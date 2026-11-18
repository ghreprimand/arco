import type { JobState } from '../stores/appStore';

export function runningCodexCommand(job: JobState | undefined) {
  return job?.codexLateCommands?.findLast(command => command.waitingUntil > Date.now());
}

// The tab's turn is open only because the agent waits on this command. A
// server or a command from an earlier turn is running, not waited on.
export function waitedCodexCommand(job: JobState | undefined) {
  return job?.busy ? job.codexLateCommands?.findLast(command => command.waiting && command.waitingUntil > Date.now()) : undefined;
}

export function CodexLateCommandLine({ job, header }: { job: JobState | undefined; header?: boolean }) {
  const waited = waitedCodexCommand(job);
  const command = waited ?? runningCodexCommand(job);
  if (!command) return null;
  let label = 'Shell command';
  try { label = JSON.parse(command.input).command?.replace(/\s+/g, ' ').trim() || label; }
  catch { /* keep the fallback */ }
  const started = new Date(command.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  // While the turn is held open for it, the agent is waiting on this command.
  const text = waited ? `Waiting for a command started at ${started}: ${label}` : `Command still running since ${started}: ${label}`;
  return <div
    role="status"
    data-help="worker.header.late-command"
    data-testid="codex-command-running"
    title={text}
    style={{
      color: 'var(--color-accent-secondary)', overflow: 'hidden', textOverflow: 'ellipsis',
      whiteSpace: 'nowrap', minWidth: 0, fontSize: '10px', flexShrink: 0,
      ...(header ? { padding: '4px 12px', borderBottom: '1px solid var(--color-border-hairline)' } : {}),
    }}
  >{text}</div>;
}
