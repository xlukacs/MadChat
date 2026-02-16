import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthContext } from '~/hooks/AuthContext';

export type RealtimeVoiceStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'interrupted'
  | 'ended'
  | 'error';

type RealtimeVoiceEvent = {
  type?: string;
  transcript?: string;
  delta?: string;
  text?: string;
  truncated?: boolean;
  error?: { message?: string } | string;
  [key: string]: unknown;
};

type UseRealtimeVoiceOptions = {
  model?: string;
  voice?: string;
  instructions?: string;
  onTranscriptDelta?: (text: string) => void;
  onAgentTranscript?: (text: string) => void;
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

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

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

  const handleEvent = useCallback(
    (event: RealtimeVoiceEvent) => {
      const type = event?.type ?? '';

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
        setStatus('listening');
      }

      if (
        type === 'response.audio_transcript.delta' ||
        type === 'response.output_audio_transcript.delta'
      ) {
        const delta = String(event.delta ?? '');
        if (delta.length > 0) {
          setAgentTranscript((prev) => {
            const next = `${prev}${delta}`;
            optionsRef.current.onAgentTranscript?.(next);
            return next;
          });
        }
      }

      if (type === 'conversation.item.input_audio_transcription.delta') {
        const delta = String(event.delta ?? '');
        if (delta.length > 0) {
          setUserTranscript((prev) => {
            const next = `${prev}${delta}`;
            optionsRef.current.onTranscriptDelta?.(next);
            return next;
          });
        }
      }

      if (type === 'conversation.item.input_audio_transcription.completed') {
        const text = String(event.transcript ?? event.text ?? '').trim();
        if (text.length > 0) {
          setUserTranscript(text);
          optionsRef.current.onTranscriptDelta?.(text);
        }
      }

      if (
        (type === 'response.audio_transcript.done' ||
          type === 'response.output_audio_transcript.done') &&
        event.truncated === true
      ) {
        setStatus('interrupted');
        optionsRef.current.onInterrupted?.();
      }
    },
    [],
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
        const sessionUpdate = {
          type: 'session.update',
          session: {
            type: 'realtime',
            model: optionsRef.current.model,
            audio: {
              output: {
                voice: optionsRef.current.voice,
              },
            },
            instructions: optionsRef.current.instructions,
            turn_detection: {
              type: 'server_vad',
            },
          },
        };
        dc.send(JSON.stringify(sessionUpdate));
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
  }, [cleanup, handleEvent, token]);

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
  };
}
