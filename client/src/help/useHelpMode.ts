import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';

// Drives the contextual help mode side effects:
//   1. Toggles body.help-mode (CSS in styles/contextual-help.css keys off this)
//   2. Capture-phase click listener intercepts clicks on [data-help] elements
//      and surfaces them as popovers; clicks outside any [data-help] dismiss
//      an open popover. The capture phase fires before any React synthetic
//      handler so we beat normal button/input behavior.
//   3. Escape exits help mode.
//
// Centralizing here means App.tsx mounts the hook once and the rest of the
// codebase only needs to add data-help attributes.
export function useHelpMode() {
  const helpMode = useAppStore((s) => s.helpMode);
  const setHelpMode = useAppStore((s) => s.setHelpMode);
  const setActiveHelpPopover = useAppStore((s) => s.setActiveHelpPopover);

  // Toggle the body class (CSS reads body.help-mode and applies the
  // pointer-events / outline-on-hover overlay).
  useEffect(() => {
    if (helpMode) document.body.classList.add('help-mode');
    else document.body.classList.remove('help-mode');
    if (!helpMode) setActiveHelpPopover(null);
    return () => document.body.classList.remove('help-mode');
  }, [helpMode, setActiveHelpPopover]);

  // Capture-phase click handler. Three cases:
  //   - click on the help system's own UI (toggle button, banner, popover) →
  //     do nothing here, let the component handle it.
  //   - click on a [data-help] element → swallow the original event and open
  //     the popover keyed to the element's data-help attribute.
  //   - click anywhere else → dismiss the popover. Help mode stays on.
  useEffect(() => {
    if (!helpMode) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.help-system-ui')) return;

      const helpEl = target.closest('[data-help]') as HTMLElement | null;
      if (helpEl) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const key = helpEl.getAttribute('data-help') ?? '';
        const rect = helpEl.getBoundingClientRect();
        setActiveHelpPopover({
          key,
          anchorRect: {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            width: rect.width,
            height: rect.height,
          },
        });
      } else {
        e.preventDefault();
        e.stopPropagation();
        setActiveHelpPopover(null);
      }
    };
    document.body.addEventListener('click', handler, true);
    return () => document.body.removeEventListener('click', handler, true);
  }, [helpMode, setActiveHelpPopover]);

  // Escape exits help mode. Don't fight Settings/Manual modals — when they're
  // open they'll have higher-priority Escape handlers; but this one runs at
  // the document level so it will fire if nothing else stops it.
  useEffect(() => {
    if (!helpMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHelpMode(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [helpMode, setHelpMode]);
}
