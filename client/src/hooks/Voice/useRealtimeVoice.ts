import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthContext } from '~/hooks/AuthContext';

export type RealtimeVoiceStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'interrupted'
  | 'ended'
  | 'error';

export type RealtimeFunctionTool = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type RealtimeFunctionCallItem = {
  type?: string;
  id?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};

type RealtimeVoiceEvent = {
  type?: string;
  transcript?: string;
  delta?: string;
  text?: string;
  truncated?: boolean;
  call_id?: string;
  item_id?: string;
  arguments?: string;
  name?: string;
  item?: RealtimeFunctionCallItem;
  error?: { message?: string } | string;
  response?: {
    output?: RealtimeFunctionCallItem[];
  };
  [key: string]: unknown;
};

type PendingFunctionCall = {
  name?: string;
  callId?: string;
  arguments?: string;
};

type UseRealtimeVoiceOptions = {
  model?: string;
  voice?: string;
  transcriptionModel?: string;
  instructions?: string;
  tools?: RealtimeFunctionTool[];
  onTranscriptDelta?: (text: string) => void;
  onAgentTranscript?: (text: string) => void;
  onUserTurnComplete?: (text: string) => void;
  onAgentTurnComplete?: (text: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>, callId: string) => Promise<string>;
  onToolCallStart?: (name: string, callId: string) => void;
  onToolCallEnd?: (name: string, callId: string, success: boolean) => void;
  onInterrupted?: () => void;
  onEnded?: () => void;
  onError?: (message: string) => void;
};

function parseMessageData(input: string): RealtimeVoiceEvent | null {
  try {
    return JSON.parse(input) as RealtimeVoiceEvent;
  } catch {
    return null;
  }
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function extractFunctionCalls(event: RealtimeVoiceEvent): RealtimeFunctionCallItem[] {
  const output = event.response?.output;
  if (!Array.isArray(output)) {
    return [];
  }
  return output.filter((item) => item?.type === 'function_call');
}

function toFunctionCallItem(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): RealtimeFunctionCallItem {
  return {
    type: 'function_call',
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  };
}

function buildSessionUpdate(options: UseRealtimeVoiceOptions): Record<string, unknown> {
  const sessionTools = options.tools ?? [];
  const sessionUpdate: Record<string, unknown> = {
    type: 'session.update',
    session: {
      type: 'realtime',
      model: options.model,
      audio: {
        input: {
          transcription: {
            model: options.transcriptionModel || 'gpt-4o-mini-transcribe',
          },
        },
        output: {
          voice: options.voice,
        },
      },
      instructions: options.instructions,
      turn_detection: {
        type: 'server_vad',
      },
    },
  };

  if (sessionTools.length > 0) {
    (sessionUpdate.session as Record<string, unknown>).tools = sessionTools;
    (sessionUpdate.session as Record<string, unknown>).tool_choice = 'auto';
  }

  return sessionUpdate;
}

function getSessionTools(options: UseRealtimeVoiceOptions): RealtimeFunctionTool[] {
  return options.tools ?? [];
}

export default function useRealtimeVoice(options: UseRealtimeVoiceOptions = {}) {
  const { token } = useAuthContext();
  const [status, setStatus] = useState<RealtimeVoiceStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [userTranscript, setUserTranscript] = useState('');
  const [agentTranscript, setAgentTranscript] = useState('');
  const [isConnected, setIsConnected] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const optionsRef = useRef(options);
  const agentTranscriptRef = useRef('');
  const toolExecutionRef = useRef(0);
  const pendingCallsRef = useRef<Map<string, PendingFunctionCall>>(new Map());
  const handledCallIdsRef = useRef<Set<string>>(new Set());
  const hasSyncedSessionRef = useRef(false);
  const lastAgentTurnTranscriptRef = useRef('');

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const sendDataChannelEvent = useCallback((payload: Record<string, unknown>) => {
    if (dcRef.current?.readyState === 'open') {
      dcRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const syncSessionConfig = useCallback(() => {
    if (dcRef.current?.readyState !== 'open') {
      return;
    }
    sendDataChannelEvent(buildSessionUpdate(optionsRef.current));
    hasSyncedSessionRef.current = true;
  }, [sendDataChannelEvent]);

  useEffect(() => {
    if (!hasSyncedSessionRef.current) {
      return;
    }
    if (dcRef.current?.readyState !== 'open') {
      return;
    }
    if ((options.tools?.length ?? 0) === 0) {
      return;
    }
    sendDataChannelEvent(buildSessionUpdate(optionsRef.current));
  }, [options.tools?.length, sendDataChannelEvent]);

  const submitToolResult = useCallback(
    (callId: string, output: string) => {
      sendDataChannelEvent({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output,
        },
      });
      sendDataChannelEvent({
        type: 'response.create',
        response: {
          output_modalities: ['audio'],
        },
      });
    },
    [sendDataChannelEvent],
  );

  const executeFunctionCall = useCallback((functionCall: RealtimeFunctionCallItem) => {
    const callId = functionCall.call_id;
    const name = functionCall.name;
    if (!callId || !name || handledCallIdsRef.current.has(callId)) {
      return;
    }

    handledCallIdsRef.current.add(callId);
    console.info('[RealtimeVoice] Executing tool call', { name, callId });
    optionsRef.current.onToolCallStart?.(name, callId);
    void handleFunctionCallsRef.current([functionCall]);
  }, []);

  const cleanup = useCallback(() => {
    dcRef.current?.close();
    dcRef.current = null;

    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
      remoteAudioRef.current = null;
    }

    setIsConnected(false);
  }, []);

  const handleFunctionCalls = useCallback(
    async (functionCalls: RealtimeFunctionCallItem[]) => {
      const onToolCall = optionsRef.current.onToolCall;
      if (!onToolCall || functionCalls.length === 0) {
        return;
      }

      toolExecutionRef.current += 1;
      setStatus('processing');

      try {
        for (const functionCall of functionCalls) {
          const callId = functionCall.call_id;
          const name = functionCall.name;
          if (!callId || !name) {
            continue;
          }

          const args = parseToolArguments(functionCall.arguments);
          let success = true;
          try {
            const output = await onToolCall(name, args, callId);
            submitToolResult(callId, output);
          } catch (err) {
            success = false;
            throw err;
          } finally {
            optionsRef.current.onToolCallEnd?.(name, callId, success);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Tool execution failed';
        setError(message);
        setStatus('error');
        optionsRef.current.onError?.(message);
      } finally {
        toolExecutionRef.current -= 1;
        if (toolExecutionRef.current <= 0) {
          toolExecutionRef.current = 0;
        }
      }
    },
    [submitToolResult],
  );

  const handleFunctionCallsRef = useRef(handleFunctionCalls);
  useEffect(() => {
    handleFunctionCallsRef.current = handleFunctionCalls;
  }, [handleFunctionCalls]);

  const handleEvent = useCallback(
    (event: RealtimeVoiceEvent) => {
      const type = event?.type ?? '';

      if (
        type.includes('function_call') ||
        type === 'response.output_item.added' ||
        type === 'response.output_item.done'
      ) {
        console.debug('[RealtimeVoice] Tool-related event', type, event);
      }

      if (type.includes('error')) {
        const message =
          typeof event.error === 'string'
            ? event.error
            : event.error?.message || 'Realtime connection error';
        setError(message);
        setStatus('error');
        optionsRef.current.onError?.(message);
        return;
      }

      if (type === 'input_audio_buffer.speech_started') {
        setUserTranscript('');
        setStatus('listening');
      }

      if (
        type === 'response.audio.delta' ||
        type === 'response.audio.started' ||
        type === 'response.output_audio.delta' ||
        type === 'response.output_audio.started'
      ) {
        setStatus('speaking');
      }

      if (
        type === 'response.done' ||
        type === 'response.audio.done' ||
        type === 'response.output_audio.done'
      ) {
        if (toolExecutionRef.current <= 0) {
          setStatus('listening');
        }
      }

      if (type === 'response.done') {
        for (const functionCall of extractFunctionCalls(event)) {
          if (functionCall.call_id && functionCall.name) {
            executeFunctionCall(functionCall);
          }
        }
      }

      if (type === 'response.output_item.added') {
        const item = event.item;
        if (item?.type === 'function_call') {
          const pending: PendingFunctionCall = {
            name: item.name,
            callId: item.call_id,
            arguments: item.arguments,
          };
          if (item.call_id) {
            pendingCallsRef.current.set(item.call_id, pending);
          }
          if (item.id) {
            pendingCallsRef.current.set(item.id, pending);
          }
        }
      }

      if (type === 'response.output_item.done') {
        const item = event.item;
        if (item?.type === 'function_call' && item.call_id && item.name) {
          executeFunctionCall(
            toFunctionCallItem(item.call_id, item.name, parseToolArguments(item.arguments)),
          );
        }
      }

      if (type === 'response.function_call_arguments.done') {
        const callId = String(event.call_id ?? '');
        const itemId = String(event.item_id ?? '');
        const pending =
          pendingCallsRef.current.get(callId) ?? pendingCallsRef.current.get(itemId);
        const name = pending?.name ?? String(event.name ?? '');
        const argsStr = String(event.arguments ?? pending?.arguments ?? '{}');
        if (callId && name) {
          executeFunctionCall(
            toFunctionCallItem(callId, name, parseToolArguments(argsStr)),
          );
        }
      }

      if (
        type === 'response.audio_transcript.delta' ||
        type === 'response.output_audio_transcript.delta'
      ) {
        const delta = String(event.delta ?? '');
        if (delta.length > 0) {
          agentTranscriptRef.current = `${agentTranscriptRef.current}${delta}`;
          setAgentTranscript((prev) => {
            const next = `${prev}${delta}`;
            optionsRef.current.onAgentTranscript?.(next);
            return next;
          });
        }
      }

      if (
        type === 'conversation.item.input_audio_transcription.delta' ||
        type === 'conversation.item.input_audio_transcript.delta'
      ) {
        const delta = String(event.delta ?? '');
        if (delta.length > 0) {
          setUserTranscript((prev) => {
            const next = `${prev}${delta}`;
            optionsRef.current.onTranscriptDelta?.(next);
            return next;
          });
        }
      }

      if (
        type === 'conversation.item.input_audio_transcription.completed' ||
        type === 'conversation.item.input_audio_transcript.completed'
      ) {
        const text = String(event.transcript ?? event.text ?? '').trim();
        if (text.length > 0) {
          setUserTranscript(text);
          optionsRef.current.onTranscriptDelta?.(text);
          optionsRef.current.onUserTurnComplete?.(text);
        }
      }

      if (
        (type === 'response.audio_transcript.done' ||
          type === 'response.output_audio_transcript.done') &&
        event.truncated === true
      ) {
        setStatus('interrupted');
        setAgentTranscript('');
        agentTranscriptRef.current = '';
        optionsRef.current.onInterrupted?.();
      }

      if (
        type === 'response.audio_transcript.done' ||
        type === 'response.output_audio_transcript.done'
      ) {
        if (event.truncated !== true) {
          const completedTranscript = agentTranscriptRef.current.trim();
          if (
            completedTranscript.length > 0 &&
            completedTranscript !== lastAgentTurnTranscriptRef.current
          ) {
            lastAgentTurnTranscriptRef.current = completedTranscript;
            optionsRef.current.onAgentTurnComplete?.(completedTranscript);
          }
          setAgentTranscript('');
          agentTranscriptRef.current = '';
        }
      }
    },
    [executeFunctionCall],
  );

  const connect = useCallback(async () => {
    if (pcRef.current) {
      return;
    }
    if (!token) {
      setError('Please log in to use Realtime voice');
      setStatus('error');
      return;
    }

    setError(null);
    setStatus('connecting');
    setUserTranscript('');
    setAgentTranscript('');
    agentTranscriptRef.current = '';
    pendingCallsRef.current.clear();
    handledCallIdsRef.current.clear();
    hasSyncedSessionRef.current = false;
    lastAgentTurnTranscriptRef.current = '';

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      localStreamRef.current = stream;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const remoteAudio = new Audio();
      remoteAudio.autoplay = true;
      remoteAudioRef.current = remoteAudio;

      pc.ontrack = (event) => {
        remoteAudio.srcObject = event.streams[0];
        void remoteAudio.play().catch(() => undefined);
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === 'connected') {
          setIsConnected(true);
          setStatus('listening');
        } else if (state === 'failed' || state === 'closed' || state === 'disconnected') {
          setIsConnected(false);
          if (state === 'failed') {
            setError('WebRTC connection failed. Check your network or try again.');
            setStatus('error');
          } else if (state !== 'closed') {
            setStatus('ended');
            optionsRef.current.onEnded?.();
          }
        }
      };

      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;

      dc.onmessage = (event) => {
        const payload = parseMessageData(String(event.data ?? ''));
        if (payload) {
          handleEvent(payload);
        }
      };

      dc.onopen = () => {
        syncSessionConfig();
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const response = await fetch('/api/realtime/session', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          sdp: offer.sdp,
          model: optionsRef.current.model,
          voice: optionsRef.current.voice,
          instructions: optionsRef.current.instructions,
          tools: getSessionTools(optionsRef.current),
        }),
      });

      const responseText = await response.text();

      if (!response.ok) {
        let errMsg = 'Failed to create realtime session';
        try {
          const parsed = JSON.parse(responseText) as { error?: string; details?: string };
          errMsg = parsed.details || parsed.error || responseText || errMsg;
        } catch {
          errMsg = responseText || errMsg;
        }
        throw new Error(errMsg);
      }

      let data: { sdp?: string; error?: string };
      try {
        data = JSON.parse(responseText) as { sdp?: string; error?: string };
      } catch {
        throw new Error('Invalid response from realtime session');
      }
      if (!data?.sdp) {
        throw new Error(data?.error || 'Missing SDP answer from realtime session');
      }

      await pc.setRemoteDescription({
        type: 'answer',
        sdp: data.sdp,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start realtime voice';
      setError(message);
      setStatus('error');
      optionsRef.current.onError?.(message);
      cleanup();
    }
  }, [cleanup, handleEvent, syncSessionConfig, token]);

  const disconnect = useCallback(() => {
    cleanup();
    setStatus('ended');
    optionsRef.current.onEnded?.();
  }, [cleanup]);

  const interrupt = useCallback(() => {
    if (dcRef.current?.readyState === 'open') {
      dcRef.current.send(JSON.stringify({ type: 'response.cancel' }));
    }
    setStatus('interrupted');
    optionsRef.current.onInterrupted?.();
  }, []);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    status,
    error,
    userTranscript,
    agentTranscript,
    isConnected,
    connect,
    disconnect,
    interrupt,
    submitToolResult,
  };
}
