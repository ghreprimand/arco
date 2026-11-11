import { useEffect, useState, type CSSProperties } from 'react';
import { CLAUDE_MODELS, CLAUDE_MODEL_LABELS, resolveNativeSubagents, type NativeSubagentPolicy } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { queueSettingsPatch } from '../utils/settingsRequests';

const control: CSSProperties = { width: '100%', minWidth: 0, maxWidth: '100%', minHeight: '44px', background: 'var(--color-bg-panel)', color: 'var(--color-control-fg)', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', padding: '6px 8px', font: 'inherit' };
export function NativeSubagentControls({ value, defaults, onChange, inherit = false }: {
  value?: NativeSubagentPolicy;
  defaults?: NativeSubagentPolicy;
  onChange: (value: NativeSubagentPolicy, field: keyof NativeSubagentPolicy) => void;
  inherit?: boolean;
}) {
  const catalog = useAppStore((s) => s.claudeNativeCatalog);
  const inherited = resolveNativeSubagents(defaults);
  const [running, setRunning] = useState(value?.maxRunning?.toString() ?? '');
  const [starts, setStarts] = useState(value?.maxStarts?.toString() ?? '');
  const [error, setError] = useState('');
  useEffect(() => { setRunning(value?.maxRunning?.toString() ?? ''); }, [value?.maxRunning]);
  useEffect(() => { setStarts(value?.maxStarts?.toString() ?? ''); }, [value?.maxStarts]);
  const models: Array<{ id: string; label: string }> = catalog?.models.length ? catalog.models.map((m) => ({ id: m.id, label: m.displayName }))
    : CLAUDE_MODELS.map((id) => ({ id, label: CLAUDE_MODEL_LABELS[id] ?? id }));
  const selected = value?.model ?? (inherit ? '__inherit__' : '');
  if (selected && selected !== '__inherit__' && !models.some((m) => m.id === selected)) models.push({ id: selected, label: `${selected} (unavailable)` });
  const commit = (key: 'maxRunning' | 'maxStarts', text: string) => {
    const next = { ...value };
    if (!text.trim()) delete next[key];
    else {
      const n = Number(text); const max = key === 'maxRunning' ? 32 : 128;
      if (!Number.isInteger(n) || n < 1 || n > max) { setError(`Enter a whole number from 1 to ${max}.`); return; }
      next[key] = n;
    }
    setError(''); onChange(next, key);
  };
  return <fieldset style={{ margin: 0, padding: '10px', minWidth: 0, border: '1px solid var(--color-border-hairline)', fontSize: '12px', color: 'var(--color-fg-muted)' }}>
    <legend>Claude Native sub-agents</legend>
    <p style={{ margin: '0 0 10px', overflowWrap: 'anywhere' }}>Enforced for Native Agent tabs outside clusters. Applies next turn. Other providers keep their own sub-agent behavior.</p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14em), 1fr))', gap: '10px', minWidth: 0 }}>
      <label data-help="settings.native-subagents-running">Maximum running at once
        <input aria-label="Maximum running at once" style={control} type="number" min={1} max={32} step={1} value={running} placeholder={String(inherited.maxRunning)} onChange={(e) => setRunning(e.target.value)} onBlur={() => commit('maxRunning', running)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
      </label>
      <label data-help="settings.native-subagents-starts">Maximum starts per turn
        <input aria-label="Maximum starts per turn" style={control} type="number" min={1} max={128} step={1} value={starts} placeholder={String(inherited.maxStarts)} onChange={(e) => setStarts(e.target.value)} onBlur={() => commit('maxStarts', starts)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
      </label>
      <label data-help="settings.native-subagents-model">Sub-agent model
        <select aria-label="Sub-agent model" style={control} value={selected} onChange={(e) => {
          const next = { ...value };
          if (e.target.value === '__inherit__') delete next.model; else next.model = e.target.value;
          onChange(next, 'model');
        }}>
          {inherit && <option value="__inherit__">Use Settings ({inherited.model || "Agent's choice"})</option>}
          <option value="">Agent's choice</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>
    </div>
    <p style={{ margin: '8px 0 0' }}>Blank limits use {inherit ? 'Settings' : 'the defaults'}: {inherited.maxRunning} running, {inherited.maxStarts} starts per turn. Extra admitted tasks queue; calls beyond the turn limit are refused. A selected model overrides the agent's request.</p>
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}

export function NativeSubagentDefaults() {
  const value = useAppStore((s) => s.settings?.nativeSubagents);
  return <NativeSubagentControls value={value} onChange={(nativeSubagents, field) => { void queueSettingsPatch((current) => ({ nativeSubagents: { ...current.nativeSubagents, [field]: nativeSubagents[field] } })); }} />;
}
