import { apiBaseUrl, request } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';

type SaveRealtimeMessageParams = {
  conversationId: string;
  message: Partial<TMessage> &
    Pick<
      TMessage,
      'messageId' | 'parentMessageId' | 'text' | 'sender' | 'isCreatedByUser' | 'endpoint'
    >;
};

export default function useSaveRealtimeMessage() {
  return async ({ conversationId, message }: SaveRealtimeMessageParams) => {
    return request.post(`${apiBaseUrl()}/api/messages/${conversationId}`, {
      ...message,
      conversationId,
    }) as Promise<TMessage>;
  };
}
