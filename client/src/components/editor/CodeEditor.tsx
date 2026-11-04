import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching,
} from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { yaml } from '@codemirror/lang-yaml';
import { rust } from '@codemirror/lang-rust';

// Workbench Expansion A6 — reusable CodeMirror 6 wrapper.
//
// A6 only needs the FileViewerModal editor, but the spec calls out that the
// same editor is wanted by A5 phase-2 (search-result preview) and A3's merge
// view — so this is a standalone component, not inlined into the modal. Keep
// it dumb: a controlled-ish surface that reports edits via onChange and rebuilds
// only on the props that change behavior (language, readOnly), never on every
// keystroke (which would fight CodeMirror's own state).

// CodeMirror language extension by our short lang tag (the same tags
// FileViewerModal already classifies files into). Unknown tags get no
// language extension — plain text editing, still fine.
function langExtension(lang?: string): Extension[] {
  switch (lang) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx':
      return [javascript({ jsx: lang === 'tsx' || lang === 'jsx', typescript: lang === 'typescript' || lang === 'tsx' })];
    case 'json':
      return [json()];
    case 'markdown':
      return [markdown()];
    case 'python':
      return [python()];
    case 'css':
    case 'scss':
    case 'less':
      return [css()];
    case 'xml':
    case 'html':
      return [html()];
    case 'yaml':
      return [yaml()];
    case 'rust':
      return [rust()];
    default:
      return [];
  }
}

// Theme bound to the app's CSS vars so the editor matches surrounding surfaces
// in every theme (matrix / etc.) without hard-coding colors. CodeMirror reads
// these at render time, so a theme swap reflows the editor for free.
const arcoTheme = EditorView.theme({
  '&': {
    color: 'var(--color-fg)',
    backgroundColor: 'var(--color-bg-input, var(--color-bg))',
    fontSize: '12px',
    height: '100%',
  },
  '.cm-content': {
    fontFamily: 'var(--font-code, monospace)',
    caretColor: 'var(--color-accent-primary)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent-primary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--color-accent-primary-a15)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--color-fg-muted)',
    border: 'none',
    borderRight: '1px solid var(--color-border-hairline)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--color-accent-primary-a04)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--color-accent-primary-a06)' },
  '.cm-scroller': { fontFamily: 'var(--font-code, monospace)', lineHeight: '1.6' },
}, { dark: true });

// A7 — the current selection, surfaced so the AI-edit affordance can scope a
// request. `from`/`to` are document offsets; `text` is the sliced selection.
// When `from === to` there is no selection (caret only).
export interface EditorSelection {
  from: number;
  to: number;
  text: string;
}

// A7 — imperative handle: Accept splices the agent's replacement into the
// exact [from,to) range of the BUFFER (not disk). Returns the new doc string so
// the parent can sync its buffer state. Select-All is a convenience for the
// whole-doc edit path.
export interface CodeEditorHandle {
  spliceSelection: (from: number, to: number, replacement: string) => string | null;
  selectAll: () => EditorSelection | null;
  docLength: () => number;
}

interface Props {
  value: string;
  language?: string;
  readOnly: boolean;
  onChange?: (next: string) => void;
  // A7 — fired on any selection change (debounced by CodeMirror's update cycle).
  onSelectionChange?: (sel: EditorSelection) => void;
}

export const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(
  { value, language, readOnly, onChange, onSelectionChange },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep the latest onChange without rebuilding the editor on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  // A7 — imperative buffer ops. Splice mutates ONLY [from,to); the
  // updateListener fires onChange with the new doc so React state stays in sync.
  useImperativeHandle(ref, () => ({
    spliceSelection(from, to, replacement) {
      const view = viewRef.current;
      if (!view) return null;
      const len = view.state.doc.length;
      const f = Math.max(0, Math.min(from, len));
      const t = Math.max(f, Math.min(to, len));
      view.dispatch({ changes: { from: f, to: t, insert: replacement } });
      return view.state.doc.toString();
    },
    selectAll() {
      const view = viewRef.current;
      if (!view) return null;
      const len = view.state.doc.length;
      view.dispatch({ selection: { anchor: 0, head: len } });
      return { from: 0, to: len, text: view.state.doc.toString() };
    },
    docLength() {
      return viewRef.current?.state.doc.length ?? 0;
    },
  }), []);

  // Build (and rebuild) the editor only when behavior-affecting props change.
  // `value` is deliberately NOT in the deps — feeding it back on every keystroke
  // would reset the cursor. We seed the initial doc here and sync external value
  // changes (e.g. a fresh file load) in a separate effect below.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        ...langExtension(language),
        arcoTheme,
        EditorView.lineWrapping,
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          // A7 — report selection on doc/selection change so the affordance can
          // scope a request to exactly what the operator highlighted.
          if (u.docChanged || u.selectionSet) {
            const r = u.state.selection.main;
            onSelectionChangeRef.current?.({ from: r.from, to: r.to, text: u.state.sliceDoc(r.from, r.to) });
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly]);

  // Sync an external value change (file reload / programmatic reset) into the
  // doc only when it genuinely diverges — guards against the keystroke→onChange
  // →parent-state→value round-trip clobbering the cursor mid-edit.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} style={{ height: '100%', overflow: 'auto' }} />;
});
