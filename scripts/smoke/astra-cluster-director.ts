// Deterministic regression for the Astra director incident. No model call:
// this pins the prompt material Archon controls before app-server receives it.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, assert, summary } from './lib.js';
import { buildClusterDirectorDoctrine } from '../../server/src/clusterDirector.js';
import { planOutline } from '../../server/src/clusterPlanOutline.js';
import {
  APPEND_CLUSTER_MAX,
  CODEX_APP_SERVER_CLUSTER_MAX,
  composeClusterAppend,
} from '../../server/src/clusterStringFold.js';
import { codexClusterDeveloperInstructions } from '../../server/src/providers/codexCodeMode.js';
import { normalizeClusterRoleText } from '../../shared/src/clusterRolePresets.js';

const ROLE = "Director role. Delegate via peer_send, never Task; don't write code; verify claims; plan = rules + tasks; you land.";

async function main(): Promise<void> {
  await step('Astra receives developer-level Arco director identity', () => {
    const home = mkdtempSync(join(tmpdir(), 'archon-astra-director-'));
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'gpt-6-astra', tool_mode: 'code_mode_only', multi_agent_version: 'v2' }],
    }));
    const instructions = codexClusterDeveloperInstructions({
      provider: 'codex', model: 'gpt-6-astra', effort: 'medium', cwd: '/tmp/project',
      codexHome: home, clusterId: 'cluster-1', clusterRole: ROLE,
    });
    assert(instructions?.includes('operator-assigned role'), 'role is developer context');
    assert(instructions?.includes('Landing is yours'), 'director keeps commit/push authority');
    assert(instructions?.includes('Do not write or edit product code or tests yourself'), 'director delegates implementation');
    assert(instructions?.includes('never in the plan body'), 'status stays out of the plan');
    assert(!instructions?.includes('Continue the next plan step in the same turn'), 'no do-it-yourself continuation rule');
    assert(instructions?.includes('tools.mcp__archon_cluster__peer_read'), 'real Astra tool name is present');
  });

  await step('app-server carries a long plan that CLI must outline', () => {
    const plan = [
      '**Standing gates (apply every turn)**',
      '- Commit and push every accepted packet.',
      '- Keep the plan and board current.',
      '### Work',
      ...Array.from({ length: 400 }, (_, i) => `- [${i < 180 ? 'x' : ' '}] task ${i} ${'detail '.repeat(7)}`),
    ].join('\n');
    const doctrine = buildClusterDirectorDoctrine(ROLE) ?? '';
    const appserver = composeClusterAppend(plan, [doctrine], 1024, CODEX_APP_SERVER_CLUSTER_MAX, planOutline(plan));
    const cli = composeClusterAppend(plan, [doctrine], 1024, APPEND_CLUSTER_MAX, planOutline(plan));
    assert(appserver.planTruncatedFrom === undefined, 'app-server receives full plan');
    assert(cli.planTruncatedFrom === plan.length, 'CLI keeps bounded outline behavior');
  });

  await step('outline retains standing directives when fallback is required', () => {
    const outline = planOutline([
      '**Standing rules**',
      '- Read the full plan before acting.',
      '- Push each accepted packet.',
      '### Phase',
      'discard this prose',
      '- [ ] implement',
    ].join('\n'));
    assert(outline.includes('Read the full plan before acting.'), 'standing rules survive');
    assert(outline.includes('- [ ] implement'), 'checkbox survives');
    assert(!outline.includes('discard this prose'), 'ordinary phase prose is omitted');
  });

  await step('stored pre-2026-09-26 director role upgrades to the current preset', () => {
    const old = 'Director role. Own outcome; delegate only via peer_send, never Task; keep plan current; verify claims; fold feedback.';
    assert(normalizeClusterRoleText(old) === ROLE, 'old own-outcome preset normalizes forward');
    assert(ROLE.length <= 120, 'preset fits MEMBER_ROLE_MAX');
    assert(normalizeClusterRoleText('Director role. custom text') === 'Director role. custom text', 'operator-typed text untouched');
  });

  summary('Astra cluster director');
}

void main();
