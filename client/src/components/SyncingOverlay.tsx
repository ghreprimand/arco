// Slot 2 — shown between WS onopen and workflow_state_snapshot arrival for
// every persisted workflow. Translucent + pointer-events:none so the UI keeps
// rendering behind it and the operator doesn't mistake stale client state for
// truth. Mirrors ShutdownOverlay.tsx shape (scaled down).
const ROOT: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexDirection: 'column', gap: '10px', zIndex: 9500, pointerEvents: 'none',
};
const TITLE: React.CSSProperties = {
  fontSize: '22px', letterSpacing: '6px', color: 'var(--color-accent-secondary)',
  animation: 'pulse-glow 1.4s ease-in-out infinite',
};
const SUB: React.CSSProperties = {
  fontSize: '11px', color: 'var(--color-fg-muted)',
  fontFamily: 'var(--font-body)', letterSpacing: '1px',
};

export function SyncingOverlay() {
  return (
    <div style={ROOT}>
      <div className="display-font glow-text-bright" style={TITLE}>SYNCING…</div>
      <div style={SUB}>restoring workflow state from server</div>
    </div>
  );
}
