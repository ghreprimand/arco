import { useState } from 'react';
import type { JobState } from '../../stores/appStore';
import { useAppStore } from '../../stores/appStore';

// docs/PROVIDERS.md - operator-attachable `codebase-memory-mcp` per
// tab. Pure UX wiring: the toggle and Re-index button drive WS / HTTP calls;
// the actual `--mcp-config` write-in at CLI spawn time is deferred until
// Cluster Phase 3's `mcpConfigWriter` lands. The binary is operator-
// installed once per machine (see docs/OPERATIONS.md) and Arco always
// invokes it with `--skip-config` so it doesn't auto-edit other agent
// configs — that invariant lives in the server-side reindex handler + the
// future spawn-site wiring.
export function CodebaseMemorySection({
  job,
  onAttach,
  onDetach,
}: {
  job: JobState;
  onAttach: (workflowId: string, indexPath?: string) => void;
  onDetach: (workflowId: string) => void;
}) {
  const cm = job.config.codebaseMemory;
  const attached = cm?.attached === true;
  const defaultPath = cm?.indexPath || job.config.workingDirectory || '';
  const [draftPath, setDraftPath] = useState<string>(defaultPath);
  const [reindexing, setReindexing] = useState(false);
  const pushNotification = useAppStore((s) => s.pushNotification);

  const handleToggle = () => {
    if (attached) {
      onDetach(job.id);
    } else {
      onAttach(job.id, draftPath || undefined);
    }
  };

  const handleReindex = async () => {
    if (reindexing) return;
    setReindexing(true);
    try {
      const resp = await fetch(`/api/workflows/${encodeURIComponent(job.id)}/codebase-memory/reindex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ indexPath: draftPath || undefined }),
      });
      if (resp.status === 503) {
        pushNotification('error', 'codebase-memory-mcp not installed — see docs/OPERATIONS.md');
        return;
      }
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        pushNotification('error', `Re-index failed: ${data.error ?? resp.status}`);
        return;
      }
      // Success — the server pushed a fresh `codebase_memory_state` over
      // WS which the store handler already mirrored; nothing else to do.
    } catch (err) {
      pushNotification('error', `Re-index failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div style={{ marginTop: '18px' }}>
      <div
        className="display-font"
        style={{
          fontSize: '10px',
          letterSpacing: '2px',
          color: 'var(--color-accent-secondary-dim)',
          marginBottom: '8px',
        }}
      >
        INDEXES & MEMORY
      </div>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '11px',
          fontFamily: 'var(--font-body)',
          color: 'var(--color-fg)',
          cursor: 'pointer',
          marginBottom: '8px',
        }}
      >
        <input
          type="checkbox"
          checked={attached}
          onChange={handleToggle}
          style={{ cursor: 'pointer' }}
        />
        Attach codebase memory to this tab
      </label>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '8px' }}>
        <label
          className="display-font"
          style={{ fontSize: '9px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)' }}
        >
          INDEX PATH
        </label>
        <input
          type="text"
          value={draftPath}
          placeholder={job.config.workingDirectory || 'absolute path'}
          onChange={(e) => setDraftPath(e.target.value)}
          style={{
            padding: '4px 8px',
            fontSize: '11px',
            fontFamily: 'var(--font-code)',
            background: 'transparent',
            border: '1px solid var(--color-border-hairline)',
            color: 'var(--color-fg)',
            borderRadius: '2px',
          }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <button
          type="button"
          onClick={handleReindex}
          disabled={reindexing}
          style={{
            padding: '4px 10px',
            fontSize: '11px',
            fontFamily: 'var(--font-body)',
            border: '1px solid var(--color-border-hairline)',
            background: 'transparent',
            color: reindexing ? 'var(--color-fg-muted)' : 'var(--color-fg)',
            cursor: reindexing ? 'wait' : 'pointer',
            borderRadius: '2px',
          }}
        >
          {reindexing ? 're-indexing…' : 'Re-index now'}
        </button>
        <span
          style={{
            fontSize: '10px',
            color: 'var(--color-fg-muted)',
            fontFamily: 'var(--font-body)',
          }}
        >
          {renderStatus(cm)}
        </span>
      </div>

      <div
        style={{
          fontSize: '10px',
          color: 'var(--color-fg-muted)',
          fontFamily: 'var(--font-body)',
          lineHeight: 1.5,
        }}
      >
        Tree-sitter knowledge graph the model can query (deterministic, no LLM in the server).
        Spawn-site MCP wiring lands as a follow-up after Cluster Phase 3 — for now the toggle
        records intent and Re-index runs the binary one-shot.
      </div>
    </div>
  );
}

function renderStatus(cm: JobState['config']['codebaseMemory']): string {
  if (!cm) return 'Not indexed yet.';
  const parts: string[] = [];
  if (typeof cm.fileCount === 'number') {
    parts.push(`Indexed: ${cm.fileCount.toLocaleString()} files`);
  }
  if (typeof cm.lastIndexedAt === 'number') {
    parts.push(`last sync ${formatRelative(cm.lastIndexedAt)}`);
  }
  if (parts.length === 0) return cm.attached ? 'Attached — not indexed yet.' : 'Not indexed yet.';
  return parts.join(' · ');
}

function formatRelative(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 60_000) return 'just now';
  if (dt < 60 * 60_000) return `${Math.floor(dt / 60_000)} min ago`;
  if (dt < 24 * 60 * 60_000) return `${Math.floor(dt / 3_600_000)} h ago`;
  return new Date(ts).toLocaleDateString();
}
