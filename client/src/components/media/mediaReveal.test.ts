import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

test('B189: media output reveal follows the pinned workflow rather than the active tab', async () => {
  const source = await readFile(new URL('../../App.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('<MediaModalHost');
  const end = source.indexOf('\n        />', start) + '\n        />'.length;
  const output = await transform(`module.exports = (${source.slice(start, end)});`, { loader: 'tsx', format: 'cjs', jsx: 'transform' });
  const pinned = { cwd: '/fixture/a', workflowId: 'a' };
  const activeJob = { id: 'b', config: { workingDirectory: '/fixture/b' } };
  const events: Array<{ detail: { workflowId: string } }> = [];
  let selected: string | undefined;
  const module = { exports: {} as { props: { fileContext: unknown; onRevealInFiles(): void } } };
  const scope = { React: { createElement: (_type: unknown, props: unknown) => ({ props }) }, MediaModalHost() {}, mediaStudio: { context: pinned }, effectiveMediaContext: pinned, activeJob, jobs: { a: {}, b: {} }, setMediaStudio() {}, useAppStore: { getState: () => ({ setActiveJob: (id: string) => { selected = id; }, jobs: { a: {}, b: {} } }) }, requestVoicePanel() {}, window: { dispatchEvent: (event: { detail: { workflowId: string } }) => events.push(event) }, CustomEvent: class { detail: unknown; constructor(_type: string, init: { detail: unknown }) { this.detail = init.detail; } } };
  new Function('module', ...Object.keys(scope), output.code)(module, ...Object.values(scope));
  assert.deepEqual(module.exports.props.fileContext, pinned);
  module.exports.props.onRevealInFiles();
  assert.equal(events[0]?.detail.workflowId, 'a');
  assert.equal(selected, 'a');
});
