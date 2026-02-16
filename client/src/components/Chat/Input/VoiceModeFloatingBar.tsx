import { memo } from 'react';
import { Mic, Volume2, Loader2, PhoneOff } from 'lucide-react';
import { useLocalize } from '~/hooks';
import type { VoiceCallStatus } from '~/store/voiceChat';
import { cn } from '~/utils';

interface VoiceModeFloatingBarProps {
  status: VoiceCallStatus;
  onEndCall: () => void;
  children?: React.ReactNode;
}

function VoiceModeFloatingBar({ status, onEndCall, children }: VoiceModeFloatingBarProps) {
  const localize = useLocalize();

  const statusConfig: Record<VoiceCallStatus, { label: string; icon: React.ReactNode }> = {
    idle: {
      label: localize('com_ui_voice_status_idle'),
      icon: <Mic className="size-5 shrink-0" aria-hidden />,
    },
    listening: {
      label: localize('com_ui_voice_status_listening'),
      icon: <Mic className="size-5 shrink-0 animate-pulse" aria-hidden />,
    },
    processing: {
      label: localize('com_ui_voice_status_processing'),
      icon: <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden />,
    },
    speaking: {
      label: localize('com_ui_voice_status_speaking'),
      icon: <Volume2 className="size-5 shrink-0" aria-hidden />,
    },
  };

  const config = statusConfig[status];

  return (
    <div
      className={cn(
        'fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-full border px-5 py-3 shadow-lg backdrop-blur-sm',
        'border-emerald-800/60 bg-emerald-950/80 dark:bg-emerald-950/90',
      )}
      role="status"
      aria-live="polite"
      aria-label={config.label}
    >
      <div className="flex items-center gap-2 text-emerald-100">
        {config.icon}
        <span className="text-sm font-medium">{config.label}</span>
      </div>
      <div className="flex items-center gap-2">{children}</div>
      <button
        type="button"
        onClick={onEndCall}
        aria-label={localize('com_ui_voice_end_call')}
        className={cn(
          'flex size-10 items-center justify-center rounded-full transition-colors',
          'bg-red-600/80 text-white hover:bg-red-600',
        )}
      >
        <PhoneOff className="size-5" aria-hidden />
      </button>
    </div>
  );
}

export default memo(VoiceModeFloatingBar);
