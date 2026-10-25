import { DiffView } from '../diff/DiffView';
import type { GhPullFile } from './types';
import { ghFilesToUnifiedDiff, ghFilesWithoutPatch } from './ghDiff';
import { fileStatusColor } from './shared';

// Workbench Expansion I4 — render a list of GitHub changed files as real diffs.
//
// Shared by the PR "files" view and the commit-detail view: both get a
// GhPullFile[] from GitHub (with bare-hunk `patch`es). We reconstruct a proper
// unified diff via ghFilesToUnifiedDiff (see ghDiff.ts for the header gotcha)
// and feed it to the A3 DiffView. Files with no patch (binary / oversized) are
// excluded from the renderer and shown as a small notice row with a link.

export function GhFilesDiff({ files, helpKey }: { files: GhPullFile[]; helpKey?: string }) {
  const patch = ghFilesToUnifiedDiff(files);
  const noPatch = ghFilesWithoutPatch(files);

  return (
    <div data-help={helpKey}>
      {patch.trim() ? (
        <DiffView patch={patch} emptyText="No textual changes." />
      ) : (
        noPatch.length === 0 && <EmptyNote label="No files changed." />
      )}
      {noPatch.length > 0 && (
        <div style={{ marginTop: patch.trim() ? '12px' : 0 }}>
          {noPatch.map((f) => (
            <div
              key={f.sha + f.filename}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0',
                borderBottom: '1px solid var(--color-border-hairline)',
              }}
            >
              <span style={{ fontFamily: 'var(--font-body)', fontSize: '12px', color: fileStatusColor(f.status), flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.previous_filename ? `${f.previous_filename} → ${f.filename}` : f.filename}
              </span>
              <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)' }}>
                binary or too large — no inline diff
              </span>
              {f.blob_url && (
                <a href={f.blob_url} target="_blank" rel="noreferrer" style={{ fontSize: '10px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-display)', letterSpacing: '1px', textDecoration: 'none' }}>VIEW ↗</a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyNote({ label }: { label: string }) {
  return (
    <div style={{ padding: '20px', textAlign: 'center', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', fontSize: '11px', letterSpacing: '1px' }}>
      {label}
    </div>
  );
}
