// Codex context-window policy resolver.
//
// Codex's remote models cache carries two distinct values: context_window is
// the conservative default, while max_context_window is the largest override
// this account/model combination currently accepts. Archon defaults Codex
// workflows to MAX, but reads the live catalog instead of pinning today's
// 872K value. Missing/malformed metadata fails safe by omitting the override
// and letting Codex choose its own default.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkerConfig } from '@archon/shared';

export interface CodexContextMetadata {
  contextWindow?: number;
  maxContextWindow?: number;
  effectiveContextWindowPercent?: number;
}

interface RawModel {
  slug?: unknown;
  id?: unknown;
  context_window?: unknown;
  max_context_window?: unknown;
  effective_context_window_percent?: unknown;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function readCodexContextMetadata(
  model: string,
  codexHome?: string,
): CodexContextMetadata | null {
  const cachePath = path.join(codexHome ?? path.join(os.homedir(), '.codex'), 'models_cache.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { models?: RawModel[] };
    const entry = parsed.models?.find((candidate) => candidate.slug === model || candidate.id === model);
    if (!entry) return null;
    return {
      contextWindow: positiveNumber(entry.context_window),
      maxContextWindow: positiveNumber(entry.max_context_window),
      effectiveContextWindowPercent: positiveNumber(entry.effective_context_window_percent),
    };
  } catch {
    return null;
  }
}

export function codexContextWindowOverride(config: WorkerConfig): number | undefined {
  if (config.provider !== 'codex' || config.codexContextPolicy === 'standard') return undefined;
  return readCodexContextMetadata(config.model, config.codexHome)?.maxContextWindow;
}

