import { describeUtilityFailure, utilityAttribution } from './utilityResult';
import { useEffect, useRef, useState } from 'react';
import {
  UTILITY_AGENT_PROVIDERS, suggestUtilityModel, utilityModelHint,
  type ArcoSettings, type UtilityAgent, type UtilityAgentCapability, type UtilityAgentProvider, type UtilityJobResult,
} from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { claudeModelLabel, modelsForProvider, useModelCatalogs } from '../utils/modelCatalog';

// Which providers can serve as the utility agent here (server-reported).
export function useUtilityAgentCapabilities(): UtilityAgentCapability[] | null {
  const [capabilities, setCapabilities] = useState<UtilityAgentCapability[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/utility-agent/providers', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { providers?: UtilityAgentCapability[] }) => { if (alive) setCapabilities(Array.isArray(body.providers) ? body.providers : []); })
      .catch(() => { if (alive) setCapabilities([]); });
    return () => { alive = false; };
  }, []);
  return capabilities;
}

// The saved utility agent, only while its provider is enabled and connected.
export function useUsableUtilityAgent(): UtilityAgent | null {
  const agent = useAppStore((s) => s.settings?.utilityAgent) ?? null;
  const authStatus = useAppStore((s) => s.authStatus);
  const isProviderEnabled = useAppStore((s) => s.isProviderEnabled);
  if (!agent) return null;
  return isProviderEnabled(agent.provider) && Boolean(authStatus?.[agent.provider]?.loggedIn) ? agent : null;
}

const PROVIDER_LABEL: Record<UtilityAgentProvider, string> = { claude: 'CLAUDE', codex: 'CODEX', cursor: 'CURSOR', ollama: 'OLLAMA', lmstudio: 'LM STUDIO', llamacpp: 'LLAMA.CPP', strata: 'STRATA', deepseek: 'DEEPSEEK (XOLOTL)' };

const pill = (active: boolean): React.CSSProperties => ({
  padding: '3px 8px', background: active ? 'var(--color-accent-primary-a10)' : 'transparent',
  border: `1px solid ${active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
  color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px',
});

const STILL_WORKING_MS = 4000;


// Choose, save, clear and test the utility agent. Nothing is selected until the
// operator saves a choice; the cheap-model hint is only a button.
export function UtilityAgentPicker({ afterSave }: { afterSave?: () => void }) {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const authStatus = useAppStore((s) => s.authStatus);
  const isProviderEnabled = useAppStore((s) => s.isProviderEnabled);
  const catalogs = useModelCatalogs();
  const capabilities = useUtilityAgentCapabilities();
  const saved = settings?.utilityAgent ?? null;
  const [provider, setProvider] = useState<UtilityAgentProvider | ''>(saved?.provider ?? '');
  const [model, setModel] = useState(saved?.model ?? '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [test, setTest] = useState<{ phase: 'idle' | 'running' | 'slow' | 'done'; result?: UtilityJobResult }>({ phase: 'idle' });
  const jobId = useRef('');
  useEffect(() => { setProvider(saved?.provider ?? ''); setModel(saved?.model ?? ''); }, [saved?.provider, saved?.model]);

  const connected = UTILITY_AGENT_PROVIDERS.filter((p) => isProviderEnabled(p) && Boolean(authStatus?.[p]?.loggedIn));
  const offered = connected.filter((p) => capabilities?.find((c) => c.provider === p)?.available === true);
  const blocked = (capabilities ?? []).filter((c) => !c.available && c.reason && connected.includes(c.provider));
  const models = provider ? modelsForProvider(provider, catalogs).map(String) : [];
  const suggestion = provider ? suggestUtilityModel(provider, models) : null;
  const hint = provider ? utilityModelHint(provider) : null;
  const dirty = (saved?.provider ?? '') !== provider || (saved?.model ?? '') !== model;

  const persist = async (next: UtilityAgent | null) => {
    setBusy(true); setNote('');
    try {
      const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ utilityAgent: next }) });
      if (!res.ok) throw new Error(String(res.status));
      setSettings((await res.json()) as ArcoSettings);
      setNote(next ? 'Saved.' : 'Cleared.');
      afterSave?.();
    } catch { setNote('Could not save. Retry.'); }
    finally { setBusy(false); }
  };

  const runTest = async () => {
    const id = `util-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    jobId.current = id;
    setTest({ phase: 'running' });
    const slow = setTimeout(() => setTest((t) => (t.phase === 'running' ? { phase: 'slow' } : t)), STILL_WORKING_MS);
    try {
      const res = await fetch('/api/utility-agent/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: id }) });
      const result = (await res.json()) as UtilityJobResult;
      if (jobId.current === id) setTest({ phase: 'done', result });
    } catch {
      if (jobId.current === id) setTest({ phase: 'done', result: { jobId: id, status: 'error', facts: [], elapsedMs: 0 } });
    } finally { clearTimeout(slow); }
  };
  const cancelTest = () => {
    void fetch('/api/utility-agent/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: jobId.current }) }).catch(() => undefined);
  };

  const statusStyle: React.CSSProperties = { margin: 0, color: 'var(--color-fg-muted)', font: '11px/1.5 var(--font-body)' };
  return (
    <div data-help="settings.utility-agent" data-testid="utility-agent-picker" style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '11px' }}>
      <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)' }}>UTILITY AGENT</div>
      <p style={statusStyle}>
        Short side jobs, such as summaries, run on this agent instead of a workflow's agent. It has no tools and only reads facts Arco collects. The facts are sent to the chosen provider, and any cost depends on that provider.
        {saved ? ` Current choice: ${saved.provider.toUpperCase()} / ${saved.model}.` : ' No utility agent is chosen; utility buttons ask for one.'}
      </p>
      {capabilities === null ? <p role="status" style={statusStyle}>Checking which providers can serve.</p>
        : offered.length === 0 ? <p role="status" style={statusStyle}>No provider that can serve is enabled and connected. Connect a supported provider first.</p>
        : (
          <>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>PROVIDER</span>
              {offered.map((p) => (
                <button key={p} type="button" className="display-font" aria-pressed={provider === p} data-testid={`utility-provider-${p}`} style={pill(provider === p)}
                  onClick={() => { setProvider(p); setModel(saved?.provider === p ? saved.model : ''); }}>{PROVIDER_LABEL[p]}</button>
              ))}
            </div>
            {provider && (
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>MODEL</span>
                {models.length === 0 && <em>No models available for {provider}.</em>}
                {models.map((m) => (
                  <button key={m} type="button" className="display-font" aria-pressed={model === m} data-testid="utility-model" style={pill(model === m)} onClick={() => setModel(m)}>
                    {provider === 'claude' ? claudeModelLabel(m, catalogs.claude) : m}
                  </button>
                ))}
              </div>
            )}
            {provider && hint && (
              <p style={statusStyle}>
                A fast, low-cost model suits this work{suggestion ? <>: <code>{suggestion}</code>{' '}
                  <button
                    type="button"
                    className="display-font"
                    data-testid="utility-use-suggestion"
                    disabled={model === suggestion}
                    onClick={() => setModel(suggestion)}
                    style={{
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--color-accent-primary)',
                      textDecoration: 'underline',
                      cursor: model === suggestion ? 'default' : 'pointer',
                      font: 'inherit',
                      letterSpacing: '0.5px',
                    }}
                  >
                    CHOOSE IT
                  </button>
                </> : ' (none matches in this list)'}. Nothing is chosen until you save.
              </p>
            )}
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button type="button" className="display-font" data-testid="utility-save" disabled={busy || !provider || !model || !dirty} onClick={() => void persist({ provider: provider as UtilityAgentProvider, model })}>SAVE</button>
              <button type="button" className="display-font" data-testid="utility-clear" disabled={busy || !saved} onClick={() => void persist(null)}>CLEAR</button>
              <button type="button" className="display-font" data-testid="utility-test" disabled={busy || !saved || dirty || test.phase === 'running' || test.phase === 'slow'} onClick={() => void runTest()}>TEST</button>
              {(test.phase === 'running' || test.phase === 'slow') && <button type="button" className="display-font" data-testid="utility-cancel" onClick={cancelTest}>CANCEL</button>}
            </div>
          </>
        )}
      {blocked.map((c) => <p key={c.provider} role="note" style={statusStyle}>{c.provider.toUpperCase()}: {c.reason}</p>)}
      {note && <p role="status" style={statusStyle}>{note}</p>}
      {test.phase === 'slow' && <p role="status" data-testid="utility-slow" style={statusStyle}>Still working. A cold start can take a while; CANCEL stops it.</p>}
      {test.phase === 'running' && <p role="status" style={statusStyle}>Asking the utility agent.</p>}
      {test.phase === 'done' && test.result && (
        <div role="status" data-testid="utility-result" style={statusStyle}>
          {test.result.status === 'ok'
            ? <>Answered by {test.result.agent?.provider.toUpperCase()} / {test.result.agent?.model} in {(test.result.elapsedMs / 1000).toFixed(1)} s: {test.result.text}</>
            : <>{describeUtilityFailure(test.result)} {utilityAttribution(test.result)}</>}
        </div>
      )}
    </div>
  );
}
