// The OUTPUT STYLE levels and the one default. The model-facing text lives in
// server/src/providers/outputStyle.ts; this file only decides which level a
// saved or received value means, so every read path agrees.

export type OutputStyle = 'normal' | 'plain' | 'terse';

// Values older releases saved: 'lite' became 'plain' in 0.1.5, and 'caveman'
// was renamed 'terse' before that.
export type StoredOutputStyle = OutputStyle | 'lite' | 'caveman';

export const OUTPUT_STYLES: readonly OutputStyle[] = ['normal', 'plain', 'terse'];

// Used wherever no style is saved: new tabs, cluster members, presets and
// tabs from older releases that never chose one. An explicit 'normal' stays
// 'normal'. Change the default here only.
export const DEFAULT_OUTPUT_STYLE: OutputStyle = 'plain';

/** A saved or received value as a current level; undefined when it is unset or unknown. */
export function normalizeOutputStyle(value: unknown): OutputStyle | undefined {
  if (value === 'normal' || value === 'plain' || value === 'terse') return value;
  if (value === 'lite') return 'plain';
  if (value === 'caveman') return 'terse';
  return undefined;
}

/** The level a tab runs with: the saved value, or the default when none is saved. */
export function resolveOutputStyle(value: unknown): OutputStyle {
  return normalizeOutputStyle(value) ?? DEFAULT_OUTPUT_STYLE;
}

/** The value to store for a choice: unset when it equals the default, so the default can change later. */
export function storedOutputStyle(value: unknown): OutputStyle | undefined {
  const level = normalizeOutputStyle(value);
  return level === undefined || level === DEFAULT_OUTPUT_STYLE ? undefined : level;
}
