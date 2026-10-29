// Workbench Expansion §F2 — Recall: conversation summaries.
//
// Generates a durable, searchable recap of ONE conversation — "a point in time
// I can go back to": what the thread was about, key decisions, current state,
// open threads. Written to the machine-global recall home at
// ~/.arco/recall/<wfid>/summary.md and linked from the index (summaryRef).
//
// FENCE-CLEARANCE (CLAUDE.md hard fences; docs/RECALL.md Part F preamble): the
// rejected pattern is *second-LLM summarization IN THE AGENT LOOP* (`distill` —
// doubles spend, fails closed). This is fence-CLEAR because:
//   (a) it runs ONLY operator-triggered (the Recall row's Summarize button) or
//       operator-armed-on-close (a default-OFF toggle) — NEVER in the per-turn
//       loop. There is no caller in any turn path.
//   (b) it has a DETERMINISTIC fallback (summarizePriorTurns digest) so it
//       NEVER fails closed and NEVER blocks the caller — a failed/unauthed LLM
//       call degrades to the structural digest, which is not an error.
//   (c) the full transcript stays the source of truth (this only ever reads
//       events.jsonl; the summary is an additive artifact).
//   (d) it is reversible — delete the summary.md and clear summaryRef.
//
// The LLM call is a SINGLE bounded read-only turn — no loops, no multi-pass
// refinement, no second LLM judging the summary. Mirrors the Handoff
// fresh-summarizer spawn shape (read-only tool allowlist, outputStyle:'normal',
// codex account passthrough) but writes to the RECALL location, not the handoff
// dir.

import { promises as fs } from 'fs';
import path from 'path';
import { WorkerManager } from '../workers/WorkerManager.js';
import { replayEvents } from '../workflowStore.js';
import { renderTranscript, summarizePriorTurns } from '../primitives/exportContext.js';
import { getRecallIndex, recallHomeDir, recallSummaryPath } from './index.js';
import { recordSessionSummary } from '../workflows/sessionIndex.js';
import type {
  ServerMessage,
  ProviderName,
  ModelName,
  EffortLevel,
} from '@arco/shared';

const WFID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
// Stable ref stored in the index + fetched by the client. Relative to the
// recall home so the route resolves it under ~/.arco/recall/<wfid>/.
const SUMMARY_FILE = 'summary.md';

export interface SummarizerConfig {
  provider: ProviderName;
  model: ModelName;
  effort: EffortLevel;
  providerAccountRef?: string;
  codexHome?: string;
}

export interface SummarizeOptions {
  wfid: string;
  summarizer: SummarizerConfig;
  // Shared WorkerManager (the workflow's, or a transient one) used to spawn the
  // short-lived read-only summarizer turn.
  manager: WorkerManager;
}

export interface SummarizeResult {
  // Stable ref persisted in the index + served to the client. Null only if we
  // couldn't even write the deterministic fallback (e.g. the workflow isn't in
  // the index, or disk write failed) — the caller treats that as the lone hard
  // failure (degraded summary is NOT a failure).
  summaryRef: string | null;
  // true  = bounded LLM summary landed.
  // false = deterministic-fallback digest landed (LLM failed / unauthed / empty,
  //         OR no provider was supplied). NOT an error — the summary still exists.
  ok: boolean;
  error?: string;
}

// The recall-summary framing — a dense recap "a point in time I can go back to."
// Distinct from the Handoff framing (which targets resuming work); this targets
// retrospective recall. Read-only: the worker reads the transcript text we
// supply, never the live session.
function buildFraming(): string {
  return [
    'You are writing a durable RECALL SUMMARY of a past coding conversation —',
    'a point in time the operator can return to weeks later and re-orient fast.',
    '',
    'Write a dense, factual markdown recap. Cover, in this order:',
    '1. **What this thread was about** — the goal / problem in one or two lines.',
    '2. **Key decisions** — choices made and why (bullet list).',
    '3. **Current state** — what is done / working / in place now.',
    '4. **Open threads** — what is unresolved, deferred, or next.',
    '',
    'Be specific (name files, commands, components). No preamble, no sign-off,',
    'no "here is the summary" — just the markdown. Aim for tight, scannable',
    'prose; this is an archive entry, not a status report to a human in a chat.',
  ].join('\n');
}

function buildSummarizerInput(framing: string, transcript: string): string {
  return [framing, '', '---', '', '## Transcript', '', transcript || '(empty transcript)'].join('\n');
}

// Deterministic fallback — the F1 title + the structural digest from
// summarizePriorTurns (NO LLM). This is what lands when the LLM call fails, is
// unauthed, returns empty, or when no provider was supplied. It is a real,
// useful summary (not an error placeholder) — the fence's "never fails closed".
function buildDeterministicSummary(title: string, events: ServerMessage[]): string {
  const digest = summarizePriorTurns(events);
  return [
    `# ${title}`,
    '',
    '_Deterministic summary (no LLM) — generated from the transcript structure._',
    '',
    digest || '(no operator turns recorded in this conversation)',
    '',
  ].join('\n');
}

// summarizeWorkflow — operator-triggered / operator-armed only. NEVER call this
// from a per-turn path. Loads the workflow's events, runs ONE bounded read-only
// LLM summary turn when a provider is available, writes summary.md, and on ANY
// failure writes the deterministic fallback to the SAME file. Never throws,
// never blocks beyond the single spawn; then sets summaryRef in the index.
export async function summarizeWorkflow(opts: SummarizeOptions): Promise<SummarizeResult> {
  const { wfid, summarizer, manager } = opts;
  if (!WFID_PATTERN.test(wfid)) {
    return { summaryRef: null, ok: false, error: 'invalid workflow id' };
  }

  const index = getRecallIndex();
  const entry = index.get(wfid);
  if (!entry) {
    // Can only summarize a conversation the index already knows (it carries the
    // cwd we need to locate events.jsonl). Backfill should have indexed it.
    return { summaryRef: null, ok: false, error: 'workflow not found in recall index' };
  }

  // Load the transcript. The full events.jsonl is the source of truth; we only
  // read it. An unreadable/empty transcript still produces a (thin) summary.
  let events: ServerMessage[] = [];
  try {
    events = await replayEvents(entry.cwd, wfid, 0);
  } catch {
    events = [];
  }

  const summaryPath = recallSummaryPath(wfid);
  if (!summaryPath) {
    return { summaryRef: null, ok: false, error: 'invalid workflow id' };
  }
  const dir = path.dirname(summaryPath);

  // Write helper — persists the body + records summaryRef in the index. The
  // FTS `summary` column gets the resolved BODY so §F3 search hits the text.
  const persist = async (body: string): Promise<boolean> => {
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(summaryPath, body.endsWith('\n') ? body : body + '\n', 'utf8');
      index.setSummary(wfid, `${wfid}/${SUMMARY_FILE}`, body);
      // docs/ARCHITECTURE.md - Recall-summary trigger: surface the summary's
      // first line as the session index's "where this left off" subtitle.
      // Fired-and-logged (projection; must not fail the summary write).
      recordSessionSummary(entry.cwd, wfid, body).catch((err) => {
        console.error(`[arco] session index subtitle update failed for ${wfid.slice(0, 8)}:`, err);
      });
      return true;
    } catch (err) {
      console.error(`[arco] recall summary write failed for ${wfid.slice(0, 8)}:`, err);
      return false;
    }
  };

  // ── Attempt the bounded LLM summary. ANY problem degrades to the fallback. ──
  const llmBody = await tryLlmSummary(events, summarizer, manager, wfid).catch(() => '');
  if (llmBody && llmBody.trim()) {
    const wrote = await persist(llmBody.trim());
    if (wrote) return { summaryRef: `${wfid}/${SUMMARY_FILE}`, ok: true };
    // Disk write failed even for the LLM body — fall through to deterministic
    // (which will hit the same disk, but try once more; if it also fails the
    // caller learns via summaryRef:null).
  }

  // ── Deterministic fallback — never fails closed. ──
  const fallback = buildDeterministicSummary(entry.title, events);
  const wrote = await persist(fallback);
  return wrote
    ? { summaryRef: `${wfid}/${SUMMARY_FILE}`, ok: false }
    : { summaryRef: null, ok: false, error: 'could not write summary file' };
}

// One bounded read-only summarizer turn. Returns the collected text, or '' on
// any failure (no provider work, spawn error, empty output) so the caller
// degrades to the deterministic digest. Mirrors the Handoff fresh-summarizer
// spawn shape.
async function tryLlmSummary(
  events: ServerMessage[],
  summarizer: SummarizerConfig,
  manager: WorkerManager,
  wfid: string,
): Promise<string> {
  const transcript = renderTranscript(events);
  const input = buildSummarizerInput(buildFraming(), transcript);

  let collected = '';
  const spawnId = `recall-summary-${wfid.slice(0, 8)}-${Date.now().toString(36)}`;
  const r = await manager.spawn(
    {
      id: spawnId,
      task: input,
      model: summarizer.model,
      effort: summarizer.effort,
      provider: summarizer.provider,
      tools: summarizer.provider === 'claude' || summarizer.provider === 'ollama'
        ? ['Read', 'Grep', 'Glob']
        : undefined,
    },
    (ev) => {
      if (ev.type === 'worker_text') collected += ev.text;
    },
    {
      cwd: recallHomeDir(),
      skipPermissions: false,
      // docs/PROVIDERS.md - forced normal regardless of any source-tab
      // outputStyle (this is an archive artifact, terseness loses detail).
      outputStyle: 'normal',
      ...(summarizer.provider === 'codex' && summarizer.codexHome
        ? { providerAccountRef: summarizer.providerAccountRef, codexHome: summarizer.codexHome }
        : {}),
    },
  );
  if (r.error) return '';
  return (collected.trim() || r.text || '').trim();
}
