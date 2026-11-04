import { createUpdateChecker } from '../updateCheck.js';
import { APP_VERSION } from '../appVersion.js';
import { readSettings } from '../settings.js';
import { sessions } from './state.js';
import { WebSocket } from 'ws';

export const updateChecker = createUpdateChecker({
  current: APP_VERSION,
  settings: () => readSettings(),
  broadcast: (message) => {
    for (const ws of sessions.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    }
  },
  debug: (message) => console.debug(`[arco] ${message}`),
  log: (message) => console.log(`[arco] ${message}`),
});
