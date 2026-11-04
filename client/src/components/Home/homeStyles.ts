import type { OpenWorkItem } from '../../utils/homeModel';

export const box = { border: '1px solid var(--color-border-hairline)', borderRadius: 4, background: 'var(--color-bg-sunken)' } as const;
export const action = {
  padding: '5px 10px', cursor: 'pointer', color: 'var(--color-fg)', background: 'var(--color-bg-elevated)',
  border: '1px solid var(--color-border-hairline)', borderRadius: 3, fontSize: '12px', fontFamily: 'var(--font-body)',
} as const;
export const primary = { ...action, color: 'var(--color-accent-primary)', borderColor: 'var(--color-accent-primary-dim)' } as const;
export const muted = { color: 'var(--color-fg-muted)', fontSize: '12px', fontFamily: 'var(--font-body)' } as const;
export const field = {
  flex: '1 1 220px', minWidth: 0, padding: '6px 10px', background: 'var(--color-bg-elevated)',
  border: '1px solid var(--color-border-hairline)', borderRadius: 3, color: 'var(--color-fg)', fontSize: '12px',
} as const;

export const KIND_LABEL: Record<OpenWorkItem['kind'], string> = { workflow: 'Session', chat: 'Chat', cluster: 'Cluster' };
export const when = (t: number) => (t > 0 ? new Date(t).toLocaleString() : '');
