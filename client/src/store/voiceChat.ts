import { atomWithLocalStorage } from '~/store/utils';

const voiceChatMode = atomWithLocalStorage('voiceChatMode', false);

export default {
  voiceChatMode,
};
