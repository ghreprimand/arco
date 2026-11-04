import { UpdateResultNotice } from './UpdateResultNotice';
import { AppUpdateNotice } from './AppUpdateNotice';
// Phase 2.5.1 — top-right toast strip for transient notifications.
// Fed by `useAppStore.notifications` (pushed from useWebSocket's `error`
// handler). Each toast auto-dismisses 6s after its `createdAt`; operator
// can click × to dismiss early. No animation — fade-in is browser default
// on mount; dismissal is instant.

import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { findDirector } from './clusterSurface.helpers';

const DISMISS_AFTER_MS = 6000;

export function NotificationToasts() {
  const notifications = useAppStore((s) => s.notifications);
  const dismiss = useAppStore((s) => s.dismissNotification);
  const focusQuestion = (workflowId: string) => {
    const state = useAppStore.getState();
    const cluster = Object.values(state.clusters).find((c) => c.members.some((m) => m.workflowId === workflowId));
    if (cluster) { state.setActiveCluster(cluster.clusterId); state.setClusterFocusedMember(cluster.clusterId, workflowId); }
    else state.setActiveJob(workflowId);
  };

  // GO TO DIRECTOR: offered on a question toast from a cluster member other
  // than the director. A click focuses the director; nothing moves on its own.
  const directorFor = (workflowId: string) => {
    const state = useAppStore.getState();
    const cluster = Object.values(state.clusters).find((c) => c.members.some((m) => m.workflowId === workflowId));
    const director = cluster ? findDirector(cluster.members) : undefined;
    return cluster && director && director.workflowId !== workflowId ? { clusterId: cluster.clusterId, workflowId: director.workflowId } : null;
  };
  const goToDirector = (target: { clusterId: string; workflowId: string }) => {
    const state = useAppStore.getState();
    state.setActiveCluster(target.clusterId);
    state.setClusterFocusedMember(target.clusterId, target.workflowId);
  };

  useEffect(() => {
    if (notifications.length === 0) return;
    const timers = notifications.map((n) => {
      const remaining = Math.max(0, DISMISS_AFTER_MS - (Date.now() - n.createdAt));
      return setTimeout(() => dismiss(n.id), remaining);
    });
    return () => { for (const t of timers) clearTimeout(t); };
  }, [notifications, dismiss]);


  return (
    <div
      style={{
        position: 'fixed',
        top: '16px',
        right: '16px',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        maxWidth: '420px',
        pointerEvents: 'none',
      }}
    >
      <UpdateResultNotice />
      <AppUpdateNotice />
      {notifications.map((n) => (
        <div
          key={n.id}
          style={{
            pointerEvents: 'auto',
            padding: '10px 12px',
            background: 'var(--color-bg-panel)',
            border: `1px solid ${n.level === 'error' ? 'var(--color-warning)' : 'var(--color-accent-primary)'}`,
            color: 'var(--color-fg)',
            fontSize: '11px',
            fontFamily: 'var(--font-code)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}
        >
          <span
            className="display-font"
            style={{
              color: n.level === 'error' ? 'var(--color-warning)' : 'var(--color-accent-primary)',
              fontSize: '10px',
              letterSpacing: '1px',
              flexShrink: 0,
            }}
          >
            {n.level === 'error' ? 'ERROR' : 'INFO'}
          </span>
          {n.workflowId ? <button data-help="header.question-toast" onClick={() => { focusQuestion(n.workflowId!); dismiss(n.id); }} style={{ flex: 1, textAlign: 'left', wordBreak: 'break-word', color: 'inherit', background: 'none', border: 0, cursor: 'pointer' }}>{n.message}</button> : <span style={{ flex: 1, wordBreak: 'break-word' }}>{n.message}</span>}
          {n.action?.kind === 'open-recall' && (
            <button
              data-testid="toast-open-recall"
              onClick={() => { useAppStore.getState().setShowRecall(true); dismiss(n.id); }}
              style={{ background: 'transparent', border: 'none', color: 'var(--color-accent-primary)', cursor: 'pointer', fontSize: '11px', padding: 0, textDecoration: 'underline', flexShrink: 0 }}
            >
              {n.action.label}
            </button>
          )}
          {n.workflowId && (() => {
            const director = directorFor(n.workflowId!);
            return director ? <button type="button" data-testid="toast-go-to-director" className="display-font" onClick={() => { goToDirector(director); dismiss(n.id); }} style={{ flexShrink: 0, background: 'transparent', border: '1px solid var(--color-border-hairline)', color: 'var(--color-accent-primary)', cursor: 'pointer', fontSize: '9px', letterSpacing: '1px', padding: '1px 5px' }}>GO TO DIRECTOR</button> : null;
          })()}
          <button
            onClick={() => dismiss(n.id)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '14px',
              lineHeight: 1,
              padding: 0,
            }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
