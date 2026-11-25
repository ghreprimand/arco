import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyDraftTask, readOnlyFileTools } from './runCompare.js';

test('the reply-draft task carries the material and the question, and says whether tools exist', () => {
  const off = buildReplyDraftTask('What do I tell it?', 'worker: shall I refactor now?', false);
  assert.match(off, /Draft the reply the operator could send/);
  assert.match(off, /shall I refactor now\?/);
  assert.match(off, /What do I tell it\?/);
  assert.match(off, /You have no tools/);
  assert.match(buildReplyDraftTask('', 'material', true), /read-only tools/);
  assert.match(buildReplyDraftTask('', 'material', true), /none given/);
});
test('file access is read-only: no write, shell or web tools for any provider', () => {
  for (const provider of ['claude', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek']) {
    const tools = readOnlyFileTools(provider);
    assert.deepEqual(tools, ['Read', 'Grep', 'Glob']);
  }
  assert.deepEqual(readOnlyFileTools('codex'), []);
  assert.deepEqual(readOnlyFileTools('cursor'), []);
});

test('Compare retains account homes in leg order when resolutions finish out of order', async () => {
  const { resolveCompareLegs } = await import('../ws/compareHandlers.js');
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  const pending = resolveCompareLegs([{ provider: 'codex', providerAccountRef: 'first' }, { provider: 'other' }, { provider: 'codex', providerAccountRef: 'second' }], async ref => {
    if (ref === 'first') await first;
    else release();
    return { profile: { id: ref! }, codexHome: `home-${ref}` };
  });
  const result = await pending;
  assert.deepEqual(result.codexHomes, ['home-first', undefined, 'home-second']);
  assert.deepEqual(result.resolvedLegs.map(leg => leg.providerAccountRef), ['first', undefined, 'second']);
  await assert.rejects(resolveCompareLegs([{ provider: 'codex', providerAccountRef: 'missing' }], async () => ({ profile: { id: 'other' }, codexHome: 'home-other' })), /unavailable/);
  const fallbackResolver = async (ref?: string) => ref === 'valid' ? { profile: { id: 'valid' }, codexHome: 'home-valid' } : { profile: { id: 'other' }, codexHome: 'home-other' };
  await assert.rejects(resolveCompareLegs([{ provider: 'codex' }], fallbackResolver, 'missing'), /unavailable/);
  const override = await resolveCompareLegs([{ provider: 'codex', providerAccountRef: 'valid' }], fallbackResolver, 'missing');
  assert.deepEqual(override.codexHomes, ['home-valid']);
  const defaults = await resolveCompareLegs([{ provider: 'codex' }], fallbackResolver);
  assert.deepEqual(defaults.codexHomes, ['home-other']);
  const { TERMINAL_CODEX_ACCOUNT } = await import('@arco/shared');
  const terminal = await resolveCompareLegs([{ provider: 'codex', providerAccountRef: undefined as string | undefined }], async ref => { assert.equal(ref, TERMINAL_CODEX_ACCOUNT); return null; }, TERMINAL_CODEX_ACCOUNT);
  assert.deepEqual(terminal.codexHomes, [undefined]);
  assert.equal(terminal.resolvedLegs[0].providerAccountRef, TERMINAL_CODEX_ACCOUNT);
});
