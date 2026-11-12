// Needs-you counter for the cluster members header: review tasks with a
// director sign-off, tasks blocked on the operator, and members waiting on an
// answer. Click opens a list; picking a task opens the BOARD with it selected,
// picking a question focuses that member. Read-only: it never sends anything.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LedgerTask } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { requestBoardTask } from '../stores/boardTaskRequest';
import { hasWaitingQuestion } from '../questions/waitingQuestion';
import { buildNeedsYouItems, needsYouLabel, type NeedsYouItem } from './clusterNeedsYou';
import { useKeepInWindow } from '../layout/keepInWindow';

const EMPTY_TASKS: LedgerTask[] = [];
const KIND_LABEL: Record<NeedsYouItem['kind'], string> = {
  review: 'ACCEPT',
  blocked: 'BLOCKED',
  question: 'QUESTION',
};

export function NeedsYouBadge({ clusterId, compact = false }: { clusterId: string; compact?: boolean }) {
  const cluster = useAppStore((s) => s.clusters[clusterId]);
  const jobs = useAppStore((s) => s.jobs);
  const cwd = cluster?.cwd;
  const ledgerKey = cwd && cluster?.taskBoardKey ? `${cwd}::${cluster.taskBoardKey}` : cwd;
  const tasks = useAppStore((s) => (ledgerKey ? s.taskLedger[ledgerKey] : undefined)) ?? EMPTY_TASKS;
  const setClusterFocusedMember = useAppStore((s) => s.setClusterFocusedMember);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const placeRef = useKeepInWindow({ ref: popoverRef, anchor: buttonRef });

  const items = useMemo(() => {
    const waitingQuestions = (cluster?.members ?? [])
      .filter((m) => hasWaitingQuestion(jobs[m.workflowId]))
      .map((m) => ({ workflowId: m.workflowId, displayName: m.displayName }));
    // Done and archived tasks are never listed: only review and blocked count.
    return buildNeedsYouItems({ tasks, waitingQuestions });
  }, [cluster?.members, jobs, tasks]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => { if (items.length === 0) setOpen(false); }, [items.length]);

  if (!cluster || items.length === 0) return null;

  const toggle = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    // Interface scale is applied as root zoom, which scales fixed offsets too.
    const zoom = Number.parseFloat(document.documentElement.style.zoom) || 1;
    if (rect) setAnchor({ top: (rect.bottom + 4) / zoom, right: Math.max(8, (window.innerWidth - rect.right) / zoom) });
    setOpen((v) => !v);
  };
  const pick = (item: NeedsYouItem) => {
    setOpen(false);
    if (item.taskId) requestBoardTask(clusterId, item.taskId);
    else if (item.workflowId) setClusterFocusedMember(clusterId, item.workflowId);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="display-font"
        data-help="cluster.needs-you"
        data-testid="cluster-needs-you"
        aria-label={needsYouLabel(items.length)}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={toggle}
        title="Work waiting on you: tasks to accept, tasks blocked on you, and members with a question."
        style={{
          flex: '0 0 auto',
          marginLeft: compact ? 0 : '6px',
          width: compact ? '32px' : undefined,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          padding: compact ? '2px' : '2px 7px',
          fontSize: '9px',
          letterSpacing: compact ? 0 : '1px',
          color: '#e0a030',
          background: open ? 'var(--color-accent-primary-a06)' : 'transparent',
          border: '1px solid currentColor',
          cursor: 'pointer',
        }}
      >
        {compact ? `! ${items.length}` : needsYouLabel(items.length)}
      </button>
      {open && anchor && (
        <div
          ref={placeRef}
          role="menu"
          data-testid="cluster-needs-you-list"
          style={{
            position: 'fixed',
            top: anchor.top,
            right: anchor.right,
            zIndex: 1000,
            width: 'min(340px, calc(100vw / var(--ui-scale, 1) - 16px))',
            maxHeight: 'calc(50vh / var(--ui-scale, 1))',
            overflowY: 'auto',
            background: 'var(--color-bg-panel)',
            border: '1px solid var(--color-border-hairline)',
            padding: '4px',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
          }}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => pick(item)}
              style={{
                textAlign: 'left',
                background: 'transparent',
                border: '1px solid transparent',
                color: 'var(--color-fg)',
                padding: '5px 6px',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
                minWidth: 0,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-hairline)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'transparent'; }}
            >
              <span style={{ display: 'flex', gap: '6px', alignItems: 'baseline', minWidth: 0 }}>
                <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: '#e0a030', flexShrink: 0 }}>
                  {KIND_LABEL[item.kind]}
                </span>
                <span style={{ fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
              </span>
              {item.detail && (
                <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.detail}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
