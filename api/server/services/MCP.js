const { tool } = require('@librechat/agents/langchain/tools');
const { logger, getTenantId } = require('@librechat/data-schemas');
const { Providers, Constants: AgentConstants } = require('@librechat/agents');
const {
  sendEvent,
  PENDING_STALE_MS,
  MCPOAuthHandler,
  isMCPDomainAllowed,
  normalizeServerName,
  normalizeJsonSchema,
  GenerationJobManager,
  resolveJsonSchemaRefs,
  sanitizeGeminiSchema,
  buildMCPAuthStepId,
  buildMCPAuthToolCall,
  processMCPEnv,
  buildMCPAuthRunStepEvent,
  buildMCPAuthRunStepDeltaEvent,
  buildMCPAuthRunStepEndDeltaEvent,
  isUserSourced,
  checkAccessWithRequestCache,
  requiresEphemeralUserConnection,
  containsGraphTokenPlaceholder,
} = require('@librechat/api');
const {
  Time,
  CacheKeys,
  Constants,
  ContentTypes,
  Permissions,
  PermissionTypes,
  isAssistantsEndpoint,
} = require('librechat-data-provider');
const {
  getOAuthReconnectionManager,
  getMCPServersRegistry,
  getFlowStateManager,
  getMCPManager,
} = require('~/config');
const db = require('~/models');
const { findToken, createToken, updateToken, deleteTokens, getMessages, getFiles } = db;
const { getGraphApiToken } = require('./GraphTokenService');
const { exchangeOboToken } = require('./OboTokenService');
const { createOboTrustChecker } = require('./OboPolicyService');
const { reinitMCPServer } = require('./Tools/mcp');
const { getAppConfig } = require('./Config');
const { getLogStores } = require('~/cache');
const fs = require('fs');
const path = require('path');

const MAX_CACHE_SIZE = 1000;
const lastReconnectAttempts = new Map();
const RECONNECT_THROTTLE_MS = 10_000;

const missingToolCache = new Map();
const MISSING_TOOL_TTL_MS = 10_000;
const BROWSER_SERVER_NAME = 'browser';
const BROWSER_TASK_TOOL_NAME = 'browser_task';

async function userCanUseMCPServers(user, req) {
  if (!user?.id || !user?.role) {
    return false;
  }

  try {
    return await checkAccessWithRequestCache({
      req,
      user,
      permissionType: PermissionTypes.MCP_SERVERS,
      permissions: [Permissions.USE],
      getRoleByName: db.getRoleByName,
    });
  } catch (error) {
    logger.error(`[MCP][User: ${user.id}] Failed MCP permission check`, error);
    return false;
  }
}

function createMCPPermissionContext(req) {
  return {
    canUseServers: (user = req?.user) => userCanUseMCPServers(user, req),
  };
}

function evictStale(map, ttl) {
  if (map.size <= MAX_CACHE_SIZE) {
    return;
  }
  const now = Date.now();
  for (const [key, timestamp] of map) {
    if (now - timestamp >= ttl) {
      map.delete(key);
    }
    if (map.size <= MAX_CACHE_SIZE) {
      return;
    }
  }
}

const unavailableMsg =
  "This tool's MCP server is temporarily unavailable. Please try again shortly.";

function getOAuthFlowId(userId, serverName, tenantId = getTenantId()) {
  if (!tenantId) {
    return MCPOAuthHandler.generateFlowId(userId, serverName);
  }
  return MCPOAuthHandler.generateFlowId(userId, serverName, tenantId);
}

async function getAppConfigForRequest(req) {
  const user = req?.user;
  return await getAppConfigForUser(user?.id, user);
}

async function getAppConfigForUser(userId, user) {
  return await getAppConfig({ role: user?.role, tenantId: getTenantId(), userId });
}

/**
 * Resolves config-source MCP servers from admin Config overrides for the current
 * request context. Returns the parsed configs keyed by server name.
 * @param {import('express').Request} req - Express request with user context
 * @returns {Promise<Record<string, import('@librechat/api').ParsedServerConfig>>}
 */
async function resolveConfigServers(req) {
  try {
    const registry = getMCPServersRegistry();
    const appConfig = await getAppConfigForRequest(req);
    return await registry.ensureConfigServers(appConfig?.mcpConfig || {});
  } catch (error) {
    logger.warn(
      '[resolveConfigServers] Failed to resolve config servers, degrading to empty:',
      error,
    );
    return {};
  }
}

/**
 * Resolves operator-managed MCP server names from admin Config overrides for the current request.
 * Returns a request-time snapshot for DB server creation, not a cross-process lock.
 * @throws Propagates app config lookup errors to keep DB server creation fail-closed.
 * @param {import('express').Request} req - Express request with user context
 * @returns {Promise<string[]>}
 */
async function resolveMcpConfigNames(req) {
  const appConfig = await getAppConfigForRequest(req);
  return Object.keys(appConfig?.mcpConfig || {});
}

/**
 * Resolves config-source servers and merges all server configs (YAML + config + user DB)
 * for the given user context. Shared helper for controllers needing the full merged config.
 * @param {string} userId
 * @param {{ id?: string, role?: string }} [user]
 * @returns {Promise<Record<string, import('@librechat/api').ParsedServerConfig>>}
 */
async function resolveAllMcpConfigs(userId, user) {
  const registry = getMCPServersRegistry();
  const appConfig = await getAppConfigForUser(userId, user);
  let configServers = {};
  try {
    configServers = await registry.ensureConfigServers(appConfig?.mcpConfig || {});
  } catch (error) {
    logger.warn(
      '[resolveAllMcpConfigs] Config server resolution failed, continuing without:',
      error,
    );
  }
  if (user?.role) {
    return await registry.getAllServerConfigs(userId, configServers, user.role);
  }

  return await registry.getAllServerConfigs(userId, configServers);
}

function getServerCustomUserVars(userMCPAuthMap, serverName) {
  return userMCPAuthMap?.[`${Constants.mcp_prefix}${serverName}`];
}

/**
 * Best-effort early gate; the authoritative check is
 * `assertResolvedRuntimeConfigAllowed` in `@librechat/api`, whose resolution
 * this must mirror. Graph placeholders resolve later (async), so a URL still
 * carrying one defers to the authoritative check instead of rejecting here.
 */
async function isEarlyDomainAllowed({
  serverConfig,
  user,
  requestBody,
  userMCPAuthMap,
  serverName,
  allowedDomains,
  allowedAddresses,
}) {
  const validationConfig = processMCPEnv({
    user,
    body: requestBody,
    dbSourced: isUserSourced(serverConfig),
    options: serverConfig,
    customUserVars: getServerCustomUserVars(userMCPAuthMap, serverName),
  });
  if (
    typeof validationConfig?.url === 'string' &&
    containsGraphTokenPlaceholder(validationConfig.url)
  ) {
    return true;
  }
  return await isMCPDomainAllowed(validationConfig, allowedDomains, allowedAddresses);
}

/**
 * @param {string} toolName
 * @param {string} serverName
 */
function createUnavailableToolStub(toolName, serverName) {
  const normalizedToolKey = `${toolName}${Constants.mcp_delimiter}${normalizeServerName(serverName)}`;
  const _call = async () => [unavailableMsg, null];
  const toolInstance = tool(_call, {
    schema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Input for the tool' },
      },
      required: [],
    },
    name: normalizedToolKey,
    description: unavailableMsg,
    responseFormat: AgentConstants.CONTENT_AND_ARTIFACT,
  });
  toolInstance.mcp = true;
  toolInstance.mcpRawServerName = serverName;
  return toolInstance;
}

function isEmptyObjectSchema(jsonSchema) {
  return (
    jsonSchema != null &&
    typeof jsonSchema === 'object' &&
    jsonSchema.type === 'object' &&
    (jsonSchema.properties == null || Object.keys(jsonSchema.properties).length === 0) &&
    !jsonSchema.additionalProperties
  );
}

const IMAGE_URL_PATTERN = /https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|gif|webp|bmp|svg)/gi;
const REPLICATE_DELIVERY_PATTERN = /https?:\/\/replicate\.delivery\/[^\s"'<>]+/gi;

function parseToolArguments(toolArguments) {
  if (toolArguments && typeof toolArguments === 'object' && !Array.isArray(toolArguments)) {
    return toolArguments;
  }
  if (typeof toolArguments !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(toolArguments);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function withBrowserRuntimeContext({
  serverName,
  toolName,
  toolArguments,
  requestBody,
  agentId,
}) {
  if (serverName !== BROWSER_SERVER_NAME || toolName !== BROWSER_TASK_TOOL_NAME) {
    return toolArguments;
  }

  const parsed = parseToolArguments(toolArguments);
  if (!parsed) {
    return toolArguments;
  }

  const runtimeAgentId = agentId || requestBody?.agent_id;
  const runtimeConversationId = requestBody?.conversationId;
  return {
    ...parsed,
    ...(parsed.agentId || !runtimeAgentId ? {} : { agentId: runtimeAgentId }),
    ...(parsed.conversationId || !runtimeConversationId
      ? {}
      : { conversationId: runtimeConversationId }),
  };
}

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
   * @param {{ expiresAt?: number }} [options]
   * @returns {Promise<void>}
   */
  return async function (authURL, options) {
    const eventData = buildMCPAuthRunStepDeltaEvent({ authURL, stepId, toolCall, options });
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
    const eventData = buildMCPAuthRunStepEvent({ runId, stepId, toolCall, index });
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
 * @param {(authURL: string, options?: { expiresAt?: number }) => void | Promise<void>} [params.callback]
 */
function createOAuthStart({ flowId, flowManager, callback }) {
  /**
   * Creates a function to handle OAuth login requests.
   * @param {string} authURL - The URL to redirect the user for OAuth authentication.
   * @param {{ expiresAt?: number }} [options]
   * @returns {Promise<boolean>} Returns true to indicate the event was sent successfully.
   */
  return async function (authURL, options) {
    let emitted = false;
    const emitOAuthStart = async (message) => {
      if (options) {
        await callback?.(authURL, options);
      } else {
        await callback?.(authURL);
      }
      emitted = true;
      logger.debug(message);
    };

    const existingFlow = await flowManager.getFlowState(flowId, 'oauth_login');
    if (existingFlow) {
      await emitOAuthStart('Re-sent OAuth login request to client');
      return true;
    }

    await flowManager.createFlowWithHandler(flowId, 'oauth_login', async () => {
      await emitOAuthStart('Sent OAuth login request to client');
      return true;
    });

    if (!emitted) {
      await emitOAuthStart('Re-sent OAuth login request to client');
    }

    return true;
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
    const eventData = buildMCPAuthRunStepEndDeltaEvent({ stepId, toolCall });
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
 * @param {string} [params.tenantId] - The tenant ID for the current request.
 * @param {FlowStateManager<any>} params.flowManager - The flow manager instance.
 */
function createAbortHandler({ userId, serverName, toolName, tenantId, flowManager }) {
  return function () {
    logger.info(`[MCP][User: ${userId}][${serverName}][${toolName}] Tool call aborted`);
    const flowId = getOAuthFlowId(userId, serverName, tenantId);
    // Clean up both mcp_oauth and mcp_get_tokens flows
    flowManager.failFlow(flowId, 'mcp_oauth', new Error('Tool call aborted'));
    flowManager.failFlow(flowId, 'mcp_get_tokens', new Error('Tool call aborted'));
  };
}

/**
 * @param {Object} params
 * @param {() => Promise<void>} params.runStepEmitter
 * @param {(authURL: string, options?: { expiresAt?: number }) => Promise<void>} params.runStepDeltaEmitter
 * @returns {(authURL: string, options?: { expiresAt?: number }) => Promise<void>}
 */
function createOAuthCallback({ runStepEmitter, runStepDeltaEmitter }) {
  return async function (authURL, options) {
    await runStepEmitter();
    await runStepDeltaEmitter(authURL, options);
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
 * @param {import('@librechat/api').RequestScopedMCPConnectionStore} [params.requestScopedConnections]
 * @param {import('@librechat/api').ParsedServerConfig} [params.serverConfig] - Used to bypass reconnect throttling for request-scoped servers.
 * @returns { Promise<Array<typeof tool | { _call: (toolInput: Object | string) => unknown}>> } An object with `_call` method to execute the tool input.
 */
async function reconnectServer({
  res,
  user,
  index,
  signal,
  serverName,
  serverConfig,
  configServers,
  userMCPAuthMap,
  requestBody,
  requestScopedConnections,
  streamId = null,
}) {
  logger.debug(
    `[MCP][reconnectServer] serverName: ${serverName}, user: ${user?.id}, hasUserMCPAuthMap: ${!!userMCPAuthMap}`,
  );

  // Request-scoped servers reconnect on every message by design; throttling them
  // would stub out healthy tools for messages sent within the throttle window.
  const requestScoped = serverConfig ? requiresEphemeralUserConnection(serverConfig) : false;
  if (!requestScoped) {
    const throttleKey = `${user.id}:${serverName}`;
    const now = Date.now();
    const lastAttempt = lastReconnectAttempts.get(throttleKey) ?? 0;
    if (now - lastAttempt < RECONNECT_THROTTLE_MS) {
      logger.debug(`[MCP][reconnectServer] Throttled reconnect for ${serverName}`);
      return null;
    }
    lastReconnectAttempts.set(throttleKey, now);
    evictStale(lastReconnectAttempts, RECONNECT_THROTTLE_MS);
  }

  const runId = Constants.USE_PRELIM_RESPONSE_MESSAGE_ID;
  const flowId = `${user.id}:${serverName}:${Date.now()}`;
  const flowManager = getFlowStateManager(getLogStores(CacheKeys.FLOWS));
  const stepId = buildMCPAuthStepId(serverName);
  const toolCall = buildMCPAuthToolCall({
    id: flowId,
    serverName,
  });

  // Set up abort handler to clean up OAuth flows if request is aborted
  const tenantId = user?.tenantId ?? getTenantId();
  const oauthFlowId = getOAuthFlowId(user.id, serverName, tenantId);
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
      configServers,
      oauthStart,
      flowManager,
      userMCPAuthMap,
      requestBody,
      requestScopedConnections,
      forceNew: true,
      returnOnOAuth: false,
      connectionTimeout: Time.THIRTY_SECONDS,
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
 * @param {{ canUseServers: (user?: IUser) => Promise<boolean> }} [params.mcpPermissionContext] - Request-scoped MCP permission context.
 * @param {IUser} params.user - The user from the request object.
 * @param {string} params.serverName
 * @param {string} params.model
 * @param {Providers | EModelEndpoint} params.provider - The provider for the tool.
 * @param {string} [params.agentId] - Agent id owning this tool for runtime context injection.
 * @param {number} [params.index]
 * @param {AbortSignal} [params.signal]
 * @param {string | null} [params.streamId] - The stream ID for resumable mode.
 * @param {import('@librechat/api').ParsedServerConfig} [params.config]
 * @param {import('@librechat/api').RequestBody} [params.requestBody]
 * @param {import('@librechat/api').RequestScopedMCPConnectionStore} [params.requestScopedConnections]
 * @param {Record<string, Record<string, string>>} [params.userMCPAuthMap]
 * @returns { Promise<Array<typeof tool | { _call: (toolInput: Object | string) => unknown}>> } An object with `_call` method to execute the tool input.
 */
async function createMCPTools({
  res,
  mcpPermissionContext,
  user,
  index,
  signal,
  config,
  provider,
  agentId,
  serverName,
  configServers,
  userMCPAuthMap,
  requestBody,
  requestScopedConnections,
  streamId = null,
}) {
  const serverConfig =
    config ?? (await getMCPServersRegistry().getServerConfig(serverName, user?.id, configServers));

  if (serverConfig?.url) {
    const appConfig = await getAppConfig({
      role: user?.role,
      tenantId: user?.tenantId,
      userId: user?.id,
    });
    const allowedDomains = appConfig?.mcpSettings?.allowedDomains;
    const allowedAddresses = appConfig?.mcpSettings?.allowedAddresses;
    const isDomainAllowed = await isEarlyDomainAllowed({
      serverConfig,
      user,
      requestBody,
      userMCPAuthMap,
      serverName,
      allowedDomains,
      allowedAddresses,
    });
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
    serverConfig,
    configServers,
    userMCPAuthMap,
    requestBody,
    requestScopedConnections,
    streamId,
  });
  if (result === null) {
    logger.debug(`[MCP][${serverName}] Reconnect throttled, skipping tool creation.`);
    return [];
  }
  if (!result || !result.tools) {
    logger.warn(`[MCP][${serverName}] Failed to reinitialize MCP server.`);
    return [];
  }

  const serverTools = [];
  for (const tool of result.tools) {
    const toolInstance = await createMCPTool({
      res,
      mcpPermissionContext,
      user,
      provider,
      agentId,
      userMCPAuthMap,
      configServers,
      streamId,
      availableTools: result.availableTools,
      toolKey: `${tool.name}${Constants.mcp_delimiter}${serverName}`,
      requestBody,
      requestScopedConnections,
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
 * @param {{ canUseServers: (user?: IUser) => Promise<boolean> }} [params.mcpPermissionContext] - Request-scoped MCP permission context.
 * @param {IUser} params.user - The user from the request object.
 * @param {string} params.toolKey - The toolKey for the tool.
 * @param {string} params.model - The model for the tool.
 * @param {number} [params.index]
 * @param {AbortSignal} [params.signal]
 * @param {string | null} [params.streamId] - The stream ID for resumable mode.
 * @param {Providers | EModelEndpoint} params.provider - The provider for the tool.
 * @param {string} [params.agentId] - Agent id owning this tool for runtime context injection.
 * @param {LCAvailableTools} [params.availableTools]
 * @param {import('@librechat/api').RequestBody} [params.requestBody]
 * @param {import('@librechat/api').RequestScopedMCPConnectionStore} [params.requestScopedConnections]
 * @param {Record<string, Record<string, string>>} [params.userMCPAuthMap]
 * @param {import('@librechat/api').ParsedServerConfig} [params.config]
 * @param {(availableTools: LCAvailableTools) => void} [params.onAvailableTools]
 * @returns { Promise<typeof tool | { _call: (toolInput: Object | string) => unknown}> } An object with `_call` method to execute the tool input.
 */
async function createMCPTool({
  res,
  mcpPermissionContext,
  user,
  index,
  signal,
  toolKey,
  provider,
  agentId,
  userMCPAuthMap,
  availableTools,
  requestBody,
  requestScopedConnections,
  config,
  configServers,
  onAvailableTools,
  streamId = null,
}) {
  const [toolName, serverName] = toolKey.split(Constants.mcp_delimiter);

  const serverConfig =
    config ?? (await getMCPServersRegistry().getServerConfig(serverName, user?.id, configServers));
  const requestScopedTools = serverConfig ? requiresEphemeralUserConnection(serverConfig) : false;
  const useMissingToolCache = !requestScopedTools;

  if (serverConfig?.url) {
    const appConfig = await getAppConfig({
      role: user?.role,
      tenantId: user?.tenantId,
      userId: user?.id,
    });
    const allowedDomains = appConfig?.mcpSettings?.allowedDomains;
    const allowedAddresses = appConfig?.mcpSettings?.allowedAddresses;
    const isDomainAllowed = await isEarlyDomainAllowed({
      serverConfig,
      user,
      requestBody,
      userMCPAuthMap,
      serverName,
      allowedDomains,
      allowedAddresses,
    });
    if (!isDomainAllowed) {
      logger.warn(`[MCP][${serverName}] Domain no longer allowed, skipping tool: ${toolName}`);
      return undefined;
    }
  }

  /** @type {LCTool | undefined} */
  let toolDefinition = availableTools?.[toolKey]?.function;
  if (!toolDefinition) {
    const cachedAt = useMissingToolCache ? missingToolCache.get(toolKey) : undefined;
    if (cachedAt && Date.now() - cachedAt < MISSING_TOOL_TTL_MS) {
      logger.debug(
        `[MCP][${serverName}][${toolName}] Tool in negative cache, returning unavailable stub.`,
      );
      return createUnavailableToolStub(toolName, serverName);
    }

    logger.warn(
      `[MCP][${serverName}][${toolName}] Requested tool not found in available tools, re-initializing MCP server.`,
    );
    const result = await reconnectServer({
      res,
      user,
      index,
      signal,
      serverName,
      serverConfig,
      configServers,
      userMCPAuthMap,
      requestBody,
      requestScopedConnections,
      streamId,
    });
    if (result?.availableTools) {
      onAvailableTools?.(result.availableTools);
    }
    toolDefinition = result?.availableTools?.[toolKey]?.function;

    if (!toolDefinition && useMissingToolCache) {
      missingToolCache.set(toolKey, Date.now());
      evictStale(missingToolCache, MISSING_TOOL_TTL_MS);
    }
  }

  if (!toolDefinition) {
    logger.warn(
      `[MCP][${serverName}][${toolName}] Tool definition not found, returning unavailable stub.`,
    );
    return createUnavailableToolStub(toolName, serverName);
  }

  return createToolInstance({
    res,
    mcpPermissionContext,
    user,
    requestBody,
    requestScopedConnections,
    provider,
    agentId,
    toolName,
    serverName,
    serverConfig,
    toolDefinition,
    streamId,
  });
}

function createToolInstance({
  res,
  mcpPermissionContext,
  user: capturedUser = null,
  requestBody: capturedRequestBody,
  requestScopedConnections: capturedRequestScopedConnections,
  agentId: capturedAgentId,
  toolName,
  serverName,
  serverConfig: capturedServerConfig,
  toolDefinition,
  provider: capturedProvider,
  streamId = null,
}) {
  /** @type {LCTool} */
  const { description, parameters } = toolDefinition;
  const isGoogle = capturedProvider === Providers.VERTEXAI || capturedProvider === Providers.GOOGLE;

  let schema = parameters ? normalizeJsonSchema(resolveJsonSchemaRefs(parameters)) : null;

  if (schema && isGoogle) {
    // Gemini/Vertex AI accept only a subset of JSON Schema; sanitize so MCP tools with
    // unions, non-string enums, etc. don't 400 (they work as-is on OpenAI/Claude).
    schema = sanitizeGeminiSchema(schema);
  }

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
    const effectiveUser = config?.configurable?.user ?? capturedUser;
    const permissionUser = effectiveUser;
    const userId = effectiveUser?.id || config?.configurable?.user_id || capturedUser?.id;
    /** @type {ReturnType<typeof createAbortHandler>} */
    let abortHandler = null;
    /** @type {AbortSignal} */
    let derivedSignal = null;

    try {
      const provider = (config?.metadata?.provider || capturedProvider)?.toLowerCase();
      const canUseMCP = mcpPermissionContext
        ? await mcpPermissionContext.canUseServers(permissionUser)
        : await userCanUseMCPServers(permissionUser);
      if (!canUseMCP) {
        throw new Error('Forbidden: Insufficient MCP server permissions');
      }
      const flowsCache = getLogStores(CacheKeys.FLOWS);
      const flowManager = getFlowStateManager(flowsCache);
      derivedSignal = config?.signal ? AbortSignal.any([config.signal]) : undefined;
      const mcpManager = getMCPManager(userId);

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
        const tenantId = config?.configurable?.user?.tenantId ?? getTenantId();
        abortHandler = createAbortHandler({ userId, serverName, toolName, tenantId, flowManager });
        derivedSignal.addEventListener('abort', abortHandler, { once: true });
      }

      const customUserVars =
        config?.configurable?.userMCPAuthMap?.[`${Constants.mcp_prefix}${serverName}`];
      const requestBody = config?.configurable?.requestBody ?? capturedRequestBody;
      const agentId = config?.configurable?.agentId ?? capturedAgentId;

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

      finalToolArguments = withBrowserRuntimeContext({
        serverName,
        toolName,
        toolArguments: finalToolArguments,
        requestBody,
        agentId,
      });

      const result = await mcpManager.callTool({
        serverName,
        serverConfig: capturedServerConfig,
        toolName,
        provider,
        toolArguments: finalToolArguments,
        options: {
          signal: derivedSignal,
        },
        user: effectiveUser,
        requestBody,
        requestScopedConnections:
          config?.configurable?.requestScopedConnections ?? capturedRequestScopedConnections,
        customUserVars,
        flowManager,
        tokenMethods: {
          findToken,
          createToken,
          updateToken,
          deleteTokens,
        },
        oauthStart,
        oauthEnd,
        graphTokenResolver: getGraphApiToken,
        oboTokenResolver: exchangeOboToken,
        oboTrustChecker: createOboTrustChecker(),
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
  // On Google/Vertex, propagate the union-flattened schema so definitions extracted
  // from this instance don't reach the Gemini converter with unsupported unions.
  toolInstance.mcpJsonSchema = isGoogle ? schema : parameters;
  return toolInstance;
}

/**
 * Get MCP setup data including config, connections, and OAuth servers.
 * Resolves config-source servers from admin Config overrides when tenant context is available.
 * @param {string} userId - The user ID
 * @param {{ role?: string, tenantId?: string }} [options] - Optional role/tenant context
 * @returns {Object} Object containing mcpConfig, appConnections, userConnections, and oauthServers
 */
async function getMCPSetupData(userId, options = {}) {
  const registry = getMCPServersRegistry();
  const { role, tenantId } = options;

  const appConfig = await getAppConfig({ role, tenantId, userId });
  const configServers = await registry.ensureConfigServers(appConfig?.mcpConfig || {});
  const mcpConfig = role
    ? await registry.getAllServerConfigs(userId, configServers, role)
    : await registry.getAllServerConfigs(userId, configServers);
  const mcpManager = getMCPManager(userId);
  /** @type {Map<string, import('@librechat/api').MCPConnection>} */
  let appConnections = new Map();
  try {
    // Use getLoaded() instead of getAll() to avoid forcing connection creation.
    // getAll() creates connections for all servers, which is problematic for servers
    // that require user context (e.g., those with {{LIBRECHAT_USER_ID}} placeholders).
    appConnections = (await mcpManager.appConnections?.getLoaded()) || new Map();
  } catch (error) {
    logger.error(`[MCP][User: ${userId}] Error getting app connections:`, error);
  }
  const userConnections = mcpManager.getUserConnections(userId) || new Map();
  const oauthServers = new Set(
    Object.entries(mcpConfig)
      .filter(([, config]) => config.requiresOAuth)
      .map(([name]) => name),
  );

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
 * @param {string} [tenantId] - The tenant ID for the current request.
 * @returns {Object} Object containing hasActiveFlow and hasFailedFlow flags
 */
async function checkOAuthFlowStatus(userId, serverName, tenantId = getTenantId()) {
  const flowsCache = getLogStores(CacheKeys.FLOWS);
  const flowManager = getFlowStateManager(flowsCache);
  const flowId = getOAuthFlowId(userId, serverName, tenantId);

  try {
    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (!flowState) {
      return { hasActiveFlow: false, hasFailedFlow: false };
    }

    const flowAge = Date.now() - flowState.createdAt;
    // Report active only while the flow is still usable (the handling/reuse window),
    // not for the full Keyv retention TTL — otherwise the UI shows "connecting" for a
    // flow the initiate/callback paths already reject, hiding the connect button.
    const flowTTL = flowState.ttl || PENDING_STALE_MS;

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
  createMCPPermissionContext,
  userCanUseMCPServers,
  getMCPSetupData,
  resolveConfigServers,
  resolveMcpConfigNames,
  resolveAllMcpConfigs,
  createOAuthStart,
  checkOAuthFlowStatus,
  getServerConnectionStatus,
  createUnavailableToolStub,
  normalizeMCPImageResult,
};
