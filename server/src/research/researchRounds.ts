// docs/RESEARCH.md - research rounds.
//
// research_round sends identical text to every researcher, then Arco holds
// each reply until every researcher has replied, failed, been stopped or
// timed out, and releases them to the Research Director together, labelled
// by letter. A held reply never reaches the Director's mailbox, context or
// the research folder before release.

import { join } from 'node:path';
import { RESEARCH_EXTEND_MINUTES, researchRoundExtendable, researchTimeLimitMinutes } from '@arco/shared';
import type { PeerArtifact, PeerMessage } from '../clusterMailbox.js';
import { readLogLines } from '../eventLog.js';
import { flushWorkflowBuffer } from '../workflowStore.js';
import {
  activeResearchers,
  cachedResearch,
  catchUpKey,
  catchUpLetter,
  loadResearch,
  nextResearchLetter,
  openCatchUp,
  openRetry,
  openRound,
  retryKey,
  replyRound,
  roundByKey,
  researcherByRef,
  researcherFor,
  researcherName,
  updateResearch,
  type ResearchResearcher,
  type ResearchRound,
  type ResearchState,
  type ResearchTargeted,
} from './researchState.js';
import { atomicWriteFile } from '../atomicFile.js';
import { appendDirectorLog, renderRound, roundDir, roundTitle, writeProjectFiles, writeReleasedRound, writeRoundStart } from './researchFolder.js';
import { readWorkSoFar, workSoFarFile } from './researchRetry.js';
import { clearResearchTripwireTails, containsForeignCanary, ensureResearchTripwires, researchBoundaryHit, researchTripwireHit, setResearchTripwireReporter } from './researchTripwires.js';

export interface ResearchDeps {
  enqueue(toWorkflowId: string, msg: PeerMessage, opts?: { maxContentBytes?: number }): Promise<void>;
  mintMsgId(): string;
  wake(workflowId: string, prompt: string): void;
  // A member whose turns only the operator starts (a Gemini member, see
  // docs/PROTOCOL_CLUSTER.md "Gemini members"): never woken; see wakeMember.
  operatorOnly?(workflowId: string): boolean;
  isBusy(workflowId: string): boolean;
  // Settings > Projects > Research time limit, read when a round or catch-up starts.
  timeLimitMinutes?(): Promise<number | undefined>;
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
  setResearchTripwireReporter(next ? (clusterId, n, kind) => {
    let changed = false;
    void updateResearch(clusterId, state => {
      if (n === 0) {
        if (kind === 'contaminated' ? state.preRoundContaminated : state.preRoundBoundaryWarning) return false;
        if (kind === 'contaminated') state.preRoundContaminated = true;
        else state.preRoundBoundaryWarning = true;
        changed = true;
        return;
      }
      const round = roundByKey(state, n);
      if (!round || (kind === 'contaminated' ? round.contaminated : round.boundaryWarning)) return false;
      if (kind === 'contaminated') round.contaminated = true;
      else round.boundaryWarning = true;
      changed = true;
    }).then(async state => {
      if (!changed || !state) return;
      next.notify(clusterId);
      const round = roundByKey(state, n);
      if (!round?.releasedAt) return;
      const content = kind === 'contaminated'
        ? `${roundTitle(round)}: the independence check failed after release. Treat its reports as contaminated.`
        : `${roundTitle(round)}: a researcher attempted access outside the sandbox after release. Check its activity.`;
      await next.enqueue(state.directorWorkflowId, {
        msgId: next.mintMsgId(), fromWorkflowId: state.directorWorkflowId, fromDisplayName: 'Arco research',
        toWorkflowId: state.directorWorkflowId, content, createdAt: iso(next.now()), delivered: false,
      }, { maxContentBytes: RELEASE_MAX_BYTES });
      if (next.isBusy(state.directorWorkflowId)) directorWakes.add(clusterId);
      else wakeMember(state.directorWorkflowId, directorWakePrompt(n > 0 ? n : undefined));
    }).catch(error => console.error('[arco] research independence warning failed:', error));
  } : undefined);
  if (!next) {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    directorWakes.clear();
  }
}

// docs/RESEARCH.md "Gemini Research Director". Starts a research turn, except
// for a member whose turns only the operator starts: it gets the turn text as
// pending mail from "Arco research" instead, which waits for the operator's
// NUDGE, unless mail already waits for it (the NUDGE reads that mail).
function wakeMember(workflowId: string, prompt: string): void {
  const deps = d();
  if (!deps.operatorOnly?.(workflowId)) { deps.wake(workflowId, prompt); return; }
  void (async () => {
    if (await deps.pendingMail(workflowId) > 0) return;
    await deps.enqueue(workflowId, {
      msgId: deps.mintMsgId(), fromWorkflowId: workflowId, fromDisplayName: 'Arco research',
      toWorkflowId: workflowId, content: prompt, createdAt: iso(deps.now()), delivered: false,
    }, { maxContentBytes: RELEASE_MAX_BYTES });
    const clusterId = deps.clusterIdFor(workflowId);
    if (clusterId) deps.notify(clusterId);
  })().catch((error) => console.error('[arco] research notice for an operator-started member failed:', error));
}

function d(): ResearchDeps {
  if (!deps) throw new Error('Research rounds are not configured.');
  return deps;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const RELEASE_INLINE_BYTES = 28 * 1024;
const RELEASE_MAX_BYTES = 32 * 1024;
const MAX_WAKES = 3;

async function timeLimit(): Promise<number> {
  return researchTimeLimitMinutes(await d().timeLimitMinutes?.().catch(() => undefined));
}

export type ResearchRoundResult =
  | { ok: true; round: number; researchers: string[]; deadline: string }
  | { ok: false; code: 'not_research' | 'access_denied' | 'round_open' | 'empty_text' | 'no_researchers' | 'quick_complete'; message: string };

export async function startRound(clusterId: string, callerWorkflowId: string, text: string): Promise<ResearchRoundResult> {
  const state = await loadResearch(clusterId);
  if (!state) return { ok: false, code: 'not_research', message: 'research_round works only in a research project.' };
  if (callerWorkflowId !== state.directorWorkflowId) return { ok: false, code: 'access_denied', message: 'Only the Research Director can send a round.' };
  const brief = text.trim();
  if (!brief) return { ok: false, code: 'empty_text', message: 'The round text is empty.' };
  if (state.quick && state.rounds.length > 0) return { ok: false, code: 'quick_complete', message: 'Quick research has one round. Keep as project to start another round.' };
  if (activeResearchers(state).length === 0) return { ok: false, code: 'no_researchers', message: 'The project has no researchers.' };
  const open = openRound(state);
  if (open) return { ok: false, code: 'round_open', message: `Round ${open.n} is still collecting replies; it is released when every researcher has replied, failed, been stopped or timed out (deadline ${open.deadline}).` };
  if (state.researchers.some(r => r.claudeTransport === 'cli' || r.provider === 'codex')) await ensureResearchTripwires(clusterId);
  const minutes = await timeLimit();
  const now = d().now();
  let round: ResearchRound | undefined;
  const next = await updateResearch(clusterId, (s) => {
    if (openRound(s) || (s.quick && s.rounds.length > 0)) return false;
    round = {
      n: s.rounds.length + 1,
      text: brief,
      startedAt: iso(now),
      deadline: iso(now + minutes * 60_000),
      timeoutMs: minutes * 60_000,
      // A researcher still on its catch-up gets this text when the catch-up
      // settles, against the same deadline (docs/RESEARCH.md).
      entries: Object.fromEntries(activeResearchers(s).map((r) => [r.letter, { state: 'waiting' as const, ...(openCatchUp(s, r.letter) || openRetry(s, r.letter) ? { deferred: true } : {}) }])),
      targeted: [],
      ...(s.preRoundContaminated || researchTripwireHit(clusterId, 0) ? { contaminated: true } : {}),
      ...(s.preRoundBoundaryWarning || researchBoundaryHit(clusterId, 0) ? { boundaryWarning: true } : {}),
    };
    s.rounds.push(round);
  });
  if (!next || !round || next.rounds.at(-1)?.n !== round.n) return { ok: false, code: 'round_open', message: 'Another round started first.' };
  await writeRoundStart(next, round);
  const sentTo = activeResearchers(next).filter((r) => round!.entries[r.letter]);
  for (const r of sentTo) if (!round.entries[r.letter].deferred) await sendRoundText(next, round, r);
  schedule(clusterId, round);
  d().notify(clusterId);
  return { ok: true, round: round.n, researchers: sentTo.map((r) => researcherName(r.letter)), deadline: round.deadline };
}

// The round (or catch-up) text as mail plus a turn message.
async function sendRoundText(state: ResearchState, round: ResearchRound, r: ResearchResearcher): Promise<void> {
  const label = round.catchUp ? 'catch-up on round 1' : `round ${round.n}`;
  // A round from a Gemini Research Director is mail from a Gemini member: it
  // waits for the operator's NUDGE on each researcher.
  const fromGemini = d().operatorOnly?.(state.directorWorkflowId) === true;
  // A Gemini researcher also takes this round only on the operator's NUDGE.
  const held = fromGemini || d().operatorOnly?.(r.workflowId) === true;
  const msgId = d().mintMsgId();
  // Recorded before the mail is queued, so a read that follows at once finds it.
  if (held) {
    await updateResearch(state.clusterId, (s) => {
      const entry = roundByKey(s, round.n)?.entries[r.letter];
      if (!entry || entry.state !== 'waiting') return false;
      entry.heldMsgId = msgId;
    });
  }
  await d().enqueue(r.workflowId, {
    msgId,
    fromWorkflowId: state.directorWorkflowId,
    fromDisplayName: 'Research Director',
    toWorkflowId: r.workflowId,
    content: `Research brief, ${label}. Answer it independently, then send your report with peer_send.\n\n${round.text}`,
    createdAt: iso(d().now()),
    delivered: false,
    ...(fromGemini ? { fromGemini: true } : {}),
  }, { maxContentBytes: RELEASE_MAX_BYTES });
  if (!held && !d().isBusy(r.workflowId)) wakeMember(r.workflowId, researcherWakePrompt(round, round.text));
}

// The brief is quoted in the turn message as well as sent as mail: mail is
// consumed by peer_read, and a compaction during the round can drop that
// result. The turn message preserves the brief through compaction.
function researcherWakePrompt(round: Pick<ResearchRound, 'n' | 'catchUp'>, brief: string): string {
  return `(research ${round.catchUp ? 'catch-up on round 1' : `round ${round.n}`}) The Research Director's brief is below; the same text is in your mail. Research it and send your report with peer_send.\n\n${brief}`;
}

function schedule(clusterId: string, round: ResearchRound): void {
  const key = `${clusterId}:${round.n}`;
  clearTimeout(timers.get(key));
  const delay = Math.max(0, Date.parse(round.deadline) - d().now());
  const timer = setTimeout(() => { timers.delete(key); void timeoutRoundIfDue(clusterId, round.n); }, Math.min(delay, 2 ** 31 - 1));
  timer.unref?.();
  timers.set(key, timer);
}

// The deadline timer: a deadline moved later (+15 MIN) since the timer was
// armed is re-armed instead of timing its researchers out.
export async function timeoutRoundIfDue(clusterId: string, n: number): Promise<void> {
  const state = await loadResearch(clusterId);
  const round = state ? roundByKey(state, n) : undefined;
  if (!round || round.releasedAt) return;
  if (Date.parse(round.deadline) > d().now()) { schedule(clusterId, round); return; }
  await timeoutRound(clusterId, n);
}

export async function timeoutRound(clusterId: string, n: number): Promise<void> {
  const at = iso(d().now());
  await updateResearch(clusterId, (s) => {
    const round = roundByKey(s, n);
    if (!round || round.releasedAt) return false;
    let changed = false;
    for (const [letter, entry] of Object.entries(round.entries)) {
      if (entry.state !== 'waiting' || entry.heldMsgId) continue;
      if (s.researchers.find(researcher => researcher.letter === letter)?.signInNeeded) continue;
      entry.state = 'timed_out'; entry.at = at; entry.reason = 'No reply before the deadline.'; changed = true;
    }
    return changed;
  });
  await maybeRelease(clusterId, n);
}

/**
 * The operator's +15 MIN (docs/RESEARCH.md "Round deadline"): moves an open
 * round's or catch-up's deadline 15 minutes later and re-arms its timer while a
 * researcher still waits, within the maximum round time. The Director reads one
 * line about it on its next turn; no turn starts for it.
 */
export async function extendRound(clusterId: string, n: number): Promise<{ ok: true; deadline: string } | { ok: false; code: 'unknown_round' | 'not_extendable' }> {
  let extended: ResearchRound | undefined;
  let known = false;
  const state = await updateResearch(clusterId, (s) => {
    const round = roundByKey(s, n);
    if (!round) return false;
    known = true;
    if (!researchRoundExtendable(round)) return false;
    round.deadline = iso(Date.parse(round.deadline) + RESEARCH_EXTEND_MINUTES * 60_000);
    extended = round;
  });
  if (!state || !extended) return { ok: false, code: known ? 'not_extendable' : 'unknown_round' };
  const round = roundByKey(state, n)!;
  schedule(clusterId, round);
  await writeRoundStart(state, round).catch(() => undefined);
  await d().enqueue(state.directorWorkflowId, {
    msgId: d().mintMsgId(), fromWorkflowId: state.directorWorkflowId, fromDisplayName: 'Arco research',
    toWorkflowId: state.directorWorkflowId, content: `${roundTitle(round)} extended to ${round.deadline} by the operator.`,
    createdAt: iso(d().now()), delivered: false,
  }, { maxContentBytes: RELEASE_MAX_BYTES });
  d().notify(clusterId);
  return { ok: true, deadline: round.deadline };
}

/**
 * A researcher read held round mail from a Gemini Research Director: its
 * entry can time out again, and the round deadline is at least the round's
 * full time limit from now (docs/RESEARCH.md "Gemini Research Director").
 */
export async function onRoundMailRead(workflowId: string, msgIds: string[]): Promise<void> {
  if (!deps || msgIds.length === 0) return;
  const clusterId = deps.clusterIdFor(workflowId);
  if (!clusterId) return;
  const now = deps.now();
  const touched: ResearchRound[] = [];
  const state = await updateResearch(clusterId, (s) => {
    const researcher = researcherFor(s, workflowId);
    if (!researcher) return false;
    for (const round of [...s.rounds, ...(s.catchUps ?? []), ...(s.retries ?? [])]) {
      const entry = round.entries[researcher.letter];
      if (round.releasedAt || !entry?.heldMsgId || !msgIds.includes(entry.heldMsgId)) continue;
      delete entry.heldMsgId;
      const limit = round.timeoutMs ?? Math.max(0, Date.parse(round.deadline) - Date.parse(round.startedAt));
      round.deadline = iso(Math.max(Date.parse(round.deadline), now + limit));
      touched.push(round);
    }
    if (touched.length === 0) return false;
  });
  if (!state) return;
  for (const round of touched) {
    const current = roundByKey(state, round.n);
    if (current && !current.releasedAt) schedule(clusterId, current);
  }
  deps.notify(clusterId);
}

/** Keep the researcher and its round waiting while the normal sign-in is renewed. */
export async function setResearcherSignInWaiting(clusterId: string, workflowId: string, waiting: boolean, provider: 'claude' | 'codex' = 'claude'): Promise<void> {
  const now = deps?.now() ?? Date.now();
  let changed = false;
  const state = await updateResearch(clusterId, s => {
    const researcher = researcherFor(s, workflowId);
    if (!researcher) return false;
    if (waiting) {
      if (researcher.signInNeeded) return false;
      researcher.signInNeeded = provider;
      changed = true;
      const round = openRound(s);
      if (round?.entries[researcher.letter]?.state === 'waiting') researcher.signInRemainingMs = Math.max(0, Date.parse(round.deadline) - now);
    } else {
      if (!researcher.signInNeeded) return false;
      changed = true;
      const round = openRound(s);
      if (round?.entries[researcher.letter]?.state === 'waiting' && researcher.signInRemainingMs !== undefined) {
        round.deadline = iso(Math.max(Date.parse(round.deadline), now + researcher.signInRemainingMs));
      }
      delete researcher.signInNeeded; delete researcher.signInRemainingMs;
    }
  });
  if (!state || !deps || !changed) return;
  const round = openRound(state);
  if (!waiting && round) schedule(clusterId, round);
  deps.notify(clusterId);
}

/** A CLI researcher is labelled sandboxed only after its preflight and provider startup. */
export async function setResearcherIsolation(clusterId: string, workflowId: string, isolation: 'checking' | 'sandboxed'): Promise<void> {
  const state = await updateResearch(clusterId, s => {
    const researcher = researcherFor(s, workflowId);
    if (!researcher || researcher.isolation === isolation) return false;
    researcher.isolation = isolation;
  });
  if (state && deps) deps.notify(clusterId);
}

// A researcher's peer_send. Returns the round number when the reply is held
// for that round; undefined means deliver it as an ordinary message.
export async function holdResearcherReply(clusterId: string, workflowId: string, content: string, artifacts: PeerArtifact[] | undefined): Promise<number | undefined> {
  let held: number | undefined;
  const at = iso(d().now());
  await updateResearch(clusterId, (s) => {
    const r = researcherFor(s, workflowId);
    const round = r && replyRound(s, r.letter);
    const entry = r && round?.entries[r.letter];
    if (!round || !entry) return false;
    if (containsForeignCanary(s, workflowId, content) || researchTripwireHit(clusterId, round.n)
      || artifacts?.some(artifact => containsForeignCanary(s, workflowId, Buffer.from(artifact.contentBase64, 'base64').toString('utf8')))) round.contaminated = true;
    if (researchBoundaryHit(clusterId, round.n)) round.boundaryWarning = true;
    // A second message in the same round (for example "Part 2/2") joins the report.
    entry.report = entry.state === 'replied' && entry.report ? `${entry.report}\n\n${content}` : content;
    entry.state = 'replied'; entry.at = at; entry.source = 'mail'; delete entry.reason;
    if (artifacts?.length) entry.artifacts = [...(entry.artifacts ?? []), ...artifacts];
    held = round.n;
  });
  if (held !== undefined) {
    d().notify(clusterId);
    await maybeRelease(clusterId, held);
  }
  return held;
}

// The text a researcher wrote in its latest turn.
async function finalTurn(workflowDir: string): Promise<{ text: string; refusal: string | null | undefined }> {
  let text = '';
  let refusal: string | null | undefined;
  try {
    for await (const line of readLogLines(workflowDir)) {
      let event: { type?: string; text?: unknown; category?: unknown };
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'primary_turn_started') { text = ''; refusal = undefined; }
      else if (event.type === 'primary_text' && typeof event.text === 'string') text += event.text;
      else if (event.type === 'primary_refusal') refusal = typeof event.category === 'string' ? event.category : null;
    }
  } catch { return { text: '', refusal: undefined }; }
  return { text: text.trim(), refusal };
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
      wakeMember(workflowId, directorWakePrompt(state.rounds.filter(r => r.releasedAt).at(-1)?.n));
    }
    return;
  }
  const researcher = researcherFor(state, workflowId);
  const round = researcher && replyRound(state, researcher.letter);
  if (!researcher || !round || round.entries[researcher.letter]?.state !== 'waiting') return;
  const n = round.n;
  const openEntry = (s: ResearchState) => { const r = roundByKey(s, n); return r && !r.releasedAt ? r.entries[researcher.letter] : undefined; };
  const at = iso(d().now());
  if (outcome === 'finished' && !d().operatorOnly?.(state.directorWorkflowId) && await d().pendingMail(workflowId) > 0 && (round.entries[researcher.letter].wakes ?? 0) < MAX_WAKES) {
    await updateResearch(clusterId, (s) => {
      const entry = openEntry(s);
      if (!entry || entry.state !== 'waiting') return false;
      entry.wakes = (entry.wakes ?? 0) + 1;
    });
    wakeMember(workflowId, researcherWakePrompt(round, round.text));
    return;
  }
  if (outcome !== 'stopped') await flushWorkflowBuffer(state.membersCwd, workflowId);
  const turn = outcome === 'stopped' ? { text: '', refusal: undefined } : await finalTurn(join(state.membersCwd, '.arco', 'workflows', workflowId));
  const line = turn.text.replace(/^\s*⚠\uFE0F?\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const networkNotice = researcher.provider === 'antigravity-cli' && /^there was a network issue connecting to the server\b/i.test(line);
  await updateResearch(clusterId, (s) => {
    const entry = openEntry(s);
    if (!entry || entry.state !== 'waiting') return false;
    entry.at = at;
    if (outcome === 'stopped') { entry.state = 'stopped'; entry.reason = 'Stopped by the operator.'; }
    else if (turn.refusal !== undefined) { entry.state = 'failed'; entry.reason = `The provider declined the request${turn.refusal ? ` (category: ${turn.refusal.replace(/\s+/g, ' ').trim().slice(0, 100)})` : ''}; rephrase the brief for this researcher.`; }
    else if (outcome === 'failed' || networkNotice) { entry.state = 'failed'; entry.reason = line ? `The turn ended without a report. Last message: ${line}` : 'The turn failed.'; }
    else if (turn.text) { entry.state = 'replied'; entry.source = 'final_reply'; entry.report = turn.text; }
    else { entry.state = 'failed'; entry.reason = 'The turn ended without a report.'; }
  });
  d().notify(clusterId);
  await maybeRelease(clusterId, n);
}

function directorWakePrompt(round?: number): string {
  return `(research) ${round ? `Round ${round} released` : 'Research mail ready'}; the reports are in your mail. Distil them, update synthesis.md and give the operator the answer.`;
}

export function buildReleaseMessage(state: ResearchState, round: ResearchRound, written: Record<string, { reportPath?: string; sources: string[] }>): string {
  const rel = (path: string): string => path.startsWith(state.folder) ? path.slice(state.folder.length + 1) : path;
  const after = state.rounds.filter((r) => r.releasedAt).at(-1)?.n;
  const header = [round.catchUp
    ? `Catch-up report from ${researcherName(round.catchUp)} on the original brief (the round 1 text), released alone.${after ? ` It arrived after round ${after}.` : ''} Add it to synthesis.md and say that it arrived later.`
    : `Round ${round.n} replies, released together.`,
    ...(round.contaminated ? ['Independence check failed: treat this round as contaminated.'] : []),
    ...(round.boundaryWarning ? ['A researcher attempted access outside the sandbox; check its activity.'] : []), ''];
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

// Releases the round (or catch-up) with key `n`, or the open round, once no
// entry is still waiting.
export async function maybeRelease(clusterId: string, n?: number): Promise<boolean> {
  let released: ResearchRound | undefined;
  const at = iso(d().now());
  const state = await updateResearch(clusterId, (s) => {
    const round = n === undefined ? openRound(s) : roundByKey(s, n);
    if (!round || round.releasedAt || Object.values(round.entries).some((e) => e.state === 'waiting')) return false;
    if (researchTripwireHit(clusterId, round.n)) round.contaminated = true;
    if (researchBoundaryHit(clusterId, round.n)) round.boundaryWarning = true;
    round.releasedAt = at;
    released = round;
  });
  if (!state || !released) return false;
  const key = released.n;
  clearResearchTripwireTails(clusterId, key);
  clearTimeout(timers.get(`${clusterId}:${key}`));
  timers.delete(`${clusterId}:${key}`);
  const latest = await loadResearch(clusterId);
  const round = latest && roundByKey(latest, key);
  if (!latest || !round) return false;
  if (round.lateFor) return await finishRetry(latest, round);
  const written = await writeReleasedRound(latest, round);
  await writeProjectFiles(latest);
  if (round.catchUp) return await finishCatchUp(latest, round, written);
  await d().enqueue(latest.directorWorkflowId, {
    msgId: d().mintMsgId(),
    fromWorkflowId: latest.directorWorkflowId,
    fromDisplayName: 'Arco research',
    toWorkflowId: latest.directorWorkflowId,
    content: buildReleaseMessage(latest, round, written),
    createdAt: at,
    delivered: false,
  }, { maxContentBytes: RELEASE_MAX_BYTES });
  if (d().isBusy(latest.directorWorkflowId)) directorWakes.add(clusterId);
  else wakeMember(latest.directorWorkflowId, directorWakePrompt(round.n));
  d().notify(clusterId);
  return true;
}

// A catch-up settled: a report goes to the Director alone and wakes it; a
// failure is one line. Then the researcher gets the round that waited for it.
async function finishCatchUp(state: ResearchState, round: ResearchRound, written: Record<string, { reportPath?: string; sources: string[] }>): Promise<boolean> {
  const letter = round.catchUp!;
  const entry = round.entries[letter];
  if (entry?.state === 'replied') {
    await noteDirector(state, buildReleaseMessage(state, round, written));
    if (d().isBusy(state.directorWorkflowId)) directorWakes.add(state.clusterId);
    else wakeMember(state.directorWorkflowId, `(research) The catch-up report from ${researcherName(letter)} is in your mail. Add it to synthesis.md and say that it arrived later.`);
  } else if (entry && entry.state !== 'removed') {
    await noteDirector(state, `${researcherName(letter)}'s catch-up on the original brief ended without a report (${(entry.state).replace('_', ' ')}).`);
  }
  await sendDeferredRound(state, letter);
  d().notify(state.clusterId);
  return true;
}

// The open round that waited for this researcher's catch-up or retry run.
async function sendDeferredRound(state: ResearchState, letter: string): Promise<void> {
  let waiting: ResearchRound | undefined;
  const next = await updateResearch(state.clusterId, (s) => {
    const open = openRound(s);
    const deferred = open?.entries[letter];
    if (!open || !deferred?.deferred) return false;
    delete deferred.deferred;
    waiting = open;
  });
  const researcher = next && researcherFor(next, state.researchers.find((r) => r.letter === letter)?.workflowId ?? '');
  if (next && waiting && researcher) await sendRoundText(next, waiting, researcher);
}

export type RetryResult = { ok: true; late: boolean; file: string } | { ok: false; code: 'not_research' | 'unknown_round' | 'unknown_researcher' | 'not_retryable' | 'busy'; message: string };

/**
 * docs/RESEARCH.md "Retry": the operator's RETRY on a researcher marked failed
 * or timed out in a round. Writes the work-so-far file from Arco's record of
 * the researcher's turns and sends it with one message. An open round takes
 * the report as usual; a released round gets it as a late report through a
 * retry run with its own deadline.
 */
export async function retryResearcher(clusterId: string, n: number, letterRef: string): Promise<RetryResult> {
  const state = await loadResearch(clusterId);
  if (!state) return { ok: false, code: 'not_research', message: 'Not a research project.' };
  const letter = letterRef.toUpperCase();
  const round = n > 0 ? state.rounds.find((r) => r.n === n) : undefined;
  if (!round) return { ok: false, code: 'unknown_round', message: 'RETRY applies to a round.' };
  const researcher = activeResearchers(state).find((r) => r.letter === letter);
  const entry = round.entries[letter];
  if (!researcher || !entry) return { ok: false, code: 'unknown_researcher', message: `${researcherName(letter)} is not in round ${n}.` };
  if (entry.state !== 'failed' && entry.state !== 'timed_out') return { ok: false, code: 'not_retryable', message: 'RETRY applies to a researcher marked failed or timed out.' };
  if (openRetry(state, letter) || openCatchUp(state, letter) || d().isBusy(researcher.workflowId)) return { ok: false, code: 'busy', message: `${researcherName(letter)} is still working. Try again when it is idle.` };
  const reason = entry.reason ?? (entry.state === 'timed_out' ? 'No reply before the deadline.' : 'The turn failed.');
  const blocks = await readWorkSoFar(join(state.membersCwd, '.arco', 'workflows', researcher.workflowId), Date.parse(round.startedAt));
  const fileName = `work-so-far-round-${n}.md`;
  const file = workSoFarFile({ title: `Round ${n}`, letter, roundText: round.text, reason, blocks });
  const late = !!round.releasedAt;
  const now = d().now();
  const minutes = late ? await timeLimit() : 0;
  const key = retryKey(n, letter);
  let accepted = false;
  const next = await updateResearch(clusterId, (s) => {
    const current = s.rounds.find((r) => r.n === n);
    const e = current?.entries[letter];
    if (!current || !e || (e.state !== 'failed' && e.state !== 'timed_out') || openRetry(s, letter) || openCatchUp(s, letter)) return false;
    if (!current.releasedAt) {
      current.entries[letter] = { ...e, state: 'waiting', retry: { at: iso(now) } };
      delete current.entries[letter].at; delete current.entries[letter].reason; delete current.entries[letter].wakes;
    } else {
      e.retry = { at: iso(now), key };
      s.retries = [...(s.retries ?? []).filter((r) => r.n !== key), {
        n: key, text: current.text, startedAt: iso(now), deadline: iso(now + minutes * 60_000), timeoutMs: minutes * 60_000,
        entries: { [letter]: { state: 'waiting' } }, targeted: [], lateFor: { round: n, letter },
      }];
    }
    accepted = true;
  });
  if (!next || !accepted) return { ok: false, code: 'busy', message: `${researcherName(letter)} changed state. Try again.` };
  const text = `(research retry) Round ${n}: your turn ended before you sent your report (${reason}). Arco saved your work so far in the attached file ${fileName}. Read that file first, then continue from where you stopped. Do not repeat searches already done unless you need their results again. Then send your report with peer_send.${late ? ' The round was already released; your report is added to it as a late report.' : ''}\n\nThe round text:\n\n${round.text}`;
  const held = d().operatorOnly?.(researcher.workflowId) === true;
  const msgId = d().mintMsgId();
  const runKey = late ? key : n;
  if (held) {
    await updateResearch(clusterId, (s) => {
      const e = roundByKey(s, runKey)?.entries[letter];
      if (!e || e.state !== 'waiting') return false;
      e.heldMsgId = msgId;
    });
  }
  const bytes = Buffer.from(file, 'utf8');
  await d().enqueue(researcher.workflowId, {
    msgId, fromWorkflowId: state.directorWorkflowId, fromDisplayName: 'Arco research', toWorkflowId: researcher.workflowId,
    content: text, createdAt: iso(now), delivered: false,
    artifacts: [{ name: fileName, contentBase64: bytes.toString('base64'), byteLength: bytes.length }],
  }, { maxContentBytes: RELEASE_MAX_BYTES });
  if (!held && !d().isBusy(researcher.workflowId)) wakeMember(researcher.workflowId, `(research retry) Round ${n}: Arco research sent you your work so far and a message about this round; both are in your mail. Read them, continue and send your report with peer_send.`);
  const latest = await loadResearch(clusterId);
  const run = latest && roundByKey(latest, runKey);
  if (late && run) schedule(clusterId, run);
  d().notify(clusterId);
  return { ok: true, late, file: fileName };
}

// A retry run for a released round settled: its report joins that round as a
// late report and the Director is told to add it; a failure is one line.
async function finishRetry(state: ResearchState, run: ResearchRound): Promise<boolean> {
  const { round: n, letter } = run.lateFor!;
  const entry = run.entries[letter];
  const name = researcherName(letter);
  if (entry?.state === 'replied') {
    const next = await updateResearch(state.clusterId, (s) => {
      const round = s.rounds.find((r) => r.n === n);
      if (!round) return false;
      round.entries[letter] = { state: 'replied', at: entry.at, source: entry.source, report: entry.report, ...(entry.artifacts ? { artifacts: entry.artifacts } : {}), late: run.releasedAt ?? entry.at };
      if (run.contaminated) round.contaminated = true;
      if (run.boundaryWarning) round.boundaryWarning = true;
    });
    const round = next?.rounds.find((r) => r.n === n);
    if (next && round) {
      const written = await writeReleasedRound(next, round);
      await writeProjectFiles(next);
      const path = written[letter]?.reportPath;
      const rel = path?.startsWith(next.folder) ? path.slice(next.folder.length + 1) : path;
      await noteDirector(next, `Late report from ${name} for round ${n}${rel ? ` (${rel})` : ''}. Add it to synthesis.md and say that it arrived later.${run.contaminated ? ' Independence check failed: treat it as contaminated.' : ''}\n\n${(entry.report ?? '').trim()}`.slice(0, RELEASE_INLINE_BYTES));
      if (d().isBusy(next.directorWorkflowId)) directorWakes.add(next.clusterId);
      else wakeMember(next.directorWorkflowId, `(research) A late report from ${name} for round ${n} is in your mail. Add it to synthesis.md and say that it arrived later.`);
    }
  } else if (entry && entry.state !== 'removed') {
    await noteDirector(state, `${name}'s retry for round ${n} ended without a report (${entry.state.replace('_', ' ')}${entry.reason ? `: ${entry.reason}` : ''}).`);
  }
  await sendDeferredRound(state, letter);
  d().notify(state.clusterId);
  return true;
}

// Arco's own line to the Research Director, read on its next turn.
async function noteDirector(state: ResearchState, content: string): Promise<void> {
  await d().enqueue(state.directorWorkflowId, {
    msgId: d().mintMsgId(), fromWorkflowId: state.directorWorkflowId, fromDisplayName: 'Arco research',
    toWorkflowId: state.directorWorkflowId, content, createdAt: iso(d().now()), delivered: false,
  }, { maxContentBytes: RELEASE_MAX_BYTES });
}

export interface JoiningResearcher {
  workflowId: string;
  provider: ResearchResearcher['provider'];
  model: string;
  effort?: string;
  claudeTransport?: 'native' | 'cli';
}

// docs/RESEARCH.md - a researcher added to a running project. It is left
// out of a round already in flight and included from the next one. With
// `catchUp` and at least one round sent, the round 1 text runs for it alone.
export async function addResearcher(clusterId: string, joining: JoiningResearcher, catchUp: boolean): Promise<{ letter: string; fromRound: number; catchUp: boolean } | null> {
  const timeoutMinutes = await timeLimit();
  const now = d().now();
  let added: { letter: string; fromRound: number; catchUp: boolean } | undefined;
  let run: ResearchRound | undefined;
  const state = await updateResearch(clusterId, (s) => {
    const letter = nextResearchLetter(s);
    const open = openRound(s);
    const fromRound = open ? open.n + 1 : s.rounds.length + 1;
    s.researchers.push({ workflowId: joining.workflowId, letter, provider: joining.provider, model: joining.model,
      ...(joining.effort ? { effort: joining.effort } : {}), ...(joining.claudeTransport ? { claudeTransport: joining.claudeTransport } : {}),
      joinedAt: iso(now), joinedFromRound: fromRound });
    const first = s.rounds[0];
    if (catchUp && first) {
      run = { n: catchUpKey(letter), text: first.text, startedAt: iso(now), deadline: iso(now + timeoutMinutes * 60_000), timeoutMs: timeoutMinutes * 60_000,
        entries: { [letter]: { state: 'waiting' } }, targeted: [], catchUp: letter };
      s.catchUps = [...(s.catchUps ?? []), run];
    }
    added = { letter, fromRound, catchUp: !!run };
  });
  if (!state || !added) return null;
  const researcher = researcherFor(state, joining.workflowId)!;
  const name = researcherName(added.letter);
  await noteDirector(state, run
    ? `${name} joined. It is included from round ${added.fromRound}. A catch-up on the original brief is running; its report will be released to you alone.`
    : `${name} joined. It is included from round ${added.fromRound}.${state.rounds.length ? ' It has not seen the original brief.' : ''}`);
  if (run) {
    const current = roundByKey(state, run.n)!;
    if (researcher.claudeTransport === 'cli' || researcher.provider === 'codex') await ensureResearchTripwires(clusterId);
    await writeRoundStart(state, current);
    await sendRoundText(state, current, researcher);
    schedule(clusterId, current);
  } else await writeProjectFiles(state);
  d().notify(clusterId);
  return added;
}

export type RemoveResearcherResult = { ok: true; workflowId: string; releasedRound?: number } | { ok: false; code: 'not_research' | 'unknown_researcher' | 'last_researcher' };

// docs/RESEARCH.md - the operator removes a researcher. Its earlier reports
// stay; a round in flight is released without it; an open catch-up closes.
export async function removeResearcher(clusterId: string, letter: string): Promise<RemoveResearcherResult> {
  const at = iso(d().now());
  let result = { ok: false, code: 'not_research' } as RemoveResearcherResult;
  let openN: number | undefined;
  let retryRun: number | undefined;
  const state = await updateResearch(clusterId, (s) => {
    const r = activeResearchers(s).find((x) => x.letter === letter.toUpperCase());
    if (!r) { result = { ok: false, code: 'unknown_researcher' }; return false; }
    if (activeResearchers(s).length === 1) { result = { ok: false, code: 'last_researcher' }; return false; }
    r.removedAt = at;
    const removed = { state: 'removed' as const, at, reason: 'Removed by the operator.' };
    const catchUp = openCatchUp(s, r.letter);
    if (catchUp) { catchUp.entries[r.letter] = removed; catchUp.releasedAt = at; }
    const retry = openRetry(s, r.letter);
    if (retry) { retry.entries[r.letter] = removed; retry.releasedAt = at; retryRun = retry.n; }
    const open = openRound(s);
    if (open?.entries[r.letter]?.state === 'waiting') { open.entries[r.letter] = removed; openN = open.n; }
    result = { ok: true, workflowId: r.workflowId, ...(openN ? { releasedRound: openN } : {}) };
  });
  if (!state || !result.ok) return result;
  const key = catchUpKey(letter.toUpperCase());
  for (const k of [key, ...(retryRun !== undefined ? [retryRun] : [])]) { clearTimeout(timers.get(`${clusterId}:${k}`)); timers.delete(`${clusterId}:${k}`); }
  const rest = activeResearchers(state).map((r) => r.letter);
  await noteDirector(state, `${researcherName(letter.toUpperCase())} was removed. Its earlier reports stay.${openN ? ` Round ${openN} is released without it.` : ''} Later rounds go to ${rest.join(', ')}.`);
  await writeProjectFiles(state);
  const catchUp = state.catchUps?.find((c) => c.n === key);
  if (catchUp) await atomicWriteFile(join(roundDir(state.folder, key), 'round.md'), renderRound(state, catchUp)).catch(() => undefined);
  if (openN) await maybeRelease(clusterId, openN);
  d().notify(clusterId);
  return result;
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
    for (const catchUp of [...(state?.catchUps ?? []), ...(state?.retries ?? [])]) if (!catchUp.releasedAt) schedule(clusterId, catchUp);
    const round = state && openRound(state);
    if (round) {
      schedule(clusterId, round);
      for (const researcher of state.researchers) {
        if (researcher.signInNeeded && round.entries[researcher.letter]?.state === 'waiting' && !d().isBusy(researcher.workflowId)) {
          wakeMember(researcher.workflowId, `(research) The server restarted during sign-in recovery for round ${round.n}. Continue the existing research task after sign-in; do not repeat completed actions.\n\n${round.text}`);
        }
      }
    }
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
  wakeMember(workflowId, toResearcher
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
    `(research) Brief for ${state.name}`,
    'If the brief below is clear enough to research, send round 1 now with research_round, built from it. If it is too unclear to research, ask the operator one question first and send no round.',
    '',
    'Brief from the operator:',
    '',
    state.brief,
  ].join('\n');
}

export function startResearchDirector(state: Pick<ResearchState, 'name' | 'brief' | 'directorWorkflowId'>): boolean {
  if (!deps) return false;
  wakeMember(state.directorWorkflowId, directorStartPrompt(state));
  return true;
}

// docs/RESEARCH.md - a project reopened from the Research library. A new
// Research Director starts by reading the project files; a resumed one gets
// a note in its mail. Neither sends a round until the operator asks.
export function directorReopenPrompt(state: ResearchState, released: number[]): string {
  const letters = activeResearchers(state).map((r) => r.letter).join(', ');
  return [
    `(research) Reopened project: ${state.name}`,
    'This research project was worked on earlier and has been reopened. You are its new Research Director.',
    'Before anything else, read research.json, brief.md, synthesis.md (if it exists) and director-log.md in the project folder, then the latest round folder under rounds/.',
    ...(state.savedQuickChat ? ['Read saved-chat.md for the saved Quick research conversation and later follow-ups.'] : []),
    `Then tell the operator in a few lines where the project stands and what could be researched next. Send no round until the operator asks for one. The earlier researchers are gone; rounds now go to ${letters}.`,
    ...(released.length ? [releasedNote(released)] : []),
  ].join('\n');
}

function releasedNote(released: number[]): string {
  const names = released.map((n) => roundTitle({ n, ...(n < 0 ? { catchUp: catchUpLetter(n) } : {}) }));
  return `${names.join(' and ')} ${names.length === 1 ? 'was' : 'were'} still open when the project closed and ${names.length === 1 ? 'is' : 'are'} now released with the replies that had arrived; read ${names.length === 1 ? 'its' : 'their'} files.`;
}

export async function announceResearchReopen(state: ResearchState, resumed: boolean, released: number[]): Promise<void> {
  if (!deps) return;
  if (!resumed) { wakeMember(state.directorWorkflowId, directorReopenPrompt(state, released)); d().notify(state.clusterId); return; }
  const letters = activeResearchers(state).map((r) => r.letter).join(', ');
  await noteDirector(state, [
    `This project was reopened on ${state.reopenedAt ?? iso(d().now())}. The earlier researchers are gone; rounds now go to ${letters}.`,
    'Continue from synthesis.md. Send no round until the operator asks for one.',
    ...(state.savedQuickChat ? ['Read saved-chat.md for the saved Quick research conversation and later follow-ups.'] : []),
    ...(released.length ? [releasedNote(released)] : []),
  ].join(' '));
  d().notify(state.clusterId);
}
