import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../stores/appStore';
import { useComputerStore } from '../stores/computerStore';
import { FileViewerModal } from './FileViewerModal';
import { openMediaStudio } from './media/launchers';
import type { JobState } from '../stores/appStore.types';

// Workbench Expansion A5 — Cmd/Ctrl+P command palette.
//
// A single fuzzy palette over four sources:
//   (a) transcript rows of the active workflow (jump-to-row via flashChatMessage)
//   (b) file paths under the active cwd (GET /api/files, lazily browsed)
//   (c) open workflows / tabs (switch tab)
//   (d) commands — the toolbar actions exposed as store setters
// Plus a phase-2 "content search" mode: when the query is prefixed with `>`
// (or the operator hits the CONTENT toggle) it runs GET /api/search/content
// and lists ripgrep hits that click into the FileViewerModal.
//
// Fuzzy matching is hand-rolled (subsequence + contiguity/word-boundary
// bonuses) rather than pulling in fuse.js: the four static sources are small
// (tens to low-hundreds of rows), the matcher is ~30 lines, and avoiding a new
// runtime dep keeps the bundle + lockfile audit surface unchanged. Content
// search is delegated to the server (ripgrep), so the client never needs a
// heavyweight fuzzy index.
//
// Print-shortcut conflict: Cmd/Ctrl+P is the browser Print accelerator. The
// global hotkey handler in App.tsx calls preventDefault() so print never opens;
// this component only renders once the store flag is set.

interface FileEntry { name: string; path: string; isDirectory: boolean; }

type Result =
  | { kind: 'command'; id: string; label: string; hint: string; run: () => void }
  | { kind: 'tab'; id: string; label: string; hint: string; run: () => void }
  | { kind: 'file'; id: string; label: string; hint: string; path: string }
  | { kind: 'transcript'; id: string; label: string; hint: string; jobId: string; messageId: string }
  | { kind: 'content'; id: string; label: string; hint: string; path: string; line: number };

// ── Fuzzy matcher ──
// Returns a score (higher = better) or null for no match. Case-insensitive
// subsequence with bonuses for contiguous runs and word-boundary starts.
function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 1;
      if (ti === lastMatch + 1) score += 3; // contiguous run
      if (ti === 0 || /[\s/_.\-]/.test(t[ti - 1])) score += 2; // word boundary
      lastMatch = ti;
      qi++;
    }
  }
  if (qi < q.length) return null; // not all query chars matched in order
  // Prefer shorter targets when scores are otherwise close.
  return score - target.length * 0.01;
}

const MAX_PER_SOURCE = 30;

interface Props {
  onClose: () => void;
}

export function CommandPalette({ onClose }: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [contentHits, setContentHits] = useState<Result[]>([]);
  const [contentNote, setContentNote] = useState<string | null>(null);
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const jobs = useAppStore((s) => s.jobs);
  const activeJobId = useAppStore((s) => s.activeJobId);
  const setActiveJob = useAppStore((s) => s.setActiveJob);
  const setActiveCluster = useAppStore((s) => s.setActiveCluster);
  const flashChatMessage = useAppStore((s) => s.flashChatMessage);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setShowManual = useAppStore((s) => s.setShowManual);
  const setShowGithub = useAppStore((s) => s.setShowGithub);
  const setShowRecall = useAppStore((s) => s.setShowRecall);
  const focusMode = useAppStore((s) => s.focusMode);
  const setFocusMode = useAppStore((s) => s.setFocusMode);
  const showJobCreator = useAppStore((s) => s.showJobCreator);

  const activeJob: JobState | undefined = activeJobId ? jobs[activeJobId] : undefined;
  const activeCwd = activeJob?.config.workingDirectory;

  // Content-search mode is entered with a leading `>`; everything after the
  // `>` is the ripgrep query. Keeps the palette single-input (no mode button
  // to hunt for) while making the toggle discoverable via the placeholder.
  const contentMode = query.startsWith('>');
  const contentQuery = contentMode ? query.slice(1).trim() : '';

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Lazy file load — only once, when first needed (palette open). Lists the
  // active cwd one level deep; the fuzzy match runs over names so a partial
  // filename surfaces it. Deeper traversal would mean a recursive walk; v1
  // keeps it to the cwd top level + whatever the operator drills via re-query.
  useEffect(() => {
    if (!activeCwd || contentMode) return;
    let cancelled = false;
    fetch(`/api/files?path=${encodeURIComponent(activeCwd)}`)
      .then((r) => r.json())
      .then((data: { files?: FileEntry[] }) => {
        if (!cancelled) setFiles(Array.isArray(data.files) ? data.files : []);
      })
      .catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [activeCwd, contentMode]);

  // Content search — debounced rg call against the active workflow cwd.
  useEffect(() => {
    if (!contentMode || !activeJobId || !contentQuery) {
      setContentHits([]);
      setContentNote(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      const params = new URLSearchParams({ wfid: activeJobId, q: contentQuery });
      fetch(`/api/search/content?${params.toString()}`)
        .then((r) => r.json())
        .then((data: { available?: boolean; capped?: boolean; hits?: Array<{ file: string; line: number; column: number; text: string }> }) => {
          if (cancelled) return;
          if (data.available === false) {
            setContentHits([]);
            setContentNote('ripgrep (rg) is not on PATH — content search unavailable.');
            return;
          }
          const hits = Array.isArray(data.hits) ? data.hits : [];
          setContentNote(
            hits.length === 0
              ? 'No matches.'
              : data.capped ? `Showing first ${hits.length} matches.` : null,
          );
          setContentHits(hits.map((h, i) => ({
            kind: 'content' as const,
            id: `content:${h.file}:${h.line}:${i}`,
            label: `${h.file}:${h.line}`,
            hint: h.text.trim().slice(0, 120),
            path: activeCwd ? `${activeCwd.replace(/\/$/, '')}/${h.file}` : h.file,
            line: h.line,
          })));
        })
        .catch(() => {
          if (!cancelled) { setContentHits([]); setContentNote('Search failed.'); }
        });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [contentMode, contentQuery, activeJobId, activeCwd]);

  // ── Commands (static toolbar actions) ──
  const commands = useMemo<Result[]>(() => [
    { kind: 'command', id: 'cmd:computer', label: 'Open Computer', hint: 'Voice conversation and saved memory', run: () => useComputerStore.getState().setOpen(true) },
    { kind: 'command', id: 'cmd:new-tab', label: 'New workflow / tab', hint: 'Open the creator', run: () => showJobCreator() },
    { kind: 'command', id: 'cmd:recall', label: 'Recall: search conversations', hint: 'Search every past conversation (F3)', run: () => setShowRecall(true) },
    { kind: 'command', id: 'cmd:settings', label: 'Open Settings', hint: 'Providers, themes, transports', run: () => setShowSettings(true) },
    { kind: 'command', id: 'cmd:manual', label: 'Open User Manual', hint: 'In-app docs', run: () => setShowManual(true) },
    { kind: 'command', id: 'cmd:shortcuts', label: 'Keyboard shortcuts', hint: 'Cheat sheet (Ctrl/Cmd+?)', run: () => window.dispatchEvent(new CustomEvent('arco:open-shortcuts')) },
    { kind: 'command', id: 'cmd:focus', label: focusMode ? 'Exit focus mode' : 'Enter focus mode', hint: 'Hide secondary chrome for a full-width chat (I3)', run: () => setFocusMode(!focusMode) },
    { kind: 'command', id: 'cmd:github', label: 'Open GitHub panel', hint: 'PRs, issues', run: () => setShowGithub(true) },
    { kind: 'command', id: 'cmd:media', label: 'Open Media studio', hint: 'Image viewer + audio/video', run: () => openMediaStudio() },
    { kind: 'command', id: 'cmd:media-image', label: 'Open Media studio (image)', hint: 'Zoom/pan/fit image viewer', run: () => openMediaStudio('image') },
    { kind: 'command', id: 'cmd:media-audio', label: 'Open Media studio (audio)', hint: 'Import + play audio', run: () => openMediaStudio('audio') },
    { kind: 'command', id: 'cmd:media-video', label: 'Open Media studio (video)', hint: 'Import + play video', run: () => openMediaStudio('video') },
  ], [showJobCreator, setShowSettings, setShowManual, setShowGithub, setShowRecall, focusMode, setFocusMode]);

  // ── Tabs (open workflows + clusters) ──
  const tabs = useMemo<Result[]>(() => {
    const out: Result[] = [];
    for (const job of Object.values(jobs)) {
      if (job.config.kind === 'cluster' || job.config.voiceOperator) continue; // Computer has its own header surface
      out.push({
        kind: 'tab',
        id: `tab:${job.id}`,
        label: job.config.name || job.id.slice(0, 8),
        hint: `${job.config.primaryProvider ?? 'workflow'} · ${job.id.slice(0, 8)}`,
        run: () => setActiveJob(job.id),
      });
    }
    return out;
  }, [jobs, setActiveJob]);

  // ── Transcript rows (active workflow only) ──
  const transcriptRows = useMemo<Result[]>(() => {
    if (!activeJob) return [];
    const rows: Result[] = [];
    for (const m of activeJob.messages) {
      if (m.toolUse || m.role === 'ctx-divider') continue;
      const text = (m.content || '').trim();
      if (!text) continue;
      rows.push({
        kind: 'transcript',
        id: `tr:${m.id}`,
        label: text.replace(/\s+/g, ' ').slice(0, 80),
        hint: `${m.role} · jump to row`,
        jobId: activeJob.id,
        messageId: m.id,
      });
    }
    return rows;
  }, [activeJob]);

  // ── File rows (active cwd, top level) ──
  const fileRows = useMemo<Result[]>(() => files
    .filter((f) => !f.isDirectory)
    .map((f) => ({
      kind: 'file' as const,
      id: `file:${f.path}`,
      label: f.name,
      hint: 'Open in viewer',
      path: f.path,
    })), [files]);

  // ── Assemble + rank ──
  const results = useMemo<Result[]>(() => {
    if (contentMode) return contentHits;
    const q = query.trim();
    const rank = (rows: Result[]): Array<{ row: Result; score: number }> =>
      rows
        .map((row) => ({ row, score: fuzzyScore(q, `${row.label} ${row.hint}`) }))
        .filter((x): x is { row: Result; score: number } => x.score !== null)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_PER_SOURCE);
    // Order groups so commands/tabs (high-intent) sit above the long
    // transcript/file lists. Within a group, fuzzy score orders.
    return [
      ...rank(commands),
      ...rank(tabs),
      ...rank(transcriptRows),
      ...rank(fileRows),
    ].map((x) => x.row);
  }, [contentMode, contentHits, query, commands, tabs, transcriptRows, fileRows]);

  // Reset selection when the result set changes shape.
  useEffect(() => { setSelected(0); }, [query]);

  // Keep the highlighted row in view as the operator arrows through.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const activate = (row: Result | undefined) => {
    if (!row) return;
    switch (row.kind) {
      case 'command':
      case 'tab':
        row.run();
        onClose();
        break;
      case 'transcript':
        // Ensure the row's workflow is the active tab, then flash+scroll it.
        // flashChatMessage drives ChatPanel's existing scrollToIndex effect.
        setActiveCluster(null);
        setActiveJob(row.jobId);
        flashChatMessage(row.jobId, row.messageId);
        onClose();
        break;
      case 'file':
        setViewerPath(row.path);
        break;
      case 'content':
        // Content hits open the file viewer. Line-anchored scrolling is a
        // future nicety; the viewer renders the whole file today.
        setViewerPath(row.path);
        break;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(0, results.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(results[selected]);
    }
  };

  const groupLabel = (kind: Result['kind']): string => ({
    command: 'COMMANDS', tab: 'TABS', transcript: 'TRANSCRIPT', file: 'FILES', content: 'CONTENT',
  }[kind]);

  return createPortal(
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 9000,
          background: 'rgba(0,0,0,0.45)', display: 'flex',
          alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh',
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 'min(640px, 90vw)', maxHeight: '70vh', display: 'flex', flexDirection: 'column',
            background: 'var(--color-bg-panel)', border: '1px solid var(--color-border-bright)',
            borderRadius: 8, boxShadow: '0 12px 40px rgba(0,0,0,0.5)', overflow: 'hidden',
            fontFamily: 'var(--font-body)',
          }}
        >
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search tabs, files, transcript, commands…  (prefix > for file-content search)"
            style={{
              border: 'none', borderBottom: '1px solid var(--color-border-hairline)',
              background: 'transparent', color: 'var(--color-fg)', fontSize: 15,
              padding: '14px 16px', outline: 'none', fontFamily: 'var(--font-body)',
            }}
          />
          <div ref={listRef} style={{ overflowY: 'auto', padding: '4px 0' }}>
            {contentMode && contentNote && (
              <div style={{ padding: '8px 16px', color: 'var(--color-fg-muted)', fontSize: 12 }}>
                {contentNote}
              </div>
            )}
            {!contentMode && results.length === 0 && (
              <div style={{ padding: '12px 16px', color: 'var(--color-fg-muted)', fontSize: 13 }}>
                No matches.
              </div>
            )}
            {results.map((row, i) => {
              const prev = results[i - 1];
              const showGroup = !prev || prev.kind !== row.kind;
              return (
                <div key={row.id}>
                  {showGroup && (
                    <div style={{
                      padding: '6px 16px 2px', fontSize: 10, letterSpacing: 1,
                      color: 'var(--color-fg-muted)', textTransform: 'uppercase',
                    }}>
                      {groupLabel(row.kind)}
                    </div>
                  )}
                  <div
                    data-idx={i}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => activate(row)}
                    style={{
                      padding: '7px 16px', cursor: 'pointer', display: 'flex',
                      flexDirection: 'column', gap: 2,
                      background: i === selected ? 'var(--color-accent-primary-a10)' : 'transparent',
                      borderLeft: i === selected
                        ? '2px solid var(--color-accent-primary)'
                        : '2px solid transparent',
                    }}
                  >
                    <span style={{
                      color: 'var(--color-fg)', fontSize: 13,
                      fontFamily: row.kind === 'file' || row.kind === 'content' ? 'var(--font-code)' : 'var(--font-body)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {row.label}
                    </span>
                    <span style={{
                      color: 'var(--color-fg-muted)', fontSize: 11,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {row.hint}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{
            padding: '6px 16px', borderTop: '1px solid var(--color-border-hairline)',
            color: 'var(--color-fg-muted)', fontSize: 11, display: 'flex', gap: 16,
          }}>
            <span>↑↓ navigate</span>
            <span>↵ open</span>
            <span>esc close</span>
            <span style={{ marginLeft: 'auto' }}>{results.length} results</span>
          </div>
        </div>
      </div>
      {viewerPath && activeJobId && activeCwd && (
        <FileViewerModal
          path={viewerPath}
          onClose={() => setViewerPath(null)}
          fallback={{ cwd: activeCwd, workflowId: activeJobId }}
        />
      )}
    </>,
    document.body,
  );
}
