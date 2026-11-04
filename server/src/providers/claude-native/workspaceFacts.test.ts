// Unit tests for H54 — workspace facts detection (pure core).
//
// Contracts:
//  • package-manager from lockfile; node verify commands from package.json
//    scripts in priority order (build/typecheck → test → lint);
//  • `npm test` shorthand (not `npm run test`); pnpm/yarn/bun use `<pm> <script>`;
//  • rust/go/python/make ecosystems detected from markers;
//  • primaryVerify is the first/best command (what Handoff seeds reuse);
//  • renderProjectFactsBlock returns null when nothing detected (no token cost);
//  • linked-worktree + branch surface in the block.
//
// Run: node --import tsx --test src/providers/claude-native/workspaceFacts.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectProjectFacts, renderProjectFactsBlock } from './workspaceFacts.js';

test('node + npm: build/test/lint from scripts, npm test shorthand', () => {
  const f = detectProjectFacts('/proj', {
    files: ['package.json', 'package-lock.json'],
    packageScripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .', dev: 'vite' },
  });
  assert.equal(f.packageManager, 'npm');
  assert.deepEqual(f.verifyCommands, ['npm run build', 'npm test', 'npm run lint']);
  assert.equal(f.primaryVerify, 'npm run build');
  assert.equal(f.runCommand, 'npm run dev');
  assert.ok(f.ecosystem.includes('node'));
});

test('pnpm uses `pnpm <script>` form', () => {
  const f = detectProjectFacts('/proj', {
    files: ['package.json', 'pnpm-lock.yaml'],
    packageScripts: { build: 'tsc', test: 'jest' },
  });
  assert.equal(f.packageManager, 'pnpm');
  assert.deepEqual(f.verifyCommands, ['pnpm build', 'pnpm test']);
});

test('typecheck wins as build-like when no build script', () => {
  const f = detectProjectFacts('/proj', {
    files: ['package.json'],
    packageScripts: { typecheck: 'tsc --noEmit', test: 'vitest' },
  });
  assert.equal(f.primaryVerify, 'npm run typecheck');
});

test('rust: cargo build/test', () => {
  const f = detectProjectFacts('/proj', { files: ['Cargo.toml'] });
  assert.ok(f.ecosystem.includes('rust'));
  assert.deepEqual(f.verifyCommands, ['cargo build', 'cargo test']);
  assert.equal(f.primaryVerify, 'cargo build');
});

test('go: go build/test', () => {
  const f = detectProjectFacts('/proj', { files: ['go.mod'] });
  assert.ok(f.ecosystem.includes('go'));
  assert.deepEqual(f.verifyCommands, ['go build ./...', 'go test ./...']);
});

test('python: pytest from pyproject.toml', () => {
  const f = detectProjectFacts('/proj', { files: ['pyproject.toml'] });
  assert.ok(f.ecosystem.includes('python'));
  assert.deepEqual(f.verifyCommands, ['pytest']);
});

test('makefile targets → make <target>, dedup vs node', () => {
  const f = detectProjectFacts('/proj', {
    files: ['Makefile'],
    makefileTargets: ['check', 'build', 'clean'],
  });
  assert.ok(f.ecosystem.includes('make'));
  assert.ok(f.verifyCommands.includes('make check'));
  assert.ok(f.verifyCommands.includes('make build'));
});

test('renderProjectFactsBlock: null when nothing detected (no token cost)', () => {
  const f = detectProjectFacts('/empty', { files: [] });
  assert.equal(renderProjectFactsBlock(f), null);
});

test('renderProjectFactsBlock: carries verify cmds, branch, linked-worktree', () => {
  const f = detectProjectFacts('/proj', {
    files: ['package.json', 'pnpm-lock.yaml'],
    packageScripts: { build: 'tsc', test: 'vitest' },
    gitBranch: 'feature/x',
    isLinkedWorktree: true,
  });
  const block = renderProjectFactsBlock(f);
  assert.ok(block);
  assert.match(block!, /Verify your work with: pnpm build; pnpm test/);
  assert.match(block!, /branch feature\/x/);
  assert.match(block!, /linked worktree/);
});

test('deterministic: same input ⇒ identical block', () => {
  const raw = { files: ['package.json'], packageScripts: { test: 'jest' } };
  const a = renderProjectFactsBlock(detectProjectFacts('/p', raw));
  const b = renderProjectFactsBlock(detectProjectFacts('/p', raw));
  assert.equal(a, b);
});
