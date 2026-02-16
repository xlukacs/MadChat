import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { v4 } from 'uuid';
import { Constants } from 'librechat-data-provider';
import type { TConversation, TMessage } from 'librechat-data-provider';
import { AlertTriangle, Radio } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useRecoilState, useRecoilValue } from 'recoil';
import { useGetCustomConfigSpeechQuery } from 'librechat-data-provider/react-query';
import { useLocalize, useRealtimeVoice, useSaveRealtimeMessage } from '~/hooks';
import type { VoiceCallStatus } from '~/store/voiceChat';
import VoiceModeFloatingBar from './VoiceModeFloatingBar';
import store from '~/store';

function mapRealtimeStatusToCallStatus(status: string): VoiceCallStatus {
  if (status === 'speaking') {
    return 'speaking';
  }
  if (status === 'connecting') {
    return 'processing';
  }
  if (status === 'listening' || status === 'interrupted') {
    return 'listening';
  }
  return 'idle';
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
  const navigate = useNavigate();
  const voice = useRecoilValue(store.voice);
  const [, setVoiceCallStatus] = useRecoilState(store.voiceCallStatus);
  const [, setVoiceCallInterimTranscript] = useRecoilState(store.voiceCallInterimTranscript);
  const { data: speechConfig } = useGetCustomConfigSpeechQuery({ enabled: true });
  const saveRealtimeMessage = useSaveRealtimeMessage();
  const pendingUserMessageIdRef = useRef<string | null>(null);

  const realtimeModel = speechConfig?.realtimeModel || 'gpt-4o-realtime-preview-2024-12-17';
  const realtimeVoice = speechConfig?.realtimeVoice || voice || 'alloy';
  const endpoint = conversation?.endpointType ?? conversation?.endpoint ?? '';

  const ensureConversationId = useCallback(() => {
    const currentConversationId = conversation?.conversationId;
    if (currentConversationId && currentConversationId !== Constants.NEW_CONVO) {
      return currentConversationId;
    }

    const createdConversationId = v4();
    setConversation({
      ...(conversation ?? {}),
      conversationId: createdConversationId,
    } as TConversation);
    void navigate(`/c/${createdConversationId}`, { replace: true });
    return createdConversationId;
  }, [conversation, navigate, setConversation]);

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
      setMessages([...existing, message]);
    },
    [getMessages, setMessages],
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
    onTranscriptDelta: (text) => {
      setVoiceCallInterimTranscript(text);
    },
    onUserTurnComplete: (text) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const currentMessages = getMessages() ?? [];
      const parentMessageId =
        currentMessages[currentMessages.length - 1]?.messageId ?? Constants.NO_PARENT;
      const conversationId = ensureConversationId();
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
      void persistMessage(userMessage).catch((err) => {
        console.error('Failed to persist realtime user message', err);
      });
    },
    onAgentTurnComplete: (text) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const currentMessages = getMessages() ?? [];
      const conversationId = ensureConversationId();
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
      void persistMessage(assistantMessage).catch((err) => {
        console.error('Failed to persist realtime assistant message', err);
      });
    },
    onEnded: () => {
      pendingUserMessageIdRef.current = null;
      setVoiceCallInterimTranscript('');
      setVoiceCallStatus('idle');
    },
    onInterrupted: () => {
      setVoiceCallStatus('listening');
    },
  });

  const callStatus = useMemo(() => mapRealtimeStatusToCallStatus(status), [status]);

  useEffect(() => {
    setVoiceCallStatus(callStatus);
  }, [callStatus, setVoiceCallStatus]);

  useEffect(() => {
    void connect();
    return () => {
      disconnect();
      setVoiceCallInterimTranscript('');
      setVoiceCallStatus('idle');
    };
  }, [connect, disconnect, setVoiceCallInterimTranscript, setVoiceCallStatus]);

  useEffect(() => {
    setVoiceCallInterimTranscript(userTranscript);
  }, [setVoiceCallInterimTranscript, userTranscript]);

  const handleEnd = () => {
    pendingUserMessageIdRef.current = null;
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
              <span className="truncate max-w-[280px]">
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
