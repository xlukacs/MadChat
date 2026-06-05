import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { v4 } from 'uuid';
import { Constants, ContentTypes, apiBaseUrl, request } from 'librechat-data-provider';
import type { TConversation, TMessage } from 'librechat-data-provider';
import { AlertTriangle, Radio } from 'lucide-react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { useGetCustomConfigSpeechQuery } from 'librechat-data-provider/react-query';
import { useAuthContext } from '~/hooks/AuthContext';
import {
  useLocalize,
  useRealtimeVoice,
  useSaveRealtimeMessage,
  type RealtimeFunctionTool,
} from '~/hooks';
import {
  appendAssistantTextToMessage,
  appendToolCallToMessage,
  buildMcpToolDisplayName,
  buildToolCallContentPart,
  createAssistantTurnMessage,
  updateToolCallInMessage,
  type RealtimeToolMapEntry,
} from '~/hooks/Voice/realtimeToolMessage';
import type { VoiceCallStatus } from '~/store/voiceChat';
import VoiceModeFloatingBar from './VoiceModeFloatingBar';
import store from '~/store';
import { getToolDisplayLabel } from '~/utils/toolLabels';

function mapRealtimeStatusToCallStatus(status: string): VoiceCallStatus {
  if (status === 'speaking') {
    return 'speaking';
  }
  if (status === 'connecting' || status === 'processing') {
    return 'processing';
  }
  if (status === 'listening' || status === 'interrupted') {
    return 'listening';
  }
  return 'idle';
}

function hasArtifactBlock(text: string): boolean {
  return text.includes(':::artifact');
}

type RealtimeVoiceCallProps = {
  onEndCall: () => void;
  conversation: TConversation | null;
  setConversation: (conversation: TConversation | null) => void;
  getMessages: () => TMessage[] | undefined;
  setMessages: (messages: TMessage[]) => void;
};

function RealtimeVoiceCall({
  onEndCall,
  conversation,
  setConversation,
  getMessages,
  setMessages,
}: RealtimeVoiceCallProps) {
  const localize = useLocalize();
  const { token } = useAuthContext();
  const voice = useRecoilValue(store.voice);
  const setVoiceCallStatus = useSetRecoilState(store.voiceCallStatus);
  const setVoiceCallInterimTranscript = useSetRecoilState(store.voiceCallInterimTranscript);
  const setVoiceCallActiveToolMessageId = useSetRecoilState(store.voiceCallActiveToolMessageId);
  const setArtifactsVisible = useSetRecoilState(store.artifactsVisibility);
  const { data: speechConfig, isLoading: isSpeechConfigLoading } = useGetCustomConfigSpeechQuery({
    enabled: true,
  });
  const saveRealtimeMessage = useSaveRealtimeMessage();
  const pendingUserMessageIdRef = useRef<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const backendConversationReadyRef = useRef<string | null>(null);
  const lastSavedUserTextRef = useRef('');
  const lastSavedAgentTextRef = useRef('');
  const currentTurnUserMessageIdRef = useRef<string | null>(null);
  const userTurnCommittedRef = useRef(false);
  const pendingUserTranscriptRef = useRef('');
  const pendingUserSaveRef = useRef<Promise<void> | null>(null);
  const resolveUserTurnReadyRef = useRef<(() => void) | null>(null);
  const userTurnReadyPromiseRef = useRef<Promise<void> | null>(null);
  const assistantTurnMessageIdRef = useRef<string | null>(null);
  const assistantTurnMessageRef = useRef<TMessage | null>(null);
  const toolCallMessageIdsRef = useRef<Map<string, string>>(new Map());
  const [tools, setTools] = useState<RealtimeFunctionTool[]>([]);
  const [toolMap, setToolMap] = useState<Record<string, RealtimeToolMapEntry>>({});
  const [toolsReady, setToolsReady] = useState(false);
  const [activeToolLabel, setActiveToolLabel] = useState<string | null>(null);

  const realtimeModel = speechConfig?.realtimeModel || 'gpt-realtime-mini';
  const realtimeVoice = speechConfig?.realtimeVoice || voice || 'alloy';
  const realtimeInstructions =
    typeof speechConfig?.realtimeInstructions === 'string'
      ? speechConfig.realtimeInstructions
      : undefined;
  const sessionInstructions = useMemo(() => {
    if (tools.length === 0) {
      return realtimeInstructions;
    }

    const toolNames = tools.map((tool) => tool.name).join(', ');
    const toolHint =
      'You have function tools available (' +
      toolNames +
      '). Use time tools for current time and timezone questions. Use search and fetch tools when the user asks about recent events, facts, or anything you should look up online. Always call the appropriate tool instead of guessing.';

    return [realtimeInstructions, toolHint].filter(Boolean).join('\n\n');
  }, [realtimeInstructions, tools]);
  const endpoint = conversation?.endpointType ?? conversation?.endpoint ?? '';

  useEffect(() => {
    let cancelled = false;

    const loadTools = async () => {
      try {
        const response = await fetch('/api/realtime/tools', {
          credentials: 'include',
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });

        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as {
          tools?: RealtimeFunctionTool[];
          toolMap?: Record<string, RealtimeToolMapEntry>;
        };
        if (!cancelled && Array.isArray(data.tools)) {
          setTools(data.tools);
          setToolMap(data.toolMap ?? {});
          if (data.tools.length === 0) {
            console.warn('[RealtimeVoice] No MCP tools loaded — check speech.realtime.mcpServers and MCP server startup');
          } else {
            console.info(`[RealtimeVoice] Loaded ${data.tools.length} MCP tools for Realtime session`);
          }
        }
      } catch (err) {
        console.error('Failed to load realtime tools', err);
      } finally {
        if (!cancelled) {
          setToolsReady(true);
        }
      }
    };

    void loadTools();

    return () => {
      cancelled = true;
    };
  }, [token]);

  const resolveConversationId = useCallback(() => {
    if (conversationIdRef.current) {
      return conversationIdRef.current;
    }

    const existingConversationId = conversation?.conversationId;
    if (existingConversationId && existingConversationId !== Constants.NEW_CONVO) {
      conversationIdRef.current = existingConversationId;
      return existingConversationId;
    }

    const createdConversationId = v4();
    conversationIdRef.current = createdConversationId;
    setConversation({
      ...(conversation ?? {}),
      conversationId: createdConversationId,
      endpoint: endpoint || conversation?.endpoint,
    } as TConversation);
    return createdConversationId;
  }, [conversation, endpoint, setConversation]);

  const ensureBackendConversation = useCallback(async (conversationId: string) => {
    if (backendConversationReadyRef.current === conversationId) {
      return;
    }

    await request.post(`${apiBaseUrl()}/api/convos/update`, {
      arg: {
        conversationId,
        title: 'Voice chat',
      },
    });
    backendConversationReadyRef.current = conversationId;
  }, []);

  const persistMessage = useCallback(
    async (message: TMessage) => {
      await saveRealtimeMessage({
        conversationId: message.conversationId ?? '',
        message: {
          messageId: message.messageId,
          conversationId: message.conversationId,
          parentMessageId: message.parentMessageId ?? Constants.NO_PARENT,
          text: message.text ?? '',
          sender: message.sender,
          isCreatedByUser: message.isCreatedByUser,
          endpoint: message.endpoint ?? endpoint,
          model: message.model,
          unfinished: message.unfinished ?? false,
          error: message.error ?? false,
          content: message.content,
        },
      });
    },
    [endpoint, saveRealtimeMessage],
  );

  const updateMessageInView = useCallback(
    (message: TMessage) => {
      const existing = getMessages() ?? [];
      setMessages(
        existing.map((entry) => (entry.messageId === message.messageId ? message : entry)),
      );
    },
    [getMessages, setMessages],
  );

  const upsertMessageToView = useCallback(
    (message: TMessage) => {
      const existing = getMessages() ?? [];
      if (existing.some((entry) => entry.messageId === message.messageId)) {
        return;
      }

      const lastMessage = existing[existing.length - 1];
      const messageText = message.text ?? '';
      if (
        !(message.content?.length ?? 0) &&
        messageText.length > 0 &&
        lastMessage?.sender === message.sender &&
        lastMessage?.text === messageText &&
        lastMessage?.isCreatedByUser === message.isCreatedByUser
      ) {
        return;
      }

      setMessages([...existing, message]);
    },
    [getMessages, setMessages],
  );

  const commitUserTurn = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      if (userTurnCommittedRef.current && currentTurnUserMessageIdRef.current) {
        if (trimmed === lastSavedUserTextRef.current) {
          return;
        }

        const existing = (getMessages() ?? []).find(
          (entry) => entry.messageId === currentTurnUserMessageIdRef.current,
        );
        if (existing) {
          const updatedMessage: TMessage = { ...existing, text: trimmed };
          lastSavedUserTextRef.current = trimmed;
          updateMessageInView(updatedMessage);
          await persistMessage(updatedMessage);
        }
        return;
      }

      if (trimmed === lastSavedUserTextRef.current && userTurnCommittedRef.current) {
        return;
      }

      lastSavedUserTextRef.current = trimmed;
      lastSavedAgentTextRef.current = '';

      const currentMessages = getMessages() ?? [];
      const parentMessageId =
        currentMessages[currentMessages.length - 1]?.messageId ?? Constants.NO_PARENT;
      const conversationId = resolveConversationId();
      await ensureBackendConversation(conversationId);

      const userMessageId = v4();
      const userMessage: TMessage = {
        messageId: userMessageId,
        conversationId,
        parentMessageId,
        sender: 'User',
        text: trimmed,
        isCreatedByUser: true,
        endpoint,
        error: false,
        unfinished: false,
        clientTimestamp: new Date().toLocaleString('sv').replace(' ', 'T'),
      };

      currentTurnUserMessageIdRef.current = userMessageId;
      pendingUserMessageIdRef.current = userMessageId;
      userTurnCommittedRef.current = true;
      upsertMessageToView(userMessage);
      await persistMessage(userMessage);
      resolveUserTurnReadyRef.current?.();
      resolveUserTurnReadyRef.current = null;
    },
    [
      endpoint,
      ensureBackendConversation,
      getMessages,
      persistMessage,
      resolveConversationId,
      updateMessageInView,
      upsertMessageToView,
    ],
  );

  const waitForUserTurnReady = useCallback(async () => {
    if (userTurnCommittedRef.current) {
      return;
    }

    const readyPromise = userTurnReadyPromiseRef.current;
    if (!readyPromise) {
      return;
    }

    await Promise.race([
      readyPromise,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 4000);
      }),
    ]);
  }, []);

  const flushPendingUserTurn = useCallback(
    async (text?: string) => {
      const transcript = (text ?? pendingUserTranscriptRef.current).trim();
      if (!transcript) {
        if (pendingUserSaveRef.current) {
          await pendingUserSaveRef.current;
        }
        return;
      }

      if (userTurnCommittedRef.current) {
        await commitUserTurn(transcript);
        return;
      }

      if (!pendingUserSaveRef.current) {
        pendingUserSaveRef.current = commitUserTurn(transcript).finally(() => {
          pendingUserSaveRef.current = null;
        });
      }

      await pendingUserSaveRef.current;
    },
    [commitUserTurn],
  );

  const ensureAssistantTurnMessage = useCallback(async (): Promise<TMessage> => {
    await flushPendingUserTurn();
    await waitForUserTurnReady();
    await flushPendingUserTurn();

    const cachedMessage = assistantTurnMessageRef.current;
    if (cachedMessage) {
      const fromView = (getMessages() ?? []).find(
        (entry) => entry.messageId === cachedMessage.messageId,
      );
      return fromView ?? cachedMessage;
    }

    const currentMessages = getMessages() ?? [];
    const conversationId = resolveConversationId();
    await ensureBackendConversation(conversationId);
    const parentMessageId =
      pendingUserMessageIdRef.current ??
      currentMessages[currentMessages.length - 1]?.messageId ??
      Constants.NO_PARENT;
    const messageId = v4();
    assistantTurnMessageIdRef.current = messageId;

    const assistantMessage = createAssistantTurnMessage({
      messageId,
      conversationId,
      parentMessageId,
      endpoint,
      model: realtimeModel,
    });
    assistantTurnMessageRef.current = assistantMessage;

    upsertMessageToView(assistantMessage);
    await persistMessage(assistantMessage);
    return assistantMessage;
  }, [
    endpoint,
    ensureBackendConversation,
    flushPendingUserTurn,
    getMessages,
    persistMessage,
    realtimeModel,
    resolveConversationId,
    upsertMessageToView,
    waitForUserTurnReady,
  ]);

  const finalizeToolCallInMessage = useCallback(
    async (
      callId: string,
      name: string,
      args: Record<string, unknown>,
      output: string,
      progress: number,
    ) => {
      const messageId = toolCallMessageIdsRef.current.get(callId);
      if (!messageId) {
        return;
      }

      const currentMessages = getMessages() ?? [];
      const existingMessage = currentMessages.find((entry) => entry.messageId === messageId);
      if (!existingMessage) {
        return;
      }

      const completedMessage = updateToolCallInMessage(existingMessage, callId, {
        toolDisplayName: buildMcpToolDisplayName(name, toolMap),
        args,
        output,
        progress,
      });
      assistantTurnMessageRef.current = completedMessage;
      updateMessageInView(completedMessage);
      await persistMessage(completedMessage);
    },
    [getMessages, persistMessage, toolMap, updateMessageInView],
  );

  const saveUserTurn = useCallback(
    async (text: string) => {
      pendingUserTranscriptRef.current = text;
      await flushPendingUserTurn(text);
    },
    [flushPendingUserTurn],
  );

  const handleUserSpeechStarted = useCallback(() => {
    pendingUserTranscriptRef.current = '';
    userTurnCommittedRef.current = false;
    currentTurnUserMessageIdRef.current = null;
    pendingUserMessageIdRef.current = null;
    assistantTurnMessageIdRef.current = null;
    assistantTurnMessageRef.current = null;
    userTurnReadyPromiseRef.current = new Promise<void>((resolve) => {
      resolveUserTurnReadyRef.current = resolve;
    });
  }, []);

  const handleUserSpeechStopped = useCallback(
    (text: string) => {
      pendingUserTranscriptRef.current = text;
      void flushPendingUserTurn(text).catch((err) => {
        console.error('Failed to persist user message on speech stop', err);
      });
    },
    [flushPendingUserTurn],
  );

  const saveAgentTurn = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || trimmed === lastSavedAgentTextRef.current) {
        return;
      }

      await flushPendingUserTurn();

      lastSavedAgentTextRef.current = trimmed;

      if (hasArtifactBlock(trimmed)) {
        setArtifactsVisible(true);
      }

      const currentMessages = getMessages() ?? [];
      const conversationId = resolveConversationId();
      await ensureBackendConversation(conversationId);

      const assistantTurnId = assistantTurnMessageIdRef.current;
      const existingAssistantMessage =
        assistantTurnMessageRef.current ??
        (assistantTurnId
          ? currentMessages.find((entry) => entry.messageId === assistantTurnId)
          : undefined);

      if (existingAssistantMessage) {
        const completedMessage = appendAssistantTextToMessage(existingAssistantMessage, trimmed);
        updateMessageInView(completedMessage);
        await persistMessage(completedMessage);
        assistantTurnMessageIdRef.current = null;
        assistantTurnMessageRef.current = null;
        pendingUserMessageIdRef.current = null;
        userTurnCommittedRef.current = false;
        currentTurnUserMessageIdRef.current = null;
        return;
      }

      const parentMessageId =
        pendingUserMessageIdRef.current ??
        currentMessages[currentMessages.length - 1]?.messageId ??
        Constants.NO_PARENT;
      const assistantMessage: TMessage = {
        messageId: v4(),
        conversationId,
        parentMessageId,
        sender: 'Assistant',
        text: trimmed,
        content: [{ type: ContentTypes.TEXT, text: trimmed }],
        isCreatedByUser: false,
        endpoint,
        model: realtimeModel,
        error: false,
        unfinished: false,
      };

      pendingUserMessageIdRef.current = null;
      userTurnCommittedRef.current = false;
      currentTurnUserMessageIdRef.current = null;
      upsertMessageToView(assistantMessage);
      await persistMessage(assistantMessage);
    },
    [
      endpoint,
      ensureBackendConversation,
      getMessages,
      persistMessage,
      realtimeModel,
      resolveConversationId,
      flushPendingUserTurn,
      setArtifactsVisible,
      updateMessageInView,
      upsertMessageToView,
    ],
  );

  const handleUserTurnComplete = useCallback(
    (text: string) => {
      void saveUserTurn(text).catch((err) => {
        console.error('Failed to persist realtime user message', err);
      });
    },
    [saveUserTurn],
  );

  const handleAgentTurnComplete = useCallback(
    (text: string) => {
      void saveAgentTurn(text).catch((err) => {
        console.error('Failed to persist realtime assistant message', err);
      });
    },
    [saveAgentTurn],
  );

  const handleRealtimeEnded = useCallback(() => {
    pendingUserMessageIdRef.current = null;
    pendingUserTranscriptRef.current = '';
    userTurnCommittedRef.current = false;
    currentTurnUserMessageIdRef.current = null;
    assistantTurnMessageIdRef.current = null;
    assistantTurnMessageRef.current = null;
  }, []);

  const handleToolCallStart = useCallback(
    async (name: string, callId: string, args: Record<string, unknown>) => {
      const label = getToolDisplayLabel(name, localize);
      setActiveToolLabel(label);

      const assistantMessage = await ensureAssistantTurnMessage();
      const messageId = assistantMessage.messageId;
      toolCallMessageIdsRef.current.set(callId, messageId);

      const toolPart = buildToolCallContentPart({
        callId,
        toolDisplayName: buildMcpToolDisplayName(name, toolMap),
        args,
        progress: 0.1,
      });
      const updatedMessage = appendToolCallToMessage(assistantMessage, toolPart);
      assistantTurnMessageRef.current = updatedMessage;

      setVoiceCallActiveToolMessageId(messageId);
      updateMessageInView(updatedMessage);
      await persistMessage(updatedMessage);
    },
    [
      ensureAssistantTurnMessage,
      localize,
      persistMessage,
      setVoiceCallActiveToolMessageId,
      toolMap,
      updateMessageInView,
    ],
  );

  const handleToolCallEnd = useCallback(
    (_name: string, callId: string, _success: boolean) => {
      setActiveToolLabel(null);
      setVoiceCallActiveToolMessageId(null);
      toolCallMessageIdsRef.current.delete(callId);
    },
    [setVoiceCallActiveToolMessageId],
  );

  const handleToolCall = useCallback(
    async (name: string, args: Record<string, unknown>, callId: string) => {
      const response = await fetch('/api/realtime/tools/execute', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ name, arguments: args }),
      });

      const responseText = await response.text();
      if (!response.ok) {
        let errMsg = 'Tool execution failed';
        try {
          const parsed = JSON.parse(responseText) as { error?: string };
          errMsg = parsed.error || responseText || errMsg;
        } catch {
          errMsg = responseText || errMsg;
        }
        await finalizeToolCallInMessage(callId, name, args, errMsg, 1);
        throw new Error(errMsg);
      }

      try {
        const parsed = JSON.parse(responseText) as { output?: string };
        const output = parsed.output ?? responseText;
        await finalizeToolCallInMessage(callId, name, args, output, 1);
        return output;
      } catch {
        await finalizeToolCallInMessage(callId, name, args, responseText, 1);
        return responseText;
      }
    },
    [finalizeToolCallInMessage, token],
  );

  const {
    status,
    error,
    userTranscript,
    connect,
    disconnect,
    interrupt,
    isConnected,
  } = useRealtimeVoice({
    model: realtimeModel,
    voice: realtimeVoice,
    instructions: sessionInstructions,
    tools,
    onToolCall: handleToolCall,
    onToolCallStart: handleToolCallStart,
    onToolCallEnd: handleToolCallEnd,
    onTranscriptDelta: (text) => {
      pendingUserTranscriptRef.current = text;
    },
    onUserSpeechStarted: handleUserSpeechStarted,
    onUserSpeechStopped: handleUserSpeechStopped,
    onUserTurnComplete: handleUserTurnComplete,
    onAgentTurnComplete: handleAgentTurnComplete,
    onEnded: handleRealtimeEnded,
  });

  const callStatus = useMemo(() => mapRealtimeStatusToCallStatus(status), [status]);

  useEffect(() => {
    setVoiceCallStatus(callStatus);
  }, [callStatus, setVoiceCallStatus]);

  useEffect(() => {
    if (!toolsReady || isSpeechConfigLoading) {
      return;
    }
    void connect();
    return () => {
      disconnect();
    };
  }, [connect, disconnect, isSpeechConfigLoading, toolsReady]);

  useEffect(() => {
    setVoiceCallInterimTranscript(userTranscript);
  }, [setVoiceCallInterimTranscript, userTranscript]);

  useEffect(() => {
    return () => {
      setVoiceCallInterimTranscript('');
      setVoiceCallActiveToolMessageId(null);
      setVoiceCallStatus('idle');
    };
  }, [setVoiceCallActiveToolMessageId, setVoiceCallInterimTranscript, setVoiceCallStatus]);

  const handleEnd = () => {
    pendingUserMessageIdRef.current = null;
    pendingUserTranscriptRef.current = '';
    userTurnCommittedRef.current = false;
    currentTurnUserMessageIdRef.current = null;
    lastSavedUserTextRef.current = '';
    lastSavedAgentTextRef.current = '';
    toolCallMessageIdsRef.current.clear();
    setActiveToolLabel(null);
    setVoiceCallActiveToolMessageId(null);
    disconnect();
    onEndCall();
  };

  return (
    <VoiceModeFloatingBar status={callStatus} onEndCall={handleEnd} activeToolLabel={activeToolLabel}>
      {isConnected ? (
        <button
          type="button"
          aria-label={localize('com_ui_voice_interrupt')}
          onClick={interrupt}
          className="flex size-10 items-center justify-center rounded-full border border-emerald-700/60 bg-emerald-900/40 text-emerald-100 transition-colors hover:bg-emerald-900/70"
        >
          <Radio className="size-5" />
        </button>
      ) : (
        <div className="flex h-10 items-center rounded-full border border-yellow-700/50 bg-yellow-900/30 px-3 text-xs text-yellow-100">
          {error ? (
            <span className="inline-flex items-center gap-1" title={error}>
              <AlertTriangle className="size-3.5 shrink-0" />
              <span className="max-w-[280px] truncate">
                {localize('com_ui_voice_realtime_failed')}: {error}
              </span>
            </span>
          ) : (
            localize('com_ui_connecting')
          )}
        </div>
      )}
    </VoiceModeFloatingBar>
  );
}

export default memo(RealtimeVoiceCall);
