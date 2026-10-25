import { useState } from 'react';
import { useTerminalStore } from '../stores/terminalStore';
import { useTerminalTarget } from '../hooks/useTerminalTarget';

// The one login surface every AUTH button funnels into. POST /api/auth-login
// returns the provider's headless login command; this shows it with RUN IN
// TERMINAL (pre-fills Archon's own terminal — a shell on the server box — and
// the operator presses Enter; the §K3 prefill fence never auto-runs) plus COPY
// as the fallback when no workflow has a terminal root (fresh boot, incognito
// chat). The CLI then prints a link / code the operator opens on whatever
// device they're using, so this works the same locally or over the tailnet.
export function LoginCommand({ command }: { command: string }) {
  const { workflowId, root } = useTerminalTarget();
  const prefillInTerminal = useTerminalStore((s) => s.prefillInTerminal);
  const [note, setNote] = useState<string | null>(null);
  const canRun = Boolean(workflowId && root);

  const run = () => {
    if (!workflowId) return;
    prefillInTerminal(workflowId, command);
    setNote('Pre-filled in the terminal — press Enter there, then open the link it prints.');
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setNote('Copied. Paste it into a shell on the Arco machine.');
    } catch {
      setNote('Clipboard unavailable — select the command above and copy it.');
    }
  };

  const btn = {
    padding: '4px 10px',
    background: 'transparent',
    border: '1px solid var(--color-accent-primary)',
    borderRadius: '3px',
    color: 'var(--color-accent-primary)',
    cursor: 'pointer',
    fontSize: '10px',
    letterSpacing: '1px',
  } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <code
        style={{
          display: 'block',
          padding: '6px 8px',
          background: 'var(--color-bg-deep, rgba(0,0,0,0.3))',
          border: '1px solid var(--color-border-hairline)',
          borderRadius: '3px',
          fontSize: '11px',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          color: 'var(--color-fg-primary, inherit)',
          wordBreak: 'break-all',
          userSelect: 'all',
        }}
      >
        {command}
      </code>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {canRun && (
          <button className="display-font" style={btn} onClick={run} title="Open Arco's terminal with this command ready to run">
            RUN IN TERMINAL
          </button>
        )}
        <button className="display-font" style={btn} onClick={() => void copy()}>
          COPY
        </button>
      </div>
      {note && (
        <div style={{ fontSize: '11px', lineHeight: 1.5, color: 'var(--color-accent-secondary-dim)', fontFamily: 'var(--font-body)' }}>
          {note}
        </div>
      )}
    </div>
  );
}
