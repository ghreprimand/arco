const MAX_ACTIVE = 2;
let active = 0;
interface Waiter { resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; abort: () => void }
const waiters: Waiter[] = [];
async function acquire(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (active < MAX_ACTIVE) { active++; return; }
  await new Promise<void>((resolve,reject) => {
    const waiter: Waiter = { resolve,reject,signal,abort: () => {
      const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);
      reject(signal?.reason ?? new Error('Cancelled'));
    } };
    waiters.push(waiter);signal?.addEventListener('abort',waiter.abort,{once:true});
    if(signal?.aborted)waiter.abort();
  });
}
function release(): void {
  for (;;) {
    const waiter=waiters.shift();
    if(!waiter){active--;return;}
    waiter.signal?.removeEventListener('abort',waiter.abort);
    if(waiter.signal?.aborted){waiter.reject(waiter.signal.reason);continue;}
    // Transfer ownership without opening a gap for a new caller to steal it.
    waiter.resolve();return;
  }
}
export async function withFileDecodeSlot<T>(task:()=>Promise<T>,signal?:AbortSignal):Promise<T> {
  await acquire(signal);
  try { signal?.throwIfAborted(); return await task(); }
  finally { release(); }
}
