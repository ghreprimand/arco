import { useEffect, useState } from 'react';
import { activeActivity } from '../utils/activityPresentation';
import type { JobState } from '../stores/appStore';

// Hold the visible step long enough to read; newer events replace it after
// the hold expires. The tooltip retains the complete, untruncated text.
export function PrimaryStatus({ job }: { job: JobState }) {
  const next = activeActivity(job.activity ?? [], job.turnStartedAt);
  const [shown, setShown] = useState(() => ({ ...next, displayedAt: Date.now() }));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (shown.key === next.key && shown.label === next.label) return;
    const delay = Math.max(0, 1500 - (Date.now() - shown.displayedAt));
    const timer = setTimeout(() => setShown({ key: next.key, label: next.label, at: next.at, displayedAt: Date.now() }), delay);
    return () => clearTimeout(timer);
  }, [next.key, next.label, next.at, shown.key, shown.label, shown.displayedAt]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - shown.at) / 1000));
  const time = seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const text = `${shown.label} (${time})${seconds > 60 ? ' · LONG-RUNNING' : ''}`;
  return <span data-help="composer.turn-step" data-testid="header-turn-step" title={text} className="display-font" style={{ color: 'var(--color-warning)', fontSize: '11px', minWidth: 0, flex: '1 1 0', display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
    <span aria-hidden="true" style={{ flexShrink: 0 }}>◦</span><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
  </span>;
}
