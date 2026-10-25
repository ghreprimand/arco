import { useMemo, useState } from 'react';
import { Diff, Hunk, parseDiff, tokenize, markEdits } from 'react-diff-view';
import type { FileData, HunkData } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import './diff-view.css';

// Workbench Expansion A3 — source-agnostic unified-diff renderer.
//
// KEYSTONE CONSTRAINT (see WORKBENCH_EXPANSION_PLAN.md § A3): this component
// must NOT know where the diff came from. It takes a unified-diff string (or
// the parsed FileData[]) and renders it — checkpoint diffs, working-tree
// diffs, upstream comparisons, and GitHub PR patches all flow through here
// unchanged. A4 (revert), A6/A7 (file-edit diffs), D5 (inline comments) and
// all of Part I (Git/GitHub workbench) reuse it. Data-fetching / source
// selection lives OUTSIDE (e.g. ChangesPanel below, diffRoutes on the server).

export interface DiffViewProps {
  // A unified-diff string (`git diff` output, a PR `.patch`, etc.). Either
  // this or `files` must be provided; `patch` is parsed into `files`.
  patch?: string;
  // Pre-parsed files, for callers that already have FileData (e.g. a GitHub
  // API response mapped to the same shape). Wins over `patch` if both given.
  files?: FileData[];
  // Default view; the operator can flip it with the toggle.
  defaultViewType?: 'unified' | 'split';
  // Hide the per-DiffView header (used when an outer container draws its own).
  hideToolbar?: boolean;
  // Shown when there are no changes to render.
  emptyText?: string;
}

// Intra-line word-level highlighting via react-diff-view's built-in markEdits
// enhancer (no external syntax-highlighter dependency — the add/delete line
// coloring + word-level marks are themed entirely with CSS vars in
// diff-view.css). This is the "syntax-highlighted" surface the spec asks for
// without pulling in refractor; a richer token highlighter can be layered
// later via the `tokens` prop without touching callers.
function tokenizeHunks(hunks: HunkData[]) {
  try {
    return tokenize(hunks, {
      highlight: false,
      enhancers: [markEdits(hunks, { type: 'block' })],
    });
  } catch {
    // markEdits can throw on pathological hunks; fall back to no tokens.
    return undefined;
  }
}

function FileDiff({ file, viewType }: { file: FileData; viewType: 'unified' | 'split' }) {
  const [collapsed, setCollapsed] = useState(false);
  const tokens = useMemo(() => tokenizeHunks(file.hunks), [file.hunks]);
  const path = file.newPath && file.newPath !== '/dev/null' ? file.newPath : file.oldPath;
  const { adds, dels } = useMemo(() => countChanges(file), [file]);

  return (
    <div className="archon-diff-file">
      <button
        type="button"
        className="archon-diff-file-header display-font"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="archon-diff-file-caret">{collapsed ? '▸' : '▾'}</span>
        <span className="archon-diff-file-path">{renderPathLabel(file, path)}</span>
        <span className="archon-diff-file-stat">
          {adds > 0 && <span className="archon-diff-stat-add">+{adds}</span>}
          {dels > 0 && <span className="archon-diff-stat-del">−{dels}</span>}
        </span>
      </button>
      {!collapsed && (
        <Diff
          viewType={viewType}
          diffType={file.type}
          hunks={file.hunks}
          tokens={tokens}
          className="archon-diff-table"
        >
          {(hunks) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
        </Diff>
      )}
    </div>
  );
}

function renderPathLabel(file: FileData, path: string): string {
  if (file.type === 'rename') return `${file.oldPath} → ${file.newPath}`;
  if (file.type === 'delete') return `${path} (deleted)`;
  if (file.type === 'add') return `${path} (new)`;
  return path;
}

function countChanges(file: FileData): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type === 'insert') adds++;
      else if (change.type === 'delete') dels++;
    }
  }
  return { adds, dels };
}

export function DiffView({
  patch,
  files,
  defaultViewType = 'unified',
  hideToolbar = false,
  emptyText = 'No changes.',
}: DiffViewProps) {
  const [viewType, setViewType] = useState<'unified' | 'split'>(defaultViewType);

  const parsed = useMemo<FileData[]>(() => {
    if (files && files.length) return files;
    if (!patch || !patch.trim()) return [];
    try {
      return parseDiff(patch);
    } catch {
      return [];
    }
  }, [patch, files]);

  if (parsed.length === 0) {
    return <div className="archon-diff-empty display-font">{emptyText}</div>;
  }

  return (
    <div className="archon-diff-view">
      {!hideToolbar && (
        <div className="archon-diff-toolbar display-font">
          <span className="archon-diff-filecount">
            {parsed.length} file{parsed.length === 1 ? '' : 's'} changed
          </span>
          <div className="archon-diff-viewtoggle">
            {(['unified', 'split'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={viewType === v ? 'active' : ''}
                onClick={() => setViewType(v)}
              >
                {v.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="archon-diff-files">
        {parsed.map((file) => (
          <FileDiff
            key={`${file.oldRevision}-${file.newRevision}-${file.newPath || file.oldPath}`}
            file={file}
            viewType={viewType}
          />
        ))}
      </div>
    </div>
  );
}
