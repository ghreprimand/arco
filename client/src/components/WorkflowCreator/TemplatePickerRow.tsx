import type { TemplatePickerRowProps } from './types';

// Workbench Expansion §D4 — TEMPLATES row in the SINGLE-workflow creator.
// Single-tab analogue of ClusterPresetsRow. Pills display each saved recipe by
// name; click to apply (pre-fills provider/model/effort/permissions + optional
// cwd, and queues an optional seedPrompt/plan to land on the new tab after
// create — pre-fill only, never auto-sent). × deletes after a window.confirm.
// [+ SAVE AS TEMPLATE] toggles an inline input that POSTs the current creator
// config to /api/templates.
export function TemplatePickerRow({
  templates,
  isLoading,
  error,
  onApply,
  onDelete,
  saveDisabled,
  saveOpen,
  saveName,
  saveError,
  saveBusy,
  onSaveOpen,
  onSaveCancel,
  onSaveNameChange,
  onSaveSubmit,
}: TemplatePickerRowProps) {
  const labelStyle: React.CSSProperties = {
    fontSize: '11px',
    letterSpacing: '2px',
    color: 'var(--color-accent-primary-dim)',
    display: 'block',
    marginBottom: '6px',
  };
  const pillStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 4px 4px 10px',
    border: '1px solid var(--color-border-hairline)',
    borderRadius: '3px',
    background: 'transparent',
    color: 'var(--color-fg-muted)',
    fontFamily: 'var(--font-display)',
    fontSize: '11px',
    letterSpacing: '1px',
    cursor: 'pointer',
  };
  const saveBtnStyle: React.CSSProperties = {
    padding: '4px 10px',
    border: `1px solid ${saveDisabled ? 'var(--color-border-hairline)' : 'var(--color-accent-secondary-dim)'}`,
    borderRadius: '3px',
    background: 'transparent',
    color: saveDisabled ? 'var(--color-fg-muted)' : 'var(--color-accent-secondary)',
    cursor: saveDisabled ? 'not-allowed' : 'pointer',
    fontFamily: 'var(--font-display)',
    fontSize: '11px',
    letterSpacing: '1px',
  };
  const tip = (t: TemplatePickerRowProps['templates'][number]): string => {
    const bits = [`${t.config.primaryProvider ?? 'claude'} · ${t.config.primaryModel}`];
    if (t.config.workingDirectory) bits.push(`cwd ${t.config.workingDirectory}`);
    if (t.seedPrompt) bits.push('seed prompt');
    if (t.plan) bits.push('plan');
    return `Apply template · ${bits.join(' · ')}`;
  };
  return (
    <div data-help="creator.templates">
      <label className="display-font" style={labelStyle}>TEMPLATES</label>
      {error && (
        <div className="display-font" style={{ fontSize: '10px', color: 'var(--color-danger)', marginBottom: '6px' }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' }}>
        {templates.map((t) => (
          <span key={t.id} style={pillStyle}>
            <button
              onClick={() => onApply(t)}
              className="display-font"
              title={tip(t)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                font: 'inherit',
                letterSpacing: 'inherit',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {t.name}
            </button>
            <button
              onClick={() => onDelete(t)}
              title={`Delete template "${t.name}"`}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--color-fg-muted)',
                cursor: 'pointer',
                fontFamily: 'var(--font-display)',
                fontSize: '11px',
                padding: '0 6px',
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </span>
        ))}
        {!saveOpen && (
          <button
            onClick={onSaveOpen}
            disabled={saveDisabled}
            className="display-font"
            title={saveDisabled ? 'Pick a model before saving.' : 'Save the current config as a reusable template.'}
            style={saveBtnStyle}
          >
            + SAVE AS TEMPLATE
          </button>
        )}
        {isLoading && (
          <span className="display-font" style={{ fontSize: '10px', color: 'var(--color-fg-muted)', letterSpacing: '1px' }}>
            LOADING…
          </span>
        )}
      </div>

      {templates.length === 0 && !saveOpen && !isLoading && !error && (
        <div
          className="display-font"
          style={{ fontSize: '10px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px', marginTop: '6px', opacity: 0.7 }}
        >
          No templates yet. Configure the form below, then save the current config as a recipe.
        </div>
      )}

      {saveOpen && (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input
              type="text"
              value={saveName}
              autoFocus
              placeholder="Template name (≤64)"
              onChange={(e) => onSaveNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); onSaveSubmit(); }
                if (e.key === 'Escape') { e.preventDefault(); onSaveCancel(); }
              }}
              style={{
                flex: 1,
                padding: '6px 10px',
                background: 'var(--color-bg-sunken)',
                border: '1px solid var(--color-border-hairline)',
                borderRadius: '4px',
                color: 'var(--color-accent-primary)',
                fontFamily: 'var(--font-body)',
                fontSize: '12px',
                outline: 'none',
              }}
            />
            <button
              onClick={onSaveSubmit}
              disabled={saveBusy || !saveName.trim()}
              className="display-font"
              style={{
                padding: '6px 12px',
                background: 'transparent',
                border: '1px solid var(--color-accent-primary-dim)',
                borderRadius: '3px',
                color: saveBusy || !saveName.trim() ? 'var(--color-fg-muted)' : 'var(--color-accent-primary)',
                cursor: saveBusy || !saveName.trim() ? 'not-allowed' : 'pointer',
                fontSize: '11px',
                letterSpacing: '1px',
              }}
            >
              {saveBusy ? 'SAVING…' : 'SAVE'}
            </button>
            <button
              onClick={onSaveCancel}
              disabled={saveBusy}
              className="display-font"
              style={{
                padding: '6px 12px',
                background: 'transparent',
                border: '1px solid var(--color-border-hairline)',
                borderRadius: '3px',
                color: 'var(--color-fg-muted)',
                cursor: saveBusy ? 'not-allowed' : 'pointer',
                fontSize: '11px',
                letterSpacing: '1px',
              }}
            >
              CANCEL
            </button>
          </div>
          <div className="display-font" style={{ fontSize: '9px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px', opacity: 0.7 }}>
            Saves provider / model / effort / permissions + current cwd. Seed prompt + plan are not captured here — pre-fill those on the new tab.
          </div>
          {saveError && (
            <div className="display-font" style={{ fontSize: '10px', color: 'var(--color-danger)', letterSpacing: '0.5px' }}>
              {saveError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
