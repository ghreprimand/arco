import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { renderSystemdUnit } from '../service/unit.js';
import { renderAgentUnit } from './unit.js';
import { renderManagementUnit } from '../management/unit.js';

test('B198: source app, agent and hub retain the install-time Arco home', () => {
  const previous = process.env.ARCO_HOME;
  const configuredHome = resolve('/fixture/state with spaces');
  process.env.ARCO_HOME = configuredHome;
  try {
    const units = [renderSystemdUnit({ repoRoot: '/fixture/project' }), renderAgentUnit({ repoRoot: '/fixture/project' }), renderManagementUnit({ repoRoot: '/fixture/project', host: 'localhost', port: 3500, privateKeyPath: '/fixture/key' })];
    for (const unit of units) {
      const line = unit.split('\n').find(line => line.startsWith('Environment=') && line.includes('ARCO_HOME='));
      assert.ok(line, 'the service must not fall back to a different home');
      assert.equal(JSON.parse(line.slice(12)), `ARCO_HOME=${configuredHome}`);
    }
  } finally { if (previous === undefined) delete process.env.ARCO_HOME; else process.env.ARCO_HOME = previous; }
});
