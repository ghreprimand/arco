import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Tiny presentational helpers — keep manual content readable inline.
// ---------------------------------------------------------------------------

export function Code({ children }: { children: ReactNode }) {
  return (
    <code
      style={{
        background: 'var(--color-bg-sunken)',
        border: '1px solid var(--color-border-hairline)',
        borderRadius: '2px',
        padding: '0 4px',
        fontFamily: 'var(--font-code, monospace)',
        fontSize: '11px',
        color: 'var(--color-accent-primary-dim)',
      }}
    >
      {children}
    </code>
  );
}

export function Pre({ children }: { children: string }) {
  return (
    <pre
      style={{
        background: 'var(--color-bg-sunken)',
        border: '1px solid var(--color-border-hairline)',
        borderRadius: '3px',
        padding: '10px 12px',
        fontFamily: 'var(--font-code, monospace)',
        fontSize: '11px',
        color: 'var(--color-accent-primary-dim)',
        overflowX: 'auto',
        margin: '8px 0',
      }}
    >
      {children}
    </pre>
  );
}

export function Note({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'tip'; children: ReactNode }) {
  const palette = {
    info: { bg: 'var(--color-accent-primary-a05)', border: 'var(--color-accent-primary-dim)', label: 'NOTE' },
    warn: { bg: 'rgba(255,180,80,0.07)', border: 'var(--color-warning)', label: 'WATCH OUT' },
    tip: { bg: 'rgba(120,255,180,0.06)', border: 'var(--color-accent-secondary)', label: 'TIP' },
  }[kind];
  return (
    <div
      style={{
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderLeft: `3px solid ${palette.border}`,
        padding: '8px 12px',
        margin: '10px 0',
        borderRadius: '3px',
        fontSize: '12px',
      }}
    >
      <div
        className="display-font"
        style={{
          fontSize: '9px',
          letterSpacing: '2px',
          color: palette.border,
          marginBottom: '4px',
        }}
      >
        {palette.label}
      </div>
      {children}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-block',
        background: 'var(--color-bg-sunken)',
        border: '1px solid var(--color-border-hairline)',
        borderRadius: '3px',
        padding: '0 6px',
        fontFamily: 'var(--font-code, monospace)',
        fontSize: '11px',
        color: 'var(--color-fg)',
      }}
    >
      {children}
    </span>
  );
}

export function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <div style={{ overflowX: 'auto', margin: '10px 0' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                className="display-font"
                style={{
                  textAlign: 'left',
                  fontSize: '10px',
                  letterSpacing: '1.5px',
                  color: 'var(--color-fg-muted)',
                  borderBottom: '1px solid var(--color-border-hairline)',
                  padding: '6px 10px',
                  fontWeight: 400,
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    borderBottom: '1px solid var(--color-border-hairline)',
                    padding: '6px 10px',
                    verticalAlign: 'top',
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function stringifyNode(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(stringifyNode).join(' ');
  if (typeof node === 'object' && 'props' in (node as unknown as Record<string, unknown>)) {
    const element = node as unknown as { type?: unknown; props?: { children?: ReactNode; headers?: ReactNode; rows?: ReactNode } };
    // Manual tables store visible text in props, not children. Include it so
    // provider/capability and reference rows are searchable too.
    if (element.type === Table) return stringifyNode([element.props?.headers, element.props?.rows]);
    return stringifyNode(element.props?.children);
  }
  return '';
}
