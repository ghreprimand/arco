// Deterministic plan outline for the string-form cluster fold.
//
// When the full shared plan doesn't fit the fold budget (see
// clusterStringFold.ts and the 2026-07-09 §10 incident in
// docs/CODEX_GPT56_CLUSTER_INCOMPAT.md), members get this outline instead of
// a head-slice: every heading and checkbox line survives, along with complete
// sections whose labels mark standing rules, gates, contracts, authority, or
// cadence. A head-slice loses the tail checkboxes — which is where the
// unticked work lives — while the outline preserves the actionable skeleton
// and standing operating instructions. Other prose is one cluster_plan_read
// call away. No model judgment: pure line filtering.

const OUTLINE_LINE_RE = /^\s*(?:#{1,6}\s|[-*]\s+\[[ xX]\])/;
const ANY_SECTION_RE = /^\s*(?:#{1,6}\s|\*\*[^*]+\*\*\s*$)/;
const DIRECTIVE_SECTION_RE = /^\s*(?:#{1,6}\s+|\*\*)(?=[^\n]*(?:standing|rules?|gates?|contract|authority|cadence))[^\n]*$/i;

export function planOutline(body: string): string {
  const kept: string[] = [];
  let keepDirectiveSection = false;
  for (const line of body.split('\n')) {
    if (DIRECTIVE_SECTION_RE.test(line)) keepDirectiveSection = true;
    else if (ANY_SECTION_RE.test(line)) keepDirectiveSection = false;
    if (OUTLINE_LINE_RE.test(line) || keepDirectiveSection) kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
