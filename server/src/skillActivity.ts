import path from 'node:path';
import { extractReadPath } from './skillUsage.js';

export type ActivitySkill = { name: string; scope: 'project' | 'global' | 'builtin' };
export type KnownSkill = ActivitySkill & { path: string };

// A use event is only an attempted Read. Native tool activity reports a
// completed result separately, including the effective input after any gate.
export function confirmedSkillRead(tool: string, input: string | undefined, status: string | undefined, cwd: string, known: KnownSkill[]): ActivitySkill | undefined {
  if (tool !== 'Read' || status !== 'completed') return undefined;
  const target = extractReadPath(input);
  if (!target) return undefined;
  const match = known.find(skill => path.resolve(cwd, skill.path) === path.resolve(cwd, target));
  return match && { name: match.name, scope: match.scope };
}

export function newSkillActivityEmitter(emit: (kind: 'applied' | 'loaded', skill: ActivitySkill) => void) {
  const seen = new Set<string>();
  return (kind: 'applied' | 'loaded', skill: ActivitySkill) => {
    const key = JSON.stringify([skill.scope, skill.name]);
    if (seen.has(key)) return;
    seen.add(key);
    emit(kind, skill);
  };
}

// Call only at the delivery boundary, never while resolving a queued pick.
export function emitDeliveredSkills(skills: readonly ActivitySkill[], emit: (kind: 'applied' | 'loaded', skill: ActivitySkill) => void): void {
  for (const skill of skills) emit('applied', skill);
}

// Antigravity receives the raw operator prompt, without Arco's skill bodies.
export function skillsDeliveredInPrompt(provider: string, skills: ActivitySkill[]): ActivitySkill[] {
  return provider === 'antigravity-cli' ? [] : skills;
}
