const { z } = require('zod');
const { tool } = require('@langchain/core/tools');
const { logger } = require('@librechat/data-schemas');
const {
  Providers,
  StepTypes,
  GraphEvents,
  Constants: AgentConstants,
} = require('@librechat/agents');
const {
  sendEvent,
  MCPOAuthHandler,
  isMCPDomainAllowed,
  normalizeServerName,
  convertWithResolvedRefs,
} = require('@librechat/api');
const {
  Time,
  CacheKeys,
  Constants,
  ContentTypes,
  isAssistantsEndpoint,
} = require('librechat-data-provider');
const {
  getOAuthReconnectionManager,
  getMCPServersRegistry,
  getFlowStateManager,
  getMCPManager,
} = require('~/config');
const { findToken, createToken, updateToken } = require('~/models');
const { getMessages } = require('~/models/Message');
const { findFileById } = require('~/models/File');
const { reinitMCPServer } = require('./Tools/mcp');
const { getAppConfig } = require('./Config');
const { getLogStores } = require('~/cache');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');

const IMAGE_URL_PATTERN = /https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|gif|webp|bmp|svg)/gi;
const REPLICATE_DELIVERY_PATTERN = /https?:\/\/replicate\.delivery\/[^\s"'<>]+/gi;

/**
 * Check if a string is an image URL (http/https or data URI)
 */
const isImageUrlString = (value) =>
  typeof value === 'string' &&
  (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('data:image/'));

/**
 * Extract image URLs from any value (string, array, object) recursively
 */
const extractImageUrls = (value, acc = []) => {
  if (!value) {
    return acc;
  }
  if (typeof value === 'string') {
    // Check for direct image URL
    if (isImageUrlString(value)) {
      acc.push(value);
      return acc;
    }
    // Also try to extract URLs from within strings (e.g. JSON or text containing URLs)
    const replicateMatches = value.match(REPLICATE_DELIVERY_PATTERN) || [];
    const imageExtMatches = value.match(IMAGE_URL_PATTERN) || [];
    const allMatches = [...new Set([...replicateMatches, ...imageExtMatches])];
    allMatches.forEach((url) => {
      if (!acc.includes(url)) {
        acc.push(url);
      }
    });
    return acc;
  }
  if (Array.isArray(value)) {
    value.forEach((v) => extractImageUrls(v, acc));
    return acc;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) {
      if (v && typeof v === 'object' && 'url' in v && isImageUrlString(v.url)) {
        if (!acc.includes(v.url)) {
          acc.push(v.url);
        }
        continue;
      }
      extractImageUrls(v, acc);
    }
  }
  return acc;
};

/**
 * Upload local file to UploadThing and get public URL
 * Requires UPLOADTHING_SECRET environment variable
 */
const uploadToUploadThing = async (localFilePath, appConfig) => {
  const uploadThingSecret = process.env.UPLOADTHING_SECRET;
  if (!uploadThingSecret) {
    logger.warn('[MCP] UPLOADTHING_SECRET not set, skipping UploadThing upload');
    return null;
  }

  try {
    // Resolve the full file path
    let fullPath;
    if (localFilePath.startsWith('/images/')) {
      const basePath = localFilePath.split('/images/')[1];
      fullPath = path.join(appConfig.paths.imageOutput, basePath);
    } else if (localFilePath.startsWith('/uploads/')) {
      const basePath = localFilePath.split('/uploads/')[1];
      fullPath = path.join(appConfig.paths.uploads, basePath);
    } else {
      fullPath = localFilePath;
    }

    // Check if file exists
    if (!fs.existsSync(fullPath)) {
      logger.warn(`[MCP] File not found: ${fullPath}`);
      return null;
    }

    // Read file
    const fileBuffer = fs.readFileSync(fullPath);
    const fileName = path.basename(fullPath);

    // UploadThing REST API endpoint
    // Note: This uses UploadThing's REST API. You may need to adjust the endpoint
    // based on your UploadThing setup. Alternatively, you can use the @uploadthing/server package.
    const uploadUrl = process.env.UPLOADTHING_URL || 'https://uploadthing.com/api/uploadFiles';

    // Create form data
    const formData = new FormData();
    formData.append('files', fileBuffer, {
      filename: fileName,
      contentType: 'application/octet-stream',
    });

    // Make upload request
    // UploadThing typically uses 'X-Uploadthing-Secret' or 'Authorization' header
    const response = await axios.post(uploadUrl, formData, {
      headers: {
        ...formData.getHeaders(),
        'X-Uploadthing-Secret': uploadThingSecret,
        // Alternative: 'Authorization': `Bearer ${uploadThingSecret}`,
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    // Handle different response formats
    let uploadedUrl = null;
    if (response.data) {
      // Array format: [{ url: '...' }]
      if (Array.isArray(response.data) && response.data[0]?.url) {
        uploadedUrl = response.data[0].url;
      }
      // Object format: { url: '...' } or { data: [{ url: '...' }] }
      else if (response.data.url) {
        uploadedUrl = response.data.url;
      } else if (response.data.data?.[0]?.url) {
        uploadedUrl = response.data.data[0].url;
      }
    }

    if (uploadedUrl) {
      logger.info(`[MCP] Successfully uploaded to UploadThing: ${fileName} -> ${uploadedUrl}`);
      return uploadedUrl;
    }

    logger.error('[MCP] UploadThing response missing URL:', response.data);
    return null;
  } catch (error) {
    logger.error(`[MCP] Error uploading to UploadThing: ${error.message}`, error);
    return null;
  }
};

/**
 * Convert local file path to public URL
 * For local storage, tries UploadThing first (if configured), then constructs full URL using DOMAIN_SERVER
 * For cloud storage, the path should already be a full URL
 */
const convertToPublicURL = async (filePath, appConfig = null) => {
  if (!filePath) {
    return null;
  }

  // If it's already a full URL (http/https), return as is
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    return filePath;
  }

  // If it's a local path (starts with /images/ or /uploads/), try to get public URL
  if (filePath.startsWith('/images/') || filePath.startsWith('/uploads/')) {
    // Try UploadThing first if configured
    if (process.env.UPLOADTHING_SECRET && appConfig) {
      const uploadThingUrl = await uploadToUploadThing(filePath, appConfig);
      if (uploadThingUrl) {
        return uploadThingUrl;
      }
      // Fall through to DOMAIN_SERVER if UploadThing fails
    }

    // Fallback to DOMAIN_SERVER
    const domainServer = process.env.DOMAIN_SERVER;
    if (domainServer) {
      // Remove trailing slash from domain if present
      const baseUrl = domainServer.endsWith('/') ? domainServer.slice(0, -1) : domainServer;
      return `${baseUrl}${filePath}`;
    } else {
      logger.warn(
        `[MCP] Local file path found but DOMAIN_SERVER not set. File may not be accessible to external services: ${filePath}`,
      );
      // Return the path as-is, but it likely won't work for external services
      return filePath;
    }
  }

  // Return as-is for other cases
  return filePath;
};

/**
 * Extract the most recent image URL from conversation
 * Queries the conversation directly, finds the last message with attachments,
 * uploads to UploadThing if needed, and returns the public URL
 */
const extractImageUrlsFromConversation = async (conversationId) => {
  if (!conversationId) {
    return [];
  }

  try {
    // Query messages from the conversation, sorted by creation date (newest first)
    const messages = await getMessages({ conversationId: conversationId });
    if (!messages || messages.length === 0) {
      logger.warn(`[MCP] No messages found for conversationId: ${conversationId}`);
      return [];
    }

    // Get messageIds to query File collection for attachments
    const messageIds = messages.map((msg) => msg.messageId);

    // Query File collection for image attachments
    const { getFiles } = require('~/models/File');
    const fileAttachments = await getFiles(
      { messageId: { $in: messageIds }, type: { $regex: /^image\//i } },
      { updatedAt: -1 }, // Sort by most recent first
      {},
    );

    logger.info(
      `[MCP] Found ${fileAttachments.length} image attachments in File collection for conversation ${conversationId}`,
    );

    if (fileAttachments.length === 0) {
      return [];
    }

    // Get the most recent image attachment
    const latestAttachment = fileAttachments[0];

    // Check if it has a filepath
    if (!latestAttachment.filepath) {
      logger.warn(`[MCP] Latest attachment ${latestAttachment.file_id} has no filepath`);
      return [];
    }

    // Get app config for UploadThing
    const appConfig = await getAppConfig();

    // Convert to public URL (uploads to UploadThing if needed)
    const publicUrl = await convertToPublicURL(latestAttachment.filepath, appConfig);

    if (publicUrl) {
      logger.info(
        `[MCP] Extracted image URL from conversation: ${publicUrl} (from filepath: ${latestAttachment.filepath})`,
      );
      return [publicUrl];
    }

    return [];
  } catch (error) {
    logger.error(`[MCP] Error extracting image from conversation ${conversationId}:`, error);
    return [];
  }
};

/**
 * Normalize MCP tool result to include image artifacts if URLs are detected.
 * Returns [textContent, artifact] format for CONTENT_AND_ARTIFACT response.
 */
const normalizeMCPImageResult = (result) => {
  // Stringify for logging to see actual values
  let resultPreview;
  try {
    resultPreview = JSON.stringify(result);
    if (resultPreview && resultPreview.length > 500) {
      resultPreview = resultPreview.slice(0, 500) + '...';
    }
  } catch (_e) {
    resultPreview = String(result);
  }

  logger.info(
    `[MCP][normalizeMCPImageResult] input type=${typeof result} isArray=${Array.isArray(result)} preview=${resultPreview}`,
  );

  const urls = extractImageUrls(result, []);
  logger.info(
    `[MCP][normalizeMCPImageResult] extracted ${urls.length} URLs: ${JSON.stringify(urls)}`,
  );

  if (!urls.length) {
    logger.info('[MCP][normalizeMCPImageResult] no URLs found, returning original result');
    return result;
  }

  // Build artifact content array with image_url entries
  const artifactContent = urls.map((url) => ({
    type: ContentTypes.IMAGE_URL,
    image_url: { url },
  }));

  // Text response for the model
  const textResponse = [
    {
      type: ContentTypes.TEXT,
      text: 'Generated image(s) displayed below.',
    },
  ];

  logger.info(
    `[MCP][normalizeMCPImageResult] returning normalized result with ${urls.length} images`,
  );

  // Return [content, artifact] format for CONTENT_AND_ARTIFACT
  return [textResponse, { content: artifactContent }];
};

/**
 * @param {object} params
 * @param {ServerResponse} params.res - The Express response object for sending events.
 * @param {string} params.stepId - The ID of the step in the flow.
 * @param {ToolCallChunk} params.toolCall - The tool call object containing tool information.
 */
function createRunStepDeltaEmitter({ res, stepId, toolCall }) {
  /**
   * @param {string} authURL - The URL to redirect the user for OAuth authentication.
   * @returns {void}
   */
  return function (authURL) {
    /** @type {{ id: string; delta: AgentToolCallDelta }} */
    const data = {
      id: stepId,
      delta: {
        type: StepTypes.TOOL_CALLS,
        tool_calls: [{ ...toolCall, args: '' }],
        auth: authURL,
        expires_at: Date.now() + Time.TWO_MINUTES,
      },
    };
    sendEvent(res, { event: GraphEvents.ON_RUN_STEP_DELTA, data });
  };
}

/**
 * @param {object} params
 * @param {ServerResponse} params.res - The Express response object for sending events.
 * @param {string} params.runId - The Run ID, i.e. message ID
 * @param {string} params.stepId - The ID of the step in the flow.
 * @param {ToolCallChunk} params.toolCall - The tool call object containing tool information.
 * @param {number} [params.index]
 */
function createRunStepEmitter({ res, runId, stepId, toolCall, index }) {
  return function () {
    /** @type {import('@librechat/agents').RunStep} */
    const data = {
      runId: runId ?? Constants.USE_PRELIM_RESPONSE_MESSAGE_ID,
      id: stepId,
      type: StepTypes.TOOL_CALLS,
      index: index ?? 0,
      stepDetails: {
        type: StepTypes.TOOL_CALLS,
        tool_calls: [toolCall],
      },
    };
    sendEvent(res, { event: GraphEvents.ON_RUN_STEP, data });
  };
}

/**
 * Creates a function used to ensure the flow handler is only invoked once
 * @param {object} params
 * @param {string} params.flowId - The ID of the login flow.
 * @param {FlowStateManager<any>} params.flowManager - The flow manager instance.
 * @param {(authURL: string) => void} [params.callback]
 */
function createOAuthStart({ flowId, flowManager, callback }) {
  /**
   * Creates a function to handle OAuth login requests.
   * @param {string} authURL - The URL to redirect the user for OAuth authentication.
   * @returns {Promise<boolean>} Returns true to indicate the event was sent successfully.
   */
  return async function (authURL) {
    await flowManager.createFlowWithHandler(flowId, 'oauth_login', async () => {
      callback?.(authURL);
      logger.debug('Sent OAuth login request to client');
      return true;
    });
  };
}

/**
 * @param {object} params
 * @param {ServerResponse} params.res - The Express response object for sending events.
 * @param {string} params.stepId - The ID of the step in the flow.
 * @param {ToolCallChunk} params.toolCall - The tool call object containing tool information.
 * @param {string} params.loginFlowId - The ID of the login flow.
 * @param {FlowStateManager<any>} params.flowManager - The flow manager instance.
 */
function createOAuthEnd({ res, stepId, toolCall }) {
  return async function () {
    /** @type {{ id: string; delta: AgentToolCallDelta }} */
    const data = {
      id: stepId,
      delta: {
        type: StepTypes.TOOL_CALLS,
        tool_calls: [{ ...toolCall }],
      },
    };
    sendEvent(res, { event: GraphEvents.ON_RUN_STEP_DELTA, data });
    logger.debug('Sent OAuth login success to client');
  };
}

/**
 * @param {object} params
 * @param {string} params.userId - The ID of the user.
 * @param {string} params.serverName - The name of the server.
 * @param {string} params.toolName - The name of the tool.
 * @param {FlowStateManager<any>} params.flowManager - The flow manager instance.
 */
function createAbortHandler({ userId, serverName, toolName, flowManager }) {
  return function () {
    logger.info(`[MCP][User: ${userId}][${serverName}][${toolName}] Tool call aborted`);
    const flowId = MCPOAuthHandler.generateFlowId(userId, serverName);
    flowManager.failFlow(flowId, 'mcp_oauth', new Error('Tool call aborted'));
  };
}

/**
 * @param {Object} params
 * @param {() => void} params.runStepEmitter
 * @param {(authURL: string) => void} params.runStepDeltaEmitter
 * @returns {(authURL: string) => void}
 */
function createOAuthCallback({ runStepEmitter, runStepDeltaEmitter }) {
  return function (authURL) {
    runStepEmitter();
    runStepDeltaEmitter(authURL);
  };
}

/**
 * @param {Object} params
 * @param {ServerResponse} params.res - The Express response object for sending events.
 * @param {IUser} params.user - The user from the request object.
 * @param {string} params.serverName
 * @param {AbortSignal} params.signal
 * @param {string} params.model
 * @param {number} [params.index]
 * @param {Record<string, Record<string, string>>} [params.userMCPAuthMap]
 * @returns { Promise<Array<typeof tool | { _call: (toolInput: Object | string) => unknown}>> } An object with `_call` method to execute the tool input.
 */
async function reconnectServer({ res, user, index, signal, serverName, userMCPAuthMap }) {
  const runId = Constants.USE_PRELIM_RESPONSE_MESSAGE_ID;
  const flowId = `${user.id}:${serverName}:${Date.now()}`;
  const flowManager = getFlowStateManager(getLogStores(CacheKeys.FLOWS));
  const stepId = 'step_oauth_login_' + serverName;
  const toolCall = {
    id: flowId,
    name: serverName,
    type: 'tool_call_chunk',
  };

  const runStepEmitter = createRunStepEmitter({
    res,
    index,
    runId,
    stepId,
    toolCall,
  });
  const runStepDeltaEmitter = createRunStepDeltaEmitter({
    res,
    stepId,
    toolCall,
  });
  const callback = createOAuthCallback({ runStepEmitter, runStepDeltaEmitter });
  const oauthStart = createOAuthStart({
    res,
    flowId,
    callback,
    flowManager,
  });
  return await reinitMCPServer({
    user,
    signal,
    serverName,
    oauthStart,
    flowManager,
    userMCPAuthMap,
    forceNew: true,
    returnOnOAuth: false,
    connectionTimeout: Time.TWO_MINUTES,
  });
}

/**
 * Creates all tools from the specified MCP Server via `toolKey`.
 *
 * This function assumes tools could not be aggregated from the cache of tool definitions,
 * i.e. `availableTools`, and will reinitialize the MCP server to ensure all tools are generated.
 *
 * @param {Object} params
 * @param {ServerResponse} params.res - The Express response object for sending events.
 * @param {IUser} params.user - The user from the request object.
 * @param {string} params.serverName
 * @param {string} params.model
 * @param {Providers | EModelEndpoint} params.provider - The provider for the tool.
 * @param {number} [params.index]
 * @param {AbortSignal} [params.signal]
 * @param {import('@librechat/api').ParsedServerConfig} [params.config]
 * @param {Record<string, Record<string, string>>} [params.userMCPAuthMap]
 * @returns { Promise<Array<typeof tool | { _call: (toolInput: Object | string) => unknown}>> } An object with `_call` method to execute the tool input.
 */
async function createMCPTools({
  res,
  user,
  index,
  signal,
  config,
  provider,
  serverName,
  userMCPAuthMap,
}) {
  // Early domain validation before reconnecting server (avoid wasted work on disallowed domains)
  // Use getAppConfig() to support per-user/role domain restrictions
  const serverConfig =
    config ?? (await getMCPServersRegistry().getServerConfig(serverName, user?.id));
  if (serverConfig?.url) {
    const appConfig = await getAppConfig({ role: user?.role });
    const allowedDomains = appConfig?.mcpSettings?.allowedDomains;
    const isDomainAllowed = await isMCPDomainAllowed(serverConfig, allowedDomains);
    if (!isDomainAllowed) {
      logger.warn(`[MCP][${serverName}] Domain not allowed, skipping all tools`);
      return [];
    }
  }

  const result = await reconnectServer({ res, user, index, signal, serverName, userMCPAuthMap });
  if (!result || !result.tools) {
    logger.warn(`[MCP][${serverName}] Failed to reinitialize MCP server.`);
    return;
  }

  const serverTools = [];
  for (const tool of result.tools) {
    const toolInstance = await createMCPTool({
      res,
      user,
      provider,
      userMCPAuthMap,
      availableTools: result.availableTools,
      toolKey: `${tool.name}${Constants.mcp_delimiter}${serverName}`,
      config: serverConfig,
    });
    if (toolInstance) {
      serverTools.push(toolInstance);
    }
  }

  return serverTools;
}

/**
 * Creates a single tool from the specified MCP Server via `toolKey`.
 * @param {Object} params
 * @param {ServerResponse} params.res - The Express response object for sending events.
 * @param {IUser} params.user - The user from the request object.
 * @param {string} params.toolKey - The toolKey for the tool.
 * @param {string} params.model - The model for the tool.
 * @param {number} [params.index]
 * @param {AbortSignal} [params.signal]
 * @param {Providers | EModelEndpoint} params.provider - The provider for the tool.
 * @param {LCAvailableTools} [params.availableTools]
 * @param {Record<string, Record<string, string>>} [params.userMCPAuthMap]
 * @param {import('@librechat/api').ParsedServerConfig} [params.config]
 * @returns { Promise<typeof tool | { _call: (toolInput: Object | string) => unknown}> } An object with `_call` method to execute the tool input.
 */
async function createMCPTool({
  res,
  user,
  index,
  signal,
  toolKey,
  provider,
  userMCPAuthMap,
  availableTools,
  config,
}) {
  const [toolName, serverName] = toolKey.split(Constants.mcp_delimiter);

  // Runtime domain validation: check if the server's domain is still allowed
  // Use getAppConfig() to support per-user/role domain restrictions
  const serverConfig =
    config ?? (await getMCPServersRegistry().getServerConfig(serverName, user?.id));
  if (serverConfig?.url) {
    const appConfig = await getAppConfig({ role: user?.role });
    const allowedDomains = appConfig?.mcpSettings?.allowedDomains;
    const isDomainAllowed = await isMCPDomainAllowed(serverConfig, allowedDomains);
    if (!isDomainAllowed) {
      logger.warn(`[MCP][${serverName}] Domain no longer allowed, skipping tool: ${toolName}`);
      return undefined;
    }
  }

  /** @type {LCTool | undefined} */
  let toolDefinition = availableTools?.[toolKey]?.function;
  if (!toolDefinition) {
    logger.warn(
      `[MCP][${serverName}][${toolName}] Requested tool not found in available tools, re-initializing MCP server.`,
    );
    const result = await reconnectServer({
      res,
      user,
      index,
      signal,
      serverName,
      userMCPAuthMap,
    });
    toolDefinition = result?.availableTools?.[toolKey]?.function;
  }

  if (!toolDefinition) {
    logger.warn(`[MCP][${serverName}][${toolName}] Tool definition not found, cannot create tool.`);
    return;
  }

  return createToolInstance({
    res,
    provider,
    toolName,
    serverName,
    toolDefinition,
  });
}

function createToolInstance({ res, toolName, serverName, toolDefinition, provider: _provider }) {
  /** @type {LCTool} */
  const { description, parameters } = toolDefinition;
  const isGoogle = _provider === Providers.VERTEXAI || _provider === Providers.GOOGLE;
  let schema = convertWithResolvedRefs(parameters, {
    allowEmptyObject: !isGoogle,
    transformOneOfAnyOf: true,
  });

  if (!schema) {
    schema = z.object({ input: z.string().optional() });
  }

  const normalizedToolKey = `${toolName}${Constants.mcp_delimiter}${normalizeServerName(serverName)}`;

  /** @type {(toolArguments: Object | string, config?: GraphRunnableConfig) => Promise<unknown>} */
  const _call = async (toolArguments, config) => {
    const userId = config?.configurable?.user?.id || config?.configurable?.user_id;
    /** @type {ReturnType<typeof createAbortHandler>} */
    let abortHandler = null;
    /** @type {AbortSignal} */
    let derivedSignal = null;

    try {
      const flowsCache = getLogStores(CacheKeys.FLOWS);
      const flowManager = getFlowStateManager(flowsCache);
      derivedSignal = config?.signal ? AbortSignal.any([config.signal]) : undefined;
      const mcpManager = getMCPManager(userId);
      const provider = (config?.metadata?.provider || _provider)?.toLowerCase();

      const { args: _args, stepId, ...toolCall } = config.toolCall ?? {};
      const flowId = `${serverName}:oauth_login:${config.metadata.thread_id}:${config.metadata.run_id}`;
      const runStepDeltaEmitter = createRunStepDeltaEmitter({
        res,
        stepId,
        toolCall,
      });
      const oauthStart = createOAuthStart({
        flowId,
        flowManager,
        callback: runStepDeltaEmitter,
      });
      const oauthEnd = createOAuthEnd({
        res,
        stepId,
        toolCall,
      });

      if (derivedSignal) {
        abortHandler = createAbortHandler({ userId, serverName, toolName, flowManager });
        derivedSignal.addEventListener('abort', abortHandler, { once: true });
      }

      const customUserVars =
        config?.configurable?.userMCPAuthMap?.[`${Constants.mcp_prefix}${serverName}`];

      // For replicate-image/image-gen edit_image tool, always extract image URLs from conversation
      // This ensures we automatically use the most recent image from the conversation
      let finalToolArguments = toolArguments;
      if (
        (serverName === 'replicate-image' || serverName === 'image-gen') &&
        toolName === 'edit_image'
      ) {
        logger.info(`[MCP][${serverName}][${toolName}] Extracting image URLs from conversation`);
        const args = typeof toolArguments === 'string' ? JSON.parse(toolArguments) : toolArguments;

        // Always try to extract from conversation to ensure we use the most recent image
        // This allows the AI to call the tool without providing image_url
        const requestBody = config?.configurable?.requestBody;
        const conversationId = requestBody?.conversationId;

        let conversationImages = [];

        // Query conversation directly for the most recent image
        if (conversationId) {
          logger.info(
            `[MCP][${serverName}][${toolName}] Extracting image from conversation: ${conversationId}`,
          );
          conversationImages = await extractImageUrlsFromConversation(conversationId);
          logger.info(
            `[MCP][${serverName}][${toolName}] Extracted ${conversationImages.length} images from conversation`,
          );
        }

        // If image_url is not provided, use the extracted image
        if (!args?.image_url) {
          if (conversationImages.length > 0) {
            // Use the last (most recent) image URL
            let lastImageUrl = conversationImages[conversationImages.length - 1];

            // Convert local file paths to public URLs
            // Get app config for file path resolution
            const appConfig = await getAppConfig({ userId });
            const publicUrl = await convertToPublicURL(lastImageUrl, appConfig);
            if (publicUrl !== lastImageUrl) {
              logger.info(
                `[MCP][${serverName}][${toolName}] Converted local path to public URL: ${lastImageUrl} -> ${publicUrl}`,
              );
              lastImageUrl = publicUrl;
            }

            // Warn if using local path that might not be accessible externally
            if (lastImageUrl.startsWith('/') && !lastImageUrl.startsWith('http')) {
              logger.warn(
                `[MCP][${serverName}][${toolName}] Image URL is a local path that may not be accessible to Replicate API. Consider using cloud storage (S3, Firebase, Azure) or UploadThing for intranet deployments: ${lastImageUrl}`,
              );
            }

            // Pass the image URL directly and also include conversation context for fallback
            // conversation_context should be a string, not JSON
            finalToolArguments = {
              ...args,
              image_url: lastImageUrl,
              conversation_context: conversationImages.join(' '),
            };
            logger.info(
              `[MCP][${serverName}][${toolName}] Auto-extracted ${conversationImages.length} image URLs from conversation, using last image: ${lastImageUrl}`,
            );
          } else {
            logger.warn(
              `[MCP][${serverName}][${toolName}] No image URLs found in conversation and image_url not provided. Tool may fail.`,
            );
            // Still pass conversation_context as empty string (not array) even if no images found
            finalToolArguments = {
              ...args,
              conversation_context: '',
            };
          }
        } else {
          // image_url was provided, but still include conversation_context as fallback
          logger.info(
            `[MCP][${serverName}][${toolName}] image_url provided by user: ${args.image_url}. Also found ${conversationImages.length} images in conversation for context.`,
          );
          finalToolArguments = {
            ...args,
            conversation_context: conversationImages.length > 0 ? conversationImages.join(' ') : '',
          };
        }
      }

      const result = await mcpManager.callTool({
        serverName,
        toolName,
        provider,
        toolArguments: finalToolArguments,
        options: {
          signal: derivedSignal,
        },
        user: config?.configurable?.user,
        requestBody: config?.configurable?.requestBody,
        customUserVars,
        flowManager,
        tokenMethods: {
          findToken,
          createToken,
          updateToken,
        },
        oauthStart,
        oauthEnd,
      });

      // Log raw MCP result before normalization
      let rawResultPreview;
      try {
        rawResultPreview = JSON.stringify(result);
        if (rawResultPreview && rawResultPreview.length > 800) {
          rawResultPreview = rawResultPreview.slice(0, 800) + '...';
        }
      } catch (_e) {
        rawResultPreview = String(result);
      }
      logger.info(`[MCP][${serverName}][${toolName}] raw callTool result: ${rawResultPreview}`);

      const normalized = normalizeMCPImageResult(result);

      if (isAssistantsEndpoint(provider) && Array.isArray(normalized)) {
        return normalized[0];
      }
      if (
        isGoogle &&
        Array.isArray(normalized[0]) &&
        normalized[0][0]?.type === ContentTypes.TEXT
      ) {
        return [normalized[0][0].text, normalized[1]];
      }
      return normalized;
    } catch (error) {
      logger.error(
        `[MCP][${serverName}][${toolName}][User: ${userId}] Error calling MCP tool:`,
        error,
      );

      /** OAuth error, provide a helpful message */
      const isOAuthError =
        error.message?.includes('401') ||
        error.message?.includes('OAuth') ||
        error.message?.includes('authentication') ||
        error.message?.includes('Non-200 status code (401)');

      if (isOAuthError) {
        throw new Error(
          `[MCP][${serverName}][${toolName}] OAuth authentication required. Please check the server logs for the authentication URL.`,
        );
      }

      throw new Error(
        `[MCP][${serverName}][${toolName}] tool call failed${error?.message ? `: ${error?.message}` : '.'}`,
      );
    } finally {
      // Clean up abort handler to prevent memory leaks
      if (abortHandler && derivedSignal) {
        derivedSignal.removeEventListener('abort', abortHandler);
      }
    }
  };

  const toolInstance = tool(_call, {
    schema,
    name: normalizedToolKey,
    description: description || '',
    responseFormat: AgentConstants.CONTENT_AND_ARTIFACT,
  });
  toolInstance.mcp = true;
  toolInstance.mcpRawServerName = serverName;
  return toolInstance;
}

/**
 * Get MCP setup data including config, connections, and OAuth servers
 * @param {string} userId - The user ID
 * @returns {Object} Object containing mcpConfig, appConnections, userConnections, and oauthServers
 */
async function getMCPSetupData(userId) {
  const mcpConfig = await getMCPServersRegistry().getAllServerConfigs(userId);

  if (!mcpConfig) {
    throw new Error('MCP config not found');
  }

  const mcpManager = getMCPManager(userId);
  /** @type {Map<string, import('@librechat/api').MCPConnection>} */
  let appConnections = new Map();
  try {
    // Use getLoaded() instead of getAll() to avoid forcing connection creation
    // getAll() creates connections for all servers, which is problematic for servers
    // that require user context (e.g., those with {{LIBRECHAT_USER_ID}} placeholders)
    appConnections = (await mcpManager.appConnections?.getLoaded()) || new Map();
  } catch (error) {
    logger.error(`[MCP][User: ${userId}] Error getting app connections:`, error);
  }
  const userConnections = mcpManager.getUserConnections(userId) || new Map();
  const oauthServers = await getMCPServersRegistry().getOAuthServers(userId);

  return {
    mcpConfig,
    oauthServers,
    appConnections,
    userConnections,
  };
}

/**
 * Check OAuth flow status for a user and server
 * @param {string} userId - The user ID
 * @param {string} serverName - The server name
 * @returns {Object} Object containing hasActiveFlow and hasFailedFlow flags
 */
async function checkOAuthFlowStatus(userId, serverName) {
  const flowsCache = getLogStores(CacheKeys.FLOWS);
  const flowManager = getFlowStateManager(flowsCache);
  const flowId = MCPOAuthHandler.generateFlowId(userId, serverName);

  try {
    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (!flowState) {
      return { hasActiveFlow: false, hasFailedFlow: false };
    }

    const flowAge = Date.now() - flowState.createdAt;
    const flowTTL = flowState.ttl || 180000; // Default 3 minutes

    if (flowState.status === 'FAILED' || flowAge > flowTTL) {
      const wasCancelled = flowState.error && flowState.error.includes('cancelled');

      if (wasCancelled) {
        logger.debug(`[MCP Connection Status] Found cancelled OAuth flow for ${serverName}`, {
          flowId,
          status: flowState.status,
          error: flowState.error,
        });
        return { hasActiveFlow: false, hasFailedFlow: false };
      } else {
        logger.debug(`[MCP Connection Status] Found failed OAuth flow for ${serverName}`, {
          flowId,
          status: flowState.status,
          flowAge,
          flowTTL,
          timedOut: flowAge > flowTTL,
          error: flowState.error,
        });
        return { hasActiveFlow: false, hasFailedFlow: true };
      }
    }

    if (flowState.status === 'PENDING') {
      logger.debug(`[MCP Connection Status] Found active OAuth flow for ${serverName}`, {
        flowId,
        flowAge,
        flowTTL,
      });
      return { hasActiveFlow: true, hasFailedFlow: false };
    }

    return { hasActiveFlow: false, hasFailedFlow: false };
  } catch (error) {
    logger.error(`[MCP Connection Status] Error checking OAuth flows for ${serverName}:`, error);
    return { hasActiveFlow: false, hasFailedFlow: false };
  }
}

/**
 * Get connection status for a specific MCP server
 * @param {string} userId - The user ID
 * @param {string} serverName - The server name
 * @param {import('@librechat/api').ParsedServerConfig} config - The server configuration
 * @param {Map<string, import('@librechat/api').MCPConnection>} appConnections - App-level connections
 * @param {Map<string, import('@librechat/api').MCPConnection>} userConnections - User-level connections
 * @param {Set} oauthServers - Set of OAuth servers
 * @returns {Object} Object containing requiresOAuth and connectionState
 */
async function getServerConnectionStatus(
  userId,
  serverName,
  config,
  appConnections,
  userConnections,
  oauthServers,
) {
  const connection = appConnections.get(serverName) || userConnections.get(serverName);
  const isStaleOrDoNotExist = connection ? connection?.isStale(config.updatedAt) : true;

  const baseConnectionState = isStaleOrDoNotExist
    ? 'disconnected'
    : connection?.connectionState || 'disconnected';
  let finalConnectionState = baseConnectionState;

  // connection state overrides specific to OAuth servers
  if (baseConnectionState === 'disconnected' && oauthServers.has(serverName)) {
    // check if server is actively being reconnected
    const oauthReconnectionManager = getOAuthReconnectionManager();
    if (oauthReconnectionManager.isReconnecting(userId, serverName)) {
      finalConnectionState = 'connecting';
    } else {
      const { hasActiveFlow, hasFailedFlow } = await checkOAuthFlowStatus(userId, serverName);

      if (hasFailedFlow) {
        finalConnectionState = 'error';
      } else if (hasActiveFlow) {
        finalConnectionState = 'connecting';
      }
    }
  }

  return {
    requiresOAuth: oauthServers.has(serverName),
    connectionState: finalConnectionState,
  };
}

module.exports = {
  createMCPTool,
  createMCPTools,
  getMCPSetupData,
  checkOAuthFlowStatus,
  getServerConnectionStatus,
  normalizeMCPImageResult,
};
