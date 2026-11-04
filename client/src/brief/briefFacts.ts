// Facts for BRIEF: collected from state the client already holds. Nothing here
// calls a model; every line is a plain reading of that state, and anything not
// held is reported as "not visible" rather than inferred.
import type { LedgerTask, UtilityJobFact } from '@arco/shared';
import type { JobState } from '../stores/appStore';
import { turnStep } from '../utils/turnStep';

const RECENT_EVENTS = 6;
const CLIP = 160;

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function clip(text: string, max = CLIP): string {
  const line = (text.split('\n').find((l) => l.trim()) ?? '').trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

type Activity = NonNullable<JobState['activity']>[number];

// The most telling argument of a tool call, first line only.
export function toolSubject(input: string | undefined): string {
  if (!input) return '';
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    for (const key of ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
      const v = parsed[key];
      if (typeof v === 'string' && v.trim()) return clip(v);
    }
    return '';
  } catch {
    return clip(input);
  }
}

function describeActivity(a: Activity): string {
  if (a.kind === 'thinking') return 'thinking';
  if (a.kind === 'tool_use') {
    const subject = toolSubject(a.input);
    return `${a.tool ?? 'tool'}${subject ? `: ${subject}` : ''}${a.status === 'failed' ? ' (failed)' : ''}`;
  }
  return clip(a.text ?? a.itemType ?? 'event', 100);
}

// The step name, elapsed time and long-running mark come from the same helper
// the working indicator uses, so BRIEF and the card never disagree.
function stepFact(job: JobState, busy: boolean, now: number): string {
  if (!busy) return 'none (idle)';
  if (!(job.activity ?? []).length) return 'not visible (no activity recorded this turn)';
  const step = turnStep(job.activity ?? [], job.turnStartedAt, now);
  return `${step.label}, ${step.time}${step.longRunning ? ' (long-running)' : ''}`;
}

// Queued or Delivered comes from the per-turn message state the transcript and
// the queue indicator show (`turnMessages`); with none held, the transcript
// decides: 'queued' marker, 'answered' once an assistant reply follows, else
// 'delivered, no reply yet'.
export function lastOperatorMessageState(job: JobState): { text: string; state: string } | null {
  const held = Object.values(job.turnMessages ?? {});
  if (held.length > 0) {
    const m = held[held.length - 1]!;
    return { text: clip(m.content), state: m.state === 'queued' ? 'queued' : 'delivered, no reply yet' };
  }
  const msgs = job.messages;
  let idx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role === 'user' && msgs[i]!.content.trim()) { idx = i; break; }
  }
  if (idx < 0) return null;
  const m = msgs[idx]!;
  const answered = msgs.slice(idx + 1).some((x) => x.role === 'assistant' && !x.toolUse && x.content.trim());
  return { text: clip(m.content), state: m.queued === true ? 'queued' : answered ? 'answered' : 'delivered, no reply yet' };
}

function lastReply(job: JobState): string | null {
  for (let i = job.messages.length - 1; i >= 0; i--) {
    const m = job.messages[i]!;
    if (m.role === 'assistant' && !m.toolUse && m.content.trim()) return clip(m.content, 300);
  }
  return null;
}

export interface WorkerFactsInput {
  name: string;
  role?: string;
  job: JobState | undefined;
  hasQuestion: boolean;
  pendingMail: number;
  // Open board tasks assigned to this worker; empty when none.
  tasks: Pick<LedgerTask, 'title' | 'status'>[];
  // Uncommitted file count when a live snapshot is held, else null.
  changedFiles: number | null;
  now: number;
}

export function collectWorkerFacts(i: WorkerFactsInput): UtilityJobFact[] {
  const facts: UtilityJobFact[] = [{ label: 'Worker', value: i.role?.trim() ? `${i.name} (${clip(i.role, 60)})` : i.name }];
  const job = i.job;
  if (!job) {
    facts.push({ label: 'Turn state', value: 'not visible (this worker is not loaded)' });
    return facts;
  }
  const busy = job.busy === true;
  if (busy) facts.push({ label: 'Turn state', value: `working for ${job.turnStartedAt ? formatDuration(i.now - job.turnStartedAt) : 'an unknown time'}` });
  else facts.push({ label: 'Turn state', value: job.lastTurnEndedAt ? `idle, last turn ended ${formatDuration(i.now - job.lastTurnEndedAt)} ago` : 'idle' });
  facts.push({ label: 'Current step', value: stepFact(job, busy, i.now) });
  const op = lastOperatorMessageState(job);
  facts.push({ label: 'Last operator message', value: op ? `"${op.text}" - ${op.state}` : 'none' });
  const acts = (job.activity ?? []).slice(-RECENT_EVENTS);
  facts.push({ label: 'Recent events', value: acts.length ? acts.map((a) => `${describeActivity(a)} (${formatDuration(i.now - a.at)} ago)`).join(' | ') : 'none recorded' });
  const reply = lastReply(job);
  facts.push({ label: 'Last reply', value: reply ?? 'none' });
  facts.push({ label: 'Pending question', value: i.hasQuestion ? 'yes, waiting for the operator to answer' : 'none' });
  facts.push({ label: 'Unread peer mail', value: String(i.pendingMail) });
  facts.push({ label: 'Board task', value: i.tasks.length ? i.tasks.map((t) => `${clip(t.title, 100)} [${t.status}]`).join(' | ') : 'none assigned' });
  facts.push({ label: 'Uncommitted files', value: i.changedFiles === null ? 'not visible' : String(i.changedFiles) });
  return facts;
}

// One deterministic line per member for the cluster brief, plus the
// "waiting on the operator" roll-up.
export function collectClusterFacts(members: Array<{ name: string; facts: UtilityJobFact[]; blocked: boolean }>): UtilityJobFact[] {
  const value = (facts: UtilityJobFact[], label: string) => facts.find((f) => f.label === label)?.value ?? 'not visible';
  const out: UtilityJobFact[] = [{ label: 'Members', value: String(members.length) }];
  for (const m of members) {
    out.push({
      label: `Member ${m.name}`,
      value: [
        value(m.facts, 'Turn state'),
        `step: ${value(m.facts, 'Current step')}`,
        `question: ${value(m.facts, 'Pending question')}`,
        `mail: ${value(m.facts, 'Unread peer mail')}`,
        `task: ${value(m.facts, 'Board task')}`,
      ].join('; '),
    });
  }
  const waiting = members.filter((m) => value(m.facts, 'Pending question').startsWith('yes') || m.blocked).map((m) => m.name);
  out.push({ label: 'Waiting on the operator', value: waiting.length ? waiting.join(', ') : 'nobody' });
  return out;
}

// Board facts for a cluster BRIEF: totals by status, release progress for any
// labeled release, and how many tasks changed in the last day by their status.
// Boards without release labels produce no release lines.
export function collectBoardFacts(tasks: readonly LedgerTask[], now: number): UtilityJobFact[] {
  if (tasks.length === 0) return [];
  const count = (list: readonly LedgerTask[]) => {
    const by = new Map<string, number>();
    for (const t of list) by.set(t.status, (by.get(t.status) ?? 0) + 1);
    return [...by].map(([status, n]) => `${n} ${status}`).join(', ');
  };
  const out: UtilityJobFact[] = [{ label: 'Board', value: `${tasks.length} tasks: ${count(tasks)}` }];
  const releases = [...new Set(tasks.map((t) => t.release).filter((r): r is string => !!r))].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const release of releases) {
    const inRelease = tasks.filter((t) => t.release === release && t.status !== 'archived');
    const accepted = inRelease.filter((t) => t.status === 'done').length;
    out.push({ label: `Release ${release}`, value: `${inRelease.length} in, ${accepted} accepted, ${inRelease.length - accepted} left` });
  }
  const moved = tasks.filter((t) => now - t.updatedAt <= 24 * 60 * 60 * 1000);
  out.push({ label: 'Board movement (last 24h)', value: moved.length ? `${moved.length} changed: ${count(moved)}` : 'none' });
  return out;
}
