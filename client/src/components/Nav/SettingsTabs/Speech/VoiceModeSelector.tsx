import { useRecoilState } from 'recoil';
import { useLocalize } from '~/hooks';
import store from '~/store';
import { useEffect } from 'react';

export default function VoiceModeSelector({
  realtimeEnabled,
}: {
  realtimeEnabled: boolean;
}) {
  const localize = useLocalize();
  const [voiceMode, setVoiceMode] = useRecoilState(store.voiceMode);

  useEffect(() => {
    if (!realtimeEnabled && voiceMode === 'realtime') {
      setVoiceMode('legacy');
    }
  }, [realtimeEnabled, setVoiceMode, voiceMode]);

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="voice-mode-selector" className="text-sm font-medium text-text-primary">
        {localize('com_ui_voice_mode')}
      </label>
      <select
        id="voice-mode-selector"
        value={voiceMode}
        onChange={(e) => setVoiceMode(e.target.value as 'legacy' | 'realtime')}
        className="rounded-md border border-border-medium bg-transparent px-3 py-2 text-sm text-text-primary"
      >
        <option value="legacy">{localize('com_ui_voice_mode_legacy')}</option>
        <option value="realtime" disabled={!realtimeEnabled}>
          {localize('com_ui_voice_mode_realtime')}
        </option>
      </select>
      {!realtimeEnabled && (
        <p className="text-xs text-text-secondary">
          {localize('com_ui_voice_mode_realtime_unavailable')}
        </p>
      )}
    </div>
  );
}
