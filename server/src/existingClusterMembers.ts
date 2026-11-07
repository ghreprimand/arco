import { memberProvider } from './localCapacity.js';

// A cached Cursor ACP session receives its peer tools only at session start.
// Fresh cluster members remain supported; joining a live session cannot add them.
export function existingClusterMemberRefusal(workflowIds: readonly string[]): string | null {
  return workflowIds.some((id) => memberProvider(id) === 'cursor')
    ? 'Existing Cursor tabs started without cluster peer tools; use + ADD FRESH to create a Cursor member.'
    : null;
}
