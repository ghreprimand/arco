import { useEffect, useState } from 'react';
import { turnStep } from '../utils/turnStep';
import type { JobState } from '../stores/appStore';
import { contextTokens } from '../utils/format';
import { parseCursorModelId, cursorEffortKey, CURSOR_EFFORT_LABELS } from '@arco/shared';

// The honest effort label for a Cursor model id: the effort parsed OUT of the
// id (never `config.primaryEffort`, which the Cursor worker ignores). `auto`
// and bare-default ids carry no effort → null (chip hidden).
function cursorEffortDisplay(modelId: string): string | null {
  const parsed = parseCursorModelId(modelId);
  if (parsed.family === 'auto' || parsed.effort === null) return null;
  return CURSOR_EFFORT_LABELS[cursorEffortKey(parsed.effort)] ?? parsed.effort;
}

// Braille spinner frames — standard 10-frame set. Renders as a single
// monospace glyph so line height doesn't shift between frames.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 90;

interface Props {
  job: JobState;
}

export function PrimaryStatus({ job }: Props) {
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const step = turnStep(job.activity ?? [], job.turnStartedAt, now);
  // Cursor bakes effort into the model id — `config.primaryEffort` is a stored
  // default the Cursor worker ignores, so showing it here would be a lie (the
  // "am I secretly on xhigh?" ambiguity). Read the TRUE effort back out of the
  // resolved id instead; `auto` has no effort (Cursor's router picks it).
  const effort = job.config.primaryProvider === 'cursor'
    ? cursorEffortDisplay(String(job.config.primaryModel))
    : job.config.primaryEffort;
  const lastCtx = job.lastTurnTokens ? contextTokens(job.lastTurnTokens, job.config.primaryProvider) : 0;
  const lastOut = job.lastTurnTokens?.output ?? 0;

  return (
    <span
      className="display-font"
      style={{
        fontSize: '11px',
        color: 'var(--color-warning)',
        letterSpacing: '1px',
        marginTop: '3px',
        marginLeft: '8px',
        minWidth: 0,
        overflow: 'hidden',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
      }}
    >
      <span style={{ fontSize: '13px', width: '10px', textAlign: 'center' }}>
        {SPINNER_FRAMES[frame]}
      </span>
      <span data-help="composer.turn-step" title={step.label} style={{ minWidth: 0, display: 'inline-flex', gap: '4px', alignItems: 'center' }}><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{step.label}</span><span style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>· {step.time}{step.longRunning ? ' · LONG-RUNNING' : ''}</span></span>
      {effort && <span style={{ opacity: 0.7 }}>· {String(effort).toUpperCase()}</span>}
      {lastCtx > 0 && (
        <span style={{ opacity: 0.55 }} title={`Last turn: ${lastCtx.toLocaleString()} ctx · ${lastOut.toLocaleString()} out`}>
          · last {formatCompact(lastCtx)} ctx
        </span>
      )}
    </span>
  );
}

function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(n / 1000) + 'k';
}
