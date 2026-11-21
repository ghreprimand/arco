import { normalizeClusterRoleText, type ArcoSkillRef, type ClusterSkillPin } from '@arco/shared';
import { ClusterValidationError, MEMBER_ROLE_MAX, getClusterIdForWorkflow, memberCwdFor, readCluster, type ClusterState } from './clusterStore.js';
import { MAX_PINNED_SKILLS, isValidSlug, resolvePinnedSkills } from './skills.js';
import { workflows } from './server/state.js';
import { readMeta } from './workflowMeta.js';

const key = (ref: ArcoSkillRef) => `${ref.scope}:${ref.slug}`;
const pinKey = (pin: ClusterSkillPin) => JSON.stringify([pin.scope, pin.slug, pin.role ?? null]);
export function uniqueSkillRefs(refs: ArcoSkillRef[]): ArcoSkillRef[] {
  return [...new Map(refs.map(ref => [key(ref), { scope: ref.scope, slug: ref.slug }])).values()];
}

export function parseClusterSkillPins(value: unknown): ClusterSkillPin[] {
  if (!Array.isArray(value)) throw new ClusterValidationError('skill_pins', 'Skills must be a list.');
  const pins: ClusterSkillPin[] = value.map(pin => {
    if (!pin || (pin.scope !== 'project' && pin.scope !== 'global') || !isValidSlug(pin.slug)
      || (pin.role !== undefined && (typeof pin.role !== 'string' || !pin.role.trim() || pin.role.trim().length > MEMBER_ROLE_MAX))) {
      throw new ClusterValidationError('skill_pins', 'Choose an installed project/global skill and a saved role of at most 120 characters.');
    }
    return { scope: pin.scope, slug: pin.slug, ...(pin.role !== undefined ? { role: pin.role.trim() } : {}) };
  });
  return [...new Map(pins.map(pin => [pinKey(pin), pin])).values()];
}

export function skillRefsForRole(state: Pick<ClusterState, 'skillPins'>, role: string | undefined, own: ArcoSkillRef[] = []): ArcoSkillRef[] {
  const savedRole = role ? normalizeClusterRoleText(role) : undefined;
  return uniqueSkillRefs([
    ...(state.skillPins ?? []).filter(pin => pin.role === undefined),
    ...(state.skillPins ?? []).filter(pin => pin.role !== undefined && pin.role === savedRole),
    ...own,
  ]);
}

export async function assertSkillUnion(state: Pick<ClusterState, 'skillPins' | 'cwd'>, role: string | undefined, own: ArcoSkillRef[], label: string): Promise<void> {
  const refs = skillRefsForRole(state, role, own);
  if (refs.length > MAX_PINNED_SKILLS) throw new ClusterValidationError('skill_limit', `${label}: tab, cluster and role pins together exceed 12 unique skills.`);
  const resolved = await resolvePinnedSkills(refs, state.cwd);
  if (resolved.truncated.length) throw new ClusterValidationError('skill_limit', `${label}: tab, cluster and role pins together exceed 64 KiB of skill text.`);
}

export async function assertClusterSkillLimits(state: ClusterState): Promise<void> {
  // Check role targets even when no current member has that role. New workers
  // must inherit a usable set rather than discovering an over-limit role later.
  const roles = new Set([undefined, ...(state.skillPins ?? []).map(pin => pin.role)]);
  for (const role of roles) await assertSkillUnion(state, role, [], role ? `Role ${role}` : 'All members');
  for (const id of state.members) {
    const wf = workflows.get(id);
    const own = wf?.config.pinnedSkills ?? (await readMeta(memberCwdFor(state, id), id).catch(() => null))?.pinnedSkills ?? [];
    await assertSkillUnion(state, state.memberRoles?.[id], own, wf?.config.name ?? `Member ${id.slice(0, 8)}`);
  }
}

export async function validateNewClusterPins(state: ClusterState, pins: ClusterSkillPin[]): Promise<void> {
  const previous = new Set((state.skillPins ?? []).map(pinKey));
  // Removing a pin must stay possible after an edited skill grows over budget.
  if (pins.every(pin => previous.has(pinKey(pin)))) return;
  for (const pin of pins) {
    if (previous.has(pinKey(pin))) continue;
    const resolved = await resolvePinnedSkills([pin], state.cwd);
    if (resolved.missing.length) throw new ClusterValidationError('skill_pins', `Skill ${pin.slug} is missing, off or unreadable. Choose an available skill.`);
    if (resolved.truncated.length) throw new ClusterValidationError('skill_limit', `Skill ${pin.slug} exceeds 64 KiB of text.`);
  }
  await assertClusterSkillLimits({ ...state, skillPins: pins });
}

export async function resolveWorkflowSkillPins(workflowId: string, cwd: string, own: ArcoSkillRef[]) {
  const clusterId = getClusterIdForWorkflow(workflowId);
  const cluster = clusterId ? await readCluster(clusterId) : null;
  const refs = cluster ? skillRefsForRole(cluster, cluster.memberRoles?.[workflowId], own) : uniqueSkillRefs(own);
  return { refs, resolved: await resolvePinnedSkills(refs, cluster?.cwd ?? cwd) };
}

export async function assertWorkflowSkillPins(workflowId: string, cwd: string, refs: ArcoSkillRef[]): Promise<void> {
  const previous = new Set((workflows.get(workflowId)?.config.pinnedSkills ?? []).map(key));
  if (refs.every(ref => previous.has(key(ref)))) return;
  const clusterId = getClusterIdForWorkflow(workflowId);
  const cluster = clusterId ? await readCluster(clusterId) : null;
  await assertSkillUnion(cluster ?? { cwd }, cluster?.memberRoles?.[workflowId], refs, 'This tab');
}
