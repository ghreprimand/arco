import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildPinnedSkillsBlock,
  resolvePinnedSkills,
  writeSkill,
} from './skills.js';

test('pinned skill block is standing, framed, and byte-counted', () => {
  const block = buildPinnedSkillsBlock([
    { name: 'Review Code', scope: 'global', body: 'Inspect the diff before reporting.' },
  ]);
  assert.match(block.text, /every turn until the operator removes the pin/i);
  assert.match(block.text, /<arco-pinned-skill name="Review Code" scope="global">/);
  assert.match(block.text, /Inspect the diff before reporting\./);
  assert.equal(block.bytes, Buffer.byteLength(block.text, 'utf8'));
});

test('resolvePinnedSkills de-dupes references and reports missing skills', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-pinned-skills-'));
  try {
    const skill = await writeSkill({
      scope: 'project',
      name: 'Project Check',
      description: 'Check the project.',
      body: 'Run the project checks.',
      operatorOnly: true,
    }, cwd);
    const resolved = await resolvePinnedSkills([
      { scope: 'project', slug: skill.slug },
      { scope: 'project', slug: skill.slug },
      { scope: 'project', slug: 'does-not-exist' },
    ], cwd);
    assert.equal(resolved.skills.length, 1);
    assert.equal(resolved.skills[0]?.name, 'Project Check');
    assert.deepEqual(resolved.missing, ['project:does-not-exist']);
    assert.deepEqual(resolved.truncated, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('cluster and exact-role pins persist and follow new and replaced members without copying tab pins', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-cluster-skills-'));
  const store = await import('./clusterStore.js');
  const { workflows } = await import('./server/state.js');
  const { resolveWorkflowSkillPins } = await import('./clusterSkills.js');
  const ids = Array.from({ length: 4 }, () => randomUUID());
  let clusterId: string | undefined;
  try {
    const common = await writeSkill({ scope: 'project', name: 'Common fixture', description: '', body: 'COMMON_PIN_TEXT', operatorOnly: true }, cwd);
    const specialist = await writeSkill({ scope: 'project', name: 'Role fixture', description: '', body: 'ROLE_PIN_TEXT', operatorOnly: true }, cwd);
    for (const id of ids) workflows.set(id, { config: { name: 'Fixture member', workingDirectory: cwd } } as never);
    const cluster = await store.createCluster({ cwd, memberWorkflowIds: ids.slice(0, 2) }); clusterId = cluster.clusterId;
    await store.setMemberRole(clusterId, ids[0], 'Reader');
    await store.setMemberRole(clusterId, ids[1], 'reader');
    const pins = [{ scope: 'project' as const, slug: common.slug }, { scope: 'project' as const, slug: specialist.slug, role: 'Reader' }];
    await store.setSkillPins(clusterId, pins);
    assert.deepEqual(JSON.parse(await readFile(store.clusterMetaPath(clusterId), 'utf8')).skillPins, pins);
    const first = await resolveWorkflowSkillPins(ids[0], path.join(cwd, 'isolated-workspace'), [pins[0]]);
    assert.deepEqual(first.resolved.skills.map(skill => skill.body), ['COMMON_PIN_TEXT', 'ROLE_PIN_TEXT']);
    assert.deepEqual((await resolveWorkflowSkillPins(ids[1], cwd, [])).refs, [pins[0]], 'custom role matching is exact');
    await store.addMember(clusterId, ids[2]);
    assert.equal((await resolveWorkflowSkillPins(ids[2], cwd, [])).resolved.skills[0].body, 'COMMON_PIN_TEXT');
    await store.replaceMember(clusterId, ids[0], ids[3]);
    assert.equal((await resolveWorkflowSkillPins(ids[3], cwd, [])).resolved.skills.length, 2);
    for (const id of ids) assert.equal(workflows.get(id)!.config.pinnedSkills, undefined, 'inherited pins never become direct tab pins');
    await store.setSkillPins(clusterId, []);
    assert.equal((await resolveWorkflowSkillPins(ids[3], cwd, [])).refs.length, 0);
  } finally {
    for (const id of ids) workflows.delete(id);
    if (clusterId) await store.deleteCluster(clusterId);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('effective pin limits reject additions and role changes atomically across tab and cluster scopes', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-cluster-skill-limits-'));
  const store = await import('./clusterStore.js');
  const { workflows } = await import('./server/state.js');
  const { assertWorkflowSkillPins } = await import('./clusterSkills.js');
  const ids = Array.from({ length: 3 }, () => randomUUID());
  let clusterId: string | undefined;
  try {
    const refs = [];
    for (let i = 0; i < 13; i++) {
      const skill = await writeSkill({ scope: 'project', name: `Small fixture ${i}`, description: '', body: 'Short standing text.' }, cwd);
      refs.push({ scope: 'project' as const, slug: skill.slug });
    }
    for (const id of ids) workflows.set(id, { config: { name: 'Limit fixture', workingDirectory: cwd } } as never);
    clusterId = (await store.createCluster({ cwd, memberWorkflowIds: ids.slice(0, 2) })).clusterId;
    await store.setSkillPins(clusterId, refs.slice(0, 12));
    await assert.rejects(store.setSkillPins(clusterId, refs), /12 unique skills/);
    assert.equal((await store.readCluster(clusterId))!.skillPins!.length, 12);
    await assertWorkflowSkillPins(ids[0], cwd, [refs[0]]);
    await assert.rejects(assertWorkflowSkillPins(ids[0], cwd, [refs[12]]), /12 unique skills/);
    const scoped = [...refs.slice(0, 11), { ...refs[11], role: 'Reader' }];
    await store.setSkillPins(clusterId, scoped);
    workflows.get(ids[0])!.config.pinnedSkills = [refs[12]];
    await assert.rejects(store.setMemberRole(clusterId, ids[0], 'Reader'), /12 unique skills/);
    assert.equal((await store.readCluster(clusterId))!.memberRoles?.[ids[0]], undefined);
    workflows.get(ids[2])!.config.pinnedSkills = [refs[12]];
    await assert.rejects(store.replaceMember(clusterId, ids[0], ids[2], undefined, 'Reader'), /12 unique skills/);
    assert.deepEqual(store.getMembers(clusterId), ids.slice(0, 2));
    const big = [];
    for (let i = 0; i < 2; i++) {
      const skill = await writeSkill({ scope: 'project', name: `Large fixture ${i}`, description: '', body: 'x'.repeat(33 * 1024) }, cwd);
      big.push({ scope: 'project' as const, slug: skill.slug });
    }
    await assert.rejects(store.setSkillPins(clusterId, big), /64 KiB/);
    await store.setSkillPins(clusterId, [big[0]]);
    await assert.rejects(assertWorkflowSkillPins(ids[1], cwd, [big[1]]), /64 KiB/);
  } finally {
    for (const id of ids) workflows.delete(id);
    if (clusterId) await store.deleteCluster(clusterId);
    await rm(cwd, { recursive: true, force: true });
  }
});
