import { useTabStatusStore, tabKey } from '../stores/tabStatusStore';
import { tabStatus, TAB_STATUS_HINT, TAB_STATUS_LABEL, type TabStatus } from '../utils/tabStatus';

const COLOR: Record<TabStatus, string> = {
  'needs-you': 'var(--color-warning)',
  working: 'var(--color-accent-primary)',
  'new-reply': 'var(--color-accent-primary)',
  idle: 'var(--color-fg-muted)',
};

export function useTabStatus(kind: 'job' | 'cluster', id: string, waiting: boolean, busy: boolean): TabStatus {
  const unviewed = useTabStatusStore((s) => !!s.unviewed[tabKey(kind, id)]);
  return tabStatus({ waiting, busy, unviewed });
}

/** The one status word for a tab or card. Text is always present, never colour alone. */
export function TabStatusChip({ status, compact = false }: { status: TabStatus; compact?: boolean }) {
  if (compact) {
    // Tab strip: the colored dot only; the word is the hover text and the accessible name.
    // Idle shows nothing (the empty marker keeps the status readable by tests and tools).
    const shown = status !== 'idle';
    return (
      <span
        data-help="tabbar.status"
        data-tab-status={status}
        {...(shown ? { role: 'img', 'aria-label': TAB_STATUS_LABEL[status], title: TAB_STATUS_LABEL[status] } : { 'aria-hidden': true })}
        style={{
          display: 'inline-block',
          flexShrink: 0,
          width: shown ? 8 : 0,
          height: shown ? 8 : 0,
          borderRadius: '50%',
          background: shown ? COLOR[status] : 'transparent',
          opacity: status === 'new-reply' ? 0.6 : 1,
          animation: status === 'working' ? 'pulse-glow 1.5s ease-in-out infinite' : undefined,
        }}
      />
    );
  }
  return (
    <span
      data-help="tabbar.status"
      data-tab-status={status}
      title={TAB_STATUS_HINT[status]}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        flexShrink: 0,
        fontSize: '11px',
        letterSpacing: '0.3px',
        textTransform: 'uppercase',
        color: COLOR[status],
        opacity: status === 'idle' ? 0.7 : 1,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: status === 'idle' ? 'transparent' : COLOR[status],
          border: `1px solid ${COLOR[status]}`,
          animation: status === 'working' ? 'pulse-glow 1.5s ease-in-out infinite' : undefined,
        }}
      />
      {TAB_STATUS_LABEL[status]}
    </span>
  );
}
