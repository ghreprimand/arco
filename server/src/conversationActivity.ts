import path from 'node:path';

interface Activity { revision: number; writers: number }
const activity = new Map<string, Activity>();
function entry(cwd: string, workflowId: string): Activity {
  const key = `${path.resolve(cwd)}\0${workflowId}`;
  let value = activity.get(key);
  if (!value) { value = { revision: 0, writers: 0 }; activity.set(key, value); }
  return value;
}

export function noteConversationActivity(cwd: string, workflowId: string): void {
  entry(cwd, workflowId).revision++;
}
export function beginConversationWrite(cwd: string, workflowId: string): () => void {
  const value = entry(cwd, workflowId);
  value.revision++; value.writers++;
  return () => { value.writers--; };
}

// A synchronous final check and removal cannot interleave with new JS writers.
export function conversationUnchanged(cwd: string, workflowId: string): () => boolean {
  const value = entry(cwd, workflowId), revision = value.revision;
  const idle = value.writers === 0;
  return () => idle && value.writers === 0 && value.revision === revision;
}
