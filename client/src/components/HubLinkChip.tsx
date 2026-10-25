import { useHubLinkStore } from '../stores/hubLinkStore';

// Header transparency indicator for the management-hub link (docs/
// REMOTE_MANAGEMENT.md §1). Shows whether THIS instance is linked to a hub (and
// thus remotely controllable) and offers a one-click local kill switch. Renders
// nothing when no hub is configured (hubUrl absent).

function hostOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^wss?:\/\//, '').split(/[:/]/)[0];
  }
}

// "4s ago" / "3m ago" — coarse age for the tooltip. Static at render (no live
// tick): the chip re-renders whenever a hub_link_status message lands.
function ago(ts?: number): string {
  if (!ts) return 'just now';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function HubLinkChip({ onToggle }: { onToggle: (enabled: boolean) => void }) {
  const { connected, hubUrl, known, monitoredCount, connectedSince } = useHubLinkStore();
  // No hub configured on this instance → nothing to show.
  if (!known || !hubUrl) return null;

  const host = hostOf(hubUrl);
  const color = connected ? 'var(--color-accent-secondary)' : 'var(--color-fg-muted)';

  const onClick = () => {
    if (connected) {
      if (confirm(`Disconnect this instance from the management hub (${host})?\n\nRemote control (reply / stop / handoff / lifecycle) stops until you reconnect.`)) {
        onToggle(false);
      }
    } else {
      onToggle(true);
    }
  };

  // Solid filled dot when linked (● — unambiguous "connected"), hollow when off.
  const dot = connected ? '●' : '○';
  // Compact label: dot + "HUB" only. Host + monitored count live in the tooltip
  // (hover) so the header indicator stays small.
  const tooltip = connected
    ? `Hub-linked: ${hubUrl}\nLinked ${ago(connectedSince)}. ${monitoredCount} workflow(s) monitored — opted in to remote (reply / stop / continue) + phone notifications.\nClick to disconnect (local kill switch).`
    : `Hub configured (${hubUrl}) but disconnected. Click to reconnect.`;

  return (
    <button
      type="button"
      data-help="header.hub-link"
      onClick={onClick}
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        background: 'transparent',
        border: `1px solid ${connected ? 'var(--color-accent-secondary-a30, var(--color-border-bright))' : 'var(--color-border-hairline)'}`,
        borderRadius: '3px',
        color,
        cursor: 'pointer',
        fontSize: '10px',
        fontFamily: 'var(--font-display)',
        letterSpacing: '1px',
        padding: '3px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden style={{ fontSize: '8px', lineHeight: 1, textShadow: connected ? '0 0 6px var(--color-accent-secondary-glow)' : 'none' }}>{dot}</span>
      {connected ? 'HUB' : 'HUB OFF'}
    </button>
  );
}
