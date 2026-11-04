import type { ActivityEntry } from '../stores/appStore';

export function turnStep(activity: ActivityEntry[], startedAt: number | undefined, now: number) {
  const latest = [...activity].reverse().find((entry) => entry.kind === 'tool_use' || entry.kind === 'thinking');
  const activeTool = latest?.kind === 'tool_use' && latest.status !== 'completed' && latest.status !== 'failed';
  let label = activeTool ? (latest.tool || 'Tool') : latest?.kind === 'thinking' ? 'Thinking' : 'Working';
  if (activeTool && /^(bash|shell|shell_call|command_execution)$/i.test(label)) {
    try {
      const input = JSON.parse(latest.input || '{}');
      const command = typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : '';
      const firstLine = command.split(/\r?\n/, 1)[0].trim();
      if (firstLine) label += `: ${firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine}`;
    } catch { /* A tool input need not be JSON. */ }
  }
  const stepStartedAt = activeTool || latest?.kind === 'thinking' ? latest!.at : latest?.updatedAt ?? startedAt ?? now;
  const elapsed = Math.max(0, now - stepStartedAt);
  const seconds = Math.floor(elapsed / 1000);
  const time = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return { label, time, longRunning: elapsed > 60_000 };
}
