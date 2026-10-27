import type { JobState } from '../../stores/appStore';

// docs/PROVIDERS.md - Files-tab "Blast radius" sub-tab. When the
// operator has attached codebase memory to this tab, this surface renders
// `detect_changes` output (importers / call sites / affected routes) for
// the current `git diff` against the index.
//
// Spawn-site MCP wiring is deferred to a follow-up after Cluster Phase 3
// ships `mcpConfigWriter`. Until then this sub-tab renders the placeholder
// state explaining what's wired and what's pending. The empty state below
// it covers the "memory not attached" branch.
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
            The model can query <code style={{ fontFamily: 'var(--font-code)' }}>detect_changes</code> once
            spawn-site MCP wiring lands (deferred — follows Cluster Phase 3 <code style={{ fontFamily: 'var(--font-code)' }}>mcpConfigWriter</code>).
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
