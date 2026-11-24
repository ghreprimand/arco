import { useEffect, useMemo, useState } from 'react';
import { useNotificationStore } from '../stores/notificationStore';
import { useAppStore } from '../stores/appStore';
import { usePhonePageChrome } from '../stores/phoneStore';

// The phone page keeps the workbench notice store and opens the same workflow.
export function MobileNotices({ onOpen }: { onOpen: (workflowId: string) => void }) {
  const notices = useNotificationStore((s) => s.notices);
  const markAllSeen = useNotificationStore((s) => s.markAllSeen);
  const clearHistory = useNotificationStore((s) => s.clearHistory);
  const jobs = useAppStore((s) => s.jobs);
  const [lastSeen] = useState(() => useNotificationStore.getState().lastSeenTs);
  const chrome = useMemo(() => ({ actions: [{ id: 'clear-notices', label: 'CLEAR ALL', onSelect: clearHistory, disabled: !notices.length }] }), [clearHistory, notices.length]);
  usePhonePageChrome(true, chrome);
  useEffect(() => { markAllSeen(); }, [markAllSeen, notices.length]);
  const ordered = [...notices].sort((a, b) => Number(b.ts > lastSeen) - Number(a.ts > lastSeen) || b.ts - a.ts);
  return <div data-help="header.notifications" style={{ color: 'var(--color-fg)' }}>
    {!ordered.length && <p style={{ padding: '12px' }}>No notices.</p>}
    {ordered.map((notice) => {
      const where = notice.workflowId ? jobs[notice.workflowId]?.config.name : undefined;
      const content = <><strong>{notice.title}</strong>{notice.body && <span>{notice.body}</span>}<small>{where ? `${where} · ` : ''}{new Date(notice.ts).toLocaleString()}{notice.ts > lastSeen ? ' · NEW' : ''}</small></>;
      const style = { display: 'grid', gap: 4, width: '100%', minHeight: 52, textAlign: 'left' as const, padding: '10px 12px', border: 0, borderBottom: '1px solid var(--color-border-hairline)', background: 'transparent', color: 'var(--color-fg)', overflowWrap: 'anywhere' as const };
      return notice.workflowId ? <button key={notice.id} type="button" onClick={() => onOpen(notice.workflowId!)} style={style}>{content}</button> : <article key={notice.id} style={style}>{content}</article>;
    })}
  </div>;
}
