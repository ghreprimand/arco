// codexCodeMode.ts contract: catalog-driven code-mode detection against a
// real-shaped models_cache.json, plus the addendum's load-bearing strings
// (the exec-cell tool names ARE the fix — see CODEX_GPT56_CLUSTER_INCOMPAT.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { codexModelUsesCodeMode, codexCodeModeClusterAddendum, codexClusterDeveloperInstructions } from './codexCodeMode.js';

function writeCache(dir: string, models: unknown[]): void {
  fs.writeFileSync(
    path.join(dir, 'models_cache.json'),
    JSON.stringify({ fetched_at: '2026-07-09T00:00:00Z', etag: 'x', client_version: '0.144.0', models }),
  );
}

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-code-mode-test-'));
}

test('code_mode_only + multi_agent_version → true', () => {
  const home = tmpHome();
  writeCache(home, [
    { slug: 'gpt-5.6-terra', tool_mode: 'code_mode_only', multi_agent_version: 'v2' },
    { slug: 'gpt-5.5', tool_mode: null, multi_agent_version: null },
  ]);
  assert.equal(codexModelUsesCodeMode('gpt-5.6-terra', home), true);
});

test('multi_agent_version alone (no tool_mode) → true', () => {
  const home = tmpHome();
  writeCache(home, [{ slug: 'gpt-5.7-hypothetical', tool_mode: null, multi_agent_version: 'v3' }]);
  assert.equal(codexModelUsesCodeMode('gpt-5.7-hypothetical', home), true);
});

test('catalog entry with neither field → false (definitively direct)', () => {
  const home = tmpHome();
  writeCache(home, [{ slug: 'gpt-5.5', tool_mode: null, multi_agent_version: null }]);
  assert.equal(codexModelUsesCodeMode('gpt-5.5', home), false);
});

test('model absent from catalog → null (unknown)', () => {
  const home = tmpHome();
  writeCache(home, [{ slug: 'gpt-5.5', tool_mode: null, multi_agent_version: null }]);
  assert.equal(codexModelUsesCodeMode('gpt-9.9-unknown', home), null);
});

test('missing cache file → null (unknown)', () => {
  assert.equal(codexModelUsesCodeMode('gpt-5.6-terra', tmpHome()), null);
});

test('malformed cache file → null, no throw', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'models_cache.json'), 'not json{');
  assert.equal(codexModelUsesCodeMode('gpt-5.6-terra', home), null);
});

test('mtime bump invalidates the in-memory cache', () => {
  const home = tmpHome();
  writeCache(home, [{ slug: 'gpt-5.6-terra', tool_mode: 'code_mode_only', multi_agent_version: 'v2' }]);
  assert.equal(codexModelUsesCodeMode('gpt-5.6-terra', home), true);
  writeCache(home, [{ slug: 'gpt-5.6-terra', tool_mode: null, multi_agent_version: null }]);
  const file = path.join(home, 'models_cache.json');
  const bumped = new Date(Date.now() + 5000);
  fs.utimesSync(file, bumped, bumped);
  assert.equal(codexModelUsesCodeMode('gpt-5.6-terra', home), false);
});

test('addendum names the exec-cell tool namespace verbatim', () => {
  const text = codexCodeModeClusterAddendum();
  // Live-verified names (exec + app-server transports, codex-cli 0.144.0):
  // server "arco-cluster" mangles dash→underscore, then mcp__<server>__<tool>.
  assert.match(text, /tools\.mcp__arco_cluster__peer_read\(\)/);
  assert.match(text, /tools\.mcp__arco_cluster__peer_send\(\{to, content\}\)/);
  assert.match(text, /tools\.mcp__arco_cluster__peer_list\(\)/);
  // The real peer_send param is `content` — a `message` param silently fails.
  assert.doesNotMatch(text, /\{to, message\}/);
  // Must disclaim the harness's native collaboration tools and directorship.
  assert.match(text, /spawn_agent/);
  assert.match(text, /director/i);
});

test('Astra director gets developer-level Arco identity and operating contract', () => {
  const home = tmpHome();
  writeCache(home, [{ slug: 'gpt-6-astra', tool_mode: 'code_mode_only', multi_agent_version: 'v2' }]);
  const text = codexClusterDeveloperInstructions({
    provider: 'codex',
    model: 'gpt-6-astra',
    effort: 'medium',
    cwd: '/tmp/project',
    clusterId: 'cluster-1',
    clusterRole: "Director role. Delegate via peer_send, never Task; don't write code; verify claims; plan = rules + tasks; you land.",
  });
  assert.ok(text?.includes('operator-assigned role'));
  assert.ok(text?.includes('Arco cluster director contract'));
  assert.ok(text?.includes('call cluster_plan_read'));
  assert.ok(text?.includes('Do not write or edit product code or tests yourself'));
  assert.ok(text?.includes('Landing is yours'));
  assert.ok(text?.includes('The plan holds standing rules and tasks only'));
  assert.ok(!text?.includes('Do not end with a status-only response'));
  assert.ok(text?.includes('tools.mcp__arco_cluster__peer_send'));
});

test('non-cluster Codex thread gets no cluster developer instructions', () => {
  assert.equal(codexClusterDeveloperInstructions({
    provider: 'codex', model: 'gpt-6-astra', effort: 'medium', cwd: '/tmp/project',
  }), null);
});
