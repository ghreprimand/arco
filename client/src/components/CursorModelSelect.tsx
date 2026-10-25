// Phase 8 — Cursor model picker (family × effort × flags), the drop-in
// replacement for the flat 189-option `<select>`. External contract matches the
// select it replaces: `value` is a catalog id, `onChange` emits a catalog id.
//
// Load-bearing rule (docs/CURSOR_TRANSPORT_PLAN.md §Phase 8): this never builds
// an id string by concatenation. It parses the current id into
// {family, effort, fast, thinking}, lets the operator move those coordinates,
// then LOOKS UP the exact id the catalog advertises (resolveCursorModelId). So a
// combination that doesn't exist is never sent, and there's no way to emit
// `xhigh` when the operator picked `high`. `config.primaryEffort` is irrelevant
// for Cursor — effort lives only in the id — so the effort here is always the
// real one, read back out of the resolved id.

import { useMemo, type CSSProperties } from 'react';
import { useAppStore } from '../stores/appStore';
import {
  buildCursorModelIndex,
  parseCursorModelId,
  cursorEffortsFor,
  resolveCursorModelId,
  cursorEffortKey,
  CURSOR_EFFORT_ORDER,
  CURSOR_EFFORT_LABELS,
  type CursorEffort,
  type CursorModelIndex,
} from '@arco/shared';

interface Props {
  value: string;                       // current catalog id (e.g. "claude-opus-4-8-high")
  onChange: (id: string) => void;      // emits a catalog id the catalog actually advertises
  disabled?: boolean;
  selectStyle?: CSSProperties;         // applied to both <select>s so callers match their look
  layout?: 'row' | 'stack';            // row = inline (composer/dialogs); stack = table cell
}

// Effort ranks for nearest-neighbour snapping when a flag toggle removes the
// current effort (e.g. FAST on an effort with no fast variant).
const EFFORT_RANK = new Map<string, number>(CURSOR_EFFORT_ORDER.map((e, i) => [cursorEffortKey(e), i]));

// Resolve a *desired* selection to a real catalog id, degrading gracefully:
// clamp flags to family capability, then find the nearest available effort.
// Guaranteed to return a real id when the family exists.
function pickCursorId(
  index: CursorModelIndex,
  family: string,
  desiredEffort: CursorEffort | null,
  fast: boolean,
  thinking: boolean,
): string | null {
  const fam = index.families.find((f) => f.family === family);
  if (!fam) return null;
  let f = fast && fam.hasFast;
  let t = thinking && fam.hasThinking;
  // Peel flags until some effort exists for this combo.
  let efforts = cursorEffortsFor(index, family, f, t);
  if (efforts.length === 0 && t) { t = false; efforts = cursorEffortsFor(index, family, f, t); }
  if (efforts.length === 0 && f) { f = false; efforts = cursorEffortsFor(index, family, f, t); }
  if (efforts.length === 0) return null;
  // Prefer the desired effort; else nearest by rank.
  let effort = efforts.includes(desiredEffort) ? desiredEffort : efforts[0];
  if (!efforts.includes(desiredEffort)) {
    const target = EFFORT_RANK.get(cursorEffortKey(desiredEffort)) ?? 0;
    let best = Infinity;
    for (const e of efforts) {
      const d = Math.abs((EFFORT_RANK.get(cursorEffortKey(e)) ?? 0) - target);
      if (d < best) { best = d; effort = e; }
    }
  }
  return resolveCursorModelId(index, family, effort, f, t);
}

export function CursorModelSelect({ value, onChange, disabled, selectStyle, layout = 'row' }: Props) {
  const cursorCatalog = useAppStore((s) => s.cursorCatalog);
  const index = useMemo(() => buildCursorModelIndex(cursorCatalog?.models ?? []), [cursorCatalog]);

  const parsed = parseCursorModelId(value || 'auto');
  const fam = index.families.find((f) => f.family === parsed.family);
  // Cold catalog (no families yet): fall back to a bare disabled select so the
  // surface still renders the stored id rather than an empty control.
  if (index.families.length === 0) {
    return (
      <select value={value} disabled className="display-font" style={selectStyle} onChange={() => {}}>
        <option value={value}>{value || 'auto'}</option>
      </select>
    );
  }

  const efforts = fam ? cursorEffortsFor(index, parsed.family, parsed.fast, parsed.thinking) : [];
  const showEffort = efforts.length > 1 || (efforts.length === 1 && efforts[0] !== null);
  const showFast = !!fam?.hasFast;
  const showThinking = !!fam?.hasThinking;

  const emit = (family: string, effort: CursorEffort | null, fast: boolean, thinking: boolean) => {
    const id = pickCursorId(index, family, effort, fast, thinking);
    if (id) onChange(id);
  };

  const chipStyle = (active: boolean): CSSProperties => ({
    fontFamily: 'var(--font-display)',
    fontSize: '9px',
    letterSpacing: '0.5px',
    padding: '3px 8px',
    borderRadius: '3px',
    cursor: disabled ? 'default' : 'pointer',
    border: `1px solid ${active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
    background: active ? 'var(--color-accent-primary-a15, rgba(120,180,255,0.15))' : 'transparent',
    color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
    opacity: disabled ? 0.5 : 1,
  });

  return (
    <div style={{ display: 'flex', flexDirection: layout === 'stack' ? 'column' : 'row', flexWrap: 'wrap', gap: '6px', alignItems: layout === 'stack' ? 'stretch' : 'center' }}>
      {/* FAMILY */}
      <select
        value={parsed.family}
        disabled={disabled}
        className="display-font"
        style={selectStyle}
        onChange={(e) => emit(e.target.value, parsed.effort, parsed.fast, parsed.thinking)}
      >
        {index.families.map((f) => (
          <option key={f.family} value={f.family}>{f.label}{f.noZdr ? ' (no ZDR)' : ''}</option>
        ))}
      </select>

      {/* EFFORT — only the efforts that exist for this family+flags */}
      {showEffort && (
        <select
          value={cursorEffortKey(parsed.effort)}
          disabled={disabled}
          className="display-font"
          style={selectStyle}
          onChange={(e) => {
            const key = e.target.value;
            const eff = (CURSOR_EFFORT_ORDER.find((x) => cursorEffortKey(x) === key) ?? null) as CursorEffort | null;
            emit(parsed.family, eff, parsed.fast, parsed.thinking);
          }}
        >
          {efforts.map((eff) => (
            <option key={cursorEffortKey(eff)} value={cursorEffortKey(eff)}>
              {CURSOR_EFFORT_LABELS[cursorEffortKey(eff)] ?? cursorEffortKey(eff)}
            </option>
          ))}
        </select>
      )}

      {/* FAST / THINKING toggles — only where the family has the variant */}
      {(showFast || showThinking) && (
        <div style={{ display: 'flex', gap: '4px' }}>
          {showFast && (
            <button
              type="button"
              disabled={disabled}
              style={chipStyle(parsed.fast)}
              onClick={() => !disabled && emit(parsed.family, parsed.effort, !parsed.fast, parsed.thinking)}
              title="Cursor Fast lane (lower latency)"
            >FAST</button>
          )}
          {showThinking && (
            <button
              type="button"
              disabled={disabled}
              style={chipStyle(parsed.thinking)}
              onClick={() => !disabled && emit(parsed.family, parsed.effort, parsed.fast, !parsed.thinking)}
              title="Extended thinking"
            >THINK</button>
          )}
        </div>
      )}

      {/* Auto router honesty note */}
      {parsed.family === 'auto' && (
        <span className="display-font" style={{ fontSize: '9px', color: 'var(--color-fg-muted)', letterSpacing: '0.3px' }}>
          Cursor picks model &amp; effort
        </span>
      )}
    </div>
  );
}
