// ULTRACODE_PLAN.md — live visibility into an ultracode background fleet.
//
// The CLI's WorkflowTool fans out subagents in the BACKGROUND: their work is
// written to `<sessionId>/subagents/workflows/wf_*/{journal,agent-*}.jsonl`,
// never to the parent `claude -p` stream that feeds the Activity tab. So while
// 24 agents churn, the tab looks dead. This turn-scoped watcher polls those
// files and emits an `ultracode_fleet_progress` snapshot (transient, like
// context_usage) so the operator sees counts + per-agent activity live.
//
// Scoping: the session dir persists across resumed turns, so we baseline the
// `wf_*` dirs that already exist when the watcher starts and only count runs
// that appear AFTER — i.e. this turn's fleet. The watcher starts at turn start
// (before the fleet launches, several seconds into scouting), so the baseline
// is clean.
//
// Read-only / deterministic / reversible — passes the four-question fence: it
// only tails files the CLI already writes and emits live telemetry the operator
// can ignore. It NEVER writes to the run dirs or steers the fleet.

import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import type { UltracodeFleetProgressMessage, UltracodeFleetAgent } from '@arco/shared';
import { resolveSubagentsWorkflowsDir } from './sessionJsonl.js';

const POLL_MS = 1500;
const LABEL_MAX = 80;
const MAX_AGENTS = 64; // defensive cap on the emitted list

interface AgentFileCache {
  mtimeMs: number;
  label: string;
  lastTool?: string;
}

// Pull the first user-turn prompt (the subagent's task) and the most recent
// tool the subagent invoked out of one `agent-*.jsonl` transcript. Content
// blocks may be a bare string or an array of typed blocks — handle both.
function parseAgentTranscript(text: string): { label: string; lastTool?: string } {
  let label = '';
  let lastTool: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type === 'user' && !label) {
      const c = e.message?.content;
      if (typeof c === 'string') label = c;
      else if (Array.isArray(c)) {
        const t = c.find((b: any) => b?.type === 'text' || typeof b?.text === 'string');
        if (t) label = t.text ?? '';
      }
    } else if (e?.type === 'assistant') {
      const c = e.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === 'tool_use' && typeof b?.name === 'string') lastTool = b.name;
        }
      }
    }
  }
  return { label: label.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX), lastTool };
}

// Build a fresh fleet snapshot from the subagents workflows dir. Pure w.r.t. the
// caller's `cache` map (mutated in place to skip re-reading unchanged agent
// files). `baseline` is the set of wf_* dir names to ignore (pre-existing runs
// from earlier turns on the same resumed session).
export async function buildFleetSnapshot(
  workflowsDir: string,
  baseline: Set<string>,
  cache: Map<string, AgentFileCache>,
): Promise<{ total: number; running: number; done: number; agents: UltracodeFleetAgent[] }> {
  let runDirs: string[];
  try {
    runDirs = (await readdir(workflowsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name.startsWith('wf_') && !baseline.has(d.name))
      .map((d) => d.name);
  } catch {
    return { total: 0, running: 0, done: 0, agents: [] }; // dir not created yet
  }

  // agentId -> { done, label, lastTool }. Journal is authoritative for spawn +
  // completion; agent transcript supplies the human-readable label + last tool.
  const agents = new Map<string, { done: boolean; label: string; lastTool?: string }>();

  for (const runDir of runDirs) {
    const dir = join(workflowsDir, runDir);
    // journal.jsonl — started/result per agentId.
    try {
      const journal = await readFile(join(dir, 'journal.jsonl'), 'utf8');
      for (const line of journal.split('\n')) {
        if (!line.trim()) continue;
        let e: any;
        try { e = JSON.parse(line); } catch { continue; }
        const id = e?.agentId;
        if (!id) continue;
        const cur = agents.get(id) ?? { done: false, label: '' };
        if (e.type === 'result') cur.done = true;
        agents.set(id, cur);
      }
    } catch { /* journal not written yet */ }

    // agent-<id>.jsonl — label + last tool. Re-read only on mtime change.
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'));
    } catch { /* ignore */ }
    for (const file of files) {
      const id = file.slice('agent-'.length, -'.jsonl'.length);
      const path = join(dir, file);
      let parsed: { label: string; lastTool?: string };
      try {
        const st = await stat(path);
        const hit = cache.get(path);
        if (hit && hit.mtimeMs === st.mtimeMs) {
          parsed = { label: hit.label, lastTool: hit.lastTool };
        } else {
          parsed = parseAgentTranscript(await readFile(path, 'utf8'));
          cache.set(path, { mtimeMs: st.mtimeMs, label: parsed.label, lastTool: parsed.lastTool });
        }
      } catch { continue; }
      const cur = agents.get(id) ?? { done: false, label: '' };
      cur.label = parsed.label || cur.label;
      cur.lastTool = parsed.lastTool ?? cur.lastTool;
      agents.set(id, cur);
    }
  }

  const list: UltracodeFleetAgent[] = [...agents.entries()]
    .slice(0, MAX_AGENTS)
    .map(([agentId, a]) => ({
      agentId,
      label: a.label || '(starting…)',
      status: a.done ? ('done' as const) : ('running' as const),
      ...(a.lastTool ? { lastTool: a.lastTool } : {}),
    }));
  const done = list.filter((a) => a.status === 'done').length;
  return { total: list.length, running: list.length - done, done, agents: list };
}

export interface FleetWatcher {
  stop(): void;
}

// Start a turn-scoped fleet watcher. Emits a snapshot via `emit` whenever the
// fleet state changes; a no-op when the subagents dir never appears (the model
// chose not to fan out). Idempotent stop().
export function startUltracodeFleetWatcher(opts: {
  workflowId: string;
  cwd: string;
  sessionId: string;
  emit: (msg: UltracodeFleetProgressMessage) => void;
}): FleetWatcher {
  const { workflowId, cwd, sessionId, emit } = opts;
  const workflowsDir = resolveSubagentsWorkflowsDir(cwd, sessionId);
  const cache = new Map<string, AgentFileCache>();
  const baseline = new Set<string>();
  let lastJson = '';
  let timer: NodeJS.Timeout | null = null;
  let polling = false;
  let stopped = false;

  // Snapshot the pre-existing wf_* dirs so we only attribute NEW runs to this
  // turn. Fire-and-forget — the first poll waits behind it via `baselineReady`.
  let baselineReady = false;
  readdir(workflowsDir, { withFileTypes: true })
    .then((ents) => { for (const d of ents) if (d.isDirectory() && d.name.startsWith('wf_')) baseline.add(d.name); })
    .catch(() => { /* dir absent — empty baseline is correct */ })
    .finally(() => { baselineReady = true; });

  const tick = async () => {
    if (polling || stopped || !baselineReady) return;
    polling = true;
    try {
      const snap = await buildFleetSnapshot(workflowsDir, baseline, cache);
      if (snap.total === 0) return; // nothing fanned out yet
      const msg: UltracodeFleetProgressMessage = { type: 'ultracode_fleet_progress', workflowId, ...snap };
      const json = JSON.stringify(snap);
      if (json !== lastJson) {
        lastJson = json;
        emit(msg);
      }
    } catch { /* best-effort telemetry */ } finally {
      polling = false;
    }
  };

  timer = setInterval(tick, POLL_MS);
  void tick();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
      // One final read so the panel lands on the fleet's terminal state (all
      // agents `done`) rather than the last mid-run snapshot.
      void buildFleetSnapshot(workflowsDir, baseline, cache).then((snap) => {
        if (snap.total === 0) return;
        const json = JSON.stringify(snap);
        if (json !== lastJson) emit({ type: 'ultracode_fleet_progress', workflowId, ...snap });
      }).catch(() => { /* ignore */ });
    },
  };
}
