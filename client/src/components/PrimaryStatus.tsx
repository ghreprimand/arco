import { useEffect, useRef, useState } from 'react';
import type { JobState } from '../stores/appStore';
import { contextTokens } from '../utils/format';
import { parseCursorModelId, cursorEffortKey, CURSOR_EFFORT_LABELS } from '@arco/shared';

// The honest effort label for a Cursor model id: the effort parsed OUT of the
// id (never `config.primaryEffort`, which the Cursor worker ignores). `auto`
// and bare-default ids carry no effort → null (chip hidden).
function cursorEffortDisplay(modelId: string): string | null {
  const parsed = parseCursorModelId(modelId);
  if (parsed.family === 'auto' || parsed.effort === null) return null;
  return CURSOR_EFFORT_LABELS[cursorEffortKey(parsed.effort)] ?? parsed.effort;
}

// Braille spinner frames — standard 10-frame set. Renders as a single
// monospace glyph so line height doesn't shift between frames.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 90;

// Generic verb cycle for when the primary hasn't emitted a recent tool_use
// or thinking delta. Rotated on a slow tick so the operator sees that the
// agent is still alive even when the CLI has been silent for a few seconds.
const IDLE_VERBS = ['Cogitating', 'Weaving', 'Threading', 'Tracing', 'Churning', 'Iterating', 'Computing', 'Synthesizing', 'Reasoning', 'Plotting'];
const VERB_CYCLE_MS = 3200;

// How long a tool_use / thinking activity can dominate the verb before we
// fall back to the idle cycle. Keeps the indicator honest if the CLI goes
// silent after a flurry of tool calls.
const ACTIVITY_STICK_MS = 6000;

// Tool name → short present participle. Falls through to a generic "Using"
// label for anything not in the table — hitting this path is fine, it just
// means we don't have a fun verb for that tool yet.
//
// Two naming conventions are mixed in: Claude's PascalCase tool names
// (Bash, Read, Edit, …) and Codex's snake_case item names (apply_patch,
// shell_call, …). Codex's `command_execution` is normalized to "Bash" by
// codex-stream.ts before it reaches the client, so it matches Claude's
// verb. Everything else lands here as-is.
const TOOL_VERBS: Record<string, string> = {
  // Claude tool names
  Read: 'Reading',
  Write: 'Writing',
  Edit: 'Editing',
  Grep: 'Grepping',
  Glob: 'Globbing',
  Bash: 'Running',
  WebFetch: 'Fetching',
  WebSearch: 'Searching',
  LSP: 'Inspecting',
  TodoWrite: 'Planning',
  NotebookEdit: 'Editing',
  // Codex item names (snake_case — these arrive from codex-stream.ts when
  // the item.type is a *_call / *_execution and item.name carries a friendly
  // label that didn't already get normalized to a Claude verb).
  apply_patch: 'Patching',
  shell_call: 'Running',
  function_call: 'Calling',
  update_plan: 'Planning',
  read_file: 'Reading',
  write_file: 'Writing',
  edit_file: 'Editing',
  search_replace: 'Editing',
  web_search: 'Searching',
  web_fetch: 'Fetching',
};

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

interface Props {
  job: JobState;
}

export function PrimaryStatus({ job }: Props) {
  const startedAt = job.turnStartedAt ?? Date.now();

  // Spinner animation — 100ms tick is fine for 10 frames; no layout thrash.
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // Elapsed counter — refresh every second so the "1m 8s" updates.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Idle verb cycle. Kept in a ref so it advances on its own schedule even
  // while activity-derived verbs are preferred; when the agent goes quiet
  // again, the next fallback starts at the already-advanced index.
  const idleIdxRef = useRef(0);
  const [, setIdleBump] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      idleIdxRef.current = (idleIdxRef.current + 1) % IDLE_VERBS.length;
      setIdleBump((x) => x + 1);
    }, VERB_CYCLE_MS);
    return () => clearInterval(id);
  }, []);

  const last = job.activity[job.activity.length - 1];
  const lastFresh = last && (Date.now() - last.at) < ACTIVITY_STICK_MS;
  const verb: string = (() => {
    if (lastFresh && last.kind === 'tool_use' && last.tool) {
      return TOOL_VERBS[last.tool] ?? `Using ${last.tool}`;
    }
    if (lastFresh && last.kind === 'thinking') return 'Thinking';
    return IDLE_VERBS[idleIdxRef.current];
  })();

  const elapsedMs = Date.now() - startedAt;
  // Cursor bakes effort into the model id — `config.primaryEffort` is a stored
  // default the Cursor worker ignores, so showing it here would be a lie (the
  // "am I secretly on xhigh?" ambiguity). Read the TRUE effort back out of the
  // resolved id instead; `auto` has no effort (Cursor's router picks it).
  const effort = job.config.primaryProvider === 'cursor'
    ? cursorEffortDisplay(String(job.config.primaryModel))
    : job.config.primaryEffort;
  const lastCtx = job.lastTurnTokens ? contextTokens(job.lastTurnTokens, job.config.primaryProvider) : 0;
  const lastOut = job.lastTurnTokens?.output ?? 0;

  return (
    <span
      className="display-font"
      style={{
        fontSize: '11px',
        color: 'var(--color-warning)',
        letterSpacing: '1px',
        marginTop: '3px',
        marginLeft: '8px',
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
      }}
    >
      <span style={{ fontSize: '13px', width: '10px', textAlign: 'center' }}>
        {SPINNER_FRAMES[frame]}
      </span>
      <span>{verb.toUpperCase()}…</span>
      <span style={{ opacity: 0.7 }}>· {formatElapsed(elapsedMs)}</span>
      {effort && <span style={{ opacity: 0.7 }}>· {String(effort).toUpperCase()}</span>}
      {lastCtx > 0 && (
        <span style={{ opacity: 0.55 }} title={`Last turn: ${lastCtx.toLocaleString()} ctx · ${lastOut.toLocaleString()} out`}>
          · last {formatCompact(lastCtx)} ctx
        </span>
      )}
    </span>
  );
}

function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(n / 1000) + 'k';
}
