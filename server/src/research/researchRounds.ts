// docs/RESEARCH.md - research rounds.
//
// research_round sends identical text to every researcher, then Arco holds
// each reply until every researcher has replied, failed, been stopped or
// timed out, and releases them to the Research Director together, labelled
// by letter. A held reply never reaches the Director's mailbox, context or
// the research folder before release.

import { join } from 'node:path';
import {
  RESEARCH_ROUND_TIMEOUT_DEFAULT_MINUTES,
  RESEARCH_ROUND_TIMEOUT_MAX_MINUTES,
} from '@arco/shared';
import type { PeerArtifact, PeerMessage } from '../clusterMailbox.js';
import { readLogLines } from '../eventLog.js';
import {
  cachedResearch,
  loadResearch,
  openRound,
  researcherByRef,
  researcherFor,
  researcherName,
  updateResearch,
  type ResearchRound,
  type ResearchState,
  type ResearchTargeted,
} from './researchState.js';
import { atomicWriteFile } from '../atomicFile.js';
import { appendDirectorLog, renderRound, roundDir, writeProjectFiles, writeReleasedRound, writeRoundStart } from './researchFolder.js';

export interface ResearchDeps {
  enqueue(toWorkflowId: string, msg: PeerMessage, opts?: { maxContentBytes?: number }): Promise<void>;
  mintMsgId(): string;
  wake(workflowId: string, prompt: string): void;
  isBusy(workflowId: string): boolean;
  pendingMail(workflowId: string): Promise<number>;
  clusterIdFor(workflowId: string): string | undefined;
  notify(clusterId: string): void;
  now(): number;
}

let deps: ResearchDeps | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
// Directors that were busy when their round was released: woken when idle.
const directorWakes = new Set<string>();

export function configureResearch(next: ResearchDeps | null): void {
  deps = next;
  if (!next) {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    directorWakes.clear();
  }
}

function d(): ResearchDeps {
  if (!deps) throw new Error('Research rounds are not configured.');
  return deps;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const RELEASE_INLINE_BYTES = 28 * 1024;
const RELEASE_MAX_BYTES = 32 * 1024;
const MAX_WAKES = 3;

export type ResearchRoundResult =
  | { ok: true; round: number; researchers: string[]; deadline: string }
  | { ok: false; code: 'not_research' | 'access_denied' | 'round_open' | 'empty_text' | 'no_researchers'; message: string };

export async function startRound(clusterId: string, callerWorkflowId: string, text: string, timeoutMinutes?: number): Promise<ResearchRoundResult> {
  const state = await loadResearch(clusterId);
  if (!state) return { ok: false, code: 'not_research', message: 'research_round works only in a research project.' };
  if (callerWorkflowId !== state.directorWorkflowId) return { ok: false, code: 'access_denied', message: 'Only the Research Director can send a round.' };
  const brief = text.trim();
  if (!brief) return { ok: false, code: 'empty_text', message: 'The round text is empty.' };
  if (state.researchers.length === 0) return { ok: false, code: 'no_researchers', message: 'The project has no researchers.' };
  const open = openRound(state);
  if (open) return { ok: false, code: 'round_open', message: `Round ${open.n} is still collecting replies; it is released when every researcher has replied, failed, been stopped or timed out (deadline ${open.deadline}).` };
  const minutes = Math.max(1, Math.min(RESEARCH_ROUND_TIMEOUT_MAX_MINUTES, Math.round(Number.isFinite(timeoutMinutes) ? timeoutMinutes! : RESEARCH_ROUND_TIMEOUT_DEFAULT_MINUTES)));
  const now = d().now();
  let round: ResearchRound | undefined;
  const next = await updateResearch(clusterId, (s) => {
    if (openRound(s)) return false;
    round = {
      n: s.rounds.length + 1,
      text: brief,
      startedAt: iso(now),
      deadline: iso(now + minutes * 60_000),
      entries: Object.fromEntries(s.researchers.map((r) => [r.letter, { state: 'waiting' as const }])),
      targeted: [],
    };
    s.rounds.push(round);
  });
  if (!next || !round || next.rounds.at(-1)?.n !== round.n) return { ok: false, code: 'round_open', message: 'Another round started first.' };
  await writeRoundStart(next, round);
  const content = `Research brief, round ${round.n}. Answer it independently, then send your report with peer_send.\n\n${brief}`;
  for (const r of next.researchers) {
    await d().enqueue(r.workflowId, {
      msgId: d().mintMsgId(),
      fromWorkflowId: next.directorWorkflowId,
      fromDisplayName: 'Research Director',
      toWorkflowId: r.workflowId,
      content,
      createdAt: iso(now),
      delivered: false,
    }, { maxContentBytes: RELEASE_MAX_BYTES });
    if (!d().isBusy(r.workflowId)) d().wake(r.workflowId, researcherWakePrompt(round.n, brief));
  }
  schedule(clusterId, round);
  d().notify(clusterId);
  return { ok: true, round: round.n, researchers: next.researchers.map((r) => researcherName(r.letter)), deadline: round.deadline };
}

// The brief is quoted in the turn message as well as sent as mail: mail is
// consumed by peer_read, and a compaction during the round can drop that
// result, which once led a researcher that had already reported to tell
// the Director it never saw the brief. The turn message survives compaction.
function researcherWakePrompt(n: number, brief: string): string {
  return `(research round ${n}) The Research Director's brief is below; the same text is in your mail. Research it and send your report with peer_send.\n\n${brief}`;
}

function schedule(clusterId: string, round: ResearchRound): void {
  const key = `${clusterId}:${round.n}`;
  clearTimeout(timers.get(key));
  const delay = Math.max(0, Date.parse(round.deadline) - d().now());
  const timer = setTimeout(() => { timers.delete(key); void timeoutRound(clusterId, round.n); }, Math.min(delay, 2 ** 31 - 1));
  timer.unref?.();
  timers.set(key, timer);
}

export async function timeoutRound(clusterId: string, n: number): Promise<void> {
  const at = iso(d().now());
  await updateResearch(clusterId, (s) => {
    const round = openRound(s);
    if (!round || round.n !== n) return false;
    let changed = false;
    for (const entry of Object.values(round.entries)) {
      if (entry.state !== 'waiting') continue;
      entry.state = 'timed_out'; entry.at = at; entry.reason = 'No reply before the deadline.'; changed = true;
    }
    return changed;
  });
  await maybeRelease(clusterId);
}

// A researcher's peer_send. Returns the round number when the reply is held
// for that round; undefined means deliver it as an ordinary message.
export async function holdResearcherReply(clusterId: string, workflowId: string, content: string, artifacts: PeerArtifact[] | undefined): Promise<number | undefined> {
  let held: number | undefined;
  const at = iso(d().now());
  await updateResearch(clusterId, (s) => {
    const round = openRound(s);
    const r = researcherFor(s, workflowId);
    const entry = r && round?.entries[r.letter];
    if (!round || !entry) return false;
    // A second message in the same round (for example "Part 2/2") joins the report.
    entry.report = entry.state === 'replied' && entry.report ? `${entry.report}\n\n${content}` : content;
    entry.state = 'replied'; entry.at = at; entry.source = 'mail'; delete entry.reason;
    if (artifacts?.length) entry.artifacts = [...(entry.artifacts ?? []), ...artifacts];
    held = round.n;
  });
  if (held !== undefined) {
    d().notify(clusterId);
    await maybeRelease(clusterId);
  }
  return held;
}

// The text a researcher wrote in its latest turn.
export async function finalReplyText(workflowDir: string): Promise<string> {
  let text = '';
  try {
    for await (const line of readLogLines(workflowDir)) {
      let event: { type?: string; text?: unknown };
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'primary_turn_started') text = '';
      else if (event.type === 'primary_text' && typeof event.text === 'string') text += event.text;
    }
  } catch { return ''; }
  return text.trim();
}

// A member's turn ended. `stopped` is the operator's STOP.
export async function onMemberSettled(workflowId: string, outcome: 'finished' | 'failed' | 'stopped'): Promise<void> {
  if (!deps) return;
  const clusterId = d().clusterIdFor(workflowId);
  const state = cachedResearch(clusterId) ?? await loadResearch(clusterId).catch(() => null);
  if (!clusterId || !state) return;
  if (workflowId === state.directorWorkflowId) {
    await logDirectorTurn(state, workflowId).catch((error) => console.error('[arco] research director log failed:', error));
    if (directorWakes.delete(clusterId) && outcome !== 'stopped' && await d().pendingMail(workflowId) > 0) {
      d().wake(workflowId, directorWakePrompt());
    }
    return;
  }
  const researcher = researcherFor(state, workflowId);
  const round = openRound(state);
  if (!researcher || !round || round.entries[researcher.letter]?.state !== 'waiting') return;
  const at = iso(d().now());
  if (outcome === 'finished' && await d().pendingMail(workflowId) > 0 && (round.entries[researcher.letter].wakes ?? 0) < MAX_WAKES) {
    await updateResearch(clusterId, (s) => {
      const entry = openRound(s)?.entries[researcher.letter];
      if (!entry || entry.state !== 'waiting') return false;
      entry.wakes = (entry.wakes ?? 0) + 1;
    });
    d().wake(workflowId, researcherWakePrompt(round.n, round.text));
    return;
  }
  const reply = outcome === 'finished' ? await finalReplyText(join(state.membersCwd, '.arco', 'workflows', workflowId)) : '';
  await updateResearch(clusterId, (s) => {
    const entry = openRound(s)?.entries[researcher.letter];
    if (!entry || entry.state !== 'waiting') return false;
    entry.at = at;
    if (outcome === 'stopped') { entry.state = 'stopped'; entry.reason = 'Stopped by the operator.'; }
    else if (outcome === 'failed') { entry.state = 'failed'; entry.reason = 'The turn failed.'; }
    else if (reply) { entry.state = 'replied'; entry.source = 'final_reply'; entry.report = reply; }
    else { entry.state = 'failed'; entry.reason = 'The turn ended without a report.'; }
  });
  d().notify(clusterId);
  await maybeRelease(clusterId);
}

function directorWakePrompt(): string {
  return '(research) A research round has been released; the reports are in your mail. Distil them, update synthesis.md and give the operator the answer.';
}

export function buildReleaseMessage(state: ResearchState, round: ResearchRound, written: Record<string, { reportPath?: string; sources: string[] }>): string {
  const rel = (path: string): string => path.startsWith(state.folder) ? path.slice(state.folder.length + 1) : path;
  const header = [`Round ${round.n} replies, released together.`, ''];
  const status = state.researchers.filter((r) => round.entries[r.letter]).map((r) => {
    const entry = round.entries[r.letter];
    const where = written[r.letter]?.reportPath ? ` - ${rel(written[r.letter].reportPath!)}` : '';
    const word = entry.state === 'replied' ? (entry.source === 'final_reply' ? 'replied (taken from final reply)' : 'replied') : entry.state.replace('_', ' ');
    return `- ${researcherName(r.letter)}: ${word}${entry.reason ? ` (${entry.reason})` : ''}${where}`;
  });
  const reports = state.researchers.filter((r) => round.entries[r.letter]?.state === 'replied').map((r) => {
    const sources = written[r.letter]?.sources ?? [];
    return [`## ${researcherName(r.letter)}`, '', ...(sources.length ? [`Returned files: ${sources.join(', ')}`, ''] : []), round.entries[r.letter].report?.trim() ?? ''].join('\n');
  });
  const full = [...header, ...status, '', ...reports].join('\n');
  if (Buffer.byteLength(full, 'utf8') <= RELEASE_INLINE_BYTES) return full;
  // Too large for one message: the reports are in the folder.
  const short = reports.map((report) => report.length > 1500 ? `${report.slice(0, 1500)}\n[... continued in the report file]` : report);
  const trimmed = [...header, ...status, '', 'The reports are too long for one message; read the full files listed above.', '', ...short].join('\n');
  return Buffer.byteLength(trimmed, 'utf8') <= RELEASE_INLINE_BYTES ? trimmed : [...header, ...status, '', 'Read the report files listed above.'].join('\n');
}

export async function maybeRelease(clusterId: string): Promise<boolean> {
  let released: ResearchRound | undefined;
  const at = iso(d().now());
  const state = await updateResearch(clusterId, (s) => {
    const round = openRound(s);
    if (!round || Object.values(round.entries).some((e) => e.state === 'waiting')) return false;
    round.releasedAt = at;
    released = round;
  });
  if (!state || !released) return false;
  const round = state.rounds.find((r) => r.n === released!.n)!;
  clearTimeout(timers.get(`${clusterId}:${round.n}`));
  timers.delete(`${clusterId}:${round.n}`);
  const written = await writeReleasedRound(state, round);
  await writeProjectFiles(state);
  await d().enqueue(state.directorWorkflowId, {
    msgId: d().mintMsgId(),
    fromWorkflowId: state.directorWorkflowId,
    fromDisplayName: 'Arco research',
    toWorkflowId: state.directorWorkflowId,
    content: buildReleaseMessage(state, round, written),
    createdAt: at,
    delivered: false,
  }, { maxContentBytes: RELEASE_MAX_BYTES });
  if (d().isBusy(state.directorWorkflowId)) directorWakes.add(clusterId);
  else d().wake(state.directorWorkflowId, directorWakePrompt());
  d().notify(clusterId);
  return true;
}

// A targeted message from the Director or the operator to one researcher,
// recorded in the open round (or the latest one) and its round.md.
export async function recordTargeted(clusterId: string, workflowId: string, from: ResearchTargeted['from'], text: string): Promise<void> {
  const at = iso(d().now());
  let touched: ResearchRound | undefined;
  const state = await updateResearch(clusterId, (s) => {
    const r = researcherFor(s, workflowId);
    if (!r) return false;
    const item = { at, from, letter: r.letter, text: text.slice(0, 16 * 1024) };
    const round = s.rounds.at(-1);
    if (round) { round.targeted.push(item); touched = round; } else s.targetedBeforeRounds.push(item);
  });
  if (state && touched) {
    const round = state.rounds.find((r) => r.n === touched!.n)!;
    await atomicWriteFile(join(roundDir(state.folder, round.n), 'round.md'), renderRound(state, round));
  }
  if (state) d().notify(clusterId);
}

export function resolveResearcherRef(state: ResearchState, ref: string): string | undefined {
  return researcherByRef(state, ref)?.workflowId;
}

// Restores round deadlines after a restart.
export async function restoreResearchTimers(clusterIds: Iterable<string>): Promise<void> {
  for (const clusterId of clusterIds) {
    const state = await loadResearch(clusterId).catch(() => null);
    const round = state && openRound(state);
    if (round) schedule(clusterId, round);
  }
}

// Appends the Director's latest turn to director-log.md: the operator's
// message, tool calls folded to one line each, and the reply.
async function logDirectorTurn(state: ResearchState, workflowId: string): Promise<void> {
  let user = ''; let reply = ''; const tools: string[] = [];
  for await (const line of readLogLines(join(state.folder, '.arco', 'workflows', workflowId))) {
    let event: { type?: string; text?: unknown; content?: unknown; tool?: unknown; name?: unknown; status?: unknown };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'primary_turn_started') { reply = ''; tools.length = 0; }
    else if (event.type === 'user_message_echo' && typeof event.content === 'string') { user = event.content; reply = ''; tools.length = 0; }
    else if (event.type === 'primary_text' && typeof event.text === 'string') reply += event.text;
    else if (event.type === 'primary_tool_use' && event.status === 'completed') tools.push(String(event.tool ?? event.name ?? 'tool'));
  }
  if (!user.trim() && !reply.trim()) return;
  const at = iso(d().now());
  const toolLine = tools.length ? `\n_Tools: ${[...new Set(tools)].map((t) => `${t} x${tools.filter((x) => x === t).length}`).join(', ')}_\n` : '';
  await appendDirectorLog(state.folder, `\n---\n\n## ${at}\n\n**Operator:** ${!user.trim() || /^\((?:research|auto-pickup)/.test(user.trim()) ? '(automatic turn)' : user.trim()}\n${toolLine}\n**Research Director:** ${reply.trim()}\n`);
}

// Ordinary mail inside a research project (a targeted question, or a
// researcher's answer outside a round) starts a turn on an idle recipient,
// whatever the cluster's AUTO-PICKUP setting.
export function wakeForResearchMail(workflowId: string, toResearcher: boolean): void {
  if (!deps || deps.isBusy(workflowId)) return;
  deps.wake(workflowId, toResearcher
    ? '(research) The Research Director sent you a message; it is in your mail. Answer it with peer_send.'
    : '(research) A researcher answered your message; it is in your mail.');
}

// The operator's Reveal: providers and models become visible in
// research.json, round.md and to the Director from now on.
export async function revealResearch(clusterId: string): Promise<boolean> {
  const at = iso(d().now());
  const state = await updateResearch(clusterId, (s) => {
    if (!s.blind || s.revealedAt) return false;
    s.revealedAt = at;
  });
  if (!state?.revealedAt) return false;
  await writeProjectFiles(state);
  for (const round of state.rounds) {
    await atomicWriteFile(join(roundDir(state.folder, round.n), 'round.md'), renderRound(state, round)).catch(() => undefined);
  }
  d().notify(clusterId);
  return true;
}

export function isResearchMemberBusy(workflowId: string): boolean { return deps?.isBusy(workflowId) ?? false; }

// docs/RESEARCH.md - START RESEARCH PROJECT starts the Director's first turn
// with the operator's brief, through the same synthetic wake as rounds. The
// prompt is the Director's visible first message.
export function directorStartPrompt(state: Pick<ResearchState, 'name' | 'brief'>): string {
  return [
    `(research) New research project: ${state.name}.`,
    'If the brief below is clear enough to research, send round 1 now with research_round, built from it. If it is too unclear to research, ask the operator one question first and send no round.',
    '',
    'Brief from the operator:',
    '',
    state.brief,
  ].join('\n');
}

export function startResearchDirector(state: Pick<ResearchState, 'name' | 'brief' | 'directorWorkflowId'>): boolean {
  if (!deps) return false;
  d().wake(state.directorWorkflowId, directorStartPrompt(state));
  return true;
}
