import { lazy, Suspense } from 'react';
import type { Props } from './XtermView';

// Code-split gate for the xterm.js terminal view (2026-08-06).
//
// XtermView is the only importer of @xterm/xterm (~290 KB) + @xterm/addon-fit.
// Both of its consumers used to import it statically, so that payload sat in
// the main chunk and every page load paid to parse a terminal emulator even
// if the operator never opened one.
//
// Splitting is safe here because neither consumer mounts a terminal eagerly:
// FloatingTerminalWindow maps over `useTerminalStore().windows` (empty until
// the operator opens a window) and TerminalPopout only renders in the
// dedicated `?popout=` window. So in the normal app the chunk is fetched the
// first time a terminal actually opens, then cached for the session.
//
// `import type { Props }` is erased at compile time — it creates no runtime
// edge to XtermView, so the split holds.
const XtermViewImpl = lazy(() => import('./XtermView').then((m) => ({ default: m.XtermView })));

export function XtermViewLazy(props: Props) {
  // The fallback fills the terminal's box so the window doesn't collapse and
  // reflow while the chunk loads. Matches the surrounding surface rather than
  // flashing a themed panel colour.
  return (
    <Suspense
      fallback={
        <div
          style={{
            width: '100%',
            height: '100%',
            background: 'var(--color-bg-input)',
            color: 'var(--color-fg-muted)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '12px',
          }}
        >
          starting terminal…
        </div>
      }
    >
      <XtermViewImpl {...props} />
    </Suspense>
  );
}
