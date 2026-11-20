// A seam between broadcastWorkflow and directorContinue.ts, so the broadcast
// module does not import the board and mailbox code it would otherwise pull
// into a cycle. directorContinue.configure() installs the observer.

import type { ServerMessage } from '@arco/shared';

let observer: ((workflowId: string, message: ServerMessage) => void) | undefined;

export function setDirectorContinueObserver(fn: (workflowId: string, message: ServerMessage) => void): void {
  observer = fn;
}

export function observeForDirectorContinue(workflowId: string, message: ServerMessage): void {
  try { observer?.(workflowId, message); } catch (err) { console.error('[arco] director continue observer failed:', err); }
}
