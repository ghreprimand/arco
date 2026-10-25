import { useMemo, useState } from 'react';

// Tree-with-checkboxes modal for the CUSTOM REVIEW flow. Operator picks
// any subset of plan tasks across phases; on confirm, returns the
// `${phaseIdx}/${taskIdx}` IDs that the server's plan parser uses to
// resolve the selection back to markdown content.
//
// This is the only client-side plan parser. It mirrors the server's
// task-detection rules (checkbox bullets and naked numbered bullets) but
// stays minimal — it only needs the structural anchors required to
// render rows and emit IDs. The server re-parses with its own (richer)
// parser to slice the actual content sent to the reviewer.

interface PickerTask {
  idx: number;
  parentLine: string;   // raw `- [ ] **4.1** - ...` line
  display: string;      // parent line stripped of `- [ ]` / `- ` prefix
  checked: boolean;
}

interface PickerPhase {
  idx: number;
  heading: string;
  tasks: PickerTask[];
}

const H3_RE = /^###\s+(.+?)\s*$/;
const H2_RE = /^##\s+/;
const CHECKBOX_TASK_RE = /^- \[( |x|X)\]\s+(.*)$/;
const NUMBERED_TASK_RE = /^- (\*\*[\d.]+.*)$/;

function parsePlanForPicker(body: string): PickerPhase[] {
  const lines = body.split('\n');
  const phases: PickerPhase[] = [];
  let currentPhase: PickerPhase | null = null;
  let betweenPhases = false;

  for (const line of lines) {
    const h3 = line.match(H3_RE);
    if (h3) {
      if (currentPhase) phases.push(currentPhase);
      currentPhase = { idx: phases.length, heading: h3[1], tasks: [] };
      betweenPhases = false;
      continue;
    }
    if (currentPhase && H2_RE.test(line)) {
      // H2 closes the phase. Discard intervening content until next H3.
      phases.push(currentPhase);
      currentPhase = null;
      betweenPhases = true;
      continue;
    }
    if (betweenPhases || !currentPhase) continue;
    const checkboxed = line.match(CHECKBOX_TASK_RE);
    if (checkboxed) {
      currentPhase.tasks.push({
        idx: currentPhase.tasks.length,
        parentLine: line,
        display: checkboxed[2],
        checked: checkboxed[1].toLowerCase() === 'x',
      });
      continue;
    }
    const numbered = line.match(NUMBERED_TASK_RE);
    if (numbered) {
      currentPhase.tasks.push({
        idx: currentPhase.tasks.length,
        parentLine: line,
        display: numbered[1],
        checked: false,
      });
      continue;
    }
  }
  if (currentPhase) phases.push(currentPhase);
  return phases;
}

interface Props {
  planTitle: string;
  planBody: string;
  onConfirm: (itemIds: string[], label: string) => void;
  onCancel: () => void;
}

export function PlanReviewPicker({ planTitle, planBody, onConfirm, onCancel }: Props) {
  const phases = useMemo(() => parsePlanForPicker(planBody), [planBody]);
  // Selection set keyed by `${phaseIdx}/${taskIdx}`.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const allIds = useMemo(() => {
    const ids: string[] = [];
    for (const p of phases) for (const t of p.tasks) ids.push(`${p.idx}/${t.idx}`);
    return ids;
  }, [phases]);
  const allCheckedIds = useMemo(() => {
    const ids: string[] = [];
    for (const p of phases) for (const t of p.tasks) if (t.checked) ids.push(`${p.idx}/${t.idx}`);
    return ids;
  }, [phases]);

  const totalTasks = allIds.length;
  const totalChecked = allCheckedIds.length;
  const totalSelected = selected.size;

  const toggleOne = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const setMany = (ids: string[], add: boolean) => {
    setSelected((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (add) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  // Per-phase tri-state: 'none' | 'some' | 'all'
  const phaseState = (p: PickerPhase): 'none' | 'some' | 'all' => {
    if (p.tasks.length === 0) return 'none';
    let count = 0;
    for (const t of p.tasks) if (selected.has(`${p.idx}/${t.idx}`)) count++;
    if (count === 0) return 'none';
    if (count === p.tasks.length) return 'all';
    return 'some';
  };
  const togglePhase = (p: PickerPhase) => {
    const state = phaseState(p);
    const ids = p.tasks.map((t) => `${p.idx}/${t.idx}`);
    setMany(ids, state !== 'all');
  };

  // Build the human-readable label that the dialog will lock into the
  // SCOPE row. Single-phase selections name the phase; multi-phase show
  // a count.
  const buildLabel = (): string => {
    if (totalSelected === 0) return 'PLAN: 0 ITEMS';
    const phasesTouched = new Set<number>();
    for (const id of selected) phasesTouched.add(Number(id.split('/')[0]));
    if (phasesTouched.size === 1) {
      const pIdx = phasesTouched.values().next().value as number;
      const phase = phases.find((p) => p.idx === pIdx);
      return `PLAN: ${totalSelected} ${totalSelected === 1 ? 'ITEM' : 'ITEMS'} FROM ${phase?.heading.toUpperCase() ?? 'PHASE'}`;
    }
    return `PLAN: ${totalSelected} ITEMS ACROSS ${phasesTouched.size} PHASES`;
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-accent-primary-dim)',
          borderRadius: '6px',
          padding: '18px 22px',
          width: 'min(560px, 94vw)',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'var(--font-body)',
        }}
      >
        <div
          className="display-font"
          style={{
            fontSize: '12px',
            letterSpacing: '3px',
            color: 'var(--color-accent-primary)',
            marginBottom: '4px',
          }}
        >
          CUSTOM REVIEW SELECTION
        </div>
        <div
          style={{
            fontSize: '11px',
            color: 'var(--color-fg-muted)',
            marginBottom: '12px',
            wordBreak: 'break-word',
          }}
        >
          Plan: {planTitle}
        </div>

        <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
          <ToolbarBtn onClick={() => setMany(allIds, true)} disabled={totalTasks === 0}>
            SELECT ALL ({totalTasks})
          </ToolbarBtn>
          <ToolbarBtn onClick={() => setMany(allCheckedIds, true)} disabled={totalChecked === 0}>
            ALL CHECKED ({totalChecked})
          </ToolbarBtn>
          <ToolbarBtn onClick={() => setSelected(new Set())} disabled={totalSelected === 0}>
            CLEAR
          </ToolbarBtn>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            padding: '8px 10px',
            background: 'var(--color-bg-sunken)',
          }}
        >
          {phases.length === 0 && (
            <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontStyle: 'italic' }}>
              No phases or tasks found in this plan.
            </div>
          )}
          {phases.map((p) => {
            const state = phaseState(p);
            return (
              <div key={p.idx} style={{ marginBottom: '10px' }}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    cursor: p.tasks.length > 0 ? 'pointer' : 'default',
                    fontSize: '12px',
                    color: 'var(--color-accent-primary)',
                    fontWeight: 600,
                    opacity: p.tasks.length > 0 ? 1 : 0.5,
                  }}
                >
                  <TriCheckbox state={state} onClick={() => p.tasks.length > 0 && togglePhase(p)} />
                  <span>{p.heading}</span>
                  {p.tasks.length === 0 && (
                    <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontWeight: 400, fontStyle: 'italic' }}>
                      (no checkbox tasks — use REVIEW PHASE for prose-only sections)
                    </span>
                  )}
                </label>
                {p.tasks.map((t) => {
                  const id = `${p.idx}/${t.idx}`;
                  const sel = selected.has(id);
                  return (
                    <label
                      key={id}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '6px',
                        marginLeft: '20px',
                        marginTop: '4px',
                        cursor: 'pointer',
                        fontSize: '11px',
                        color: t.checked ? 'var(--color-fg-muted)' : 'var(--color-accent-primary)',
                      }}
                    >
                      <SimpleCheckbox checked={sel} onClick={() => toggleOne(id)} />
                      <span style={{ flex: 1, wordBreak: 'break-word' }}>
                        {t.checked && <span style={{ color: 'var(--color-accent-secondary-dim)', marginRight: '4px' }}>[x]</span>}
                        {t.display}
                      </span>
                    </label>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div
          className="display-font"
          style={{
            marginTop: '10px',
            fontSize: '10px',
            letterSpacing: '1px',
            color: totalSelected > 0 ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
          }}
        >
          {totalSelected} {totalSelected === 1 ? 'ITEM' : 'ITEMS'} SELECTED
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
          <Btn onClick={onCancel}>CANCEL</Btn>
          <Btn
            primary
            disabled={totalSelected === 0}
            onClick={() => onConfirm(Array.from(selected), buildLabel())}
          >
            CONTINUE TO REVIEW
          </Btn>
        </div>
      </div>
    </div>
  );
}

function ToolbarBtn({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="display-font"
      style={{
        padding: '4px 8px',
        background: 'transparent',
        border: '1px solid var(--color-border-hairline)',
        borderRadius: '3px',
        color: 'var(--color-fg-muted)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: '10px',
        letterSpacing: '1px',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

function SimpleCheckbox({ checked, onClick }: { checked: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); onClick(); }}
      style={{
        width: '14px',
        height: '14px',
        flexShrink: 0,
        marginTop: '2px',
        border: '1px solid var(--color-accent-primary)',
        background: checked ? 'var(--color-accent-primary)' : 'transparent',
        color: 'var(--color-bg-panel)',
        cursor: 'pointer',
        padding: 0,
        fontSize: '10px',
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {checked ? '✓' : ''}
    </button>
  );
}

function TriCheckbox({ state, onClick }: { state: 'none' | 'some' | 'all'; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); onClick(); }}
      style={{
        width: '14px',
        height: '14px',
        flexShrink: 0,
        border: '1px solid var(--color-accent-primary)',
        background: state === 'all' ? 'var(--color-accent-primary)' : state === 'some' ? 'var(--color-accent-primary-dim)' : 'transparent',
        color: 'var(--color-bg-panel)',
        cursor: 'pointer',
        padding: 0,
        fontSize: '10px',
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {state === 'all' ? '✓' : state === 'some' ? '–' : ''}
    </button>
  );
}

function Btn({
  onClick,
  children,
  primary,
  disabled,
}: { onClick: () => void; children: React.ReactNode; primary?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="display-font"
      style={{
        padding: '6px 14px',
        background: primary ? 'var(--color-accent-primary-a10)' : 'transparent',
        border: `1px solid ${primary ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
        borderRadius: '3px',
        color: primary ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: '11px',
        letterSpacing: '2px',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}
