import { useEffect, useState } from 'react';

// Browser-side dedup via Web Locks API. The first tab to load claims an
// exclusive lock; any tab that loads after it (e.g. a duplicate from Zen's
// session restore running alongside xdg-open) gets denied and can render a
// "duplicate" overlay instead of bringing up a second live app. The lock
// auto-releases when the primary tab closes, so a queued duplicate can
// promote itself to primary without a reload.

type Status = 'checking' | 'primary' | 'duplicate';

const LOCK_NAME = 'arco-singleton';

let started = false;
let cachedStatus: Status = 'checking';
const listeners = new Set<(s: Status) => void>();

function broadcast(s: Status) {
  cachedStatus = s;
  listeners.forEach((fn) => fn(s));
}

function startAcquire() {
  if (started) return;
  started = true;

  if (typeof navigator === 'undefined' || !navigator.locks) {
    broadcast('primary');
    return;
  }

  // ifAvailable: immediate check. If lock is free we take it, hold it
  // forever (tab lifetime), and become primary. If not, we broadcast
  // duplicate and queue a blocking request that will promote us if the
  // primary ever releases.
  navigator.locks
    .request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (lock) {
        broadcast('primary');
        await new Promise<void>(() => {});
        return;
      }
      broadcast('duplicate');
      await navigator.locks.request(LOCK_NAME, async () => {
        broadcast('primary');
        await new Promise<void>(() => {});
      });
    })
    .catch(() => broadcast('primary'));
}

export function useTabSingleton(): Status {
  const [status, setStatus] = useState<Status>(cachedStatus);

  useEffect(() => {
    listeners.add(setStatus);
    if (cachedStatus !== status) setStatus(cachedStatus);
    startAcquire();
    return () => {
      listeners.delete(setStatus);
    };
  }, []);

  return status;
}
