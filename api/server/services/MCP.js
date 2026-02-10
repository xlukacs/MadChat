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
  resolveJsonSchemaRefs,
  GenerationJobManager,
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
const { getGraphApiToken } = require('./GraphTokenService');
const { reinitMCPServer } = require('./Tools/mcp');
const { getAppConfig } = require('./Config');
const { getLogStores } = require('~/cache');
const fs = require('fs');
const path = require('path');

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
 * Upload local file to S3 and get public URL
 * Uses the configured file storage strategy (S3, Azure, Firebase, or Local)
 */
const uploadToCloudStorage = async (localFilePath, appConfig, userId) => {
  if (!appConfig) {
    logger.warn('[MCP] App config not provided, cannot upload to cloud storage');
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

    logger.info(
      `[MCP] Uploading to cloud storage: ${fileName} (${(fileBuffer.length / 1024).toFixed(2)} KB)`,
    );

    // Get the storage strategy functions
    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    const strategyFunctions = getStrategyFunctions(appConfig.fileStrategy);

    if (!strategyFunctions?.saveBuffer) {
      logger.warn(
        `[MCP] Storage strategy "${appConfig.fileStrategy}" does not support saveBuffer. Cannot upload file.`,
      );
      return null;
    }

    // Determine base path based on file location
    const basePath = localFilePath.startsWith('/images/') ? 'images' : 'uploads';

    // Upload using the storage strategy
    const publicUrl = await strategyFunctions.saveBuffer({
      userId: userId || 'system',
      buffer: fileBuffer,
      fileName: fileName,
      basePath: basePath,
    });

    if (publicUrl) {
      logger.info(
        `[MCP] Successfully uploaded to ${appConfig.fileStrategy}: ${fileName} -> ${publicUrl}`,
      );
      return publicUrl;
    }

    logger.error(`[MCP] Upload to ${appConfig.fileStrategy} returned no URL`);
    return null;
  } catch (error) {
    logger.error(`[MCP] Error uploading to cloud storage: ${error.message}`, error);
    return null;
  }
};

/**
 * Upload local file to S3 specifically for external access (e.g., Replicate API)
 * This forces S3 upload even if the main fileStrategy is 'local'
 * Throws an error if S3 is not available - no fallbacks to DOMAIN_SERVER
 */
const uploadToS3ForExternalAccess = async (localFilePath, userId) => {
  if (!localFilePath) {
    throw new Error('No file path provided for S3 upload');
  }

  // If it's already an S3 URL, return as is
  if (
    localFilePath.includes('amazonaws.com') ||
    localFilePath.includes('s3.') ||
    localFilePath.includes('s3-')
  ) {
    logger.info(`[MCP] File is already an S3 URL: ${localFilePath}`);
    return localFilePath;
  }

  // If it's a DOMAIN_SERVER URL, extract the local path and upload to S3
  let actualLocalPath = localFilePath;
  if (localFilePath.startsWith('http://') || localFilePath.startsWith('https://')) {
    // Try to extract local path from DOMAIN_SERVER URL
    const domainServer = process.env.DOMAIN_SERVER;
    if (domainServer) {
      const baseUrl = domainServer.endsWith('/') ? domainServer.slice(0, -1) : domainServer;
      if (localFilePath.startsWith(baseUrl)) {
        actualLocalPath = localFilePath.replace(baseUrl, '');
        logger.info(`[MCP] Extracted local path from DOMAIN_SERVER URL: ${actualLocalPath}`);
      } else {
        // It's already a public URL (not DOMAIN_SERVER), check if it's S3
        if (!localFilePath.includes('amazonaws.com') && !localFilePath.includes('s3.')) {
          throw new Error(
            `File is already a public URL but not S3. Cannot use non-S3 URLs for Replicate access: ${localFilePath}. Please ensure S3 is configured.`,
          );
        }
        return localFilePath;
      }
    } else {
      throw new Error(
        `File is already a public URL but S3 is required for Replicate access: ${localFilePath}. Please ensure S3 is configured.`,
      );
    }
  }

  // Only process local paths
  if (!actualLocalPath.startsWith('/images/') && !actualLocalPath.startsWith('/uploads/')) {
    throw new Error(
      `Invalid file path format. Expected local path (/images/... or /uploads/...) but got: ${actualLocalPath}`,
    );
  }

  try {
    const appConfig = await getAppConfig({ userId });

    // Check if S3 is available (even if not the main fileStrategy)
    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    const { FileSources } = require('librechat-data-provider');

    // Try S3 - this is required, no fallbacks
    let s3Functions;
    try {
      s3Functions = getStrategyFunctions(FileSources.s3);
    } catch (_e) {
      throw new Error(
        'S3 strategy is not available. S3 is required for uploading input images for Replicate API access. Please configure S3 in your environment.',
      );
    }

    if (!s3Functions?.saveBuffer) {
      throw new Error(
        'S3 saveBuffer function is not available. S3 is required for uploading input images for Replicate API access. Please configure S3 in your environment.',
      );
    }

    // Read the file
    let fullPath;
    if (actualLocalPath.startsWith('/images/')) {
      const basePath = actualLocalPath.split('/images/')[1];
      fullPath = path.join(appConfig.paths.imageOutput, basePath);
    } else if (actualLocalPath.startsWith('/uploads/')) {
      const basePath = actualLocalPath.split('/uploads/')[1];
      fullPath = path.join(appConfig.paths.uploads, basePath);
    } else {
      fullPath = actualLocalPath;
    }

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found for S3 upload: ${fullPath}`);
    }

    const fileBuffer = fs.readFileSync(fullPath);
    const fileName = path.basename(fullPath);
    const basePath = actualLocalPath.startsWith('/images/') ? 'images' : 'uploads';

    logger.info(
      `[MCP] Uploading to S3 for external access: ${fileName} (${(fileBuffer.length / 1024).toFixed(2)} KB)`,
    );

    let s3Url;
    try {
      s3Url = await s3Functions.saveBuffer({
        userId: userId || 'system',
        buffer: fileBuffer,
        fileName: fileName,
        basePath: basePath,
      });
    } catch (saveError) {
      throw new Error(
        `S3 upload failed for file ${fileName}: ${saveError.message}. Please ensure S3 credentials are correct and the bucket is accessible.`,
      );
    }

    if (!s3Url || typeof s3Url !== 'string' || s3Url.trim() === '') {
      throw new Error(
        `S3 upload completed but no valid URL returned for file: ${fileName}. Please check S3 configuration.`,
      );
    }

    logger.info(`[MCP] Successfully uploaded to S3: ${fileName} -> ${s3Url}`);
    return s3Url;
  } catch (error) {
    logger.error(`[MCP] Error uploading to S3 for external access: ${error.message}`, error);
    throw error; // Re-throw instead of returning null
  }
};

/**
 * Convert local file path to public URL
 * For local storage, uploads to cloud storage (S3/Azure/Firebase) if configured, otherwise uses DOMAIN_SERVER
 * For cloud storage, the path should already be a full URL
 */
const convertToPublicURL = async (filePath, appConfig = null, userId = null) => {
  if (!filePath) {
    return null;
  }

  // If it's already a full URL (http/https), return as is
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    return filePath;
  }

  // If it's a local path (starts with /images/ or /uploads/), try to get public URL
  if (filePath.startsWith('/images/') || filePath.startsWith('/uploads/')) {
    // If cloud storage is configured (S3, Azure, Firebase), upload the file
    if (appConfig && appConfig.fileStrategy && appConfig.fileStrategy !== 'local') {
      const cloudUrl = await uploadToCloudStorage(filePath, appConfig, userId);
      if (cloudUrl) {
        return cloudUrl;
      }
      // If cloud upload fails, fall through to DOMAIN_SERVER
      logger.warn(
        `[MCP] Failed to upload to ${appConfig.fileStrategy}, falling back to DOMAIN_SERVER: ${filePath}`,
      );
    }

    // Fallback to DOMAIN_SERVER (for local storage or if cloud upload failed)
    const domainServer = process.env.DOMAIN_SERVER;
    if (domainServer) {
      // Remove trailing slash from domain if present
      const baseUrl = domainServer.endsWith('/') ? domainServer.slice(0, -1) : domainServer;
      logger.warn(
        `[MCP] Using DOMAIN_SERVER for file URL. This may not be accessible to external services if on intranet: ${filePath}`,
      );
      return `${baseUrl}${filePath}`;
    } else {
      throw new Error(
        `Local file path found but no cloud storage configured and DOMAIN_SERVER not set. File cannot be accessed by external services: ${filePath}`,
      );
    }
  }

  // Return as-is for other cases
  return filePath;
};

/**
 * Extract the most recent image URL from conversation
 * Queries the conversation directly, finds the last message with attachments,
 * uploads to S3/Azure/Firebase if configured, and returns the public URL
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

    // Get app config for cloud storage upload
    const appConfig = await getAppConfig();

    // Extract userId from file attachment if available (for S3 path)
    const userId = latestAttachment.user || null;

    // Convert to public URL (uploads to S3/Azure/Firebase if configured)
    const publicUrl = await convertToPublicURL(latestAttachment.filepath, appConfig, userId);

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

function isEmptyObjectSchema(jsonSchema) {
  return (
    jsonSchema != null &&
    typeof jsonSchema === 'object' &&
    jsonSchema.type === 'object' &&
    (jsonSchema.properties == null || Object.keys(jsonSchema.properties).length === 0) &&
    !jsonSchema.additionalProperties
  );
}

/**
 * @param {object} params
 * @param {ServerResponse} params.res - The Express response object for sending events.
 * @param {string} params.stepId - The ID of the step in the flow.
 * @param {ToolCallChunk} params.toolCall - The tool call object containing tool information.
 * @param {string | null} [params.streamId] - The stream ID for resumable mode.
 */
function createRunStepDeltaEmitter({ res, stepId, toolCall, streamId = null }) {
  /**
   * @param {string} authURL - The URL to redirect the user for OAuth authentication.
   * @returns {Promise<void>}
   */
  return async function (authURL) {
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
    const eventData = { event: GraphEvents.ON_RUN_STEP_DELTA, data };
    if (streamId) {
      await GenerationJobManager.emitChunk(streamId, eventData);
    } else {
      sendEvent(res, eventData);
    }
  };
}

/**
 * @param {object} params
 * @param {ServerResponse} params.res - The Express response object for sending events.
 * @param {string} params.runId - The Run ID, i.e. message ID
 * @param {string} params.stepId - The ID of the step in the flow.
 * @param {ToolCallChunk} params.toolCall - The tool call object containing tool information.
 * @param {number} [params.index]
 * @param {string | null} [params.streamId] - The stream ID for resumable mode.
 * @returns {() => Promise<void>}
 */
function createRunStepEmitter({ res, runId, stepId, toolCall, index, streamId = null }) {
  return async function () {
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
    const eventData = { event: GraphEvents.ON_RUN_STEP, data };
    if (streamId) {
      await GenerationJobManager.emitChunk(streamId, eventData);
    } else {
      sendEvent(res, eventData);
    }
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
 * @param {string | null} [params.streamId] - The stream ID for resumable mode.
 */
function createOAuthEnd({ res, stepId, toolCall, streamId = null }) {
  return async function () {
    /** @type {{ id: string; delta: AgentToolCallDelta }} */
    const data = {
      id: stepId,
      delta: {
        type: StepTypes.TOOL_CALLS,
        tool_calls: [{ ...toolCall }],
      },
    };
    const eventData = { event: GraphEvents.ON_RUN_STEP_DELTA, data };
    if (streamId) {
      await GenerationJobManager.emitChunk(streamId, eventData);
    } else {
      sendEvent(res, eventData);
    }
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
    // Clean up both mcp_oauth and mcp_get_tokens flows
    flowManager.failFlow(flowId, 'mcp_oauth', new Error('Tool call aborted'));
    flowManager.failFlow(flowId, 'mcp_get_tokens', new Error('Tool call aborted'));
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
 * @param {string | null} [params.streamId] - The stream ID for resumable mode.
 * @param {Record<string, Record<string, string>>} [params.userMCPAuthMap]
 * @returns { Promise<Array<typeof tool | { _call: (toolInput: Object | string) => unknown}>> } An object with `_call` method to execute the tool input.
 */
async function reconnectServer({
  res,
  user,
  index,
  signal,
  serverName,
  userMCPAuthMap,
  streamId = null,
}) {
  logger.debug(
    `[MCP][reconnectServer] serverName: ${serverName}, user: ${user?.id}, hasUserMCPAuthMap: ${!!userMCPAuthMap}`,
  );
  const runId = Constants.USE_PRELIM_RESPONSE_MESSAGE_ID;
  const flowId = `${user.id}:${serverName}:${Date.now()}`;
  const flowManager = getFlowStateManager(getLogStores(CacheKeys.FLOWS));
  const stepId = 'step_oauth_login_' + serverName;
  const toolCall = {
    id: flowId,
    name: serverName,
    type: 'tool_call_chunk',
  };

  // Set up abort handler to clean up OAuth flows if request is aborted
  const oauthFlowId = MCPOAuthHandler.generateFlowId(user.id, serverName);
  const abortHandler = () => {
    logger.info(
      `[MCP][User: ${user.id}][${serverName}] Tool loading aborted, cleaning up OAuth flows`,
    );
    // Clean up both mcp_oauth and mcp_get_tokens flows
    flowManager.failFlow(oauthFlowId, 'mcp_oauth', new Error('Tool loading aborted'));
    flowManager.failFlow(oauthFlowId, 'mcp_get_tokens', new Error('Tool loading aborted'));
  };

  if (signal) {
    signal.addEventListener('abort', abortHandler, { once: true });
  }

  try {
    const runStepEmitter = createRunStepEmitter({
      res,
      index,
      runId,
      stepId,
      toolCall,
      streamId,
    });
    const runStepDeltaEmitter = createRunStepDeltaEmitter({
      res,
      stepId,
      toolCall,
      streamId,
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
  } finally {
    // Clean up abort handler to prevent memory leaks
    if (signal) {
      signal.removeEventListener('abort', abortHandler);
    }
  }
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
 * @param {string | null} [params.streamId] - The stream ID for resumable mode.
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
  streamId = null,
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

  const result = await reconnectServer({
    res,
    user,
    index,
    signal,
    serverName,
    userMCPAuthMap,
    streamId,
  });
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
      streamId,
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
 * @param {string | null} [params.streamId] - The stream ID for resumable mode.
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
  streamId = null,
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
      streamId,
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
    streamId,
  });
}

function createToolInstance({
  res,
  toolName,
  serverName,
  toolDefinition,
  provider: _provider,
  streamId = null,
}) {
  /** @type {LCTool} */
  const { description, parameters } = toolDefinition;
  const isGoogle = _provider === Providers.VERTEXAI || _provider === Providers.GOOGLE;

  let schema = parameters ? resolveJsonSchemaRefs(parameters) : null;

  if (!schema || (isGoogle && isEmptyObjectSchema(schema))) {
    schema = {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Input for the tool' },
      },
      required: [],
    };
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
        streamId,
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
        streamId,
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

        // Always prioritize extracted images over user-provided image_url
        // This prevents using hallucinated URLs from the user's input
        if (conversationImages.length > 0) {
          // Use the last (most recent) image URL from conversation
          let lastImageUrl = conversationImages[conversationImages.length - 1];

          // Get the original local filepath from the database (not the converted URL)
          // We need to pass the local path to uploadToS3ForExternalAccess
          const { getFiles } = require('~/models/File');
          const requestBody = config?.configurable?.requestBody;
          const conversationId = requestBody?.conversationId;

          let localFilePath = null;
          if (conversationId) {
            const messages = await getMessages({ conversationId: conversationId });
            const messageIds = messages.map((msg) => msg.messageId);
            const fileAttachments = await getFiles(
              { messageId: { $in: messageIds }, type: { $regex: /^image\//i } },
              { updatedAt: -1 },
              {},
            );
            if (fileAttachments.length > 0) {
              localFilePath = fileAttachments[0].filepath;
            }
          }

          // For input images (for Replicate to access), always upload to S3
          // This ensures Replicate can access the image even if main fileStrategy is 'local'
          // Use the original local filepath if available, otherwise try the URL
          const filePathToUpload = localFilePath || lastImageUrl;
          if (!filePathToUpload) {
            throw new Error(
              `[MCP][${serverName}][${toolName}] No file path available for S3 upload. Cannot proceed with image editing.`,
            );
          }

          let s3Url;
          try {
            s3Url = await uploadToS3ForExternalAccess(filePathToUpload, userId);
            if (!s3Url || typeof s3Url !== 'string' || s3Url.trim() === '') {
              throw new Error('S3 upload returned empty or invalid URL');
            }
            logger.info(
              `[MCP][${serverName}][${toolName}] Uploaded input image to S3 for Replicate access: ${filePathToUpload} -> ${s3Url}`,
            );
            lastImageUrl = s3Url;
          } catch (error) {
            const errorMessage = error?.message || 'Unknown error';
            logger.error(
              `[MCP][${serverName}][${toolName}] Failed to upload input image to S3: ${errorMessage}`,
              error,
            );
            // Re-throw with a clear error message that will stop the tool call
            throw new Error(
              `Cannot edit image: S3 upload failed. ${errorMessage}. Please ensure S3 is properly configured with valid credentials and bucket access for Replicate API access. The tool call has been aborted.`,
            );
          }

          finalToolArguments = {
            ...args,
            image_url: lastImageUrl,
            conversation_context: conversationImages.join(' '),
          };
          logger.info(
            `[MCP][${serverName}][${toolName}] Auto-extracted ${conversationImages.length} image URLs from conversation, using last image: ${lastImageUrl}`,
          );
        } else if (args?.image_url) {
          // Only use user-provided image_url if no images found in conversation
          // But warn that it might be a hallucination
          logger.warn(
            `[MCP][${serverName}][${toolName}] No images found in conversation, using user-provided image_url (may be incorrect): ${args.image_url}`,
          );
          finalToolArguments = {
            ...args,
            conversation_context: '',
          };
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
        graphTokenResolver: getGraphApiToken,
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
  toolInstance.mcpJsonSchema = parameters;
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
