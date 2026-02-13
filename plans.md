---
name: voice-chat-mode
overview: Implement a dedicated Voice Chat Mode as a frontend-only chat mode, independent from Temporary Chat, with continuous audio turn-taking behavior.
todos:
  - id: add-voice-mode-state
    content: Create and export a persisted voiceChatMode atom in client store
    status: in_progress
  - id: add-input-toggle
    content: Implement rightmost input-bar Voice Chat toggle and wire mode state
    status: pending
  - id: stop-on-user-speech
    content: Stop model generation immediately when user starts speaking in Voice Chat Mode
    status: pending
  - id: wire-continuous-loop
    content: Connect TTS playback ended event to mic auto re-arm when voice mode is active
    status: pending
  - id: integrate-chatform-behavior
    content: Apply voice mode behavior/visuals in ChatForm with safety guards
    status: pending
  - id: call-length-badge
    content: Show non-persistent call-length badge in input area when voice mode is turned off
    status: pending
  - id: tests-and-validation
    content: Add tests and run lint/type validation for modified client files
    status: pending
isProject: false
---

# Voice Chat Mode Implementation Plan

## Goal

Add a dedicated `Voice Chat Mode` using a rightmost input-bar toggle (as shown in your mockup) that enables continuous voice turn-taking: user speaks, auto-send triggers, AI replies with auto-playback, then mic re-arms for the next turn.

## Decisions Locked

- Frontend-only mode (no backend schema/conversation type changes)
- Voice Chat Mode remains independent from Temporary Chat
- Voice mode toggle lives in the chat input bar as the most-right icon
- Call length is shown as a non-persistent badge in the input area after voice mode ends

## Implementation Steps

- Add a new persisted mode atom in [C:/Users/madre/Documents/GitHub/MadChat/client/src/store](C:/Users/madre/Documents/GitHub/MadChat/client/src/store) (e.g., `voiceChatMode`) and export it via [C:/Users/madre/Documents/GitHub/MadChat/client/src/store/index.ts](C:/Users/madre/Documents/GitHub/MadChat/client/src/store/index.ts).
- Add a rightmost icon button to [C:/Users/madre/Documents/GitHub/MadChat/client/src/components/Chat/Input/ChatForm.tsx](C:/Users/madre/Documents/GitHub/MadChat/client/src/components/Chat/Input/ChatForm.tsx) (near mic/send controls) that:
  - uses a Lucide voice icon style matching your screenshot,
  - toggles `voiceChatMode`,
  - reflects active state visually (Tailwind state styles).
- In [C:/Users/madre/Documents/GitHub/MadChat/client/src/components/Chat/Input/ChatForm.tsx](C:/Users/madre/Documents/GitHub/MadChat/client/src/components/Chat/Input/ChatForm.tsx):
  - derive effective speech behavior from `voiceChatMode` (force `conversationMode` semantics and `automaticPlayback` behavior while active),
  - add subtle Tailwind visual treatment for active voice mode.
- Interrupt model output when user begins speaking in voice mode:
  - wire `AudioRecorder` start-listening action to invoke existing stop-generation flow from ChatForm (`handleStopGenerating`) when currently submitting/streaming,
  - ensure this only applies while `voiceChatMode` is active.
- Add playback-ended callback wiring:
  - extend [C:/Users/madre/Documents/GitHub/MadChat/client/src/hooks/Audio/useCustomAudioRef.ts](C:/Users/madre/Documents/GitHub/MadChat/client/src/hooks/Audio/useCustomAudioRef.ts) to accept optional `onEnded`,
  - pass callback from [C:/Users/madre/Documents/GitHub/MadChat/client/src/components/Chat/Input/StreamAudio.tsx](C:/Users/madre/Documents/GitHub/MadChat/client/src/components/Chat/Input/StreamAudio.tsx).
- Expose mic re-arm from [C:/Users/madre/Documents/GitHub/MadChat/client/src/components/Chat/Input/AudioRecorder.tsx](C:/Users/madre/Documents/GitHub/MadChat/client/src/components/Chat/Input/AudioRecorder.tsx) to parent (imperative ref or callback registration), then trigger it when TTS playback ends and `voiceChatMode` is active.
- Add safeguards to avoid conflicts:
  - do not auto-start mic if already listening,
  - avoid restart while message is submitting,
  - add a short debounce/delay before re-arming mic.
- Add voice session timing and end badge in [C:/Users/madre/Documents/GitHub/MadChat/client/src/components/Chat/Input/ChatForm.tsx](C:/Users/madre/Documents/GitHub/MadChat/client/src/components/Chat/Input/ChatForm.tsx):
  - start timer when `voiceChatMode` becomes active,
  - on toggle-off, compute elapsed duration and show a non-persistent input-area badge like `Voice chat ended • 59s`,
  - allow dismiss action and auto-hide timeout.
- Add/adjust i18n labels in [C:/Users/madre/Documents/GitHub/MadChat/client/src/locales/en/translation.json](C:/Users/madre/Documents/GitHub/MadChat/client/src/locales/en/translation.json) (and optional follow-up locale sync).
- Add focused tests for:
  - rightmost input toggle visibility/interaction and state persistence,
  - stop-generation-on-speech-start behavior in voice mode,
  - playback-ended -> mic re-arm path,
  - call-length badge shown on mode end and hidden/dismiss logic,
  - no auto re-arm when mode off.

## Validation

- Manual QA: toggle Voice Chat Mode on a new chat, start one turn, confirm continuous loop across multiple turns.
- While model is speaking/streaming, start speaking and verify generation stops immediately, then STT takes over.
- Turn voice mode off and verify elapsed call-length badge appears in the input area and can be dismissed.
- Verify that disabling mode immediately returns to standard text/speech behavior.
- Run lint/type checks on touched client files and fix any introduced diagnostics.

## Out of Scope

- Backend persistence/model changes for conversation type
- Coupling Voice Chat Mode with Temporary Chat

