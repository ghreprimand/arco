import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../../atomicFile.js';
import { serverFoldSeed, type ServerCompactionBlock } from './serverFold.js';

const SUMMARY_CACHE_VERSION = 1;
const SUMMARY_CACHE_KIND = 'claude-native-resume-summary';
const DEFAULT_REPLAY_BYTES = 1 * 1024 * 1024;
const TAIL_LINE_BACKTRACK_BYTES = 1 * 1024 * 1024;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const RESUME_EXACT_REPLAY_BYTES = readPositiveIntEnv(
  'ARCHON_CLAUDE_NATIVE_EXACT_REPLAY_BYTES',
  DEFAULT_REPLAY_BYTES,
);
export const RESUME_RECENT_TAIL_BYTES = readPositiveIntEnv(
  'ARCHON_CLAUDE_NATIVE_RECENT_TAIL_BYTES',
  DEFAULT_REPLAY_BYTES,
);

export type ClaudeResumeMessage = {
  role: 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string }>;
};

type ReplayEvent = {
  type?: string;
  content?: string;
  text?: string;
  error?: string;
  seq?: number;
  // PHASE_9_FORKS_PLAN.md — lineage link stamped by persistAndStampSeq on the
  // on-disk envelope (workflowStore.ts). The branch-filter pre-pass walks this
  // to reconstruct the kept branch; the existing flat-seq loop ignores it.
  parentEventSeq?: number;
  // Carried by a `leaf_move` event — the seq the head was moved to. The pre-pass
  // treats `leaf_move` as a REDIRECT node: when the ancestry walk lands on one it
  // jumps to `targetSeq` instead of following parentEventSeq, which is what
  // prunes the abandoned span without any write-path change.
  targetSeq?: number;
  phase?: string;
  tool?: string;
  name?: string;
  input?: string;
  // Carried by a `native_compacted` event — the operator-triggered in-place
  // compaction's summary. Replay resets to this point (like a handoff) and
  // seeds the summary, so a compact survives restart.
  summary?: string;
  // NATIVE_COMPACTION_PLAN Phase 2 — keep-last-N verbatim tail. The live
  // `compactInPlace` keeps the last few user/assistant messages after the
  // seed so the active working set survives the fold. Those messages occur
  // BEFORE this marker, so replay (which resets at the marker) would lose
  // them — they're persisted here and re-appended via the SAME helper, so
  // live and replayed workers land byte-identical. Already projected to the
  // clean resume shape (string user content / single-text-block assistant).
  keptTail?: ClaudeResumeMessage[];
  // Server Fold (`context_folded {engine:'server'}`) — the signed compaction
  // block + the RAW kept turns. Reseeded via the SAME serverFoldSeed the live
  // worker used, so the signed block goes back verbatim and first.
  compactionBlock?: ServerCompactionBlock;
  keptMessages?: unknown[];
};

type ReplayOptions = {
  exactReplayBytes?: number;
  recentTailBytes?: number;
  // PHASE_9_FORKS_PLAN.md — when the workflow's head has been rewound, replay
  // walks the lineage from this seq instead of flat seq order. Branch-aware
  // replay needs the FULL event list to resolve the parent walk across any
  // tail/older boundary, so when set we bypass the byte-range summary path and
  // read the whole file (sub-phase 4 hardens the rotated-off-disk case).
  leafSeq?: number;
};

export type ResumeReplayResult = {
  messages: ClaudeResumeMessage[];
  mode: 'empty' | 'exact' | 'summary_tail';
  eventBytes: number;
  summaryThroughSeq?: number;
  summaryBytes?: number;
  tailEvents?: number;
  // PHASE_9_FORKS_PLAN.md sub-phase 4 — true when a branch-aware (leafSeq)
  // replay walked into ancestry that had rotated off the size-capped log, so
  // the branch was reconstructed from what survived rather than replayed in
  // full. The caller surfaces this (hygiene-B: no silent lossy degradation).
  reconstructed?: boolean;
};

type SummaryCache = {
  version: typeof SUMMARY_CACHE_VERSION;
  kind: typeof SUMMARY_CACHE_KIND;
  workflowId: string;
  sourceSize: number;
  tailStartByte: number;
  throughSeq: number | null;
  lastHandoffSeq: number | null;
  summary: string;
  updatedAt: string;
};

type SummaryBuild = {
  summary: string;
  throughSeq: number | null;
  lastHandoffSeq: number | null;
};

function workflowDir(cwd: string, workflowId: string): string {
  return join(cwd, '.archon', 'workflows', workflowId);
}

function eventsPath(cwd: string, workflowId: string): string {
  return join(workflowDir(cwd, workflowId), 'events.jsonl');
}

function summaryCachePath(cwd: string, workflowId: string): string {
  return join(workflowDir(cwd, workflowId), 'resume-summary.json');
}

async function readByteRange(path: string, start: number, length: number): Promise<string> {
  const fh = await fs.open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

async function findTailReplayStart(path: string, desiredStart: number): Promise<{ start: number; completeLine: boolean }> {
  if (desiredStart <= 0) return { start: 0, completeLine: true };
  const probeStart = Math.max(0, desiredStart - TAIL_LINE_BACKTRACK_BYTES);
  const raw = await readByteRange(path, probeStart, desiredStart - probeStart);
  const lines = raw.split('\n');
  let cursor = probeStart;
  let turnStart: number | null = null;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const lineStart = cursor;
    cursor += Buffer.byteLength(line, 'utf8') + 1;
    if (line.includes('"type":"user_message_echo"')) {
      turnStart = lineStart;
    }
  }
  if (turnStart !== null) return { start: turnStart, completeLine: true };
  const idx = raw.lastIndexOf('\n');
  if (idx >= 0) return { start: probeStart + idx + 1, completeLine: true };
  return { start: desiredStart, completeLine: false };
}

function parseJsonl(raw: string, opts: { dropFirstPartial?: boolean; dropLastPartial?: boolean } = {}): ReplayEvent[] {
  const lines = raw.split('\n');
  if (opts.dropFirstPartial && lines.length > 1) lines.shift();
  if (opts.dropLastPartial && raw.length > 0 && !raw.endsWith('\n')) lines.pop();

  const events: ReplayEvent[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as ReplayEvent;
      events.push(parsed);
    } catch {
      // Corrupt or partial entries are ignored; events.jsonl remains append-only.
    }
  }
  return events;
}

function cloneMessages(messages: ClaudeResumeMessage[]): ClaudeResumeMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? m.content
      : m.content.map((b) => ({ ...b })),
  }));
}

// Post-compaction seed for the operator-triggered in-place compact
// (worker.compactInPlace). Exported so the LIVE worker and a REPLAYED worker
// build byte-identical history from the same summary — divergent wording would
// split the prompt cache and confuse a transcript diff. Distinct framing from
// `summarySeedMessages` (which labels a deterministic resume digest).
//
// NATIVE_COMPACTION_PLAN Phase 2: `keptTail` is the keep-last-N verbatim tail.
// The live worker passes the last few user/assistant messages (already
// projected to the clean resume shape) so the freshly-active working set
// survives the fold; replay passes the SAME array from the persisted
// `native_compacted.keptTail`. Because BOTH sites call THIS helper with the
// SAME data, the seed+tail array is byte-identical across live and replay —
// the load-bearing prompt-cache / transcript-diff invariant
// (docs/GOTCHAS.md § Claude Native transport). The tail is appended AFTER the
// seed (chronological: summary of older history, then the recent verbatim
// turns), and is cloned so callers can't alias into the helper's output.
export function compactSummarySeed(summary: string, keptTail: ClaudeResumeMessage[] = []): ClaudeResumeMessage[] {
  const trimmed = summary.trim();
  if (!trimmed) return [];
  return [
    {
      role: 'user',
      content: [
        'Summary of the conversation so far (the full transcript was compacted to free context):',
        '',
        trimmed,
      ].join('\n'),
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Understood. I\'ll continue from this summary.' }],
    },
    ...cloneMessages(keptTail),
  ];
}

function summarySeedMessages(summary: string): ClaudeResumeMessage[] {
  const trimmed = summary.trim();
  if (!trimmed) return [];
  return [
    {
      role: 'user',
      content: [
        'Previous workflow context (deterministic summary of older events before the exact recent transcript):',
        '',
        trimmed,
      ].join('\n'),
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Acknowledged. I will use the prior workflow summary as context.' }],
    },
  ];
}

// PHASE_9_FORKS_PLAN.md §5 — branch-aware replay pre-pass. The replay loop below
// walks FLAT seq order; this filters the event list to just the ancestry of
// `leafSeq` first, so a rewound head replays only its own branch and the
// abandoned span is excluded. MUST run before any byte-range summarization
// (callers apply it to the full event list, not a tail slice) or the summary
// pulls in off-branch events.
//
// Algorithm — walk ancestry from the leaf, collecting an in-scope seq set:
//   cur = leafSeq
//   repeat: add cur; if events[cur] is a `leaf_move`, jump to its targetSeq
//           (the redirect — this is what prunes the abandoned branch);
//           else step to parentEventSeq ?? cur-1.
//   stop when the next step is < 1, undefined, or already visited (cycle guard).
// Then keep events whose seq ∈ set, in their original ascending order.
//
// `leafSeq` ABSENT ⇒ identity (return events unchanged) ⇒ byte-identical to
// pre-Phase-9 behavior. This is the load-bearing no-regression invariant.
export function walkBranchSeqs(
  events: ReplayEvent[],
  startSeq: number,
): { inScope: Set<number>; truncated: boolean } {
  const bySeq = new Map<number, ReplayEvent>();
  for (const e of events) {
    if (typeof e.seq === 'number') bySeq.set(e.seq, e);
  }
  const inScope = new Set<number>();
  let truncated = false;
  let cur: number | undefined = startSeq;
  while (typeof cur === 'number' && cur >= 1 && !inScope.has(cur)) {
    const ev = bySeq.get(cur);
    if (!ev) {
      // The walk referenced an ancestry seq that is NOT in the loaded events.
      // Since the leafSeq replay path reads the whole file, "not loaded" means
      // it has physically rotated off the size-capped log ⇒ the branch can only
      // be RECONSTRUCTED, not replayed byte-for-byte (hygiene-B: surface this,
      // never silently degrade a "lossless rewind" into a lossy one). Don't
      // record the missing seq — inScope holds only events that survived.
      truncated = true;
      break;
    }
    inScope.add(cur);
    let next: number | undefined;
    if (ev.type === 'leaf_move' && typeof ev.targetSeq === 'number') {
      // Redirect: jump to the rewind target rather than the linear predecessor.
      next = ev.targetSeq;
    } else if (typeof ev.parentEventSeq === 'number') {
      next = ev.parentEventSeq;
    } else {
      // Present, but no parent field ⇒ linear convention OR the genesis event
      // (seq 1, parent 0). Step to seq-1; the `>= 1` guard stops at the root.
      next = cur - 1;
    }
    cur = next;
  }
  return { inScope, truncated };
}

export function filterEventsToBranch(events: ReplayEvent[], leafSeq?: number): ReplayEvent[] {
  if (typeof leafSeq !== 'number') return events;
  const { inScope } = walkBranchSeqs(events, leafSeq);
  return events.filter((e) => typeof e.seq === 'number' && inScope.has(e.seq));
}

// Preserve the worker's replay invariants: only completed user/assistant
// pairs survive, and a successful handoff resets everything before it.
export function buildMessagesFromReplayEvents(
  events: ReplayEvent[],
  initialMessages: ClaudeResumeMessage[] = [],
  maxSeq?: number,
  leafSeq?: number,
): ClaudeResumeMessage[] {
  const messages = cloneMessages(initialMessages);
  const scoped = typeof leafSeq === 'number' ? filterEventsToBranch(events, leafSeq) : events;
  let userBuf = '';
  let assistantBuf = '';
  const flushPair = (): void => {
    if (userBuf && assistantBuf) {
      messages.push({ role: 'user', content: userBuf });
      messages.push({ role: 'assistant', content: [{ type: 'text', text: assistantBuf }] });
    }
    userBuf = '';
    assistantBuf = '';
  };

  for (const entry of scoped) {
    if (typeof maxSeq === 'number' && typeof entry.seq === 'number' && entry.seq > maxSeq) break;
    const t = entry.type ?? '';
    if (t === 'handoff_artifact_ready' && !entry.error) {
      messages.length = 0;
      userBuf = '';
      assistantBuf = '';
    } else if ((t === 'native_compacted' || t === 'context_folded') && typeof entry.summary === 'string') {
      // Operator-triggered in-place compaction OR a §2.1 Fold — same reset
      // semantics as a handoff, but instead of discarding everything we re-seed
      // the summary/digest (+ the verbatim tail) so the post-fold worker resumes
      // with exactly the context it had live. Events after this marker replay on
      // top. `keptTail` is passed straight to the SAME compactSummarySeed the
      // live worker used → byte-identical. Both markers share this branch so a
      // Fold survives restart on the proven native-compact replay rails.
      messages.length = 0;
      userBuf = '';
      assistantBuf = '';
      if (t === 'context_folded' && entry.compactionBlock && typeof entry.compactionBlock.content === 'string') {
        // Server Fold: raw blocks (thinking/tool) in the kept turns — the
        // text-only ClaudeResumeMessage type can't express them, hence the cast.
        const kept = Array.isArray(entry.keptMessages) ? entry.keptMessages : [];
        for (const m of serverFoldSeed(entry.compactionBlock, kept)) messages.push(m as unknown as ClaudeResumeMessage);
        continue;
      }
      const tail = Array.isArray(entry.keptTail) ? entry.keptTail : [];
      for (const m of compactSummarySeed(entry.summary, tail)) messages.push(m);
    } else if (t === 'user_message_echo' && typeof entry.content === 'string') {
      flushPair();
      userBuf = entry.content;
    } else if (t === 'primary_text' && typeof entry.text === 'string' && userBuf) {
      assistantBuf += entry.text;
    } else if ((t === 'primary_complete' || t === 'worker_complete') && userBuf) {
      flushPair();
    }
  }
  flushPair();
  return messages;
}

export function summarizeClaudeNativePriorTurns(events: ReplayEvent[]): SummaryBuild {
  interface Turn {
    userText: string;
    toolCounts: Map<string, number>;
    filesRead: Set<string>;
    filesWritten: Set<string>;
    bashCmds: string[];
    finalReply: string;
  }

  const turns: Turn[] = [];
  let throughSeq: number | null = null;
  let lastHandoffSeq: number | null = null;
  // Latest operator compaction's summary, if one falls in the older-than-tail
  // portion of a >1MB log. Resets prior turns (the summary already condensed
  // them) and is prepended to the regenerated summary so it isn't lost.
  let compactSummary: string | null = null;
  // Phase 2 keep-tail text from that same compaction (advisory digest only —
  // the byte-identical path is compactSummarySeed in buildMessagesFromReplayEvents;
  // this digest is the lossy >1MB fallback, where we just don't want the kept
  // verbatim turns to vanish from the operator-visible summary).
  let compactTail: string | null = null;

  for (const ev of events) {
    if (typeof ev.seq === 'number') throughSeq = ev.seq;
    if (ev.type === 'handoff_artifact_ready' && !ev.error) {
      turns.length = 0;
      lastHandoffSeq = typeof ev.seq === 'number' ? ev.seq : throughSeq;
      compactSummary = null;
      compactTail = null;
      continue;
    }
    if ((ev.type === 'native_compacted' || ev.type === 'context_folded') && typeof ev.summary === 'string') {
      turns.length = 0;
      compactSummary = ev.summary;
      compactTail = Array.isArray(ev.keptTail) && ev.keptTail.length > 0
        ? ev.keptTail
            .map((m) => {
              const text = typeof m.content === 'string'
                ? m.content
                : m.content.map((b) => b.text).join('');
              return `**${m.role}:** ${text.replace(/\s+/g, ' ').trim().slice(0, 400)}`;
            })
            .join('\n')
        : null;
      continue;
    }
    if (ev.type === 'user_message_echo') {
      turns.push({
        userText: (ev.content ?? '').trim(),
        toolCounts: new Map<string, number>(),
        filesRead: new Set<string>(),
        filesWritten: new Set<string>(),
        bashCmds: [],
        finalReply: '',
      });
      continue;
    }
    const cur = turns[turns.length - 1];
    if (!cur) continue;
    if (ev.type === 'primary_text' && typeof ev.text === 'string') {
      cur.finalReply += ev.text;
    } else if (ev.type === 'primary_tool_use') {
      const name = ev.tool ?? ev.name ?? 'unknown';
      cur.toolCounts.set(name, (cur.toolCounts.get(name) ?? 0) + 1);
      if (typeof ev.input !== 'string') continue;
      try {
        const args = JSON.parse(ev.input) as Record<string, unknown>;
        if ((name === 'Read' || name === 'NotebookEdit') && typeof args.file_path === 'string') {
          cur.filesRead.add(args.file_path);
        }
        if ((name === 'Write' || name === 'Edit') && typeof args.file_path === 'string') {
          cur.filesWritten.add(args.file_path);
        }
        if (name === 'Bash' && typeof args.command === 'string') {
          cur.bashCmds.push(args.command.split('\n')[0].slice(0, 120));
        }
      } catch {
        // Tool input is advisory in the summary; malformed JSON is skipped.
      }
    }
  }

  if (turns.length === 0 && !compactSummary) return { summary: '', throughSeq, lastHandoffSeq };

  const lines: string[] = [];
  if (compactSummary) {
    lines.push('## Earlier context (operator-compacted)');
    lines.push('');
    lines.push(compactSummary.trim());
    if (compactTail) {
      lines.push('');
      lines.push('### Recent verbatim turns kept at that compaction');
      lines.push(compactTail);
    }
    if (turns.length > 0) lines.push('');
  }
  if (turns.length > 0) lines.push('## Prior turns in this workflow (auto-summary)');
  turns.forEach((t, i) => {
    const head = t.userText.length > 120 ? t.userText.slice(0, 120) + '...' : t.userText;
    lines.push('');
    lines.push(`### Turn ${i + 1}: ${head}`);
    if (t.toolCounts.size > 0) {
      const counts: string[] = [];
      for (const [k, v] of t.toolCounts) counts.push(`${k}x${v}`);
      lines.push(`- Tools: ${counts.join(', ')}`);
    }
    if (t.filesWritten.size > 0) {
      lines.push(`- Files written: ${[...t.filesWritten].join(', ')}`);
    }
    if (t.filesRead.size > 0) {
      const reads = [...t.filesRead];
      const shown = reads.slice(0, 8);
      const extra = reads.length > 8 ? ` (+${reads.length - 8} more)` : '';
      lines.push(`- Files read: ${shown.join(', ')}${extra}`);
    }
    if (t.bashCmds.length > 0) {
      const shown = t.bashCmds.slice(-6);
      lines.push(`- Bash: ${shown.map((c) => '`' + c + '`').join('; ')}`);
    }
    if (t.finalReply.trim().length > 0) {
      const reply = t.finalReply.trim().replace(/\s+/g, ' ').slice(0, 240);
      lines.push(`- Assistant reply: "${reply}${t.finalReply.length > 240 ? '...' : ''}"`);
    }
  });
  return { summary: lines.join('\n'), throughSeq, lastHandoffSeq };
}

async function readSummaryCache(path: string, workflowId: string, sourceSize: number, tailStartByte: number): Promise<SummaryCache | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SummaryCache>;
    if (
      parsed.version === SUMMARY_CACHE_VERSION &&
      parsed.kind === SUMMARY_CACHE_KIND &&
      parsed.workflowId === workflowId &&
      parsed.sourceSize === sourceSize &&
      parsed.tailStartByte === tailStartByte &&
      typeof parsed.summary === 'string'
    ) {
      return parsed as SummaryCache;
    }
  } catch {
    // Missing or stale cache is rebuilt below.
  }
  return null;
}

async function writeSummaryCache(path: string, cache: SummaryCache): Promise<void> {
  try {
    // Advisory: a stale or missing cache is rebuilt, so this skips the fsync.
    // The atomic rename still matters — a torn file would be re-parsed as
    // garbage on every resume until something overwrote it.
    await atomicWriteFile(path, JSON.stringify(cache, null, 2), { durability: 'advisory' });
  } catch {
    // Resume should not fail because the advisory cache could not be written.
  }
}

export async function replayMessagesWithResumePolicy(
  cwd: string,
  workflowId: string,
  maxSeq?: number,
  opts: ReplayOptions = {},
): Promise<ResumeReplayResult> {
  const path = eventsPath(cwd, workflowId);
  let stat;
  try {
    stat = await fs.stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { messages: [], mode: 'empty', eventBytes: 0 };
    }
    throw err;
  }

  const exactReplayBytes = opts.exactReplayBytes ?? RESUME_EXACT_REPLAY_BYTES;
  const recentTailBytes = opts.recentTailBytes ?? RESUME_RECENT_TAIL_BYTES;

  // PHASE_9_FORKS_PLAN.md §5 — branch-aware replay. `meta.leafSeq` being set
  // signals "branch mode": the head was rewound at least once, so flat replay
  // would pull in abandoned spans. The lineage walk needs the FULL event list
  // to follow parentEventSeq / leaf_move redirects across any tail boundary, so
  // we bypass the byte-range summary path and read the whole file. (Sub-phase 4
  // hardens the case where the branch's ancestry has rotated off the cap.)
  //
  // The walk STARTS from the physical tail (newest event), not from the stored
  // leafSeq value: each rewind appends a fresh leaf_move at the tail and every
  // post-rewind turn appends after it, so the newest event is always on the
  // active branch and the most-recent redirect is always on its ancestry path.
  // This is what lets post-rewind turns be included WITHOUT advancing leafSeq
  // on every turn.
  if (typeof opts.leafSeq === 'number') {
    const raw = await fs.readFile(path, 'utf8');
    const events = parseJsonl(raw);
    let tailSeq: number | undefined;
    for (const e of events) {
      if (typeof e.seq === 'number' && (tailSeq === undefined || e.seq > tailSeq)) tailSeq = e.seq;
    }
    const walkStart = tailSeq ?? opts.leafSeq;
    const { truncated } = walkBranchSeqs(events, walkStart);
    return {
      messages: buildMessagesFromReplayEvents(events, [], maxSeq, walkStart),
      mode: 'exact',
      eventBytes: stat.size,
      ...(truncated ? { reconstructed: true } : {}),
    };
  }

  if (stat.size <= exactReplayBytes) {
    const raw = await fs.readFile(path, 'utf8');
    const events = parseJsonl(raw);
    return {
      messages: buildMessagesFromReplayEvents(events, [], maxSeq),
      mode: 'exact',
      eventBytes: stat.size,
    };
  }

  // HISTORY cutoffs are not normal resume. Keep their existing exact-tail
  // behavior so Spawn-from-here callers do not inherit a summary past maxSeq.
  if (typeof maxSeq === 'number') {
    const start = Math.max(0, stat.size - recentTailBytes);
    const raw = await readByteRange(path, start, stat.size - start);
    const events = parseJsonl(raw, { dropFirstPartial: start > 0 });
    return {
      messages: buildMessagesFromReplayEvents(events, [], maxSeq),
      mode: 'exact',
      eventBytes: stat.size,
      tailEvents: events.length,
    };
  }

  const desiredTailStartByte = Math.max(0, stat.size - recentTailBytes);
  const tailStart = await findTailReplayStart(path, desiredTailStartByte);
  const tailStartByte = tailStart.start;
  const tailRaw = await readByteRange(path, tailStartByte, stat.size - tailStartByte);
  const tailEvents = parseJsonl(tailRaw, { dropFirstPartial: !tailStart.completeLine });

  const cachePath = summaryCachePath(cwd, workflowId);
  let cache = await readSummaryCache(cachePath, workflowId, stat.size, tailStartByte);
  if (!cache) {
    const olderRaw = tailStartByte > 0 ? await readByteRange(path, 0, tailStartByte) : '';
    const olderEvents = parseJsonl(olderRaw, { dropLastPartial: !tailStart.completeLine });
    const built = summarizeClaudeNativePriorTurns(olderEvents);
    cache = {
      version: SUMMARY_CACHE_VERSION,
      kind: SUMMARY_CACHE_KIND,
      workflowId,
      sourceSize: stat.size,
      tailStartByte,
      throughSeq: built.throughSeq,
      lastHandoffSeq: built.lastHandoffSeq,
      summary: built.summary,
      updatedAt: new Date().toISOString(),
    };
    await writeSummaryCache(cachePath, cache);
  }

  const seed = summarySeedMessages(cache.summary);
  return {
    messages: buildMessagesFromReplayEvents(tailEvents, seed),
    mode: 'summary_tail',
    eventBytes: stat.size,
    summaryThroughSeq: cache.throughSeq ?? undefined,
    summaryBytes: cache.summary.length,
    tailEvents: tailEvents.length,
  };
}
