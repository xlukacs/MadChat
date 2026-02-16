import { memo, useEffect, useMemo } from 'react';
import { AlertTriangle, Radio } from 'lucide-react';
import { useRecoilState, useRecoilValue } from 'recoil';
import { useGetCustomConfigSpeechQuery } from 'librechat-data-provider/react-query';
import { useLocalize, useRealtimeVoice } from '~/hooks';
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

function RealtimeVoiceCall({ onEndCall }: { onEndCall: () => void }) {
  const localize = useLocalize();
  const voice = useRecoilValue(store.voice);
  const [, setVoiceCallStatus] = useRecoilState(store.voiceCallStatus);
  const [, setVoiceCallInterimTranscript] = useRecoilState(store.voiceCallInterimTranscript);
  const { data: speechConfig } = useGetCustomConfigSpeechQuery({ enabled: true });

  const realtimeModel = speechConfig?.realtimeModel || 'gpt-4o-realtime-preview-2024-12-17';
  const realtimeVoice = speechConfig?.realtimeVoice || voice || 'alloy';

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
    onEnded: () => {
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
