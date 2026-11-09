import type { ActivityEntry, JobState } from '../stores/appStore';

// Tool descriptions are deliberately short; tool inputs never include output or reasoning.
export function describeTool(entry: ActivityEntry): string {
  const name = entry.tool || 'Tool';
  let input: Record<string, unknown> = {};
  try { const parsed = JSON.parse(entry.input || '{}'); if (parsed && typeof parsed === 'object') input = parsed; } catch { /* Some providers send plain text. */ }
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : '';
  if (/^read$/i.test(name)) return path ? `Reading ${path}` : 'Reading file';
  if (/^(write|edit)$/i.test(name)) return path ? `Editing ${path}` : 'Editing file';
  if (/cluster_task_create$/i.test(name)) return 'Creating board task';
  if (/^(bash|shell|shell_call|command_execution)$/i.test(name)) {
    const command = typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : '';
    const first = command.split(/\r?\n/, 1)[0].trim();
    return first ? `Bash: ${first}` : 'Running command';
  }
  return name.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ');
}

export function activeActivity(activity: ActivityEntry[], startedAt: number | undefined) {
  const latest = [...activity].reverse().find((entry) => entry.kind === 'tool_use' || entry.kind === 'thinking');
  if (latest?.kind === 'tool_use' && latest.status !== 'completed' && latest.status !== 'failed') return { key: latest.id, label: describeTool(latest), at: latest.at };
  if (latest?.kind === 'thinking') return { key: 'thinking', label: 'Thinking', at: latest.at };
  return { key: 'working', label: 'Working', at: latest?.updatedAt ?? startedAt ?? Date.now() };
}

export function settledCardItem(job: JobState | undefined): { text: string; at: number } | undefined {
  if (!job) return undefined;
  const message = [...job.messages].reverse().find((m) => m.role === 'assistant' && !m.toolUse && !m.isStreaming && !!m.content?.trim());
  const tool = [...(job.activity ?? [])].reverse().find((entry) => entry.kind === 'tool_use' && (entry.status === 'completed' || entry.status === 'failed'));
  const text = message?.content.trim();
  const messageAt = message?.timestamp ?? 0;
  if (tool && (!message || (tool.updatedAt ?? tool.at) >= messageAt)) return { text: describeTool(tool), at: tool.updatedAt ?? tool.at };
  return text ? { text: text.length > 1200 ? `${text.slice(0, 1200).trimEnd()}\n[preview truncated]` : text, at: messageAt } : undefined;
}

export function canPlanFirst(role: string | undefined): boolean {
  const text = role ?? '';
  if (/^\s*(?:director|coordinator|reviewer|researcher|documenter)\b/i.test(text)) return false;
  if (/^\s*(?:(?:you are|this is|role is)\s+(?:an?\s+)?)?read[ -]only\b/i.test(text)) return false;

  // A restriction qualified within its sentence permits changes under a condition.
  const clauses = text.split(/[.!?;\n]/);
  return !clauses.some((clause) => {
    if (/\b(?:outside|unless|except|until|before|after|provided|if|when|without(?=\s+(?!code\b|coding\b|source\s+code\b)))\b/i.test(clause)) return false;
    return /\b(?:no|without)\s+(?:source\s+)?(?:code|coding)\b/i.test(clause)
      || /\b(?:do(?:es)?\s+not|don['’]t|doesn['’]t|never|must\s+not|cannot|can['’]t)\b[^.!?\n]{0,35}\b(?:write|writes|edit|edits|modify|modifies|change|changes|touch)\b[^.!?\n]{0,45}\b(?:code|coding|source\s+files?)\b/i.test(clause);
  });
}

export function settledCardPreview(job: JobState | undefined): string | undefined { return settledCardItem(job)?.text; }
