import { CLAUDE_MODELS as CLAUDE_MODEL_VALUES, CODEX_PICKER_MODELS} from '@arco/shared';
import type { ProviderName, ModelName, PlanSummary, PlanAttachmentSpan } from '@arco/shared';
import type { ActivityEntry } from '../../stores/appStore';

const CLAUDE_MODELS: ModelName[] = [...CLAUDE_MODEL_VALUES] as ModelName[];
const CODEX_MODELS: ModelName[] = [...CODEX_PICKER_MODELS];

export function modelsFor(provider: ProviderName): ModelName[] {
  if (provider === 'claude') return CLAUDE_MODELS;
  if (provider === 'codex') return CODEX_MODELS;


  return [];
}

// Ollama's done envelope has no cached-token field — prompt_eval_count counts
// the reused prefix too (timings prove the prefix cache hits), so its turns
// arrive with cacheRead/cacheCreate = 0. Render "not reported" rather than a
// misleading 0 cache-read / 0% cache-hit.
export function cacheUnreported(provider: ProviderName | undefined): boolean {
  return provider === 'ollama';
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

export function formatAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Turn a JSON-stringified tool input into a one-line summary. Best-effort —
// if parsing fails or the schema is unfamiliar, fall back to a truncated
// raw string so nothing is lost.
export function abbreviateToolInput(tool: string | undefined, input: string | undefined): string {
  if (!input) return '';
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { return truncate(input, 200); }
  if (parsed === null || typeof parsed !== 'object') return truncate(String(parsed), 200);
  const obj = parsed as Record<string, unknown>;

  // Known shapes. These cover the common Claude/Codex tool schemas; anything
  // else falls through to the JSON preview below.
  switch (tool) {
    case 'ReadFile':
    case 'Read': return String(obj.file_path ?? obj.path ?? '');
    case 'WriteFile':
    case 'Write': return String(obj.file_path ?? obj.path ?? '');
    case 'Edit':
    case 'edit_file':
    case 'search_replace': {
      const path = String(obj.file_path ?? obj.path ?? '');
      const oldText = typeof obj.old_string === 'string' ? truncate(obj.old_string.replace(/\s+/g, ' '), 48) : '';
      const newText = typeof obj.new_string === 'string' ? truncate(obj.new_string.replace(/\s+/g, ' '), 48) : '';
      const line = obj.line_number ?? obj.line ?? obj.start_line;
      const linePart = line ? `:${String(line)}` : '';
      const change = oldText || newText ? ` · ${oldText || '?'} → ${newText || '?'}` : '';
      return `${path}${linePart}${change}`;
    }
    case 'NotebookEdit': return String(obj.notebook_path ?? obj.file_path ?? '');
    case 'Grep': {
      const pattern = obj.pattern ?? '';
      const glob = obj.glob ? ` in ${obj.glob}` : obj.path ? ` in ${obj.path}` : '';
      return `${String(pattern)}${glob}`;
    }
    case 'Glob': return String(obj.pattern ?? '');
    case 'Bash': return truncate(String(obj.command ?? ''), 180);
    case 'WebFetch': return String(obj.url ?? '');
    case 'WebSearch': return String(obj.query ?? '');
    case 'PermissionRequest':
      return `${String(obj.tool ?? 'tool')} · ${String(obj.request ?? '')}`;
    case 'waiting_unbridged_tool':
    case 'timed_out':
    case 'waiting_permission':
      return String(obj.detail ?? '');
    case 'TodoWrite': {
      const todos = Array.isArray(obj.todos) ? obj.todos : [];
      return `${todos.length} todo${todos.length === 1 ? '' : 's'}`;
    }
    default: {
      if (typeof obj.path === 'string' || typeof obj.file_path === 'string') {
        return String(obj.file_path ?? obj.path);
      }
      const preview = Object.entries(obj)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${truncate(typeof v === 'string' ? v : JSON.stringify(v), 60)}`)
        .join(' · ');
      return preview || truncate(input, 200);
    }
  }
}

export function displayToolLabel(tool: string | undefined): string {
  switch (tool) {
    case 'WebSearch': return 'WEB SEARCH';
    case 'Bash': return 'BASH';
    case 'ReadFile': return 'READ FILE';
    case 'WriteFile': return 'WRITE FILE';
    case 'PermissionRequest': return 'PERMISSION';
    case 'waiting_unbridged_tool': return 'WAITING UNBRIDGED';
    case 'waiting_permission': return 'WAITING PERMISSION';
    case 'timed_out': return 'TIMED OUT';
    default: return (tool ?? '?').replace(/_/g, ' ').toUpperCase();
  }
}

export function sameToolSummary(a: ActivityEntry, b: ActivityEntry): boolean {
  if (a.status !== b.status || a.tool !== b.tool || a.itemId || b.itemId) return false;
  return abbreviateToolInput(a.tool, a.input) === abbreviateToolInput(b.tool, b.input);
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function splitAttachments(attachments: PlanAttachmentSpan[] | undefined): {
  active: PlanAttachmentSpan[];
  past: PlanAttachmentSpan[];
} {
  if (!attachments) return { active: [], past: [] };
  const active: PlanAttachmentSpan[] = [];
  const past: PlanAttachmentSpan[] = [];
  for (const a of attachments) {
    if (a.detachedAt === null) active.push(a);
    else past.push(a);
  }
  // Newest first within each bucket.
  active.sort((a, b) => b.attachedAt - a.attachedAt);
  past.sort((a, b) => (b.detachedAt ?? 0) - (a.detachedAt ?? 0));
  return { active, past };
}

export function planRowSubtitle(plan: PlanSummary, active: PlanAttachmentSpan[], past: PlanAttachmentSpan[]): string {
  const parts: string[] = [`edited ${formatRelativeTime(plan.updatedAt)}`];
  if (active.length > 0) {
    const names = active.map((a) => a.workflowName || a.workflowId.slice(0, 6));
    if (names.length === 1) parts.push(`active in ${names[0]}`);
    else if (names.length === 2) parts.push(`active in ${names[0]} + ${names[1]}`);
    else parts.push(`active in ${names[0]} + ${names.length - 1} others`);
  }
  if (past.length > 0) parts.push(`${past.length} past`);
  if (plan.completedAt != null) parts.push(`completed ${formatRelativeTime(plan.completedAt)}`);
  return parts.join(' · ');
}
