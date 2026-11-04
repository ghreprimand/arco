import type { ReactNode } from 'react';
import { useAppStore } from '../../stores/appStore';

// Inline file-path chip. Looks like the existing <code> chip but is
// click-to-open: triggers the DocViewer modal with the given path.
//
// Use for *real* repo-relative paths (docs/ARCHITECTURE.md, shared/src/
// protocol.ts, etc.) — anything actually loadable via /api/docs.
//
// Path is taken from the children when no explicit `path` prop is given,
// so the common case (`<DocRef>shared/src/protocol.ts</DocRef>`) doesn't
// duplicate the string.
interface Props {
  path?: string;
  children: ReactNode;
}

export function DocRef({ path, children }: Props) {
  const setActiveDocRef = useAppStore((s) => s.setActiveDocRef);
  const resolved = path ?? (typeof children === 'string' ? children : '');

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setActiveDocRef({ path: resolved });
      }}
      title={`Open ${resolved}`}
      style={{
        background: 'var(--color-bg-sunken)',
        border: '1px solid var(--color-accent-primary-dim)',
        borderRadius: '2px',
        padding: '0 4px',
        fontFamily: 'var(--font-code, monospace)',
        fontSize: '11px',
        color: 'var(--color-accent-primary)',
        cursor: 'pointer',
        textDecoration: 'underline dotted transparent',
        textUnderlineOffset: '3px',
        transition: 'border-color 0.12s, text-decoration-color 0.12s, background 0.12s',
        verticalAlign: 'baseline',
        lineHeight: 'inherit',
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget;
        el.style.borderColor = 'var(--color-accent-primary)';
        el.style.textDecorationColor = 'var(--color-accent-primary)';
        el.style.background = 'var(--color-accent-primary-a05)';
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget;
        el.style.borderColor = 'var(--color-accent-primary-dim)';
        el.style.textDecorationColor = 'transparent';
        el.style.background = 'var(--color-bg-sunken)';
      }}
    >
      {children}
    </button>
  );
}
