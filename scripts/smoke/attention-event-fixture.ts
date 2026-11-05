// Produce a real attention event for a synthetic long turn, without providers.
// The turn's start and end go through send(), the path the turn engine uses
// for operator, auto-pickup and peer-mail turns.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import type { ServerMessage } from '@arco/shared';
import { initNotifications } from '../../server/src/notifications.js';
import { _setChannelsPathForTest, loadChannels, saveChannels, MIN_FINISHED_TURN_MS } from '../../server/src/attention.js';
import { send } from '../../server/src/server/broadcast.js';
import { workflows } from '../../server/src/server/state.js';
import type { WorkflowState } from '../../server/src/workflows/types.js';

async function main() {
const dir = await mkdtemp(join(tmpdir(), 'arco-attention-smoke-'));
const now = Date.now;
try {
  _setChannelsPathForTest(join(dir, 'channels.json'));
  await loadChannels();
  await saveChannels({ desktop: { finished: true } });
  let event: ServerMessage | undefined;
  await initNotifications((message) => { if (message.type === 'attention_event') event = message; });
  const ws = { readyState: 3, send: () => undefined } as unknown as WebSocket;
  workflows.set('other', { config: { name: 'Other', workingDirectory: dir }, primary: { provider: 'claude', model: 'fixture' }, observers: new Set() } as unknown as WorkflowState);
  const start = now(); Date.now = () => start;
  send(ws, { type: 'primary_turn_started', workflowId: 'other', startedAt: start } as ServerMessage);
  Date.now = () => start + MIN_FINISHED_TURN_MS + 1;
  send(ws, { type: 'primary_turn_ended', workflowId: 'other', endedAt: start + MIN_FINISHED_TURN_MS + 1 } as ServerMessage);
  if (!event) throw new Error('No attention event was emitted.');
  process.stdout.write(JSON.stringify(event));
} finally { Date.now = now; await rm(dir, { recursive: true, force: true }); }
process.exit(0);
}
void main();
