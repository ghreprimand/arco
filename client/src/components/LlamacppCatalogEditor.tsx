import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import type { LlamacppModelDef } from '@arco/shared';

// Operator-facing editor for ~/.arco/llamacpp.json. Reads the catalog
// over /api/llamacpp/catalog (full GET / full POST replace, same
// wholesale-not-merge pattern as the models.md editor), and exposes
// per-row Load / Unload / Edit / Delete plus an Add form.
//
// Why surface this in-app rather than just letting operators hand-edit
// the JSON: the GGUF path is long, capability flags are easy to miss,
// and "Load now" hides the 20-30s GGUF cold-start behind an explicit
// click instead of making the next workflow turn pay for it.

interface CatalogResponse {
  models: LlamacppModelDef[];
}

interface BlankForm {
  alias: string;
  ggufPath: string;
  mmprojPath: string;
  ctxSize: string;  // string in form, parsed on save
  ngl: string;
  tools: boolean;
  vision: boolean;
  thinking: boolean;
}

const BLANK: BlankForm = {
  alias: '',
  ggufPath: '',
  mmprojPath: '',
  ctxSize: '',
  ngl: '999',
  tools: true,
  vision: false,
  thinking: true,
};

function defToForm(def: LlamacppModelDef): BlankForm {
  return {
    alias: def.alias,
    ggufPath: def.ggufPath,
    mmprojPath: def.mmprojPath ?? '',
    ctxSize: def.ctxSize ? String(def.ctxSize) : '',
    ngl: typeof def.ngl === 'number' ? String(def.ngl) : '999',
    tools: def.capabilities?.tools ?? false,
    vision: def.capabilities?.vision ?? false,
    thinking: def.capabilities?.thinking ?? false,
  };
}

function formToDef(f: BlankForm, prior?: LlamacppModelDef): LlamacppModelDef {
  // Preserve operator-set extraArgs / chatTemplate across edits — the form
  // doesn't expose them but we don't want hand-edited values to get nuked
  // every time someone clicks Save in the GUI.
  const out: LlamacppModelDef = {
    alias: f.alias.trim(),
    ggufPath: f.ggufPath.trim(),
    capabilities: { tools: f.tools, vision: f.vision, thinking: f.thinking },
  };
  if (f.mmprojPath.trim()) out.mmprojPath = f.mmprojPath.trim();
  const ctx = parseInt(f.ctxSize, 10);
  if (Number.isFinite(ctx) && ctx > 0) out.ctxSize = ctx;
  const ngl = parseInt(f.ngl, 10);
  if (Number.isFinite(ngl)) out.ngl = ngl;
  if (prior?.chatTemplate) out.chatTemplate = prior.chatTemplate;
  if (prior?.extraArgs) out.extraArgs = prior.extraArgs;
  return out;
}

export function LlamacppCatalogEditor() {
  const llamacppLive = useAppStore((s) => s.llamacppLive);
  const setLlamacppLive = useAppStore((s) => s.setLlamacppLive);
  const [models, setModels] = useState<LlamacppModelDef[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingAlias, setEditingAlias] = useState<string | null>(null); // null = closed; '' = adding new
  const [form, setForm] = useState<BlankForm>(BLANK);
  const [saving, setSaving] = useState(false);
  const [actionPending, setActionPending] = useState<string | null>(null); // alias being load/unloaded/deleted
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const res = await fetch('/api/llamacpp/catalog');
      const data = await res.json() as CatalogResponse;
      setModels(data.models);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => { void refresh(); }, []);

  const startAdd = () => { setForm(BLANK); setEditingAlias(''); };
  const startEdit = (def: LlamacppModelDef) => { setForm(defToForm(def)); setEditingAlias(def.alias); };
  const cancelForm = () => { setEditingAlias(null); setForm(BLANK); };

  const save = async () => {
    if (!models) return;
    if (!form.alias.trim() || !form.ggufPath.trim()) {
      setActionError('alias and ggufPath are required');
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      const prior = editingAlias ? models.find((m) => m.alias === editingAlias) : undefined;
      const next = formToDef(form, prior);
      let updated: LlamacppModelDef[];
      if (editingAlias) {
        // Replace by alias. If the operator renamed it, the new alias still
        // sits in the same slot — the catalog has no separate identity beyond
        // the alias string.
        updated = models.map((m) => (m.alias === editingAlias ? next : m));
      } else {
        // Reject duplicate alias — the catalog dedupes silently on read but
        // the operator should know if they're shadowing an existing entry.
        if (models.some((m) => m.alias === next.alias)) {
          setActionError(`alias "${next.alias}" already exists`);
          setSaving(false);
          return;
        }
        updated = [...models, next];
      }
      const res = await fetch('/api/llamacpp/catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: updated }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as CatalogResponse;
      setModels(data.models);
      cancelForm();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (alias: string) => {
    if (!models) return;
    if (!confirm(`Delete model "${alias}" from the registry?`)) return;
    setActionPending(alias);
    setActionError(null);
    try {
      const updated = models.filter((m) => m.alias !== alias);
      const res = await fetch('/api/llamacpp/catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: updated }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as CatalogResponse;
      setModels(data.models);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  };

  const loadAlias = async (alias: string) => {
    setActionPending(alias);
    setActionError(null);
    try {
      const res = await fetch(`/api/llamacpp-load?alias=${encodeURIComponent(alias)}`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      // Force-refresh the live status so the UI reflects the new loaded model
      // immediately rather than waiting up to 15s for the next App.tsx poll.
      try {
        const live = await fetch('/api/llamacpp-live').then((r) => r.json());
        setLlamacppLive(live);
      } catch { /* fall back to next poll */ }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  };

  const unloadCurrent = async () => {
    setActionPending('__unload__');
    setActionError(null);
    try {
      const res = await fetch('/api/llamacpp-unload', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      try {
        const live = await fetch('/api/llamacpp-live').then((r) => r.json());
        setLlamacppLive(live);
      } catch { /* fall back to next poll */ }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  };

  const loadedAlias = llamacppLive?.loadedModel ?? null;

  return (
    <div data-help="settings.llamacpp-catalog">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <span className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)' }}>
          LLAMA.CPP MODELS
        </span>
        <div style={{ display: 'flex', gap: '6px' }}>
          {loadedAlias && (
            <button
              onClick={unloadCurrent}
              disabled={actionPending === '__unload__'}
              className="display-font"
              style={btnStyle('warning', actionPending === '__unload__')}
              title={`Evict "${loadedAlias}" from VRAM`}
            >
              {actionPending === '__unload__' ? '…' : 'UNLOAD'}
            </button>
          )}
          {editingAlias === null && (
            <button
              onClick={startAdd}
              className="display-font"
              style={btnStyle('secondary', false)}
            >
              + ADD MODEL
            </button>
          )}
        </div>
      </div>

      {loadError && (
        <div style={errorStyle}>{loadError}</div>
      )}
      {actionError && (
        <div style={errorStyle}>{actionError}</div>
      )}

      {editingAlias !== null && (
        <ModelForm
          form={form}
          setForm={setForm}
          onSave={save}
          onCancel={cancelForm}
          saving={saving}
          isEdit={editingAlias !== ''}
        />
      )}

      {models && models.length === 0 && editingAlias === null && (
        <div style={hintStyle}>
          No models registered. Click + ADD MODEL to register your first GGUF.
          See <code>docs/PROVIDERS.md § llama.cpp</code> for the field reference.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
        {models?.map((def) => {
          const isLoaded = def.alias === loadedAlias;
          const isLoading = actionPending === def.alias;
          const badges: string[] = [];
          if (def.capabilities?.tools) badges.push('tools');
          if (def.capabilities?.vision) badges.push('vision');
          if (def.capabilities?.thinking) badges.push('thinking');
          if (def.mmprojPath) badges.push('mmproj');
          return (
            <div
              key={def.alias}
              style={{
                display: 'flex',
                gap: '10px',
                padding: '10px 12px',
                border: `1px solid ${isLoaded ? 'var(--color-accent-secondary)' : 'var(--color-border-hairline)'}`,
                borderRadius: '4px',
                background: isLoaded ? 'var(--color-accent-secondary-a08)' : 'var(--color-bg-sunken)',
              }}
            >
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="display-font" style={{ fontSize: '12px', letterSpacing: '2px', color: 'var(--color-accent-primary)' }}>
                    {def.alias.toUpperCase()}
                  </span>
                  {isLoaded && (
                    <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-accent-secondary)', border: '1px solid var(--color-accent-secondary)', borderRadius: '2px', padding: '0 5px' }}>
                      LOADED
                    </span>
                  )}
                </div>
                <div style={pathStyle} title={def.ggufPath}>
                  {def.ggufPath}
                </div>
                {def.mmprojPath && (
                  <div style={pathStyle} title={def.mmprojPath}>
                    mmproj: {def.mmprojPath}
                  </div>
                )}
                <div style={{ fontSize: '9px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {typeof def.ctxSize === 'number' && <span>ctx: {def.ctxSize.toLocaleString()}</span>}
                  {typeof def.ngl === 'number' && <span>ngl: {def.ngl}</span>}
                  {badges.length > 0 && <span>· {badges.join(' · ')}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'stretch' }}>
                <button
                  onClick={() => loadAlias(def.alias)}
                  disabled={isLoaded || isLoading}
                  className="display-font"
                  style={btnStyle('primary', isLoading || isLoaded)}
                  title={isLoaded ? 'Already loaded' : 'Load this model into VRAM (~20-30s for a fresh GGUF)'}
                >
                  {isLoading ? '…' : isLoaded ? 'IN VRAM' : 'LOAD'}
                </button>
                <button
                  onClick={() => startEdit(def)}
                  disabled={editingAlias !== null}
                  className="display-font"
                  style={btnStyle('ghost', editingAlias !== null)}
                >
                  EDIT
                </button>
                <button
                  onClick={() => remove(def.alias)}
                  disabled={actionPending === def.alias || editingAlias !== null}
                  className="display-font"
                  style={btnStyle('danger', actionPending === def.alias || editingAlias !== null)}
                >
                  DELETE
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ModelFormProps {
  form: BlankForm;
  setForm: (f: BlankForm) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  isEdit: boolean;
}

function ModelForm({ form, setForm, onSave, onCancel, saving, isEdit }: ModelFormProps) {
  const update = (patch: Partial<BlankForm>) => setForm({ ...form, ...patch });
  return (
    <div style={{ marginBottom: '12px', padding: '12px', border: '1px solid var(--color-accent-primary)', borderRadius: '4px', background: 'var(--color-accent-primary-a05)' }}>
      <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary)', marginBottom: '8px' }}>
        {isEdit ? `EDIT MODEL` : 'ADD MODEL'}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 10px', alignItems: 'center', fontFamily: 'var(--font-body)' }}>
        <label style={fieldLabelStyle}>alias</label>
        <input value={form.alias} onChange={(e) => update({ alias: e.target.value })} placeholder="e.g. qwen3.6" style={fieldInputStyle} />

        <label style={fieldLabelStyle}>ggufPath</label>
        <input value={form.ggufPath} onChange={(e) => update({ ggufPath: e.target.value })} placeholder="/absolute/path/to/model.gguf" style={fieldInputStyle} />

        <label style={fieldLabelStyle}>mmprojPath</label>
        <input value={form.mmprojPath} onChange={(e) => update({ mmprojPath: e.target.value })} placeholder="/absolute/path/to/mmproj.gguf (optional, vision only)" style={fieldInputStyle} />

        <label style={fieldLabelStyle}>ctxSize</label>
        <input value={form.ctxSize} onChange={(e) => update({ ctxSize: e.target.value })} placeholder="e.g. 98304 (leave blank for model default)" style={fieldInputStyle} />

        <label style={fieldLabelStyle}>ngl</label>
        <input value={form.ngl} onChange={(e) => update({ ngl: e.target.value })} placeholder="999 = all layers on GPU" style={fieldInputStyle} />

        <label style={fieldLabelStyle}>capabilities</label>
        <div style={{ display: 'flex', gap: '12px' }}>
          <CapBox label="tools" checked={form.tools} onChange={(v) => update({ tools: v })} />
          <CapBox label="vision" checked={form.vision} onChange={(v) => update({ vision: v })} />
          <CapBox label="thinking" checked={form.thinking} onChange={(v) => update({ thinking: v })} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: '6px', marginTop: '10px', justifyContent: 'flex-end' }}>
        <button onClick={onCancel} disabled={saving} className="display-font" style={btnStyle('ghost', saving)}>
          CANCEL
        </button>
        <button onClick={onSave} disabled={saving} className="display-font" style={btnStyle('primary', saving)}>
          {saving ? 'SAVING…' : 'SAVE'}
        </button>
      </div>
    </div>
  );
}

function CapBox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px', color: 'var(--color-fg-muted)', cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ accentColor: 'var(--color-accent-primary)' }} />
      {label}
    </label>
  );
}

// ---- Style fragments. Inline so we don't add another file ----

const fieldLabelStyle: React.CSSProperties = {
  fontSize: '10px',
  color: 'var(--color-fg-muted)',
  fontFamily: 'var(--font-display)',
  letterSpacing: '1px',
  textAlign: 'right',
};

const fieldInputStyle: React.CSSProperties = {
  fontSize: '11px',
  padding: '4px 8px',
  background: 'var(--color-bg-sunken)',
  color: 'var(--color-fg-default)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  fontFamily: 'var(--font-body)',
  outline: 'none',
};

const pathStyle: React.CSSProperties = {
  fontSize: '10px',
  color: 'var(--color-fg-muted)',
  fontFamily: 'var(--font-body)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const errorStyle: React.CSSProperties = {
  fontSize: '10px',
  color: 'var(--color-warning)',
  fontFamily: 'var(--font-body)',
  marginBottom: '8px',
  padding: '6px 8px',
  border: '1px solid var(--color-warning)',
  borderRadius: '3px',
  background: 'var(--color-warning-a10, transparent)',
};

const hintStyle: React.CSSProperties = {
  fontSize: '10px',
  color: 'var(--color-fg-muted)',
  fontFamily: 'var(--font-body)',
  padding: '8px 10px',
  border: '1px dashed var(--color-border-hairline)',
  borderRadius: '3px',
  marginBottom: '12px',
};

type BtnTone = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning';

function btnStyle(tone: BtnTone, disabled: boolean): React.CSSProperties {
  const fg =
    tone === 'primary' ? 'var(--color-accent-primary)'
    : tone === 'secondary' ? 'var(--color-accent-secondary)'
    : tone === 'danger' ? 'var(--color-danger, #f04a4a)'
    : tone === 'warning' ? 'var(--color-warning)'
    : 'var(--color-fg-muted)';
  const bg = tone === 'ghost'
    ? 'transparent'
    : tone === 'primary' ? 'var(--color-accent-primary-a10)'
    : tone === 'secondary' ? 'var(--color-accent-secondary-a08)'
    : 'transparent';
  return {
    padding: '4px 10px',
    background: bg,
    border: `1px solid ${fg}`,
    borderRadius: '3px',
    color: fg,
    cursor: disabled ? 'default' : 'pointer',
    fontSize: '10px',
    letterSpacing: '1.5px',
    opacity: disabled ? 0.5 : 1,
  };
}
