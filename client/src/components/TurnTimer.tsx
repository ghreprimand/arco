import React, { useEffect, useState } from 'react';

export function turnElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function TurnTimer({ busy, startedAt }: { busy: boolean; startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!busy || startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy, startedAt]);
  if (!busy || startedAt === undefined || !Number.isFinite(startedAt)) return null;
  return <span data-help="composer.turn-timer" data-testid="turn-timer" className="display-font" title="Elapsed time for the current turn" style={{ position: 'absolute', right: 0, top: '4px', color: 'var(--color-fg-muted)', fontSize: '10px', whiteSpace: 'nowrap', maxWidth: '90px', overflow: 'hidden', textOverflow: 'ellipsis' }}>TURN {turnElapsed(startedAt, now)}</span>;
}
