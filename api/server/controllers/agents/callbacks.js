const { nanoid } = require('nanoid');
const { sendEvent } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { Tools, StepTypes, FileContext, ErrorTypes } = require('librechat-data-provider');
const {
  EnvVar,
  Providers,
  GraphEvents,
  getMessageId,
  ToolEndHandler,
  handleToolCalls,
  ChatModelStreamHandler,
} = require('@librechat/agents');
const path = require('path');
const { processFileCitations } = require('~/server/services/Files/Citations');
const { processCodeOutput } = require('~/server/services/Files/Code/process');
const { loadAuthValues } = require('~/server/services/Tools/credentials');
const { saveBase64Image, processFileURL } = require('~/server/services/Files/process');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const extractUrls = (value, acc = []) => {
  if (!value) {
    return acc;
  }
  if (typeof value === 'string') {
    const matches = [];
    const standard = value.match(/https?:\/\/\S+/g);
    if (standard) {
      matches.push(...standard);
    }
    const replicate = value.match(/replicate\.delivery\/[^\s"']+/g);
    if (replicate) {
      // normalize replicate matches to full URL if missing scheme
      replicate.forEach((m) => {
        const hasProtocol = m.startsWith('http://') || m.startsWith('https://');
        matches.push(hasProtocol ? m : `https://${m}`);
      });
    }
    if (matches) {
      acc.push(...matches);
    }
    return acc;
  }
  if (Array.isArray(value)) {
    value.forEach((v) => extractUrls(v, acc));
    return acc;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((v) => extractUrls(v, acc));
  }
  return acc;
};

class ModelEndHandler {
  /**
   * @param {Array<UsageMetadata>} collectedUsage
   */
  constructor(collectedUsage) {
    if (!Array.isArray(collectedUsage)) {
      throw new Error('collectedUsage must be an array');
    }
    this.collectedUsage = collectedUsage;
  }

  finalize(errorMessage) {
    if (!errorMessage) {
      return;
    }
    throw new Error(errorMessage);
  }

  /**
   * @param {string} event
   * @param {ModelEndData | undefined} data
   * @param {Record<string, unknown> | undefined} metadata
   * @param {StandardGraph} graph
   * @returns {Promise<void>}
   */
  async handle(event, data, metadata, graph) {
    if (!graph || !metadata) {
      console.warn(`Graph or metadata not found in ${event} event`);
      return;
    }

    /** @type {string | undefined} */
    let errorMessage;
    try {
      const agentContext = graph.getAgentContext(metadata);
      const isGoogle = agentContext.provider === Providers.GOOGLE;
      const streamingDisabled = !!agentContext.clientOptions?.disableStreaming;
      if (data?.output?.additional_kwargs?.stop_reason === 'refusal') {
        const info = { ...data.output.additional_kwargs };
        errorMessage = JSON.stringify({
          type: ErrorTypes.REFUSAL,
          info,
        });
        logger.debug(`[ModelEndHandler] Model refused to respond`, {
          ...info,
          userId: metadata.user_id,
          messageId: metadata.run_id,
          conversationId: metadata.thread_id,
        });
      }

      const toolCalls = data?.output?.tool_calls;
      let hasUnprocessedToolCalls = false;
      if (Array.isArray(toolCalls) && toolCalls.length > 0 && graph?.toolCallStepIds?.has) {
        try {
          hasUnprocessedToolCalls = toolCalls.some(
            (tc) => tc?.id && !graph.toolCallStepIds.has(tc.id),
          );
        } catch {
          hasUnprocessedToolCalls = false;
        }
      }
      if (isGoogle || streamingDisabled || hasUnprocessedToolCalls) {
        await handleToolCalls(toolCalls, metadata, graph);
      }

      const usage = data?.output?.usage_metadata;
      if (!usage) {
        return this.finalize(errorMessage);
      }
      const modelName = metadata?.ls_model_name || agentContext.clientOptions?.model;
      if (modelName) {
        usage.model = modelName;
      }

      this.collectedUsage.push(usage);
      if (!streamingDisabled) {
        return this.finalize(errorMessage);
      }
      if (!data.output.content) {
        return this.finalize(errorMessage);
      }
      const stepKey = graph.getStepKey(metadata);
      const message_id = getMessageId(stepKey, graph) ?? '';
      if (message_id) {
        await graph.dispatchRunStep(stepKey, {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: {
            message_id,
          },
        });
      }
      const stepId = graph.getStepIdByKey(stepKey);
      const content = data.output.content;
      if (typeof content === 'string') {
        await graph.dispatchMessageDelta(stepId, {
          content: [
            {
              type: 'text',
              text: content,
            },
          ],
        });
      } else if (content.every((c) => c.type?.startsWith('text'))) {
        await graph.dispatchMessageDelta(stepId, {
          content,
        });
      }
    } catch (error) {
      logger.error('Error handling model end event:', error);
      return this.finalize(errorMessage);
    }
  }
}

/**
 * @deprecated Agent Chain helper
 * @param {string | undefined} [last_agent_id]
 * @param {string | undefined} [langgraph_node]
 * @returns {boolean}
 */
function checkIfLastAgent(last_agent_id, langgraph_node) {
  if (!last_agent_id || !langgraph_node) {
    return false;
  }
  return langgraph_node?.endsWith(last_agent_id);
}

/**
 * Get default handlers for stream events.
 * @param {Object} options - The options object.
 * @param {ServerResponse} options.res - The options object.
 * @param {ContentAggregator} options.aggregateContent - The options object.
 * @param {ToolEndCallback} options.toolEndCallback - Callback to use when tool ends.
 * @param {Array<UsageMetadata>} options.collectedUsage - The list of collected usage metadata.
 * @returns {Record<string, t.EventHandler>} The default handlers.
 * @throws {Error} If the request is not found.
 */
function getDefaultHandlers({ res, aggregateContent, toolEndCallback, collectedUsage }) {
  if (!res || !aggregateContent) {
    throw new Error(
      `[getDefaultHandlers] Missing required options: res: ${!res}, aggregateContent: ${!aggregateContent}`,
    );
  }
  const handlers = {
    [GraphEvents.CHAT_MODEL_END]: new ModelEndHandler(collectedUsage),
    [GraphEvents.TOOL_END]: new ToolEndHandler(toolEndCallback, logger),
    [GraphEvents.CHAT_MODEL_STREAM]: new ChatModelStreamHandler(),
    [GraphEvents.ON_RUN_STEP]: {
      /**
       * Handle ON_RUN_STEP event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: (event, data, metadata) => {
        if (data?.stepDetails.type === StepTypes.TOOL_CALLS) {
          sendEvent(res, { event, data });
        } else if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          sendEvent(res, { event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          sendEvent(res, { event, data });
        } else {
          const agentName = metadata?.name ?? 'Agent';
          const isToolCall = data?.stepDetails.type === StepTypes.TOOL_CALLS;
          const action = isToolCall ? 'performing a task...' : 'thinking...';
          sendEvent(res, {
            event: 'on_agent_update',
            data: {
              runId: metadata?.run_id,
              message: `${agentName} is ${action}`,
            },
          });
        }
        aggregateContent({ event, data });
      },
    },
    [GraphEvents.ON_RUN_STEP_DELTA]: {
      /**
       * Handle ON_RUN_STEP_DELTA event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: (event, data, metadata) => {
        if (data?.delta.type === StepTypes.TOOL_CALLS) {
          sendEvent(res, { event, data });
        } else if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          sendEvent(res, { event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          sendEvent(res, { event, data });
        }
        aggregateContent({ event, data });
      },
    },
    [GraphEvents.ON_RUN_STEP_COMPLETED]: {
      /**
       * Handle ON_RUN_STEP_COMPLETED event.
       * @param {string} event - The event name.
       * @param {StreamEventData & { result: ToolEndData }} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: (event, data, metadata) => {
        if (data?.result != null) {
          sendEvent(res, { event, data });
        } else if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          sendEvent(res, { event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          sendEvent(res, { event, data });
        }
        aggregateContent({ event, data });
      },
    },
    [GraphEvents.ON_MESSAGE_DELTA]: {
      /**
       * Handle ON_MESSAGE_DELTA event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: (event, data, metadata) => {
        if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          sendEvent(res, { event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          sendEvent(res, { event, data });
        }
        aggregateContent({ event, data });
      },
    },
    [GraphEvents.ON_REASONING_DELTA]: {
      /**
       * Handle ON_REASONING_DELTA event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: (event, data, metadata) => {
        if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          sendEvent(res, { event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          sendEvent(res, { event, data });
        }
        aggregateContent({ event, data });
      },
    },
  };

  return handlers;
}

/**
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {ServerResponse} params.res
 * @param {Promise<MongoFile | { filename: string; filepath: string; expires: number;} | null>[]} params.artifactPromises
 * @returns {ToolEndCallback} The tool end callback.
 */
function createToolEndCallback({ req, res, artifactPromises }) {
  /**
   * @type {ToolEndCallback}
   */
  return async (data, metadata) => {
    const output = data?.output;

    // Debug logging for tool end callback
    let artifactPreview;
    try {
      artifactPreview = output?.artifact ? JSON.stringify(output.artifact).slice(0, 300) : 'none';
    } catch (_e) {
      artifactPreview = 'error serializing';
    }
    const toolCallId = output?.tool_call_id ?? data?.tool_call_id;
    logger.info(
      `[ToolEndCallback] called - hasOutput=${!!output} outputName=${output?.name} hasArtifact=${!!output?.artifact} toolCallId=${toolCallId}`,
    );
    logger.info(`[ToolEndCallback] artifact preview: ${artifactPreview}`);

    if (!output) {
      logger.info('[ToolEndCallback] no output, returning early');
      return;
    }

    if (!output.artifact) {
      logger.info('[ToolEndCallback] no artifact, returning early');
      return;
    }

    const contentPreview = output.artifact.content
      ? JSON.stringify(output.artifact.content).slice(0, 300)
      : 'none';
    logger.info(
      `[ToolEndCallback] processing artifact - hasContent=${!!output.artifact.content} contentLength=${output.artifact.content?.length} content=${contentPreview}`,
    );

    // Edited file outputs (save_edited_file): stream and collect as attachments
    if (Array.isArray(output.artifact.saved_files) && output.artifact.saved_files.length > 0) {
      const toolCallIdFallback = output.tool_call_id ?? data?.tool_call_id ?? data?.id ?? null;
      for (const saved of output.artifact.saved_files) {
        artifactPromises.push(
          (async () => {
            const attachment = {
              ...saved,
              // Match other attachment events: attach to the current run/thread metadata
              messageId: metadata?.run_id,
              conversationId: metadata?.thread_id,
              toolCallId: toolCallIdFallback,
            };
            if (!res.headersSent) {
              return attachment;
            }
            res.write(`event: attachment\ndata: ${JSON.stringify(attachment)}\n\n`);
            return attachment;
          })().catch((error) => {
            logger.error('Error processing saved_files artifact:', error);
            return null;
          }),
        );
      }
    }

    if (output.artifact[Tools.file_search]) {
      artifactPromises.push(
        (async () => {
          const user = req.user;
          const attachment = await processFileCitations({
            user,
            metadata,
            appConfig: req.config,
            toolArtifact: output.artifact,
            toolCallId: output.tool_call_id,
          });
          if (!attachment) {
            return null;
          }
          if (!res.headersSent) {
            return attachment;
          }
          res.write(`event: attachment\ndata: ${JSON.stringify(attachment)}\n\n`);
          return attachment;
        })().catch((error) => {
          logger.error('Error processing file citations:', error);
          return null;
        }),
      );
    }

    // TODO: a lot of duplicated code in createToolEndCallback
    // we should refactor this to use a helper function in a follow-up PR
    if (output.artifact[Tools.ui_resources]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.ui_resources,
            messageId: metadata.run_id,
            toolCallId: output.tool_call_id,
            conversationId: metadata.thread_id,
            [Tools.ui_resources]: output.artifact[Tools.ui_resources].data,
          };
          if (!res.headersSent) {
            return attachment;
          }
          res.write(`event: attachment\ndata: ${JSON.stringify(attachment)}\n\n`);
          return attachment;
        })().catch((error) => {
          logger.error('Error processing artifact content:', error);
          return null;
        }),
      );
    }

    if (output.artifact[Tools.web_search]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.web_search,
            messageId: metadata.run_id,
            toolCallId: output.tool_call_id,
            conversationId: metadata.thread_id,
            [Tools.web_search]: { ...output.artifact[Tools.web_search] },
          };
          if (!res.headersSent) {
            return attachment;
          }
          res.write(`event: attachment\ndata: ${JSON.stringify(attachment)}\n\n`);
          return attachment;
        })().catch((error) => {
          logger.error('Error processing artifact content:', error);
          return null;
        }),
      );
    }

    if (output.artifact.content) {
      /** @type {FormattedContent[]} */
      const content = output.artifact.content;
      for (let i = 0; i < content.length; i++) {
        const part = content[i];
        if (!part) {
          continue;
        }
        if (part.type !== 'image_url') {
          continue;
        }
        const { url } = part.image_url || {};
        if (!url) {
          continue;
        }
        const isHttpUrl = /^https?:\/\//i.test(url);
        artifactPromises.push(
          (async () => {
            const baseFileName = `${output.name}_${output.tool_call_id}_img_${nanoid()}`;
            const fallbackExt = '.png';
            const file_id = output.artifact.file_ids?.[i];
            let fileMetadata = null;

            try {
              if (isHttpUrl) {
                const parsedUrl = new URL(url);
                const ext = path.extname(parsedUrl.pathname) || fallbackExt;
                const fileName = `${baseFileName}${ext}`;
                const fileStrategy = getFileStrategy(req.config, { isImage: true });
                // Ensure userId is defined - use metadata.user_id as fallback
                const userId = req.user?.id || metadata?.user_id;
                if (!userId) {
                  logger.error('[ToolEnd][image_url:http] No userId available, cannot process file');
                  return null;
                }
                const file = await processFileURL({
                  URL: url,
                  userId,
                  fileName,
                  basePath: 'images',
                  context: FileContext.image_generation,
                  fileStrategy,
                });
                logger.info(
                  `[ToolEnd][image_url:http] stored: ${JSON.stringify({
                    url,
                    file_id: file?.file_id,
                    filepath: file?.filepath,
                    width: file?.width,
                    height: file?.height,
                    bytes: file?.bytes,
                    type: file?.type,
                  })}`,
                );
                fileMetadata = file
                  ? Object.assign(file, {
                      messageId: metadata.run_id,
                      toolCallId: output.tool_call_id,
                      conversationId: metadata.thread_id,
                    })
                  : null;
              } else {
                const file = await saveBase64Image(url, {
                  req,
                  file_id,
                  filename: `${baseFileName}${fallbackExt}`,
                  endpoint: metadata.provider,
                  context: FileContext.image_generation,
                });
                logger.info('[ToolEnd][image_url:base64] stored', {
                  url: 'base64',
                  file_id: file?.file_id,
                  filepath: file?.filepath,
                  tool: output.name,
                  tool_call_id: output.tool_call_id,
                });
                fileMetadata = file
                  ? Object.assign(file, {
                      messageId: metadata.run_id,
                      toolCallId: output.tool_call_id,
                      conversationId: metadata.thread_id,
                    })
                  : null;
              }
            } catch (error) {
              logger.error('Error processing artifact content:', error);
              return null;
            }

            if (!fileMetadata) {
              logger.info('[ToolEnd][image_url] no fileMetadata, returning null');
              return null;
            }

            logger.info(
              `[ToolEnd][image_url] fileMetadata ready: ${JSON.stringify({
                file_id: fileMetadata.file_id,
                filepath: fileMetadata.filepath,
                filename: fileMetadata.filename,
                width: fileMetadata.width,
                height: fileMetadata.height,
                messageId: fileMetadata.messageId,
                toolCallId: fileMetadata.toolCallId,
                headersSent: res.headersSent,
              })}`,
            );
            // Log if critical fields are missing
            if (!fileMetadata.filepath || !fileMetadata.width || !fileMetadata.height) {
              logger.warn(
                `[ToolEnd][image_url] MISSING CRITICAL FIELDS: filepath=${!!fileMetadata.filepath} width=${!!fileMetadata.width} height=${!!fileMetadata.height}`,
              );
            }

            if (!res.headersSent) {
              logger.info('[ToolEnd][image_url] headers not sent, deferring attachment');
              return fileMetadata;
            }

            const attachmentPayload = JSON.stringify(fileMetadata);
            logger.info(
              `[ToolEnd][image_url] streaming attachment event: ${attachmentPayload.slice(0, 200)}`,
            );
            res.write(`event: attachment\ndata: ${attachmentPayload}\n\n`);
            return fileMetadata;
          })().catch((error) => {
            logger.error('Error processing artifact content:', error);
            return null;
          }),
        );
      }
      return;
    }

    // Fallback: if tool output contains http(s) URLs, treat them as images and store them
    const urlFallbacks = extractUrls(output.output, extractUrls(output.artifact, []));
    if (urlFallbacks.length > 0) {
      for (const url of urlFallbacks) {
        const isHttpUrl = /^https?:\/\//i.test(url);
        if (!isHttpUrl) {
          continue;
        }
        artifactPromises.push(
          (async () => {
            try {
              const parsedUrl = new URL(url);
              const ext = path.extname(parsedUrl.pathname) || '.png';
              const fileName = `${output.name}_${output.tool_call_id}_img_${nanoid()}${ext}`;
              const fileStrategy = getFileStrategy(req.config, { isImage: true });
              const file = await processFileURL({
                URL: url,
                userId: req.user.id,
                fileName,
                basePath: 'images',
                context: FileContext.image_generation,
                fileStrategy,
              });
              logger.info('[ToolEnd][url_fallback] stored', {
                url,
                file_id: file.file_id,
                filepath: file.filepath,
                tool: output.name,
                tool_call_id: output.tool_call_id,
              });
              const fileMetadata = Object.assign(file, {
                messageId: metadata.run_id,
                toolCallId: output.tool_call_id,
                conversationId: metadata.thread_id,
              });
              if (!res.headersSent) {
                return fileMetadata;
              }
              res.write(`event: attachment\ndata: ${JSON.stringify(fileMetadata)}\n\n`);
              return fileMetadata;
            } catch (error) {
              logger.error('Error processing url fallback content:', error);
              return null;
            }
          })(),
        );
      }
      return;
    }

    {
      if (output.name !== Tools.execute_code) {
        return;
      }
    }

    if (!output.artifact.files) {
      return;
    }

    for (const file of output.artifact.files) {
      const { id, name } = file;
      artifactPromises.push(
        (async () => {
          const result = await loadAuthValues({
            userId: req.user.id,
            authFields: [EnvVar.CODE_API_KEY],
          });
          const fileMetadata = await processCodeOutput({
            req,
            id,
            name,
            apiKey: result[EnvVar.CODE_API_KEY],
            messageId: metadata.run_id,
            toolCallId: output.tool_call_id,
            conversationId: metadata.thread_id,
            session_id: output.artifact.session_id,
          });
          if (!res.headersSent) {
            return fileMetadata;
          }

          if (!fileMetadata) {
            return null;
          }

          res.write(`event: attachment\ndata: ${JSON.stringify(fileMetadata)}\n\n`);
          return fileMetadata;
        })().catch((error) => {
          logger.error('Error processing code output:', error);
          return null;
        }),
      );
    }
  };
}

module.exports = {
  getDefaultHandlers,
  createToolEndCallback,
};
