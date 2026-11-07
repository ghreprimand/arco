import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKBENCH_NOTICE_CATEGORIES, type ServerMessage } from '@arco/shared';

const root = mkdtempSync(join(tmpdir(), 'arco-notice-source-'));
installIsolatedTestHome(root);
const clusters = await import('./clusterStore.js');
const { workflows } = await import('./server/state.js');
const { noticeSourceFor } = await import('./noticeSource.js');
const notice = await import('./notifications.js');
const attention = await import('./attention.js');
after(() => rmSync(root, { recursive: true, force: true }));

test('server events identify the correct member and cluster for all scoped notice types', async () => {
  const project = join(root, 'project'); mkdirSync(project);
  const one = await clusters.createCluster({ cwd: project, memberWorkflowIds: ['director-one', 'helper-one'] });
  const two = await clusters.createCluster({ cwd: project, memberWorkflowIds: ['director-two', 'helper-two'] });
  await clusters.renameCluster(one.clusterId, 'Harbor');
  await clusters.renameCluster(two.clusterId, 'Beacon');
  workflows.set('director-one', { config: { name: 'Director' } } as never);
  workflows.set('director-two', { config: { name: 'Director' } } as never);
  workflows.set('standalone', { config: { name: 'Build tab' } } as never);
  assert.equal(noticeSourceFor('director-one'), 'Director in Harbor');
  assert.equal(noticeSourceFor('director-two'), 'Director in Beacon');
  assert.equal(noticeSourceFor('standalone'), 'Build tab');
  const sent: ServerMessage[] = [];
  notice._setMutesPathForTest(join(root, 'mutes.json'));
  await notice.initNotifications((event) => sent.push(event));
  for (const category of WORKBENCH_NOTICE_CATEGORIES) {
    const emitted = notice.emit({ category, severity: 'info', title: 'Fixture event', workflowId: 'director-one' });
    assert.equal(emitted?.title, category === 'turn-finished' ? 'Director in Harbor finished' : 'Director in Harbor: Fixture event', category);
    assert.equal(emitted?.workflowId, 'director-one');
  }
  assert.equal(notice.emit({ category: 'backup', severity: 'info', title: 'Backup complete' })?.title, 'Backup complete');
  const posted: string[] = [];
  attention._setChannelsPathForTest(join(root, 'channels.json'));
  attention._setFetchForTest((async (_url: string, init: { headers: Record<string, string> }) => { posted.push(init.headers.Title); return { ok: true, status: 200 }; }) as never);
  await attention.loadChannels();
  await attention.saveChannels({ clusterFinished: 'all', phone: { finished: true }, ntfy: { server: 'https://ntfy.example.org', topic: 'fixture' } });
  attention.raise('finished', 'director-two', { name: 'Director', incognito: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(posted, ['Director in Beacon finished']);
  const message = sent.find((event) => event.type === 'attention_event');
  assert.equal(message?.type === 'attention_event' && message.workflowName, 'Director in Beacon');
  workflows.delete('director-one'); workflows.delete('director-two'); workflows.delete('standalone');
});
