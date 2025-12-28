const { tool } = require('@librechat/agents/langchain/tools');
const { logger, getTenantId } = require('@librechat/data-schemas');
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
  normalizeJsonSchema,
  GenerationJobManager,
  resolveJsonSchemaRefs,
  buildOAuthToolCallName,
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
const { findToken, createToken, updateToken, deleteTokens } = require('~/models');
const { getGraphApiToken } = require('./GraphTokenService');
const { reinitMCPServer } = require('./Tools/mcp');
const { getAppConfig } = require('./Config');
const { getLogStores } = require('~/cache');

const MAX_CACHE_SIZE = 1000;
const lastReconnectAttempts = new Map();
const RECONNECT_THROTTLE_MS = 10_000;

const missingToolCache = new Map();
const MISSING_TOOL_TTL_MS = 10_000;

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

/**
 * Resolves config-source MCP servers from admin Config overrides for the current
 * request context. Returns the parsed configs keyed by server name.
 * @param {import('express').Request} req - Express request with user context
 * @returns {Promise<Record<string, import('@librechat/api').ParsedServerConfig>>}
 */
async function resolveConfigServers(req) {
  try {
    const registry = getMCPServersRegistry();
    const user = req?.user;
    const appConfig = await getAppConfig({
      role: user?.role,
      tenantId: getTenantId(),
      userId: user?.id,
    });
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
 * Resolves config-source servers and merges all server configs (YAML + config + user DB)
 * for the given user context. Shared helper for controllers needing the full merged config.
 * @param {string} userId
 * @param {{ id?: string, role?: string }} [user]
 * @returns {Promise<Record<string, import('@librechat/api').ParsedServerConfig>>}
 */
async function resolveAllMcpConfigs(userId, user) {
  const registry = getMCPServersRegistry();
  const appConfig = await getAppConfig({ role: user?.role, tenantId: getTenantId(), userId });
  let configServers = {};
  try {
    configServers = await registry.ensureConfigServers(appConfig?.mcpConfig || {});
  } catch (error) {
    logger.warn(
      '[resolveAllMcpConfigs] Config server resolution failed, continuing without:',
      error,
    );
  }
  return await registry.getAllServerConfigs(userId, configServers);
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
 * Extract image URLs from conversation messages in requestBody
 */
const extractImageUrlsFromConversation = (requestBody) => {
  if (!requestBody) {
    return [];
  }

  const imageUrls = [];

  // Extract from messages array if present
  if (requestBody.messages && Array.isArray(requestBody.messages)) {
    for (const message of requestBody.messages) {
      // Check content array for image URLs
      if (message.content && Array.isArray(message.content)) {
        for (const content of message.content) {
          // Check for image_url type
          if (content.type === 'image_url' && content.image_url?.url) {
            const url = content.image_url.url;
            if (isImageUrlString(url) && !imageUrls.includes(url)) {
              imageUrls.push(url);
            }
          }
          // Check for image_file type (file_id references)
          if (content.type === 'image_file' && content.image_file?.file_id) {
            // Note: file_id references would need to be resolved to URLs
            // For now, we'll skip these as they need additional processing
          }
          // Extract URLs from text content
          if (content.text || content.type === 'text') {
            const text = content.text || content[content.type] || '';
            const urls = extractImageUrls(text, []);
            urls.forEach((url) => {
              if (!imageUrls.includes(url)) {
                imageUrls.push(url);
              }
            });
          }
        }
      }
      // Check for attachments
      if (message.attachments && Array.isArray(message.attachments)) {
        for (const attachment of message.attachments) {
          if (attachment.url && isImageUrlString(attachment.url)) {
            if (!imageUrls.includes(attachment.url)) {
              imageUrls.push(attachment.url);
            }
          }
        }
      }
      // Extract from any text field in the message
      if (message.text) {
        const urls = extractImageUrls(message.text, []);
        urls.forEach((url) => {
          if (!imageUrls.includes(url)) {
            imageUrls.push(url);
          }
        });
      }
    }
  }

  // Also check for files array
  if (requestBody.files && Array.isArray(requestBody.files)) {
    for (const file of requestBody.files) {
      if (file.url && isImageUrlString(file.url)) {
        if (!imageUrls.includes(file.url)) {
          imageUrls.push(file.url);
        }
      }
      if (file.filepath && isImageUrlString(file.filepath)) {
        if (!imageUrls.includes(file.filepath)) {
          imageUrls.push(file.filepath);
        }
      }
    }
  }

  // Extract from any other fields recursively
  const allUrls = extractImageUrls(requestBody, []);
  allUrls.forEach((url) => {
    if (!imageUrls.includes(url)) {
      imageUrls.push(url);
    }
  });

  return imageUrls;
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
  configServers,
  userMCPAuthMap,
  streamId = null,
}) {
  logger.debug(
    `[MCP][reconnectServer] serverName: ${serverName}, user: ${user?.id}, hasUserMCPAuthMap: ${!!userMCPAuthMap}`,
  );

  const throttleKey = `${user.id}:${serverName}`;
  const now = Date.now();
  const lastAttempt = lastReconnectAttempts.get(throttleKey) ?? 0;
  if (now - lastAttempt < RECONNECT_THROTTLE_MS) {
    logger.debug(`[MCP][reconnectServer] Throttled reconnect for ${serverName}`);
    return null;
  }
  lastReconnectAttempts.set(throttleKey, now);
  evictStale(lastReconnectAttempts, RECONNECT_THROTTLE_MS);

  const runId = Constants.USE_PRELIM_RESPONSE_MESSAGE_ID;
  const flowId = `${user.id}:${serverName}:${Date.now()}`;
  const flowManager = getFlowStateManager(getLogStores(CacheKeys.FLOWS));
  const stepId = 'step_oauth_login_' + serverName;
  const toolCall = {
    id: flowId,
    name: buildOAuthToolCallName(serverName),
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
      configServers,
      oauthStart,
      flowManager,
      userMCPAuthMap,
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
  configServers,
  userMCPAuthMap,
  streamId = null,
}) {
  const serverConfig =
    config ?? (await getMCPServersRegistry().getServerConfig(serverName, user?.id, configServers));
  if (serverConfig?.url) {
    const appConfig = await getAppConfig({ role: user?.role, tenantId: user?.tenantId });
    const allowedDomains = appConfig?.mcpSettings?.allowedDomains;
    const allowedAddresses = appConfig?.mcpSettings?.allowedAddresses;
    const isDomainAllowed = await isMCPDomainAllowed(
      serverConfig,
      allowedDomains,
      allowedAddresses,
    );
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
    configServers,
    userMCPAuthMap,
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
      user,
      provider,
      userMCPAuthMap,
      configServers,
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
  configServers,
  streamId = null,
}) {
  const [toolName, serverName] = toolKey.split(Constants.mcp_delimiter);

  const serverConfig =
    config ?? (await getMCPServersRegistry().getServerConfig(serverName, user?.id, configServers));
  if (serverConfig?.url) {
    const appConfig = await getAppConfig({ role: user?.role, tenantId: user?.tenantId });
    const allowedDomains = appConfig?.mcpSettings?.allowedDomains;
    const allowedAddresses = appConfig?.mcpSettings?.allowedAddresses;
    const isDomainAllowed = await isMCPDomainAllowed(
      serverConfig,
      allowedDomains,
      allowedAddresses,
    );
    if (!isDomainAllowed) {
      logger.warn(`[MCP][${serverName}] Domain no longer allowed, skipping tool: ${toolName}`);
      return undefined;
    }
  }

  /** @type {LCTool | undefined} */
  let toolDefinition = availableTools?.[toolKey]?.function;
  if (!toolDefinition) {
    const cachedAt = missingToolCache.get(toolKey);
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
      configServers,
      userMCPAuthMap,
      streamId,
    });
    toolDefinition = result?.availableTools?.[toolKey]?.function;

    if (!toolDefinition) {
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
    provider,
    toolName,
    serverName,
    serverConfig,
    toolDefinition,
    streamId,
  });
}

function createToolInstance({
  res,
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
      const provider = (config?.metadata?.provider || capturedProvider)?.toLowerCase();

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

      // For replicate-image edit_image tool, extract image URLs from conversation if image_url not provided
      let finalToolArguments = toolArguments;
      if (serverName === 'replicate-image' && toolName === 'edit_image') {
        logger.info(`[MCP][${serverName}][${toolName}] Extracting image URLs from conversation`);
        const args = typeof toolArguments === 'string' ? JSON.parse(toolArguments) : toolArguments;

        // If image_url is not provided, try to extract from conversation
        if (!args?.image_url) {
          const requestBody = config?.configurable?.requestBody;
          const conversationImages = extractImageUrlsFromConversation(requestBody);

          if (conversationImages.length > 0) {
            // Use the last (most recent) image URL
            const lastImageUrl = conversationImages[conversationImages.length - 1];
            // Pass the image URL directly and also include conversation context for fallback
            finalToolArguments = {
              ...args,
              image_url: lastImageUrl,
              conversation_context: JSON.stringify(conversationImages.join(' ')),
            };
            logger.info(
              `[MCP][${serverName}][${toolName}] Extracted ${conversationImages.length} image URLs from conversation, using last image: ${lastImageUrl}`,
            );
          }
        }
      }

      const result = await mcpManager.callTool({
        serverName,
        serverConfig: capturedServerConfig,
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
          deleteTokens,
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
  const mcpConfig = await registry.getAllServerConfigs(userId, configServers);
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
  resolveConfigServers,
  resolveAllMcpConfigs,
  checkOAuthFlowStatus,
  getServerConnectionStatus,
  createUnavailableToolStub,
  normalizeMCPImageResult,
};
