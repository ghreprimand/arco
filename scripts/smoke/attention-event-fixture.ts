// Produce a real attention event for a synthetic long turn, without providers.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '@arco/shared';
import { initNotifications } from '../../server/src/notifications.js';
import { _setChannelsPathForTest, loadChannels, saveChannels, observeAttention, MIN_FINISHED_TURN_MS } from '../../server/src/attention.js';

async function main() {
const dir = await mkdtemp(join(tmpdir(), 'arco-attention-smoke-'));
const now = Date.now;
try {
  _setChannelsPathForTest(join(dir, 'channels.json'));
  await loadChannels();
  await saveChannels({ desktop: { finished: true } });
  let event: ServerMessage | undefined;
  await initNotifications((message) => { if (message.type === 'attention_event') event = message; });
  const start = now(); Date.now = () => start;
  observeAttention('other', { type: 'primary_turn_started', workflowId: 'other', startedAt: start } as ServerMessage, { name: 'Other', incognito: false });
  Date.now = () => start + MIN_FINISHED_TURN_MS + 1;
  observeAttention('other', { type: 'primary_turn_ended', workflowId: 'other', endedAt: start + MIN_FINISHED_TURN_MS + 1 } as ServerMessage, { name: 'Other', incognito: false });
  if (!event) throw new Error('No attention event was emitted.');
  process.stdout.write(JSON.stringify(event));
} finally { Date.now = now; await rm(dir, { recursive: true, force: true }); }

}
void main();
