import { Constants } from 'librechat-data-provider';
import type { FlowStateManager } from '~/flow/manager';
import type { MCPManager } from '~/mcp/MCPManager';
import type { LCAvailableTools, Provider } from '~/mcp/types';
import type { MCPOAuthTokens } from '~/mcp/oauth/types';
import type { TokenMethods } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';

export type RealtimeFunctionTool = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type RealtimeToolMapEntry = {
  serverName: string;
  toolName: string;
};

export type RealtimeToolsResult = {
  tools: RealtimeFunctionTool[];
  toolMap: Record<string, RealtimeToolMapEntry>;
};

export function filterToolsByServer(
  tools: LCAvailableTools,
  serverName: string,
): LCAvailableTools {
  const suffix = `${Constants.mcp_delimiter}${serverName}`;
  const filtered: LCAvailableTools = {};

  for (const [toolKey, toolDef] of Object.entries(tools)) {
    if (toolKey.endsWith(suffix)) {
      filtered[toolKey] = toolDef;
    }
  }

  return filtered;
}

export function convertToRealtimeFunctionTools(
  serverToolsByServer: Record<string, LCAvailableTools>,
): RealtimeToolsResult {
  const tools: RealtimeFunctionTool[] = [];
  const toolMap: Record<string, RealtimeToolMapEntry> = {};
  const delimiter = Constants.mcp_delimiter;

  for (const [serverName, serverTools] of Object.entries(serverToolsByServer)) {
    for (const [toolKey, toolDef] of Object.entries(serverTools)) {
      if (!toolDef?.function || !toolKey.includes(delimiter)) {
        continue;
      }

      const toolName = toolKey.split(delimiter)[0];
      if (!toolName) {
        continue;
      }

      const hasConflict = toolMap[toolName] != null && toolMap[toolName].serverName !== serverName;
      const realtimeName = hasConflict ? `${serverName}_${toolName}` : toolName;

      toolMap[realtimeName] = { serverName, toolName };
      tools.push({
        type: 'function',
        name: realtimeName,
        description: toolDef.function.description ?? '',
        parameters: (toolDef.function.parameters ?? {
          type: 'object',
          properties: {},
        }) as Record<string, unknown>,
      });
    }
  }

  return { tools, toolMap };
}

export function formatRealtimeToolOutput(content: string | unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  return JSON.stringify(content);
}

export async function executeRealtimeTool(params: {
  mcpManager: MCPManager;
  flowManager: FlowStateManager<MCPOAuthTokens | null>;
  tokenMethods: TokenMethods;
  user: IUser;
  serverName: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
  provider?: Provider;
}): Promise<string> {
  const provider = params.provider ?? 'openai';
  const [content] = await params.mcpManager.callTool({
    user: params.user,
    serverName: params.serverName,
    toolName: params.toolName,
    provider,
    toolArguments: params.toolArguments,
    flowManager: params.flowManager,
    tokenMethods: params.tokenMethods,
  });

  return formatRealtimeToolOutput(content);
}
