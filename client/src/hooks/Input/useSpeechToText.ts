import useSpeechToTextBrowser from './useSpeechToTextBrowser';
import useSpeechToTextExternal from './useSpeechToTextExternal';
import useGetAudioSettings from './useGetAudioSettings';

const useSpeechToText = (
  setText: (text: string) => void,
  onTranscriptionComplete: (text: string) => void,
  options?: {
    preferExternal?: boolean;
  },
): {
  isLoading?: boolean;
  isListening?: boolean;
  stopRecording: () => void | (() => Promise<void>);
  startRecording: () => void | (() => Promise<void>);
  activeSource: 'external' | 'browser';
} => {
  const { speechToTextEndpoint } = useGetAudioSettings();

  const {
    isListening: speechIsListeningBrowser,
    isLoading: speechIsLoadingBrowser,
    startRecording: startSpeechRecordingBrowser,
    stopRecording: stopSpeechRecordingBrowser,
    isSupported: browserSupported,
  } = useSpeechToTextBrowser(setText, onTranscriptionComplete);

  const {
    isListening: speechIsListeningExternal,
    isLoading: speechIsLoadingExternal,
    externalStartRecording: startSpeechRecordingExternal,
    externalStopRecording: stopSpeechRecordingExternal,
    isSupported: externalSupported,
  } = useSpeechToTextExternal(setText, onTranscriptionComplete);

  const preferExternal = options?.preferExternal === true || speechToTextEndpoint === 'external';
  const useExternal = preferExternal && externalSupported;
  const useBrowser = !useExternal && browserSupported;

  const isListening = useExternal
    ? speechIsListeningExternal
    : useBrowser
      ? speechIsListeningBrowser
      : false;
  const isLoading = useExternal
    ? speechIsLoadingExternal
    : useBrowser
      ? speechIsLoadingBrowser
      : false;

  const startRecording = useExternal
    ? startSpeechRecordingExternal
    : useBrowser
      ? startSpeechRecordingBrowser
      : () => undefined;
  const stopRecording = useExternal
    ? stopSpeechRecordingExternal
    : useBrowser
      ? stopSpeechRecordingBrowser
      : () => undefined;

  return {
    isLoading,
    isListening,
    stopRecording,
    startRecording,
    activeSource: useExternal ? 'external' : 'browser',
  };
};

export default useSpeechToText;
