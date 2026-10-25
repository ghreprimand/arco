import type { ReactNode } from 'react';

// Shared presentational bits + the HelpEntry type for the contextual-help
// content registry. The per-area files (header / tabbar / composer / …) import
// from here; index.tsx assembles them into HELP_CONTENT.
//
// Conventions for keys:
//   <area>.<element>           e.g. header.settings
//   <area>.<sub>.<element>     e.g. composer.footer.ctx
// Hyphens are fine; prefer dotted-segments to keep the keyspace organized.
//
// Body content is JSX (typesafe; no dangerouslySetInnerHTML). Keep entries
// short — 1–3 sentences plus optional bullet list. The Manual modal is the
// long-form reference; this is the at-a-glance hint surface.

export interface HelpEntry {
  title: string;
  body: ReactNode;
  // Optional cross-reference to a Manual section id; when set, the popover
  // shows a "Read more in MANUAL" link that opens the Manual at that section.
  manualSection?: string;
}

export const C = ({ children }: { children: ReactNode }) => (
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
