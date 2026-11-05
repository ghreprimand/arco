import { useUsableUtilityAgent } from '../UtilityAgentPicker';
import { Fragment, useEffect, useRef, useState } from 'react';
import {
  AUTO_PICKUP_MODE_LABELS,
  AUTO_PICKUP_MODES,
  DEFAULT_SMART_PICKUP_LIMITS,
  DEFAULT_RULE_PICKUP_LIMITS,
  RULE_PICKUP_LIMIT_KEYS,
  RULE_PICKUP_LIMIT_SPECS,
  type RulePickupLimits,
  SMART_PICKUP_EVALUATOR_PROVIDERS,
  SMART_PICKUP_LIMIT_KEYS,
  SMART_PICKUP_LIMIT_SPECS,
  isSmartPickupMode,
  resolveAutoPickupMode,
  type AutoPickupMode,
  type ClusterAutoPickupState,
  type ClusterStatePayload,
  type SmartPickupEvaluator,
  type SmartPickupEvaluatorCapability,
  type SmartPickupEvaluatorProvider,
  type SmartPickupLimits,
} from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { useStartupStore } from '../../stores/startupStore';
import { modelsForProvider, useModelCatalogs } from '../../utils/modelCatalog';

const PROVIDER_NAMES: Record<SmartPickupEvaluatorProvider, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', ollama: 'Ollama', lmstudio: 'LM Studio', llamacpp: 'llama.cpp', strata: 'Strata', deepseek: 'DeepSeek (Xolotl)' };

const MODE_HELP: Record<AutoPickupMode, string> = {
  off: 'No automatic worker turns. MAIL ALERTS and NUDGE stay available.',
  rule: 'Recommended: wakes members when mail arrives; skips acknowledgements and stops loops.',
  'smart-observe': 'The chosen evaluator reads an idle member\'s waiting mail and answers wake, wait or ask. Answers are only logged; no turn starts.',
  'smart-auto': 'The same evaluator, but a wake answer starts a turn when every limit allows it, and an ask answer alerts the operator.',
};

export function autoPickupStateOf(cluster: ClusterStatePayload): ClusterAutoPickupState {
  return cluster.autoPickup ?? { mode: resolveAutoPickupMode(undefined, cluster.autoTurnOnMailboxEnabled), limits: DEFAULT_SMART_PICKUP_LIMITS };
}

function describeDecision(state: ClusterAutoPickupState): string | null {
  const d = state.lastDecision;
  if (!d) return null;
  const when = new Date(d.at).toLocaleTimeString();
  const unloaded = /^evaluator_error:model_not_loaded_(lmstudio|llamacpp|strata|deepseek)$/.exec(d.reason);
  const names = { lmstudio: 'LM Studio', llamacpp: 'llama.cpp', strata: 'Strata', deepseek: 'DeepSeek' } as const;
  const what = d.action ? `answered ${d.action}` : unloaded
    ? `model not loaded in ${names[unloaded[1] as keyof typeof names]}; load it or choose another`
    : d.reason.replace(/_/g, ' ');
  return `${when}: ${what}${d.action ? ` (${d.reason.replace(/_/g, ' ')}), ${d.outcome}` : ''}`;
}

export function AutoPickupControl({ cluster }: { cluster: ClusterStatePayload }) {
  const state = autoPickupStateOf(cluster);
  const wsSendRaw = useAppStore((s) => s.wsSendRaw);
  const connected = useAppStore((s) => s.connected);
  const [open, setOpen] = useState(false);
  const send = (mode: AutoPickupMode, evaluator?: SmartPickupEvaluator, limits?: Partial<SmartPickupLimits>, ruleLimits?: Partial<RulePickupLimits>) => {
    wsSendRaw?.({ type: 'cluster_auto_pickup_set', clusterId: cluster.clusterId, mode, ...(evaluator ? { evaluator } : {}), ...(limits ? { limits } : {}), ...(ruleLimits ? { ruleLimits } : {}) });
  };
  const on = state.mode !== 'off';
  const remaining = state.session ? Math.max(0, Math.ceil((state.session.expiresAt - Date.now()) / 60_000)) : null;
  const title = on
    ? `${AUTO_PICKUP_MODE_LABELS[state.mode].label}${remaining !== null ? `, about ${remaining} min left in this session` : ''}. Click to review or change.`
    : 'AUTO-PICKUP is off. Click to choose a mode.';
  return (
    <>
      <span className="display-font" data-help="cluster.auto-turn" style={{ color: 'var(--color-fg-muted)', letterSpacing: '1px', marginLeft: '10px' }}>
        AUTO-PICKUP
      </span>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-help="cluster.auto-turn"
        aria-haspopup="dialog"
        aria-label={`AUTO-PICKUP: ${AUTO_PICKUP_MODE_LABELS[state.mode].label}`}
        className="display-font"
        title={title}
        style={{
          padding: '3px 8px',
          background: on ? 'var(--color-accent-primary-a06)' : 'transparent',
          border: '1px solid ' + (on ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
          color: on ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
          cursor: 'pointer',
          fontSize: '9px',
          letterSpacing: '1px',
        }}
      >
        {AUTO_PICKUP_MODE_LABELS[state.mode].chip}
        {isSmartPickupMode(state.mode) && state.counters ? ` · ${state.counters.wakesThisSession}/${state.limits.wakesPerSession}` : ''}
      </button>
      {state.mode === 'rule' && state.ruleStatus?.budgetPaused && <button type="button" data-help="cluster.auto-pickup-rule-resume" disabled={!connected} onClick={() => wsSendRaw?.({ type: 'cluster_auto_pickup_set', clusterId: cluster.clusterId, mode: 'rule', resumeRule: true })}>RESUME</button>}
      {on && (
        <button
          type="button"
          onClick={() => send('off')}
          disabled={!connected}
          data-help="cluster.auto-pickup-off"
          aria-label="Turn AUTO-PICKUP off"
          className="display-font"
          style={{ padding: '3px 6px', background: 'transparent', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '9px', letterSpacing: '1px' }}
        >
          TURN OFF
        </button>
      )}
      {open && <AutoPickupDialog state={state} onClose={() => setOpen(false)} onApply={(mode, evaluator, limits, ruleLimits) => { send(mode, evaluator, limits, ruleLimits); setOpen(false); }} />}
    </>
  );
}

function AutoPickupDialog({ state, onClose, onApply }: {
  state: ClusterAutoPickupState;
  onClose: () => void;
  onApply: (mode: AutoPickupMode, evaluator?: SmartPickupEvaluator, limits?: Partial<SmartPickupLimits>, ruleLimits?: Partial<RulePickupLimits>) => void;
}) {
  const authStatus = useAppStore((s) => s.authStatus);
  const isProviderEnabled = useAppStore((s) => s.isProviderEnabled);
  const connected = useAppStore((s) => s.connected);
  const catalogs = useModelCatalogs();
  // Which providers can evaluate without tools here (server-reported).
  const [capabilities, setCapabilities] = useState<SmartPickupEvaluatorCapability[] | null>(null);
  const [capabilityError, setCapabilityError] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch('/api/smart-pickup/evaluators', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { evaluators?: SmartPickupEvaluatorCapability[] }) => { if (alive) setCapabilities(Array.isArray(body.evaluators) ? body.evaluators : []); })
      .catch(() => { if (alive) { setCapabilities([]); setCapabilityError(true); } });
    return () => { alive = false; };
  }, []);
  const capable = (p: SmartPickupEvaluatorProvider) => capabilities?.find((c) => c.provider === p)?.available === true;
  const connectedProviders = SMART_PICKUP_EVALUATOR_PROVIDERS.filter((p) => isProviderEnabled(p) && Boolean(authStatus?.[p]?.loggedIn));
  const available = connectedProviders.filter(capable);
  const utilityAgent = useUsableUtilityAgent();
  const unsupported = (capabilities ?? []).filter((c) => !c.available && c.reason);
  // Never preselect the first time; offer the active or last explicit choice
  // only while its provider is still enabled and connected.
  const offered = [state.evaluator, state.lastEvaluator].find((e) => e && connectedProviders.includes(e.provider));
  const [mode, setMode] = useState<AutoPickupMode>(state.mode);
  const [provider, setProvider] = useState<SmartPickupEvaluatorProvider | ''>(offered?.provider ?? '');
  const [model, setModel] = useState(offered?.model ?? '');
  // Drop the offered choice once support is known not to cover it.
  useEffect(() => {
    if (capabilities && provider && !capable(provider)) { setProvider(''); setModel(''); }
  }, [capabilities]); // eslint-disable-line react-hooks/exhaustive-deps
  const [ruleLimits, setRuleLimits] = useState<RulePickupLimits>(state.ruleLimits ?? DEFAULT_RULE_PICKUP_LIMITS);
  const [limits, setLimits] = useState<SmartPickupLimits>(state.limits);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const models = provider ? modelsForProvider(provider, catalogs).map(String) : [];
  const smart = isSmartPickupMode(mode);
  const evaluator = provider && model ? { provider, model } : undefined;
  const changedLimits = Object.fromEntries(SMART_PICKUP_LIMIT_KEYS.filter((k) => limits[k] !== state.limits[k]).map((k) => [k, limits[k]])) as Partial<SmartPickupLimits>;
  const limitsValid = SMART_PICKUP_LIMIT_KEYS.every((k) => Number.isInteger(limits[k]) && limits[k] >= SMART_PICKUP_LIMIT_SPECS[k].min && limits[k] <= SMART_PICKUP_LIMIT_SPECS[k].max);
  const ruleValid = RULE_PICKUP_LIMIT_KEYS.every((k) => Number.isInteger(ruleLimits[k]) && ruleLimits[k] >= RULE_PICKUP_LIMIT_SPECS[k].min && ruleLimits[k] <= RULE_PICKUP_LIMIT_SPECS[k].max);
  const problem = mode === 'rule' && !ruleValid ? 'Each rule limit must be a whole number within its range.' : !connected ? 'Not connected to the server.'
    : smart && capabilities === null ? 'Checking which providers can evaluate.'
    : smart && available.length === 0 ? 'Connect an evaluator provider first.'
    : smart && !evaluator ? 'Choose an evaluator provider and model.'
    : !limitsValid ? 'Each limit must be a whole number within its range.'
    : null;
  const field: React.CSSProperties = { display: 'block', margin: '4px 0 10px' };
  const decision = describeDecision(state);
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auto-pickup-title"
        data-help="cluster.auto-pickup-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
        style={{ width: 'min(620px, calc(94vw / var(--ui-scale, 1)))', maxHeight: 'calc(88vh / var(--ui-scale, 1))', overflowY: 'auto', background: 'var(--color-bg-dialog)', border: '1px solid var(--color-accent-primary-dim)', borderRadius: '6px', padding: '18px 20px', fontSize: '12px', lineHeight: 1.5 }}
      >
        <h2 id="auto-pickup-title" className="display-font glow-text-bright" style={{ margin: '0 0 10px', fontSize: '14px', letterSpacing: '2px' }}>AUTO-PICKUP</h2>
        <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)' }}>MODE</legend>
          {AUTO_PICKUP_MODES.map((m, i) => (
            <Fragment key={m}>
              {/* The heading groups the Smart modes; it sits above their first radio, outside any label. */}
              {m === 'smart-observe' && <div data-testid="auto-pickup-advanced-heading" style={{ margin: '12px 0 4px', color: 'var(--color-fg-muted)' }}>Advanced: model-assisted</div>}
              <label style={{ display: 'block', margin: '6px 0' }}>
                <input ref={i === 0 ? first : undefined} type="radio" name="auto-pickup-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />{' '}
                <strong>{AUTO_PICKUP_MODE_LABELS[m].label}</strong>
                <span style={{ display: 'block', marginLeft: '22px', color: 'var(--color-fg-muted)' }}>{MODE_HELP[m]}</span>
              </label>
            </Fragment>
          ))}
        </fieldset>

        {mode === 'rule' && <section data-help="cluster.auto-pickup-rule-limits">
          <h3>Rule-based limits</h3>
          {RULE_PICKUP_LIMIT_KEYS.map((k) => { const spec = RULE_PICKUP_LIMIT_SPECS[k]; return <label key={k} className="arco-field-label" style={field}>{spec.label} ({spec.min} to {spec.max} {spec.unit})
            <input className="arco-field" type="number" min={spec.min} max={spec.max} step={1} value={Number.isFinite(ruleLimits[k]) ? ruleLimits[k] : ''} onChange={(e) => setRuleLimits((prior) => ({ ...prior, [k]: e.target.value === '' ? Number.NaN : Number(e.target.value) }))} />
          </label>; })}
          <button type="button" data-help="cluster.auto-pickup-rule-reset" onClick={() => setRuleLimits({ ...DEFAULT_RULE_PICKUP_LIMITS })}>RESET LIMITS</button>
          {state.ruleStatus && <p>Automatic wakes: {state.ruleStatus.wakes} of {ruleLimits.wakesPerArming} this arming.{state.ruleStatus.ledgerUnavailable ? ' Paused: the Rule-based ledger is unavailable.' : state.ruleStatus.budgetPaused ? ' Paused: resume to start a fresh budget.' : ''}{state.ruleStatus.pausedPair ? ' Alternating pair paused.' : ''}</p>}
        </section>}
        {smart && (
          <section data-help="cluster.auto-pickup-evaluator" style={{ borderTop: '1px solid var(--color-border-hairline)', marginTop: '10px', paddingTop: '10px' }}>
            <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)' }}>EVALUATOR</div>
            <p style={{ margin: '6px 0' }}>
              The evaluator reads only the waiting mail and short member and task facts, then answers wake, wait or ask.
              A fast, low-cost model suits this; a large or high-effort model adds cost without benefit.
              The mail is sent to the chosen provider, and any cost depends on that provider.
            </p>
            {capabilities === null ? null : available.length === 0 ? (
              <p role="status">
                No provider that can evaluate is enabled and connected.{' '}
                <button type="button" onClick={() => useStartupStore.getState().openConnections()} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-accent-secondary)', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>Open Connections</button>
              </p>
            ) : (
              <>
                {utilityAgent && available.includes(utilityAgent.provider) && (
                  <button type="button" data-testid="evaluator-use-utility" data-help="cluster.auto-pickup-evaluator" disabled={provider === utilityAgent.provider && model === utilityAgent.model}
                    onClick={() => { setProvider(utilityAgent.provider); setModel(utilityAgent.model); }} style={{ marginBottom: '8px' }}>
                    USE UTILITY AGENT ({PROVIDER_NAMES[utilityAgent.provider]} / {utilityAgent.model})
                  </button>
                )}
                <label className="arco-field-label" style={field}>Provider
                  <select className="arco-field" aria-label="Evaluator provider" value={provider} onChange={(e) => { setProvider(e.target.value as SmartPickupEvaluatorProvider | ''); setModel(''); }}>
                    <option value="">Choose a provider</option>
                    {available.map((p) => <option key={p} value={p}>{PROVIDER_NAMES[p]}</option>)}
                  </select>
                </label>
                <label className="arco-field-label" style={field}>Model
                  <select className="arco-field" aria-label="Evaluator model" value={model} disabled={!provider} onChange={(e) => setModel(e.target.value)}>
                    <option value="">Choose a model</option>
                    {models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
              </>
            )}
            {(unsupported.length > 0 || capabilityError) && (
              <ul aria-label="Providers that cannot evaluate" style={{ margin: '0 0 10px', paddingLeft: '18px', color: 'var(--color-fg-muted)' }}>
                {capabilityError && <li>Evaluator support could not be checked; try again.</li>}
                {unsupported.map((c) => <li key={c.provider}>{PROVIDER_NAMES[c.provider]}: {c.reason}</li>)}
              </ul>
            )}
            <details data-help="cluster.auto-pickup-limits">
              <summary className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', cursor: 'pointer' }}>LIMITS</summary>
              {SMART_PICKUP_LIMIT_KEYS.map((k) => {
                const spec = SMART_PICKUP_LIMIT_SPECS[k];
                return (
                  <label key={k} className="arco-field-label" style={field}>{spec.label} ({spec.min} to {spec.max} {spec.unit})
                    <input className="arco-field" type="number" min={spec.min} max={spec.max} step={1} value={Number.isFinite(limits[k]) ? limits[k] : ''}
                      onChange={(e) => setLimits((prior) => ({ ...prior, [k]: e.target.value === '' ? Number.NaN : Number(e.target.value) }))} />
                  </label>
                );
              })}
              <p style={{ color: 'var(--color-fg-muted)' }}>The existing cooldown, per-minute ceiling and chain limit also apply.</p>
            </details>
          </section>
        )}

        {(state.counters || decision) && (
          <section data-help="cluster.auto-pickup-status" aria-label="AUTO-PICKUP status" style={{ borderTop: '1px solid var(--color-border-hairline)', marginTop: '10px', paddingTop: '10px', color: 'var(--color-fg-muted)' }}>
            {state.session && <div>Session ends at {new Date(state.session.expiresAt).toLocaleTimeString()}.</div>}
            {state.counters && <div>Evaluator requests: {state.counters.callsThisSession} this session, {state.counters.callsLastHour} in the last hour, {state.counters.inFlight} in progress. Automatic wakes: {state.counters.wakesThisSession} of {state.limits.wakesPerSession} this session, {state.counters.wakesLastHour} in the last hour.</div>}
            {decision && <div>Last decision: {decision}</div>}
          </section>
        )}

        {problem && <p role="alert" style={{ color: 'var(--color-accent-secondary-dim)' }}>{problem}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
          <button type="button" onClick={onClose} className="display-font">CANCEL</button>
          <button type="button" disabled={problem !== null} onClick={() => onApply(mode, smart ? evaluator : undefined, Object.keys(changedLimits).length ? changedLimits : undefined, mode === 'rule' ? ruleLimits : undefined)} className="display-font">
            {smart ? (mode === 'smart-auto' ? 'ARM AUTOMATIC' : 'ARM OBSERVE-ONLY') : 'APPLY'}
          </button>
        </div>
      </div>
    </div>
  );
}
