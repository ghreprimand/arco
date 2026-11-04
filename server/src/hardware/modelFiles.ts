import path from 'node:path';
import { arcoHome } from '../arcoHome.js';

/** Folder holding local GGUF model files (read-only for diagnostics and backup). */
export function modelsDir(): string {
  return path.join(arcoHome(), 'models');
}

// Parameter count in billions from a model id/name ("32b", "7B", "1.5b"); 0 when unknown.
export function parseParams(name: string): number {
  const m = /(\d+(?:\.\d+)?)\s*[bB]\b/.exec(name);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}
