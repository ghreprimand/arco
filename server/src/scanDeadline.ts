// Pending filesystem work cannot always be cancelled. Bound the caller's wait
// and dispose any handle that arrives after its scan has already returned.
export function scanBeforeDeadline<T>(pending: Promise<T>, budget: { deadline: number; partial: boolean }, discard?: (value: T) => unknown): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abandon = (value: T) => {
      try { void Promise.resolve(discard?.(value)).catch(() => {}); } catch { /* late cleanup is best effort */ }
    };
    const expire = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); budget.partial = true; resolve(undefined);
    };
    const remaining = budget.deadline - performance.now();
    if (remaining <= 0) expire();
    else timer = setTimeout(expire, Math.max(1, Math.ceil(remaining)));
    pending.then(value => {
      if (settled) { abandon(value); return; }
      if (performance.now() >= budget.deadline) { expire(); abandon(value); return; }
      settled = true; clearTimeout(timer); resolve(value);
    }, error => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(error);
    });
  });
}
