import { createRoot } from 'react-dom/client';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ClientMessage, ProviderName } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { ChatPanel } from '../components/ChatPanel';
import { ChatMessage } from '../components/ChatMessage';
import { TokenBadge } from '../components/TokenBadge';
import { DiffView } from '../components/diff/DiffView';
import { ThemedBackgroundShader } from '../components/ThemedBackgroundShader';
import { applyTheme, applyCrispText } from '../themes/apply';
import { CLASSIC_THEME_REGISTRY as THEME_REGISTRY } from '../themes/registry';
import { resolveProviderTheme } from '../themes/providerThemes';
import { FONT_PACKS } from '../themes/fontPacks';
import { Ambient } from './Ambient';
import { phosphorEmission } from './emission';
import { PHOSPHOR_PREFIX, phosphorTheme } from './paletteAdapter';
import { arcoThemes, themeCategories } from './arco-palette';
import { files, history, recent, patch, streamText } from './fixtures';
import '../styles/global.css';
import '../styles/matrix.css';
import './demo.css';

const ID = 'demo-review';
const tokens = { input: 48210, output: 3912, cacheRead: 39100, cacheCreate: 1240 };
const store = useAppStore.getState();
store.createJob(ID, { name: 'Phosphor presentation', primaryProvider: 'claude', primaryModel: 'claude-opus-4-6', primaryEffort: 'high', skipPermissions: false, workingDirectory: '/demo/Arco' });
useAppStore.setState(s => ({ jobs: { ...s.jobs, [ID]: { ...s.jobs[ID], messages: [...history, ...recent], totalTokens: tokens, totalCost: 1.284, busy: false } } }));
store.setWsSendRaw(raw => {
  const msg = raw as ClientMessage;
  if (msg.type === 'gate_reply') useAppStore.getState().resolveGate(ID, msg.gateId, { status: msg.decision, wasEdited: !!msg.finalArgs });
  window.dispatchEvent(new CustomEvent('demo:notice', { detail: `${msg.type} · simulated locally` }));
});

type Panel = 'PLAN' | 'FILES' | 'TASKS' | 'ACTIVITY' | 'REVIEW' | 'PREVIEW' | 'USAGE';
type Family = 'phosphor' | 'classic';
const panelGroups: [string, Panel[]][] = [['WORKSPACE', ['FILES']], ['AGENT', ['ACTIVITY', 'REVIEW', 'PLAN', 'TASKS']], ['MEMORY', ['USAGE']], ['RUNTIME', ['PREVIEW']]];
const taskSeed = [
  { title: 'Inventory presentation surfaces', state: 'done', owner: 'PRIMARY', path: 'docs/PRESENTATION_REVIEW.md' },
  { title: 'Adapt palette roles and contrast', state: 'done', owner: 'PRIMARY', path: 'client/src/themes/apply.ts' },
  { title: 'Inspect code, diff and ANSI states', state: 'review', owner: 'OPERATOR', path: 'artifacts/review-017.md' },
  { title: 'Keyboard, reduced motion and zoom', state: 'active', owner: 'PRIMARY', path: 'docs/PRESENTATION_REVIEW.md' },
  { title: 'Approve broader rollout', state: 'blocked', owner: 'OPERATOR', path: 'docs/PRESENTATION_REVIEW.md' },
];
function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return <section className="demo-section"><header className="section-heading"><span>{title}</span>{aside}</header><div className="section-body">{children}</div></section>;
}
// Streaming updates only the transcript, not the palette catalog or workbench.
const Transcript = memo(function Transcript({ presentation }: { presentation: 'chat' | 'workbench' }) {
  const job = useAppStore(s => s.jobs[ID]);
  return <ChatPanel job={job} presentation={presentation} />;
});
function TranscriptSearch() {
  const job = useAppStore(s => s.jobs[ID]);
  const [query, setQuery] = useState('');
  const matches = job.messages.filter(m => JSON.stringify(m).toLowerCase().includes(query.toLowerCase()));
  return <><label>Search all {job.messages.length} messages<input autoFocus type="search" aria-label="Search transcript" value={query} onChange={e => setQuery(e.target.value)} placeholder="Message text, code or tool arguments…" /></label><div className="transcript-results">{matches.map(m => <details key={m.id}><summary>{new Date(m.timestamp).toLocaleTimeString()} · {m.role.toUpperCase()} · {m.toolUse?.tool ?? m.content.split('\n')[0]}</summary><pre>{m.toolUse ? JSON.stringify(m.toolUse, null, 2) : m.content}</pre></details>)}</div></>;
}
function Dialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    // CSS zoom leaves vh in the unzoomed coordinate space in Chromium.
    // Bound the top-layer dialog to its actual available CSS pixels as well.
    const fit = () => {
      const zoom = Number(getComputedStyle(document.body).zoom) || 1;
      dialog.style.maxHeight = `${innerHeight / zoom - 24}px`;
      dialog.style.maxWidth = `${innerWidth / zoom - 24}px`;
    };
    fit(); dialog.showModal();
    const observer = new ResizeObserver(fit); observer.observe(document.body);
    window.addEventListener('resize', fit);
    return () => { observer.disconnect(); window.removeEventListener('resize', fit); dialog.close(); };
  }, []);
  return <dialog ref={ref} className="demo-dialog" onCancel={close} onClick={e => { if (e.target === e.currentTarget) close(); }} aria-label={title}>
    <header className="section-heading"><h2>{title}</h2><button onClick={close} aria-label="Close dialog">×</button></header><div className="dialog-body">{children}</div>
  </dialog>;
}
function Demo() {
  const [family, setFamily] = useState<Family>('phosphor');
  const [phosphor, setPhosphor] = useState(PHOSPHOR_PREFIX + 'arco-crt');
  const [classic, setClassic] = useState('matrix');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [effects, setEffects] = useState(true);
  const [density, setDensity] = useState('compact');
  const [crisp, setCrisp] = useState(localStorage.getItem('arco_crisp_text') === '1');
  const [font, setFont] = useState(localStorage.getItem('arco_font_pack_override') ?? '');
  const [brightness, setBrightness] = useState(0);
  const [backgroundBrightness, setBackgroundBrightness] = useState(0);
  const [softness, setSoftness] = useState(50);
  const [frost, setFrost] = useState<'on' | 'off' | undefined>(undefined);
  const [provider, setProvider] = useState<ProviderName>('claude');
  const [panel, setPanel] = useState<Panel>('PLAN');
  const [split, setSplit] = useState(62);
  const [screen, setScreen] = useState('Presentation review');
  const [settings, setSettings] = useState(false);
  const [modal, setModal] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState('Check the remaining contrast findings, then keep the preview open for review.');
  const [attachments, setAttachments] = useState(['PRESENTATION_REVIEW.md · 1.4 KB', 'review-017.md · 824 B']);
  const [tasks, setTasks] = useState(taskSeed);
  const [file, setFile] = useState('client/src/themes/apply.ts');
  const [fileMode, setFileMode] = useState('CHANGES');
  const [streaming, setStreaming] = useState(false);
  const [terminal, setTerminal] = useState(true);
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalExtra, setTerminalExtra] = useState<string[]>([]);
  const [viewWidth, setViewWidth] = useState('100%');
  const [queue, setQueue] = useState<string[]>(['FOLLOW-UP · Compare amber after the keyboard pass']);
  const [showNav, setShowNav] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(matchMedia('(prefers-reduced-motion: reduce)').matches);
  const splitRef = useRef<HTMLDivElement>(null);
  const lastThemeKeys = useRef<string[]>([]);
  const selectedId = family === 'phosphor' ? phosphor : classic;
  const selection = useMemo(() => family === 'phosphor' ? phosphorTheme(phosphor) : classic === 'provider-auto' ? resolveProviderTheme(provider) : THEME_REGISTRY[classic], [family, phosphor, classic, provider]);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReducedMotion(media.matches);
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    for (const key of lastThemeKeys.current) root.style.removeProperty(`--${key}`);
    lastThemeKeys.current = Object.keys(selection.tokens);
    root.dataset.family = family; root.dataset.demoEffects = effects ? 'on' : 'off'; root.dataset.density = density;
    root.dataset.phosphorEffects = effects ? 'on' : 'off';
    applyCrispText(crisp);
    // No setSettings/setThemeId: those actions persist through the real settings API.
    applyTheme(selection, font, family === 'classic' ? frost : 'off', undefined, { bg: backgroundBrightness, text: brightness });
    useAppStore.setState(s => ({ settings: { ...s.settings, themeId: classic } as NonNullable<typeof s.settings> }));
  }, [selectedId, family, effects, density, crisp, font, frost, brightness, backgroundBrightness, provider]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.phosphorSoftness = String(softness);
    if (family === 'phosphor') root.style.setProperty('--phosphor-text', phosphorEmission(softness));
    else root.style.removeProperty('--phosphor-text');
    return () => { root.style.removeProperty('--phosphor-text'); };
  }, [family, softness]);
  useEffect(() => {
    const handler = (e: Event) => setNotice((e as CustomEvent<string>).detail);
    window.addEventListener('demo:notice', handler); return () => window.removeEventListener('demo:notice', handler);
  }, []);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(t); }, [notice]);
  useEffect(() => {
    if (!streaming) return;
    let n = 0;
    const id = 'fixture-stream';
    const current = useAppStore.getState();
    if (current.jobs[ID].messages.some(m => m.id === id)) current.removeMessage(ID, id);
    current.addMessage(ID, { id, role: 'assistant', content: '', isStreaming: true, timestamp: Date.parse('2026-09-07T19:35:00Z') });
    const t = setInterval(() => {
      if (document.hidden) return;
      n += 5;
      useAppStore.getState().updateMessage(ID, id, { content: streamText.slice(0, n), isStreaming: n < streamText.length });
      if (n >= streamText.length) setStreaming(false);
    }, 90);
    return () => { clearInterval(t); useAppStore.getState().updateMessage(ID, id, { isStreaming: false }); };
  }, [streaming]);

  const openFile = (name: string) => { setFile(name); setFileMode('SOURCE'); setPanel('FILES'); };
  const simulated = (action: string) => setNotice(`${action} · simulated in this preview`);
  const send = (kind = 'STEER') => {
    if (!draft.trim()) return;
    if (streaming) setQueue(q => [...q, `${kind} · ${draft}`]);
    else useAppStore.getState().addMessage(ID, { id: crypto.randomUUID(), role: 'user', content: draft, timestamp: Date.now(), isStreaming: false });
    setDraft(''); simulated(streaming ? 'Queued prompt' : 'Prompt added');
  };
  const options = family === 'phosphor' ? arcoThemes.map(t => ({ id: PHOSPHOR_PREFIX + t.id, name: t.name, category: t.category })) : Object.values(THEME_REGISTRY).map(t => ({ id: t.id, name: t.name, category: t.mood }));
  const filtered = options.filter(t => (category === 'All' || t.category === category) && `${t.name} ${t.id}`.toLowerCase().includes(search.toLowerCase()));

  function panelContent() {
    if (panel === 'FILES') return <>
      <nav className="demo-subnav" aria-label="File views">{['TREE', 'SOURCE', 'CHANGES'].map(v => <button key={v} aria-pressed={fileMode === v} onClick={() => setFileMode(v)}>{v}</button>)}</nav>
      <div className="demo-file-list">{Object.keys(files).map(p => <button key={p} onClick={() => { setFile(p); setFileMode('SOURCE'); }} aria-pressed={file === p}><span>{p}</span><span className="warn">{p.endsWith('.ts') ? 'M' : '·'}</span></button>)}</div>
      {fileMode === 'CHANGES' ? <DiffView patch={patch} /> : <><div className="path-label">/demo/Arco/{file}</div><ChatMessage message={{ id: `file-${file}`, role: 'assistant', content: file.endsWith('.md') ? files[file] : `\`\`\`${file.endsWith('.json') ? 'json' : 'typescript'}\n${files[file]}\n\`\`\``, timestamp: 0, isStreaming: false }} /></>}
    </>;
    if (panel === 'PLAN' || panel === 'TASKS') return <>
      <Section title={panel === 'PLAN' ? 'ATTACHED PLAN / 03' : 'PROJECT TASKS / 05'} aside={<span className="good">{tasks.filter(t => t.state === 'done').length}/{tasks.length} DONE</span>}>
        <h2>Phosphor presentation</h2><p className="muted">Updated 14:31:04 · operator-owned · 5 checkpoints</p>
        <p>Introduce a shared CRT presentation without changing workflow authority, persisted choices or the information available to the operator.</p>
        <div className="progress-track"><span style={{ width: `${tasks.filter(t => t.state === 'done').length * 20}%` }} /></div>
      </Section>
      {tasks.map((task, i) => <article className="task-row" key={task.title}><label><input type="checkbox" checked={task.state === 'done'} onChange={e => setTasks(ts => ts.map((t, j) => j === i ? { ...t, state: e.target.checked ? 'done' : 'active' } : t))} /><strong>{String(i + 1).padStart(2, '0')} · {task.title}</strong></label><div><span className={`state ${task.state}`}>{task.state.toUpperCase()}</span><span className="muted">{task.owner}</span><button onClick={() => openFile(task.path)} title={task.path}>OPEN ↗</button></div></article>)}
      <Section title="ARTIFACTS / 02">{['docs/PRESENTATION_REVIEW.md', 'artifacts/review-017.md'].map(p => <button className="artifact-row" key={p} onClick={() => openFile(p)}><span>◇ {p}</span><span>↗</span></button>)}</Section>
      <div className="demo-actions"><button onClick={() => setModal('REVIEW PLAN')}>REVIEW PLAN</button><button onClick={() => setModal('HANDOFF')}>HANDOFF</button><button onClick={() => simulated('Plan detach')}>DETACH</button></div>
    </>;
    if (panel === 'REVIEW') return <><Section title="VERIFY / REVIEW 017" aside={<span className="warn">NEEDS ATTENTION</span>}><p>14:32:18 · Claude · plan scoped · 3 files</p><p>2 findings · 1 resolved · 1 open</p></Section><ChatMessage message={{ id: 'review-body', role: 'assistant', content: files['artifacts/review-017.md'], isStreaming: false, timestamp: 0 }} /><div className="demo-actions"><button onClick={() => openFile('client/src/themes/apply.ts')}>OPEN F01 ↗</button><button onClick={() => simulated('Finding resolved')}>MARK RESOLVED</button></div></>;
    if (panel === 'ACTIVITY') return <><Section title="TURN TELEMETRY" aside={<span className="good">{streaming ? 'STREAMING' : 'AWAITING INPUT'}</span>}><TokenBadge turnTokens={tokens} cumulativeOutput={18924} cumulativeTokens={tokens} showBar /><p>Elapsed 02:18 · 6 tools · $1.284 session</p></Section><table className="demo-table"><thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead><tbody>{[['14:32:18', 'REVIEW', '2 findings, VERIFY'], ['14:31:58', 'GATE', 'Bash · pending operator'], ['14:31:52', 'ERROR', 'typecheck · exit 2'], ['14:31:50', 'TOOL', 'Bash · 120000 ms timeout'], ['14:31:42', 'READ', 'apply.ts · 294 lines'], ['14:31:40', 'TURN', 'Primary turn started'], ['14:29:14', 'CONTEXT', '48,210 input · 39,100 cache read']].map(r => <tr key={r[0]}>{r.map((v, i) => <td key={i} className={v === 'ERROR' ? 'danger' : ''}>{v}</td>)}</tr>)}</tbody></table><Section title="BACKGROUND JOBS"><p>No background workers in this fixture.</p></Section></>;
    if (panel === 'USAGE') return <><Section title="USAGE / SYNTHETIC SESSION"><div className="readings"><div><strong>48.2k</strong><span>INPUT TOKENS</span></div><div><strong>81.1%</strong><span>CACHE HIT</span></div><div><strong>$1.284</strong><span>TOTAL COST</span></div></div></Section><Section title="TOKENS BY TURN / 14:20–14:35"><svg viewBox="0 0 500 160" role="img" aria-label="Input token usage across eight turns: 12, 18, 17, 29, 25, 39, 42, 48 thousand"><path d="M25 10V135H485" fill="none" stroke="var(--color-border-bright)" />{[12, 18, 17, 29, 25, 39, 42, 48].map((n, i) => <rect key={i} x={40 + i * 55} y={135 - n * 2.4} width="28" height={n * 2.4} fill={`var(--arco-chart-${i % 6 + 1}, var(--color-accent-primary))`} />)}</svg><table className="demo-table"><thead><tr><th>Turn</th><th>Input</th><th>Output</th></tr></thead><tbody>{[12, 18, 17, 29, 25, 39, 42, 48].map((n, i) => <tr key={i}><td>{i + 1}</td><td>{n},000</td><td>{(n * 73).toLocaleString()}</td></tr>)}</tbody></table></Section></>;
    return <><nav className="demo-subnav"><span className="good">● PREVIEW / FIXTURE</span>{['100%', '390px'].map(v => <button key={v} aria-pressed={viewWidth === v} onClick={() => setViewWidth(v)}>{v === '100%' ? 'FIT' : '390 PX'}</button>)}<button onClick={() => simulated('Preview refreshed')}>↻ REFRESH</button></nav><div className="preview-frame" style={{ width: viewWidth, maxWidth: '100%' }}><h2>ARCO / WORKSPACE MAP</h2><p className="muted">Synthetic configuration map · select a node</p><div className="atlas-nodes">{['OPERATOR', 'PRIMARY AGENT', 'BOUNDED TOOLS', 'PROJECT ARTIFACTS'].map((name, i) => <button key={name} onClick={() => setModal(name)}><small>0{i + 1} / {['DIRECT', 'INTERPRET', 'EXECUTE', 'REVIEW'][i]}</small><strong>{name}</strong><span>{['Prompts · approvals · preferences', 'One long-lived primary per tab', 'File access · shell · review', 'Plans · changes · evidence'][i]}</span></button>)}</div><p>Operator → primary → bounded tools → artifacts → operator review</p></div><Section title="PREVIEW HISTORY"><p>14:31 · fixture://workspace-map · manual</p><p>14:22 · fixture://presentation-review · detected</p></Section></>;
  }

  return <>
    {family === 'phosphor' && effects && <><Ambient /><div className="phosphor-fog" aria-hidden="true" /><div className="phosphor-raster" aria-hidden="true" /><div className="phosphor-glass" aria-hidden="true" /></>}
    {family === 'classic' && effects && !reducedMotion && <ThemedBackgroundShader />}
    <div className="demo-app">
      <a href="#composer" className="skip-link">Skip to composer</a>
      <header className="demo-header"><div className="demo-brand"><span className="arco-wordmark">ARCO<span className="brand-cursor"> ▌</span></span><span className="muted">MULTI-PROVIDER WORKBENCH</span></div><div className="demo-actions"><span className="demo-tag">DESIGN PREVIEW · SYNTHETIC</span><button onClick={() => setShowNav(v => !v)} aria-expanded={showNav}>PROJECTS</button><button onClick={() => setSettings(true)}>SETTINGS</button><button onClick={() => setModal('NOTIFICATIONS')}>NOTICES <span className="warn">3</span></button><button onClick={() => setModal('DEMO COVERAGE')}>? HELP</button></div></header>
      <section className="demo-display" aria-label="Presentation controls">
        <label>FAMILY<select aria-label="Theme family" value={family} onChange={e => { setFamily(e.target.value as Family); setSearch(''); setCategory('All'); }}><option value="classic">Arco Classic</option><option value="phosphor">Arco Phosphor</option></select></label>
        <label>PALETTE<select aria-label="Palette" value={selectedId} onChange={e => family === 'phosphor' ? setPhosphor(e.target.value) : setClassic(e.target.value)}>{[...new Set(options.map(t => t.category))].map(c => <optgroup key={c} label={c}>{options.filter(t => t.category === c).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>)}</select></label>
        <span className="demo-hint"><button onClick={() => setSettings(true)} aria-describedby="palette-hint">⌕ BROWSE {options.length}</button><span role="tooltip" id="palette-hint">Search palettes by name or ID, or filter by category. Switching changes paint in place.</span></span>
        <button aria-pressed={effects} onClick={() => setEffects(v => !v)}>EFFECTS {effects ? 'ON' : 'OFF'}</button>
        <label>DENSITY<select aria-label="Density" value={density} onChange={e => setDensity(e.target.value)}><option value="compact">Compact</option><option value="comfortable">Comfortable</option></select></label>
        <label className="check-label"><input type="checkbox" checked={crisp} onChange={e => setCrisp(e.target.checked)} />Crisp text</label>
        {family === 'phosphor' && <label className="softness-control" title="0 = no text glow; 50 = tighter default; 100 = original reference emission">GLOW SOFTNESS<input aria-label="Glow softness" type="range" min="0" max="100" step="5" value={softness} disabled={crisp || !effects} onChange={e => setSoftness(Number(e.target.value))} /><output>{softness}%</output></label>}
        <button onClick={() => setSettings(true)}>FONTS / BRIGHTNESS</button>
        <span className="display-note">{crisp ? 'GLOW OFF · glass + raster retained' : 'Live comparison · same content'}</span>
      </section>
      <nav className="workflow-tabs" aria-label="Workflow tabs">{['Presentation review', 'Transport audit', 'Chat · design notes'].map((t, i) => <button key={t} aria-pressed={screen === t} onClick={() => { setScreen(t); if (i === 1) setPanel('ACTIVITY'); }}><span className={i === 0 ? 'good' : 'muted'}>{i === 0 ? '●' : '○'}</span> {t} <small>{i === 0 ? 'CLAUDE · INPUT' : i === 1 ? 'CODEX · IDLE' : 'CHAT · IDLE'}</small></button>)}<button onClick={() => setModal('NEW WORKFLOW')}>＋ NEW</button></nav>
      <div className={`demo-workspace ${showNav ? '' : 'nav-hidden'}`}>
        {showNav && <aside className="project-nav" aria-label="Project navigation"><div className="section-heading">PROJECTS <span>03</span></div>{['Arco', 'arco-mon', 'design-studies'].map((name, i) => <details key={name} open={i === 0}><summary>{name} <span className="muted">{[3, 2, 1][i]}</span></summary>{['Presentation review', 'Transport audit', 'Review artifacts'].map((t, j) => <button key={t} aria-pressed={i === 0 && screen === t} onClick={() => { setScreen(t); setPanel(j === 2 ? 'REVIEW' : 'PLAN'); }}>{j === 0 ? '●' : '○'} {t}</button>)}</details>)}<div className="nav-bottom"><span className="good">● FIXTURE CONNECTED</span><span>main · 3 changed</span><span>/demo/Arco</span><button onClick={() => setModal('DEMO COVERAGE')}>COVERAGE NOTES ↗</button></div></aside>}
        <div className="demo-main" ref={splitRef} style={{ '--demo-split': `${split}%` } as CSSProperties}>
          <section className="conversation-pane" aria-label="Agent workbench"><div className="pane-heading"><div><strong>{screen}</strong><span className="muted"> / ARCO</span></div><div className="demo-actions"><span className="good">{streaming ? '● STREAMING' : '◇ INPUT REQUIRED'}</span><button onClick={() => setModal('SEARCH TRANSCRIPT')}>⌕ SEARCH</button><button onClick={() => setStreaming(v => !v)}>{streaming ? '■ STOP STREAM' : '▶ PLAY STREAM'}</button><button onClick={() => setModal('WORKFLOW ACTIONS')} aria-label="Workflow menu">⋯</button></div></div><div className="north-star"><span>◇ NORTH STAR</span> Make the workbench clear, dense and reviewable.</div>
            <div className="conversation-scroll" aria-label="Conversation transcript" tabIndex={0}><Transcript presentation={screen.startsWith('Chat') ? 'chat' : 'workbench'} /></div>
            <div className="composer">
              {queue.length > 0 && <div className="queue-strip">{queue.map((q, i) => <div key={i}><span>{q}</span><button aria-label={`Remove queued item ${i + 1}`} onClick={() => setQueue(qs => qs.filter((_, j) => i !== j))}>×</button></div>)}</div>}
              <div className="attachment-strip">{attachments.map((a, i) => <span key={a}>◇ <button onClick={() => openFile(i === 0 ? 'docs/PRESENTATION_REVIEW.md' : 'artifacts/review-017.md')}>{a}</button><button onClick={() => setAttachments(as => as.filter(x => x !== a))} aria-label={`Remove attachment ${a}`}>×</button></span>)}</div>
              <textarea id="composer" aria-label="Message composer" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e.altKey ? 'FOLLOW-UP' : 'STEER'); } if (e.key === 'Escape') setStreaming(false); }} />
              <div className="composer-controls"><div className="demo-actions"><label className="attach-button">＋ ATTACH<input type="file" multiple onChange={e => { setAttachments(a => [...a, ...Array.from(e.target.files ?? []).map(f => `${f.name} · ${f.size} B`)]); e.target.value = ''; }} /></label><select aria-label="Provider" value={provider} onChange={e => setProvider(e.target.value as ProviderName)}>{['claude', 'codex', 'gemini', 'ollama', 'llamacpp', 'lmstudio',  'cursor'].map(p => <option key={p}>{p}</option>)}</select><select aria-label="Model" key={provider}>{(provider === 'claude' ? ['Opus 4.6', 'Sonnet 4.6'] : provider === 'codex' ? ['gpt-5.6', 'gpt-5.5'] : ['Default model', 'Local model']).map(p => <option key={p}>{p}</option>)}</select><select aria-label="Reasoning effort" defaultValue="high"><option>low</option><option>medium</option><option>high</option><option>max</option></select></div><button className="send-button" onClick={() => send()}>{streaming ? 'STEER ↑' : 'SEND ↑'}</button></div>
              <div className="composer-tools">{['REVIEW', 'HANDOFF', 'SPAWN', 'DOCS', 'GIT', 'PLAN'].map(p => <button key={p} onClick={() => setModal(p)}>{p}</button>)}<span>Enter {streaming ? 'steer' : 'send'} · Shift+Enter newline</span><TokenBadge turnTokens={tokens} cumulativeOutput={18924} /></div>
            </div>
          </section>
          <div className="demo-splitter" role="separator" aria-label="Resize workbench panels" aria-orientation="vertical" aria-valuemin={38} aria-valuemax={76} aria-valuenow={split} tabIndex={0} onKeyDown={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); setSplit(v => e.key === 'Home' ? 38 : e.key === 'End' ? 76 : Math.max(38, Math.min(76, v + (e.key === 'ArrowRight' ? 2 : -2)))); } }} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const box = splitRef.current!.getBoundingClientRect(); setSplit(Math.max(38, Math.min(76, (e.clientX - box.left) / box.width * 100))); }} onPointerUp={e => { e.currentTarget.releasePointerCapture(e.pointerId); }} />
          <aside className="right-pane" aria-label="Workbench tools"><nav className="panel-tabs">{panelGroups.map(([group, tabs]) => <div key={group}><span>{group}</span><div>{tabs.map(t => <button key={t} onClick={() => setPanel(t)} aria-pressed={panel === t}>{t}{t === 'REVIEW' ? ' 2' : ''}</button>)}</div></div>)}</nav><div className="panel-scroll" key={panel}>{panelContent()}</div></aside>
        </div>
      </div>
      <section className="terminal-section" aria-label="Terminal output"><header className="terminal-heading"><button onClick={() => setTerminal(v => !v)} aria-expanded={terminal}>{terminal ? '▾' : '▸'} TERMINAL / 01</button><span className="muted">bash · /demo/Arco · exit 2</span><button onClick={() => setTerminalExtra([])}>CLEAR LOCAL OUTPUT</button></header>{terminal && <div className="terminal-body"><pre tabIndex={0}><span className="ansi-cyan">operator@arco</span>:<span className="ansi-blue">~/Projects/Arco</span> $ npm run typecheck -w client{'\n'}<span className="ansi-red">error TS2741</span>: Property 'selection' is missing in type 'Palette' but required in type 'ResolvedPalette'.{'\n'}<span className="ansi-yellow">WARN</span> client/src/themes/palette.ts:41:9 · original output retained · elapsed 1.82s{'\n'}<span className="ansi-green">PASS</span> 68 catalog entries · <span className="ansi-magenta">8 categories</span> · namespace collisions: 0{terminalExtra.map((line, i) => <span key={i}>{'\n'}{line}</span>)}</pre><form onSubmit={e => { e.preventDefault(); setTerminalExtra(lines => [...lines, `$ ${terminalInput}`, 'Fixture shell: command recorded; no process was launched.']); setTerminalInput(''); }}><span className="good">❯</span><input aria-label="Fixture terminal command" value={terminalInput} onChange={e => setTerminalInput(e.target.value)} placeholder="Type a command to inspect the terminal input state" /><button>ENTER</button></form></div>}</section>
      <footer className="demo-footer"><span>ARCO / PRESENTATION STUDY 01</span><span>{selectedId} · {density} · {effects ? crisp ? 'CRISP / STATIC GLASS' : 'CRT ON' : 'EFFECTS OFF'}</span><span>All operations simulated · no deployment</span></footer>
    </div>
    {settings && <Dialog title="DISPLAY SETTINGS" close={() => setSettings(false)}><p className="muted">Preview preferences live only in this document. Palette changes preserve the active transcript and panels. This fixture shell is not a proposed layout change: rollout must retain Arco’s existing layout, content and full settings.</p><div className="settings-fields"><label>Family<select aria-label="Settings family" value={family} onChange={e => { setFamily(e.target.value as Family); setSearch(''); setCategory('All'); }}><option value="classic">Arco Classic · 43 themes</option><option value="phosphor">Arco Phosphor · 68 palettes</option></select></label><label>Font override<select aria-label="Font override" value={font} onChange={e => setFont(e.target.value)}><option value="">Family default</option>{FONT_PACKS.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label><label>Text brightness · {brightness}<input aria-label="Text brightness" type="range" min="-30" max="80" value={brightness} onChange={e => setBrightness(Number(e.target.value))} /></label><label>Background brightness · {backgroundBrightness}<input aria-label="Background brightness" type="range" min="-30" max="30" value={backgroundBrightness} onChange={e => setBackgroundBrightness(Number(e.target.value))} /></label>{family === 'phosphor' && <label>Glow softness · {softness}%<input aria-label="Settings glow softness" type="range" min="0" max="100" step="5" value={softness} disabled={crisp || !effects} onChange={e => setSoftness(Number(e.target.value))} /><small>0: no glow · 50: tighter default · 100: reference look. Crisp text and effects off override this setting.</small></label>}{family === 'classic' && <label>Frosted surfaces<select aria-label="Frosted surfaces" value={frost ?? 'default'} onChange={e => setFrost(e.target.value === 'default' ? undefined : e.target.value as 'on' | 'off')}><option value="default">Theme default</option><option value="on">On</option><option value="off">Off</option></select></label>}<label className="check-label"><input type="checkbox" checked={effects} onChange={e => setEffects(e.target.checked)} />Decorative effects</label><label className="check-label"><input type="checkbox" checked={crisp} onChange={e => setCrisp(e.target.checked)} />Crisp text · disables text emission, keeps glass/raster</label></div><div className="catalog-controls"><input aria-label="Search palettes" type="search" placeholder="Search name or palette ID…" value={search} onChange={e => setSearch(e.target.value)} /><select aria-label="Palette category" value={category} onChange={e => setCategory(e.target.value)}><option>All</option>{(family === 'phosphor' ? themeCategories : [...new Set(options.map(t => t.category))]).map(c => <option key={c}>{c}</option>)}</select><span>{filtered.length} / {options.length}</span></div><div className="palette-grid">{filtered.map(t => { const theme = family === 'phosphor' ? phosphorTheme(t.id) : THEME_REGISTRY[t.id]; return <button key={t.id} aria-pressed={t.id === selectedId} onClick={() => family === 'phosphor' ? setPhosphor(t.id) : setClassic(t.id)}><span className="palette-swatches">{['color-bg', 'color-fg', 'color-accent-primary', 'color-accent-secondary', 'color-warning', 'color-danger'].map(k => <i key={k} style={{ background: theme.tokens[k] }} />)}</span><strong>{t.name}</strong><small>{t.category} · {t.id}</small></button>; })}</div>{!filtered.length && <p>No matching palettes. Clear the search or choose All categories.</p>}<p className="muted">Glow softness changes the text halo and chromatic spread, not text brightness. Background brightness independently adjusts surfaces and the ambient base. Reduced motion retains static glow; crisp text overrides glow only; effects off disables all decoration. Code, diffs and terminal output stay sharp.</p></Dialog>}
    {modal && <Dialog title={modal} close={() => setModal(null)}>{modal === 'SEARCH TRANSCRIPT' ? <TranscriptSearch /> : modal === 'DEMO COVERAGE' ? <><p>Layout boundary: this is a rearranged fixture shell, not the production workbench layout. Design approval covers presentation only; existing Arco layout, information and settings must remain intact.</p><p>Real Arco components: ChatPanel, ChatMessage, tool disclosures, approval and question controls, Markdown/code viewer, DiffView, token badges and Classic shader renderer.</p><p>Fixture adapters: project and workflow navigation, composer, plans/tasks, review summary, usage chart, terminal and preview map, settings, dialogs and notifications.</p><p>Not exercised: live providers, server persistence, cluster grid/mailbox/board, Genesis, media editors, Recall, archive explorer, terminal pop-out, GitHub operations, research/handoff execution and account/auth screens. This is a presentation review, not whole-site coverage.</p></> : modal === 'NOTIFICATIONS' ? <><p className="danger">14:31:52 · Type check failed · exit 2</p><p className="warn">14:31:58 · Approval required · Bash</p><p className="good">14:32:18 · Review artifact available</p></> : modal === 'WORKFLOW ACTIONS' ? <div className="menu-items">{['Rename workflow', 'Duplicate fixture', 'Export transcript', 'Archive fixture'].map(a => <button key={a} onClick={() => { simulated(a); setModal(null); }}>{a}</button>)}</div> : <><p>Review the {modal.toLowerCase()} action for “{screen}”. This fixture keeps the operation local.</p><label>Scope<select><option>Current workflow</option><option>Selected plan items</option><option>New tab</option></select></label><label>Instructions<textarea defaultValue="Preserve context and report findings with evidence." /></label><div className="demo-actions"><button onClick={() => setModal(null)}>CANCEL</button><button className="send-button" onClick={() => { simulated(modal); setModal(null); }}>SIMULATE {modal}</button></div></>}</Dialog>}
    {notice && <div className="demo-toast" role="status"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss notification">×</button></div>}
  </>;
}

createRoot(document.getElementById('root')!).render(<Demo />);
