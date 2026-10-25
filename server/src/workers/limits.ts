import path from 'node:path';

// Hard safety caps applied to every worker, regardless of provider.
// These exist to convert "system can hard-lock from a runaway scan" into
// "worker gets terminated when it gets stupid" — see the 2026-04-16 incident
// where a Gemini worker ballooned 63GB and OOM'd the operator's box.

// Per-worker text-output cap. Anything beyond this is dropped from
// `worker.output` and the worker is force-finished with a truncation notice.
// The 2026-04-16 Gemini incident was a 63GB *RSS* runaway — a memory issue
// the RSS_KILL guard now handles directly. The text cap was doing collateral
// safety work; 50MB gives Native (1M-context) and long agentic Codex/exec
// runs comfortable headroom while still catching "model went berserk
// printing forever." Reports beyond this should write to the artifacts dir
// (the safety footer nudges this). Override via ARCO_MAX_WORKER_OUTPUT_BYTES.
function parseOutputCapEnv(): number {
  const DEFAULT_CAP = 50 * 1024 * 1024;
  const raw = process.env.ARCO_MAX_WORKER_OUTPUT_BYTES;
  if (!raw) return DEFAULT_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 * 1024 * 1024) {
    console.warn(`[arco] ignoring ARCO_MAX_WORKER_OUTPUT_BYTES=${raw} (not a finite number ≥ 1MB); using default 50MB`);
    return DEFAULT_CAP;
  }
  return n;
}
export const MAX_WORKER_OUTPUT_BYTES = parseOutputCapEnv();

function formatCapMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

export const OUTPUT_TRUNCATION_NOTICE =
  `\n\n[OUTPUT TRUNCATED — Arco enforced ${formatCapMb(MAX_WORKER_OUTPUT_BYTES)} worker-output cap. ` +
  'For reports larger than this, instruct the worker to write the full ' +
  'output to a markdown file in the workflow artifacts directory and return only a brief summary + path.]';

// Tree-RSS auto-kill threshold, polled by WorkerManager via the /proc
// activity probe. Any worker whose process tree (worker + descendants)
// exceeds this gets killed and surfaced as a worker_error.
//
// 32GB default (raised from 16GB on 2026-04-28 after the cap tripped on a
// legitimate workload with 48 subprocesses on a 96GB-RAM box). Earlier history:
// 4GB → 16GB on 2026-04-22 after the 2026-04-16 Gemini runaway (63GB scan).
// 32GB still catches that scenario well before swap-death on ≥64GB systems
// while leaving headroom for fan-out workloads (many concurrent subprocesses,
// Clang ThinLTO link phases, large `grep -r`, kernel compiles at high `-j`).
// Systems with <64GB RAM should shrink this via ARCO_RSS_KILL_BYTES.
// Workflows doing known-huge work (kernel build, LTO link) can opt out
// entirely by setting `disableRssGuard: true` in the workflow's meta.json —
// skips only the tree-RSS kill, NOT the 5MB output cap or process-tree kill
// on cancel.
function parseRssEnv(): number {
  const raw = process.env.ARCO_RSS_KILL_BYTES;
  if (!raw) return 32 * 1024 * 1024 * 1024;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 * 1024 * 1024 * 1024) {
    console.warn(`[arco] ignoring ARCO_RSS_KILL_BYTES=${raw} (not a finite number ≥ 1GB); using default 32GB`);
    return 32 * 1024 * 1024 * 1024;
  }
  return n;
}
export const RSS_KILL_BYTES = parseRssEnv();

// Canonical per-workflow artifacts directory. Duplicated from workflowMeta /
// workflowStore / buildLog on purpose — those modules each define the same
// `workflowDir` helper privately and the footer builder wants a zero-import
// path to avoid a circular dependency with the workflow-store stack.
export function artifactsDir(cwd: string, wfid: string): string {
  return path.join(cwd, '.arco', 'workflows', wfid, 'artifacts');
}

// Server-prepended footer on every worker task. Single source of truth for
// the foot-gun rules — the orchestrator no longer enumerates them in each
// task it writes. Tight intentionally; workers are smart, they don't need
// a wall of warnings, they need pointed reminders about the surfaces that
// actually cause OOMs and system locks.
//
// Lives ALONGSIDE the server-side hard caps (5MB output, 32GB RSS auto-kill,
// process-tree kill on cancel). The footer is the prompt-side "please
// don't"; the caps are the "we will."
//
// The artifacts directory line is workflow-scoped: when we know the
// workflowId + cwd, we bake the absolute path in so the worker writes
// reports to `<cwd>/.arco/workflows/<wfid>/artifacts/` instead of
// littering the project root. Falls back to generic cwd guidance when the
// workflow scope isn't available (tests, edge paths).
export function buildWorkerSafetyFooter(cwd?: string, wfid?: string): string {
  const dir = cwd && wfid ? artifactsDir(cwd, wfid) : null;
  const bigOutputLine = dir
    ? `- For report-shaped outputs (deep dives, inventories, audits, multi-section findings), write a markdown file into \`${dir}/\` (this directory already exists) and return a brief summary plus the bare filename (e.g. \`audit-spawns.md\`). Do NOT write report files at the project root — Arco tracks artifacts per-workflow and surfaces them inline in chat. For ordinary prose responses — even detailed ones — return the full text inline; the operator reads it in chat.`
    : `- For report-shaped outputs (deep dives, inventories, audits, multi-section findings), write a markdown file in the cwd and return a brief summary + absolute path. For ordinary prose responses — even detailed ones — return the full text inline; the operator reads it in chat.`;

  return `

---
[Arco safety reminders — apply if your task touches the filesystem or shell]
- Cap unknown-size shell output: pipe through \`| head -c 100K\` or \`| head -n 200\`.
- No \`find /\` / \`du -sh /\` without \`-maxdepth\` and exclusions for \`/proc /sys /dev /run\`. Skip \`~/.cache\`, \`node_modules\`, \`.git/objects\`, \`/var/cache\`, \`/snap\`.
- No reads of \`/proc/kcore\`, \`/proc/*/mem\`, \`/dev/{kmem,mem,zero,urandom}\` past first KB. No unbounded \`journalctl\` or \`while true\` loops.
- No \`cat\` of files >10MB; use \`head -c 100K\` instead. \`xargs\` always with explicit limits.
${bigOutputLine}
- Arco will hard-kill your process tree at 32GB RSS or ${formatCapMb(MAX_WORKER_OUTPUT_BYTES)} returned output. These are the floor, not the budget.
`;
}
