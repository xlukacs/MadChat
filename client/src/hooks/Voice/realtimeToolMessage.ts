import { Constants, ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';

export type RealtimeToolMapEntry = {
  serverName: string;
  toolName: string;
};

export function buildMcpToolDisplayName(
  realtimeName: string,
  toolMap: Record<string, RealtimeToolMapEntry>,
): string {
  const mapping = toolMap[realtimeName];
  if (!mapping) {
    return realtimeName;
  }
  return `${mapping.toolName}${Constants.mcp_delimiter}${mapping.serverName}`;
}

export function buildToolCallContentPart(params: {
  callId: string;
  toolDisplayName: string;
  args: Record<string, unknown>;
  output?: string;
  progress: number;
}): TMessageContentParts {
  return {
    type: ContentTypes.TOOL_CALL,
    tool_call: {
      type: ToolCallTypes.TOOL_CALL,
      id: params.callId,
      name: params.toolDisplayName,
      args: JSON.stringify(params.args, null, 2),
      output: params.output,
      progress: params.progress,
    },
  };
}

export function createAssistantTurnMessage(params: {
  messageId: string;
  conversationId: string;
  parentMessageId: string;
  endpoint: string;
  model: string;
}): TMessage {
  return {
    messageId: params.messageId,
    conversationId: params.conversationId,
    parentMessageId: params.parentMessageId,
    sender: 'Assistant',
    text: '',
    content: [],
    isCreatedByUser: false,
    endpoint: params.endpoint,
    model: params.model,
    error: false,
    unfinished: true,
  };
}

export function appendToolCallToMessage(
  message: TMessage,
  toolPart: TMessageContentParts,
): TMessage {
  return {
    ...message,
    content: [...(message.content ?? []), toolPart],
    unfinished: true,
  };
}

export function updateToolCallInMessage(
  message: TMessage,
  callId: string,
  params: {
    toolDisplayName: string;
    args: Record<string, unknown>;
    output?: string;
    progress: number;
  },
): TMessage {
  let found = false;
  const content = (message.content ?? []).map((part) => {
    if (part?.type !== ContentTypes.TOOL_CALL) {
      return part;
    }
    const toolCall = part.tool_call;
    if (toolCall?.id !== callId) {
      return part;
    }
    found = true;
    return buildToolCallContentPart({
      callId,
      toolDisplayName: params.toolDisplayName,
      args: params.args,
      output: params.output,
      progress: params.progress,
    });
  });

  if (!found) {
    content.push(
      buildToolCallContentPart({
        callId,
        toolDisplayName: params.toolDisplayName,
        args: params.args,
        output: params.output,
        progress: params.progress,
      }),
    );
  }

  const hasRunningTool = content.some(
    (part) =>
      part?.type === ContentTypes.TOOL_CALL && (part.tool_call?.progress ?? 1) < 1,
  );

  return {
    ...message,
    content,
    unfinished: hasRunningTool,
  };
}

export function appendAssistantTextToMessage(message: TMessage, text: string): TMessage {
  const content = [...(message.content ?? [])];
  const lastPart = content[content.length - 1];
  if (lastPart?.type === ContentTypes.TEXT && typeof lastPart.text === 'string') {
    content[content.length - 1] = { type: ContentTypes.TEXT, text };
  } else {
    content.push({ type: ContentTypes.TEXT, text });
  }

  return {
    ...message,
    text,
    content,
    unfinished: false,
  };
}
