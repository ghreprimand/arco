import { useCallback, useEffect, useRef, useState } from 'react';
import { VOICE_OUTPUT_OPTIONS, type VoiceOutputId } from '@arco/shared';
import { useVoiceStore } from '../voice/store';

const control: React.CSSProperties = {
  background: 'var(--color-bg-panel)', color: 'var(--color-accent-primary)',
  border: '1px solid var(--color-border-hairline)', padding: '5px 9px',
  fontSize: 11, fontFamily: 'var(--font-display)',
};

const accents = [...new Set(VOICE_OUTPUT_OPTIONS.map((v) => v.accent))];

export function VoiceOutputPicker({ previewLive }: { previewLive: () => void }) {
  const voice = useVoiceStore((s) => s.outputVoice);
  const setVoice = useVoiceStore((s) => s.setOutputVoice);
  const enabled = useVoiceStore((s) => s.enabled);
  const phase = useVoiceStore((s) => s.phase);
  const capturing = useVoiceStore((s) => s.commandText !== null);
  const [defaultVoice, setDefaultVoice] = useState('');
  const [status, setStatus] = useState<'idle' | 'preparing' | 'playing'>('idle');
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const audioUrl = useRef<string | null>(null);
  const stop = useCallback(() => {
    request.current?.abort(); request.current = null;
    if (player.current) {
      player.current.onended = null; player.current.onerror = null;
      player.current.pause(); player.current.removeAttribute('src'); player.current.load(); player.current = null;
    }
    if (audioUrl.current) { URL.revokeObjectURL(audioUrl.current); audioUrl.current = null; }
    setStatus('idle');
  }, []);
  // An off-mic sample must end before hands-free capture starts. Live samples
  // instead use runtime.speak so normal echo/barge-in handling stays intact.
  useEffect(() => { setError(''); return stop; }, [stop, voice, enabled]);
  useEffect(() => {
    const abort = new AbortController();
    void fetch('/api/voice/status', { signal: abort.signal }).then((r) => r.ok ? r.json() : null)
      .then((s) => { if (!abort.signal.aborted && typeof s?.defaultVoice === 'string') setDefaultVoice(s.defaultVoice); }).catch(() => {});
    return () => abort.abort();
  }, []);
  const preview = async () => {
    if (status !== 'idle') { stop(); return; }
    setError('');
    if (enabled) { previewLive(); return; }
    const abort = new AbortController(); request.current = abort;
    setStatus('preparing');
    try {
      const response = await fetch('/api/voice/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(voice ? { voice } : {}), signal: abort.signal });
      if (!response.ok) throw new Error('Voice sample unavailable. Try again when connected.');
      const blob = await response.blob();
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(blob); audioUrl.current = url;
      const audio = new Audio(url); player.current = audio;
      audio.onended = stop;
      audio.onerror = () => { stop(); setError('Could not play the voice sample.'); };
      await audio.play();
      if (!abort.signal.aborted) setStatus('playing');
    } catch (e) {
      if (!abort.signal.aborted) { stop(); setError(e instanceof Error ? e.message : 'Voice sample failed.'); }
    }
  };
  const defaultOption = VOICE_OUTPUT_OPTIONS.find((v) => v.id === defaultVoice);
  const defaultName = defaultOption ? `${defaultOption.name} · ${defaultOption.accent}` : defaultVoice;
  return <div data-help="voice.output" style={{ margin: '10px 0' }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <label>Reply voice <select aria-label="Computer reply voice" style={control} value={voice ?? ''}
        onChange={(e) => setVoice((e.target.value || null) as VoiceOutputId | null)}>
        <option value="">System default{defaultName ? ` · ${defaultName}` : ''}</option>
        {accents.map((accent) => <optgroup key={accent} label={accent}>
          {VOICE_OUTPUT_OPTIONS.filter((v) => v.accent === accent).map((v) =>
            <option key={v.id} value={v.id}>{v.name} · {v.accent}</option>)}
        </optgroup>)}
      </select></label>
      <button style={{ ...control, cursor: 'pointer' }} disabled={enabled && (phase !== 'listening' || capturing)}
        title={enabled && (phase !== 'listening' || capturing) ? 'Finish the current speech or capture before auditioning.' : 'Play a short sample without a model call.'}
        onClick={() => void preview()}>{status === 'preparing' ? 'CANCEL SAMPLE' : status === 'playing' ? 'STOP SAMPLE' : 'LISTEN'}</button>
      <span style={{ color: 'var(--color-fg-muted)' }}>Saved for this browser. Applies to the next reply.</span>
    </div>
    <div role="status" style={{ color: 'var(--color-fg-muted)' }}>{status === 'preparing' ? 'Preparing voice sample…' : ''}</div>
    {error && <div role="alert" style={{ color: 'var(--color-danger)' }}>{error}</div>}
  </div>;
}
