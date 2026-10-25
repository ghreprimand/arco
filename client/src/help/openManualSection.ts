import { useAppStore } from '../stores/appStore';

// WORKBENCH_EXPANSION §J3 — the single clean bridge from anywhere in the app to
// "open the User Manual scrolled to section X". Wraps the machinery that already
// works: open the modal via the store, then dispatch the window CustomEvent the
// UserManual listens for. Callers (HelpPopover's "READ MORE IN MANUAL" link and
// the in-modal <ModalHelpButton>) route through here so the open+jump dance
// lives in exactly one place.
//
// Why the setTimeout: the Manual reads its target section from the window event
// rather than threading state through props, so the listener must be mounted
// before we dispatch. Deferring to the next tick guarantees the modal (which we
// just flipped on) has rendered its effect-registered listener.
export function openManualSection(sectionId: string): void {
  useAppStore.getState().setShowManual(true);
  setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent('arco:manual-jump', { detail: { sectionId } }),
    );
  }, 0);
}
