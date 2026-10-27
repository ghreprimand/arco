// Compare composer-button helpers - docs/ARCHITECTURE.md
//
// Extracted from TerminalInput.tsx to keep that file under the 2000-line cap:
// the COMPARE button's dispatch logic (open the dialog, fire the request
// through the compareStore module-level sender) lives here, NOT inline. The
// button in TerminalInput is just an onClick into openCompareDialog; the dialog
// + the results grid are rendered by the globally-mounted CompareOverlay, so
// TerminalInput needs no extra render branch.

import type { CompareLegConfig } from '@arco/shared';
import { useCompareStore, sendCompareRequest } from '../../stores/compareStore';

// Open the compare dialog for a workflow. (The dialog and the results grid are
// globally mounted off compareStore, so the button only needs to flip the flag.)
export function openCompareDialog(workflowId: string): void {
  useCompareStore.getState().openDialog(workflowId);
}

// Dispatch a race — called by the dialog's confirm. Fires the request through
// the registered WS sender; lifecycle arrives via the compare_* events.
export function dispatchCompare(workflowId: string, prompt: string, legs: CompareLegConfig[], blind: boolean): void {
  sendCompareRequest({ workflowId, prompt, legs, blind });
}
