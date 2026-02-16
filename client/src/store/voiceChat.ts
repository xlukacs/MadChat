import { atom } from 'recoil';
import { atomWithLocalStorage } from '~/store/utils';

const voiceChatMode = atomWithLocalStorage('voiceChatMode', false);
const voiceMode = atomWithLocalStorage<'legacy' | 'realtime'>('voiceMode', 'legacy');

/** Status shown in the floating bar during voice call mode */
export type VoiceCallStatus = 'idle' | 'listening' | 'processing' | 'speaking';

const voiceCallStatus = atom<VoiceCallStatus>({
  key: 'voiceCallStatus',
  default: 'idle',
});

/** Live interim transcript shown in messages area while user speaks */
const voiceCallInterimTranscript = atom<string>({
  key: 'voiceCallInterimTranscript',
  default: '',
});

export default {
  voiceChatMode,
  voiceMode,
  voiceCallStatus,
  voiceCallInterimTranscript,
};
