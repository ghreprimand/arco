// Providers report compactions for auto-handoff: the Claude CLI's
// compact_boundary and Codex app-server compactions, one per compaction.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
import type { WorkerConfig } from '@arco/shared';

const temp = mkdtempSync(join(tmpdir(), 'arco-compaction-sources-'));
installIsolatedTestHome(temp);
after(() => rmSync(temp, { recursive: true, force: true }));
const { setCompactionSink } = await import('./compactionReport.js');
const { StreamParser } = await import('./workers/StreamParser.js');
const { CodexAppServerWorker } = await import('./providers/codex-appserver/worker.js');

test('the Claude CLI stream reports compact_boundary with its session', async () => {
  const parser = new StreamParser();
  const seen: unknown[] = [];
  parser.on('compact_boundary', (data) => seen.push(data));
  const input = new PassThrough();
  parser.parse(input);
  input.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }) + '\n');
  input.write(JSON.stringify({ type: 'system', subtype: 'compact_boundary', session_id: 's1', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } }) + '\n');
  input.write(JSON.stringify({ type: 'system', subtype: 'compact_boundary', session_id: 's1', compact_metadata: { trigger: 'manual', pre_tokens: 9000 } }) + '\n');
  input.end();
  await new Promise((done) => parser.once('done', done));
  assert.deepEqual(seen, [{ sessionId: 's1', trigger: 'auto' }, { sessionId: 's1', trigger: 'manual' }]);
});

test('Codex app-server counts one compaction per turn whether it arrives as an item, a notification or both', () => {
  const reports: Array<{ workflowId: string; source: string; sessionId?: string }> = [];
  setCompactionSink((r) => reports.push(r));
  try {
    const worker = new CodexAppServerWorker('wf-codex-count', {} as WorkerConfig, 'thread-1');
    const internals = worker as unknown as { threadId: string | null; onNotification: (n: { method: string; params: unknown }) => void };
    internals.threadId = 'thread-1';
    internals.onNotification({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 't1', item: { type: 'contextCompaction', id: 'c1' } } });
    internals.onNotification({ method: 'thread/compacted', params: { threadId: 'thread-1', turnId: 't1' } });
    internals.onNotification({ method: 'thread/compacted', params: { threadId: 'thread-1', turnId: 't2' } });
    internals.onNotification({ method: 'thread/compacted', params: { threadId: 'other-thread', turnId: 't3' } });
    assert.deepEqual(reports, [
      { workflowId: 'wf-codex-count', source: 'codex', sessionId: 'thread-1' },
      { workflowId: 'wf-codex-count', source: 'codex', sessionId: 'thread-1' },
    ]);
  } finally { setCompactionSink(null); }
});
