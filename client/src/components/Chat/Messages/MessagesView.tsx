import { useState, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { CSSTransition } from 'react-transition-group';
import type { TMessage } from 'librechat-data-provider';
import { useScreenshot, useMessageScrolling, useLocalize } from '~/hooks';
import ScrollToBottom from '~/components/Messages/ScrollToBottom';
import { MessagesViewProvider } from '~/Providers';
import { fontSizeAtom } from '~/store/fontSize';
import MultiMessage from './MultiMessage';
import MessageNav from './MessageNav';
import { cn } from '~/utils';
import store from '~/store';

function MessagesViewContent({
  messagesTree: _messagesTree,
}: {
  messagesTree?: TMessage[] | null;
}) {
  const localize = useLocalize();
  const fontSize = useAtomValue(fontSizeAtom);
  const voiceChatMode = useRecoilValue(store.voiceChatMode);
  const voiceCallInterimTranscript = useRecoilValue(store.voiceCallInterimTranscript);
  const voiceCallToolActivity = useRecoilValue(store.voiceCallToolActivity);
  const { screenshotTargetRef } = useScreenshot();
  const scrollButtonPreference = useRecoilValue(store.showScrollButton);
  const [currentEditId, setCurrentEditId] = useState<number | string | null>(-1);
  const scrollToBottomRef = useRef<HTMLDivElement>(null);

  const {
    conversation,
    scrollableRef,
    messagesEndRef,
    showScrollButton,
    handleSmoothToRef,
    debouncedHandleScroll,
  } = useMessageScrolling(_messagesTree);

  const { conversationId } = conversation ?? {};
  const showLiveTranscript = voiceChatMode && voiceCallInterimTranscript.trim().length > 0;
  const showToolActivity = voiceChatMode && voiceCallToolActivity != null && voiceCallToolActivity.length > 0;

  return (
    <>
      <div className="relative flex-1 overflow-hidden overflow-y-auto">
        <div className="relative h-full">
          <div
            className="scrollbar-gutter-stable"
            onScroll={debouncedHandleScroll}
            ref={scrollableRef}
            style={{
              height: '100%',
              overflowY: 'auto',
              width: '100%',
            }}
          >
            <div
              className={cn(
                'flex flex-col pb-9 pt-14 dark:bg-transparent',
                voiceChatMode && 'mx-auto max-w-2xl px-4 pb-28',
              )}
            >
              {(_messagesTree && _messagesTree.length == 0) || _messagesTree === null ? (
                <div
                  className={cn(
                    'flex w-full items-center justify-center p-3 text-text-secondary',
                    fontSize,
                  )}
                >
                  {localize('com_ui_nothing_found')}
                </div>
              ) : (
                <>
                  <div ref={screenshotTargetRef}>
                    <MultiMessage
                      messagesTree={_messagesTree}
                      messageId={conversationId ?? null}
                      setCurrentEditId={setCurrentEditId}
                      currentEditId={currentEditId ?? null}
                    />
                  </div>
                </>
              )}
              <div
                id="messages-end"
                className="group h-0 w-full flex-shrink-0"
                ref={messagesEndRef}
              />
            </div>
          </div>

          {(showLiveTranscript || showToolActivity) && (
            <div
              className="absolute bottom-24 left-1/2 z-40 w-full max-w-xl -translate-x-1/2 px-4 animate-in fade-in duration-200"
              role="status"
              aria-live="polite"
            >
              <div className="scrollbar-gutter-stable max-h-[40vh] overflow-y-auto rounded-2xl border border-emerald-800/40 bg-emerald-950/90 px-4 py-3 shadow-lg backdrop-blur-sm">
                {showToolActivity && (
                  <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-emerald-700/50 bg-emerald-900/60 px-3 py-1 text-xs font-medium text-emerald-100">
                    <span className="inline-block size-2 animate-pulse rounded-full bg-emerald-400" aria-hidden />
                    {localize('com_ui_voice_realtime_using_tool', { toolName: voiceCallToolActivity ?? '' })}
                  </div>
                )}
                {showLiveTranscript && (
                  <p className="whitespace-pre-wrap break-words text-sm text-emerald-100">
                    {voiceCallInterimTranscript}
                  </p>
                )}
                {showLiveTranscript && (
                  <div className="mt-2 flex gap-1">
                    {[1, 2, 3].map((i) => (
                      <span
                        key={i}
                        className="h-1 w-1 animate-pulse rounded-full bg-emerald-400"
                        style={{ animationDelay: `${i * 150}ms` }}
                        aria-hidden
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <CSSTransition
            in={showScrollButton && scrollButtonPreference}
            timeout={{
              enter: 300,
              exit: 250,
            }}
            classNames="scroll-animation"
            unmountOnExit={true}
            appear={true}
            nodeRef={scrollToBottomRef}
          >
            <ScrollToBottom ref={scrollToBottomRef} scrollHandler={handleSmoothToRef} />
          </CSSTransition>

          <MessageNav scrollableRef={scrollableRef} />
        </div>
      </div>
    </>
  );
}

export default function MessagesView({ messagesTree }: { messagesTree?: TMessage[] | null }) {
  return (
    <MessagesViewProvider>
      <MessagesViewContent messagesTree={messagesTree} />
    </MessagesViewProvider>
  );
}
