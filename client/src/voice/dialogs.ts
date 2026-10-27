// docs/VOICE.md - Computer's "open this dialog" tool. Incident
// (2026-10-17): "bring up the nudge dialogue box for this workflow" became
// an arco_nudge to the focused member because the only nudge-shaped tool
// SENT the nudge; the operator wanted the picker to choose. A dialog
// request is a synchronous DOM event: the component that owns the dialog
// state answers it and marks it handled, so the executor can tell Computer
// whether anything opened instead of claiming success.
export const VOICE_DIALOGS = ['nudge', 'broadcast', 'review', 'handoff', 'spawn', 'plan', 'docs', 'git', 'tuneup', 'research', 'transcript'] as const;
export type VoiceDialog = typeof VOICE_DIALOGS[number];
export interface VoiceDialogRequest { name: VoiceDialog; jobId: string | null; clusterId: string | null; handled: boolean }
export const VOICE_DIALOG_EVENT = 'arco:voice-dialog';

export function requestVoiceDialog(name: VoiceDialog, jobId: string | null, clusterId: string | null): boolean {
  if (typeof window === 'undefined') return false;
  const detail: VoiceDialogRequest = { name, jobId, clusterId, handled: false };
  window.dispatchEvent(new CustomEvent<VoiceDialogRequest>(VOICE_DIALOG_EVENT, { detail }));
  return detail.handled;
}

// Subscribe a dialog owner. The handler returns true when it opened the
// dialog; the first owner to do so wins and later ones see handled=true.
export function onVoiceDialog(handler: (request: VoiceDialogRequest) => boolean): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<VoiceDialogRequest>).detail;
    if (!detail || detail.handled) return;
    if (handler(detail)) detail.handled = true;
  };
  window.addEventListener(VOICE_DIALOG_EVENT, listener);
  return () => window.removeEventListener(VOICE_DIALOG_EVENT, listener);
}
