import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/atom-one-dark.css';
import { CodeEditor, type CodeEditorHandle, type EditorSelection } from './editor/CodeEditor';
import { AiEditAffordance } from './editor/AiEditAffordance';

type FilePayload =
  | { type: 'text'; content: string; size: number }
  | { type: 'image'; dataUrl: string; size: number }
  | { type: 'binary'; size: number }
  | { type: 'too-large'; size: number; kind: 'text' | 'image' }
  | { type: 'error'; error: string };

interface Props {
  path: string;
  onClose: () => void;
  // When the literal path 404s, the server retries inside the workflow's
  // artifacts dir if these are supplied. Lets chat-text filename clicks
  // (which guess at locations) recover when the agent wrote the file as an
  // artifact rather than into the cwd-relative slot we predicted.
  fallback?: { cwd: string; workflowId: string };
  // A6 — supplied only by callers whose file is known to live under a real
  // workflow cwd (the FILES explorer). Presence enables the Edit/Lock toggle;
  // its cwd is what the server resolves the write against (path-escape guard).
  // Absent ⇒ read-only viewer (chat/history artifacts may sit outside any cwd).
  editContext?: { cwd: string; workflowId?: string };
  // D5 — open scrolled to a specific 1-based line (the Review tab's findings
  // list jumps here). Best-effort: we estimate the offset by line-height
  // against the scroll container rather than instrumenting per-line DOM, which
  // keeps it working across the markdown / code / plain render paths. Absent ⇒
  // open at the top, today's behavior.
  startLine?: number;
}

// Map file extensions to the highlight.js language tag we wrap them with
// when we render as a fenced code block. Anything not in this table falls
// through to plain <pre>.
const CODE_LANGS: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  json: 'json', xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  lua: 'lua', php: 'php', pl: 'perl', r: 'r',
  dockerfile: 'dockerfile', makefile: 'makefile', cmake: 'cmake',
  diff: 'diff', patch: 'diff',
};

type RenderKind = 'markdown' | 'code' | 'plain';

function classifyFile(path: string, content: string): { kind: RenderKind; lang?: string } {
  const name = (path.split('/').pop() || '').toLowerCase();
  if (name === 'dockerfile') return { kind: 'code', lang: 'dockerfile' };
  if (name === 'makefile') return { kind: 'code', lang: 'makefile' };
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return { kind: 'markdown' };
  if (ext in CODE_LANGS) return { kind: 'code', lang: CODE_LANGS[ext] };
  // Look for a shebang — many script files have no extension
  if (content.startsWith('#!')) {
    const line = content.slice(0, 120).split('\n')[0];
    if (/(bash|sh|zsh)/.test(line)) return { kind: 'code', lang: 'bash' };
    if (/python/.test(line)) return { kind: 'code', lang: 'python' };
    if (/node/.test(line)) return { kind: 'code', lang: 'javascript' };
  }
  return { kind: 'plain' };
}

export function FileViewerModal({ path, onClose, fallback, editContext, startLine }: Props) {
  const [payload, setPayload] = useState<FilePayload | null>(null);
  const [rawMode, setRawMode] = useState(false);
  // A6 editing state. `editing` flips the buffer writable + reveals Save;
  // default is Locked (read-only). `buffer` holds the live edit; `loadedText`
  // is the last-saved/loaded baseline so the dirty flag is a simple compare.
  const [editing, setEditing] = useState(false);
  const [buffer, setBuffer] = useState('');
  const [loadedText, setLoadedText] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // A7 — live editor selection + an imperative handle for the AI-edit Accept
  // splice. `wholeDoc` flips when SELECT ALL is used (whole-document edit).
  const editorRef = useRef<CodeEditorHandle | null>(null);
  const [selection, setSelection] = useState<EditorSelection>({ from: 0, to: 0, text: '' });
  const [wholeDoc, setWholeDoc] = useState(false);
  // D5 — the read-only scroll container, used for the startLine jump.
  const scrollBodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ path });
    if (fallback) {
      params.set('cwd', fallback.cwd);
      params.set('workflowId', fallback.workflowId);
    }
    fetch(`/api/file-content?${params.toString()}`)
      .then((r) => r.json() as Promise<FilePayload>)
      .then((p) => {
        if (cancelled) return;
        setPayload(p);
        // Seed the edit baseline from text payloads; reset edit UI on (re)load.
        if (p.type === 'text') { setBuffer(p.content); setLoadedText(p.content); }
        setEditing(false);
        setSaveError(null);
      })
      .catch((e) => { if (!cancelled) setPayload({ type: 'error', error: String(e) }); });
    return () => { cancelled = true; };
  }, [path, fallback?.cwd, fallback?.workflowId]);

  const dirty = editing && buffer !== loadedText;

  // Confirm-on-close-if-dirty so an accidental backdrop/Esc click doesn't
  // silently drop unsaved hand-edits.
  const attemptClose = () => {
    if (dirty && !window.confirm('You have unsaved edits. Discard them and close?')) return;
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') attemptClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // attemptClose closes over `dirty`; re-bind when it changes so the confirm
    // gate reflects current buffer state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, onClose]);

  // D5 — once a text payload has rendered, scroll to the requested line.
  // Estimate the y-offset by line-height: instrumenting per-line DOM would
  // mean owning the highlighter's output across three render paths (markdown /
  // code fence / plain pre), so an estimate keyed off the rendered scroll
  // height is the pragmatic, cross-render choice. rAF lets the markdown/
  // highlight pass paint before we measure. Editing mode owns its own scroll
  // (CodeMirror), so we skip the jump there.
  useEffect(() => {
    if (!startLine || startLine < 1 || editing) return;
    if (payload?.type !== 'text') return;
    const el = scrollBodyRef.current;
    if (!el) return;
    const lineCount = Math.max(1, payload.content.split('\n').length);
    const raf = requestAnimationFrame(() => {
      const target = el.scrollHeight * ((startLine - 1) / lineCount);
      // Bias up by ~a third of the viewport so the target line sits near the
      // top third rather than flush against the very top edge.
      el.scrollTop = Math.max(0, target - el.clientHeight / 3);
    });
    return () => cancelAnimationFrame(raf);
  }, [startLine, payload, editing]);

  const filename = path.split('/').pop() || path;

  const canEdit = !!editContext && payload?.type === 'text';

  const handleSave = async () => {
    if (!editContext) return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await fetch('/api/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: editContext.cwd,
          ...(editContext.workflowId ? { wfid: editContext.workflowId } : {}),
          path,
          content: buffer,
        }),
      });
      const body = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !body.ok) {
        setSaveError(body.error || `save failed (${r.status})`);
        return;
      }
      // Success: new baseline, flip back to Locked, keep the buffer shown.
      setLoadedText(buffer);
      setPayload((p) => (p && p.type === 'text' ? { ...p, content: buffer, size: new Blob([buffer]).size } : p));
      setEditing(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Portal to document.body so `position: fixed` escapes any transformed
  // ancestor. Chat rows live inside the virtualizer's `transform: translateY`
  // container, which otherwise becomes the containing block for fixed
  // descendants — clipping the modal into the row's local coord space.
  const body = typeof document !== 'undefined' ? document.body : null;
  if (!body) return null;

  const classification = useMemo(() => {
    if (payload?.type !== 'text') return null;
    const c = classifyFile(path, payload.content);
    // JSON: pretty-print for readability before syntax highlighting
    if (c.kind === 'code' && c.lang === 'json') {
      try {
        const pretty = JSON.stringify(JSON.parse(payload.content), null, 2);
        return { ...c, prettyContent: pretty };
      } catch { /* not valid JSON — highlight raw */ }
    }
    return c;
  }, [payload, path]);

  const canFormat = classification && classification.kind !== 'plain';

  return createPortal(
    <div
      onClick={attemptClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '40px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glow-border"
        style={{
          width: '100%',
          maxWidth: '1100px',
          maxHeight: '100%',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border-bright)',
          borderRadius: '6px',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--color-border-hairline)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            flexShrink: 0,
          }}
        >
          <div style={{ overflow: 'hidden' }}>
            <div
              className="display-font glow-text-cyan"
              style={{ fontSize: '12px', letterSpacing: '1px' }}
            >
              {filename}
            </div>
            <div
              style={{
                fontSize: '10px',
                color: 'var(--color-fg-muted)',
                marginTop: '2px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={path}
            >
              {path}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '6px', flexShrink: 0, alignItems: 'center' }}>
            {dirty && (
              <span
                title="Unsaved edits"
                style={{ color: 'var(--color-warning)', fontSize: '10px', letterSpacing: '0.5px' }}
                className="display-font"
              >
                ● UNSAVED
              </span>
            )}
            {canEdit && (
              <button
                onClick={() => {
                  // Flipping back to Lock with unsaved edits: confirm discard,
                  // then restore the loaded baseline so the buffer matches disk.
                  if (editing) {
                    if (dirty && !window.confirm('Discard unsaved edits?')) return;
                    setBuffer(loadedText);
                    setEditing(false);
                  } else {
                    setRawMode(false); // editing always uses the code surface
                    setEditing(true);
                  }
                  setSaveError(null);
                }}
                data-help="fileviewer.toggle-edit"
                className="display-font"
                title={editing ? 'Lock the file (read-only)' : 'Edit this file'}
                style={{
                  background: editing ? 'var(--color-accent-primary-a10)' : 'transparent',
                  border: '1px solid var(--color-border-hairline)',
                  borderRadius: '3px',
                  color: 'var(--color-accent-primary-dim)',
                  cursor: 'pointer',
                  fontSize: '10px',
                  padding: '4px 10px',
                  letterSpacing: '1px',
                }}
              >
                {editing ? 'LOCK' : 'EDIT'}
              </button>
            )}
            {editing && (
              <button
                onClick={handleSave}
                disabled={saving || !dirty}
                className="display-font"
                title={dirty ? 'Save changes to disk' : 'No changes to save'}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--color-border-hairline)',
                  borderRadius: '3px',
                  color: dirty ? 'var(--color-success)' : 'var(--color-fg-muted)',
                  cursor: saving || !dirty ? 'default' : 'pointer',
                  fontSize: '10px',
                  padding: '4px 10px',
                  letterSpacing: '1px',
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? 'SAVING…' : 'SAVE'}
              </button>
            )}
            {editing && editContext?.workflowId && (
              <button
                onClick={() => { const sel = editorRef.current?.selectAll(); if (sel) { setSelection(sel); setWholeDoc(true); } }}
                data-help="aiedit.selectall"
                className="display-font"
                title="Select the whole document for a whole-doc AI edit"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--color-border-hairline)',
                  borderRadius: '3px',
                  color: 'var(--color-accent-primary-dim)',
                  cursor: 'pointer',
                  fontSize: '10px',
                  padding: '4px 10px',
                  letterSpacing: '1px',
                }}
              >
                SELECT ALL
              </button>
            )}
            {canFormat && !editing && (
              <button
                onClick={() => setRawMode(!rawMode)}
                data-help="fileviewer.toggle-raw"
                className="display-font"
                title={rawMode ? 'Switch to formatted view' : 'Switch to raw view'}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--color-border-hairline)',
                  borderRadius: '3px',
                  color: 'var(--color-accent-primary-dim)',
                  cursor: 'pointer',
                  fontSize: '10px',
                  padding: '4px 10px',
                  letterSpacing: '1px',
                }}
              >
                {rawMode ? 'FORMATTED' : 'RAW'}
              </button>
            )}
            <button
              onClick={attemptClose}
              className="display-font"
              style={{
                background: 'transparent',
                border: '1px solid var(--color-border-hairline)',
                borderRadius: '3px',
                color: 'var(--color-accent-primary-dim)',
                cursor: 'pointer',
                fontSize: '14px',
                width: '26px',
                height: '26px',
              }}
            >
              ×
            </button>
          </div>
        </div>

        {saveError && (
          <div
            style={{
              padding: '6px 16px',
              borderBottom: '1px solid var(--color-border-hairline)',
              fontSize: '11px',
              color: 'var(--color-danger)',
              flexShrink: 0,
            }}
          >
            Save failed: {saveError}
          </div>
        )}

        {/* Editing surface: CodeMirror takes over the whole body. No inner
            padding so the gutter sits flush; the editor scrolls itself. */}
        {editing && payload?.type === 'text' ? (
          <div className="arco-file-body" style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
            <CodeEditor
              ref={editorRef}
              value={buffer}
              language={classification?.kind === 'code' ? classification.lang : classification?.kind === 'markdown' ? 'markdown' : undefined}
              readOnly={false}
              onChange={setBuffer}
              onSelectionChange={(sel) => { setSelection(sel); if (wholeDoc && (sel.from !== 0 || sel.to !== buffer.length)) setWholeDoc(false); }}
            />
            {/* A7 — AI-edit affordance overlay. In-tab only: needs a real
                workflow so the proposal round-trips to THIS buffer. */}
            {editContext?.workflowId && (
              <AiEditAffordance
                workflowId={editContext.workflowId}
                filePath={path}
                buffer={buffer}
                selectionFrom={selection.from}
                selectionTo={selection.to}
                wholeDoc={wholeDoc}
                onAccept={(from, to, replacement) => {
                  const next = editorRef.current?.spliceSelection(from, to, replacement);
                  if (next != null) setBuffer(next);
                  setWholeDoc(false);
                }}
              />
            )}
          </div>
        ) : (
        <div ref={scrollBodyRef} className="arco-file-body" style={{ flex: 1, overflow: 'auto', padding: '14px 18px' }}>
          {payload === null && (
            <div style={{ color: 'var(--color-fg-muted)', fontSize: '12px', fontStyle: 'italic' }}>
              Loading…
            </div>
          )}

          {payload?.type === 'text' && (
            rawMode || !classification || classification.kind === 'plain' ? (
              <pre
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '12px',
                  lineHeight: '1.6',
                  color: 'var(--color-accent-primary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  margin: 0,
                }}
              >
                {payload.content}
              </pre>
            ) : classification.kind === 'markdown' ? (
              <div className="arco-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {payload.content}
                </ReactMarkdown>
              </div>
            ) : (
              // Code files: wrap in a fenced block so react-markdown +
              // rehype-highlight does all the work with the same styles as
              // fenced blocks inside markdown.
              <div className="arco-markdown">
                <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
                  {'```' + (classification.lang ?? '') + '\n' + ('prettyContent' in classification && classification.prettyContent ? classification.prettyContent : payload.content) + '\n```'}
                </ReactMarkdown>
              </div>
            )
          )}

          {payload?.type === 'image' && (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <img
                src={payload.dataUrl}
                alt={filename}
                style={{ maxWidth: '100%', maxHeight: 'calc(70vh / var(--ui-scale, 1))', imageRendering: 'auto' }}
              />
            </div>
          )}

          {payload?.type === 'binary' && (
            <div style={infoStyle}>
              Binary file ({formatSize(payload.size)}) — no preview available.
            </div>
          )}

          {payload?.type === 'too-large' && (
            <div style={infoStyle}>
              {payload.kind === 'image' ? 'Image' : 'Text'} too large to preview ({formatSize(payload.size)}).
            </div>
          )}

          {payload?.type === 'error' && (
            <div style={{ ...infoStyle, color: 'var(--color-danger)' }}>
              Error: {payload.error}
            </div>
          )}
        </div>
        )}

        {payload && 'size' in payload && (
          <div
            className="display-font"
            style={{
              padding: '6px 16px',
              borderTop: '1px solid var(--color-border-hairline)',
              fontSize: '10px',
              color: 'var(--color-fg-muted)',
              letterSpacing: '1px',
              flexShrink: 0,
            }}
          >
            {formatSize(payload.size)}
          </div>
        )}
      </div>
    </div>,
    body,
  );
}

const infoStyle: React.CSSProperties = {
  color: 'var(--color-fg-muted)',
  fontSize: '12px',
  fontStyle: 'italic',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
