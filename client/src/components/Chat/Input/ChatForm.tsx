import { memo, useRef, useMemo, useEffect, useState, useCallback } from 'react';
import { useWatch } from 'react-hook-form';
import { TextareaAutosize, TooltipAnchor } from '@librechat/client';
import { AudioLines, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { useRecoilState, useRecoilValue } from 'recoil';
import { Constants, isAssistantsEndpoint, isAgentsEndpoint } from 'librechat-data-provider';
import { useGetCustomConfigSpeechQuery } from 'librechat-data-provider/react-query';
import {
  useChatContext,
  useChatFormContext,
  useAddedChatContext,
  useAssistantsMapContext,
} from '~/Providers';
import {
  useTextarea,
  useAutoSave,
  useLocalize,
  useRequiresKey,
  useHandleKeyUp,
  useQueryParams,
  useSubmitMessage,
  useFocusChatEffect,
} from '~/hooks';
import { usePauseGlobalAudio } from '~/hooks/Audio';
import { mainTextareaId, BadgeItem } from '~/common';
import AttachFileChat from './Files/AttachFileChat';
import FileFormChat from './Files/FileFormChat';
import { cn, removeFocusRings } from '~/utils';
import TextareaHeader from './TextareaHeader';
import PromptsCommand from './PromptsCommand';
import AudioRecorder from './AudioRecorder';
import RealtimeVoiceCall from './RealtimeVoiceCall';
import VoiceModeFloatingBar from './VoiceModeFloatingBar';
import CollapseChat from './CollapseChat';
import StreamAudio from './StreamAudio';
import StopButton from './StopButton';
import SendButton from './SendButton';
import EditBadges from './EditBadges';
import BadgeRow from './BadgeRow';
import Mention from './Mention';
import store from '~/store';

const ChatForm = memo(({ index = 0 }: { index?: number }) => {
  const VOICE_CHAT_AUTO_SEND_SECONDS = 3;
  const VOICE_CHAT_CALL_AUTO_SEND_SECONDS = 1.5;
  const VOICE_CHAT_DECIBEL_VALUE = -45;
  const VOICE_CHAT_REARM_DELAY_MS = 500;
  const VOICE_CHAT_BADGE_TIMEOUT_MS = 10_000;

  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const voiceChatStartRecordingRef = useRef<(() => void) | null>(null);
  const voiceSessionStartRef = useRef<number | null>(null);
  const previousVoiceSettingsRef = useRef<{
    conversationMode: boolean;
    autoTranscribeAudio: boolean;
    autoSendText: number;
    decibelValue: number;
    automaticPlayback: boolean;
  } | null>(null);
  const voiceRearmTimeoutRef = useRef<number | null>(null);
  const suppressTranscriptRef = useRef(false);
  useFocusChatEffect(textAreaRef);
  const localize = useLocalize();

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [, setIsScrollable] = useState(false);
  const [visualRowCount, setVisualRowCount] = useState(1);
  const [isTextAreaFocused, setIsTextAreaFocused] = useState(false);
  const [isMicListening, setIsMicListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [sttSource, setSttSource] = useState<'external' | 'browser'>('browser');
  const [voiceEndedDuration, setVoiceEndedDuration] = useState<number | null>(null);
  const [backupBadges, setBackupBadges] = useState<Pick<BadgeItem, 'id'>[]>([]);

  const SpeechToText = useRecoilValue(store.speechToText);
  const TextToSpeech = useRecoilValue(store.textToSpeech);
  const chatDirection = useRecoilValue(store.chatDirection);
  const maximizeChatSpace = useRecoilValue(store.maximizeChatSpace);
  const centerFormOnLanding = useRecoilValue(store.centerFormOnLanding);
  const isTemporary = useRecoilValue(store.isTemporary);
  const { data: speechConfig } = useGetCustomConfigSpeechQuery({ enabled: true });
  const [voiceChatMode, setVoiceChatMode] = useRecoilState(store.voiceChatMode);
  const [voiceMode] = useRecoilState(store.voiceMode);
  const [, setVoiceCallStatus] = useRecoilState(store.voiceCallStatus);
  const [, setVoiceCallInterimTranscript] = useRecoilState(store.voiceCallInterimTranscript);
  const [conversationMode, setConversationMode] = useRecoilState(store.conversationMode);
  const globalAudioPlaying = useRecoilValue(store.globalAudioPlayingFamily(index));
  const [autoTranscribeAudio, setAutoTranscribeAudio] = useRecoilState(store.autoTranscribeAudio);
  const [autoSendText, setAutoSendText] = useRecoilState(store.autoSendText);
  const [decibelValue, setDecibelValue] = useRecoilState(store.decibelValue);
  const [automaticPlayback, setAutomaticPlayback] = useRecoilState(store.automaticPlayback);

  const [badges, setBadges] = useRecoilState(store.chatBadges);
  const [isEditingBadges, setIsEditingBadges] = useRecoilState(store.isEditingBadges);
  const [showStopButton, setShowStopButton] = useRecoilState(store.showStopButtonByIndex(index));
  const [showPlusPopover, setShowPlusPopover] = useRecoilState(store.showPlusPopoverFamily(index));
  const [showMentionPopover, setShowMentionPopover] = useRecoilState(
    store.showMentionPopoverFamily(index),
  );

  const { requiresKey } = useRequiresKey();
  const methods = useChatFormContext();
  const {
    files,
    setFiles,
    conversation,
    setConversation,
    getMessages,
    setMessages,
    isSubmitting,
    filesLoading,
    newConversation,
    handleStopGenerating,
  } = useChatContext();
  const { pauseGlobalAudio } = usePauseGlobalAudio(index);
  const {
    generateConversation,
    conversation: addedConvo,
    setConversation: setAddedConvo,
  } = useAddedChatContext();
  const assistantMap = useAssistantsMapContext();

  const endpoint = useMemo(
    () => conversation?.endpointType ?? conversation?.endpoint,
    [conversation?.endpointType, conversation?.endpoint],
  );
  const conversationId = useMemo(
    () => conversation?.conversationId ?? Constants.NEW_CONVO,
    [conversation?.conversationId],
  );

  const isRTL = useMemo(
    () => (chatDirection != null ? chatDirection?.toLowerCase() === 'rtl' : false),
    [chatDirection],
  );
  const invalidAssistant = useMemo(
    () =>
      isAssistantsEndpoint(endpoint) &&
      (!(conversation?.assistant_id ?? '') ||
        !assistantMap?.[endpoint ?? '']?.[conversation?.assistant_id ?? '']),
    [conversation?.assistant_id, endpoint, assistantMap],
  );
  const disableInputs = useMemo(
    () => requiresKey || invalidAssistant,
    [requiresKey, invalidAssistant],
  );

  const handleContainerClick = useCallback(() => {
    /** Check if the device is a touchscreen */
    if (window.matchMedia?.('(pointer: coarse)').matches) {
      return;
    }
    textAreaRef.current?.focus();
  }, []);

  const handleFocusOrClick = useCallback(() => {
    if (isCollapsed) {
      setIsCollapsed(false);
    }
  }, [isCollapsed]);

  useAutoSave({
    files,
    setFiles,
    textAreaRef,
    conversationId,
    isSubmitting,
  });

  const { submitMessage, submitPrompt } = useSubmitMessage();

  const handleKeyUp = useHandleKeyUp({
    index,
    textAreaRef,
    setShowPlusPopover,
    setShowMentionPopover,
  });
  const {
    isNotAppendable,
    handlePaste,
    handleKeyDown,
    handleCompositionStart,
    handleCompositionEnd,
  } = useTextarea({
    textAreaRef,
    submitButtonRef,
    setIsScrollable,
    disabled: disableInputs,
  });

  useQueryParams({ textAreaRef });

  const { ref, ...registerProps } = methods.register('text', {
    required: true,
    onChange: useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) =>
        methods.setValue('text', e.target.value, { shouldValidate: true }),
      [methods],
    ),
  });

  const textValue = useWatch({ control: methods.control, name: 'text' });

  useEffect(() => {
    if (textAreaRef.current) {
      const style = window.getComputedStyle(textAreaRef.current);
      const lineHeight = parseFloat(style.lineHeight);
      setVisualRowCount(Math.floor(textAreaRef.current.scrollHeight / lineHeight));
    }
  }, [textValue]);

  useEffect(() => {
    if (isEditingBadges && backupBadges.length === 0) {
      setBackupBadges([...badges]);
    }
  }, [isEditingBadges, badges, backupBadges.length]);

  const handleSaveBadges = useCallback(() => {
    setIsEditingBadges(false);
    setBackupBadges([]);
  }, [setIsEditingBadges, setBackupBadges]);

  const handleCancelBadges = useCallback(() => {
    if (backupBadges.length > 0) {
      setBadges([...backupBadges]);
    }
    setIsEditingBadges(false);
    setBackupBadges([]);
  }, [backupBadges, setBadges, setIsEditingBadges]);

  const isMoreThanThreeRows = visualRowCount > 3;
  const realtimeEnabled = `${speechConfig?.realtimeEnabled ?? ''}` === 'true';
  const isRealtimeMode = voiceMode === 'realtime';
  const isLegacyVoiceAvailable = SpeechToText && TextToSpeech;
  const isVoiceModeBlocked = disableInputs || isNotAppendable || !endpoint;
  const canUseLegacyVoiceMode = isLegacyVoiceAvailable && !isVoiceModeBlocked;
  const canUseRealtimeVoiceMode = realtimeEnabled && !isVoiceModeBlocked;
  const canUseVoiceMode = isRealtimeMode ? canUseRealtimeVoiceMode : canUseLegacyVoiceMode;
  const isCallModeActive = !isRealtimeMode && voiceChatMode && canUseLegacyVoiceMode;
  const isRealtimeCallActive = isRealtimeMode && voiceChatMode && canUseRealtimeVoiceMode;
  const shouldAutoplayAudio = TextToSpeech && (automaticPlayback || isCallModeActive);

  const formatVoiceDuration = useCallback((seconds: number) => {
    if (seconds < 60) {
      return `${seconds}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }, []);

  const handleVoiceInterruption = useCallback(() => {
    if (!isCallModeActive) {
      return;
    }

    if (isSubmitting || showStopButton) {
      handleStopGenerating({
        preventDefault: () => undefined,
      } as React.MouseEvent<HTMLButtonElement>);
    }
    pauseGlobalAudio();
  }, [isCallModeActive, pauseGlobalAudio, handleStopGenerating, isSubmitting, showStopButton]);

  const handleVoiceModeStartRecording = useCallback(() => {
    handleVoiceInterruption();
  }, [handleVoiceInterruption]);

  const handleVoicePlaybackEnded = useCallback(() => {
    if (!isCallModeActive || isMicListening || isSubmitting || disableInputs || isNotAppendable) {
      return;
    }

    if (voiceRearmTimeoutRef.current != null) {
      window.clearTimeout(voiceRearmTimeoutRef.current);
    }

    voiceRearmTimeoutRef.current = window.setTimeout(() => {
      voiceChatStartRecordingRef.current?.();
    }, VOICE_CHAT_REARM_DELAY_MS);
  }, [disableInputs, isMicListening, isNotAppendable, isSubmitting, isCallModeActive]);

  const handleToggleVoiceChatMode = useCallback(() => {
    if (!canUseVoiceMode) {
      return;
    }
    setVoiceChatMode((prev) => !prev);
  }, [canUseVoiceMode, setVoiceChatMode]);

  const voiceCallStatus = useMemo(() => {
    if (isMicListening) {
      return 'listening' as const;
    }
    if (isSubmitting && showStopButton) {
      return 'processing' as const;
    }
    if (globalAudioPlaying) {
      return 'speaking' as const;
    }
    return 'idle' as const;
  }, [isMicListening, isSubmitting, showStopButton, globalAudioPlaying]);

  useEffect(() => {
    if (!isCallModeActive) {
      return;
    }
    setVoiceCallStatus(voiceCallStatus);
  }, [isCallModeActive, voiceCallStatus, setVoiceCallStatus]);

  useEffect(() => {
    if (isCallModeActive) {
      setVoiceCallInterimTranscript(interimTranscript);
    } else {
      setVoiceCallInterimTranscript('');
    }
  }, [isCallModeActive, interimTranscript, setVoiceCallInterimTranscript]);

  useEffect(() => {
    if (!isCallModeActive) {
      return;
    }

    if (previousVoiceSettingsRef.current == null) {
      previousVoiceSettingsRef.current = {
        conversationMode,
        autoTranscribeAudio,
        autoSendText,
        decibelValue,
        automaticPlayback,
      };
    }

    if (!conversationMode) {
      setConversationMode(true);
    }
    if (!autoTranscribeAudio) {
      setAutoTranscribeAudio(true);
    }
    if (autoSendText === -1) {
      setAutoSendText(VOICE_CHAT_CALL_AUTO_SEND_SECONDS);
    }
    if (decibelValue !== VOICE_CHAT_DECIBEL_VALUE) {
      setDecibelValue(VOICE_CHAT_DECIBEL_VALUE);
    }
    if (!automaticPlayback) {
      setAutomaticPlayback(true);
    }
  }, [
    autoSendText,
    autoTranscribeAudio,
    automaticPlayback,
    conversationMode,
    decibelValue,
    setAutoSendText,
    setAutoTranscribeAudio,
    setAutomaticPlayback,
    setConversationMode,
    setDecibelValue,
    isCallModeActive,
  ]);

  useEffect(() => {
    if (isCallModeActive || previousVoiceSettingsRef.current == null) {
      return;
    }

    const previousSettings = previousVoiceSettingsRef.current;
    setConversationMode(previousSettings.conversationMode);
    setAutoTranscribeAudio(previousSettings.autoTranscribeAudio);
    setAutoSendText(previousSettings.autoSendText);
    setDecibelValue(previousSettings.decibelValue);
    setAutomaticPlayback(previousSettings.automaticPlayback);
    previousVoiceSettingsRef.current = null;
  }, [
    setAutoSendText,
    setAutoTranscribeAudio,
    setAutomaticPlayback,
    setConversationMode,
    setDecibelValue,
    isCallModeActive,
  ]);

  useEffect(() => {
    if (voiceChatMode && !canUseVoiceMode) {
      setVoiceChatMode(false);
    }
  }, [canUseVoiceMode, setVoiceChatMode, voiceChatMode]);

  useEffect(() => {
    if (isRealtimeMode || !voiceChatMode || !canUseVoiceMode || isMicListening || isSubmitting) {
      return;
    }

    if (voiceRearmTimeoutRef.current != null) {
      window.clearTimeout(voiceRearmTimeoutRef.current);
    }

    voiceRearmTimeoutRef.current = window.setTimeout(() => {
      voiceChatStartRecordingRef.current?.();
    }, 250);
  }, [canUseVoiceMode, isMicListening, isSubmitting, voiceChatMode, isRealtimeMode]);

  useEffect(() => {
    if (isCallModeActive) {
      voiceSessionStartRef.current = Date.now();
      setVoiceEndedDuration(null);
      return;
    }

    if (voiceSessionStartRef.current != null) {
      const elapsedSeconds = Math.max(
        1,
        Math.floor((Date.now() - voiceSessionStartRef.current) / 1000),
      );
      setVoiceEndedDuration(elapsedSeconds);
      voiceSessionStartRef.current = null;
    }
  }, [isCallModeActive]);

  const handleSubmitMessage = useCallback(
    (data: { text: string }) => {
      if (isCallModeActive) {
        return;
      }
      submitMessage(data);
    },
    [isCallModeActive, submitMessage],
  );

  useEffect(() => {
    if (voiceEndedDuration == null) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setVoiceEndedDuration(null);
    }, VOICE_CHAT_BADGE_TIMEOUT_MS);

    return () => window.clearTimeout(timeout);
  }, [voiceEndedDuration]);

  useEffect(() => {
    if (!isCallModeActive) {
      setInterimTranscript('');
    }
  }, [isCallModeActive]);

  /*
   * Two separate pipelines — no shared audio or text:
   * 1. User: mic → STT (AudioRecorder) → transcript text → submitMessage. Uses: voiceCallInterimTranscript, form text.
   * 2. Agent: latestMessage → TTS (StreamAudio) → playback + message display. Uses: globalAudioURL, globalAudioPlaying.
   * Cross-pipeline control only: barge-in (user volume → pause TTS), onEnded (TTS done → re-arm mic). No data shared.
   */
  useEffect(() => {
    if (globalAudioPlaying) {
      suppressTranscriptRef.current = true;
      return;
    }
    suppressTranscriptRef.current = true;
    const t = window.setTimeout(() => {
      suppressTranscriptRef.current = false;
    }, 1500);
    return () => window.clearTimeout(t);
  }, [globalAudioPlaying]);

  const bargeInStreamRef = useRef<MediaStream | null>(null);
  const bargeInContextRef = useRef<AudioContext | null>(null);
  const bargeInRafRef = useRef<number | null>(null);
  const BARGE_IN_VOLUME_THRESHOLD = 25;

  useEffect(() => {
    if (!isCallModeActive || !globalAudioPlaying) {
      return;
    }

    let cancelled = false;
    const streamPromise = navigator.mediaDevices
      .getUserMedia({ audio: true })
      .catch(() => null);

    streamPromise.then((stream) => {
      if (cancelled || !stream) {
        return;
      }
      bargeInStreamRef.current = stream;
      const ctx = new AudioContext();
      bargeInContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const checkVolume = () => {
        if (cancelled) {
          return;
        }
        analyser.getByteFrequencyData(dataArray);
        const sum = dataArray.reduce((a, b) => a + b, 0);
        const avg = sum / dataArray.length;
        if (avg > BARGE_IN_VOLUME_THRESHOLD) {
          handleVoiceInterruption();
          return;
        }
        bargeInRafRef.current = requestAnimationFrame(checkVolume);
      };
      bargeInRafRef.current = requestAnimationFrame(checkVolume);
    });

    return () => {
      cancelled = true;
      if (bargeInRafRef.current != null) {
        cancelAnimationFrame(bargeInRafRef.current);
        bargeInRafRef.current = null;
      }
      bargeInStreamRef.current?.getTracks().forEach((t) => t.stop());
      bargeInStreamRef.current = null;
      bargeInContextRef.current?.close();
      bargeInContextRef.current = null;
    };
  }, [isCallModeActive, globalAudioPlaying, handleVoiceInterruption]);

  useEffect(() => {
    return () => {
      if (voiceRearmTimeoutRef.current != null) {
        window.clearTimeout(voiceRearmTimeoutRef.current);
      }
    };
  }, []);

  const baseClasses = useMemo(
    () =>
      cn(
        'md:py-3.5 m-0 w-full resize-none py-[13px] placeholder-black/50 bg-transparent dark:placeholder-white/50 [&:has(textarea:focus)]:shadow-[0_2px_6px_rgba(0,0,0,.05)]',
        isCollapsed ? 'max-h-[52px]' : 'max-h-[45vh] md:max-h-[55vh]',
        isMoreThanThreeRows ? 'pl-5' : 'px-5',
      ),
    [isCollapsed, isMoreThanThreeRows],
  );

  if (isRealtimeCallActive) {
    return (
      <RealtimeVoiceCall
        onEndCall={() => setVoiceChatMode(false)}
        conversation={conversation}
        setConversation={setConversation}
        getMessages={getMessages}
        setMessages={setMessages}
      />
    );
  }

  if (isCallModeActive) {
    return (
      <form
        onSubmit={methods.handleSubmit(handleSubmitMessage)}
        className="relative w-full min-h-0"
        aria-label={localize('com_ui_voice_chat_mode')}
      >
        <textarea
          ref={(e) => {
            (textAreaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = e;
          }}
          className="sr-only"
          aria-hidden
          tabIndex={-1}
        />
        <VoiceModeFloatingBar status={voiceCallStatus} onEndCall={handleToggleVoiceChatMode}>
          {SpeechToText && (
            <AudioRecorder
              methods={methods}
              ask={submitMessage}
              textAreaRef={textAreaRef}
              disabled={disableInputs || isNotAppendable}
              isSubmitting={isSubmitting}
              onStartRecording={handleVoiceModeStartRecording}
              onSpeechDetected={handleVoiceInterruption}
              onListeningChange={setIsMicListening}
              onInterimTranscriptChange={setInterimTranscript}
              onSTTSourceChange={setSttSource}
              preferExternalSTT
              suppressTranscriptRef={suppressTranscriptRef}
              pauseListening={globalAudioPlaying}
              registerStartRecording={(startRecording) => {
                voiceChatStartRecordingRef.current = startRecording;
              }}
            />
          )}
        </VoiceModeFloatingBar>
        {shouldAutoplayAudio && (
          <StreamAudio index={index} onEnded={handleVoicePlaybackEnded} />
        )}
      </form>
    );
  }

  return (
    <form
      onSubmit={methods.handleSubmit(handleSubmitMessage)}
      className={cn(
        'mx-auto flex w-full flex-row gap-3 transition-[max-width] duration-300 sm:px-2',
        maximizeChatSpace ? 'max-w-full' : 'md:max-w-3xl xl:max-w-4xl',
        centerFormOnLanding &&
          (conversationId == null || conversationId === Constants.NEW_CONVO) &&
          !isSubmitting &&
          conversation?.messages?.length === 0
          ? 'transition-all duration-200 sm:mb-28'
          : 'sm:mb-10',
      )}
    >
      <div className="relative flex h-full flex-1 items-stretch md:flex-col">
        <div className={cn('flex w-full items-center', isRTL && 'flex-row-reverse')}>
          {showPlusPopover && !isAssistantsEndpoint(endpoint) && (
            <Mention
              conversation={conversation}
              setShowMentionPopover={setShowPlusPopover}
              newConversation={generateConversation}
              textAreaRef={textAreaRef}
              commandChar="+"
              placeholder="com_ui_add_model_preset"
              includeAssistants={false}
            />
          )}
          {showMentionPopover && (
            <Mention
              conversation={conversation}
              setShowMentionPopover={setShowMentionPopover}
              newConversation={newConversation}
              textAreaRef={textAreaRef}
            />
          )}
          <PromptsCommand index={index} textAreaRef={textAreaRef} submitPrompt={submitPrompt} />
          <div
            onClick={handleContainerClick}
            className={cn(
              'relative flex w-full flex-grow flex-col overflow-hidden rounded-t-3xl border pb-4 text-text-primary transition-all duration-200 sm:rounded-3xl sm:pb-0',
              isTextAreaFocused ? 'shadow-lg' : 'shadow-md',
              isTemporary
                ? 'border-violet-800/60 bg-violet-950/10'
                : isCallModeActive
                  ? 'border-emerald-800/60 bg-emerald-950/10'
                  : 'border-border-light bg-surface-chat',
            )}
          >
            <TextareaHeader addedConvo={addedConvo} setAddedConvo={setAddedConvo} />
            {/* WIP */}
            <EditBadges
              isEditingChatBadges={isEditingBadges}
              handleCancelBadges={handleCancelBadges}
              handleSaveBadges={handleSaveBadges}
              setBadges={setBadges}
            />
            <FileFormChat conversation={conversation} />
            {voiceEndedDuration != null && (
              <div className="mx-3 mt-2 flex items-center justify-between rounded-xl border border-border-light bg-surface-secondary px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <AudioLines className="h-4 w-4" aria-hidden="true" />
                  <div className="flex items-center gap-2">
                    <span>{localize('com_ui_voice_chat_ended')}</span>
                    <span className="text-text-secondary">
                      {formatVoiceDuration(voiceEndedDuration)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={localize('com_ui_feedback_positive')}
                    className="rounded-md p-1 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                  >
                    <ThumbsUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={localize('com_ui_feedback_negative')}
                    className="rounded-md p-1 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                  >
                    <ThumbsDown className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={localize('com_ui_close')}
                    className="rounded-md p-1 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                    onClick={() => setVoiceEndedDuration(null)}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
            {isCallModeActive && (
              <div className="mx-3 mt-2 rounded-xl border border-emerald-800/40 bg-emerald-950/20 px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-emerald-200">
                    {localize('com_ui_voice_call_listening')}
                  </span>
                  <span className="text-xs text-text-secondary">
                    {localize(
                      sttSource === 'external'
                        ? 'com_ui_voice_stt_source_external'
                        : 'com_ui_voice_stt_source_browser',
                    )}
                  </span>
                </div>
                {interimTranscript.trim().length > 0 && (
                  <div className="mt-2 text-text-primary">{interimTranscript}</div>
                )}
              </div>
            )}
            {endpoint && (
              <div className={cn('flex', isRTL ? 'flex-row-reverse' : 'flex-row')}>
                <div
                  className="relative flex-1"
                  style={
                    isCollapsed
                      ? {
                          WebkitMaskImage: 'linear-gradient(to bottom, black 60%, transparent 90%)',
                          maskImage: 'linear-gradient(to bottom, black 60%, transparent 90%)',
                        }
                      : undefined
                  }
                >
                  <TextareaAutosize
                    {...registerProps}
                    ref={(e) => {
                      ref(e);
                      (textAreaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current =
                        e;
                    }}
                    disabled={disableInputs || isNotAppendable || isCallModeActive}
                    onPaste={handlePaste}
                    onKeyDown={handleKeyDown}
                    onKeyUp={handleKeyUp}
                    onCompositionStart={handleCompositionStart}
                    onCompositionEnd={handleCompositionEnd}
                    id={mainTextareaId}
                    tabIndex={0}
                    data-testid="text-input"
                    rows={1}
                    onFocus={() => {
                      handleFocusOrClick();
                      setIsTextAreaFocused(true);
                    }}
                    onBlur={setIsTextAreaFocused.bind(null, false)}
                    aria-label={localize('com_ui_message_input')}
                    onClick={handleFocusOrClick}
                    style={{ height: 44, overflowY: 'auto' }}
                    className={cn(
                      baseClasses,
                      removeFocusRings,
                      'scrollbar-hover transition-[max-height] duration-200 disabled:cursor-not-allowed',
                    )}
                  />
                </div>
                <div className="flex flex-col items-start justify-start pr-2.5 pt-1.5">
                  <CollapseChat
                    isCollapsed={isCollapsed}
                    isScrollable={isMoreThanThreeRows}
                    setIsCollapsed={setIsCollapsed}
                  />
                </div>
              </div>
            )}
            <div
              className={cn(
                '@container items-between flex items-center gap-2 pb-2',
                isRTL ? 'flex-row-reverse' : 'flex-row',
              )}
            >
              <div className={`${isRTL ? 'mr-2' : 'ml-2'}`}>
                <AttachFileChat conversation={conversation} disableInputs={disableInputs} />
              </div>
              <div className="min-w-0 flex-1 overflow-hidden">
                <BadgeRow
                  showEphemeralBadges={
                    !!endpoint && !isAgentsEndpoint(endpoint) && !isAssistantsEndpoint(endpoint)
                  }
                  isSubmitting={isSubmitting}
                  conversationId={conversationId}
                  onChange={setBadges}
                  isInChat={
                    Array.isArray(conversation?.messages) && conversation.messages.length >= 1
                  }
                />
              </div>
              <div className={cn('flex shrink-0 items-center gap-2', isRTL ? 'ml-2' : 'mr-2')}>
                {SpeechToText && (
                  <AudioRecorder
                    methods={methods}
                    ask={submitMessage}
                    textAreaRef={textAreaRef}
                    disabled={disableInputs || isNotAppendable}
                    isSubmitting={isSubmitting}
                    onStartRecording={handleVoiceModeStartRecording}
                    onSpeechDetected={handleVoiceInterruption}
                    onListeningChange={setIsMicListening}
                    onInterimTranscriptChange={setInterimTranscript}
                    onSTTSourceChange={setSttSource}
                    preferExternalSTT={isCallModeActive}
                    suppressTranscriptRef={suppressTranscriptRef}
                    pauseListening={isCallModeActive && globalAudioPlaying}
                    registerStartRecording={(startRecording) => {
                      voiceChatStartRecordingRef.current = startRecording;
                    }}
                  />
                )}
                <div>
                  {isSubmitting && showStopButton ? (
                    <StopButton stop={handleStopGenerating} setShowStopButton={setShowStopButton} />
                  ) : (
                    endpoint && (
                      <SendButton
                        ref={submitButtonRef}
                        control={methods.control}
                        disabled={
                          filesLoading ||
                          isSubmitting ||
                          disableInputs ||
                          isNotAppendable ||
                          isCallModeActive
                        }
                      />
                    )
                  )}
                </div>
                <TooltipAnchor
                  description={
                    !canUseVoiceMode
                      ? isRealtimeMode
                        ? localize('com_ui_voice_mode_realtime_unavailable')
                        : localize('com_ui_voice_chat_mode_unavailable')
                      : isVoiceModeBlocked
                        ? localize('com_endpoint_config_placeholder')
                        : localize('com_ui_voice_chat_mode')
                  }
                  render={
                    <button
                      id="voice-chat-mode-toggle"
                      type="button"
                      aria-label={localize('com_ui_voice_chat_mode')}
                      aria-pressed={voiceChatMode}
                      onClick={handleToggleVoiceChatMode}
                      disabled={!canUseVoiceMode}
                      className={cn(
                        'flex size-10 items-center justify-center rounded-full border transition-all',
                        (isCallModeActive || isRealtimeCallActive)
                          ? 'border-transparent bg-white text-black shadow-md dark:bg-white dark:text-black'
                          : 'border-border-light bg-transparent text-text-secondary hover:bg-surface-hover',
                        !canUseVoiceMode && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      <AudioLines className="h-5 w-5" aria-hidden="true" />
                    </button>
                  }
                />
              </div>
            </div>
            {shouldAutoplayAudio && (
              <StreamAudio index={index} onEnded={handleVoicePlaybackEnded} />
            )}
          </div>
        </div>
      </div>
    </form>
  );
});

export default ChatForm;
