import { ROLE_PRESETS } from '@arco/shared';
import type { EffortLevel, MemberTier } from '@arco/shared';

// Built-in cluster starting shapes. A template fixes roles, a recommended
// tier and a starting effort for each member, and explains the choice in
// words. It never names or picks a model: the operator chooses provider and
// model from what is connected. Effort starts at or below HIGH.

export type TemplateRole = 'director' | 'builder' | 'reviewer' | 'tester' | 'documenter' | 'researcher';

export interface RoleGuidance {
  tier: MemberTier;
  effort: EffortLevel;
  advice: string;
  reason: string;
}

export const ROLE_GUIDANCE: Record<TemplateRole, RoleGuidance> = {
  director: { tier: 'heavy', effort: 'high', advice: 'Heavy or Standard model, MEDIUM or HIGH effort.', reason: 'Plans the work and reviews everyone else; mistakes here cost the whole team.' },
  builder: { tier: 'heavy', effort: 'high', advice: 'Heavy or Standard model, MEDIUM or HIGH effort.', reason: 'Writes and changes code; a stronger model leaves fewer mistakes to undo.' },
  reviewer: { tier: 'standard', effort: 'high', advice: 'Standard or Heavy model, MEDIUM or HIGH effort.', reason: 'Reads changes and looks for problems; careful reasoning matters more than speed.' },
  tester: { tier: 'standard', effort: 'medium', advice: 'Standard model, MEDIUM effort.', reason: 'Writes and runs tests; routine work a mid-range model handles well.' },
  documenter: { tier: 'light', effort: 'low', advice: 'Standard or Light model, LOW or MEDIUM effort.', reason: 'Writing and summarizing does not need the strongest model.' },
  researcher: { tier: 'light', effort: 'medium', advice: 'Light or Standard model, LOW or MEDIUM effort.', reason: 'Reads code and reports findings; quick answers matter more than depth.' },
};

export interface ClusterTemplate {
  id: string;
  name: string;
  summary: string;
  roles: TemplateRole[];
}

export const CLUSTER_TEMPLATES: ClusterTemplate[] = [
  { id: 'pair', name: 'Pair', summary: 'A builder and a reviewer who checks the work.', roles: ['builder', 'reviewer'] },
  { id: 'small-team', name: 'Small team', summary: 'A director who plans and lands, a builder and a tester.', roles: ['director', 'builder', 'tester'] },
  { id: 'full-team', name: 'Full team', summary: 'Director, builder, tester and a documenter.', roles: ['director', 'builder', 'tester', 'documenter'] },
  { id: 'parallel-build', name: 'Parallel build', summary: 'Two builders working in parallel, with a director, tester and documenter.', roles: ['director', 'builder', 'builder', 'tester', 'documenter'] },
  { id: 'research', name: 'Research', summary: 'A director and two researchers who investigate and report.', roles: ['director', 'researcher', 'researcher'] },
];

export function roleText(role: TemplateRole): string {
  return ROLE_PRESETS.find((p) => p.key === role)?.text ?? role;
}

export function roleLabel(role: TemplateRole): string {
  const label = ROLE_PRESETS.find((p) => p.key === role)?.label ?? role;
  return label.charAt(0) + label.slice(1).toLowerCase();
}
