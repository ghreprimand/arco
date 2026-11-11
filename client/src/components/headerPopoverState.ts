import { useEffect } from 'react';

// Only header popovers subscribe: closing them must not send keyboard events
// to unrelated dialogs, draft fields, voice controls or help handlers.
const closers = new Set<() => void>();
export function closeHeaderPopovers(): void {
  for (const close of closers) close();
}
export function useCloseHeaderPopover(setOpen: (open: boolean) => void): void {
  useEffect(() => {
    const close = () => setOpen(false);
    closers.add(close);
    return () => { closers.delete(close); };
  }, [setOpen]);
}
