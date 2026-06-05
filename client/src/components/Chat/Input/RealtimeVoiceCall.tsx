import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { v4 } from 'uuid';
import { Constants, apiBaseUrl, request } from 'librechat-data-provider';
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
import type { VoiceCallStatus } from '~/store/voiceChat';
import VoiceModeFloatingBar from './VoiceModeFloatingBar';
import store from '~/store';

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
  const [tools, setTools] = useState<RealtimeFunctionTool[]>([]);
  const [toolsReady, setToolsReady] = useState(false);

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
    const toolHint = `You have function tools available (${toolNames}). When the user asks about the current time or timezone conversions, you must call the appropriate tool instead of guessing.`;

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

        const data = (await response.json()) as { tools?: RealtimeFunctionTool[] };
        if (!cancelled && Array.isArray(data.tools)) {
          setTools(data.tools);
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
          unfinished: false,
          error: false,
        },
      });
    },
    [endpoint, saveRealtimeMessage],
  );

  const upsertMessageToView = useCallback(
    (message: TMessage) => {
      const existing = getMessages() ?? [];
      if (existing.some((entry) => entry.messageId === message.messageId)) {
        return;
      }

      const lastMessage = existing[existing.length - 1];
      if (
        lastMessage?.sender === message.sender &&
        lastMessage?.text === message.text &&
        lastMessage?.isCreatedByUser === message.isCreatedByUser
      ) {
        return;
      }

      setMessages([...existing, message]);
    },
    [getMessages, setMessages],
  );

  const saveUserTurn = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || trimmed === lastSavedUserTextRef.current) {
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

      pendingUserMessageIdRef.current = userMessageId;
      upsertMessageToView(userMessage);
      await persistMessage(userMessage);
    },
    [
      endpoint,
      ensureBackendConversation,
      getMessages,
      persistMessage,
      resolveConversationId,
      upsertMessageToView,
    ],
  );

  const saveAgentTurn = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || trimmed === lastSavedAgentTextRef.current) {
        return;
      }

      lastSavedAgentTextRef.current = trimmed;

      if (hasArtifactBlock(trimmed)) {
        setArtifactsVisible(true);
      }

      const currentMessages = getMessages() ?? [];
      const conversationId = resolveConversationId();
      await ensureBackendConversation(conversationId);
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
        isCreatedByUser: false,
        endpoint,
        model: realtimeModel,
        error: false,
        unfinished: false,
      };

      pendingUserMessageIdRef.current = null;
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
      setArtifactsVisible,
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
  }, []);

  const handleToolCall = useCallback(
    async (name: string, args: Record<string, unknown>, _callId: string) => {
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
        throw new Error(errMsg);
      }

      try {
        const parsed = JSON.parse(responseText) as { output?: string };
        return parsed.output ?? responseText;
      } catch {
        return responseText;
      }
    },
    [token],
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
      setVoiceCallStatus('idle');
    };
  }, [setVoiceCallInterimTranscript, setVoiceCallStatus]);

  const handleEnd = () => {
    pendingUserMessageIdRef.current = null;
    lastSavedUserTextRef.current = '';
    lastSavedAgentTextRef.current = '';
    disconnect();
    onEndCall();
  };

  return (
    <VoiceModeFloatingBar status={callStatus} onEndCall={handleEnd}>
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
