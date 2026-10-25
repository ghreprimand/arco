import { useEffect, useRef, useState } from 'react';
import { useNotificationStore, unreadCount } from '../stores/notificationStore';
import { WORKBENCH_NOTICE_CATEGORIES } from '@archon/shared';
import type { WorkbenchNoticeCategory, WorkbenchNoticeSeverity } from '@archon/shared';

// ARCHON_OPS_PLAN.md §J1 — the header notice center: a bell with an unread
// badge that opens the durable notice history + per-category mute toggles.
// Inform-only — nothing here sends a command; the only outbound action is the
// mute preference (`onSetMutes`, persisted server-side).

const CATEGORY_LABEL: Record<WorkbenchNoticeCategory, string> = {
  'computer-watch': 'Computer watches',
  'turn-finished': 'Turn finished',
  'quota-recovered': 'Quota recovered',
  'auth-expired': 'Auth expired',
  'cluster-nudge': 'Cluster member idle',
  'terminal-exited': 'Terminal exited',
  'preview-failed': 'Preview failed',
  'pr-status': 'PR / check status',
  backup: 'Backup',
};

const severityColor: Record<WorkbenchNoticeSeverity, string> = {
  info: 'var(--color-accent-primary-dim)',
  success: 'var(--color-accent-primary)',
  warning: 'var(--color-warning)',
  error: 'var(--color-danger)',
};

function relativeTime(ts: number): string {
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function NotificationCenter({ onSetMutes }: { onSetMutes: (muted: WorkbenchNoticeCategory[]) => void }) {
  const notices = useNotificationStore((s) => s.notices);
  const muted = useNotificationStore((s) => s.muted);
  const unread = useNotificationStore(unreadCount);
  const markAllSeen = useNotificationStore((s) => s.markAllSeen);
  const clearHistory = useNotificationStore((s) => s.clearHistory);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Opening the center clears the unread badge.
  useEffect(() => { if (open) markAllSeen(); }, [open, markAllSeen]);

  const toggleMute = (cat: WorkbenchNoticeCategory) => {
    const next = muted.includes(cat) ? muted.filter((c) => c !== cat) : [...muted, cat];
    onSetMutes(next);
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        data-help="header.notifications"
        className="display-font"
        title="Notifications — workbench event notices + per-category mute"
        style={{
          position: 'relative',
          background: open ? 'var(--color-accent-primary-a10)' : 'transparent',
          border: '1px solid var(--color-border-hairline)',
          borderRadius: '3px',
          color: 'var(--color-accent-primary-dim)',
          cursor: 'pointer',
          fontSize: '11px',
          letterSpacing: '1px',
          padding: '3px 8px',
        }}
      >
        ◔ BELL
        {unread > 0 && (
          <span
            style={{
              position: 'absolute',
              top: '-5px',
              right: '-5px',
              minWidth: '14px',
              height: '14px',
              padding: '0 3px',
              borderRadius: '7px',
              background: 'var(--color-danger)',
              color: '#fff',
              fontSize: '8px',
              lineHeight: '14px',
              textAlign: 'center',
              fontFamily: 'var(--font-display)',
            }}
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            width: '320px',
            maxHeight: '460px',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--color-bg-panel)',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '4px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
            fontFamily: 'var(--font-content)',
            fontSize: '11px',
            zIndex: 20,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', borderBottom: '1px solid var(--color-border-hairline)' }}>
            <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)' }}>NOTIFICATIONS</span>
            {notices.length > 0 && (
              <button
                onClick={clearHistory}
                className="display-font"
                title="Clear notice history"
                style={{ background: 'transparent', border: 'none', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '9px', letterSpacing: '1px' }}
              >
                CLEAR
              </button>
            )}
          </div>

          {/* Notice list */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {notices.length === 0 ? (
              <div style={{ padding: '16px 10px', color: 'var(--color-fg-muted)', textAlign: 'center' }}>No notices yet.</div>
            ) : (
              notices.map((n) => (
                <div key={n.id} style={{ padding: '8px 10px', borderBottom: '1px solid var(--color-border-hairline)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                    <span className="display-font" style={{ fontSize: '10px', letterSpacing: '0.5px', color: severityColor[n.severity] }}>{n.title}</span>
                    <span style={{ color: 'var(--color-fg-muted)', fontSize: '9px', whiteSpace: 'nowrap' }}>{relativeTime(n.ts)}</span>
                  </div>
                  {n.body && <div style={{ color: 'var(--color-fg-muted)', marginTop: '2px', lineHeight: 1.4 }}>{n.body}</div>}
                </div>
              ))
            )}
          </div>

          {/* Mute toggles */}
          <div style={{ padding: '8px 10px', borderTop: '1px solid var(--color-border-hairline)' }}>
            <div className="display-font" style={{ fontSize: '9px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)', marginBottom: '6px' }}>MUTE CATEGORIES</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 10px' }}>
              {WORKBENCH_NOTICE_CATEGORIES.map((cat) => {
                const isMuted = muted.includes(cat);
                return (
                  <label key={cat} style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', color: isMuted ? 'var(--color-fg-muted)' : 'var(--color-accent-primary-dim)' }}>
                    <input type="checkbox" checked={isMuted} onChange={() => toggleMute(cat)} style={{ cursor: 'pointer' }} />
                    <span style={{ fontSize: '10px' }}>{CATEGORY_LABEL[cat]}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
