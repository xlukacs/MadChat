import { useCallback, useEffect, useRef } from 'react';
import { MicOff } from 'lucide-react';
import { useToastContext, TooltipAnchor, ListeningIcon, Spinner } from '@librechat/client';
import { useLocalize, useSpeechToText, useGetAudioSettings } from '~/hooks';
import { useChatFormContext } from '~/Providers';
import { cn } from '~/utils';

/**
 * USER VOICE PIPELINE ONLY.
 * This component handles: microphone → STT → user message text.
 * It must not read or write agent TTS state (globalAudio, playback, etc.).
 * Agent pipeline (StreamAudio, TTS, message display) is separate.
 */

const isExternalSTT = (speechToTextEndpoint: string) => speechToTextEndpoint === 'external';

/** Phrases often misheard from TTS playback - do not submit as user message */
const ECHO_BLOCKLIST = new Set([
  '.',
  '..',
  '...',
  'thank you',
  'thanks',
  'ok',
  'okay',
  'bye',
  'yes',
  'no',
  'uh',
  'um',
  'hmm',
]);

export default function AudioRecorder({
  disabled,
  ask,
  methods,
  textAreaRef,
  isSubmitting,
  onStartRecording,
  onSpeechDetected,
  registerStartRecording,
  onListeningChange,
  onInterimTranscriptChange,
  onSTTSourceChange,
  preferExternalSTT,
  suppressTranscriptRef,
  pauseListening,
}: {
  disabled: boolean;
  ask: (data: { text: string }) => void;
  methods: ReturnType<typeof useChatFormContext>;
  textAreaRef: React.RefObject<HTMLTextAreaElement>;
  isSubmitting: boolean;
  onStartRecording?: () => void;
  onSpeechDetected?: () => void;
  registerStartRecording?: (startRecording: () => void) => void;
  onListeningChange?: (isListening: boolean) => void;
  onInterimTranscriptChange?: (text: string) => void;
  onSTTSourceChange?: (source: 'external' | 'browser') => void;
  preferExternalSTT?: boolean;
  /** When true, do not submit transcriptions (avoids TTS echo being sent as user message) */
  suppressTranscriptRef?: React.RefObject<boolean>;
  /** When true, stop recognition so no audio is sent to STT (avoids TTS echo in pipeline). Barge-in handled separately. */
  pauseListening?: boolean;
}) {
  const { setValue, reset, getValues } = methods;
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { speechToTextEndpoint } = useGetAudioSettings();

  const existingTextRef = useRef<string>('');
  const hasDetectedSpeechRef = useRef(false);

  const onTranscriptionComplete = useCallback(
    (text: string) => {
      if (isSubmitting) {
        showToast({
          message: localize('com_ui_speech_while_submitting'),
          status: 'error',
        });
        return;
      }
      if (suppressTranscriptRef?.current) {
        return;
      }
      if (text) {
        /** For external STT, append existing text to the transcription */
        const finalText =
          isExternalSTT(speechToTextEndpoint) && existingTextRef.current
            ? `${existingTextRef.current} ${text}`.trim()
            : text.trim();
        if (!finalText) {
          return;
        }
        const normalized = finalText.toLowerCase();
        if (
          ECHO_BLOCKLIST.has(normalized) ||
          (finalText.length <= 2 && /^[.\s,!?]+$/.test(finalText))
        ) {
          return;
        }
        onInterimTranscriptChange?.('');
        hasDetectedSpeechRef.current = false;
        ask({ text: finalText });
        reset({ text: '' });
        existingTextRef.current = '';
      }
    },
    [
      ask,
      reset,
      showToast,
      localize,
      isSubmitting,
      speechToTextEndpoint,
      onInterimTranscriptChange,
      suppressTranscriptRef,
    ],
  );

  const setText = useCallback(
    (text: string) => {
      let newText = text;
      if (isExternalSTT(speechToTextEndpoint)) {
        /** For external STT, the text comes as a complete transcription, so append to existing */
        newText = existingTextRef.current ? `${existingTextRef.current} ${text}` : text;
      } else {
        /** For browser STT, the transcript is cumulative, so we only need to prepend the existing text once */
        newText = existingTextRef.current ? `${existingTextRef.current} ${text}` : text;
      }
      onInterimTranscriptChange?.(newText);
      if (newText.trim().length > 0 && !hasDetectedSpeechRef.current) {
        hasDetectedSpeechRef.current = true;
        onSpeechDetected?.();
      }
      setValue('text', newText, {
        shouldValidate: true,
      });
    },
    [setValue, speechToTextEndpoint, onInterimTranscriptChange, onSpeechDetected],
  );

  const { isListening, isLoading, startRecording, stopRecording, activeSource } = useSpeechToText(
    setText,
    onTranscriptionComplete,
    { preferExternal: preferExternalSTT },
  );

  const handleStartRecording = useCallback(() => {
    onStartRecording?.();
    existingTextRef.current = getValues('text') || '';
    startRecording();
  }, [getValues, onStartRecording, startRecording]);

  const handleStopRecording = useCallback(() => {
    stopRecording();
    /** For browser STT, clear the reference since text was already being updated */
    if (!isExternalSTT(speechToTextEndpoint)) {
      existingTextRef.current = '';
    }
  }, [speechToTextEndpoint, stopRecording]);

  useEffect(() => {
    onListeningChange?.(isListening === true);
  }, [isListening, onListeningChange]);

  useEffect(() => {
    onSTTSourceChange?.(activeSource);
  }, [activeSource, onSTTSourceChange]);

  useEffect(() => {
    if (!pauseListening) {
      return;
    }
    stopRecording();
  }, [pauseListening, stopRecording]);

  useEffect(() => {
    if (registerStartRecording == null) {
      return;
    }

    registerStartRecording(() => {
      if (isListening !== true) {
        handleStartRecording();
      }
    });
  }, [handleStartRecording, isListening, registerStartRecording]);

  const renderIcon = () => {
    if (isListening === true) {
      return <MicOff className="stroke-red-500" />;
    }
    if (isLoading === true) {
      return <Spinner className="stroke-text-secondary" />;
    }
    return <ListeningIcon className="stroke-text-secondary" />;
  };

  if (!textAreaRef.current) {
    return null;
  }

  return (
    <TooltipAnchor
      description={localize('com_ui_use_micrphone')}
      render={
        <button
          id="audio-recorder"
          type="button"
          aria-label={localize('com_ui_use_micrphone')}
          onClick={isListening === true ? handleStopRecording : handleStartRecording}
          disabled={disabled}
          className={cn(
            'flex size-9 items-center justify-center rounded-full p-1 transition-colors hover:bg-surface-hover',
          )}
          title={localize('com_ui_use_micrphone')}
          aria-pressed={isListening}
        >
          {renderIcon()}
        </button>
      }
    />
  );
}
