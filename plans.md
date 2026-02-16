---
name: OpenAI Realtime Voice Mode
overview: Add a new voice call mode powered by the OpenAI Realtime API with WebRTC bidirectional audio, while keeping the existing STT/TTS pipeline as a fallback. Realtime sessions support transcription display and message persistence.
todos: []
isProject: false
---

# OpenAI Realtime API Voice Mode

## Architecture Overview

```mermaid
flowchart TB
    subgraph client [Client]
        UI[VoiceModeFloatingBar]
        RealtimeHook[useRealtimeVoice]
        WebRTC[WebRTC PeerConnection]
        Mic[User Microphone]
        Speaker[Audio Output]
    end

    subgraph backend [Backend Proxy]
        RealtimeRoute[/api/realtime/session]
        OpenAI[OpenAI /v1/realtime/calls]
    end

    UI --> RealtimeHook
    RealtimeHook --> WebRTC
    Mic --> WebRTC
    WebRTC --> Speaker
    WebRTC -->|SDP offer| RealtimeRoute
    RealtimeRoute -->|SDP + config| OpenAI
    OpenAI -->|SDP answer| RealtimeRoute
    RealtimeRoute --> WebRTC
    WebRTC <-->|Bidirectional audio| OpenAI
```



**Two pipelines (no shared data):**

- **Legacy mode**: Mic → STT (Whisper/browser) → submitMessage → LLM stream → TTS (StreamAudio) → speaker. Uses existing [AudioRecorder](client/src/components/Chat/Input/AudioRecorder.tsx), [StreamAudio](client/src/components/Chat/Input/StreamAudio.tsx).
- **Realtime mode**: WebRTC directly to OpenAI — mic and speaker streamed bidirectionally. Interruption handled by OpenAI (`response.audio_transcript.done` with `truncated: true`).

---

## Phase 1: Backend – Realtime Session Proxy

### 1.1 New API Route

Create [api/server/routes/realtime/index.js](api/server/routes/realtime/index.js):

- `POST /api/realtime/session` — accepts SDP offer (base64) + optional `voice` and `instructions` in JSON body.
- Server creates `RTCPeerConnection`, generates SDP offer with session config (model: `gpt-4o-realtime-preview-2024-12-17` or latest), voice, instructions.
- Call OpenAI `POST https://api.openai.com/v1/realtime/calls` with FormData: `model`, `voice`, `instructions` (optional), client SDP. Use `OPENAI_API_KEY` from env or user keys.
- Return OpenAI’s SDP answer to client.

Reference: [OpenAI Realtime WebRTC guide](https://platform.openai.com/docs/guides/realtime-webrtc) — “unified interface” pattern (backend proxies SDP, keeps API key server-side).

### 1.2 Config and Auth

- Add `realtime` section to [librechat.yaml](librechat.yaml) (or detect from existing `speech.tts.openai`): model, voice, enable/disable.
- Use `getUserKey`/config for OpenAI key (same pattern as agents).
- Require auth (passport) on `/api/realtime/*`.

---

## Phase 2: Client – Realtime Voice Hook and Component

### 2.1 Hook: `useRealtimeVoice`

Create [client/src/hooks/Voice/useRealtimeVoice.ts](client/src/hooks/Voice/useRealtimeVoice.ts):

- **Connection**: `POST /api/realtime/session` with SDP offer → get SDP answer → `RTCPeerConnection.setRemoteDescription` → connect.
- **Events** (data channel): Handle `response.audio_transcript.done` with `truncated: true` → pause playback / treat as interruption. Handle `session.updated`, `error`, `call.ended`.
- **State**: `status`: `'idle' | 'connecting' | 'listening' | 'speaking' | 'interrupted' | 'ended' | 'error'`
- **Callbacks**: `onTranscriptDelta` (live user transcript), `onAgentTranscript` (agent text), `onInterrupted` (barge-in), `onEnded`, `onError`
- Use `@openai/agents` or raw WebRTC + data channel. Prefer official SDK if stable; otherwise implement minimal WebRTC handshake per OpenAI docs.

### 2.2 Realtime Voice UI Component

Create [client/src/components/Chat/Input/RealtimeVoiceCall.tsx](client/src/components/Chat/Input/RealtimeVoiceCall.tsx):

- Renders when Realtime mode is active (new store atom or toggle).
- Uses `VoiceModeFloatingBar` with status from `useRealtimeVoice`.
- Manages `useRealtimeVoice` lifecycle: start on mount when mode on, disconnect on “End call”.
- No form/textarea — pure voice. Ephemeral: no `submitMessage`, no conversation sync.

---

## Phase 3: Mode Selection and Integration

### 3.1 Realtime vs Legacy Toggle

- Add `voiceMode: 'legacy' | 'realtime'` to [client/src/store/voiceChat.ts](client/src/store/voiceChat.ts) (persisted).
- In [client/src/components/Chat/Input/ChatForm.tsx](client/src/components/Chat/Input/ChatForm.tsx): when `voiceChatMode` is on, branch:
  - If `voiceMode === 'realtime'` and Realtime config available → render `RealtimeVoiceCall`.
  - Else → render existing `VoiceModeFloatingBar` + `AudioRecorder` + `StreamAudio`.
- Settings UI: add toggle or dropdown for “Voice mode: Legacy (STT/TTS) / Realtime (OpenAI)”. Show Realtime only when OpenAI key is configured.

### 3.2 Interruption Handling (Realtime)

- OpenAI sends `response.audio_transcript.done` with `truncated: true` when user speaks over the model → stop playing agent audio.
- No custom barge-in detector needed — Realtime API handles it natively.
- Keep legacy barge-in (volume-based + `pauseListening`) for non-Realtime mode.

---

## Phase 4: Cleanup and Edge Cases

### 4.1 Dependencies

- Add `@openai/agents` or minimal WebRTC helpers if needed. Check [openai-realtime-api](https://www.npmjs.com/package/openai-realtime-api) or official examples.
- No change to existing STT/TTS deps.

### 4.2 Edge Cases

- **No OpenAI key**: Hide or disable Realtime option; fall back to legacy.
- **WebRTC unsupported**: Detect and show message; suggest legacy.
- **Network errors**: Surface in `VoiceModeFloatingBar`, allow retry.
- **Concurrent use**: Only one active voice session per tab; Realtime and legacy mutually exclusive when call is active.

---

## File Summary


| Action | File                                                                        |
| ------ | --------------------------------------------------------------------------- |
| Create | `api/server/routes/realtime/index.js`                                       |
| Create | `api/server/controllers/realtime/session.js`                                |
| Modify | `api/server/routes/index.js` (mount realtime)                               |
| Create | `client/src/hooks/Voice/useRealtimeVoice.ts`                                |
| Create | `client/src/components/Chat/Input/RealtimeVoiceCall.tsx`                    |
| Modify | `client/src/store/voiceChat.ts` (add voiceMode)                             |
| Modify | `client/src/components/Chat/Input/ChatForm.tsx` (branch Realtime vs legacy) |
| Modify | `librechat.yaml` (realtime config)                                          |
| Modify | Config/speech UI for mode selection                                         |


---

## Preserved Behavior

- **Legacy mode**: All current behavior (STT, TTS, barge-in, floating bar, live transcript) unchanged.
- **Realtime mode**: ChatGPT-like voice UX with native interruption, lower latency, single WebRTC pipe, with transcript display and persistence support.

