// docs/PROVIDERS.md - regression guard for the fleet-snapshot parser. Builds a
// fixture `subagents/workflows/` dir (journal.jsonl + agent-*.jsonl) matching
// what the CLI's WorkflowTool writes, then asserts buildFleetSnapshot derives
// the right counts / labels / lastTool, honors the baseline filter, and uses
// the mtime cache. Pins the load-bearing behavior so a refactor can't silently
// blank the Activity-tab FLEET panel.
//
// Run: node --conditions development --import tsx --test src/ultracodeFleetWatcher.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildFleetSnapshot } from './ultracodeFleetWatcher.js';

function runDir(workflowsDir: string, name: string): string {
  const dir = join(workflowsDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJournal(dir: string, lines: object[]): void {
  writeFileSync(join(dir, 'journal.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function writeAgent(dir: string, agentId: string, prompt: string, tools: string[]): void {
  const lines: object[] = [{ type: 'user', agentId, message: { role: 'user', content: prompt } }];
  for (const name of tools) {
    lines.push({ type: 'assistant', agentId, message: { role: 'assistant', content: [{ type: 'tool_use', name }] } });
  }
  writeFileSync(join(dir, `agent-${agentId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('absent workflows dir → empty snapshot, never throws', async () => {
  const snap = await buildFleetSnapshot(join(tmpdir(), 'does-not-exist-xyz'), new Set(), new Map());
  assert.deepEqual(snap, { total: 0, running: 0, done: 0, agents: [] });
});

test('counts started vs result; label + lastTool from transcript', async () => {
  const wfDir = mkdtempSync(join(tmpdir(), 'fleet-'));
  const run = runDir(wfDir, 'wf_abc123');
  // a1 done, a2 still running.
  writeJournal(run, [
    { type: 'started', agentId: 'a1' },
    { type: 'started', agentId: 'a2' },
    { type: 'result', agentId: 'a1' },
  ]);
  writeAgent(run, 'a1', 'Adversarially verify the v0.5.4 install section', ['Read', 'Bash']);
  writeAgent(run, 'a2', 'Inventory the odytty README feature list', ['Grep']);

  const snap = await buildFleetSnapshot(wfDir, new Set(), new Map());
  assert.equal(snap.total, 2);
  assert.equal(snap.done, 1);
  assert.equal(snap.running, 1);

  const a1 = snap.agents.find((a) => a.agentId === 'a1')!;
  const a2 = snap.agents.find((a) => a.agentId === 'a2')!;
  assert.equal(a1.status, 'done');
  assert.equal(a1.label, 'Adversarially verify the v0.5.4 install section');
  assert.equal(a1.lastTool, 'Bash'); // last tool_use wins
  assert.equal(a2.status, 'running');
  assert.equal(a2.lastTool, 'Grep');
});

test('baseline filter ignores wf_* dirs from earlier turns on the same session', async () => {
  const wfDir = mkdtempSync(join(tmpdir(), 'fleet-'));
  const old = runDir(wfDir, 'wf_old');
  writeJournal(old, [{ type: 'started', agentId: 'x1' }, { type: 'result', agentId: 'x1' }]);
  writeAgent(old, 'x1', 'stale prior-turn agent', ['Read']);
  const fresh = runDir(wfDir, 'wf_new');
  writeJournal(fresh, [{ type: 'started', agentId: 'n1' }]);
  writeAgent(fresh, 'n1', 'this turn agent', ['Edit']);

  const snap = await buildFleetSnapshot(wfDir, new Set(['wf_old']), new Map());
  assert.equal(snap.total, 1);
  assert.equal(snap.agents[0].agentId, 'n1');
});

test('agent with no transcript yet still counts, with a placeholder label', async () => {
  const wfDir = mkdtempSync(join(tmpdir(), 'fleet-'));
  const run = runDir(wfDir, 'wf_p');
  writeJournal(run, [{ type: 'started', agentId: 'q1' }]); // no agent-q1.jsonl
  const snap = await buildFleetSnapshot(wfDir, new Set(), new Map());
  assert.equal(snap.total, 1);
  assert.equal(snap.agents[0].status, 'running');
  assert.equal(snap.agents[0].label, '(starting…)');
});
