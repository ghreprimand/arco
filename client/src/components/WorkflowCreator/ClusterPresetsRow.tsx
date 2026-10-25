import type { ClusterPresetsRowProps } from './types';

// 2026-05-11 — PRESETS row above the DEFAULT FOR NEW MEMBERS banner. Pills
// display each saved preset by name; click to apply (overwrites MEMBERS list +
// fills CLUSTER NAME when blank); × deletes after a window.confirm. The
// [+ SAVE AS PRESET] button toggles an inline input that posts to
// /api/cluster-presets. Cwd is intentionally never threaded through this
// surface — presets are project-agnostic.
export function ClusterPresetsRow({
  presets,
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
}: ClusterPresetsRowProps) {
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
  return (
    <div data-help="creator.cluster-presets">
      <label className="display-font" style={labelStyle}>PRESETS</label>
      {error && (
        <div className="display-font" style={{ fontSize: '10px', color: 'var(--color-danger)', marginBottom: '6px' }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' }}>
        {presets.map((p) => (
          <span key={p.id} style={pillStyle}>
            <button
              onClick={() => onApply(p)}
              className="display-font"
              title={`Apply preset · ${p.members.length} members${p.clusterNameTemplate ? ` · name "${p.clusterNameTemplate}"` : ''}`}
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
              {p.name}
            </button>
            <button
              onClick={() => onDelete(p)}
              title={`Delete preset "${p.name}"`}
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
            title={saveDisabled ? 'Configure at least 2 members (each with a model) before saving.' : 'Save the current cluster shape as a preset.'}
            style={saveBtnStyle}
          >
            + SAVE AS PRESET
          </button>
        )}
        {isLoading && (
          <span className="display-font" style={{ fontSize: '10px', color: 'var(--color-fg-muted)', letterSpacing: '1px' }}>
            LOADING…
          </span>
        )}
      </div>

      {presets.length === 0 && !saveOpen && !isLoading && !error && (
        <div
          className="display-font"
          style={{ fontSize: '10px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px', marginTop: '6px', opacity: 0.7 }}
        >
          No presets yet. Configure members below, then save the current shape.
        </div>
      )}

      {saveOpen && (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input
              type="text"
              value={saveName}
              autoFocus
              placeholder="Preset name (≤64)"
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
