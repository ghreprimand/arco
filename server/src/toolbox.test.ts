import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeClaudeSkillCatalog,
  normalizeCodexSkillCatalog,
  parseClaudeInitLine,
} from './toolbox.js';

test('Claude init parsing and catalog merge preserve native invocation names', () => {
  const init = parseClaudeInitLine(JSON.stringify({
    type: 'system',
    subtype: 'init',
    skills: ['frontend-design:frontend-design', 'code-review'],
  }));
  assert.ok(init);
  const entries = mergeClaudeSkillCatalog(init, [{
    name: 'frontend-design:frontend-design',
    displayName: 'frontend-design',
    description: 'Design guidance',
    provider: 'claude',
    source: 'plugin',
    invocation: '/frontend-design:frontend-design',
  }]);
  assert.deepEqual(entries.map((entry) => [entry.name, entry.source, entry.invocation]), [
    ['frontend-design:frontend-design', 'plugin', '/frontend-design:frontend-design'],
    ['code-review', 'builtin', '/code-review'],
  ]);
});

test('Codex catalog normalization uses $ mentions, scope, display metadata, and enablement', () => {
  const entries = normalizeCodexSkillCatalog({
    data: [{
      cwd: '/repo',
      errors: [],
      skills: [
        {
          name: 'repo-check', description: 'Check this repo', path: '/repo/.agents/skills/repo-check/SKILL.md',
          scope: 'repo', enabled: true,
        },
        {
          name: 'imagegen', description: 'Generate images', path: '/home/u/.codex/skills/.system/imagegen/SKILL.md',
          scope: 'system', enabled: true, interface: { displayName: 'Image Gen', shortDescription: 'Images' },
        },
        {
          name: 'templates:report', description: 'Create report',
          path: '/home/u/.archon/provider-accounts/codex-work/plugins/cache/vendor/templates/1.0/skills/report/SKILL.md',
          scope: 'user', enabled: true,
        },
        {
          name: 'disabled', description: 'Hidden', path: '/tmp/disabled/SKILL.md', scope: 'user', enabled: false,
        },
      ],
    }],
  }, '/repo');
  assert.deepEqual(entries.map((entry) => [entry.name, entry.source, entry.invocation, entry.displayName]), [
    ['repo-check', 'project', '$repo-check', undefined],
    ['templates:report', 'plugin', '$templates:report', undefined],
    ['imagegen', 'system', '$imagegen', 'Image Gen'],
  ]);
});
