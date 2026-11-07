import { BriefControl } from './BriefControl';
import { ClusterComposerButtons, type ClusterComposerControls } from './ClusterComposerButtons';
import type { SpawnMemberIdentity } from '@arco/shared';
import { formatRow } from '../utils/transcriptFormat';
import { ForwardDialog, MessageSelectionBar } from './ForwardMessages';
import { useMessageSelectionStore } from '../stores/messageSelectionStore';
import { TidyComposer } from './TidyComposer';
import { PendingQuestionsButton } from './PendingQuestionsButton';
import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { parseContextRefs, contextRefLabel } from './composer/contextRefs';
import { handleKillLine } from './composer/killLine';
import { submitComposer } from './composer/submitComposer';
import { useAppStore, type JobState, type DraftAttachment } from '../stores/appStore';
import { onVoiceDialog } from '../voice/dialogs';
import { useDraftStore, readDraft as readDraftFor } from '../stores/draftStore';
import { useCodexCatalogFor } from '../hooks/useCodexCatalog';
import { useHubLinkStore } from '../stores/hubLinkStore';
import { ToolboxMenu } from './ToolboxMenu';
import { SkillEditorDialog } from './SkillEditorDialog';
import { SkillImportDialog } from './SkillsSettings';
import { ReviewDialog } from './ReviewDialog';
import { HandoffDialog } from './HandoffDialog';
import { SpawnDialog } from './SpawnDialog';
import { CursorModelSelect } from './CursorModelSelect';
import { PlanComposerDialog } from './PlanComposerDialog';
import { TranscriptSendDialog } from './TranscriptSendDialog';
import { DocsUpdateDialog } from './DocsUpdateDialog';
import { GitDialog } from './GitDialog';
import { MdTuneupDialog } from './MdTuneupDialog';
import { ResearchDialog } from './ResearchDialog';
import { mintResearchSpawnToken, registerPendingResearch } from './terminalInput/research';
import { beginPlanReview, planDraftPrompt } from './terminalInput/planDraft';
import { effectivePublic } from '../utils/publicProject';
import { DialogPortal } from './DialogShell';
import { openCompareDialog } from './terminalInput/compare';
import { PrimaryStatus } from './PrimaryStatus';
import { QueuedMessagesIndicator } from './QueuedMessagesIndicator';
import { NorthStarBar } from './NorthStarBar';
import { CLAUDE_MODELS as CLAUDE_MODEL_VALUES, CLAUDE_MODEL_LABELS, CODEX_PICKER_MODELS, CODEX_MODEL_INFO} from '@arco/shared';
import { useMessageBoxSize, messageBoxMinHeight, messageBoxMaxHeight } from '../utils/messageBoxSize';
import type { ToolboxEntry, ProviderName, ModelName, EffortLevel, WorkflowConfig, ReviewContextRef, ArcoSkillRef } from '@arco/shared';
import {
  effortsForModel,
} from '../utils/format';
import type { UploadResult } from '../utils/uploadAttachment';
import { useLayoutRange } from '../layout/layoutRange';
import { ToolbarMore, useToolbarOverflow } from '../layout/ToolbarOverflow';
import { useKeepInWindow } from '../layout/keepInWindow';

// FILE, PLAN and BRIEF stay on the composer line in every layout.
const TOOLBAR_KEEP: ReadonlySet<string> = new Set(['composer.attach', 'composer.plan', 'composer.brief']);

export interface Props {
  job: JobState;
  // Phase 4 — `kind` is set when sending mid-turn (busy). Idle sends omit it.
  // 'steer' = "do this now / change direction"; 'follow-up' = "after the
  // current task lands." Interrupt cancels the active turn and sends next.
  onSend: (
    content: string,
    attachments?: string[],
    kind?: 'steer' | 'follow-up' | 'interrupt',
    primitive?: 'docs' | 'git' | 'plan-review',
    // DD8 — operator-picked Arco skills to inline into this turn.
    pickedSkills?: Array<{ scope: 'project' | 'global' | 'builtin'; slug: string }>,
  ) => boolean | void; // false ⇒ socket down, nothing sent: keep the draft
  onCancel: () => void;
  // Per-item cancel from the queue strip's [×] button.
  onCancelQueued?: (clientMessageId: string) => void;
  onUpload: (file: File) => Promise<UploadResult>;
  // Phase 5 — reviewer dispatch. Opens ReviewDialog → submits via WS.
  onReview?: (
    reviewer: { provider: ProviderName; model: ModelName; effort: EffortLevel },
    contextRef: ReviewContextRef,
    includeGitDiff: boolean,
  ) => void;
  // Phase 6 — session rotation. Generates a handoff document via the named
  // mode and pre-warms a fresh native session in the same tab.
  onHandoff?: (
    mode: 'quick' | 'fresh-summarizer' | 'original-worker' | 'fresh-agent',
    newPrimary?: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string },
    // WP2 — fresh-summarizer worker that writes the handoff (strong fresh model).
    summarizer?: { provider: ProviderName; model: ModelName; effort: EffortLevel },
  ) => void;
  // Phase 7 — fork the tab into a new one. Receives the full target config
  // (config edits happen in the dialog) + optional direction prompt.
  // Phase 2.5b — when invoked from a cluster member, `joinClusterId` is set
  // (operator opted in via the SpawnDialog checkbox). The server adds the
  // new workflow to the cluster after creation, gated on Native transport.
  onSpawn?: (newConfig: WorkflowConfig, newDirection: string, includePlan: boolean, joinClusterId?: string, memberIdentity?: SpawnMemberIdentity) => void;
  // Phase 2.5b — set when this composer instance is mounted inside a cluster
  // member pane. Drives the SpawnDialog "Spawn into cluster" checkbox.
  clusterContext?: { clusterId: string; name: string };
  // Live-edit the primary's model / effort from the chip. Mid-turn picks
  // are honored on the next round-trip; the worker pulls config.model and
  // config.effort fresh on each messages.create.
  onUpdatePrimary?: (update: { model?: ModelName; effort?: EffortLevel; remoteEnabled?: boolean; remoteGatesEnabled?: boolean; goalRun?: { enabled: boolean; total?: number; tokenBudget?: number }; goal?: string; pinnedSkills?: ArcoSkillRef[] }) => void;
  // Operator-triggered provider-native compaction. The button is capability-
  // gated below; the server validates transport/session state + drives the lock.
  onCompact?: () => void;
  // engine 'server' = Server Fold (on-demand compaction, keeps recent turns
  // verbatim; deterministic Fold fallback server-side).
  onFold?: (engine?: 'server') => void;
  // §4.1 — set the per-tab tool posture (session-local; Native-only).
  onSetToolPosture?: (posture: 'full' | 'coding' | 'chat' | 'review') => void;
  // DD7 — answer the project-trust prompt for this tab's cwd.
  onSetProjectTrust?: (cwd: string, decision: 'always' | 'never') => void;
  // Operator-initiated plan-mode entry. Fired send-time when the inline
  // toggle above the textarea is checked: the WS request lands just before
  // the user_message so the upcoming turn dispatch picks up the armed flag
  // and starts in plan mode. Only wired for Claude Native; the toggle is
  // hidden on every other provider/transport.
  onArmPlanMode?: () => void;
  // Cluster-only escape hatch — when present, the status row renders a
  // "← BACK TO CLUSTER" button left of SKILLS so operators looking at a
  // member's individual view can pop back to the cluster surface. Hidden
  // (no greyed-out state) for non-cluster workflows.
  onBackToCluster?: () => void;
  // Cluster tab only: recipient chip, NUDGE and the BRIEF choice live in the composer.
  clusterControls?: ClusterComposerControls;
  // Operator-driven peer_send. Only wired for cluster members; the SEND
  // TRANSCRIPT button gates on this prop being defined AND the workflow
  // belonging to a cluster. Fires operator_peer_send via useWebSocket.
  onTranscriptSend?: (toWorkflowId: string, content: string) => void;
  // Cluster-only — peer-route a review request through another cluster member
  // instead of spawning a sub-worker. Built off the same ReviewDialog scope
  // picker; App.tsx assembles the review-task body + dispatches via
  // operator_peer_send.
  onReviewViaMember?: (
    reviewerWorkflowId: string,
    contextRef: ReviewContextRef,
    includeGitDiff: boolean,
  ) => void;
  // docs/ARCHITECTURE.md - Deep Research dispatch. `spawnConfig`
  // present ⇒ new-tab path (App creates the workflow + defers the
  // research_request via the spawn-token registry); absent ⇒ in-tab dispatch
  // against this workflow. App wires this off requestResearch / createWorkflow.
  onResearch?: (
    researcher: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string },
    topic: string,
    maxRounds: number,
    spawnConfig?: WorkflowConfig,
  ) => void;
}

// Cap on the auto-grow height so a 50-line paste doesn't push the chat off
// screen. ~10 lines at the current font/line-height. Beyond this the textarea
// scrolls internally.
const MAX_INPUT_HEIGHT_PX = 240;

// Stable empty reference for the attachments selector — Zustand's default
// equality is Object.is, so returning a fresh `[]` every render would
// re-render on every store tick. This constant is shared across tabs
// that have no staged attachments and is safe because it's frozen.
const EMPTY_ATTS: DraftAttachment[] = [];

// ── Composer draft: why the textarea and the chips are their own components ──
//
// Measured on a low-power laptop (Event Timing API): a single keystroke
// cost 42.7ms median of JS `processing`. At normal typing speed that is ~40% of
// the main thread; under key auto-repeat (~60/s) it oversubscribes the thread
// ~2.7x, so events queue and the *presentation* phase balloons to seconds. That
// is the typing lag — not layout (forced reflow measured 0.1ms), not the DOM
// (1878 nodes), not background work (idle sat at a clean 60fps).
//
// Cause: the draft lives in the global store, TerminalInput subscribed to it,
// and TerminalInput is ~2500 lines rendering a toolbar, chips, status and a
// stack of dialogs. Every character re-rendered that entire tree.
//
// Fix: only these two small components subscribe to the draft, so a keystroke
// re-renders ~50 lines instead of ~2500. TerminalInput no longer subscribes at
// all — its handlers read the draft on demand via readDraft() below. That is
// the whole point, so DO NOT reintroduce a `useAppStore(s => s.drafts[...])`
// subscription in TerminalInput; it silently restores the 42.7ms cost.
//
// The store stays the single source of truth (ReviewTab, the terminal→composer
// bridge and the seed-prompt handler all still write it and still show up here).
const ComposerTextarea = memo(function ComposerTextarea({
  jobId, inputRef, onKeyDown, onPaste, disabled, placeholder, isBusy,
}: {
  jobId: string;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  disabled: boolean;
  placeholder: string;
  isBusy: boolean;
}) {
  const value = useDraftStore((s) => s.drafts[jobId] ?? '');
  const setDraft = useDraftStore((s) => s.setDraft);
  const boxSize = useMessageBoxSize();
  const minPx = messageBoxMinHeight(boxSize, 24);
  const maxPx = messageBoxMaxHeight(boxSize, 24, MAX_INPUT_HEIGHT_PX);

  // Auto-grow, measured ONCE per change. This used to read scrollHeight twice
  // with a style write in between — write→read→write→read, i.e. two forced
  // synchronous reflows per keystroke. Measured at 0.1ms median so it was never
  // the lag, but the second read was redundant: scrollHeight is the content
  // extent, so clamping the box height doesn't change it. The `height='auto'`
  // write is NOT removable — it's what lets scrollHeight report a shrunken box
  // when text is deleted.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const contentH = el.scrollHeight;
    el.style.height = `${Math.max(minPx, Math.min(contentH, maxPx))}px`;
    const overflow = contentH > maxPx ? 'auto' : 'hidden';
    if (el.style.overflowY !== overflow) el.style.overflowY = overflow;
  }, [value, inputRef, minPx, maxPx]);

  return (
    <textarea
      ref={inputRef}
      data-recovery-composer=""
      value={value}
      onChange={(e) => setDraft(jobId, e.target.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      disabled={disabled}
      placeholder={placeholder}
      rows={1}
      style={{
        flex: 1,
        minWidth: 0,
        background: 'transparent',
        border: 'none',
        outline: 'none',
        opacity: disabled ? 0.5 : 1,
        color: isBusy ? 'var(--color-warning)' : 'var(--color-accent-primary)',
        fontFamily: 'var(--font-body)',
        fontSize: '14px',
        lineHeight: '1.6',
        resize: 'none',
        caretColor: 'var(--color-accent-primary)',
        minHeight: `${minPx}px`,
        maxHeight: `${maxPx}px`,
        overflowY: 'hidden',
      }}
    />
  );
});

// Inline `@`-ref chips. Subscribes to the draft for the same reason as above —
// parsing is a cheap single-pass regex, but rendering it from the parent would
// drag the parent's whole tree into every keystroke.
const ContextRefChips = memo(function ContextRefChips({
  jobId, onRemove,
}: {
  jobId: string;
  onRemove: (start: number, end: number) => void;
}) {
  const value = useDraftStore((s) => s.drafts[jobId] ?? '');
  const contextRefs = useMemo(() => parseContextRefs(value), [value]);
  if (contextRefs.length === 0) return null;
  return (
    <div
      data-help="composer.context-refs"
      style={{ display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' }}
    >
      {contextRefs.map((ref, i) => (
        <span
          key={`${ref.start}-${i}`}
          className="display-font"
          style={{
            fontSize: '10px',
            padding: '3px 8px',
            border: `1px solid ${ref.kind === 'url' ? 'var(--color-border-hairline)' : 'var(--color-accent-secondary)'}`,
            borderRadius: '3px',
            color: ref.kind === 'url' ? 'var(--color-fg-muted)' : 'var(--color-accent-secondary-dim)',
            letterSpacing: '0.5px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
          title={ref.kind === 'url'
            ? '@url: is not yet supported: expands to a deferral notice'
            : `Expands at send into this turn's context: ${contextRefLabel(ref)}`}
        >
          {contextRefLabel(ref)}
          <button
            onClick={() => onRemove(ref.start, ref.end)}
            style={{ background: 'none', border: 'none', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '11px', padding: 0 }}
            title="Remove this context ref"
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
});

function ComposerSendButtons({ jobId, blocked, hasAttachments, busy, canInterrupt, onSend, onInterrupt }: {
  jobId: string; blocked: boolean; hasAttachments: boolean; busy: boolean; canInterrupt: boolean;
  onSend: () => void; onInterrupt: () => void;
}) {
  const draft = useDraftStore((s) => s.drafts[jobId] ?? '');
  const disabled = blocked || (!draft.trim() && !hasAttachments);
  const style = { padding: '3px 10px', background: 'transparent', borderRadius: '3px',
    fontSize: '10px', letterSpacing: '1px', whiteSpace: 'nowrap' as const, cursor: disabled ? 'not-allowed' : 'pointer' };
  return <>
    <button onClick={onSend} disabled={disabled} data-help="composer.send" className="display-font"
      title={busy ? 'Send normally (Enter). Steers at the next supported boundary without interrupting the turn.' : 'Send message (Enter)'}
      style={{ ...style, border: '1px solid var(--color-accent-primary)', color: 'var(--color-accent-primary)' }}>
      SEND
    </button>
    {busy && canInterrupt && <button onClick={onInterrupt} disabled={disabled} data-help="composer.interrupt"
    className="display-font"
    title="Interrupt the active turn and send this message next (Ctrl/Cmd+Enter). Keeps queued messages and completed edits."
    style={{ ...style, border: '1px solid var(--color-warning)', color: 'var(--color-warning)' }}>
    INTERRUPT &amp; SEND
    </button>}
  </>;
}

export function TerminalInput({ job, onSend, onCancel, onCancelQueued, onUpload, onReview, onHandoff, onSpawn, onUpdatePrimary, onCompact, onFold, onSetToolPosture, onSetProjectTrust, onArmPlanMode, onBackToCluster, clusterControls, clusterContext, onTranscriptSend, onReviewViaMember, onResearch }: Props) {
  // Composer text lives in the store keyed by job.id so each tab keeps its
  // own draft across tab switches. Empty tab reads back as ''.
  // NOT a subscription — see the ComposerTextarea note above. Handlers read the
  // draft on demand so a keystroke doesn't re-render this whole component.
  // `readDraft()` is always current because it reads the store at call time.
  const setDraft = useAppStore((s) => s.setDraft);
  const readDraft = useCallback(() => readDraftFor(job.id), [job.id]);
  const setValue = useCallback((next: string) => setDraft(job.id, next), [setDraft, job.id]);
  // §D1 — the `@`-context-ref chips render in ContextRefChips, which does its
  // own draft subscription + parse. Keeping that out of this component is what
  // stops a keystroke re-rendering the composer's whole tree.
  //
  // Remove a ref by stripping its exact span from the draft (plus one leading
  // space if present, so removing a mid-sentence ref doesn't leave a double
  // space). Offsets come from the parser; recompute is implicit via setValue.
  const removeContextRef = useCallback((start: number, end: number) => {
    const value = readDraft();
    const before = value.slice(0, start);
    const after = value.slice(end);
    const trimmedBefore = before.endsWith(' ') && after.startsWith(' ') ? before.slice(0, -1) : before;
    setValue(trimmedBefore + after);
  }, [readDraft, setValue]);
  // Attachments also per-tab in the store — uploaded server-side, previewed
  // via a local blob URL. Revocation happens inside store actions so the URL
  // outlives the component lifecycle (tab switches remount TerminalInput).
  const attachments: DraftAttachment[] = useAppStore((s) => s.attachments[job.id] ?? EMPTY_ATTS);
  const addAttachment = useAppStore((s) => s.addAttachment);
  const removeAttachmentAction = useAppStore((s) => s.removeAttachment);
  const clearAttachments = useAppStore((s) => s.clearAttachments);
  const addMessage = useAppStore((s) => s.addMessage);
  const [uploading, setUploading] = useState(false);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const toolbarOneLine = useLayoutRange() !== 'standard';
  const toolbarHidden = useToolbarOverflow(toolbarRef, toolbarOneLine, TOOLBAR_KEEP);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // DD8 — operator-picked Arco skills to inline into the next turn. Per-tab;
  // cleared after each send and when the active tab changes.
  const [pickedSkills, setPickedSkills] = useState<Array<{ scope: 'project' | 'global'; slug: string; name: string }>>([]);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const skillMenuPlaceRef = useKeepInWindow();
  const skillMenuRef = useRef<HTMLDivElement>(null);
  const [showSkillEditor, setShowSkillEditor] = useState(false);
  const [skillCatalogRevision, setSkillCatalogRevision] = useState(0);
  const [availableSkills, setAvailableSkills] = useState<Array<{ scope: 'project' | 'global'; slug: string; name: string; description: string; operatorOnly?: boolean; off?: boolean }>>([]);
  const [showSkillImport, setShowSkillImport] = useState(false);
  const [skillCatalogStatus, setSkillCatalogStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  // P8.5 — skills shipped with Arco: run once, or make an editable copy.
  const [builtinSkills, setBuiltinSkills] = useState<Array<{ slug: string; name: string; description: string; operatorOnly?: boolean; off?: boolean; replaced?: boolean }>>([]);
  const [builtinNote, setBuiltinNote] = useState('');
  const pinnedSkills = job.config.pinnedSkills ?? [];
  const pinnedSkillsKey = pinnedSkills.map((s) => `${s.scope}:${s.slug}`).join('|');
  useEffect(() => { setPickedSkills([]); setSkillMenuOpen(false); setShowSkillEditor(false); }, [job.id]);
  useEffect(() => {
    if (!skillMenuOpen) return;
    const onOutside = (event: MouseEvent) => { if (!skillMenuRef.current?.contains(event.target as Node)) setSkillMenuOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSkillMenuOpen(false); };
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onOutside); document.removeEventListener('keydown', onKey); };
  }, [skillMenuOpen]);
  // Fetch when the picker opens OR a persisted pin needs a display name. The
  // catalog remains the name source; stable pin identity is scope + slug.
  useEffect(() => {
    if (!skillMenuOpen && pinnedSkillsKey.length === 0) return;
    const params = job.config.workingDirectory ? `?cwd=${encodeURIComponent(job.config.workingDirectory)}` : '';
    let cancelled = false;
    setSkillCatalogStatus('loading');
    fetch(`/api/skills${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { project?: typeof availableSkills; global?: typeof availableSkills; builtin?: typeof builtinSkills }) => {
        if (cancelled) return;
        // Skills turned off in Settings > SKILLS are left out of the apply list.
        setAvailableSkills([...(data.project ?? []), ...(data.global ?? [])].filter((s) => !s.off));
        setBuiltinSkills(data.builtin ?? []);
        setSkillCatalogStatus('ready');
      })
      .catch(() => { if (!cancelled) { setAvailableSkills([]); setSkillCatalogStatus('error'); } });
    return () => { cancelled = true; };
  }, [skillMenuOpen, pinnedSkillsKey, job.config.workingDirectory, skillCatalogRevision]);
  const togglePickedSkill = useCallback((s: { scope: 'project' | 'global'; slug: string; name: string }) => {
    setPickedSkills((prev) =>
      prev.some((p) => p.scope === s.scope && p.slug === s.slug)
        ? prev.filter((p) => !(p.scope === s.scope && p.slug === s.slug))
        : [...prev, { scope: s.scope, slug: s.slug, name: s.name }],
    );
  }, []);
  const setSkillPinned = useCallback((s: { scope: 'project' | 'global'; slug: string }, pinned: boolean) => {
    if (!onUpdatePrimary) return;
    const exists = pinnedSkills.some((p) => p.scope === s.scope && p.slug === s.slug);
    const next = pinned
      ? (exists ? pinnedSkills : [...pinnedSkills, { scope: s.scope, slug: s.slug }])
      : pinnedSkills.filter((p) => !(p.scope === s.scope && p.slug === s.slug));
    onUpdatePrimary({ pinnedSkills: next });
    if (pinned) {
      // A standing pin supersedes a staged one-shot copy of the same body.
      setPickedSkills((prev) => prev.filter((p) => !(p.scope === s.scope && p.slug === s.slug)));
    }
  }, [onUpdatePrimary, pinnedSkillsKey]);
  const runBuiltinSkill = (s: { slug: string; name: string }) => {
    const sent = onSend(`Run the ${s.name} on this project.`, undefined, isBusy ? 'follow-up' : undefined, undefined, [{ scope: 'builtin', slug: s.slug }]);
    if (sent === false) { setBuiltinNote('Not connected; nothing was sent.'); return; }
    setBuiltinNote(''); setSkillMenuOpen(false);
  };
  const copyBuiltinSkill = async (s: { slug: string; name: string }) => {
    const cwd = job.config.workingDirectory ?? '';
    const scope = cwd ? 'project' : 'global';
    try {
      const res = await fetch(`/api/skills/copy-builtin${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, slug: s.slug }) });
      const body = await res.json().catch(() => ({})) as { skill?: { name: string }; error?: string };
      if (!res.ok) throw new Error(body.error || res.statusText);
      setBuiltinNote(`Saved "${body.skill?.name ?? s.name}" to your ${scope} skills; edit it in Settings > SKILLS.`);
      setSkillCatalogRevision((n) => n + 1);
    } catch (err) { setBuiltinNote(`Could not copy: ${err instanceof Error ? err.message : String(err)}`); }
  };
  const skillDisplayName = useCallback((scope: 'project' | 'global', slug: string) =>
    availableSkills.find((s) => s.scope === scope && s.slug === slug)?.name ?? slug,
  [availableSkills]);
  const [showReviewDialog, setShowReviewDialog] = useState(false);
  const [showHandoffDialog, setShowHandoffDialog] = useState(false);
  const [showSpawnDialog, setShowSpawnDialog] = useState(false);
  const [showPlanDialog, setShowPlanDialog] = useState(false);

  const [showDocsDialog, setShowDocsDialog] = useState(false);
  const [showGitDialog, setShowGitDialog] = useState(false);
  const [showTuneupDialog, setShowTuneupDialog] = useState(false);
  const [showResearchDialog, setShowResearchDialog] = useState(false);
  const [showTranscriptDialog, setShowTranscriptDialog] = useState(false);
  const [showForwardDialog, setShowForwardDialog] = useState(false);
  // Cluster lookup for transcript-send — find the cluster this workflow
  // belongs to (if any). Returns null when not a cluster member; the
  // SEND TRANSCRIPT button hides in that case.
  const clusterForJob = useAppStore((s) => {
    for (const c of Object.values(s.clusters)) {
      if (c.members.some((m) => m.workflowId === job.id)) return c;
    }
    return null;
  });
  // Computer (voice) asks for a composer dialog by name. Same preconditions
  // as the buttons that open them; a dialog this composer cannot show stays
  // unhandled so Computer reports that instead of claiming it opened.
  useEffect(() => onVoiceDialog((r) => {
    if (r.jobId !== job.id) return false;
    switch (r.name) {
      case 'review': if (!onReview) return false; setShowReviewDialog(true); return true;
      case 'handoff': if (!onHandoff) return false; setShowHandoffDialog(true); return true;
      case 'spawn': if (!onSpawn) return false; setShowSpawnDialog(true); return true;
      case 'plan': setShowPlanDialog(true); return true;
      case 'docs': if (!onSpawn) return false; setShowDocsDialog(true); return true;
      case 'git': if (!job.config.workingDirectory || !onSpawn) return false; setShowGitDialog(true); return true;
      case 'tuneup': setShowTuneupDialog(true); return true;
      case 'research': if (!onResearch) return false; setShowResearchDialog(true); return true;
      case 'transcript': if (!onTranscriptSend || !clusterForJob) return false; setShowTranscriptDialog(true); return true;
      default: return false;
    }
  }), [job.id, job.config.workingDirectory, onReview, onHandoff, onSpawn, onResearch, onTranscriptSend, clusterForJob]);
  // Local-only plan-mode arming. Send-time-fire: clicking the inline
  // checkbox just flips this; the WS message + user_message both go out
  // when the operator hits send. Cleared on every send so arming is always
  // single-turn. Not persisted — a tab swap or reload resets it.
  const [planModeArmed, setPlanModeArmed] = useState(false);
  const setPendingPlanCapture = useAppStore((s) => s.setPendingPlanCapture);
  const clearCompacting = useAppStore((s) => s.clearCompacting);
  const settings = useAppStore((s) => s.settings);
  // Cluster membership lookup off the store — true when this workflow is a
  // member of any cluster, regardless of whether the composer is mounted
  // inside ClusterTab/MemberPane (clusterContext set) or the standalone
  // WorkflowView tab (clusterContext undefined). Drives the PlanComposerDialog
  // AUTOSAVE → review-mode override so cluster members always see the
  // SAVE & ATTACH TO WORKER / ATTACH TO CLUSTER / DISCARD choice banner.
  const isMemberOfACluster = useAppStore((s) => {
    for (const c of Object.values(s.clusters)) {
      if (c.members.some((m) => m.workflowId === job.id)) return true;
    }
    return false;
  });
  // Mirror the cascade the server applies when resolving the per-turn
  // transport: per-tab field wins, otherwise fall back to settings, default
  // 'cli'. Toggle is gated to Claude Native; on any other resolved
  // transport the row renders nothing.
  const resolvedClaudeTransport: 'cli' | 'native' = job.config.claudeTransport
    ?? (settings?.claude?.transport === 'native' ? 'native' : 'cli');
  const planModeToggleVisible =
    !!onArmPlanMode
    && (job.config.primaryProvider ?? 'claude') === 'claude'
    && resolvedClaudeTransport === 'native';
  // REMOTE_MANAGEMENT.md §1.4 — per-workflow hub opt-in toggle. Only shown when
  // this instance is actually hub-linked (otherwise there's nothing to opt into).
  const hubLinked = useHubLinkStore((s) => s.known && s.connected);
  const remoteEnabled = job.config.remoteEnabled === true;
  // R1 §9.2 — second arming for remote DEBAG gate resolution. Only meaningful
  // (and only rendered) when the workflow is remote-shared AND reviewSafeMode
  // is actually parking gates.
  const remoteGatesEnabled = job.config.remoteGatesEnabled === true;
  const reviewSafeOn = job.config.reviewSafeMode === 'on';
  // Provider-native compact: Codex app-server (`thread/compact/start`), Cursor
  // ACP (`/compress`), or Claude native (in-place summarize-replace). Mirror
  // the transport precedence used for the Claude toggle above: per-tab override
  // first, then the cascade default. The server gates again + drives the lock.
  const resolvedCodexTransport: 'exec' | 'appserver' = job.config.codexTransport
    ?? (settings?.codex?.transport === 'appserver' ? 'appserver' : 'exec');
  const provider = job.config.primaryProvider ?? 'claude';
  const interruptAvailable = (provider === 'claude' || provider === 'codex') && !job.config.voiceOperator;
  const compactVisible =
    !!onCompact
    && (
      ((provider === 'codex' && resolvedCodexTransport === 'appserver'))
      || provider === 'cursor'
      || (provider === 'claude' && resolvedClaudeTransport === 'native')
      // WP3 — Ollama has no transport requirement. The worker is stateless per
      // turn, so the button arms a force-compact that runs at the start of the
      // next turn (the server emits an honest "armed for next turn" notice).
      || provider === 'ollama'
    );
  // §2.1 — Fold is Claude-Native-only (it splices the in-process messages[]).
  const foldVisible = !!onFold && provider === 'claude' && resolvedClaudeTransport === 'native';
  // §4.1 — posture pill: Native-only (the only transport whose buildToolDefs
  // honors it). Cycles full → coding → review → chat → full on click.
  const postureVisible = !!onSetToolPosture && provider === 'claude' && resolvedClaudeTransport === 'native';
  // docs/PROVIDERS.md - sticky ultracode indicator. Read-only here (the toggle
  // lives in CONFIG → TRANSPORT); shown so the operator always sees that every
  // turn fans out a subagent fleet, runs unattended, and spends heavily.
  const ultracodeActive = provider === 'claude' && job.config.ultracode === true;
  // While a turn is actively fanning out, surface the live fleet count right on
  // the pill (the per-agent rows stay in the Activity tab) so progress is
  // visible without leaving the conversation. Transient — cleared each turn.
  const ultracodeFleet = job.ultracodeFleet;
  const fleetLive = !!ultracodeFleet && ultracodeFleet.total > 0;
  const currentPosture = job.toolPosture ?? 'full';
  const POSTURE_CYCLE: Array<'full' | 'coding' | 'review' | 'chat'> = ['full', 'coding', 'review', 'chat'];
  // llama.cpp lifecycle state — used in the model footer line so operators
  // see whether the next turn will hit a cold-start (~20-30s for a fresh
  // GGUF load) or fast-path against an already-loaded model.
  const llamacppLive = useAppStore((s) => s.llamacppLive);
  const claudeNativeCatalog = useAppStore((s) => s.claudeNativeCatalog);
  // Account-scoped so the composer MODEL picker shows this tab's Codex
  // profile's entitlements (HOME vs WORK).
  const codexCatalog = useCodexCatalogFor(job.config.providerAccountRef);
  // Popover state for the clickable model + effort chip. Click-outside
  // closes; null hides both.
  const [chipPopover, setChipPopover] = useState<'model' | 'effort' | null>(null);
  const chipRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!chipPopover) return;
    const handler = (e: MouseEvent) => {
      if (chipRef.current && !chipRef.current.contains(e.target as Node)) {
        setChipPopover(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [chipPopover]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeWorkerCount = Object.values(job.workers).filter(
    (w) => w.status === 'running' || w.status === 'spawning'
  ).length;
  const hasActiveWorkers = activeWorkerCount > 0;
  const hasStreaming = job.messages.some((m) => m.isStreaming);
  // Server-authoritative busy flag wins over the local heuristics — it's the
  // one signal that stays true across tool roundtrips (between primary_complete
  // and the next primary_text, when no message is actively streaming).
  const isBusy = (job.busy === true) || hasActiveWorkers || hasStreaming;
  // NATIVE_COMPACTION_PLAN Phase 3 — the worker is mid-compaction; you can't
  // send a turn into it. Greys the send + short-circuits handleSubmit/keydown.
  const isCompacting = job.compacting === true;
  const codexAccount = (job.config.primaryProvider ?? 'claude') === 'codex'
    ? (() => {
        const accounts = settings?.providerAccounts?.codex ?? [];
        const account = (job.config.providerAccountRef
          ? accounts.find((a) => a.id === job.config.providerAccountRef)
          : undefined) ?? accounts[0];
        if (account) {
          return {
            label: account.shortLabel || account.label || account.id,
            title: `${account.label || account.id}${account.id ? ` (${account.id})` : ''}`,
          };
        }
        if (job.config.providerAccountRef) {
          return { label: job.config.providerAccountRef, title: job.config.providerAccountRef };
        }
        return null;
      })()
    : null;

  useEffect(() => {
    inputRef.current?.focus();
  }, [isBusy, job.id]);

  // Auto-grow the textarea with content up to MAX_INPUT_HEIGHT_PX, then scroll
  // within. Default rows={1} (~24px) is too cramped for paragraph-length asks
  // — operators give up partway through composing. We resize on every value
  // change by clearing height first (forces scrollHeight to reflect the
  // shrunken content) then snapping to scrollHeight, capped.

  // Note: no component-level URL revocation. Preview URLs are created in
  // `uploadAndAppend` and revoked in the store's removeAttachment /
  // clearAttachments / removeJob actions. That decouples URL lifetime from
  // React remounts, so a tab switch (which unmounts this component) no
  // longer kills previews for staged-but-not-sent attachments.

  const uploadAndAppend = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    const failed: string[] = [];
    for (const file of files) {
      const result = await onUpload(file);
      if (!result.ok) {
        failed.push(result.error);
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
    if (failed.length > 0) setUploadError(failed.join(' · '));
  }, [onUpload, addAttachment, job.id]);

  // Listen for app-wide drops (DragOverlay dispatches this event). Also
  // handle direct drops on the input area.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { files: File[] } | undefined;
      if (detail?.files?.length) void uploadAndAppend(detail.files);
    };
    window.addEventListener('arco:attach-files', handler);
    return () => window.removeEventListener('arco:attach-files', handler);
  }, [uploadAndAppend]);

  const handleSubmit = (kind?: 'steer' | 'follow-up' | 'interrupt') => submitComposer({
    kind, isCompacting, uploading, readDraft, attachments, provider, isBusy,
    onCompact, addMessage, job, setValue, clearAttachments, onUpdatePrimary,
    planModeArmed, planModeToggleVisible, onArmPlanMode, setPlanModeArmed,
    onSend, pickedSkills, setPickedSkills,
  });

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Don't intercept while an IME composition is in progress — Enter inside
    // an open candidate window (Japanese/Chinese/Korean input) commits the
    // candidate, it must NOT submit. `nativeEvent.isComposing` is the
    // standards-track signal; `e.keyCode === 229` is the legacy fallback
    // some browsers still surface.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    // Phase 4 — Enter / Alt+Enter routing.
    //   Idle + Enter         → send (start a fresh turn)
    //   Busy + Enter         → enqueue as steer (do this now / change direction)
    //   Busy + Alt+Enter     → enqueue as follow-up (after the current task lands)
    //   Busy + Ctrl/Cmd+Enter → interrupt Claude/Codex and send the draft next
    //   Shift+Enter          → newline (preserved at every state)
    // Steer delivery depends on the transport; interrupt waits for teardown.
    if (e.key === 'Enter' && !e.shiftKey) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && isBusy && interruptAvailable) {
        e.preventDefault();
        handleSubmit('interrupt');
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (!isBusy) return; // idle Alt+Enter is a no-op (no queue to land in)
        e.preventDefault();
        handleSubmit('follow-up');
        return;
      }
      if (!e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleSubmit(isBusy ? 'steer' : undefined);
        return;
      }
    }

    if (handleKillLine(e, setValue)) return;

    // Phase 4 — Alt+Up recalls the most-recently-queued message into the
    // editor. Steers and follow-ups share one virtual order; we pick by
    // descending index across both arrays. Replaces the current draft with
    // the recalled content (no merge — a simple recall, like shell history).
    if (e.altKey && e.key === 'ArrowUp' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const q = job.queue;
      const last = q ? (q.followUp[q.followUp.length - 1] ?? q.steering[q.steering.length - 1]) : undefined;
      if (last) {
        e.preventDefault();
        setValue(last.content);
        queueMicrotask(() => {
          const ta = inputRef.current;
          if (ta) ta.selectionStart = ta.selectionEnd = last.content.length;
        });
        return;
      }
    }

    // Phase 4 — Escape behavior depends on busy-state and modifiers.
    //   Busy + Escape         → cancel current turn; if queue is non-empty,
    //                           confirm "Drop N queued messages?" first.
    //   Busy + Shift+Escape   → force-cancel without the prompt.
    //   Idle + Escape (empty) → fall through to the legacy "cancel last
    //                           queued message" affordance (kept for
    //                           muscle-memory parity; rare at idle since
    //                           the queue should be empty post-drain).
    if (e.key === 'Escape' && isBusy) {
      e.preventDefault();
      const queueDepth =
        (job.queue?.steering.length ?? 0) + (job.queue?.followUp.length ?? 0);
      if (queueDepth > 0 && !e.shiftKey) {
        const ok = window.confirm(
          `Drop ${queueDepth} queued message${queueDepth === 1 ? '' : 's'}?\n\nCancelling the in-flight turn drops the queue too. Press Shift+Escape to skip this prompt next time.`,
        );
        if (!ok) return;
      }
      onCancel();
      return;
    }
    if (e.key === 'Escape' && readDraft() === '' && onCancelQueued) {
      for (let i = job.messages.length - 1; i >= 0; i--) {
        const m = job.messages[i];
        if (m.role === 'user' && m.queued) {
          e.preventDefault();
          onCancelQueued(m.id);
          return;
        }
      }
    }
  };

  // Clipboard paste — captures images pasted from screenshot tools or image
  // copies. Non-image items fall through to the textarea's default handler.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pastedFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      void uploadAndAppend(pastedFiles);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) void uploadAndAppend(files);
    e.target.value = ''; // allow re-selecting the same file
  };

  const removeAttachment = (idx: number) => {
    removeAttachmentAction(job.id, idx);
  };

  return (
    <div
      style={{
        borderTop: '1px solid var(--color-border-hairline)',
        background: 'var(--color-bg-input)',
        padding: '10px 20px',
        position: 'relative',
        zIndex: 10,
        flexShrink: 0,
        transition: 'all 0.2s ease',
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileInputChange}
        style={{ display: 'none' }}
      />

      <div data-testid="composer-status-line" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', marginBottom: '6px', minWidth: 0, minHeight: isBusy ? '24px' : undefined }}>
        <NorthStarBar job={job} onUpdatePrimary={onUpdatePrimary} />
        {job.compactedResume && !isCompacting && (
          <span data-help="composer.compact-continue" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <button type="button" disabled={isBusy} title={typeof job.compactedResume.foldedTurns === 'number' ? `Compacted ${job.compactedResume.foldedTurns} turns into a summary. Continue the parked conversation.` : 'Earlier history was folded into a summary. Continue the parked conversation.'} onClick={() => { if (isBusy || isCompacting) return; clearCompacting(job.id); onSend(COMPACT_CONTINUE_PROMPT); }}>COMPACTED: CONTINUE</button>
            <button type="button" title="Dismiss the compacted conversation notice; resume on your own when ready." aria-label="Dismiss compacted notice" onClick={() => clearCompacting(job.id)}>×</button>
          </span>
        )}
        {onCancelQueued && <QueuedMessagesIndicator job={job} onCancel={onCancelQueued} />}
      {/* Standing pins persist in WorkflowConfig/meta.json and are re-injected
          every turn. They remain visible until explicitly removed. */}
      {pinnedSkills.length > 0 && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
            PINNED SKILLS:
          </span>
          {pinnedSkills.map((s) => (
            <span
              key={`${s.scope}:${s.slug}`}
              className="display-font"
              title={`Standing skill · applied every turn · ${s.scope}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '9px', letterSpacing: '0.5px',
                color: 'var(--color-accent-primary)', border: '1px solid var(--color-accent-primary)',
                borderRadius: '3px', padding: '2px 6px',
              }}
            >
              ◉ {skillDisplayName(s.scope, s.slug)}
              <button
                onClick={() => setSkillPinned(s, false)}
                title="Unpin this skill"
                style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: '11px', lineHeight: 1 }}
              >×</button>
            </span>
          ))}
        </div>
      )}

      {/* One-shot picks inline into the next turn only, then clear. */}
      {pickedSkills.length > 0 && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
            INLINE SKILLS:
          </span>
          {pickedSkills.map((s) => (
            <span
              key={`${s.scope}:${s.slug}`}
              className="display-font"
              title={`Inline "${s.name}" (${s.scope}) into the next turn`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '9px',
                letterSpacing: '0.5px',
                color: 'var(--color-accent-secondary)',
                border: '1px solid var(--color-accent-secondary)',
                borderRadius: '3px',
                padding: '2px 6px',
              }}
            >
              {s.name}
              <button
                onClick={() => togglePickedSkill(s)}
                title="Remove"
                style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: '11px', lineHeight: 1 }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* docs/PROVIDERS.md - always-visible reminder that this tab is in sticky
          ultracode: every turn authors a Workflow + fans out a subagent fleet,
          unattended + heavy-spend. Toggle in CONFIG → TRANSPORT. */}
      {ultracodeActive && (
        <button
          type="button"
          data-help="rightpanel.config.transport"
          onClick={(event) => useAppStore.getState().setActiveHelpPopover({ key: 'rightpanel.config.transport', anchorRect: event.currentTarget.getBoundingClientRect().toJSON() })}
          className="display-font"
          title="Ultracode is ON for this tab: every turn fans out a subagent fleet (CLI + Workflow + xhigh). Toggle in CONFIG → TRANSPORT."
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '9px',
            letterSpacing: '1.5px',
            color: 'var(--color-accent-primary)',
            border: '1px solid var(--color-accent-primary)',
            background: 'var(--color-accent-primary-a10, transparent)',
            borderRadius: '3px',
            padding: '3px 8px',
            width: 'fit-content',
            cursor: 'pointer',
          }}
        >
          ⚡ ULTRACODE
          {fleetLive ? (
            <span style={{ color: 'var(--color-fg-muted)', letterSpacing: '0.5px', fontFamily: 'var(--font-body)', fontSize: '10px' }}>
              <span style={{ color: 'var(--color-accent-primary)' }}>
                {ultracodeFleet!.done}/{ultracodeFleet!.total} agents
              </span>
              {ultracodeFleet!.running > 0 ? ` · ${ultracodeFleet!.running} running` : ' · done'}
            </span>
          ) : (
            <span style={{ color: 'var(--color-fg-muted)', letterSpacing: '0.5px', fontFamily: 'var(--font-body)', fontSize: '10px' }}>
              fleet · unattended · heavy spend
            </span>
          )}
        </button>
      )}

      </div>

      {/* DD7 — project-trust prompt. This repo ships CLAUDE.md / project skills /
          .arco/settings.json that Arco SUPPRESSED from the turn until the
          operator vouches for it (the cloned-repo prompt-injection vector). The
          turn already ran with them suppressed; trusting folds them in next turn.
          Operator-prompt only: no auto-grant. */}
      {job.projectTrustPrompt && onSetProjectTrust && (
        <div
          data-help="composer.project-trust"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            marginBottom: '8px',
            padding: '7px 12px',
            border: '1px solid var(--color-accent-warning, var(--color-accent-primary-dim))',
            borderRadius: '3px',
            background: 'var(--color-accent-primary-a15, transparent)',
          }}
        >
          <span className="display-font" style={{ fontSize: '11px', letterSpacing: '0.5px', color: 'var(--color-fg-muted)', flex: 1 }}>
            ⚠ UNTRUSTED PROJECT: suppressed from the turn: {job.projectTrustPrompt.resources.join(', ')}. Trust this repo to fold them in (next turn).
          </span>
          <button
            onClick={() => onSetProjectTrust(job.projectTrustPrompt!.cwd, 'always')}
            className="display-font"
            title="Record this repo as trusted in ~/.arco/trust.json. Its CLAUDE.md / project skills / project settings fold into future turns. Reversible: edit trust.json to revoke."
            style={{
              padding: '4px 12px',
              background: 'transparent',
              border: '1px solid var(--color-accent-primary)',
              borderRadius: '3px',
              color: 'var(--color-accent-primary)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
          >
            ▸ TRUST
          </button>
          <button
            onClick={() => onSetProjectTrust(job.projectTrustPrompt!.cwd, 'never')}
            className="display-font"
            title="Record this repo as never-trusted. Its project resources stay suppressed and you won't be prompted again."
            style={{
              padding: '4px 8px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
          >
            NEVER
          </button>
        </div>
      )}

      {/* §D1 — context-refs chip bar. One chip per `@`-ref parsed from the
          draft, with a × remove affordance that strips the ref span from the
          composer. Purely visual: the server re-parses + expands at send. */}
      <ContextRefChips jobId={job.id} onRemove={removeContextRef} />

      {uploadError && (
        <div
          role="alert"
          style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', color: 'var(--color-warning)', fontSize: '11px' }}
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

      {/* Attachments bar */}
      {attachments.length > 0 && (
        <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' }}>
          {attachments.map((a, i) => (
            <span
              key={i}
              className="display-font"
              style={{
                fontSize: '10px',
                padding: '3px 8px',
                border: '1px solid var(--color-accent-secondary)',
                borderRadius: '3px',
                color: 'var(--color-accent-secondary-dim)',
                letterSpacing: '0.5px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              {a.previewUrl && (
                <img
                  src={a.previewUrl}
                  alt={a.filename}
                  style={{
                    width: '28px',
                    height: '28px',
                    objectFit: 'cover',
                    borderRadius: '2px',
                    border: '1px solid var(--color-border-hairline)',
                  }}
                />
              )}
              {a.filename}
              <button
                onClick={() => removeAttachment(i)}
                style={{ background: 'none', border: 'none', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '11px', padding: 0 }}
                title="Remove attachment"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Plan-mode arming row — operator-controlled entry into plan mode.
          Mirrors the worker's EnterPlanMode tool call but starts the next
          turn already gated, regardless of model behavior. Only rendered
          for Claude Native (toggle is meaningless on CLI / other
          providers). Auto-clears on send. */}
      {planModeToggleVisible && (
        <div
          className="display-font"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '6px',
            padding: '4px 8px',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            fontSize: '10px',
            letterSpacing: '1px',
            color: planModeArmed ? 'var(--color-warning)' : 'var(--color-accent-secondary-dim)',
            cursor: 'pointer',
            userSelect: 'none',
            width: 'fit-content',
          }}
          title="Arm plan mode for the next turn: Write/Edit tools stay disabled until the model calls ExitPlanMode. Auto-clears on send."
          onClick={() => setPlanModeArmed((v) => !v)}
        >
          <input
            type="checkbox"
            checked={planModeArmed}
            onChange={(e) => setPlanModeArmed(e.target.checked)}
            style={{ margin: 0, cursor: 'pointer', accentColor: 'var(--color-warning)' }}
            onClick={(e) => e.stopPropagation()}
          />
          <span>⛔ PLAN MODE: GATE WRITE TOOLS FOR NEXT TURN</span>
        </div>
      )}

      {/* Send choices wrap below the draft so both stay visible at narrow widths. */}
      <div
        className="glow-border"
        data-help="composer.input"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          border: '1px solid var(--color-border-bright)',
          borderRadius: '4px',
          padding: '8px 12px',
          background: 'var(--color-bg-sunken)',
        }}
      >
        <span
          className="display-font glow-text"
          style={{
            marginRight: '10px',
            marginTop: '2px',
            fontSize: '14px',
            userSelect: 'none',
            color: isBusy ? 'var(--color-warning)' : 'var(--color-accent-primary)',
          }}
        >
          {isBusy ? '...' : '>'}
        </span>

        <ComposerTextarea
          jobId={job.id}
          inputRef={inputRef}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={isCompacting}
          isBusy={isBusy}
          placeholder={
            uploading
              ? 'Uploading file...'
              : isCompacting
                ? 'Compacting conversation… composer is locked until it finishes'
                : isBusy
                  ? interruptAvailable ? '↵ steer · ⌥↵ follow-up · Ctrl/⌘↵ interrupt & send' : '↵ steer · ⌥↵ follow-up · ⎋ cancel turn'
                  : planModeArmed && planModeToggleVisible
                    ? 'Type your task: plan mode armed for next turn'
                    : (clusterControls?.placeholder ?? 'Enter command... (drop / paste / attach files anywhere)')
          }
        />

        <div style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', alignItems: 'center',
          justifyContent: 'flex-end', gap: '6px', marginTop: '6px' }}>
        {isBusy && (
          <span
            className="display-font"
            title={`busy=${job.busy === true ? 1 : 0} · workers=${activeWorkerCount} · streaming=${hasStreaming ? 1 : 0}: which flag is keeping the composer in queue mode`}
            style={{
              marginLeft: '6px',
              padding: '3px 6px',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-fg-muted)',
              fontSize: '10px',
              letterSpacing: '0.5px',
              whiteSpace: 'nowrap',
              opacity: 0.7,
            }}
          >
            b{job.busy === true ? 1 : 0}·w{activeWorkerCount}·s{hasStreaming ? 1 : 0}
          </span>
        )}

        <TidyComposer key={job.id} jobId={job.id} disabled={uploading || isCompacting} />
        <ComposerSendButtons jobId={job.id} blocked={uploading || isCompacting}
          hasAttachments={attachments.length > 0} busy={isBusy} canInterrupt={interruptAvailable}
          onSend={() => handleSubmit(isBusy ? 'steer' : undefined)} onInterrupt={() => handleSubmit('interrupt')} />
        {isBusy && (
          <button
            onClick={onCancel}
            data-help="composer.cancel"
            className="display-font"
            title="Cancel current primary turn + kill in-flight workers"
            style={{
              marginLeft: '6px',
              padding: '3px 10px',
              background: 'transparent',
              border: '1px solid var(--color-warning)',
              borderRadius: '3px',
              color: 'var(--color-warning)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
          >
            ✕ CANCEL
          </button>
        )}
        </div>
      </div>

      <MessageSelectionBar jobId={job.id} onSecondOpinion={() => {
        const picked = new Set(useMessageSelectionStore.getState().selected[job.id] ?? []);
        const excerpt = job.messages.filter((m) => picked.has(m.id)).map((m) => formatRow(m, job.config.name)).filter(Boolean).join('\n\n');
        openCompareDialog(job.id, excerpt);
      }} onForward={onTranscriptSend && clusterForJob && clusterForJob.members.length > 1 ? () => setShowForwardDialog(true) : undefined} />

      {/* Toolbar row — permanent second line. Primitives on the left,
          live status + tokens on the right. Stays visible at narrow widths
          because it's below the prompt instead of competing with it. Outside
          the Standard layout it stays on one line and the tools that do not
          fit move into MORE (client/src/layout/ToolbarOverflow.tsx). */}
      <div
        ref={toolbarRef}
        data-testid="composer-toolbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          marginTop: '4px',
          padding: '0 4px',
          flexWrap: toolbarOneLine ? 'nowrap' : 'wrap',
        }}
      >
        <span data-help="composer.attach" style={{ display: 'inline-flex' }}>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          title="Attach file"
          className="display-font"
          style={{
            padding: '3px 8px',
            background: 'transparent',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: uploading ? 'var(--color-fg-muted)' : 'var(--color-accent-secondary-dim)',
            cursor: uploading ? 'not-allowed' : 'pointer',
            fontSize: '10px',
            letterSpacing: '1px',
            whiteSpace: 'nowrap',
          }}
        >
          + FILE
        </button>
        </span>

        {hubLinked && onUpdatePrimary && (
          <button
            onClick={() => onUpdatePrimary({ remoteEnabled: !remoteEnabled })}
            data-help="composer.remote"
            className="display-font"
            title={remoteEnabled
              ? 'This workflow is monitored remotely: it shows in the management console and pushes phone notifications. Click to stop sharing it.'
              : 'Share this workflow to the management hub: monitor / respond / get notified from your phone. Off by default.'}
            style={{
              padding: '3px 8px',
              background: remoteEnabled ? 'var(--color-accent-secondary-a30, transparent)' : 'transparent',
              border: `1px solid ${remoteEnabled ? 'var(--color-accent-secondary)' : 'var(--color-border-hairline)'}`,
              borderRadius: '3px',
              color: remoteEnabled ? 'var(--color-accent-secondary)' : 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
          >
            {remoteEnabled ? '◉ REMOTE' : '◎ REMOTE: OFF'}
          </button>
        )}

        {hubLinked && remoteEnabled && reviewSafeOn && onUpdatePrimary && (
          <button
            onClick={() => onUpdatePrimary({ remoteGatesEnabled: !remoteGatesEnabled })}
            data-help="composer.remote-gates"
            className="display-font"
            title={remoteGatesEnabled
              ? 'Review gates can be approved/rejected from the phone console. Click to make them desk-only again.'
              : 'Allow approving/rejecting parked review gates from the phone console. Off by default: remote conversation never implies remote approval authority.'}
            style={{
              padding: '3px 8px',
              background: remoteGatesEnabled ? 'var(--color-accent-secondary-a30, transparent)' : 'transparent',
              border: `1px solid ${remoteGatesEnabled ? 'var(--color-accent-secondary)' : 'var(--color-border-hairline)'}`,
              borderRadius: '3px',
              color: remoteGatesEnabled ? 'var(--color-accent-secondary)' : 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
          >
            {remoteGatesEnabled ? '⛨ GATES' : '⛨ GATES: DESK'}
          </button>
        )}

        {compactVisible && (
          <button
            onClick={() => { if (!isBusy) onCompact?.(); }}
            disabled={isBusy}
            data-help="composer.compact"
            className="display-font"
            title={isBusy
              ? 'Compact runs between turns: wait for the current turn to finish.'
              : provider === 'codex'
                ? 'Native /compact: Codex summarizes earlier thread history server-side so the next turn starts with a smaller prompt. App-server compact path; far cheaper than a Handoff.'
                : provider === 'cursor'
                  ? 'Native /compress: Cursor summarizes older conversation context inside the live ACP session. Arco sends the slash command without cluster or north-star prompt prefixes.'
                : provider === 'ollama'
                  ? 'Compact context on next turn: the local model has no resident session to compact between turns, so this arms a compaction that runs at the start of your next message. Far cheaper than a Handoff (same tab, no doc).'
                  : 'Native /compact: summarize the conversation in place and continue with a smaller prompt. Same idea as Claude Code’s /compact; far cheaper than a Handoff (same tab, no doc).'}
            style={{
              padding: '3px 8px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: isBusy ? 'var(--color-fg-muted)' : 'var(--color-accent-primary)',
              cursor: isBusy ? 'default' : 'pointer',
              opacity: isBusy ? 0.5 : 1,
              fontSize: '10px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
          >
            ⊟ COMPACT
          </button>
        )}

        {foldVisible && (
          <button
            onClick={() => { if (!isBusy) onFold?.(); }}
            disabled={isBusy}
            data-help="composer.fold"
            className="display-font"
            title={isBusy
              ? 'Fold runs between turns: wait for the current turn to finish.'
              : 'Fold: deterministically trim older history into a digest + keep a verbatim recent tail, same session, instantly (no model round). Cheaper than Compact (no summarization call) and Handoff (no fresh worker). Raw transcript stays in events.jsonl.'}
            style={{
              padding: '3px 8px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: isBusy ? 'var(--color-fg-muted)' : 'var(--color-accent-primary)',
              cursor: isBusy ? 'default' : 'pointer',
              opacity: isBusy ? 0.5 : 1,
              fontSize: '10px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
          >
            ⊞ FOLD
          </button>
        )}

        {foldVisible && (
          <button
            onClick={() => { if (!isBusy) onFold?.('server'); }}
            disabled={isBusy}
            data-help="composer.serverFold"
            className="display-font"
            title={isBusy
              ? 'Server Fold runs between turns: wait for the current turn to finish.'
              : 'Server Fold: one Anthropic on-demand compaction call summarizes older turns into a signed server summary; the last 2 turns stay verbatim (thinking preserved). Spends one summarization call (tokens shown in the notice). Falls back to the deterministic Fold if unavailable. Undo via HISTORY rewind.'}
            style={{
              padding: '3px 8px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: isBusy ? 'var(--color-fg-muted)' : 'var(--color-accent-primary)',
              cursor: isBusy ? 'default' : 'pointer',
              opacity: isBusy ? 0.5 : 1,
              fontSize: '10px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
          >
            ⊞ S-FOLD
          </button>
        )}

        {postureVisible && (
          <button
            onClick={() => {
              const next = POSTURE_CYCLE[(POSTURE_CYCLE.indexOf(currentPosture as typeof POSTURE_CYCLE[number]) + 1) % POSTURE_CYCLE.length];
              onSetToolPosture?.(next);
            }}
            data-help="composer.posture"
            className="display-font"
            title={'Tool posture (session-local, next turn): full = all tools; coding = no web research; review = read/inspect/run only (no Write/Edit/Task/web); chat = read-only lookup. Cuts tool-def tokens + attention. Reverts to full on reload. Click to cycle.'}
            style={{
              padding: '3px 8px',
              background: currentPosture === 'full' ? 'transparent' : 'var(--color-accent-primary)',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: currentPosture === 'full' ? 'var(--color-fg-muted)' : 'var(--color-bg-primary)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
          >
            ⌗ {currentPosture.toUpperCase()}
          </button>
        )}

        {onReview && (
          <button
            onClick={() => setShowReviewDialog(true)}
            data-help="actions.review"
            className="display-font"
            title="Run a reviewer over the last turn"
            style={{
              padding: '3px 8px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-accent-secondary-dim)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
          >
            ✎ REVIEW
          </button>
        )}

        {onHandoff && (
          <button
            onClick={() => setShowHandoffDialog(true)}
            data-help="actions.handoff"
            className="display-font"
            title={'Rotate session: archive current, pre-warm fresh session with handoff context'}
            style={{
              padding: '3px 8px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-accent-secondary-dim)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
          >
            ⤭ HANDOFF
          </button>
        )}

        {onSpawn && (
          <button
            onClick={() => setShowSpawnDialog(true)}
            data-help="actions.spawn"
            className="display-font"
            title="Spawn from here: fork this tab into a new tab seeded with current context"
            style={{
              padding: '3px 8px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-accent-secondary-dim)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
          >
            ⎇ SPAWN
          </button>
        )}

        {onTranscriptSend && clusterForJob && clusterForJob.members.length > 1 && (
          <button
            onClick={() => setShowTranscriptDialog(true)}
            data-help="cluster.transcript-send"
            className="display-font"
            title="Send a chat-feed slice (full / last turn / last N turns) to another cluster member as a peer message"
            style={{
              padding: '3px 8px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-accent-secondary-dim)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
          >
            → TRANSCRIPT
          </button>
        )}

        <BriefControl scope="worker" targetId={job.id} clusterId={clusterControls ? clusterControls.clusterId : undefined} label="BRIEF" data-help="composer.brief" testId="composer-brief" title="A short synopsis of this worker from facts Arco can see. Read-only; sends nothing." />

        <button
          onClick={() => setShowPlanDialog(true)}
          data-help="composer.plan"
          className="display-font"
          title="Draft a project plan from this conversation and attach it to this workflow. A plan can keep the next steps in one place."
          style={{
            padding: '3px 8px',
            background: 'transparent',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: 'var(--color-accent-secondary-dim)',
            cursor: 'pointer',
            fontSize: '10px',
            letterSpacing: '1px',
            whiteSpace: 'nowrap',
          }}
        >
          ☰ PLAN
        </button>

        {onSpawn && (
        <button
          onClick={() => setShowDocsDialog(true)}
          data-help="composer.docs"
          className="display-font"
          title="Ask an agent to update repo docs (README, DEVLOG, etc.): explicitly excludes plan files"
          style={{
            padding: '3px 8px',
            background: 'transparent',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: 'var(--color-accent-secondary-dim)',
            cursor: 'pointer',
            fontSize: '10px',
            letterSpacing: '1px',
            whiteSpace: 'nowrap',
          }}
        >
          ✎ DOCS
        </button>
        )}

        {job.config.workingDirectory && onSpawn && (
          <button
            onClick={() => setShowGitDialog(true)}
            data-help="composer.git"
            className="display-font"
            title="Commit, push, open PR, or switch branch: bakes your decisions into the prompt"
            style={{
              padding: '3px 8px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-accent-secondary-dim)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
          >
            ⎇ GIT
          </button>
        )}

        {job.config.workingDirectory && (
          <button
            onClick={() => setShowTuneupDialog(true)}
            data-help="composer.tuneup"
            className="display-font"
            title="Compact this project's agent-instruction file (CLAUDE.md / AGENTS.md): proposes a tightened version as a diff; backs up the original before writing"
            style={{
              padding: '3px 8px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-accent-secondary-dim)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
          >
            ✦ TUNE MD
          </button>
        )}

        {onResearch && (
          <button
            onClick={() => setShowResearchDialog(true)}
            data-help="composer.research"
            className="display-font"
            title="Run a bounded web-research turn: plan, search, read, and write a cited markdown report into the RESEARCH tab"
            style={{
              padding: '3px 8px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-accent-secondary-dim)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
          >
            ⌕ RESEARCH
          </button>
        )}

        {/* §B1 — COMPARE: race one prompt across N read-only legs. Store-driven
            (no prop) so the handler stays out of this near-cap file; the dialog
            + grid are globally mounted. */}
        <button
          onClick={() => openCompareDialog(job.id)}
          data-help="composer.compare"
          className="display-font"
          title="Ask several models, independently, to draft the reply you could send to this worker. Nothing is sent; USE THIS REPLY puts the one you pick in the composer."
          style={{
            padding: '3px 8px',
            background: 'transparent',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: 'var(--color-accent-secondary-dim)',
            cursor: 'pointer',
            fontSize: '10px',
            letterSpacing: '1px',
            whiteSpace: 'nowrap',
          }}
        >
          ⚖ SECOND OPINION
        </button>

        {toolbarOneLine && <ToolbarMore row={toolbarRef} hidden={toolbarHidden} />}
        {!isBusy && <div style={{ flex: 1 }} />}

        {isBusy && <PrimaryStatus job={job} />}
        <PendingQuestionsButton workflowId={job.id} />
      </div>

      {/* Hint row — keyboard shortcuts + toolbox. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', rowGap: '6px', marginTop: '4px', fontSize: '10px', fontFamily: 'var(--font-display)', color: 'var(--color-fg-muted)', letterSpacing: '1px', padding: '0 4px' }}>
        <span style={{ flex: '1 1 220px', minWidth: 0 }}>
          <span ref={chipRef} data-help="composer.footer.model" style={{ position: 'relative', color: 'var(--color-accent-primary)', opacity: 0.85 }}>
            {String(job.config.primaryProvider ?? 'claude').toUpperCase()}
            {codexAccount && (
              <span
                title={`Codex profile: ${codexAccount.title}`}
                style={{ color: 'var(--color-accent-secondary)', marginLeft: 6 }}
              >
                [{codexAccount.label.toUpperCase()}]
              </span>
            )}
            {' · '}
            {(() => {
              // Clickable model segment — opens a popover listing the
              // provider's catalog. Click → onUpdatePrimary({model}).
              // Resolved-vs-requested badge inline when they differ.
              const requested = String(job.config.primaryModel);
              const resolved = job.resolvedPrimaryModel;
              const mismatch = resolved && resolved !== requested;
              const tooltip = !resolved
                ? 'Click to change model · awaiting first response to verify'
                : mismatch
                  ? `Click to change model · requested ${requested} → server echoed ${resolved}`
                  : `Click to change model · verified ${resolved}`;
              return (
                <button
                  type="button"
                  className="display-font"
                  onClick={() => setChipPopover((p) => (p === 'model' ? null : 'model'))}
                  title={tooltip}
                  style={{
                    background: chipPopover === 'model' ? 'var(--color-accent-primary-a10, transparent)' : 'transparent',
                    border: '1px solid transparent',
                    color: 'inherit',
                    padding: '0 4px',
                    fontFamily: 'inherit',
                    fontSize: 'inherit',
                    letterSpacing: 'inherit',
                    cursor: 'pointer',
                    borderRadius: '2px',
                  }}
                >
                  {requested.toUpperCase()}
                  {mismatch && <span style={{ color: 'var(--color-warning)', marginLeft: 4 }}>↪ {resolved.toUpperCase()}</span>}
                </button>
              );
            })()}
            {/* Cursor bakes effort into the model id (grok-4.5-HIGH) and the
                worker ignores primaryEffort, so a separate "@ HIGH" chip is
                redundant AND misleading: change effort via the MODEL picker
                instead. Every other provider carries effort separately. */}
            {job.config.primaryProvider !== 'cursor' && <>
            {' @ '}
            <button
              type="button"
              className="display-font"
              onClick={() => setChipPopover((p) => (p === 'effort' ? null : 'effort'))}
              title="Click to change effort"
              style={{
                background: chipPopover === 'effort' ? 'var(--color-accent-primary-a10, transparent)' : 'transparent',
                border: '1px solid transparent',
                color: 'inherit',
                padding: '0 4px',
                fontFamily: 'inherit',
                fontSize: 'inherit',
                letterSpacing: 'inherit',
                cursor: 'pointer',
                borderRadius: '2px',
              }}
            >
              {String(job.config.primaryEffort).toUpperCase()}
            </button>
            </>}
            {chipPopover && (
              <ChipPopover
                kind={chipPopover}
                provider={job.config.primaryProvider ?? 'claude'}
                model={job.config.primaryModel}
                effort={job.config.primaryEffort}
                claudeCatalog={claudeNativeCatalog}
                codexCatalog={codexCatalog}
                onPick={(update) => {
                  onUpdatePrimary?.(update);
                  setChipPopover(null);
                }}
                onClose={() => setChipPopover(null)}
              />
            )}
            {job.config.primaryProvider === 'llamacpp' && (() => {
              // Loaded-vs-selected indicator. Three states the operator cares
              // about: loaded (fast next turn), wrong-model loaded (next turn
              // pays the switch cost), idle (next turn pays cold-start).
              //
              // Worker-running override: if a turn is in flight against this
              // workflow, the lifecycle manager has *already* called
              // ensureLoaded(selected) and blocked on /health — the model is
              // definitely loaded, even if our 15s poll hasn't caught up.
              // Without this override the indicator says "WILL LOAD" mid-turn
              // when polling is stale, which is wrong and confusing.
              const selected = String(job.config.primaryModel);
              const polled = llamacppLive?.loadedModel ?? null;
              const loaded = isBusy ? selected : polled;
              if (loaded === selected) {
                return <span style={{ marginLeft: 6, color: 'var(--color-accent-secondary)', fontSize: '9px' }}>(LOADED)</span>;
              }
              if (loaded) {
                return <span style={{ marginLeft: 6, color: 'var(--color-warning)', fontSize: '9px' }}>(SWITCH FROM "{loaded.toUpperCase()}")</span>;
              }
              return <span style={{ marginLeft: 6, color: 'var(--color-fg-muted)', fontSize: '9px' }}>(WILL LOAD ON NEXT TURN)</span>;
            })()}
          </span>
          <span style={{ opacity: 0.5 }}>{'  ·  '}</span>
          DROP / PASTE TO ATTACH · SHIFT+ENTER FOR NEWLINE
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', justifyContent: 'flex-start' }}>
          {onBackToCluster && (
            <button
              type="button"
              onClick={onBackToCluster}
              data-help="composer.back-to-cluster"
              className="display-font"
              title="Activate this workflow's cluster tab"
              style={{
                padding: '2px 8px',
                background: 'transparent',
                border: '1px solid var(--color-border-hairline)',
                color: 'var(--color-fg-muted)',
                cursor: 'pointer',
                fontSize: '10px',
                letterSpacing: '1.5px',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-accent-primary)';
                (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-accent-primary)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-border-hairline)';
                (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-fg-muted)';
              }}
            >
              ← BACK TO CLUSTER
            </button>
          )}
          {/* DD8 — inline an Arco skill (incl. operator-only ones, hidden from
              the model manifest) into the next turn. */}
          {clusterControls && <ClusterComposerButtons controls={clusterControls} />}
          <div ref={skillMenuRef} style={{ position: 'relative' }} data-help="composer.skills">
            <button
              onClick={() => setSkillMenuOpen((v) => !v)}
              title="Choose skills to apply once, pin to this tab, or insert a supported agent skill."
              className="display-font"
              style={{
                padding: clusterControls ? '7px 18px' : '3px 10px',
                background: skillMenuOpen ? 'var(--color-accent-secondary-a12)' : 'transparent',
                border: `1px solid ${skillMenuOpen ? 'var(--color-accent-secondary)' : 'var(--color-border-hairline)'}`,
                borderRadius: '3px',
                color: skillMenuOpen ? 'var(--color-accent-secondary)' : 'var(--color-accent-secondary-dim)',
                cursor: 'pointer',
                fontSize: clusterControls ? '12px' : '10px',
                letterSpacing: clusterControls ? '1.5px' : '1px',
                fontWeight: clusterControls ? 600 : undefined,
                whiteSpace: 'nowrap',
              }}
            >
              SKILLS{(pickedSkills.length > 0 || pinnedSkills.length > 0) && (
                <span style={{ opacity: 0.6 }}> [{pickedSkills.length}×1 · {pinnedSkills.length} PIN]</span>
              )}
            </button>
            {skillMenuOpen && (
              <div
                ref={skillMenuPlaceRef}
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 6px)',
                  right: 0,
                  width: 'min(340px, calc(100vw / var(--ui-scale, 1) - 24px))',
                  maxHeight: '300px',
                  overflowY: 'auto',
                  background: 'var(--color-bg-elevated)',
                  border: '1px solid var(--color-accent-secondary)',
                  borderRadius: '4px',
                  boxShadow: '0 0 18px var(--color-accent-secondary-a25)',
                  zIndex: 20,
                }}
              >
                <div className="display-font" style={{ padding: '9px 10px', color: 'var(--color-fg-muted)', fontSize: '9px', letterSpacing: '1px' }}>YOUR SKILLS</div>
                <button type="button" onClick={() => setShowSkillEditor(true)} className="display-font" style={{ margin: '0 0 8px 10px', padding: '4px 8px', cursor: 'pointer' }}>NEW SKILL</button>
                <button type="button" data-help="composer.skills.import" onClick={() => { setShowSkillImport(true); setSkillMenuOpen(false); }} className="display-font" style={{ margin: '0 10px 8px 6px', padding: '4px 8px', cursor: 'pointer' }}>IMPORT</button>
                {skillCatalogStatus === 'loading' ? (
                  <div style={{ padding: '14px', color: 'var(--color-fg-muted)', fontSize: '11px' }}>Loading skills...</div>
                ) : skillCatalogStatus === 'error' ? (
                  <div style={{ padding: '14px', color: 'var(--color-error)', fontSize: '11px' }}>Could not load skills. Close and reopen this menu to retry.</div>
                ) : availableSkills.length === 0 ? (
                  <div style={{ padding: '14px', textAlign: 'center', color: 'var(--color-fg-muted)', fontSize: '11px', letterSpacing: '1px' }} className="display-font">
                    A skill is reusable guidance for an agent. Skills are stored in this project's .arco/skills or your home .arco/skills folder.
                  </div>
                ) : (
                  availableSkills.map((s) => {
                    const picked = pickedSkills.some((p) => p.scope === s.scope && p.slug === s.slug);
                    const pinned = pinnedSkills.some((p) => p.scope === s.scope && p.slug === s.slug);
                    return (
                      <div
                        key={`${s.scope}:${s.slug}`}
                        style={{
                          display: 'block', width: '100%', padding: '8px 10px', textAlign: 'left',
                          background: pinned ? 'var(--color-accent-primary-a08)' : picked ? 'var(--color-accent-secondary-a12)' : 'transparent',
                          borderBottom: '1px solid var(--color-accent-secondary-a08)',
                          color: 'var(--color-accent-primary)', fontFamily: 'var(--font-body)',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                          <span style={{ fontSize: '11px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-display)', letterSpacing: '1px' }}>
                            {pinned ? '◉ ' : picked ? '✓ ' : ''}{s.name}
                          </span>
                          {s.operatorOnly && (
                            <span className="display-font" style={{ fontSize: '7px', letterSpacing: '1px', color: 'var(--color-warning)', border: '1px solid var(--color-warning)', borderRadius: '2px', padding: '0 3px' }}>
                              OPERATOR
                            </span>
                          )}
                          <span style={{ fontSize: '8px', color: 'var(--color-fg-muted)', marginLeft: 'auto', letterSpacing: '1px' }} className="display-font">
                            {s.scope.toUpperCase()}
                          </span>
                        </div>
                        {s.description && (
                          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', lineHeight: 1.4 }}>
                            {s.description.length > 120 ? `${s.description.slice(0, 120)}…` : s.description}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: '6px', marginTop: '7px' }}>
                          <button
                            onClick={() => togglePickedSkill(s)}
                            disabled={pinned}
                            title={pinned ? 'Already active on every turn' : 'Apply this skill to the next turn only'}
                            className="display-font"
                            style={{
                              flex: 1, padding: '3px 5px', borderRadius: '2px', cursor: pinned ? 'not-allowed' : 'pointer',
                              border: '1px solid var(--color-accent-secondary)', background: picked ? 'var(--color-accent-secondary-a18)' : 'transparent',
                              color: pinned ? 'var(--color-fg-muted)' : 'var(--color-accent-secondary)', fontSize: '8px', letterSpacing: '0.8px',
                            }}
                          >
                            {picked ? '✓ APPLY ONCE' : 'APPLY ONCE'}
                          </button>
                          <button
                            onClick={() => setSkillPinned(s, !pinned)}
                            disabled={!onUpdatePrimary}
                            title={pinned ? 'Stop applying this skill every turn' : 'Apply every turn until removed'}
                            className="display-font"
                            style={{
                              flex: 1, padding: '3px 5px', borderRadius: '2px', cursor: onUpdatePrimary ? 'pointer' : 'not-allowed',
                              border: '1px solid var(--color-accent-primary)', background: pinned ? 'var(--color-accent-primary-a15)' : 'transparent',
                              color: 'var(--color-accent-primary)', fontSize: '8px', letterSpacing: '0.8px',
                            }}
                          >
                            {pinned ? '× UNPIN' : '◉ PIN TO TAB'}
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
                {builtinSkills.length > 0 && (
                  <div data-testid="builtin-skills">
                    <div className="display-font" style={{ padding: '9px 10px 4px', color: 'var(--color-fg-muted)', fontSize: '9px', letterSpacing: '1px' }}>BUILT-IN</div>
                    {builtinSkills.map((s) => (
                      <div key={`builtin:${s.slug}`} style={{ padding: '8px 10px', borderBottom: '1px solid var(--color-accent-secondary-a08)', color: 'var(--color-accent-primary)', fontFamily: 'var(--font-body)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                          <span style={{ fontSize: '11px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-display)', letterSpacing: '1px' }}>{s.name}</span>
                          <span className="display-font" style={{ fontSize: '7px', letterSpacing: '1px', color: 'var(--color-warning)', border: '1px solid var(--color-warning)', borderRadius: '2px', padding: '0 3px' }}>{s.replaced ? 'REPLACED BY YOUR COPY' : s.off ? 'OFF' : s.operatorOnly ? 'OPERATOR' : 'MODEL'}</span>
                        </div>
                        <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', lineHeight: 1.4 }}>{s.description}</div>
                        <div style={{ display: 'flex', gap: '6px', marginTop: '7px' }}>
                          <button type="button" data-help="composer.skills.run-builtin" disabled={s.off || s.replaced} onClick={() => runBuiltinSkill(s)} title="Run this skill in this conversation" className="display-font" style={{ flex: 1, padding: '3px 5px', borderRadius: '2px', cursor: 'pointer', border: '1px solid var(--color-accent-secondary)', background: 'transparent', color: 'var(--color-accent-secondary)', fontSize: '8px', letterSpacing: '0.8px' }}>RUN</button>
                          <button type="button" data-help="composer.skills.copy-builtin" onClick={() => void copyBuiltinSkill(s)} title="Save an editable copy to your skills" className="display-font" style={{ flex: 1, padding: '3px 5px', borderRadius: '2px', cursor: 'pointer', border: '1px solid var(--color-accent-primary)', background: 'transparent', color: 'var(--color-accent-primary)', fontSize: '8px', letterSpacing: '0.8px' }}>EDITABLE COPY</button>
                        </div>
                      </div>
                    ))}
                    {builtinNote && <div role="status" style={{ padding: '6px 10px', fontSize: '10px', color: 'var(--color-fg-muted)' }}>{builtinNote}</div>}
                  </div>
                )}
                <ToolboxMenu
                  provider={job.config.primaryProvider ?? 'claude'}
                  workflowId={job.id}
                  transport={(job.config.primaryProvider ?? 'claude') === 'claude'
                    ? (job.config.claudeTransport ?? settings?.claude?.transport)
                    : job.config.primaryProvider === 'codex'
                      ? (job.config.codexTransport ?? settings?.codex?.transport ?? 'exec')
                      : undefined}
                  cwd={job.config.workingDirectory}
                  providerAccountRef={job.config.providerAccountRef}
                  onPick={(entry: ToolboxEntry) => {
                    const prefix = `${entry.invocation} `;
                    const value = readDraft(); setValue(value.startsWith(prefix) ? value : prefix + value);
                    setSkillMenuOpen(false);
                    inputRef.current?.focus();
                  }}
                />
              </div>
            )}
          </div>
          <span>{isBusy ? '↵ STEER · ⌥↵ FOLLOW-UP' : 'ENTER TO SEND'}</span>
        </div>
      </div>

      <DialogPortal>
      {showSkillImport && (
        <SkillImportDialog cwd={job.config.workingDirectory ?? ''} onClose={() => setShowSkillImport(false)} onImported={() => { setShowSkillImport(false); setSkillCatalogRevision((n) => n + 1); setSkillMenuOpen(true); }} />
      )}
      {showSkillEditor && (
        <div data-help="composer.skills">
          <SkillEditorDialog cwd={job.config.workingDirectory ?? ''} target={{ scope: job.config.workingDirectory ? 'project' : 'global' }}
            onClose={() => setShowSkillEditor(false)} onSaved={() => setSkillCatalogRevision((n) => n + 1)} />
        </div>
      )}
      {showReviewDialog && onReview && (
        <ReviewDialog
          primary={{
            provider: job.config.primaryProvider ?? 'claude',
            model: job.config.primaryModel,
            effort: job.config.primaryEffort,
            providerAccountRef: job.config.providerAccountRef,
          }}
          onConfirm={(reviewer, contextRef, includeGitDiff) => {
            setShowReviewDialog(false);
            onReview(reviewer, contextRef, includeGitDiff);
          }}
          onCancel={() => setShowReviewDialog(false)}
          clusterContext={clusterForJob ? {
            clusterId: clusterForJob.clusterId,
            selfWorkflowId: job.id,
            members: clusterForJob.members.map((m) => ({ workflowId: m.workflowId, displayName: m.displayName })),
          } : undefined}
          onConfirmViaMember={onReviewViaMember ? (reviewerWfid, contextRef, includeGitDiff) => {
            setShowReviewDialog(false);
            onReviewViaMember(reviewerWfid, contextRef, includeGitDiff);
          } : undefined}
        />
      )}

      {showHandoffDialog && onHandoff && (
        <HandoffDialog
          currentConfig={job.config}
          onConfirm={(mode, newPrimary, summarizer) => {
            setShowHandoffDialog(false);
            onHandoff(mode, newPrimary, summarizer);
          }}
          onCancel={() => setShowHandoffDialog(false)}
        />
      )}

      {showSpawnDialog && onSpawn && (
        <SpawnDialog
          parentConfig={job.config}
          parentPlanTitle={job.plan?.title ?? null}
          clusterContext={clusterContext}
          onConfirm={(newConfig, newDirection, includePlan, joinClusterId, memberIdentity) => {
            setShowSpawnDialog(false);
            onSpawn(newConfig, newDirection, includePlan, joinClusterId, memberIdentity);
          }}
          onCancel={() => setShowSpawnDialog(false)}
        />
      )}

      {showForwardDialog && onTranscriptSend && clusterForJob && (
        <ForwardDialog
          cluster={clusterForJob}
          fromWorkflowId={job.id}
          messages={job.messages}
          onConfirm={(recipients, content) => {
            setShowForwardDialog(false);
            for (const to of recipients) onTranscriptSend(to, content);
            useMessageSelectionStore.getState().clear(job.id);
          }}
          onCancel={() => setShowForwardDialog(false)}
        />
      )}

      {showTranscriptDialog && onTranscriptSend && clusterForJob && (
        <TranscriptSendDialog
          cluster={clusterForJob}
          fromWorkflowId={job.id}
          messages={job.messages}
          onConfirm={(recipients, content) => {
            setShowTranscriptDialog(false);
            for (const to of recipients) onTranscriptSend(to, content);
          }}
          onCancel={() => setShowTranscriptDialog(false)}
        />
      )}

      {showPlanDialog && (
        <PlanComposerDialog
          job={job}
          isClusterMember={isMemberOfACluster}
          onConfirm={(mode) => {
            setShowPlanDialog(false);
            // Cluster members route autosave through the review-mode flow
            // so the PlanCandidateBanner offers SAVE & ATTACH TO WORKER vs
            // ATTACH TO CLUSTER instead of silently attaching to the
            // worker (the third auto-attach path the cluster-plan UX gap
            // brief closes). Non-cluster workflows keep the current
            // behaviour — review stays review, autosave stays autosave.
            // Cluster membership is read off the store (not clusterContext)
            // so the override also fires when the operator opens the dialog
            // from the standalone tab of a member workflow (WorkflowView
            // path) — not just from inside ClusterTab/MemberPane.
            const effectiveMode = isMemberOfACluster && mode === 'autosave' ? 'review' : mode;
            if (effectiveMode === 'review') {
              if (!beginPlanReview(job.id, (prompt) => onSend(prompt, undefined, undefined, 'plan-review'), '', isMemberOfACluster, effectivePublic(job.config.workingDirectory ?? ''))) {
                useAppStore.getState().pushNotification('error', 'Wait for the current turn or plan draft to finish before drafting a plan.');
              }
            } else {
              setPendingPlanCapture(job.id, 'autosave');
              if (onSend(planDraftPrompt('', 'autosave', false, effectivePublic(job.config.workingDirectory ?? ''))) === false) setPendingPlanCapture(job.id, null);
            }
          }}
          onCancel={() => setShowPlanDialog(false)}
        />
      )}

      {showDocsDialog && onSpawn && (
        <DocsUpdateDialog
          parentConfig={job.config}
          onConfirm={(prompt) => {
            setShowDocsDialog(false);
            // docs/PROVIDERS.md - DOCS in-tab dispatch tags the
            // user_message so the server forces outputStyle: normal for
            // the upcoming turn even if the tab is pinned to plain/terse.
            onSend(prompt, undefined, undefined, 'docs');
          }}
          onSpawn={(newConfig, newDirection, includePlan) => {
            setShowDocsDialog(false);
            onSpawn(newConfig, newDirection, includePlan);
          }}
          onCancel={() => setShowDocsDialog(false)}
        />
      )}

      {showGitDialog && job.config.workingDirectory && onSpawn && (
        <GitDialog
          cwd={job.config.workingDirectory}
          wfid={job.id}
          parentConfig={job.config}
          onConfirm={(prompt) => {
            setShowGitDialog(false);
            // docs/PROVIDERS.md - see DOCS branch above. Forces
            // outputStyle: normal for the upcoming turn regardless of tab.
            onSend(prompt, undefined, undefined, 'git');
          }}
          onSpawn={(newConfig, newDirection, includePlan) => {
            setShowGitDialog(false);
            onSpawn(newConfig, newDirection, includePlan);
          }}
          onCancel={() => setShowGitDialog(false)}
        />
      )}

      {showTuneupDialog && (
        <MdTuneupDialog
          workflowId={job.id}
          editor={{
            provider,
            model: job.config.primaryModel ?? 'sonnet',
            effort: job.config.primaryEffort ?? 'medium',
            providerAccountRef: job.config.providerAccountRef,
          }}
          onClose={() => setShowTuneupDialog(false)}
        />
      )}

      {showResearchDialog && onResearch && (
        <ResearchDialog
          parentConfig={job.config}
          onConfirm={(researcher, topic, maxRounds) => {
            setShowResearchDialog(false);
            onResearch(researcher, topic, maxRounds);
          }}
          onSpawn={(spawnConfig, researcher, topic, maxRounds) => {
            setShowResearchDialog(false);
            // New-tab path: mint a one-shot token, register the pending
            // research keyed by it, and stamp it on the spawned tab's config.
            // App creates the workflow; the WS workflow_created handler drains
            // the registry and fires research_request against the new id.
            const token = mintResearchSpawnToken();
            registerPendingResearch(token, { topic, maxRounds, researcher });
            onResearch(researcher, topic, maxRounds, { ...spawnConfig, researchSpawnToken: token });
          }}
          onCancel={() => setShowResearchDialog(false)}
        />
      )}
      </DialogPortal>
    </div>
  );
}

// Synthesizes the conversation into a project plan. Phrasing leans toward
// durable framings rather than turn-by-turn recap so the captured body is
// useful as a living document, not just a session log. The agent's reply
// becomes the plan body verbatim — title is extracted from the first H1.
// "Next steps" asks for `- [ ]` checklist format so the operator (and the
// agent on later turns) can tick items off as they ship.
// NATIVE_COMPACTION_PLAN Phase 3 — the continuance prompt the operator-clicked
// "Continue" affordance (or the opt-in server-side auto-continue) sends to
// resume work from the compacted seed. Short and direction-free: the summary
// seed already carries the working context; this just hands the turn back.
const COMPACT_CONTINUE_PROMPT =
  'Context was just compacted into a summary. Re-orient from that summary and continue the work in progress: pick up exactly where we left off.';


// Anthropic's default prompt cache TTL is 5 minutes idle, refreshed on each
// cached turn. For long-context Claude sessions this is the dominant cost
// lever: a cache-warm turn at 351k tokens costs ~$0.18 input vs ~$1.76 cold.
// The countdown gives the operator a glanceable answer to "is the next turn
// going to be cheap?" — useful when orchestrating workers that take >5 min
// (every Opus return after a slow worker is otherwise a silent cold start).
//
// Caveats baked into the tooltip: the timer can't see prefix-invalidation
// events (model swap, tools/skills change, system-prompt edits) that kill
// the cache early, and Anthropic may evict under load. It's a proxy for the
// dominant signal (idle time), not a guarantee.

// Chip-popover for live model + effort swap. Reads the live Claude catalog
// when present; falls back to the static CLAUDE_MODEL_VALUES for
// pre-auth / non-Claude providers. Effort row gated by effortsForModel
// so unsupported levels don't render. Click an entry → fires onPick →
// caller updates primary config; popover closes.
function ChipPopover({
  kind,
  provider,
  model,
  effort,
  claudeCatalog,
  codexCatalog,
  onPick,
}: {
  kind: 'model' | 'effort';
  provider: ProviderName;
  model: ModelName;
  effort: EffortLevel;
  claudeCatalog: ReturnType<typeof useAppStore.getState>['claudeNativeCatalog'];
  codexCatalog: ReturnType<typeof useAppStore.getState>['codexCatalog'];
  onPick: (update: { model?: ModelName; effort?: EffortLevel }) => void;
  onClose: () => void;
}) {
  const authStatus = useAppStore((s) => s.authStatus);
  const placeRef = useKeepInWindow();
  const popoverStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    marginBottom: '4px',
    background: 'var(--color-bg-elevated, #1a1a1a)',
    border: '1px solid var(--color-border-hairline)',
    borderRadius: '3px',
    padding: '6px',
    minWidth: '220px',
    zIndex: 1000,
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  };
  if (kind === 'effort') {
    const efforts = effortsForModel(provider, model, claudeCatalog, codexCatalog);
    if (efforts.length === 0) {
      return (
        <div ref={placeRef} data-testid="composer-chip-popover" style={popoverStyle}>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', padding: '4px 6px' }}>
            This model doesn't accept the effort flag.
          </div>
        </div>
      );
    }
    return (
      <div ref={placeRef} data-testid="composer-chip-popover" style={popoverStyle}>
        {efforts.map((e) => (
          <button
            key={e}
            type="button"
            className="display-font"
            onClick={() => onPick({ effort: e })}
            style={{
              padding: '5px 8px',
              fontSize: '10px',
              letterSpacing: '1px',
              textAlign: 'left',
              background: e === effort ? 'var(--color-accent-primary-a10, transparent)' : 'transparent',
              border: '1px solid ' + (e === effort ? 'var(--color-accent-primary)' : 'transparent'),
              color: e === effort ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)',
              borderRadius: '2px',
              cursor: 'pointer',
            }}
          >
            {e.toUpperCase()}
          </button>
        ))}
      </div>
    );
  }
  // kind === 'model'
  type Entry = { value: ModelName; label: string; subline?: string };
  let entries: Entry[];
  if (provider === 'claude') {
    if (claudeCatalog?.models?.length) {
      entries = claudeCatalog.models.map((m) => ({
        value: (m.id ?? '') as ModelName,
        label: (m.displayName ?? m.id ?? '').replace(/^Claude\s+/, '').toUpperCase() || (m.id ?? '?').toUpperCase(),
        subline: `${m.contextWindow ? Math.round(m.contextWindow / 1000) + 'K' : '?'} · ${effortsForModel('claude', m.id as ModelName, claudeCatalog, codexCatalog).join('/').toUpperCase() || 'NO EFFORT'}`,
      }));
    } else {
      entries = CLAUDE_MODEL_VALUES.map((v) => ({ value: v, label: CLAUDE_MODEL_LABELS[v] ?? String(v).toUpperCase() }));
    }
  } else if (provider === 'codex') {
    if (codexCatalog?.models?.length) {
      // Subline = catalog one-liner ("Frontier model for complex coding...")
      // when present, falling back to the effort set. Description gives the
      // operator a real reason to pick one model over another.
      entries = codexCatalog.models.filter((m) => !m.hidden).map((m) => ({
        value: m.id as ModelName,
        label: (m.displayName || m.id).toUpperCase(),
        subline: m.description
          || (m.supportedReasoningEfforts.length > 0 ? m.supportedReasoningEfforts.join('/').toUpperCase() : undefined),
      }));
    } else {
      entries = CODEX_PICKER_MODELS.map((v) => ({
        value: v,
        label: CODEX_MODEL_INFO[v]?.label ?? String(v).toUpperCase(),
        subline: CODEX_MODEL_INFO[v]?.publishedContextWindow
          ? `${Math.round((CODEX_MODEL_INFO[v]!.publishedContextWindow) / 1000)}K`
          : undefined,
      }));
    }
  } else if (provider === 'cursor') {
    // Cursor: inline family × effort × flags picker (effort is baked into the
    // id). CursorModelSelect reads the catalog from the store itself, so no
    // prop plumbing; it emits an exact catalog id.
    return (
      <div ref={placeRef} data-testid="composer-chip-popover" style={{ ...popoverStyle, padding: '8px', minWidth: '240px' }}>
        <CursorModelSelect
          value={String(model)}
          onChange={(id) => onPick({ model: id as ModelName })}
          selectStyle={{
            padding: '5px 8px',
            background: 'var(--color-bg-sunken)',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: 'var(--color-accent-primary)',
            fontSize: '11px',
            outline: 'none',
            cursor: 'pointer',
          }}
          layout="stack"
        />
      </div>
    );
  } else if ((provider === 'strata' || provider === 'deepseek')) {
    entries = (authStatus?.[provider]?.installedModels ?? []).map((id) => ({
      value: id as ModelName,
      label: authStatus?.[provider]?.installedModelLabels?.[id] ?? id,
      subline: 'Loads for the next message · one profile at a time',
    }));
  } else {
    // Other providers: simple "current model only" — picker not useful here.
    return (
      <div ref={placeRef} data-testid="composer-chip-popover" style={popoverStyle}>
        <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', padding: '4px 6px' }}>
          Switch model from the {provider.toUpperCase()} provider's CONFIG tab.
        </div>
      </div>
    );
  }
  return (
    <div ref={placeRef} data-testid="composer-chip-popover" style={{ ...popoverStyle, maxHeight: 'calc(60vh / var(--ui-scale, 1))', overflowY: 'auto' }}>
      {entries.map((m) => (
        <button
          key={m.value}
          type="button"
          className="display-font"
          onClick={() => onPick({ model: m.value })}
          style={{
            padding: '5px 8px',
            fontSize: '10px',
            letterSpacing: '1px',
            textAlign: 'left',
            background: m.value === model ? 'var(--color-accent-primary-a10, transparent)' : 'transparent',
            border: '1px solid ' + (m.value === model ? 'var(--color-accent-primary)' : 'transparent'),
            color: m.value === model ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)',
            borderRadius: '2px',
            cursor: 'pointer',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: '2px',
          }}
        >
          <span>{m.label}</span>
          {m.subline && (
            <span style={{ fontSize: '8px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px' }}>{m.subline}</span>
          )}
        </button>
      ))}
    </div>
  );
}
