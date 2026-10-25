import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import type { JobState } from '../stores/appStore';
import type { WorkerState } from '@arco/shared';

// DARKN0DE-inspired tension signal — a single scalar in [0, 1] derived
// from app state. 0 = calm (nothing happening, all providers healthy);
// 1 = crisis (disconnected + multiple failed workers + everything busy).
// Consumers:
//  - ThemedBackgroundShader → uTension uniform; shaders scale motion
//    / density / aberration against it
//  - Global CSS → --tension custom property; body vignette, status-dot
//    pulse period, glow intensity
// The value is written to :root and fired as an event once per RAF
// frame (not per state change) so that decay → 0 is smooth rather than
// snapping when e.g. an error ages out.

const FAIL_WINDOW_MS = 60_000;
const FAIL_WEIGHT = 0.25;   // per failed worker (capped)
const FAIL_CAP = 0.5;       // max contribution from failures
const BUSY_WEIGHT = 0.35;   // for any busy job
const DISCONNECT_WEIGHT = 0.4;

function countBusyJobs(jobs: Record<string, JobState>): number {
  let n = 0;
  for (const j of Object.values(jobs)) if (j.busy) n++;
  return n;
}

function countRecentFailures(jobs: Record<string, JobState>, now: number): number {
  let n = 0;
  for (const j of Object.values(jobs)) {
    for (const w of Object.values(j.workers) as WorkerState[]) {
      if (w.status === 'failed' && now - w.lastActivityAt < FAIL_WINDOW_MS) n++;
    }
  }
  return n;
}

export function computeTension(
  jobs: Record<string, JobState>,
  connected: boolean,
  now: number = Date.now(),
): number {
  let t = 0;
  const busy = countBusyJobs(jobs);
  if (busy > 0) t += BUSY_WEIGHT;
  if (!connected) t += DISCONNECT_WEIGHT;
  const failures = countRecentFailures(jobs, now);
  t += Math.min(failures * FAIL_WEIGHT, FAIL_CAP);
  return Math.min(t, 1);
}

// Polls the store at 5Hz (interval, not rAF — tension changes on the order
// of seconds, not frames; failures decay over 60s, busy/disconnected flips
// on WS state). Only writes `:root { --tension }` and fires `arco:tension`
// when the rounded value actually changes — earlier this dispatched 60 (or
// 144!) times/sec, every dispatch invalidating any CSS using `--tension` as
// a custom property and triggering style recalc. With a 5090 on a 144Hz
// scaled-4K display that path was a measurable share of idle GPU.
//
// Idempotent: multiple calls share nothing but the last one wins via the
// ref counter below so React StrictMode double-mount doesn't leak intervals.
let installed = 0;
const POLL_MS = 200;        // 5Hz
const EPSILON = 0.01;       // skip dispatches inside this band
export function useTensionDriver(): void {
  const intervalRef = useRef<number | undefined>(undefined);
  const lastRef = useRef<number>(NaN);
  useEffect(() => {
    installed++;
    const root = document.documentElement;
    const tick = () => {
      const s = useAppStore.getState();
      const t = computeTension(s.jobs, s.connected);
      if (!Number.isFinite(lastRef.current) || Math.abs(t - lastRef.current) >= EPSILON) {
        lastRef.current = t;
        root.style.setProperty('--tension', t.toFixed(3));
        window.dispatchEvent(new CustomEvent('arco:tension', { detail: t }));
        // body.tension-active gates `body::before` (the full-screen vignette)
        // so it doesn't sit in the compositor tree at opacity:0 forever.
        // Threshold matches the dead-zone above which the visual change is
        // discernible — picking 0.05 keeps it off through normal busy spikes.
        document.body.classList.toggle('tension-active', t > 0.05);
      }
    };
    tick(); // seed once so shaders get an initial value before the first interval fire
    intervalRef.current = window.setInterval(tick, POLL_MS);
    return () => {
      installed--;
      if (intervalRef.current !== undefined) window.clearInterval(intervalRef.current);
      if (installed === 0) root.style.removeProperty('--tension');
    };
  }, []);
}
