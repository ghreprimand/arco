import { OperatorQuestionNotice } from './OperatorQuestionNotice';
import { memo, useMemo, useRef, useState } from 'react';
import { useAppStore, type ClusterMemberLabel } from '../stores/appStore';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ChatMessage as ChatMessageType } from '@arco/shared';
import { cleanPrimaryText } from '../utils/chatText';
import { ArtifactPill } from './ArtifactPill';
import { AuthReloginNotice, parseAuthNotice } from './AuthReloginNotice';
import { AskUserQuestionNotice, parseAskNotice } from './AskUserQuestionNotice';
import { ToolCallPill } from './ToolCallPill';
import { TaskCard } from './TaskCard';
import { GateApprovalNotice } from './GateApprovalNotice';
import { HandoffSeedPill, isHandoffSeed } from './HandoffSeedPill';
import { SpawnSeedPill, isSpawnSeed } from './SpawnSeedPill';
import { LongUserMessage } from './LongUserMessage';
import { AttachmentPill } from './AttachmentPill';
import { FileViewerModal } from './FileViewerModal';
import { linkifyText } from '../utils/linkify';
import { useOperatorLabel } from '../utils/operatorLabel';
import { useTerminalStore } from '../stores/terminalStore';
import { detectCommand } from './Terminal/detectCommand';

// Thresholds above which an operator message auto-collapses into a pill.
// Either dimension triggers — a single 2000-char paragraph is as intrusive
// inline as a 30-line multi-paragraph paste. Numbers are deliberately
// generous: a normal back-and-forth prompt (a sentence or two) stays
// rendered inline; only a genuine wall-of-text collapses.
const LONG_MESSAGE_CHAR_THRESHOLD = 800;
const LONG_MESSAGE_LINE_THRESHOLD = 12;
// Worker-written reports are surfaced as [artifact:<name>] markers in the
// orchestrator's chat text. Render each as an inline-expand pill that fetches
// the file on demand from `<cwd>/.arco/workflows/<wfid>/artifacts/<name>`.
// Filename grammar is intentionally permissive (anything up to a `]`, no
// whitespace) so the client renders the pill even for unexpected names — the
// server endpoint does the strict sanitizing and returns 404 on bad refs.
const ARTIFACT_RE = /\[artifact:([^\]\s]+)\]/g;

type ContentPart =
  | { kind: 'text'; value: string }
  | { kind: 'artifact'; name: string };

function splitArtifactRefs(text: string): ContentPart[] {
  const parts: ContentPart[] = [];
  let lastIdx = 0;
  for (const m of text.matchAll(ARTIFACT_RE)) {
    const idx = m.index ?? 0;
    if (idx > lastIdx) parts.push({ kind: 'text', value: text.slice(lastIdx, idx) });
    parts.push({ kind: 'artifact', name: m[1] });
    lastIdx = idx + m[0].length;
  }
  if (lastIdx < text.length) parts.push({ kind: 'text', value: text.slice(lastIdx) });
  return parts.length > 0 ? parts : [{ kind: 'text', value: text }];
}

// System rows that point at a written artifact get rendered with the artifact
// name as a clickable span so the operator can open it in FileViewerModal
// without having to swap to the REVIEW / HANDOFFS tab. Two shapes today:
//   [REVIEW <verdict>] <artifactName>            → artifacts/<name>
//   [HANDOFF SAVED] <artifactName>               → handoffs/<name>
// The "Failed —" / "Running review …" / "Session rotated" rows don't carry an
// artifact name and stay non-clickable.
const REVIEW_ARTIFACT_RE = /^\[REVIEW\s+([A-Z]+)\]\s+(\S+\.md)\s*$/;
const HANDOFF_ARTIFACT_RE = /^\[HANDOFF\s+SAVED\]\s+(\S+\.md)\s*$/;

function parseArtifactSystemRow(content: string):
  | { kind: 'review' | 'handoff'; prefix: string; artifactName: string }
  | null {
  const review = REVIEW_ARTIFACT_RE.exec(content);
  if (review) return { kind: 'review', prefix: `[REVIEW ${review[1]}] `, artifactName: review[2] };
  const handoff = HANDOFF_ARTIFACT_RE.exec(content);
  if (handoff) return { kind: 'handoff', prefix: '[HANDOFF SAVED] ', artifactName: handoff[1] };
  return null;
}

// Heuristic for "this string is a filename": ends in a 1–8-char alpha-leading
// extension, allowed body chars are word/dot/slash/dash. URLs are rejected by
// resolveChatFilePath before we get here. False positives are tolerable —
// clicking a non-file just opens FileViewerModal which renders a clean error.
const FILENAME_RE = /^[\w./_-]+\.[A-Za-z][A-Za-z0-9]{0,7}$/;

function looksLikeFilename(s: string | undefined | null): boolean {
  if (!s) return false;
  const trimmed = s.trim();
  if (trimmed.length < 3 || trimmed.length > 200) return false;
  return FILENAME_RE.test(trimmed);
}

// System rows normally stay plain text, but agent/session summaries can carry
// markdown inline-code file references (for example `00-report.md`). Render
// just those markdown-shaped system rows through the file-link pipeline.
const MARKDOWN_FILE_REF_RE =
  /`[\w./_-]+\.[A-Za-z][A-Za-z0-9]{0,7}`|\[[^\]]+\]\((?!https?:|mailto:|#)[^)]+\.[A-Za-z][A-Za-z0-9]{0,7}[^)]*\)/i;

function hasMarkdownFileRef(text: string): boolean {
  return MARKDOWN_FILE_REF_RE.test(text);
}

// Index of files the agent has touched via Read/Write/Edit tool calls in the
// current workflow. Built upstream from displayMessages (see ChatPanel).
// `byBasename` keys on the bare filename (`audit.md`); `byTail` keys on
// trailing-N-segments (`reports/audit.md`) so partial paths resolve too.
export interface WrittenFilesIndex {
  byBasename: Map<string, string>;
  byTail: Map<string, string>;
}

// Resolve a path string from chat markdown to an absolute filesystem path
// the /api/file-content endpoint can serve. Resolution order:
//   1. Index of files the agent actually touched (most reliable).
//   2. Absolute path as-is.
//   3. cwd-relative join (last-resort heuristic — may 404 if the agent put
//      the file somewhere else; the server-side fallback in /api/file-content
//      then tries the workflow's artifacts dir before giving up).
// Returns null for things we can't or shouldn't open (URLs, anchors, ~/…).
function resolveChatFilePath(
  raw: string,
  cwd: string | undefined,
  index?: WrittenFilesIndex,
): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null; // http://, file://, etc.
  if (t.startsWith('#') || t.startsWith('mailto:')) return null;
  if (t.startsWith('~/')) return null;

  if (index) {
    const stripped = t.startsWith('./') ? t.slice(2) : t;
    const tailHit = index.byTail.get(stripped);
    if (tailHit) return tailHit;
    const base = stripped.split('/').pop() || '';
    const baseHit = index.byBasename.get(base);
    if (baseHit) return baseHit;
  }

  if (t.startsWith('/')) return t;
  if (!cwd) return null;
  const rel = t.startsWith('./') ? t.slice(2) : t;
  return `${cwd.replace(/\/$/, '')}/${rel}`;
}

// Extract pure text from a ReactMarkdown children prop. Markdown headings /
// inline-code may pass children as a string, an array of strings, or wrapped
// elements (when the heading itself contains nested formatting). We only
// treat the heading as a filename when ALL its text is one filename — nested
// elements collapse to the same string here.
function nodeToText(children: unknown): string {
  if (children == null) return '';
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(nodeToText).join('');
  if (typeof children === 'object' && 'props' in (children as Record<string, unknown>)) {
    const props = (children as { props?: { children?: unknown } }).props;
    return nodeToText(props?.children);
  }
  return '';
}

// Pull the `language-xxx` className off the <code> child a markdown `pre`
// wraps, so the §K3 detector can classify the fenced block. ReactMarkdown
// always nests exactly one <code> inside <pre> for a fenced block.
function codeChildClassName(children: unknown): string | undefined {
  const kids = Array.isArray(children) ? children : [children];
  for (const k of kids) {
    if (k && typeof k === 'object' && 'props' in (k as Record<string, unknown>)) {
      const cn = (k as { props?: { className?: unknown } }).props?.className;
      if (typeof cn === 'string') return cn;
    }
  }
  return undefined;
}

function CopyablePre({
  children,
  workflowId,
  ...props
}: React.HTMLAttributes<HTMLPreElement> & { children?: React.ReactNode; workflowId?: string }) {
  const [copied, setCopied] = useState(false);
  const text = nodeToText(children).replace(/\n$/, '');
  const prefillInTerminal = useTerminalStore((s) => s.prefillInTerminal);

  // §K3 "Run in terminal" — offer the chip only on shell-ish fenced blocks
  // (bash/sh/shell/console/zsh). The chip PRE-FILLS the command on the PTY
  // input line; it NEVER runs it (no newline) — the operator hits Enter.
  const detected = detectCommand(codeChildClassName(children), nodeToText(children));
  const canRunInTerminal = detected.isShell && !!workflowId;

  const copy = () => {
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    };
    const legacyCopy = () => {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        done();
      } finally {
        document.body.removeChild(textarea);
      }
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(legacyCopy);
      return;
    }
    legacyCopy();
  };

  return (
    <div
      style={{
        position: 'relative',
        margin: '0.6em 0',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '6px',
          right: '6px',
          zIndex: 1,
          display: 'flex',
          gap: '4px',
        }}
      >
        {canRunInTerminal && (
          <button
            type="button"
            onClick={() => prefillInTerminal(workflowId!, detected.command)}
            className="display-font"
            data-help="chat.run-in-terminal"
            title="Open the terminal and pre-fill this command (it does NOT run — review, then press Enter)"
            style={{
              padding: '2px 7px',
              border: '1px solid var(--color-accent-primary-dim)',
              borderRadius: '3px',
              background: 'var(--color-bg-panel)',
              color: 'var(--color-accent-primary)',
              cursor: 'pointer',
              fontSize: '9px',
              letterSpacing: '1px',
            }}
          >
            ▶ RUN IN TERMINAL
          </button>
        )}
        <button
          type="button"
          onClick={copy}
          className="display-font"
          title="Copy code block"
          style={{
            padding: '2px 7px',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            background: copied ? 'var(--color-accent-primary-a20)' : 'var(--color-bg-panel)',
            color: copied ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
            cursor: 'pointer',
            fontSize: '9px',
            letterSpacing: '1px',
          }}
        >
          {copied ? 'COPIED' : 'COPY'}
        </button>
      </div>
      <pre
        {...props}
        style={{
          ...(props.style ?? {}),
          margin: 0,
          paddingTop: '30px',
        }}
      >
        {children}
      </pre>
    </div>
  );
}

interface Props {
  message: ChatMessageType;
  jobId?: string;
  jobCwd?: string;
  // Built once per workflow in ChatPanel from every Read/Write/Edit tool call.
  // Powers chat-text filename clicks: when an agent writes a Write to
  // `<cwd>/reports/audit.md` and then says "I wrote `audit.md`", the resolver
  // finds the actual path instead of guessing `<cwd>/audit.md`.
  writtenFiles?: WrittenFilesIndex;
  onCancelQueued?: (clientMessageId: string) => void;
  // §10.7 follow-up — when this chat belongs to a cluster member whose board is
  // attached, ChatPanel supplies a promote-to-task callback so an incoming peer
  // message in the transcript can become a durable board task (parallels the
  // MAILBOX modal's → TASK button, which only covers the undelivered window).
  onMakeTask?: (content: string, fromWorkflowId: string) => void;
  presentation?: 'workbench' | 'chat';
  // Chat-presentation row actions. Both callbacks must be referentially
  // stable (see the memo note at the bottom of this file). `retryText` is the
  // operator message that produced this answer — set only on the row the
  // panel considers retryable, so RETRY appears once, at the bottom.
  retryText?: string;
  // The retried message's attachments — same array identity as the source
  // message, so memo stays intact. RETRY used to resend text only.
  retryAttachments?: string[];
  onEditMessage?: (text: string, attachments?: string[]) => void;
  onRetryMessage?: (text: string, attachments?: string[]) => void;
}

function ChatMessageInner({ message, jobId, jobCwd, writtenFiles, onCancelQueued, onMakeTask, presentation = 'workbench', retryText, retryAttachments, onEditMessage, onRetryMessage }: Props) {
  // Tool-use pills from the Claude session JSONL render as a compact row
  // rather than a chat bubble. Bypass the whole bubble pipeline — we don't
  // want the role label, the border-left, or markdown parsing applied.
  if (message.toolUse) {
    // Phase 7b — Task spawns its own child workflow; render as an
    // expandable status card with promote/cancel controls instead of the
    // generic tool-call pill. Falls back to the pill if the parent jobId
    // didn't get threaded through (defensive — every chat path passes it).
    if (message.toolUse.tool === 'Task' && jobId) {
      const desc = (message.toolUse.input && typeof message.toolUse.input === 'object')
        ? ((message.toolUse.input as Record<string, unknown>).description as string | undefined)
        : undefined;
      return (
        <TaskCard
          parentJobId={jobId}
          toolUseId={message.toolUse.toolUseId}
          fallbackDescription={desc}
        />
      );
    }
    // DEBAG (docs/PROVIDERS.md) - a parked review gate renders as an inline
    // approve/edit/reject card driven by the structured proposal in
    // toolUse.input. Falls back to the generic pill if jobId wasn't threaded.
    if (message.toolUse.tool === 'Gate' && jobId) {
      return <GateApprovalNotice workflowId={jobId} input={message.toolUse.input as Record<string, unknown>} />;
    }
    return (
      <ToolCallPillWithFilter
        jobId={jobId}
        toolUseId={message.toolUse.toolUseId}
        tool={message.toolUse.tool}
        input={message.toolUse.input}
        filePath={message.toolUse.filePath}
      />
    );
  }

  // docs/PROTOCOL_CLUSTER.md - peer-message rows. Synthetic ChatMessage
  // entries with role 'peer-sent' / 'peer-received', injected by
  // useWebSocket.onmessage when peer_message_sent / peer_message_received
  // events arrive. Render as a colored block keyed by sender workflowId so
  // the same sender renders the same color across a session. Distinct
  // visual variant; deliberately not collapsed into the existing tool-call
  // pill rendering (per Phase 2 brief).
  if (message.role === 'peer-sent' || message.role === 'peer-received') {
    return <PeerMessageBlock message={message} onMakeTask={onMakeTask} />;
  }

  // docs/PROVIDERS.md - ctx_action ledger divider. Synthetic
  // entry pushed by useWebSocket's ctx_action handler. The label encodes
  // `<action> (<trigger>)[ · <detail>]`; renderer formats as a horizontal-
  // rule sandwich so transcript review sees when context was reshaped.
  if (message.role === 'ctx-divider') {
    return (
      <div
        className="display-font"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          margin: '8px 0',
          fontSize: '11px',
          opacity: 0.55,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}
      >
        <hr style={{ flex: 1, border: 0, borderTop: '1px dashed currentColor', opacity: 0.4 }} />
        <span>── context · {message.content} ──</span>
        <hr style={{ flex: 1, border: 0, borderTop: '1px dashed currentColor', opacity: 0.4 }} />
      </div>
    );
  }

  // Handoff + Spawn pre-warm seeds are 300+ line user bubbles the operator
  // never needs to read inline. Collapse to a pill; expand on demand. Detection
  // differs: handoff has a stable `[HANDOFF — ...]` prefix; spawn has a stable
  // `\n\n---\n\n(New direction|Acknowledge with "READY")` suffix.
  if (message.role === 'user' && isHandoffSeed(message.content)) {
    return <HandoffSeedPill content={message.content} />;
  }
  if (message.role === 'user' && isSpawnSeed(message.content)) {
    return <SpawnSeedPill content={message.content} />;
  }

  // Long operator pastes auto-collapse into an expandable pill so a single
  // wall of text doesn't fill the whole chat pane. Content is sent verbatim
  // to the agent regardless of how we render it here.
  if (
    message.role === 'user' &&
    (message.content.length > LONG_MESSAGE_CHAR_THRESHOLD ||
      message.content.split('\n').length > LONG_MESSAGE_LINE_THRESHOLD)
  ) {
    return <LongUserMessage message={message} onCancelQueued={onCancelQueued} />;
  }

  // Auth-expired notices (server-side from Claude 401s, client-side from the
  // TUI-only slash-command guard) render as an inline row with a RE-LOGIN
  // button that POSTs /api/auth-login?provider=<name>, instead of the plain
  // italic system line.
  if (message.role === 'system') {
    if (message.operatorQuestion && jobId) return <OperatorQuestionNotice workflowId={jobId} question={message.operatorQuestion} error={message.operatorQuestionError} />;
    const authNotice = parseAuthNotice(message.content);
    if (authNotice) {
      return <AuthReloginNotice provider={authNotice.provider} body={authNotice.body} />;
    }
    const askNotice = parseAskNotice(message.content);
    if (askNotice && jobId) {
      return (
        <AskUserQuestionNotice
          workflowId={jobId}
          questionId={askNotice.questionId}
          question={askNotice.question}
          options={askNotice.options}
          answered={askNotice.answered}
          messageId={message.id}
          content={message.content}
        />
      );
    }
  }

  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const phase = message.phase;
  const isAssistant = message.role === 'assistant';

  // Strip orchestrator-internal JSON blocks (worker specs, state mutations,
  // QC verdicts, arco-artifact) from the rendered chat — the task body
  // already lives on the worker card / detail modal, the JSON is just for the
  // server's parsers. Source text stays untouched (orchestrator's --resume
  // context still sees the original).
  const cleaned = useMemo(() => {
    if (!isAssistant) return null;
    return cleanPrimaryText(message.content);
  }, [isAssistant, message.content]);
  const displayContent = cleaned ? cleaned.text : message.content;
  const renderSystemMarkdown = isSystem && hasMarkdownFileRef(displayContent);

  // Filename auto-link: any markdown heading / inline `code` / `[link]` / image
  // whose text resolves to a file under the workflow CWD opens FileViewerModal.
  // State + modal live at message scope so each bubble owns its own viewer.
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  // Shared mousedown coords for all FileLink spans in this bubble. A useRef
  // (not a closure variable inside FileLink) so the value survives any render
  // that lands between mousedown and mouseup.
  const fileLinkDownRef = useRef<{ x: number; y: number } | null>(null);
  const markdownComponents = useMemo<Components>(() => {
    const FileLink = ({ filePath, children }: { filePath: string; children: React.ReactNode }) => {
      // Plain inline span — no role="button"/tabIndex. Browsers treat
      // role="button" elements as interactive widgets and exclude them when
      // building a text selection across mixed inline content, which made
      // file-link pills the only thing in the chat that wouldn't highlight
      // during a drag-select. This span behaves like any other inline text;
      // we detect click vs drag via mousedown/mouseup coordinate delta, not
      // via accessibility roles. (Lost keyboard activation of the modal —
      // worth it; the modal is reachable other ways and the loss is small.)
      const open = () => setViewerPath(filePath);
      const handleMouseDown = (e: React.MouseEvent<HTMLSpanElement>) => {
        fileLinkDownRef.current = { x: e.clientX, y: e.clientY };
      };
      const handleMouseUp = (e: React.MouseEvent<HTMLSpanElement>) => {
        const start = fileLinkDownRef.current;
        fileLinkDownRef.current = null;
        if (!start || e.button !== 0) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        // Any motion over 4px is a drag-select; leave the selection alone.
        if (dx * dx + dy * dy > 16) return;
        open();
      };
      return (
        <span
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          title={filePath}
          style={{
            cursor: 'pointer',
            textDecoration: 'underline dotted',
            textUnderlineOffset: '2px',
          }}
        >
          {children}
        </span>
      );
    };
    const headingWithFilename =
      (Tag: 'h1' | 'h2' | 'h3'): Components[typeof Tag] =>
      ({ node: _node, children, ...props }) => {
        const text = nodeToText(children);
        const resolved = looksLikeFilename(text) ? resolveChatFilePath(text, jobCwd, writtenFiles) : null;
        return (
          <Tag {...props}>
            {resolved ? <FileLink filePath={resolved}>{children}</FileLink> : children}
          </Tag>
        );
      };
    return {
      pre: ({ node: _node, children, ...props }) => (
        <CopyablePre {...props} workflowId={jobId}>{children}</CopyablePre>
      ),
      a: ({ node: _node, href, children, ...props }) => {
        const resolved = href ? resolveChatFilePath(href, jobCwd, writtenFiles) : null;
        if (resolved) return <FileLink filePath={resolved}>{children}</FileLink>;
        return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      },
      h1: headingWithFilename('h1'),
      h2: headingWithFilename('h2'),
      h3: headingWithFilename('h3'),
      code: ({ node: _node, className, children, ...props }) => {
        // Fenced/block code carries language-xxx — leave it for rehype-highlight.
        if (className && className.includes('language-')) {
          return <code className={className} {...props}>{children}</code>;
        }
        const text = nodeToText(children);
        const resolved = looksLikeFilename(text) ? resolveChatFilePath(text, jobCwd, writtenFiles) : null;
        if (resolved) {
          return <code {...props}><FileLink filePath={resolved}>{children}</FileLink></code>;
        }
        return <code {...props}>{children}</code>;
      },
      img: ({ node: _node, src, alt, ...props }) => {
        const resolved = typeof src === 'string' ? resolveChatFilePath(src, jobCwd, writtenFiles) : null;
        if (resolved) {
          return (
            <button
              type="button"
              onClick={() => setViewerPath(resolved)}
              title={resolved}
              style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
            >
              <img {...props} src={src} alt={alt} style={{ maxWidth: '100%' }} />
            </button>
          );
        }
        return <img {...props} src={src} alt={alt} />;
      },
    };
  }, [jobCwd, writtenFiles, jobId]);

  const operatorLabel = useOperatorLabel();
  const chatPresentation = presentation === 'chat';
  const roleLabel = isUser
    ? chatPresentation ? 'YOU' : `> ${operatorLabel}`
    : isSystem
      ? '[SYSTEM]'
      : phase === 'passthrough'
        ? chatPresentation ? 'ARCO' : '< ARCO :: PASSTHROUGH'
        : chatPresentation ? 'ARCO' : '< ARCO';

  const roleClass = isUser ? 'glow-text-cyan' : isSystem ? '' : 'glow-text';

  return (
    <div
      data-help={
        isUser ? 'chat.message.user'
        : isSystem ? 'chat.message.system'
        : 'chat.message.agent'
      }
      style={{
        animation: 'fade-in-up 0.3s ease-out',
        marginBottom: '16px',
        maxWidth: '100%',
        display: chatPresentation ? 'flex' : undefined,
        flexDirection: chatPresentation ? 'column' : undefined,
        alignItems: chatPresentation ? (isUser ? 'flex-end' : isSystem ? 'center' : 'stretch') : undefined,
      }}
    >
      {/* Role label */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '4px',
          fontSize: '11px',
          fontFamily: 'var(--font-display)',
          letterSpacing: '1px',
        }}
      >
        <span className={roleClass} style={isSystem ? { color: 'var(--color-fg-muted)' } : undefined}>
          {roleLabel}
        </span>
        {message.timestamp ? (
          <span
            className="display-font"
            title={new Date(message.timestamp).toLocaleString()}
            style={{
              fontSize: '10px',
              letterSpacing: '0.5px',
              color: 'var(--color-fg-muted)',
              opacity: 0.55,
            }}
          >
            {new Date(message.timestamp).toLocaleTimeString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            })}
          </span>
        ) : null}
        {isUser && message.queued && (
          <span
            className="display-font"
            style={{
              fontSize: '10px',
              letterSpacing: '1.5px',
              padding: '1px 6px',
              border: '1px solid var(--color-accent-secondary-dim)',
              color: 'var(--color-accent-secondary-dim)',
              opacity: 0.85,
            }}
            title="Queued — will be sent when the current turn finishes"
          >
            QUEUED
          </span>
        )}
        {isUser && message.queued && onCancelQueued && (
          <button
            type="button"
            onClick={() => onCancelQueued(message.id)}
            className="display-font"
            title="Cancel this queued message"
            style={{
              fontSize: '10px',
              letterSpacing: '1.5px',
              padding: '1px 6px',
              border: '1px solid var(--color-accent-secondary-dim)',
              color: 'var(--color-accent-secondary-dim)',
              background: 'transparent',
              cursor: 'pointer',
              opacity: 0.75,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.75'; }}
          >
            CANCEL
          </button>
        )}
      </div>

      {/* Message content. Assistant phases (including passthrough) get the
          same markdown pipeline as WorkerDetailModal / FileViewerModal so
          code fences, tables, headings render instead of dumping raw text.
          Operator text stays plain; system rows only opt into markdown when
          they carry markdown-shaped file references. */}
      <div
        className={isAssistant || renderSystemMarkdown ? 'arco-markdown' : undefined}
        style={{
          padding: isSystem ? '4px 0' : '8px 12px',
          borderLeft: chatPresentation || isSystem
            ? 'none'
            : `2px solid ${isUser
              ? 'var(--color-accent-secondary)'
              : phase === 'passthrough' ? 'var(--color-accent-primary-dim)'
              : 'var(--color-accent-primary)'}`,
          marginLeft: isSystem ? '0' : '4px',
          maxWidth: chatPresentation && isUser ? '78%' : undefined,
          borderRadius: chatPresentation && isUser ? '16px 16px 4px 16px' : undefined,
          background: chatPresentation && isUser ? 'var(--color-accent-secondary-a08, var(--color-bg-panel))' : undefined,
          color: isSystem
            ? 'var(--color-fg-muted)'
            : isUser
              ? 'var(--color-accent-secondary-dim)'
              : 'var(--color-accent-primary)',
          fontStyle: isSystem ? 'italic' : 'normal',
          whiteSpace: isAssistant || renderSystemMarkdown ? 'normal' : 'pre-wrap',
          wordBreak: 'break-word',
          fontSize: isSystem ? '12px' : '14px',
          lineHeight: '1.7',
          fontFamily: isAssistant || renderSystemMarkdown ? 'var(--font-body)' : undefined,
        }}
      >
        {isAssistant ? (
          splitArtifactRefs(displayContent).map((part, i) =>
            part.kind === 'text' ? (
              <ReactMarkdown
                key={i}
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={markdownComponents}
              >
                {part.value}
              </ReactMarkdown>
            ) : jobId && jobCwd ? (
              <ArtifactPill key={i} name={part.name} cwd={jobCwd} workflowId={jobId} />
            ) : (
              <code key={i}>[artifact:{part.name}]</code>
            ),
          )
        ) : isSystem && jobCwd && jobId && parseArtifactSystemRow(displayContent) ? (
          (() => {
            const parsed = parseArtifactSystemRow(displayContent)!;
            const dir = parsed.kind === 'handoff' ? 'handoffs' : 'artifacts';
            const path = `${jobCwd}/.arco/workflows/${jobId}/${dir}/${parsed.artifactName}`;
            return (
              <>
                {parsed.prefix}
                <span
                  onClick={() => setViewerPath(path)}
                  title={`Open ${parsed.artifactName}`}
                  style={{
                    cursor: 'pointer',
                    textDecoration: 'underline dotted',
                    textUnderlineOffset: '2px',
                  }}
                >
                  {parsed.artifactName}
                </span>
              </>
            );
          })()
        ) : renderSystemMarkdown ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={markdownComponents}
          >
            {displayContent}
          </ReactMarkdown>
        ) : (
          // Operator + system messages render as plain text (no markdown),
          // but still need bare URLs to be clickable. Linkify emits a mix
          // of strings and <a> tags — inline inside the pre-wrap container
          // so newlines/whitespace are preserved untouched.
          linkifyText(displayContent)
        )}
        {isUser && message.attachments && message.attachments.length > 0 && (
          <div
            style={{
              marginTop: '6px',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '6px',
            }}
          >
            {message.attachments.map((p, i) => (
              <AttachmentPill key={i} path={p} />
            ))}
          </div>
        )}
        {message.isStreaming && (
          <span
            style={{
              display: 'inline-block',
              width: '8px',
              height: '16px',
              background: 'var(--color-accent-primary)',
              marginLeft: '2px',
              verticalAlign: 'text-bottom',
              animation: 'cursor-blink 1s step-end infinite',
            }}
          />
        )}
      </div>
      {chatPresentation && !isSystem && !message.isStreaming && (
        <ChatRowActions
          content={displayContent}
          onEdit={isUser && onEditMessage ? (text) => onEditMessage(text, message.attachments) : undefined}
          onRetry={!isUser && onRetryMessage && retryText !== undefined ? () => onRetryMessage(retryText, retryAttachments) : undefined}
        />
      )}
      {viewerPath && (
        <FileViewerModal
          path={viewerPath}
          onClose={() => setViewerPath(null)}
          fallback={jobCwd && jobId ? { cwd: jobCwd, workflowId: jobId } : undefined}
        />
      )}
    </div>
  );
}

// Chat-presentation row actions: copy any message, edit an operator message
// back into the composer, retry the last answer by re-sending the message that
// produced it. Retry is a NEW turn appended to the conversation, not a rewind —
// the model still sees its previous answer, so the label says RETRY rather than
// promising a regenerate the transports can't give.
function ChatRowActions({ content, onEdit, onRetry }: {
  content: string;
  onEdit?: (text: string) => void;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(content).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => { /* clipboard blocked (insecure origin) — leave the label alone */ },
    );
  };
  return (
    <div
      className="chat-row-actions display-font"
      style={{ display: 'flex', gap: '6px', marginTop: '2px', padding: '0 4px' }}
    >
      <RowActionButton onClick={copy} title="Copy this message">{copied ? 'COPIED' : 'COPY'}</RowActionButton>
      {onEdit && <RowActionButton onClick={() => onEdit(content)} title="Put this message back in the composer to edit and send again">EDIT</RowActionButton>}
      {onRetry && <RowActionButton onClick={onRetry} title="Send the same message again as a new turn">RETRY</RowActionButton>}
    </div>
  );
}

function RowActionButton({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        background: 'transparent',
        border: 0,
        padding: '2px 4px',
        color: 'var(--color-fg-muted)',
        cursor: 'pointer',
        fontSize: '9px',
        letterSpacing: '1px',
        opacity: 0.55,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
      onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.55'; }}
    >
      {children}
    </button>
  );
}

// docs/PROVIDERS.md - looks up the per-toolUseId filter annotation
// from the appStore so ToolCallPill can render the chip + raw-bytes recovery
// affordance. Selector is narrow (single map lookup) so the pill only re-
// renders when its own entry changes, not when any other tool's filter
// event arrives.
function ToolCallPillWithFilter({
  jobId,
  toolUseId,
  tool,
  input,
  filePath,
}: {
  jobId?: string;
  toolUseId: string;
  tool: string;
  input: unknown;
  filePath?: string;
}) {
  const filtered = useAppStore((s) => (jobId ? s.jobs[jobId]?.toolFiltered?.[toolUseId] : undefined));
  return <ToolCallPill tool={tool} input={input} filePath={filePath} filtered={filtered} />;
}

// docs/PROTOCOL_CLUSTER.md - peer-message block. Colored by stable
// hash of the sender's workflowId so the same sender always renders the
// same color, both across messages and across sender/recipient panes.
// Direction arrow indicates which side this is (→ outbound, ← inbound).
const PEER_COLORS = [
  '#7dd3fc', // sky-300
  '#fca5a5', // red-300
  '#a7f3d0', // emerald-200
  '#c4b5fd', // violet-300
  '#fcd34d', // amber-300
  '#f9a8d4', // pink-300
  '#fdba74', // orange-300
  '#67e8f9', // cyan-300
];

function hashSenderColor(senderWorkflowId: string | undefined): string {
  if (!senderWorkflowId) return PEER_COLORS[0];
  // Cheap djb2-ish hash — stable, deterministic, good enough for an 8-bucket
  // categorical color pick. We don't need cryptographic distribution here;
  // just "same wfid → same color across reloads".
  let h = 5381;
  for (let i = 0; i < senderWorkflowId.length; i++) {
    h = ((h << 5) + h + senderWorkflowId.charCodeAt(i)) | 0;
  }
  return PEER_COLORS[Math.abs(h) % PEER_COLORS.length];
}

function PeerMessageBlock({ message, onMakeTask }: { message: ChatMessageType; onMakeTask?: (content: string, fromWorkflowId: string) => void }) {
  const isSent = message.role === 'peer-sent';
  const senderColor = hashSenderColor(message.senderWorkflowId);
  const arrow = isSent ? '→' : '←';
  const verb = isSent ? 'sent to' : 'from';
  // Look up the relevant peer (recipient for sent rows, sender for received
  // rows) through the store's wfid -> label index. This keeps old peer rows
  // reactive to renames / role edits without subscribing every row to the
  // entire clusters map.
  const lookupWfid = isSent ? message.targetWorkflowId : message.senderWorkflowId;
  const peerInfo: ClusterMemberLabel | undefined = useAppStore((s) => lookupWfid ? s.clusterMemberLabels[lookupWfid] : undefined);
  const fallbackLabel = message.senderDisplayName ?? message.senderWorkflowId?.slice(0, 8) ?? '???';
  const senderLabel = peerInfo
    ? (peerInfo.role ? `${peerInfo.displayName} (${peerInfo.role})` : peerInfo.displayName)
    : fallbackLabel;
  return (
    <div
      style={{
        margin: '8px 16px',
        padding: '8px 12px',
        borderLeft: `3px solid ${senderColor}`,
        background: 'var(--color-bg-panel)',
        fontSize: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      }}
    >
      <div
        className="display-font"
        style={{
          fontSize: '10px',
          letterSpacing: '1px',
          color: senderColor,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        <span>PEER {arrow} {verb} {senderLabel}</span>
        {message.timestamp ? (
          <span style={{ color: 'var(--color-fg-muted)', marginLeft: 'auto' }}>
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
        ) : null}
        {/* → TASK on incoming peer rows only — the sender is the provenance,
            matching the MAILBOX modal's FROM-<sender> semantics. Outbound rows
            are this member's own sends; promoting them would mislabel origin. */}
        {onMakeTask && !isSent && message.senderWorkflowId ? (
          <button
            type="button"
            onClick={() => onMakeTask(message.content, message.senderWorkflowId as string)}
            className="display-font"
            style={{
              marginLeft: message.timestamp ? '8px' : 'auto',
              background: 'transparent',
              border: '1px solid var(--color-accent-primary)',
              color: 'var(--color-accent-primary)',
              padding: '1px 6px',
              cursor: 'pointer',
              fontSize: '9px',
              letterSpacing: '1px',
            }}
            title="Promote this peer message into a durable board task"
          >
            → TASK
          </button>
        ) : null}
      </div>
      <div style={{ color: 'var(--color-fg)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {message.content}
      </div>
    </div>
  );
}

// Memoised (2026-08-06). ChatPanel virtualises with `overscan: 16`, so ~30 rows
// are mounted at once, each rendering react-markdown + rehype-highlight — not
// cheap. Without memo, ANY ChatPanel re-render re-rendered all of them, and in
// a live cluster ChatPanel re-renders constantly because several components
// subscribe to whole store maps that change identity on every worker event.
//
// This only works because every prop is referentially stable: `message` is a
// store object, `writtenFiles` and `onMakeTask` are useMemo'd in ChatPanel,
// `onCancelQueued` is passed straight through, and jobId/jobCwd are strings.
// If you add a prop, keep it stable or this silently stops helping.
export const ChatMessage = memo(ChatMessageInner);
