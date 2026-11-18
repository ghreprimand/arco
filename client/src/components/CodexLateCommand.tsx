import type { JobState } from '../stores/appStore';

export function runningCodexCommand(job: JobState | undefined) {
  return job?.codexLateCommands?.findLast(command => command.waitingUntil > Date.now());
}

export function CodexLateCommandLine({ job, header }: { job: JobState | undefined; header?: boolean }) {
  const command = runningCodexCommand(job);
  if (!command) return null;
  let label = 'Shell command';
  try { label = JSON.parse(command.input).command?.replace(/\s+/g, ' ').trim() || label; }
  catch { /* keep the fallback */ }
  const started = new Date(command.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const text = `Command still running since ${started}: ${label}`;
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
