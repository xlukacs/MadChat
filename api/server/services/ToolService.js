const { sleep } = require('@librechat/agents');
const { logger } = require('@librechat/data-schemas');
const { tool: toolFn, DynamicStructuredTool } = require('@langchain/core/tools');
const {
  getToolkitKey,
  hasCustomUserVars,
  getUserMCPAuthMap,
  isActionDomainAllowed,
} = require('@librechat/api');
const {
  Tools,
  Constants,
  ErrorTypes,
  ContentTypes,
  imageGenTools,
  EModelEndpoint,
  actionDelimiter,
  ImageVisionTool,
  openapiToFunction,
  AgentCapabilities,
  validateActionDomain,
  defaultAgentCapabilities,
  validateAndParseOpenAPISpec,
} = require('librechat-data-provider');
const {
  createActionTool,
  decryptMetadata,
  loadActionSets,
  domainParser,
} = require('./ActionService');
const { processFileURL, uploadImageBuffer } = require('~/server/services/Files/process');
const { getEndpointsConfig, getCachedTools } = require('~/server/services/Config');
const { manifestToolMap, toolkits } = require('~/app/clients/tools/manifest');
const { createOnSearchResults } = require('~/server/services/Tools/search');
const { recordUsage } = require('~/server/services/Threads');
const { loadTools } = require('~/app/clients/tools/util');
const { redactMessage } = require('~/config/parsers');
const { findPluginAuthsByKeys } = require('~/models');
const path = require('path');
 
const SAVE_EDITED_FILE_TOOL = 'save_edited_file';
const RETRIEVE_FILE_TO_ARTIFACT_TOOL = 'retrieve_file_to_artifact';
const LIST_ACCESSIBLE_FILES_TOOL = 'list_accessible_files';
const TEXT_EXT_ALLOWLIST = new Set(['.txt', '.md', '.json', '.js', '.ts', '.csv']);
const shouldEnableSaveEditedFile = (req) => {
  const files = req?.body?.files ?? [];
  if (!Array.isArray(files) || files.length === 0) {
    return false;
  }
  return files.some((f) => {
    const filename = (f && f.filename) || '';
    const type = (f && f.type) || '';
    if (typeof type === 'string' && type.startsWith('image/')) {
      return false;
    }
    const ext = path.extname(filename).toLowerCase();
    return TEXT_EXT_ALLOWLIST.has(ext);
  });
};
const shouldEnableRetrieveFileToArtifact = shouldEnableSaveEditedFile;
const shouldEnableListAccessibleFiles = (req) => {
  // Keep this conservative to avoid bloating prompts/toolsets unless it’s likely needed.
  const extractText = (content) => {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      // OpenAI/OpenRouter style: [{type:'text', text:{value}}] or [{type:'text', text:'...'}]
      return content
        .map((part) => {
          if (!part) return '';
          if (typeof part === 'string') return part;
          if (typeof part.text === 'string') return part.text;
          if (typeof part.text?.value === 'string') return part.text.value;
          if (typeof part.content === 'string') return part.content;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    if (content && typeof content === 'object') {
      if (typeof content.text === 'string') return content.text;
      if (typeof content.text?.value === 'string') return content.text.value;
    }
    return '';
  };

  const lastFromMessages = Array.isArray(req?.body?.messages)
    ? extractText(req.body.messages.at(-1)?.content)
    : '';

  const lastUserText = extractText(
    req?.body?.message ?? req?.body?.text ?? req?.body?.prompt ?? req?.body?.input ?? lastFromMessages,
  );

  if (typeof lastUserText !== 'string' || lastUserText.trim().length === 0) {
    return false;
  }
  const s = lastUserText.toLowerCase();
  return (
    (s.includes('list') || s.includes('show') || s.includes('display') || s.includes('table')) &&
    (s.includes('file') || s.includes('files'))
  );
};
 
const getSaveEditedFileInstructions = () => {
  return [
    '## Edited file outputs',
    'When the user asks you to modify an attached text file (txt/md/json/js/ts/csv):',
    `1) Call \`${SAVE_EDITED_FILE_TOOL}\` with \`source_file_id\` and the FULL updated \`content\`.`,
    '2) Then respond with EXACTLY ONE enclosed artifact block containing the edited content:',
    '```',
    ':::artifact{type="text/markdown" title="FILENAME_HERE" identifier="FILE_ID_HERE"}',
    '...paste the full edited content here...',
    ':::',
    '```',
    'Do not include additional artifact blocks. The artifact body must be the complete updated file content.',
  ].join('\n');
};
 
const getRetrieveFileToArtifactInstructions = () => {
  return [
    '## File retrieval to artifact',
    `If you need to re-open/reuse a previously uploaded file by its file_id, call \`${RETRIEVE_FILE_TO_ARTIFACT_TOOL}\` with \`source_file_id\`.`,
    'After calling it, you MUST respond with EXACTLY ONE enclosed artifact block (Markdown) using the returned file_id as the artifact identifier:',
    '```',
    ':::artifact{type="text/markdown" title="FILENAME_HERE" identifier="FILE_ID_HERE"}',
    '...paste the full file content here...',
    ':::',
    '```',
  ].join('\n');
};

const getListAccessibleFilesInstructions = () => {
  return [
    '## Listing accessible files',
    `When the user asks to list/show/display their files (or files they can access), call \`${LIST_ACCESSIBLE_FILES_TOOL}\`.`,
    'After calling it, respond with EXACTLY ONE enclosed artifact block containing a Markdown table of files (include file_id in the table).',
    'Do NOT use filesystem tools (e.g. list_directory) to inspect server paths like /app/uploads and do NOT provide path-based download links.',
    'Never output links like /api/download?path=... . Always work with file_id-based access.',
    '```',
    ':::artifact{type="text/markdown" title="Accessible files" identifier="accessible_files"}',
    '| Filename | file_id | Size | Type | Source | Context | Access |',
    '|---|---|---:|---|---|---|---|',
    '| ... | `file_id_here` | ... | ... | ... | ... | ... |',
    ':::',
    '```',
  ].join('\n');
};
/**
 * Processes the required actions by calling the appropriate tools and returning the outputs.
 * @param {OpenAIClient} client - OpenAI or StreamRunManager Client.
 * @param {RequiredAction} requiredActions - The current required action.
 * @returns {Promise<ToolOutput>} The outputs of the tools.
 */
const processVisionRequest = async (client, currentAction) => {
  if (!client.visionPromise) {
    return {
      tool_call_id: currentAction.toolCallId,
      output: 'No image details found.',
    };
  }

  /** @type {ChatCompletion | undefined} */
  const completion = await client.visionPromise;
  if (completion && completion.usage) {
    recordUsage({
      user: client.req.user.id,
      model: client.req.body.model,
      conversationId: (client.responseMessage ?? client.finalMessage).conversationId,
      ...completion.usage,
    });
  }
  const output = completion?.choices?.[0]?.message?.content ?? 'No image details found.';
  return {
    tool_call_id: currentAction.toolCallId,
    output,
  };
};

/**
 * Processes return required actions from run.
 * @param {OpenAIClient | StreamRunManager} client - OpenAI (legacy) or StreamRunManager Client.
 * @param {RequiredAction[]} requiredActions - The required actions to submit outputs for.
 * @returns {Promise<ToolOutputs>} The outputs of the tools.
 */
async function processRequiredActions(client, requiredActions) {
  logger.debug(
    `[required actions] user: ${client.req.user.id} | thread_id: ${requiredActions[0].thread_id} | run_id: ${requiredActions[0].run_id}`,
    requiredActions,
  );
  const appConfig = client.req.config;
  const toolDefinitions = await getCachedTools();
  const seenToolkits = new Set();
  const tools = requiredActions
    .map((action) => {
      const toolName = action.tool;
      const toolDef = toolDefinitions[toolName];
      if (toolDef && !manifestToolMap[toolName]) {
        for (const toolkit of toolkits) {
          if (seenToolkits.has(toolkit.pluginKey)) {
            return;
          } else if (toolName.startsWith(`${toolkit.pluginKey}_`)) {
            seenToolkits.add(toolkit.pluginKey);
            return toolkit.pluginKey;
          }
        }
      }
      return toolName;
    })
    .filter((toolName) => !!toolName);

  const { loadedTools } = await loadTools({
    user: client.req.user.id,
    model: client.req.body.model ?? 'gpt-4o-mini',
    tools,
    functions: true,
    endpoint: client.req.body.endpoint,
    options: {
      processFileURL,
      req: client.req,
      res: client.res,
      uploadImageBuffer,
      openAIApiKey: client.apiKey,
      returnMetadata: true,
    },
    webSearch: appConfig.webSearch,
    fileStrategy: appConfig.fileStrategy,
    imageOutputType: appConfig.imageOutputType,
  });

  const ToolMap = loadedTools.reduce((map, tool) => {
    map[tool.name] = tool;
    return map;
  }, {});

  const promises = [];

  /** @type {Action[]} */
  let actionSets = [];
  let isActionTool = false;
  const ActionToolMap = {};
  const ActionBuildersMap = {};

  for (let i = 0; i < requiredActions.length; i++) {
    const currentAction = requiredActions[i];
    if (currentAction.tool === ImageVisionTool.function.name) {
      promises.push(processVisionRequest(client, currentAction));
      continue;
    }
    let tool = ToolMap[currentAction.tool] ?? ActionToolMap[currentAction.tool];

    const handleToolOutput = async (toolResult) => {
      let output = toolResult;
      let artifact = null;
      if (toolResult && typeof toolResult === 'object') {
        output = toolResult.output ?? toolResult.content ?? '';
        artifact = toolResult.artifact ?? null;
      }
      if (typeof output !== 'string') {
        output = JSON.stringify(output);
      }
      requiredActions[i].output = output;
 
      // Stream any saved file attachments produced by the tool
      if (artifact && Array.isArray(artifact.saved_files) && artifact.saved_files.length > 0) {
        for (const saved of artifact.saved_files) {
          try {
            client.res?.write?.(
              `event: attachment\ndata: ${JSON.stringify({
                ...saved,
                messageId: currentAction.run_id,
                conversationId: currentAction.thread_id,
                toolCallId: currentAction.toolCallId,
              })}\n\n`,
            );
          } catch (e) {
            logger.warn('[ToolService] Failed streaming saved_files attachment:', e);
          }
        }
      }

      /** @type {FunctionToolCall & PartMetadata} */
      const toolCall = {
        function: {
          name: currentAction.tool,
          arguments: JSON.stringify(currentAction.toolInput),
          output,
        },
        id: currentAction.toolCallId,
        type: 'function',
        progress: 1,
        action: isActionTool,
      };

      const toolCallIndex = client.mappedOrder.get(toolCall.id);

      if (imageGenTools.has(currentAction.tool)) {
        const imageOutput = output;
        toolCall.function.output = `${currentAction.tool} displayed an image. All generated images are already plainly visible, so don't repeat the descriptions in detail. Do not list download links as they are available in the UI already. The user may download the images by clicking on them, but do not mention anything about downloading to the user.`;

        // Streams the "Finished" state of the tool call in the UI
        client.addContentData({
          [ContentTypes.TOOL_CALL]: toolCall,
          index: toolCallIndex,
          type: ContentTypes.TOOL_CALL,
        });

        await sleep(500);

        /** @type {ImageFile} */
        const imageDetails = {
          ...imageOutput,
          ...currentAction.toolInput,
        };

        const image_file = {
          [ContentTypes.IMAGE_FILE]: imageDetails,
          type: ContentTypes.IMAGE_FILE,
          // Replace the tool call output with Image file
          index: toolCallIndex,
        };

        client.addContentData(image_file);

        // Update the stored tool call
        client.seenToolCalls && client.seenToolCalls.set(toolCall.id, toolCall);

        return {
          tool_call_id: currentAction.toolCallId,
          output: toolCall.function.output,
        };
      }

      client.seenToolCalls && client.seenToolCalls.set(toolCall.id, toolCall);
      client.addContentData({
        [ContentTypes.TOOL_CALL]: toolCall,
        index: toolCallIndex,
        type: ContentTypes.TOOL_CALL,
        // TODO: to append tool properties to stream, pass metadata rest to addContentData
        // result: tool.result,
      });

      return {
        tool_call_id: currentAction.toolCallId,
        output,
      };
    };

    if (!tool) {
      // throw new Error(`Tool ${currentAction.tool} not found.`);

      // Load all action sets once if not already loaded
      if (!actionSets.length) {
        actionSets =
          (await loadActionSets({
            assistant_id: client.req.body.assistant_id,
          })) ?? [];

        // Process all action sets once
        // Map domains to their processed action sets
        const processedDomains = new Map();
        const domainMap = new Map();

        for (const action of actionSets) {
          const domain = await domainParser(action.metadata.domain, true);
          domainMap.set(domain, action);

          const isDomainAllowed = await isActionDomainAllowed(
            action.metadata.domain,
            appConfig?.actions?.allowedDomains,
          );
          if (!isDomainAllowed) {
            continue;
          }

          // Validate and parse OpenAPI spec
          const validationResult = validateAndParseOpenAPISpec(action.metadata.raw_spec);
          if (!validationResult.spec || !validationResult.serverUrl) {
            throw new Error(
              `Invalid spec: user: ${client.req.user.id} | thread_id: ${requiredActions[0].thread_id} | run_id: ${requiredActions[0].run_id}`,
            );
          }

          // SECURITY: Validate the domain from the spec matches the stored domain
          // This is defense-in-depth to prevent any stored malicious actions
          const domainValidation = validateActionDomain(
            action.metadata.domain,
            validationResult.serverUrl,
          );
          if (!domainValidation.isValid) {
            logger.error(`Domain mismatch in stored action: ${domainValidation.message}`, {
              userId: client.req.user.id,
              action_id: action.action_id,
            });
            continue; // Skip this action rather than failing the entire request
          }

          // Process the OpenAPI spec
          const { requestBuilders } = openapiToFunction(validationResult.spec);

          // Store encrypted values for OAuth flow
          const encrypted = {
            oauth_client_id: action.metadata.oauth_client_id,
            oauth_client_secret: action.metadata.oauth_client_secret,
          };

          // Decrypt metadata
          const decryptedAction = { ...action };
          decryptedAction.metadata = await decryptMetadata(action.metadata);

          processedDomains.set(domain, {
            action: decryptedAction,
            requestBuilders,
            encrypted,
          });

          // Store builders for reuse
          ActionBuildersMap[action.metadata.domain] = requestBuilders;
        }

        // Update actionSets reference to use the domain map
        actionSets = { domainMap, processedDomains };
      }

      // Find the matching domain for this tool
      let currentDomain = '';
      for (const domain of actionSets.domainMap.keys()) {
        if (currentAction.tool.includes(domain)) {
          currentDomain = domain;
          break;
        }
      }

      if (!currentDomain || !actionSets.processedDomains.has(currentDomain)) {
        // TODO: try `function` if no action set is found
        // throw new Error(`Tool ${currentAction.tool} not found.`);
        continue;
      }

      const { action, requestBuilders, encrypted } = actionSets.processedDomains.get(currentDomain);
      const functionName = currentAction.tool.replace(`${actionDelimiter}${currentDomain}`, '');
      const requestBuilder = requestBuilders[functionName];

      if (!requestBuilder) {
        // throw new Error(`Tool ${currentAction.tool} not found.`);
        continue;
      }

      // We've already decrypted the metadata, so we can pass it directly
      tool = await createActionTool({
        userId: client.req.user.id,
        res: client.res,
        action,
        requestBuilder,
        // Note: intentionally not passing zodSchema, name, and description for assistants API
        encrypted, // Pass the encrypted values for OAuth flow
      });
      if (!tool) {
        logger.warn(
          `Invalid action: user: ${client.req.user.id} | thread_id: ${requiredActions[0].thread_id} | run_id: ${requiredActions[0].run_id} | toolName: ${currentAction.tool}`,
        );
        throw new Error(`{"type":"${ErrorTypes.INVALID_ACTION}"}`);
      }
      isActionTool = !!tool;
      ActionToolMap[currentAction.tool] = tool;
    }

    if (currentAction.tool === 'calculator') {
      currentAction.toolInput = currentAction.toolInput.input;
    }

    const handleToolError = (error) => {
      logger.error(
        `tool_call_id: ${currentAction.toolCallId} | Error processing tool ${currentAction.tool}`,
        error,
      );
      return {
        tool_call_id: currentAction.toolCallId,
        output: `Error processing tool ${currentAction.tool}: ${redactMessage(error.message, 256)}`,
      };
    };

    try {
      const promise = tool
        ._call(currentAction.toolInput)
        .then(handleToolOutput)
        .catch(handleToolError);
      promises.push(promise);
    } catch (error) {
      const toolOutputError = handleToolError(error);
      promises.push(Promise.resolve(toolOutputError));
    }
  }

  return {
    tool_outputs: await Promise.all(promises),
  };
}

/**
 * Processes the runtime tool calls and returns the tool classes.
 * @param {Object} params - Run params containing user and request information.
 * @param {ServerRequest} params.req - The request object.
 * @param {ServerResponse} params.res - The request object.
 * @param {AbortSignal} params.signal
 * @param {Pick<Agent, 'id' | 'provider' | 'model' | 'tools'} params.agent - The agent to load tools for.
 * @param {string | undefined} [params.openAIApiKey] - The OpenAI API key.
 * @returns {Promise<{ tools?: StructuredTool[]; userMCPAuthMap?: Record<string, Record<string, string>> }>} The agent tools.
 */
async function loadAgentTools({ req, res, agent, signal, tool_resources, openAIApiKey }) {
  if (!agent.tools || agent.tools.length === 0) {
    return {};
  } else if (
    agent.tools &&
    agent.tools.length === 1 &&
    /** Legacy handling for `ocr` as may still exist in existing Agents */
    (agent.tools[0] === AgentCapabilities.context || agent.tools[0] === AgentCapabilities.ocr)
  ) {
    return {};
  }

  const appConfig = req.config;
  const endpointsConfig = await getEndpointsConfig(req);
  let enabledCapabilities = new Set(endpointsConfig?.[EModelEndpoint.agents]?.capabilities ?? []);
  /** Edge case: use defined/fallback capabilities when the "agents" endpoint is not enabled */
  if (enabledCapabilities.size === 0 && agent.id === Constants.EPHEMERAL_AGENT_ID) {
    enabledCapabilities = new Set(
      appConfig.endpoints?.[EModelEndpoint.agents]?.capabilities ?? defaultAgentCapabilities,
    );
  }
  const checkCapability = (capability) => {
    const enabled = enabledCapabilities.has(capability);
    if (!enabled) {
      logger.warn(
        `Capability "${capability}" disabled${capability === AgentCapabilities.tools ? '.' : ' despite configured tool.'} User: ${req.user.id} | Agent: ${agent.id}`,
      );
    }
    return enabled;
  };
  const areToolsEnabled = checkCapability(AgentCapabilities.tools);

  let includesWebSearch = false;
  const _agentTools = agent.tools?.filter((tool) => {
    if (tool === Tools.file_search) {
      return checkCapability(AgentCapabilities.file_search);
    } else if (tool === Tools.execute_code) {
      return checkCapability(AgentCapabilities.execute_code);
    } else if (tool === Tools.web_search) {
      includesWebSearch = checkCapability(AgentCapabilities.web_search);
      return includesWebSearch;
    } else if (!areToolsEnabled && !tool.includes(actionDelimiter)) {
      return false;
    }
    return true;
  });
 
  // Auto-enable save_edited_file when user has attached a text-like file in this request.
  // This keeps the UX simple: upload -> ask for edits -> model can return an updated downloadable file.
  if (_agentTools && shouldEnableSaveEditedFile(req) && !_agentTools.includes(SAVE_EDITED_FILE_TOOL)) {
    _agentTools.push(SAVE_EDITED_FILE_TOOL);
  }
  if (
    _agentTools &&
    shouldEnableRetrieveFileToArtifact(req) &&
    !_agentTools.includes(RETRIEVE_FILE_TO_ARTIFACT_TOOL)
  ) {
    _agentTools.push(RETRIEVE_FILE_TO_ARTIFACT_TOOL);
  }

  // Make file listing available when tools are enabled (agent-safe: results are access-checked server-side).
  if (_agentTools && areToolsEnabled && !_agentTools.includes(LIST_ACCESSIBLE_FILES_TOOL)) {
    _agentTools.push(LIST_ACCESSIBLE_FILES_TOOL);
  }
 
  // If we enabled save_edited_file, inject explicit instructions into the agent system prompt.
  if (shouldEnableSaveEditedFile(req)) {
    const current = req?.body?.ephemeralAgent?.additional_instructions ?? agent?.additional_instructions ?? '';
    const injected = `${current}\n\n${getSaveEditedFileInstructions()}\n\n${getRetrieveFileToArtifactInstructions()}`.trim();
    if (req?.body?.ephemeralAgent) {
      req.body.ephemeralAgent.additional_instructions = injected;
    }
    if (agent) {
      agent.additional_instructions = injected;
    }
  }

  // Only inject listing instructions when the user likely asked for it, to avoid prompt bloat.
  if (shouldEnableListAccessibleFiles(req)) {
    const current = req?.body?.ephemeralAgent?.additional_instructions ?? agent?.additional_instructions ?? '';
    const injected = `${current}\n\n${getListAccessibleFilesInstructions()}`.trim();
    if (req?.body?.ephemeralAgent) {
      req.body.ephemeralAgent.additional_instructions = injected;
    }
    if (agent) {
      agent.additional_instructions = injected;
    }
  }

  if (!_agentTools || _agentTools.length === 0) {
    return {};
  }
  /** @type {ReturnType<typeof createOnSearchResults>} */
  let webSearchCallbacks;
  if (includesWebSearch) {
    webSearchCallbacks = createOnSearchResults(res);
  }

  /** @type {Record<string, Record<string, string>>} */
  let userMCPAuthMap;
  //TODO pass config from registry
  if (hasCustomUserVars(req.config)) {
    userMCPAuthMap = await getUserMCPAuthMap({
      tools: agent.tools,
      userId: req.user.id,
      findPluginAuthsByKeys,
    });
  }

  const { loadedTools, toolContextMap } = await loadTools({
    agent,
    signal,
    userMCPAuthMap,
    functions: true,
    user: req.user.id,
    tools: _agentTools,
    options: {
      req,
      res,
      openAIApiKey,
      tool_resources,
      processFileURL,
      uploadImageBuffer,
      returnMetadata: true,
      [Tools.web_search]: webSearchCallbacks,
    },
    webSearch: appConfig.webSearch,
    fileStrategy: appConfig.fileStrategy,
    imageOutputType: appConfig.imageOutputType,
  });

  const agentTools = [];
  for (let i = 0; i < loadedTools.length; i++) {
    const tool = loadedTools[i];
    if (tool.name && (tool.name === Tools.execute_code || tool.name === Tools.file_search)) {
      agentTools.push(tool);
      continue;
    }

    if (!areToolsEnabled) {
      continue;
    }

    if (tool.mcp === true) {
      agentTools.push(tool);
      continue;
    }

    if (tool instanceof DynamicStructuredTool) {
      agentTools.push(tool);
      continue;
    }

    const toolDefinition = {
      name: tool.name,
      schema: tool.schema,
      description: tool.description,
    };

    if (imageGenTools.has(tool.name)) {
      toolDefinition.responseFormat = 'content_and_artifact';
    }

    const toolInstance = toolFn(async (...args) => {
      return tool['_call'](...args);
    }, toolDefinition);

    agentTools.push(toolInstance);
  }

  const ToolMap = loadedTools.reduce((map, tool) => {
    map[tool.name] = tool;
    return map;
  }, {});

  if (!checkCapability(AgentCapabilities.actions)) {
    return {
      tools: agentTools,
      userMCPAuthMap,
      toolContextMap,
    };
  }

  const actionSets = (await loadActionSets({ agent_id: agent.id })) ?? [];
  if (actionSets.length === 0) {
    if (_agentTools.length > 0 && agentTools.length === 0) {
      logger.warn(`No tools found for the specified tool calls: ${_agentTools.join(', ')}`);
    }
    return {
      tools: agentTools,
      userMCPAuthMap,
      toolContextMap,
    };
  }

  // Process each action set once (validate spec, decrypt metadata)
  const processedActionSets = new Map();
  const domainMap = new Map();

  for (const action of actionSets) {
    const domain = await domainParser(action.metadata.domain, true);
    domainMap.set(domain, action);

    // Check if domain is allowed (do this once per action set)
    const isDomainAllowed = await isActionDomainAllowed(
      action.metadata.domain,
      appConfig?.actions?.allowedDomains,
    );
    if (!isDomainAllowed) {
      continue;
    }

    // Validate and parse OpenAPI spec once per action set
    const validationResult = validateAndParseOpenAPISpec(action.metadata.raw_spec);
    if (!validationResult.spec || !validationResult.serverUrl) {
      continue;
    }

    // SECURITY: Validate the domain from the spec matches the stored domain
    // This is defense-in-depth to prevent any stored malicious actions
    const domainValidation = validateActionDomain(
      action.metadata.domain,
      validationResult.serverUrl,
    );
    if (!domainValidation.isValid) {
      logger.error(`Domain mismatch in stored action: ${domainValidation.message}`, {
        userId: req.user.id,
        agent_id: agent.id,
        action_id: action.action_id,
      });
      continue; // Skip this action rather than failing the entire request
    }

    const encrypted = {
      oauth_client_id: action.metadata.oauth_client_id,
      oauth_client_secret: action.metadata.oauth_client_secret,
    };

    // Decrypt metadata once per action set
    const decryptedAction = { ...action };
    decryptedAction.metadata = await decryptMetadata(action.metadata);

    // Process the OpenAPI spec once per action set
    const { requestBuilders, functionSignatures, zodSchemas } = openapiToFunction(
      validationResult.spec,
      true,
    );

    processedActionSets.set(domain, {
      action: decryptedAction,
      requestBuilders,
      functionSignatures,
      zodSchemas,
      encrypted,
    });
  }

  // Now map tools to the processed action sets
  const ActionToolMap = {};

  for (const toolName of _agentTools) {
    if (ToolMap[toolName]) {
      continue;
    }

    // Find the matching domain for this tool
    let currentDomain = '';
    for (const domain of domainMap.keys()) {
      if (toolName.includes(domain)) {
        currentDomain = domain;
        break;
      }
    }

    if (!currentDomain || !processedActionSets.has(currentDomain)) {
      continue;
    }

    const { action, encrypted, zodSchemas, requestBuilders, functionSignatures } =
      processedActionSets.get(currentDomain);
    const functionName = toolName.replace(`${actionDelimiter}${currentDomain}`, '');
    const functionSig = functionSignatures.find((sig) => sig.name === functionName);
    const requestBuilder = requestBuilders[functionName];
    const zodSchema = zodSchemas[functionName];

    if (requestBuilder) {
      const tool = await createActionTool({
        userId: req.user.id,
        res,
        action,
        requestBuilder,
        zodSchema,
        encrypted,
        name: toolName,
        description: functionSig.description,
      });

      if (!tool) {
        logger.warn(
          `Invalid action: user: ${req.user.id} | agent_id: ${agent.id} | toolName: ${toolName}`,
        );
        throw new Error(`{"type":"${ErrorTypes.INVALID_ACTION}"}`);
      }

      agentTools.push(tool);
      ActionToolMap[toolName] = tool;
    }
  }

  if (_agentTools.length > 0 && agentTools.length === 0) {
    logger.warn(`No tools found for the specified tool calls: ${_agentTools.join(', ')}`);
    return {};
  }

  return {
    tools: agentTools,
    toolContextMap,
    userMCPAuthMap,
  };
}

module.exports = {
  getToolkitKey,
  loadAgentTools,
  processRequiredActions,
};
