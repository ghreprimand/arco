import { CLAUDE_MODEL_LABELS, CLAUDE_MODELS as CLAUDE_MODEL_VALUES, CODEX_MODEL_INFO, CODEX_PICKER_MODELS, presetForText } from '@arco/shared';
import type { ModelName, EffortLevel } from '@arco/shared';
import type { MemberDraft } from './types';

// Compute the effective display name for each cluster member at submit time.
// Priority: operator-typed displayName → role-preset label (suffixed " #N" if
// multiple members share the preset) → custom-role text (truncated) → "Member
// #i". Keeps the member-row UX from forcing operators to retype their role
// in two places (DISPLAY NAME and ROLE), since for preset-driven workflows
// the role IS the natural identity.
export function deriveDisplayNames(members: MemberDraft[]): string[] {
  const presetCounts: Record<string, number> = {};
  const presetSeen: Record<string, number> = {};
  for (const m of members) {
    if (m.displayName.trim().length > 0) continue;
    const preset = presetForText(m.role);
    if (preset) presetCounts[preset.key] = (presetCounts[preset.key] ?? 0) + 1;
  }
  return members.map((m, i) => {
    const typed = m.displayName.trim();
    if (typed.length > 0) return typed;
    const preset = presetForText(m.role);
    if (preset) {
      const idx = (presetSeen[preset.key] ?? 0) + 1;
      presetSeen[preset.key] = idx;
      const label = preset.label.charAt(0) + preset.label.slice(1).toLowerCase();
      return presetCounts[preset.key]! > 1 ? `${label} #${idx}` : label;
    }
    const role = m.role.trim();
    if (role.length > 0) return role.length > 24 ? `${role.slice(0, 24)}…` : role;
    return `Member #${i + 1}`;
  });
}

export const CLAUDE_MODELS: { value: ModelName; label: string }[] = [
  ...CLAUDE_MODEL_VALUES.map((value) => ({ value, label: CLAUDE_MODEL_LABELS[value] ?? value.toUpperCase() })),
];
// Static fallback for cold-start (codexCatalog null). Live picker is
// constructed inside the component from `codexCatalog`.
export const CODEX_MODELS_UI_FALLBACK: { value: ModelName; label: string }[] = [
  ...CODEX_PICKER_MODELS.map((value) => ({ value, label: CODEX_MODEL_INFO[value]?.label ?? value.toUpperCase() })),
];
// Kept for the ADVANCED OPTIONS fallback selector, which is Claude-only.
export const MODELS = CLAUDE_MODELS;

export const EFFORT_LABELS: Record<string, string> = {
  low: 'LOW',
  medium: 'MED',
  high: 'HIGH',
  xhigh: 'XHIGH',
  max: 'MAX',
};
export const FALLBACK_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
