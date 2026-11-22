import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeResearcherFence } from './researcherFence.js';

test('Claude researcher policy keeps the home fence and removes web tools when web is off', () => {
  for (const webAccess of [true, false]) {
    const { args } = claudeResearcherFence({ webAccess, webProxyPort: 32123 });
    const tools = args[args.indexOf('--tools') + 1].split(',');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    assert.ok(tools.includes('Bash') && tools.includes('Read') && tools.includes('Write'));
    assert.equal(tools.includes('WebSearch'), webAccess);
    assert.equal(tools.includes('WebFetch'), webAccess);
    assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
    assert.equal(settings.permissions.blockWritesOutsideWorkingDirectories, true);
    assert.ok(settings.permissions.deny.includes('Read(//home/**)'));
    assert.ok(settings.permissions.deny.includes('Read(//run/arco-access.json)'));
    assert.ok(settings.sandbox.filesystem.denyRead.includes('/run/arco-access.json'));
    assert.ok(settings.sandbox.filesystem.denyRead.includes('/run/arco-check.json'));
    assert.ok(settings.permissions.allow.includes('mcp__arco-cluster__peer_read'));
    assert.ok(settings.permissions.allow.includes('mcp__arco-cluster__peer_send'));
    assert.equal(settings.sandbox.enabled, true);
    assert.equal(settings.sandbox.failIfUnavailable, true);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.equal(settings.sandbox.network.httpProxyPort, 32123);
    assert.ok(args.includes('--strict-mcp-config'));
  }
  for (const webProxyPort of [0, -1, 65536, 1.5]) assert.throws(() => claudeResearcherFence({ webAccess: true, webProxyPort }), /valid sandbox proxy port/);
});
