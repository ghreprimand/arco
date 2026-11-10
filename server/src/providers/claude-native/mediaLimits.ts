// https://platform.claude.com/docs/en/build-with-claude/vision
// https://platform.claude.com/docs/en/build-with-claude/pdf-support
export interface NativeMediaLimits { images: number; pdfPages: number; encodedBytes: number }
export function nativeMediaLimits(contextWindow?: number, baseURL?: string): NativeMediaLimits {
  const window = typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 200_000;
  let firstParty = false;
  try { firstParty = new URL(baseURL ?? '').origin === 'https://api.anthropic.com'; } catch { /* Unknown endpoint: conservative cap. */ }
  return {
    images: window > 200_000 ? 600 : 100,
    pdfPages: window >= 1_000_000 ? 600 : 100,
    // Custom endpoints can proxy platforms with smaller request limits.
    encodedBytes: (firstParty ? 128 : 20) * 1024 * 1024,
  };
}
