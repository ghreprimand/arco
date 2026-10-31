import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localCapacityProblem, localCapacityUsage, sanitizeLocalClusterCapacity } from './localCapacity.js';

test('default capacity keeps the one-local-member rule', () => {
  assert.equal(localCapacityProblem(['claude', 'ollama'], undefined), null);
  assert.match(localCapacityProblem(['ollama', 'ollama'], undefined) ?? '', /2 members use Ollama, but it allows 1 at once/);
  assert.match(localCapacityProblem(['ollama', 'llamacpp'], undefined) ?? '', /together allow 1/);
  assert.equal(localCapacityProblem(['ollama', 'ollama', 'ollama'], undefined, true), null);
});

test('per-runtime settings raise each runtime and the combined limit', () => {
  assert.equal(localCapacityProblem(['ollama', 'ollama', 'ollama', 'codex'], { ollama: 3 }), null);
  assert.match(localCapacityProblem(['ollama', 'ollama', 'ollama', 'ollama'], { ollama: 3 }) ?? '', /4 members use Ollama, but it allows 3/);
  assert.match(localCapacityProblem(['llamacpp', 'llamacpp'], { ollama: 3 }) ?? '', /llama\.cpp, but it allows 1/);
  assert.equal(localCapacityProblem(['ollama', 'ollama', 'llamacpp'], { ollama: 3 }), null);
  assert.deepEqual(localCapacityUsage(['ollama', 'claude'], { ollama: 2 }).runtimes[0], { runtime: 'ollama', used: 1, limit: 2 });
});

test('sanitize keeps integers 1-16 only', () => {
  assert.deepEqual(sanitizeLocalClusterCapacity({ ollama: 4, llamacpp: 16 }), { ollama: 4, llamacpp: 16 });
  assert.equal(sanitizeLocalClusterCapacity({ ollama: 0, llamacpp: 17 }), undefined);
  assert.deepEqual(sanitizeLocalClusterCapacity({ ollama: 2.5, llamacpp: 2, lmstudio: 3 }), { llamacpp: 2 });
  assert.equal(sanitizeLocalClusterCapacity('3'), undefined);
});
