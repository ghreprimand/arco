import { requestOutputs } from '../utils/outputNavigation';
import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/atom-one-dark.css';
import { useAppStore, type ArtifactItem } from '../stores/appStore';
import { openImageForEdit } from './media/launchers';

interface Props {
  onRespond: (workflowId: string, content: string) => void;
}

// Renders the front of the artifact queue as a centered cyberpunk modal.
// Esc/backdrop/CLOSE dismisses a show-type artifact; ask-types resolve by
// clicking CONFIRM / CANCEL / a choice button, which dispatches a follow-up
// user message (`[artifact:<id>] <answer>`) that the orchestrator picks up
// on its next turn.
export function ArtifactModal({ onRespond }: Props) {
  const queue = useAppStore((s) => s.artifactQueue);
  const dequeue = useAppStore((s) => s.dequeueArtifact);
  const artifact = queue[0];
  // Emitting workflow's cwd — artifact paths are cwd-relative, and the
  // artifact's tab need not be the active one (the queue is global).
  const artifactCwd = useAppStore((s) => (artifact ? s.jobs[artifact.workflowId]?.config.workingDirectory : undefined));

  useEffect(() => {
    if (!artifact) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dequeue(artifact.artifactId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [artifact, dequeue]);

  if (!artifact) return null;

  const dismiss = () => dequeue(artifact.artifactId);
  const respond = (answer: string) => {
    onRespond(artifact.workflowId, `[artifact:${artifact.artifactId}] ${answer}`);
    dequeue(artifact.artifactId);
  };
  // §H4 — dismiss the artifact modal and open its image in the H2 raster editor,
  // pinned to the emitting workflow's cwd so the relative path resolves there.
  const openInEditor = () => {
    if (!artifact.path) return;
    openImageForEdit(artifact.path, artifactCwd ? { cwd: artifactCwd, workflowId: artifact.workflowId } : undefined);
    dequeue(artifact.artifactId);
  };

  const isAsk = artifact.kind === 'confirm' || artifact.kind === 'choice';

  return (
    <div
      onClick={isAsk ? undefined : dismiss}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.82)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        backdropFilter: 'blur(3px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glow-border"
        style={{
          // Frosted token (not a hardcoded opaque rgba) so frosted mode + the
          // CONFIG opacity slider affect this modal like the dropdowns.
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-accent-secondary)',
          borderRadius: '6px',
          width: 'min(820px, calc(92vw / var(--ui-scale, 1)))',
          maxHeight: 'calc(88vh / var(--ui-scale, 1))',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 0 36px var(--color-accent-secondary-a30)',
        }}
      >
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border-hairline)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span className="display-font" style={{ fontSize: '10px', padding: '2px 6px', border: '1px solid var(--color-accent-secondary)', color: 'var(--color-accent-secondary)', letterSpacing: '2px', borderRadius: '2px' }}>
            {artifact.kind.toUpperCase()}
          </span>
          <span className="display-font glow-text" style={{ flex: 1, fontSize: '13px', letterSpacing: '2px', color: 'var(--color-accent-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {artifact.title || 'ARTIFACT'}
          </span>
          <span className="display-font" style={{ fontSize: '9px', color: 'var(--color-fg-muted)', letterSpacing: '1px' }}>
            {artifact.artifactId.slice(0, 8)}
          </span>
          {artifact.kind === 'image' && artifact.openInEditor && artifact.path && (
            <button
              onClick={openInEditor}
              data-help="artifact.open-in-editor"
              title="Open this image in the editor"
              className="display-font"
              style={{ background: 'var(--color-accent-secondary-a10)', border: '1px solid var(--color-accent-secondary)', borderRadius: '3px', color: 'var(--color-accent-secondary)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px', padding: '3px 10px', lineHeight: '16px' }}
            >OPEN IN EDITOR</button>
          )}
          {!isAsk && (artifact.path || artifact.content) && <button type="button" onClick={() => { useAppStore.getState().setActiveJob(artifact.workflowId); requestOutputs(artifact.workflowId); dismiss(); }} style={{ background: 'var(--color-bg-sunken)', color: 'var(--color-accent-primary)', border: '1px solid var(--color-border-hairline)', borderRadius: 3, padding: '3px 8px', cursor: 'pointer' }}>View in Outputs</button>}
          {!isAsk && (
            <button
              onClick={dismiss}
              title="Close (Esc)"
              style={{ background: 'none', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '14px', padding: '0 8px', lineHeight: '22px' }}
            >×</button>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          <ArtifactBody artifact={artifact} />
        </div>

        {isAsk && (
          <div style={{ padding: '10px 14px', borderTop: '1px solid var(--color-border-hairline)', display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            {artifact.kind === 'confirm' && (
              <>
                <button
                  onClick={() => respond('rejected')}
                  className="display-font"
                  style={{ padding: '7px 18px', background: 'transparent', border: '1px solid var(--color-danger)', borderRadius: '3px', color: 'var(--color-danger)', cursor: 'pointer', fontSize: '11px', letterSpacing: '2px' }}
                >
                  ✗ REJECT
                </button>
                <button
                  onClick={() => respond('approved')}
                  className="display-font glow-border"
                  style={{ padding: '7px 18px', background: 'var(--color-accent-primary-a10)', border: '1px solid var(--color-accent-primary)', borderRadius: '3px', color: 'var(--color-accent-primary)', cursor: 'pointer', fontSize: '11px', letterSpacing: '2px' }}
                >
                  ✓ APPROVE
                </button>
              </>
            )}
            {artifact.kind === 'choice' && artifact.choices && (
              artifact.choices.map((choice, i) => (
                <button
                  key={i}
                  onClick={() => respond(choice)}
                  className="display-font"
                  style={{ padding: '7px 16px', background: 'transparent', border: '1px solid var(--color-accent-secondary)', borderRadius: '3px', color: 'var(--color-accent-secondary)', cursor: 'pointer', fontSize: '11px', letterSpacing: '2px' }}
                >
                  → {choice.toUpperCase()}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

type ImagePayload =
  | { type: 'image'; dataUrl: string; size: number }
  | { type: 'text'; content: string; size: number }
  | { type: 'binary'; size: number }
  | { type: 'too-large'; size: number; kind: 'text' | 'image' }
  | { type: 'error'; error: string };

function ArtifactBody({ artifact }: { artifact: ArtifactItem }) {
  const [imagePayload, setImagePayload] = useState<ImagePayload | null>(null);
  // The artifact's path is cwd-RELATIVE (confinement) — resolve it against the
  // emitting workflow's cwd, not the server process cwd (which only matches by
  // coincidence when the tab is rooted at the Arco repo).
  const cwd = useAppStore((s) => s.jobs[artifact.workflowId]?.config.workingDirectory);

  useEffect(() => {
    if (artifact.kind !== 'image' || !artifact.path) return;
    let cancelled = false;
    const params = new URLSearchParams({ path: artifact.path });
    if (cwd) {
      params.set('cwd', cwd);
      params.set('workflowId', artifact.workflowId);
    }
    fetch(`/api/file-content?${params.toString()}`)
      .then((r) => r.json() as Promise<ImagePayload>)
      .then((p) => { if (!cancelled) setImagePayload(p); })
      .catch((e) => { if (!cancelled) setImagePayload({ type: 'error', error: String(e) }); });
    return () => { cancelled = true; };
  }, [artifact, cwd]);

  const codeFenced = useMemo(() => {
    if (artifact.kind !== 'code' && artifact.kind !== 'diff') return null;
    const lang = artifact.kind === 'diff' ? 'diff' : (artifact.language || 'text');
    return '```' + lang + '\n' + (artifact.content ?? '') + '\n```';
  }, [artifact]);

  const box: React.CSSProperties = { padding: '16px', color: 'var(--color-accent-primary)', fontFamily: 'var(--font-body)', fontSize: '13px', lineHeight: 1.55 };

  if (artifact.kind === 'image') {
    if (!imagePayload) return <div style={{ ...box, color: 'var(--color-fg-muted)', textAlign: 'center' }}>Loading image…</div>;
    if (imagePayload.type === 'image') {
      return (
        <div style={{ ...box, display: 'flex', justifyContent: 'center', background: 'rgba(0, 8, 4, 0.6)' }}>
          <img src={imagePayload.dataUrl} alt={artifact.title || 'artifact'} style={{ maxWidth: '100%', maxHeight: 'calc(72vh / var(--ui-scale, 1))', objectFit: 'contain', borderRadius: '3px' }} />
        </div>
      );
    }
    if (imagePayload.type === 'error') {
      return <div style={{ ...box, color: 'var(--color-danger)' }}>Could not load image: {imagePayload.error}</div>;
    }
    return <div style={{ ...box, color: 'var(--color-fg-muted)' }}>File not viewable as image.</div>;
  }

  if (artifact.kind === 'confirm') {
    return (
      <div style={box}>
        {artifact.message ? (
          <div className="arco-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{artifact.message}</ReactMarkdown>
          </div>
        ) : (
          <div style={{ color: 'var(--color-fg-muted)' }}>Awaiting confirmation.</div>
        )}
      </div>
    );
  }

  if (artifact.kind === 'choice') {
    return (
      <div style={box}>
        {artifact.message ? (
          <div className="arco-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{artifact.message}</ReactMarkdown>
          </div>
        ) : (
          <div style={{ color: 'var(--color-fg-muted)' }}>Pick one:</div>
        )}
      </div>
    );
  }

  if (artifact.kind === 'code' || artifact.kind === 'diff') {
    if (!codeFenced) return <div style={box}>(empty)</div>;
    return (
      <div style={box} className="arco-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{codeFenced}</ReactMarkdown>
      </div>
    );
  }

  // text
  return (
    <div style={box} className="arco-markdown">
      {artifact.content ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{artifact.content}</ReactMarkdown>
      ) : (
        <div style={{ color: 'var(--color-fg-muted)' }}>(empty)</div>
      )}
    </div>
  );
}
