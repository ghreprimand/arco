// 100 preserves the inspected reference stack. Lower settings tighten the core
// and reduce halo/chromatic spread, never blur the DOM or dim foreground ink.
export function phosphorEmission(softness: number): string {
  const t = Math.max(0, Math.min(100, Number.isFinite(softness) ? softness : 50)) / 100;
  if (!t) return 'none';
  const n = (v: number) => Number(v.toFixed(4));
  return `0 0 ${n(2 * t)}px currentColor,0 0 ${n(7 * t)}px color-mix(in srgb,currentColor ${n(54 * t)}%,transparent),0 0 ${n(20 * t)}px color-mix(in srgb,currentColor ${n(24 * t)}%,transparent),${n(.7 * t)}px 0 ${n(t)}px rgba(255,51,68,${n(.15 * t)}),${n(-.7 * t)}px 0 ${n(t)}px rgba(0,255,255,${n(.15 * t)})`;
}
