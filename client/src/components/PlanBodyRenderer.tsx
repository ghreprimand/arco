// Plan body renderer. Extracted from RightPanel.tsx so the cluster PLAN tab
// (ClusterPlanTab) can render the same shape without duplicating the parser
// + pill plumbing. Almost all lines pass through as preformatted text in a
// `<div>` per line (so flex layout sees real children rather than one
// monolithic `<pre>`); checkbox lines render a clickable glyph the operator
// can flip from this panel without leaving for EDIT mode. H3 lines render
// per-phase action pills (REVIEW / VERIFY / SPAWN) when the matching handler
// is wired. Both worker-tab and cluster-tab parents reuse this component.
//
// Keeping the regex + extractors co-located with the renderer so the cluster
// tab can call them without depth-coupling back into RightPanel.

import type { CSSProperties, ReactNode } from 'react';
import { splitRefLinks } from './plans/planRefs';

// Match `- [ ] item` and `- [x] item`, with arbitrary leading whitespace
// (so nested checklists work). Used by both the renderer (to spot rows that
// need a clickable checkbox) and the toggle handler (to flip the same line).
export const CHECKBOX_RE = /^(\s*)-\s+\[([ xX])\]\s+(.*)$/;

// Extract the phase block rooted at `lines[startIndex]`: the H3 heading line
// plus every following line, stopping at the next H1/H2/H3 heading. Trailing
// blank lines are trimmed.
export function extractPhaseBlock(lines: string[], startIndex: number): string {
  if (!/^###\s/.test(lines[startIndex] ?? '')) return lines[startIndex] ?? '';
  const out: string[] = [lines[startIndex]];
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  while (out.length > 1 && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n');
}

// Extract the "task block" rooted at `lines[startIndex]`: the parent line
// itself plus every subsequent line indented MORE deeply than the parent,
// up to (but not including) the next sibling/uncle. Used by the spawn-task
// flow so the prefilled direction carries the full sub-bullet structure
// instead of just the parent's one-line summary — local thinking models
// otherwise miss sub-items that aren't checkboxes (sub-bullets in plans
// are usually plain `- ` rows, not `- [ ]`, and the spawn button only
// renders on checkboxes). Empty lines inside a block are preserved so
// markdown structure carries over; trailing empties are trimmed.
export function extractTaskBlock(lines: string[], startIndex: number): string {
  const m = lines[startIndex]?.match(CHECKBOX_RE);
  if (!m) return lines[startIndex] ?? '';
  const parentIndent = m[1].length;
  const out: string[] = [lines[startIndex]];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      out.push(line);
      continue;
    }
    const lead = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (lead > parentIndent) {
      out.push(line);
    } else {
      break;
    }
  }
  while (out.length > 1 && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n');
}

export interface PlanBodyRendererProps {
  body: string | null;
  loading: boolean;
  errorMessage: string | null;
  onToggleCheckbox: (lineIndex: number) => void;
  // When provided, unchecked checkbox rows render a small SPAWN button
  // that opens SpawnDialog prefilled with the task text. Undefined when
  // the parent has no spawn handler (shouldn't happen in practice but
  // keeps the renderer reusable).
  onSpawnTask?: (taskText: string) => void;
  // §10.7 P12.5 — plan→task bridge. When provided, unchecked checkbox rows
  // render a small → TASK pill that promotes the checkbox text into a durable
  // ledger task (the parent fires task_ledger_create on the cluster board).
  onPromoteTask?: (taskText: string) => void;
  // When provided, H3 lines render a small REVIEW PHASE pill that fires
  // with the heading text (everything after `### `). Parent uses this to
  // open ReviewDialog with a `plan-phase` ref locked in.
  onReviewPhase?: (heading: string) => void;
  // When provided, H3 lines also render a SPAWN PHASE pill next to
  // REVIEW PHASE — fires with the full phase block (heading + every line
  // up to the next heading). Parent opens SpawnDialog prefilled with a
  // phase-scoped direction.
  onSpawnPhase?: (phaseText: string) => void;
  // When provided, H3 lines render a VERIFY PHASE pill — same plan-phase
  // ref as REVIEW PHASE but parent pre-ticks INCLUDE GIT DIFF so the
  // reviewer sees the actual changes alongside the claimed-done items.
  onVerifyPhase?: (heading: string) => void;
  // Reference-doc links (`[label](ref:slug)` / `[[ref:slug]]`) render as chips
  // that fire this with the slug. `refSlugs` (when known) dims links to refs
  // that don't exist; null = list still loading, so nothing is dimmed.
  onOpenRef?: (slug: string) => void;
  refSlugs?: ReadonlySet<string> | null;
}

export function PlanBodyRenderer({
  body,
  loading,
  errorMessage,
  onToggleCheckbox,
  onSpawnTask,
  onPromoteTask,
  onReviewPhase,
  onSpawnPhase,
  onVerifyPhase,
  onOpenRef,
  refSlugs,
}: PlanBodyRendererProps) {
  const withRefs = (text: string): ReactNode => {
    if (!onOpenRef || !text.includes('ref:')) return text;
    return splitRefLinks(text).map((part, k) => {
      if (typeof part === 'string') return part;
      const missing = !!refSlugs && !refSlugs.has(part.slug);
      return (
        <button
          key={k}
          type="button"
          onClick={() => onOpenRef(part.slug)}
          title={missing ? `ref:${part.slug} — not written yet (click to create)` : `Open reference doc ref:${part.slug}`}
          style={{
            display: 'inline',
            padding: '0 5px',
            margin: '0 1px',
            background: missing ? 'transparent' : 'var(--color-accent-secondary-a10)',
            border: `1px ${missing ? 'dashed' : 'solid'} var(--color-accent-secondary-dim)`,
            borderRadius: '3px',
            color: 'var(--color-accent-secondary)',
            opacity: missing ? 0.55 : 1,
            cursor: 'pointer',
            fontSize: '11px',
            fontFamily: 'inherit',
            lineHeight: 1.35,
          }}
        >
          ⧉ {part.label}
        </button>
      );
    });
  };
  const containerStyle: CSSProperties = {
    fontSize: '12px',
    fontFamily: 'var(--font-body)',
    color: 'var(--color-accent-primary)',
    margin: 0,
    background: 'var(--color-bg-sunken)',
    padding: '10px 12px',
    border: '1px solid var(--color-border-hairline)',
    minHeight: '120px',
    lineHeight: 1.5,
    maxWidth: '100%',
    flexShrink: 0,
  };
  if (body === null) {
    if (loading) return <div style={containerStyle}>loading…</div>;
    return <div style={containerStyle}>{errorMessage ? '(fetch failed)' : '(empty plan)'}</div>;
  }
  if (body === '') {
    return <div style={containerStyle}>(empty plan)</div>;
  }
  const lines = body.split('\n');
  return (
    <div style={containerStyle}>
      {lines.map((line, i) => {
        const m = line.match(CHECKBOX_RE);
        if (m) {
          const [, indent, mark, rest] = m;
          const checked = mark.toLowerCase() === 'x';
          return (
            <div
              key={i}
              style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              <span style={{ whiteSpace: 'pre' }}>{indent}- </span>
              <button
                type="button"
                onClick={() => onToggleCheckbox(i)}
                title={checked ? 'Mark as not done' : 'Mark as done'}
                style={{
                  width: '14px',
                  height: '14px',
                  flexShrink: 0,
                  marginTop: '3px',
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
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  textDecoration: checked ? 'line-through' : 'none',
                  opacity: checked ? 0.65 : 1,
                }}
              >
                {withRefs(rest)}
              </span>
              {onSpawnTask && !checked && rest.trim().length > 0 && (
                <button
                  type="button"
                  onClick={() => onSpawnTask(extractTaskBlock(lines, i))}
                  title="Spawn a focused workflow on this task (includes any sub-items)"
                  className="display-font"
                  style={{
                    flexShrink: 0,
                    marginLeft: '6px',
                    padding: '2px 6px',
                    background: 'transparent',
                    border: '1px solid var(--color-accent-secondary-dim)',
                    borderRadius: '3px',
                    color: 'var(--color-accent-secondary-dim)',
                    cursor: 'pointer',
                    fontSize: '9px',
                    letterSpacing: '1px',
                    lineHeight: 1.4,
                  }}
                >
                  ▷ SPAWN
                </button>
              )}
              {onPromoteTask && !checked && rest.trim().length > 0 && (
                <button
                  type="button"
                  onClick={() => onPromoteTask(rest.trim())}
                  title="Promote this plan item into a durable board task"
                  className="display-font"
                  style={{
                    flexShrink: 0,
                    marginLeft: '6px',
                    padding: '2px 6px',
                    background: 'transparent',
                    border: '1px solid var(--color-accent-primary)',
                    borderRadius: '3px',
                    color: 'var(--color-accent-primary)',
                    cursor: 'pointer',
                    fontSize: '9px',
                    letterSpacing: '1px',
                    lineHeight: 1.4,
                  }}
                >
                  → TASK
                </button>
              )}
            </div>
          );
        }
        const h3Match = line.match(/^###\s+(.+?)\s*$/);
        if (h3Match && (onReviewPhase || onSpawnPhase || onVerifyPhase)) {
          const heading = h3Match[1];
          const pillStyle: CSSProperties = {
            flexShrink: 0,
            padding: '2px 6px',
            background: 'transparent',
            border: '1px solid var(--color-accent-secondary-dim)',
            borderRadius: '3px',
            color: 'var(--color-accent-secondary-dim)',
            cursor: 'pointer',
            fontSize: '9px',
            letterSpacing: '1px',
            lineHeight: 1.4,
          };
          // Each pill on its own line — labels are long enough that flex-row
          // wrap reads as cramped, and stacking keeps the heading clearly
          // separated from the actions.
          const phasePillRow: CSSProperties = { display: 'flex', justifyContent: 'flex-start' };
          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '6px' }}>
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{line}</div>
              {onReviewPhase && (
                <div style={phasePillRow}>
                  <button
                    type="button"
                    onClick={() => onReviewPhase(heading)}
                    title={`Critique the structure of "${heading}"`}
                    className="display-font"
                    style={pillStyle}
                  >
                    ▷ REVIEW PHASE PLAN
                  </button>
                </div>
              )}
              {onVerifyPhase && (
                <div style={phasePillRow}>
                  <button
                    type="button"
                    onClick={() => onVerifyPhase(heading)}
                    title={`Verify the claimed-done items in "${heading}" against git diff + tools`}
                    className="display-font"
                    style={pillStyle}
                  >
                    ▷ VERIFY PHASE WORK
                  </button>
                </div>
              )}
              {onSpawnPhase && (
                <div style={phasePillRow}>
                  <button
                    type="button"
                    onClick={() => onSpawnPhase(extractPhaseBlock(lines, i))}
                    title={`Spawn a worker to complete every task in "${heading}"`}
                    className="display-font"
                    style={pillStyle}
                  >
                    ▷ SPAWN PHASE
                  </button>
                </div>
              )}
            </div>
          );
        }
        return (
          <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {line ? withRefs(line) : ' '}
          </div>
        );
      })}
    </div>
  );
}
