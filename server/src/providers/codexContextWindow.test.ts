import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WorkerConfig } from '@archon/shared';
import { codexContextWindowOverride, readCodexContextMetadata } from './codexContextWindow.js';
import { buildThreadConfigOverrides } from './codex-appserver/worker.js';

function homeWith(models: unknown[]): string {
  const home = mkdtempSync(join(tmpdir(), 'archon-codex-context-'));
  writeFileSync(join(home, 'models_cache.json'), JSON.stringify({ models }));
  return home;
}

function config(codexHome: string, policy?: 'max' | 'standard'): WorkerConfig {
  return {
    provider: 'codex',
    model: 'gpt-6-astra',
    effort: 'medium',
    codexHome,
    ...(policy ? { codexContextPolicy: policy } : {}),
  };
}

test('missing policy defaults to the live catalog maximum', () => {
  const home = homeWith([{
    slug: 'gpt-6-astra',
    context_window: 272_000,
    max_context_window: 872_000,
    effective_context_window_percent: 95,
  }]);
  assert.equal(codexContextWindowOverride(config(home)), 872_000);
  assert.deepEqual(readCodexContextMetadata('gpt-6-astra', home), {
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    effectiveContextWindowPercent: 95,
  });
});

test('standard policy leaves Codex at its catalog default', () => {
  const home = homeWith([{ slug: 'gpt-6-astra', context_window: 272_000, max_context_window: 872_000 }]);
  assert.equal(codexContextWindowOverride(config(home, 'standard')), undefined);
});

test('app-server thread config applies MAX and omits STANDARD', async () => {
  const home = homeWith([{ slug: 'gpt-6-astra', context_window: 272_000, max_context_window: 872_000 }]);
  assert.deepEqual(await buildThreadConfigOverrides(config(home)), {
    web_search: 'live',
    model_context_window: 872_000,
  });
  assert.deepEqual(await buildThreadConfigOverrides(config(home, 'standard')), {
    web_search: 'live',
  });
});

test('missing or malformed metadata fails safe to Codex default', () => {
  const home = homeWith([{ slug: 'gpt-5.6-sol', max_context_window: 872_000 }]);
  assert.equal(codexContextWindowOverride(config(home, 'max')), undefined);
  writeFileSync(join(home, 'models_cache.json'), '{bad json');
  assert.equal(codexContextWindowOverride(config(home, 'max')), undefined);
});
