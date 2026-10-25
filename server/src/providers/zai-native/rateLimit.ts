type Slot = { release: () => void; waitMs: number; retryCount: number };

const MAX_IN_FLIGHT = parseEnvInt('ARCHON_ZAI_MAX_IN_FLIGHT', 2, 1, 8);
const MIN_REQUEST_INTERVAL_MS = parseEnvMs('ARCHON_ZAI_MIN_REQUEST_INTERVAL_MS', 0, 0, 60_000);
const DEFAULT_429_BACKOFF_MS = parseEnvMs('ARCHON_ZAI_429_BACKOFF_MS', 5_000, 1_000, 5 * 60_000);
const MAX_429_BACKOFF_MS = parseEnvMs('ARCHON_ZAI_MAX_429_BACKOFF_MS', 10_000, 1_000, 10 * 60_000);
const MAX_429_RETRIES = parseEnvInt('ARCHON_ZAI_429_RETRIES', 1, 0, 12);

let inFlight = 0;
const waiters: Array<() => void> = [];
let gate: Promise<void> = Promise.resolve();
let nextStartAt = 0;
let cooldownUntil = 0;

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

function parseEnvMs(name: string, fallback: number, min: number, max: number): number {
  return parseEnvInt(name, fallback, min, max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireInFlight(): Promise<() => void> {
  while (inFlight >= MAX_IN_FLIGHT) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight = Math.max(0, inFlight - 1);
    waiters.shift()?.();
  };
}

async function waitStartWindow(): Promise<void> {
  const prior = gate;
  let releaseGate!: () => void;
  gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  await prior;
  try {
    const delay = Math.max(0, cooldownUntil - Date.now(), nextStartAt - Date.now());
    if (delay > 0) await sleep(delay);
    nextStartAt = Math.max(nextStartAt, Date.now() + MIN_REQUEST_INTERVAL_MS);
  } finally {
    releaseGate();
  }
}

export async function acquireZaiSlot(): Promise<Slot> {
  const start = Date.now();
  const release = await acquireInFlight();
  try {
    await waitStartWindow();
  } catch (err) {
    release();
    throw err;
  }
  return { release, waitMs: Date.now() - start, retryCount: 0 };
}

export function maxZaiRetries(): number {
  return MAX_429_RETRIES;
}

export function zaiErrorCode(detail: string): string | null {
  try {
    const parsed = JSON.parse(detail) as { error?: { code?: unknown }; code?: unknown };
    const code = parsed.error?.code ?? parsed.code;
    return typeof code === 'string' || typeof code === 'number' ? String(code) : null;
  } catch {
    const match = /"code"\s*:\s*"?(\d{4})"?/i.exec(detail);
    return match?.[1] ?? null;
  }
}

export function isRetryableZai429(detail: string): boolean {
  const code = zaiErrorCode(detail);
  return !code || code === '1302' || code === '1303' || code === '1305';
}

export function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export function recordZai429(retryAfter: string | null, attempt: number): number {
  const explicit = retryAfterMs(retryAfter);
  const backoff = explicit !== null
    ? Math.min(MAX_429_BACKOFF_MS, explicit)
    : Math.min(MAX_429_BACKOFF_MS, DEFAULT_429_BACKOFF_MS * Math.max(1, 2 ** attempt));
  cooldownUntil = Math.max(cooldownUntil, Date.now() + backoff);
  nextStartAt = Math.max(nextStartAt, cooldownUntil);
  return backoff;
}
