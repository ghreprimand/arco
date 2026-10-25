// Phase 2.5.1 — top-right toast strip for transient notifications.
// Fed by `useAppStore.notifications` (pushed from useWebSocket's `error`
// handler). Each toast auto-dismisses 6s after its `createdAt`; operator
// can click × to dismiss early. No animation — fade-in is browser default
// on mount; dismissal is instant.

import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';

const DISMISS_AFTER_MS = 6000;

export function NotificationToasts() {
  const notifications = useAppStore((s) => s.notifications);
  const dismiss = useAppStore((s) => s.dismissNotification);

  useEffect(() => {
    if (notifications.length === 0) return;
    const timers = notifications.map((n) => {
      const remaining = Math.max(0, DISMISS_AFTER_MS - (Date.now() - n.createdAt));
      return setTimeout(() => dismiss(n.id), remaining);
    });
    return () => { for (const t of timers) clearTimeout(t); };
  }, [notifications, dismiss]);

  if (notifications.length === 0) return null;

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
          <span style={{ flex: 1, wordBreak: 'break-word' }}>{n.message}</span>
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
