import { useAppStore } from '../stores/appStore';
import { computerProviderConnected } from '../utils/computerAvailability';
import { useState } from 'react';
import { COMPUTER_PROVIDERS, type ComputerProvider, type ModelName } from '@arco/shared';
import { useComputerStore } from '../stores/computerStore';
import { defaultModelForProvider, modelsForProvider, useModelCatalogs } from '../utils/modelCatalog';
import { clampEffortForModel, effortsForModel } from '../utils/format';
import { requestComputerSelection } from '../voice/computerControl';

export function ComputerAgentPicker() {
  const auth = useAppStore(s => s.authStatus);
  const settings = useAppStore(s => s.settings);
  const selection = useComputerStore((s) => s.selection);
  const pending = useComputerStore((s) => s.pending);
  const error = useComputerStore((s) => s.error);
  const [draft, setDraft] = useState(selection);
  const catalogs = useModelCatalogs();
  const models = modelsForProvider(draft.provider, catalogs);
  const efforts = effortsForModel(draft.provider, draft.model as ModelName, catalogs.claude, catalogs.codex);
  const control = { background: 'var(--color-bg-input)', color: 'var(--color-fg)', border: '1px solid var(--color-border-hairline)', padding: '5px 8px', maxWidth: '100%' };
  const privacyUnavailable = draft.provider === 'strata' && draft.history === 'none';
  return <div data-help="computer.agent" style={{ padding: '10px 18px', borderBottom: '1px solid var(--color-border-hairline)', fontSize: 12, lineHeight: 1.7 }}>
    <div>Active: {selection.provider} · {selection.model} · {selection.effort} · <strong>{selection.history === 'none' ? 'NO HISTORY' : 'SAVED HISTORY'}</strong></div>
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <label>Provider <select aria-label="Computer provider" style={control} value={draft.provider} onChange={(e) => {
        const provider = e.target.value as ComputerProvider;
        const model = provider === 'codex' && modelsForProvider(provider, catalogs).includes('gpt-6-luna') ? 'gpt-6-luna' : defaultModelForProvider(provider, catalogs);
        setDraft({ ...draft, provider, model, effort: clampEffortForModel('low', provider, model, catalogs.claude, catalogs.codex) });
      }}>{COMPUTER_PROVIDERS.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}</select></label>
      <label>Model <select aria-label="Computer model" style={control} value={draft.model} onChange={(e) => {
        const model = e.target.value as ModelName;
        setDraft({ ...draft, model, effort: clampEffortForModel(draft.effort, draft.provider, model, catalogs.claude, catalogs.codex) });
      }}>{models.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
      <label>Effort <select aria-label="Computer effort" style={control} value={draft.effort} onChange={(e) => setDraft({ ...draft, effort: e.target.value as typeof draft.effort })}>
        {efforts.map((v) => <option key={v} value={v}>{v.toUpperCase()}</option>)}
      </select></label>
      <label>History <select aria-label="Computer history mode" style={control} value={draft.history} onChange={(e) => setDraft({ ...draft, history: e.target.value as 'saved' | 'none' })}>
        <option value="saved">Saved history</option><option value="none">No history (Incognito)</option>
      </select></label>
      <button style={{ ...control, color: 'var(--color-accent-primary)', cursor: 'pointer' }} disabled={!!pending || !models.length || privacyUnavailable || (!!auth && !computerProviderConnected(draft.provider, auth, settings?.enabledProviders))}
        onClick={() => { try { requestComputerSelection(draft); } catch (e) { useComputerStore.setState({ error: e instanceof Error ? e.message : 'Computer switch failed.' }); } }}>USE AGENT</button>
    </div>
    <div style={{ color: 'var(--color-fg-muted)' }}>Each provider/model/effort has a separate context. Changes wait for the current turn and queue. No earlier messages are copied.</div>
    {draft.history === 'none' && <div style={{ color: 'var(--color-fg-muted)' }}>No history keeps the transcript in memory until you clear context, leave this mode, reload or close the page. Cloud inference and Microsoft speech still receive the text they process. Messages sent to workers follow the destination’s history settings.</div>}
    {privacyUnavailable && <div role="alert">Strata’s standalone service keeps logs/cache. No-history mode requires Ollama, Claude or Codex.</div>}
    {pending && <div role="status">Switch requested: {pending.provider} · {pending.model} · {pending.history === 'none' ? 'NO HISTORY' : 'SAVED HISTORY'}. Waiting for the current turn and queue.</div>}
    {error && <div role="alert" style={{ color: 'var(--color-danger)' }}>{error}</div>}
  </div>;
}
