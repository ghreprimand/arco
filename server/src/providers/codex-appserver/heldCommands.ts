// docs/PROVIDERS.md - a Codex app-server turn that ends while a command the
// agent started is still running is not over for Arco. These limits bound the
// wait and the text that carries each result back to the agent.
import type { HeldCommandResult } from './lateCommands.js';

export const HELD_WAIT_LIMIT_MS = 30 * 60_000;
export const HELD_CONTINUATION_LIMIT = 20;
export const HELD_OUTPUT_CHARS = 4_000;
// Results in one message; any further results in the same batch keep their
// exit code but not their output.
export const HELD_RESULTS_WITH_OUTPUT = 8;
// Ends this close together go to the agent in one continuation.
export const HELD_BATCH_MS = 2_000;

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function shortCommand(command: string, max = 160): string {
  const flat = command.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function outcome(result: HeldCommandResult): string {
  return typeof result.exitCode === 'number' ? `exit ${result.exitCode}` : result.failed ? 'failed' : 'ended';
}

/** The operator-visible line for one delivered result. */
export function heldResultNotice(result: HeldCommandResult, continues: boolean): string {
  return `Command ended: \`${shortCommand(result.command)}\` - ${outcome(result)} after ${formatDuration(result.endedAt - result.startedAt)}.${continues ? ' Codex continues.' : ''}`;
}

/** The text Codex receives: each result once, output tail capped. */
export function heldResultsMessage(results: HeldCommandResult[], stillRunning: Array<{ command: string }>): string {
  const parts = ['[Arco] A command you started has ended since your last reply. This is its result, observed by Arco; it is not from the operator.'];
  results.forEach((result, index) => {
    const lines = [
      `Command: ${result.command}`,
      ...(result.cwd ? [`Working directory: ${result.cwd}`] : []),
      `Result: ${outcome(result)} after ${formatDuration(result.endedAt - result.startedAt)}`,
    ];
    if (index < HELD_RESULTS_WITH_OUTPUT) {
      const output = result.output ?? '';
      const tail = output.length > HELD_OUTPUT_CHARS ? output.slice(-HELD_OUTPUT_CHARS) : output;
      lines.push(output.length > HELD_OUTPUT_CHARS
        ? `Output (last ${HELD_OUTPUT_CHARS} of ${output.length} characters):\n${tail}`
        : `Output:\n${tail || '(none)'}`);
    } else lines.push('Output: not included; too many results in one message.');
    parts.push(lines.join('\n'));
  });
  if (stillRunning.length) parts.push(`Still running: ${stillRunning.map(item => shortCommand(item.command)).join('; ')}. Arco tells you when ${stillRunning.length === 1 ? 'it ends' : 'they end'}.`);
  parts.push('Continue the work.');
  return parts.join('\n\n');
}
