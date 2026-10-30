import { PendingQuestionsButton } from './PendingQuestionsButton';
import { GenerationSpeedReadout } from './GenerationSpeedReadout';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EffortLevel, ModelName, ProviderName } from '@arco/shared';
import { useAppStore, type DraftAttachment, type JobState } from '../stores/appStore';
import { useDraftStore } from '../stores/draftStore';
import { claudeModelLabel, modelsForProvider, useModelCatalogs } from '../utils/modelCatalog';
import { clampEffortForModel, effortsForModel } from '../utils/format';
import { ChatPanel } from './ChatPanel';
import { handleKillLine } from './composer/killLine';

interface Props {
  job: JobState;
  onSend: (content: string, attachments?: string[]) => boolean | void; // false ⇒ socket down, nothing sent
  onCancel: () => void;
  onLoadEarlier?: () => void;
  onUpload: (file: File) => Promise<{ fileId: string; filename: string; path: string } | null>;
  onUpdatePrimary?: (update: { model?: ModelName; effort?: EffortLevel; chatWebAccess?: boolean }) => void;
}

// Cap on the composer's auto-grow. ~8 lines at this font/line-height; past
// that the textarea scrolls internally instead of eating the transcript.
const MAX_INPUT_HEIGHT_PX = 200;

// Client mirror of the server's CHAT_WEB_PROVIDERS (server/src/chatMode.ts).
// Only these transports have a web tool Arco can arm per turn — the rest
// stay offline, and the header says so rather than showing a dead toggle.
const WEB_CAPABLE: ReadonlySet<ProviderName> = new Set<ProviderName>(['claude', 'codex', 'ollama', 'strata', 'deepseek']);

// Stable empty reference — a fresh `[]` from the selector would re-render on
// every store tick (Zustand compares with Object.is).
const EMPTY_ATTS: DraftAttachment[] = [];

export function ChatModeView({ job, onSend, onCancel, onLoadEarlier, onUpload, onUpdatePrimary }: Props) {
  const draft = useDraftStore((s) => s.drafts[job.id] ?? '');
  const setDraft = useDraftStore((s) => s.setDraft);
  const attachments = useAppStore((s) => s.attachments[job.id] ?? EMPTY_ATTS);
  const addAttachment = useAppStore((s) => s.addAttachment);
  const removeAttachment = useAppStore((s) => s.removeAttachment);
  const clearAttachments = useAppStore((s) => s.clearAttachments);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const streaming = job.messages.some((m) => m.isStreaming);
  const busy = job.busy === true || streaming;
  const provider = (job.config.primaryProvider ?? 'claude') as ProviderName;
  const incognito = job.config.incognito === true;

  const catalogs = useModelCatalogs();
  const modelOptions = useMemo(() => modelsForProvider(provider, catalogs), [provider, catalogs]);
  const currentModel = String(job.resolvedPrimaryModel ?? job.config.primaryModel);
  const efforts = effortsForModel(provider, job.config.primaryModel, catalogs.claude, catalogs.codex);
  const webCapable = WEB_CAPABLE.has(provider);
  // Mirrors the server's chatWebArmed(): unset ⇒ on for a saved chat, off for
  // incognito (a search query leaves the machine, so incognito opts in).
  const webArmed = webCapable
    && (typeof job.config.chatWebAccess === 'boolean' ? job.config.chatWebAccess : !incognito);
  // Uploads land in ~/.arco/uploads and are logged there by name, which an
  // incognito chat's "nothing touches disk" contract can't allow.
  const canAttach = !incognito;

  useEffect(() => { areaRef.current?.focus(); }, [job.id]);

  // Auto-grow with the message up to MAX_INPUT_HEIGHT_PX. The `height='auto'`
  // write is what lets scrollHeight report a shrunken box when text is deleted;
  // scrollHeight is read once (it's the content extent, so clamping the box
  // height doesn't change it).
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const contentH = el.scrollHeight;
    el.style.height = `${Math.min(contentH, MAX_INPUT_HEIGHT_PX)}px`;
    const overflow = contentH > MAX_INPUT_HEIGHT_PX ? 'auto' : 'hidden';
    if (el.style.overflowY !== overflow) el.style.overflowY = overflow;
  }, [draft]);

  const uploadAndAppend = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    if (!canAttach) {
      setUploadError('Attachments are off in incognito — nothing was attached.');
      return;
    }
    setUploading(true);
    setUploadError(null);
    const failed: string[] = [];
    for (const file of files) {
      const result = await onUpload(file);
      if (!result) {
        failed.push(file.name || 'pasted file');
        continue;
      }
      const isImage = file.type.startsWith('image/');
      addAttachment(job.id, {
        filename: result.filename,
        path: result.path,
        isImage,
        ...(isImage && { previewUrl: URL.createObjectURL(file) }),
      });
    }
    setUploading(false);
    if (failed.length > 0) setUploadError(`Upload failed: ${failed.join(', ')}`);
  }, [onUpload, addAttachment, job.id, canAttach]);

  // App-wide drops land here via DragOverlay's `arco:attach-files` event.
  // TerminalInput owns that event on Agent tabs; a Chat tab never mounts
  // TerminalInput, so without this listener a dropped file vanished silently
  // despite the "paste or drop" hint.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { files: File[] } | undefined;
      if (detail?.files?.length) void uploadAndAppend(detail.files);
    };
    window.addEventListener('arco:attach-files', handler);
    return () => window.removeEventListener('arco:attach-files', handler);
  }, [uploadAndAppend]);

  const submit = () => {
    const text = draft.trim();
    // `uploading`: a paste still in flight isn't staged yet; sending now would
    // drop the image from this message and stage it onto the next one.
    if ((!text && attachments.length === 0) || busy || uploading) return;
    const sent = onSend(text, attachments.length > 0 ? attachments.map((a) => a.path) : undefined);
    if (sent === false) {
      setUploadError('Not connected — message kept in the composer. Send again once Arco reconnects.');
      return;
    }
    setUploadError(null);
    setDraft(job.id, '');
    clearAttachments(job.id);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted: File[] = [];
    for (const item of Array.from(e.clipboardData?.items ?? [])) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) pasted.push(file);
      }
    }
    if (pasted.length > 0) {
      e.preventDefault();
      void uploadAndAppend(pasted);
    }
  };

  const sendable = busy || !!draft.trim() || attachments.length > 0;

  // Stable identities — ChatMessage is memoised and re-creating these each
  // render would un-memo every visible row.
  // EDIT re-stages the message's attachments too (server paths are still on
  // disk; no preview thumbnail since the original File is gone). Previously
  // only the text came back and the image silently fell off the edit.
  const handleEditMessage = useCallback((text: string, messageAttachments?: string[]) => {
    setDraft(job.id, text);
    if (messageAttachments && messageAttachments.length > 0) {
      clearAttachments(job.id);
      for (const path of messageAttachments) {
        addAttachment(job.id, { filename: basename(path), path, isImage: IMAGE_EXT_RE.test(path) });
      }
    }
    areaRef.current?.focus();
  }, [setDraft, clearAttachments, addAttachment, job.id]);
  const handleRetryMessage = useCallback((text: string, messageAttachments?: string[]) => {
    onSend(text, messageAttachments && messageAttachments.length > 0 ? messageAttachments : undefined);
  }, [onSend]);

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <header data-help="chat.mode-status" style={{ padding: '14px 24px 10px', borderBottom: '1px solid var(--color-border-hairline)', textAlign: 'center' }}>
        <div className="display-font" style={{ color: 'var(--color-fg-primary)', fontSize: '14px', letterSpacing: '1.8px' }}>{job.config.name || job.id.slice(0, 8)}</div>
        <div
          className="display-font"
          style={{
            display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center',
            gap: '8px', marginTop: '6px', color: 'var(--color-fg-muted)', fontSize: '9px', letterSpacing: '1.3px',
          }}
        >
          <span>CHAT · {provider === 'deepseek' ? 'XOLOTL' : provider.toUpperCase()}</span>
          {onUpdatePrimary && modelOptions.length > 0 ? (
            <span data-help="chat.model" style={{ display: 'inline-flex' }}><select
              value={String(job.config.primaryModel)}
              onChange={(e) => {
                const model = e.target.value as ModelName;
                const effort = clampEffortForModel(job.config.primaryEffort, provider, model, catalogs.claude, catalogs.codex);
                onUpdatePrimary({ model, ...(effort !== job.config.primaryEffort ? { effort } : {}) });
              }}
              title="Swap the model for the next message. Same provider — the conversation carries over."
              className="display-font"
              style={selectStyle}
            >
              {/* The tab's own value first: an alias (or an id the catalog has
                  since dropped) would otherwise render as the first option and
                  read as a model the chat isn't actually on. */}
              {!modelOptions.some((m) => String(m) === String(job.config.primaryModel)) && (
                <option value={String(job.config.primaryModel)}>{modelLabel(provider, String(job.config.primaryModel), catalogs)} (unlisted)</option>
              )}
              {modelOptions.map((m) => (
                <option key={String(m)} value={String(m)}>{modelLabel(provider, String(m), catalogs)}</option>
              ))}
            </select></span>
          ) : (
            <span>· {currentModel}</span>
          )}
          {onUpdatePrimary && efforts.length > 0 && (
            <span data-help="chat.effort" style={{ display: 'inline-flex' }}><select
              value={job.config.primaryEffort}
              onChange={(e) => onUpdatePrimary({ effort: e.target.value as EffortLevel })}
              title="Reasoning effort for the next message"
              className="display-font"
              style={selectStyle}
            >
              {efforts.map((e) => <option key={e} value={e}>{e.toUpperCase()}</option>)}
            </select></span>
          )}
          {webCapable ? (
            <span data-help="chat.web" style={{ display: 'inline-flex' }}><button
              type="button"
              onClick={() => onUpdatePrimary?.({ chatWebAccess: !webArmed })}
              disabled={!onUpdatePrimary}
              title={webArmed
                ? 'Web search and fetch are armed. Click to take this chat offline.'
                : 'This chat has no web access. Click to arm web search and fetch for the next message.'}
              className="display-font"
              style={{
                ...chipStyle,
                cursor: onUpdatePrimary ? 'pointer' : 'default',
                color: webArmed ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                borderColor: webArmed ? 'var(--color-accent-primary-dim)' : 'var(--color-border-hairline)',
              }}
            >
              {webArmed ? '◉ WEB' : '○ WEB OFF'}
            </button></span>
          ) : (
            <span title={`${provider} chat has no web tool Arco can arm`} style={{ opacity: 0.6 }}>○ NO WEB</span>
          )}
          <span>· {incognito ? 'INCOGNITO · NOT SAVED' : 'SAVED'} · NO PROJECT</span>
        </div>
      </header>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <ChatPanel
          job={job}
          onLoadEarlier={onLoadEarlier}
          presentation="chat"
          onEditMessage={handleEditMessage}
          onRetryMessage={busy ? undefined : handleRetryMessage}
        />
      </div>
      <div style={{ padding: '10px 20px 20px' }}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) void uploadAndAppend(files);
            e.target.value = '';
          }}
        />
        {uploadError && (
          <div
            role="alert"
            style={{ maxWidth: '860px', margin: '0 auto 8px', display: 'flex', justifyContent: 'center', gap: '8px', color: 'var(--color-warning)', fontSize: '11px' }}
          >
            <span>{uploadError}</span>
            <button
              type="button"
              onClick={() => setUploadError(null)}
              aria-label="Dismiss"
              style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: '11px' }}
            >
              ×
            </button>
          </div>
        )}
        {attachments.length > 0 && (
          <div style={{ maxWidth: '860px', margin: '0 auto 8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {attachments.map((a, i) => (
              <span
                key={`${a.path}-${i}`}
                className="display-font"
                style={{
                  fontSize: '10px', padding: '3px 8px', borderRadius: '12px',
                  border: '1px solid var(--color-accent-secondary)', color: 'var(--color-accent-secondary-dim)',
                  display: 'flex', alignItems: 'center', gap: '6px',
                }}
              >
                {a.previewUrl && (
                  <img src={a.previewUrl} alt={a.filename} style={{ width: '24px', height: '24px', objectFit: 'cover', borderRadius: '2px' }} />
                )}
                {a.filename}
                <button
                  type="button"
                  onClick={() => removeAttachment(job.id, i)}
                  aria-label={`Remove ${a.filename}`}
                  style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: '11px' }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div style={{ maxWidth: '860px', margin: '0 auto', display: 'flex', gap: '10px', alignItems: 'flex-end', padding: '10px 10px 10px 12px', border: '1px solid var(--color-border)', borderRadius: '20px', background: 'var(--color-bg-elevated, var(--color-bg))', boxShadow: '0 8px 30px rgba(0,0,0,.16)' }}>
          {canAttach && (
            <button
              data-help="chat.attach"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              title="Attach images or files"
              aria-label="Attach a file"
              style={{
                width: '30px', height: '30px', flex: '0 0 30px', borderRadius: '50%', border: 0,
                background: 'transparent', color: 'var(--color-fg-muted)', cursor: uploading ? 'default' : 'pointer',
                fontSize: '15px', opacity: uploading ? 0.4 : 1,
              }}
            >
              {uploading ? '…' : '＋'}
            </button>
          )}
          <textarea
            data-help="chat.input"
            ref={areaRef}
            value={draft}
            onChange={(e) => setDraft(job.id, e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              // IME: Enter that commits a CJK candidate must not send. keyCode
              // 229 is the WebKit fallback when isComposing reads false.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (handleKillLine(e, (next) => setDraft(job.id, next))) return;
              // Esc stops the in-flight reply, same as the Agent composer.
              if (e.key === 'Escape' && busy) {
                e.preventDefault();
                onCancel();
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={busy ? 'Arco is responding…' : 'Message Arco'}
            rows={1}
            style={{
              flex: 1, minHeight: '28px', maxHeight: `${MAX_INPUT_HEIGHT_PX}px`, overflowY: 'hidden',
              resize: 'none', border: 0, outline: 0, background: 'transparent',
              color: 'var(--color-fg-primary)', font: 'inherit', lineHeight: 1.5, padding: '4px 0',
            }}
          />
          <button
            data-help={busy ? 'chat.stop' : 'chat.send'}
            type="button"
            onClick={busy ? onCancel : submit}
            disabled={!sendable}
            aria-label={busy ? 'Stop response' : 'Send message'}
            title={busy ? 'Stop' : 'Send'}
            style={{ width: '38px', height: '38px', flex: '0 0 38px', borderRadius: '50%', border: 0, cursor: sendable ? 'pointer' : 'default', color: 'var(--color-bg)', background: busy ? 'var(--color-warning)' : sendable ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)', opacity: sendable ? 1 : .45, fontSize: '18px' }}
          >
            {busy ? '■' : '↑'}
          </button>
        </div>
        <div style={{ maxWidth: '860px', margin: '7px auto 0', textAlign: 'center', color: 'var(--color-fg-muted)', fontSize: '10px' }}>
          Enter to send · Shift+Enter for a new line
          {canAttach ? ' · paste or drop a file to attach' : ' · attachments off in incognito'}
          {' · '}{incognito ? 'Incognito: closing or refreshing erases this chat' : 'Saved to Past Chats'}
          {' · '}{webArmed ? 'Web search on' : 'No web access'} · No project
          <GenerationSpeedReadout job={job} />
        <PendingQuestionsButton workflowId={job.id} />
        </div>
      </div>
    </div>
  );
}

function modelLabel(provider: ProviderName, id: string, catalogs: ReturnType<typeof useModelCatalogs>): string {
  if (provider === 'deepseek') return catalogs.deepseekLabels?.[id] ?? id;
  if (provider === 'strata') return catalogs.strataLabels?.[id] ?? id;
  if (provider === 'claude') return claudeModelLabel(id, catalogs.claude);
  if (provider === 'codex') return catalogs.codex?.models?.find((m) => m.id === id)?.displayName ?? id;
  if (provider === 'cursor') return catalogs.cursor?.models?.find((m) => m.id === id)?.displayName ?? id;
  return id;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

function basename(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  // Uploads are saved as `<8-char id>-<original name>`; show the original.
  return name.replace(/^[0-9a-f]{8}-/, '');
}

const selectStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '10px',
  color: 'var(--color-accent-primary)',
  fontSize: '9px',
  letterSpacing: '1px',
  padding: '2px 4px',
  cursor: 'pointer',
  maxWidth: '190px',
};

const chipStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '10px',
  fontSize: '9px',
  letterSpacing: '1px',
  padding: '3px 8px',
};
