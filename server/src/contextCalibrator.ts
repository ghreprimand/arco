
import { registerWorkerPid, unregisterWorkerPid } from './workers/pidRegistry.js';
import { commandArgs } from './windowsCommand.js';

export type CalibrationZone = 'E' | 'A' | 'B' | 'C';

export interface CalibrationState {
  ratio: number;                     // bytes per message-token (JSONL bytes / messages tokens)
  overhead: number;                  // fixed overhead tokens (system prompt + tools etc.)
  zonesCalibrated: Set<CalibrationZone>;
  lastGroundTruth?: number;          // epoch ms of last successful calibration
}

export interface CalibrationResult {
  ratio: number;
  overhead: number;
  groundTruthTotalTokens: number;
  groundTruthMessagesTokens: number;
}

// Zone ranges [low%, high%] — calibration fires once per zone per session.
// Zone E (early) exists so Opus 1M sessions get a ground-truth reading while
// the session is still small enough to matter; without it, zone A at 20–30%
// means the first calibration doesn't fire until 200k–300k msg tokens on a
// 1M window — most sessions rotate (handoff) before reaching that.
const ZONE_RANGES: Record<CalibrationZone, [number, number]> = {
  E: [8, 15],
  A: [20, 30],
  B: [45, 55],
  C: [70, 80],
};

// Returns the zone the given percentage falls within, or null.
export function zoneForPercent(percent: number): CalibrationZone | null {
  for (const zone of ['E', 'A', 'B', 'C'] as CalibrationZone[]) {
    const [lo, hi] = ZONE_RANGES[zone];
    if (percent >= lo && percent <= hi) return zone;
  }
  return null;
}

// Returns the highest uncalibrated zone whose range overlaps [min(from,to), max(from,to)].
// Handles late-trigger: a single turn jumping from 40% → 85% should still fire zone C.
export function highestUncalibratedZoneCrossed(
  from: number,
  to: number,
  calibrated: Set<CalibrationZone>,
): CalibrationZone | null {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (const zone of ['C', 'B', 'A', 'E'] as CalibrationZone[]) {
    if (calibrated.has(zone)) continue;
    const [zlo, zhi] = ZONE_RANGES[zone];
    if (lo <= zhi && hi >= zlo) return zone;
  }
  return null;
}

// Strip ANSI escape sequences and non-printable control chars from pty output.
function stripAnsi(s: string): string {
  return s.replace(
    // CSI sequences (\x1B[ ... letter), OSC (\x1B] ... \x07/ST), other Fe-sequences
    /\x1B\[[0-9;?]*[a-zA-Z]|\x1B\][^\x07]*\x07|\x1B[()][0-9A-Z]|\x1B[^[]/g,
    '',
  ).replace(/[\x00-\x08\x0B-\x1A\x1C-\x1F\x7F]/g, '');
}

// Parse a token count string like "62k", "223.8k", "1m", "62,048", "1,000,000".
function parseTokenCount(s: string): number {
  const clean = s.replace(/,/g, '').toLowerCase().trim();
  if (clean.endsWith('m')) return Math.round(parseFloat(clean) * 1_000_000);
  if (clean.endsWith('k')) return Math.round(parseFloat(clean) * 1000);
  return parseInt(clean, 10);
}

interface ParsedContext {
  totalTokens: number;    // total context used (messages + overhead)
  messagesTokens: number; // messages portion only
}

// Parse `/context` command output. Claude TUI (Apr 2026) outputs markdown:
//   **Tokens:** 247k / 1m (25%)
//   | Messages | 223.8k | 22.4% |
// Older TUI builds used a plain-text form that's kept here as a fallback:
//   62k/200k tokens (31%)
//   Messages: 44k tokens
function parseContextOutput(raw: string): ParsedContext | null {
  const text = stripAnsi(raw);

  // Total used: prefer the markdown "Tokens: NN / NN" header; fall back to
  // the legacy "NN/NN tokens" form. The markdown label sits *before* the
  // numbers; the legacy label sits after — two distinct patterns.
  const totalMatch =
    text.match(/Tokens:\*{0,2}\s*([\d,.]+[km]?)\s*\/\s*[\d,.]+[km]?/i) ||
    text.match(/([\d,.]+[km]?)\s*\/\s*[\d,.]+[km]?\s*tokens/i);
  // Messages portion: markdown table row "| Messages | NN | NN% |" or the
  // legacy "Messages: NN tokens" form.
  const msgMatch =
    text.match(/\|\s*Messages\s*\|\s*([\d,.]+[km]?)\s*\|/i) ||
    text.match(/[Mm]essages:\s*([\d,.]+[km]?)\s*tokens/i);

  if (!totalMatch || !msgMatch) return null;

  const totalTokens = parseTokenCount(totalMatch[1]);
  const messagesTokens = parseTokenCount(msgMatch[1]);

  if (
    isNaN(totalTokens) || isNaN(messagesTokens) ||
    totalTokens <= 0 || messagesTokens <= 0 ||
    messagesTokens > totalTokens
  ) return null;

  return { totalTokens, messagesTokens };
}

// Run `claude --resume <sessionId> --print "/context"` and parse the real
// token counts. Returns calibration result or null on failure/timeout.
//
// `registerCancel` is called synchronously with a function that kills the
// subprocess early — used by the caller to cancel if a primary turn starts
// mid-calibration.
//
// Historical note: this used to spawn a pty and type /context into the TUI.
// That broke when the TUI's history-render step started taking >10s on large
// sessions (a 247k-context Opus 1M session would spin up rendering the full
// prior conversation before /context was even accepted), and the parser
// silently timed out every run. --print goes through the same slash-command
// dispatcher but returns the report directly and exits in ~3s — no pty, no
// history render, no init-delay guesswork.
export async function runCalibration(
  sessionId: string,
  model: string,
  cwd: string,
  jsonlBytes: number,
  registerCancel?: (cancelFn: () => void) => void,
): Promise<CalibrationResult | null> {
  const TIMEOUT_MS = 30_000;
  const { spawn } = await import('child_process');

  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    let child: import('child_process').ChildProcess | undefined;

    const done = (result: CalibrationResult | null): void => {
      if (settled) return;
      settled = true;
      const pid = child?.pid;
      try { child?.kill('SIGKILL'); } catch { /* best-effort */ }
      if (pid !== undefined) unregisterWorkerPid(pid);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      console.warn(`[calibrator] /context timed out (session ${sessionId.slice(0, 8)})`);
      done(null);
    }, TIMEOUT_MS);

    const cancelFn = (): void => {
      clearTimeout(timeout);
      done(null);
    };

    if (registerCancel) registerCancel(cancelFn);

    try {
      // Pass --model so /context renders for the model Arco's session is
      // actually using. Without it, claude resumes with the user's default
      // model — whose /context output may not reconcile (sessions with
      // mid-flight kills can show messages > total under some models, which
      // trips the parser's sanity check). Matching the model also makes the
      // overhead/window numbers correct (they're model-specific).
      child = spawn(...commandArgs('claude', ['--resume', sessionId, '--model', model, '--print', '/context']), {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (child.pid !== undefined) registerWorkerPid(child.pid);

      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
      child.stderr?.on('data', () => { /* ignored — slash-command dispatcher may log auth hints */ });

      child.on('error', (err) => {
        clearTimeout(timeout);
        console.error('[calibrator] failed to spawn claude:', err);
        done(null);
      });

      child.on('exit', () => {
        clearTimeout(timeout);
        const parsed = parseContextOutput(stdout);
        if (!parsed) {
          done(null);
          return;
        }
        const ratio = jsonlBytes > 0 ? jsonlBytes / parsed.messagesTokens : 9.0;
        const overhead = parsed.totalTokens - parsed.messagesTokens;
        done({
          ratio: ratio > 1 ? ratio : 9.0,
          overhead: overhead > 0 ? overhead : 17_000,
          groundTruthTotalTokens: parsed.totalTokens,
          groundTruthMessagesTokens: parsed.messagesTokens,
        });
      });
    } catch (err) {
      clearTimeout(timeout);
      console.error('[calibrator] failed to spawn claude:', err);
      done(null);
    }
  });
}
