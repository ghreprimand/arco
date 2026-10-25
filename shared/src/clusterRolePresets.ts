// Cluster role preset bodies. The wire shape (`cluster_member_role_set`)
// stays free-form text capped at MEMBER_ROLE_MAX (120 chars) — a preset is
// just a known string the UI can drop into the editor. Each `.text` is
// ≤120 chars so it round-trips through the server clamp unchanged.

export interface RolePreset {
  key: 'director' | 'builder' | 'reviewer' | 'researcher' | 'tester' | 'documenter';
  label: string;
  text: string;
}

const LEGACY_DIRECTOR_TEXT = "Coordinator role. Add to plan via cluster_plan_write. Delegate via peer_send. Don't remove items or write code.";
const OUTCOME_DIRECTOR_TEXT = "Director role. Own outcome; plan/delegate via peer_send; verify claims; fold feedback into plan; don't code.";
// 2026-09-26 — "Own outcome; … keep plan current" dropped the don't-code
// guard and read as "own everything", so directors implemented and turned the
// plan into a status ledger. Still normalized forward so stored roles upgrade.
const OWN_OUTCOME_DIRECTOR_TEXT = 'Director role. Own outcome; delegate only via peer_send, never Task; keep plan current; verify claims; fold feedback.';

export const ROLE_PRESETS: RolePreset[] = [
  {
    key: 'director',
    label: 'DIRECTOR',
    text: "Director role. Delegate via peer_send, never Task; don't write code; verify claims; plan = rules + tasks; you land.",
  },
  {
    key: 'builder',
    label: 'BUILDER',
    text: 'Implementer role. Focus on your assigned scope. Use peer_send to report progress + blockers, not to direct peers.',
  },
  {
    key: 'reviewer',
    label: 'REVIEWER',
    text: "Reviewer role. Read peer output via peer_read and the cluster plan. Critique. Don't write code; write critiques.",
  },
  {
    key: 'researcher',
    label: 'RESEARCHER',
    text: "Researcher role. Investigate the codebase, produce findings as text. Don't modify files. Surface findings via peer_send.",
  },
  {
    key: 'tester',
    label: 'TESTER',
    text: 'Tester role. Write + run tests against peer work. Report failures via peer_send. Modify test files only.',
  },
  {
    key: 'documenter',
    label: 'DOCUMENTER',
    text: 'Documenter role. Read peer work via peer_read; write + update docs (README, guides, comments). Modify docs only.',
  },
];

export function normalizeClusterRoleText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === LEGACY_DIRECTOR_TEXT || trimmed === OUTCOME_DIRECTOR_TEXT || trimmed === OWN_OUTCOME_DIRECTOR_TEXT) {
    return ROLE_PRESETS.find((p) => p.key === 'director')?.text ?? trimmed;
  }
  return trimmed;
}

// Match a stored role string back to its preset. Trim + case-sensitive
// equality (presets are canonical strings; any operator edit drops back to
// 'Custom'). Returns undefined when the text doesn't match any preset.
export function presetForText(text: string): RolePreset | undefined {
  const trimmed = normalizeClusterRoleText(text);
  if (trimmed.length === 0) return undefined;
  return ROLE_PRESETS.find((p) => p.text === trimmed);
}
