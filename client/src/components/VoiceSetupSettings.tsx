import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { downsampleToPcm16, meterPercent, openSetupMic, peakLevel, SETUP_PHRASE_SECONDS, type MicCapture } from '../voice/setupAudio';

// Settings -> VOICE SETUP (P3.5). Shows what `npm run voice:setup` installed
// under the voice home, runs it with a live log, tests the microphone level
// and round-trips one phrase through the local recognizer. The microphone is
// open only while a test runs; every track is released when it ends.

export interface VoiceSetupStatus {
  deployment: 'docker' | 'host';
  platform: string;
  voiceHome: string;
  voiceHomeFromEnv: boolean;
  uv: { found: boolean; version: string | null };
  python: { found: boolean; version: string | null };
  packages: Array<{ name: string; version: string | null }>;
  models: Array<{ name: string; title: string; size: string; installed: boolean; applies: boolean }>;
  ready: boolean;
  notices: boolean;
  install: { running: boolean; exitCode: number | null; startedAt: number | null; finishedAt: number | null; log: string };
}

// An older or foreign server can answer this path with another shape; the
// section then reports the status as unavailable instead of failing to render.
export function isVoiceSetupStatus(value: unknown): value is VoiceSetupStatus {
  const v = value as Partial<VoiceSetupStatus> | null;
  return !!v && typeof v === 'object' && typeof v.voiceHome === 'string' && !!v.install && typeof v.install === 'object'
    && !!v.uv && !!v.python && Array.isArray(v.packages) && Array.isArray(v.models);
}

export function voiceSetupSummary(s: VoiceSetupStatus): string {
  if (s.deployment === 'docker') return 'Voice needs the native run. The Docker image has no microphone access or speech runtime; start Arco natively (npm run dev or npm start) to use voice.';
  if (s.install.running) return 'Installing local speech. Downloads total about 1 GB on first install.';
  if (s.ready) return 'Local speech is installed. Test the microphone, then say a phrase to check recognition.';
  if (!s.uv.found) return 'Install uv first; voice setup uses it to provide Python 3.12. Then choose Install.';
  return 'Local speech is not installed. Install downloads the speech runtime and models into the voice home.';
}

const label: CSSProperties = { fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' };
const note: CSSProperties = { fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 };
const mono: CSSProperties = { fontFamily: 'var(--font-code)', fontSize: '11px' };
const button = (active: boolean): CSSProperties => ({
  background: 'none', border: '1px solid var(--color-border-hairline)', borderRadius: '3px',
  color: active ? 'var(--color-accent-secondary)' : 'var(--color-fg-muted)', cursor: active ? 'pointer' : 'not-allowed',
  fontSize: '10px', letterSpacing: '1px', padding: '5px 10px', whiteSpace: 'nowrap',
});
const pre: CSSProperties = { ...mono, fontSize: '10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '220px', overflowY: 'auto', margin: '0 0 8px', padding: '6px 10px', background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)', borderRadius: '4px' };

type Mic = 'off' | 'meter' | 'phrase' | 'recognizing';

export function VoiceSetupSettings() {
  const [status, setStatus] = useState<VoiceSetupStatus | null>(null);
  const [error, setError] = useState('');
  const [mic, setMic] = useState<Mic>('off');
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState<{ text: string; detail: string } | null>(null);
  const [notices, setNotices] = useState<string | null>(null);
  const capture = useRef<MicCapture | null>(null);
  const frames = useRef<Float32Array[]>([]);
  const phraseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);
  const headingId = useId();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/voice/setup');
      const data = await res.json() as VoiceSetupStatus & { error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!isVoiceSetupStatus(data)) throw new Error('unexpected response from this server.');
      setStatus(data);
    } catch (e) { setError(`Voice status unavailable: ${e instanceof Error ? e.message : String(e)}`); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  const running = status?.install.running === true;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { void refresh(); }, 1000);
    return () => clearInterval(timer);
  }, [running, refresh]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [status?.install.log]);

  const closeMic = useCallback(() => {
    if (phraseTimer.current) { clearTimeout(phraseTimer.current); phraseTimer.current = null; }
    capture.current?.stop(); capture.current = null; setLevel(0);
  }, []);
  useEffect(() => closeMic, [closeMic]);

  async function post(path: string) {
    setError('');
    try {
      const res = await fetch(path, { method: 'POST' });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) setError(data.error || `HTTP ${res.status}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    void refresh();
  }

  async function startMeter() {
    setError(''); setHeard(null);
    try {
      capture.current = await openSetupMic((f) => setLevel(peakLevel(f)));
      setMic('meter');
    } catch (e) { closeMic(); setMic('off'); setError(`Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`); }
  }

  async function finishPhrase() {
    const cap = capture.current;
    if (!cap) return;
    const rate = cap.rate; const chunks = frames.current; frames.current = [];
    closeMic(); setMic('recognizing');
    const pcm = downsampleToPcm16(chunks, rate);
    try {
      const res = await fetch('/api/voice/setup/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm.buffer as ArrayBuffer });
      const data = await res.json() as { text?: string; ms?: number; recognizer?: string; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setHeard({ text: data.text ?? '', detail: `${data.recognizer ?? 'Local recognizer'}, ${((data.ms ?? 0) / 1000).toFixed(1)} s` });
    } catch (e) { setError(`Recognition failed: ${e instanceof Error ? e.message : String(e)}`); }
    setMic('off');
  }

  async function startPhrase() {
    setError(''); setHeard(null); frames.current = [];
    try {
      capture.current = await openSetupMic((f) => { frames.current.push(f); setLevel(peakLevel(f)); });
      setMic('phrase');
      phraseTimer.current = setTimeout(() => { void finishPhrase(); }, SETUP_PHRASE_SECONDS * 1000);
    } catch (e) { closeMic(); setMic('off'); setError(`Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`); }
  }

  const stopMic = () => { if (mic === 'phrase') void finishPhrase(); else { closeMic(); setMic('off'); } };

  async function toggleNotices() {
    if (notices !== null) { setNotices(null); return; }
    try {
      const res = await fetch('/api/voice/setup/notices');
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${res.status}`);
      setNotices(await res.text());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  const docker = status?.deployment === 'docker';
  const canTest = !!status && status.ready && !running && !docker;
  const meter = meterPercent(level);

  return (
    <section data-help="settings.voice-setup" aria-labelledby={headingId} style={{ marginBottom: '14px' }}>
      <div id={headingId} className="display-font" style={label}>VOICE SETUP</div>
      {!status && !error && <p style={note}>Checking local speech...</p>}
      {status && <p data-voice-setup-state={docker ? 'docker' : running ? 'installing' : status.ready ? 'ready' : 'missing'} style={{ ...note, margin: '0 0 8px', color: status.ready || docker ? 'var(--color-fg-muted)' : 'var(--color-warning)' }}>{voiceSetupSummary(status)}</p>}
      {status && !docker && (
        <>
          <dl aria-label="Voice components" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '3px 12px', margin: '0 0 8px', fontSize: '10px', fontFamily: 'var(--font-body)' }}>
            <dt style={note}>Voice home</dt>
            <dd style={{ ...mono, margin: 0, wordBreak: 'break-all' }}>{status.voiceHome}<span style={note}>{status.voiceHomeFromEnv ? ' (from ARCO_VOICE_HOME)' : ' (set ARCO_VOICE_HOME to move it)'}</span></dd>
            <dt style={note}>uv</dt>
            <dd style={{ ...mono, margin: 0 }}>{status.uv.found ? `found ${status.uv.version ?? ''}` : <>not found, see <a href="https://docs.astral.sh/uv/getting-started/installation/" target="_blank" rel="noreferrer">uv installation</a></>}</dd>
            <dt style={note}>Python</dt>
            <dd style={{ ...mono, margin: 0 }}>{status.python.found ? `voice environment, Python ${status.python.version ?? 'unknown'}` : 'not installed (uv provides Python 3.12)'}</dd>
            {status.packages.map((p) => (<FragmentRow key={p.name} name={p.name} value={p.version ? p.version : 'missing'} ok={!!p.version} />))}
            {status.models.map((m) => (<FragmentRow key={m.name} name={m.title} value={!m.applies ? 'not used on this platform' : m.installed ? `installed (${m.name})` : `missing, ${m.size}`} ok={m.installed || !m.applies} />))}
          </dl>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
            {running
              ? <button type="button" className="display-font" style={button(true)} onClick={() => void post('/api/voice/setup/cancel')}>CANCEL INSTALL</button>
              : <button type="button" className="display-font" style={button(mic === 'off')} disabled={mic !== 'off'} onClick={() => void post('/api/voice/setup/install')}>{status.ready ? 'REINSTALL / REPAIR' : 'INSTALL'}</button>}
            {mic === 'meter' || mic === 'phrase'
              ? <button type="button" className="display-font" style={button(true)} onClick={stopMic}>{mic === 'phrase' ? 'STOP AND RECOGNIZE' : 'STOP MICROPHONE'}</button>
              : <>
                  <button type="button" className="display-font" style={button(!running && mic === 'off')} disabled={running || mic !== 'off'} onClick={() => void startMeter()}>TEST MICROPHONE</button>
                  <button type="button" className="display-font" style={button(canTest && mic === 'off')} disabled={!canTest || mic !== 'off'} onClick={() => void startPhrase()}>SAY A PHRASE</button>
                </>}
            <button type="button" className="display-font" style={button(status.notices)} disabled={!status.notices} aria-expanded={notices !== null} onClick={() => void toggleNotices()}>{notices !== null ? 'HIDE NOTICES' : 'MODEL NOTICES'}</button>
          </div>
          {(mic === 'meter' || mic === 'phrase') && (
            <div style={{ marginBottom: '8px' }}>
              <div role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={meter} style={{ height: '8px', background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ width: `${meter}%`, height: '100%', background: 'var(--color-accent-primary)', transition: 'width 80ms linear' }} />
              </div>
              <p style={{ ...note, margin: '4px 0 0' }}>{mic === 'phrase' ? `Listening for up to ${SETUP_PHRASE_SECONDS} seconds. Say a short sentence.` : 'Speak normally; the bar should move with your voice. Nothing is recorded or sent.'}</p>
            </div>
          )}
          {mic === 'recognizing' && <p role="status" style={note}>Recognizing locally...</p>}
          {heard && <p role="status" aria-label="Recognized phrase" style={{ ...note, margin: '0 0 8px' }}>Heard: <span style={{ ...mono, color: 'var(--color-accent-primary)' }}>{heard.text || '(nothing recognized; try again closer to the microphone)'}</span> <span>({heard.detail})</span></p>}
          {(running || status.install.log) && <pre ref={logRef} aria-label="Voice setup log" style={pre}>{status.install.log}</pre>}
          {notices !== null && <pre aria-label="Voice model notices" style={pre}>{notices}</pre>}
        </>
      )}
      {error && <div role="alert" style={{ color: 'var(--color-warning)', fontSize: '10px', fontFamily: 'var(--font-body)', marginBottom: '6px' }}>{error}</div>}
    </section>
  );
}

function FragmentRow({ name, value, ok }: { name: string; value: string; ok: boolean }) {
  return (<>
    <dt style={note}>{name}</dt>
    <dd style={{ ...mono, margin: 0, color: ok ? undefined : 'var(--color-warning)' }}>{value}</dd>
  </>);
}
