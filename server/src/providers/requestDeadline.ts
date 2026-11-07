// Keep the deadline active until the caller finishes the required response phase.
export async function requestWithDeadline<T>(
  ownerSignal: AbortSignal | null | undefined,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const signal = ownerSignal ? AbortSignal.any([ownerSignal, deadline.signal]) : deadline.signal;
  signal.throwIfAborted();
  const timer = setTimeout(() => deadline.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const running = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation(signal);
    });
    return await Promise.race([running, cancelled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
