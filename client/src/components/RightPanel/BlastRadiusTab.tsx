import type { JobState } from '../../stores/appStore';

// docs/PROVIDERS.md - Files-tab "Blast radius" sub-tab. When the
// operator has attached codebase memory to this tab, this surface renders
// the index status. The model can use `detect_changes` for importers, call
// sites and affected routes through the attached MCP server.
//
// Claude CLI and Codex Agent launches receive the attached server in their
// MCP configuration. This sub-tab does not display the tool output. The empty
// state below covers the "memory not attached" branch.
export function BlastRadiusTab({ job }: { job: JobState }) {
  const attached = job.config.codebaseMemory?.attached === true;
  if (!attached) {
    return (
      <div
        className="display-font"
        style={{
          padding: '24px 18px',
          color: 'var(--color-fg-muted)',
          fontSize: '11px',
          letterSpacing: '0.5px',
          lineHeight: 1.6,
        }}
      >
        Attach codebase memory in CONFIG to enable Blast Radius.
      </div>
    );
  }

  const cm = job.config.codebaseMemory;
  const indexed = typeof cm?.lastIndexedAt === 'number';

  return (
    <div style={{ padding: '14px 16px', overflowY: 'auto', flex: 1 }}>
      <div
        className="display-font"
        style={{
          fontSize: '10px',
          letterSpacing: '2px',
          color: 'var(--color-accent-secondary-dim)',
          marginBottom: '8px',
        }}
      >
        BLAST RADIUS
      </div>
      <div
        style={{
          fontSize: '11px',
          fontFamily: 'var(--font-body)',
          color: 'var(--color-fg-muted)',
          lineHeight: 1.6,
        }}
      >
        {indexed ? (
          <>
            Index is ready at <code style={{ fontFamily: 'var(--font-code)' }}>{cm?.indexPath}</code>.
            Claude CLI and Codex Agent tabs outside isolation can use <code style={{ fontFamily: 'var(--font-code)' }}>detect_changes</code> through the attached MCP server. Ask the agent to check the changes; this panel shows index status.
          </>
        ) : (
          <>
            Codebase memory is attached but the index hasn't been built yet. Click <strong>Re-index now</strong> in
            the CONFIG tab to populate it.
          </>
        )}
      </div>
    </div>
  );
}
