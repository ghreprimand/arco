import type { EffortLevel } from './providers.js';

// Ollama graded thinking. `/api/show` returns a top-level
// `thinking: { values, default }` for models whose parser accepts levels —
// e.g. qwen3.8 advertises [false, "low", "medium", "xhigh"], default "medium";
// gpt-oss advertises low/medium/high. Archon used to send only a boolean
// (`think: effort !== 'low'`), so every level beyond the model default was
// unreachable. Shared so the server request and the client picker agree.
//
// Archon's `low` keeps its long-standing meaning — thinking OFF (plus the
// `/no_think` system prepend) — when the model permits `false`; the model's
// own "low" level is then the one value the picker can't reach. On a model
// that can't disable thinking, `low` selects its lowest level instead.

export interface OllamaThinkingInfo {
  /** Level strings in ascending effort order (unknown names dropped). */
  levels: string[];
  /** `false` is among the advertised values. */
  canDisable: boolean;
  default?: string;
}

const RANK = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const rankOf = (level: string): number => (RANK as readonly string[]).indexOf(level);

export function parseOllamaThinking(raw: unknown): OllamaThinkingInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const values = (raw as { values?: unknown }).values;
  if (!Array.isArray(values)) return null;
  const levels = values
    .filter((v): v is string => typeof v === 'string' && rankOf(v) >= 0)
    .sort((a, b) => rankOf(a) - rankOf(b));
  const def = (raw as { default?: unknown }).default;
  return {
    levels: [...new Set(levels)],
    canDisable: values.includes(false),
    ...(typeof def === 'string' ? { default: def } : {}),
  };
}

// Picker efforts for a model. Null info (probe failed / old daemon / no level
// support) ⇒ the legacy LOW / HIGH pair.
export function ollamaEffortsFor(info: OllamaThinkingInfo | null | undefined): EffortLevel[] {
  if (!info || info.levels.length === 0) return ['low', 'high'];
  const out: EffortLevel[] = ['low'];
  for (const l of info.levels) {
    if (l !== 'low' && !out.includes(l as EffortLevel)) out.push(l as EffortLevel);
  }
  return out;
}

// The `think` request value for an Archon effort.
export function ollamaThinkParam(effort: string | undefined, info: OllamaThinkingInfo | null | undefined): boolean | string {
  if (!info || info.levels.length === 0) return effort !== 'low';
  if (effort === 'low') return info.canDisable ? false : info.levels[0];
  if (effort && info.levels.includes(effort)) return effort;
  // `high` is what every pre-level tab stored for "thinking on" — keep it
  // meaning the model's default rather than silently escalating.
  if (effort === 'high' || !effort) return true;
  const r = rankOf(effort);
  const lower = info.levels.filter((l) => rankOf(l) < r);
  return lower.length > 0 ? lower[lower.length - 1] : true;
}
