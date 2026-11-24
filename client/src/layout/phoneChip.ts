// docs/CLIENT.md "Mobile view" - one row of filter chips on a phone page, in
// place of a tab row: 44 px targets that wrap, in the workbench's colours.
import type { CSSProperties } from 'react';

export const phoneChipRow: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '8px 10px', borderBottom: '1px solid var(--color-border-hairline)', overflowX: 'visible' };

export function phoneChip(active: boolean): CSSProperties {
  return {
    flex: '0 0 auto', minHeight: '44px', padding: '0 12px', fontFamily: 'var(--font-display)', fontSize: '12px', letterSpacing: '1.5px', cursor: 'pointer',
    background: active ? 'var(--color-accent-primary-a08)' : 'transparent',
    border: `1px solid ${active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
    color: active ? 'var(--color-accent-primary)' : 'var(--color-fg)',
  };
}
