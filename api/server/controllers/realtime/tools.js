const { logger } = require('@librechat/data-schemas');
const {
  convertToRealtimeFunctionTools,
  executeRealtimeTool,
  filterToolsByServer,
} = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config');
const { getMCPServerTools } = require('~/server/services/Config/getCachedTools');
const { cacheMCPServerTools } = require('~/server/services/Config/mcp');
const { reinitMCPServer } = require('~/server/services/Tools/mcp');
const { getMCPManager, getFlowStateManager } = require('~/config');
const { findToken, createToken, updateToken, deleteTokens } = require('~/models');

function hasTools(serverTools) {
  return serverTools != null && Object.keys(serverTools).length > 0;
}

async function cacheToolsIfNeeded(userId, serverName, serverTools) {
  if (!hasTools(serverTools)) {
    return;
  }
  await cacheMCPServerTools({ userId, serverName, serverTools }).catch((err) =>
    logger.error(`[RealtimeTools] Failed to cache tools for ${serverName}:`, err),
  );
}

async function loadServerTools(userId, serverName, user) {
  const cachedTools = await getMCPServerTools(userId, serverName);
  if (hasTools(cachedTools)) {
    return cachedTools;
  }

  const mcpManager = getMCPManager();

  let serverTools = await mcpManager.getServerToolFunctions(userId, serverName);
  if (hasTools(serverTools)) {
    await cacheToolsIfNeeded(userId, serverName, serverTools);
    return serverTools;
  }

  const appTools = await mcpManager.getAppToolFunctions();
  const appServerTools = filterToolsByServer(appTools, serverName);
  if (hasTools(appServerTools)) {
    await cacheToolsIfNeeded(userId, serverName, appServerTools);
    logger.info(
      `[RealtimeTools] Loaded ${Object.keys(appServerTools).length} app-level tools for ${serverName}`,
    );
    return appServerTools;
  }

  logger.info(`[RealtimeTools] No cached tools for ${serverName}, initializing MCP connection`);
  const initResult = await reinitMCPServer({
    user,
    serverName,
    returnOnOAuth: false,
  });

  if (hasTools(initResult?.availableTools)) {
    logger.info(
      `[RealtimeTools] Initialized ${Object.keys(initResult.availableTools).length} tools for ${serverName}`,
    );
    return initResult.availableTools;
  }

  serverTools = await mcpManager.getServerToolFunctions(userId, serverName);
  if (hasTools(serverTools)) {
    await cacheToolsIfNeeded(userId, serverName, serverTools);
    return serverTools;
  }

  logger.warn(`[RealtimeTools] No tools available for MCP server "${serverName}"`);
  return {};
}

async function getRealtimeTools(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const appConfig = await getAppConfig({ role: req.user?.role, tenantId: req.user?.tenantId });
    const mcpServers = appConfig?.speech?.realtime?.mcpServers ?? [];
    if (!Array.isArray(mcpServers) || mcpServers.length === 0) {
      logger.warn('[RealtimeTools] No speech.realtime.mcpServers configured');
      return res.status(200).json({ tools: [], toolMap: {} });
    }

    const serverToolsByServer = {};
    for (const serverName of mcpServers) {
      try {
        serverToolsByServer[serverName] = await loadServerTools(userId, serverName, req.user);
      } catch (error) {
        logger.error(`[RealtimeTools] Failed to load tools for ${serverName}:`, error);
        serverToolsByServer[serverName] = {};
      }
    }

    const { tools, toolMap } = convertToRealtimeFunctionTools(serverToolsByServer);
    logger.info(`[RealtimeTools] Returning ${tools.length} function tools for Realtime session`);
    return res.status(200).json({ tools, toolMap });
  } catch (error) {
    logger.error('[RealtimeTools] Failed to list tools', error);
    return res.status(500).json({ error: 'Failed to load realtime tools' });
  }
}

async function executeRealtimeToolHandler(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { name, arguments: toolArguments } = req.body ?? {};
    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Missing tool name' });
    }

    const appConfig = await getAppConfig({ role: req.user?.role, tenantId: req.user?.tenantId });
    const mcpServers = appConfig?.speech?.realtime?.mcpServers ?? [];
    if (!Array.isArray(mcpServers) || mcpServers.length === 0) {
      return res.status(403).json({ error: 'Realtime MCP tools are not configured' });
    }

    const serverToolsByServer = {};
    for (const serverName of mcpServers) {
      serverToolsByServer[serverName] = await loadServerTools(userId, serverName, req.user);
    }

    const { toolMap } = convertToRealtimeFunctionTools(serverToolsByServer);
    const mapping = toolMap[name];
    if (!mapping) {
      return res.status(404).json({ error: `Unknown tool: ${name}` });
    }

    const parsedArguments =
      toolArguments != null && typeof toolArguments === 'object' && !Array.isArray(toolArguments)
        ? toolArguments
        : {};

    logger.info(
      `[RealtimeTools] Executing ${mapping.toolName} on ${mapping.serverName} for user ${userId}`,
    );

    const output = await executeRealtimeTool({
      mcpManager: getMCPManager(),
      flowManager: getFlowStateManager(),
      tokenMethods: {
        findToken,
        createToken,
        updateToken,
        deleteTokens,
      },
      user: req.user,
      serverName: mapping.serverName,
      toolName: mapping.toolName,
      toolArguments: parsedArguments,
    });

    return res.status(200).json({ output });
  } catch (error) {
    logger.error('[RealtimeTools] Failed to execute tool', error);
    const message = error instanceof Error ? error.message : 'Failed to execute tool';
    return res.status(500).json({ error: message });
  }
}

module.exports = {
  getRealtimeTools,
  executeRealtimeToolHandler,
};
