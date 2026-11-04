export const TIDY_INPUT_MAX = 18_000;
export const TIDY_DIRECTIVES_MAX = 16;
export interface TidyInput { original: string; proposal: string; directives: string[]; }

// Never silently cut the original or the accumulated directives: a model
// seeing a partial instruction could produce an incorrect replacement.
export function buildTidyMaterial(raw: unknown): { material: string; input: TidyInput } | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.original !== 'string' || !value.original.trim() || typeof value.proposal !== 'string' || !Array.isArray(value.directives) || value.directives.length > TIDY_DIRECTIVES_MAX || value.directives.some((item) => typeof item !== 'string' || !item.trim() || item.length > 500)) return null;
  const input = { original: value.original, proposal: value.proposal, directives: value.directives as string[] };
  const material = JSON.stringify(input);
  if (material.length > TIDY_INPUT_MAX) return null;
  return { material, input };
}
