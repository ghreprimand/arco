// DEBAG sub-phase 1 — sensitivity classifier (docs/DEBAG_PLAN.md §3).
//
// Proves the static allowlist is deterministic and operator-readable:
//  - Bash always gates; a git push/reset --hard/clean -fd inside it gates with
//    the more-specific git-destructive category (richer audit reason).
//  - KillShell gates.
//  - Write/Edit/MultiEdit gate ONLY when the resolved target escapes cwd.
//  - Read-only tools and in-cwd writes are inert (hot path untouched).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyGate } from './gateReview.js';

const CWD = '/home/operator/Projects/Arco';

test('Bash gates wholesale (category bash)', () => {
  const d = classifyGate('Bash', { command: 'npm test' }, CWD);
  assert.equal(d.sensitive, true);
  if (d.sensitive) assert.equal(d.category, 'bash');
});

test('git push inside Bash gates with git-destructive category', () => {
  const d = classifyGate('Bash', { command: 'git push origin main' }, CWD);
  assert.equal(d.sensitive, true);
  if (d.sensitive) assert.equal(d.category, 'git-destructive');
});

test('git reset --hard gates as git-destructive', () => {
  const d = classifyGate('Bash', { command: 'git reset --hard HEAD~1' }, CWD);
  assert.equal(d.sensitive, true);
  if (d.sensitive) assert.equal(d.category, 'git-destructive');
});

test('git clean -fd gates as git-destructive (either flag order)', () => {
  const a = classifyGate('Bash', { command: 'git clean -fd' }, CWD);
  const b = classifyGate('Bash', { command: 'git clean -df' }, CWD);
  assert.equal(a.sensitive, true);
  assert.equal(b.sensitive, true);
  if (a.sensitive) assert.equal(a.category, 'git-destructive');
  if (b.sensitive) assert.equal(b.category, 'git-destructive');
});

test('KillShell gates', () => {
  const d = classifyGate('KillShell', { shell_id: 'abc' }, CWD);
  assert.equal(d.sensitive, true);
  if (d.sensitive) assert.equal(d.category, 'kill-shell');
});

test('Write inside cwd is inert', () => {
  const d = classifyGate('Write', { file_path: 'server/src/x.ts', content: 'x' }, CWD);
  assert.equal(d.sensitive, false);
});

test('Write inside cwd via absolute path is inert', () => {
  const d = classifyGate('Write', { file_path: `${CWD}/server/src/x.ts`, content: 'x' }, CWD);
  assert.equal(d.sensitive, false);
});

test('Write outside cwd gates (write-outside-cwd)', () => {
  const d = classifyGate('Write', { file_path: '/etc/passwd', content: 'x' }, CWD);
  assert.equal(d.sensitive, true);
  if (d.sensitive) assert.equal(d.category, 'write-outside-cwd');
});

test('Edit escaping cwd via ../ gates', () => {
  const d = classifyGate('Edit', { file_path: '../../../etc/hosts', old_string: 'a', new_string: 'b' }, CWD);
  assert.equal(d.sensitive, true);
  if (d.sensitive) assert.equal(d.category, 'write-outside-cwd');
});

test('a sibling dir that shares a prefix is still outside cwd', () => {
  // /home/operator/Projects/Arco-windows-port must NOT count as inside Arco.
  const d = classifyGate('Write', { file_path: '/home/operator/Projects/Arco-windows-port/x.ts', content: 'x' }, CWD);
  assert.equal(d.sensitive, true);
  if (d.sensitive) assert.equal(d.category, 'write-outside-cwd');
});

test('the cwd root itself is treated as inside (inert)', () => {
  const d = classifyGate('Write', { file_path: CWD, content: 'x' }, CWD);
  assert.equal(d.sensitive, false);
});

test('Write with no file_path is inert (nothing to resolve)', () => {
  const d = classifyGate('Write', { content: 'x' }, CWD);
  assert.equal(d.sensitive, false);
});

test('read-only tools are inert', () => {
  for (const t of ['Read', 'Glob', 'Grep', 'TodoWrite', 'WebFetch']) {
    assert.equal(classifyGate(t, {}, CWD).sensitive, false, `${t} should be inert`);
  }
});
