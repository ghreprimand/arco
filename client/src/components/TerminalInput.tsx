import { PendingQuestionsButton } from './PendingQuestionsButton';
import { GenerationSpeedReadout } from './GenerationSpeedReadout';
import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { parseContextRefs, contextRefLabel } from './composer/contextRefs';
import { handleKillLine } from './composer/killLine';
import { useAppStore, type JobState, type DraftAttachment } from '../stores/appStore';
import { onVoiceDialog } from '../voice/dialogs';
import { useDraftStore, readDraft as readDraftFor } from '../stores/draftStore';
import { useCodexCatalogFor } from '../hooks/useCodexCatalog';
import { useHubLinkStore } from '../stores/hubLinkStore';
import { ToolboxMenu } from './ToolboxMenu';
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
import { openCompareDialog } from './terminalInput/compare';
import { PrimaryStatus } from './PrimaryStatus';
import { QueuedMessagesIndicator } from './QueuedMessagesIndicator';
import { CLAUDE_MODELS as CLAUDE_MODEL_VALUES, CLAUDE_MODEL_LABELS, CODEX_PICKER_MODELS, CODEX_MODEL_INFO, DEFAULT_ZAI_MODEL, ZAI_MODEL_LABELS } from '@arco/shared';
import type { ToolboxEntry, ProviderName, ModelName, EffortLevel, WorkflowConfig, ReviewContextRef, ArcoSkillRef } from '@arco/shared';
import {
  cacheHitPercent,
  codexPublishedMaxOutput,
  contextPercentColor,
  contextTokens,
  effortsForModel,
  providerOperationalWindow,
  providerPublishedContextWindow,
} from '../utils/format';

interface Props {
  job: JobState;
  // Phase 4 — `kind` is set when sending mid-turn (busy). Idle sends omit it.
  // 'steer' = "do this now / change direction"; 'follow-up' = "after the
  // current task lands." Both kinds drain post-turn for every provider in
  // Phase 4 — visible/rebindable is the scope here. Phases 5–7 wire real
  // mid-turn delivery for steer per provider.
  onSend: (
    content: string,
    attachments?: string[],
    kind?: 'steer' | 'follow-up',
    primitive?: 'docs' | 'git',
    // DD8 — operator-picked Arco skills to inline into this turn.
    pickedSkills?: Array<{ scope: 'project' | 'global'; slug: string }>,
  ) => boolean | void; // false ⇒ socket down, nothing sent — keep the draft
  onCancel: () => void;
  // Per-item cancel from the queue strip's [×] button.
  onCancelQueued?: (clientMessageId: string) => void;
  onUpload: (file: File) => Promise<{ fileId: string; filename: string; path: string } | null>;
  // Phase 5 — reviewer dispatch. Opens ReviewDialog → submits via WS.
  onReview?: (
    reviewer: { provider: ProviderName; model: ModelName; effort: EffortLevel },
    contextRef: ReviewContextRef,
    includeGitDiff: boolean,
  ) => void;
  // Phase 6 — session rotation. Generates a handoff document via the named
  // mode and pre-warms a fresh native session in the same tab.
  onHandoff?: (
    mode: 'fresh-summarizer' | 'original-worker' | 'fresh-agent',
    newPrimary?: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string },
    // WP2 — fresh-summarizer worker that writes the handoff (strong fresh model).
    summarizer?: { provider: ProviderName; model: ModelName; effort: EffortLevel },
  ) => void;
  // Phase 7 — fork the tab into a new one. Receives the full target config
  // (config edits happen in the dialog) + optional direction prompt.
  // Phase 2.5b — when invoked from a cluster member, `joinClusterId` is set
  // (operator opted in via the SpawnDialog checkbox). The server adds the
  // new workflow to the cluster after creation, gated on Native transport.
  onSpawn?: (newConfig: WorkflowConfig, newDirection: string, includePlan: boolean, joinClusterId?: string) => void;
  // Phase 2.5b — set when this composer instance is mounted inside a cluster
  // member pane. Drives the SpawnDialog "Spawn into cluster" checkbox.
  clusterContext?: { clusterId: string; name: string };
  // Operator-triggered ground-truth calibration. Fires when the CTX glyph
  // in the tokens footer is clicked. Claude-only; the server no-ops for
  // other providers.
  onRecalibrate?: () => void;
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
  // "← BACK TO CLUSTER" button left of /SKILLS so operators looking at a
  // member's individual view can pop back to the cluster surface. Hidden
  // (no greyed-out state) for non-cluster workflows.
  onBackToCluster?: () => void;
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
  // WORKBENCH_EXPANSION_PLAN.md §B2 — Deep Research dispatch. `spawnConfig`
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

// Claude Code TUI-only slash commands. Arco runs `claude -p` (non-interactive
// stream-json), so these never reach the interactive dispatcher — they're sent
// as user prompts and come back as errors (e.g. /login → 401). Intercept them
// in the composer so the operator isn't wasting a turn + an auth-token hit.
// `/login` gets routed through the same AUTH notice path as a stream-side 401.
const TUI_ONLY_SLASH_COMMANDS = new Set([
  'login', 'logout', 'context', 'clear', 'model', 'config',
  'help', 'compact', 'cost', 'status', 'doctor', 'memory',
  'agents', 'permissions', 'init', 'ide', 'bug', 'release-notes',
]);

// Stable empty reference for the attachments selector — Zustand's default
// equality is Object.is, so returning a fresh `[]` every render would
// re-render on every store tick. This constant is shared across tabs
// that have no staged attachments and is safe because it's frozen.
const EMPTY_ATTS: DraftAttachment[] = [];

// ── Composer draft: why the textarea and the chips are their own components ──
//
// Measured on the EliteBook (2026-08-06, Event Timing API): a single keystroke
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
    el.style.height = `${Math.min(contentH, MAX_INPUT_HEIGHT_PX)}px`;
    const overflow = contentH > MAX_INPUT_HEIGHT_PX ? 'auto' : 'hidden';
    if (el.style.overflowY !== overflow) el.style.overflowY = overflow;
  }, [value, inputRef]);

  return (
    <textarea
      ref={inputRef}
      value={value}
      onChange={(e) => setDraft(jobId, e.target.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      disabled={disabled}
      placeholder={placeholder}
      rows={1}
      style={{
        flex: 1,
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
        minHeight: '24px',
        maxHeight: `${MAX_INPUT_HEIGHT_PX}px`,
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
            ? '@url: is not yet supported — expands to a deferral notice'
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

export function TerminalInput({ job, onSend, onCancel, onCancelQueued, onUpload, onReview, onHandoff, onSpawn, onRecalibrate, onUpdatePrimary, onCompact, onFold, onSetToolPosture, onSetProjectTrust, onArmPlanMode, onBackToCluster, clusterContext, onTranscriptSend, onReviewViaMember, onResearch }: Props) {
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
  // DD8 — operator-picked Arco skills to inline into the next turn. Per-tab;
  // cleared after each send and when the active tab changes.
  const [pickedSkills, setPickedSkills] = useState<Array<{ scope: 'project' | 'global'; slug: string; name: string }>>([]);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [availableSkills, setAvailableSkills] = useState<Array<{ scope: 'project' | 'global'; slug: string; name: string; description: string; operatorOnly?: boolean }>>([]);
  const pinnedSkills = job.config.pinnedSkills ?? [];
  const pinnedSkillsKey = pinnedSkills.map((s) => `${s.scope}:${s.slug}`).join('|');
  useEffect(() => { setPickedSkills([]); setSkillMenuOpen(false); }, [job.id]);
  // Fetch when the picker opens OR a persisted pin needs a display name. The
  // catalog remains the name source; stable pin identity is scope + slug.
  useEffect(() => {
    if (!skillMenuOpen && pinnedSkillsKey.length === 0) return;
    const params = job.config.workingDirectory ? `?cwd=${encodeURIComponent(job.config.workingDirectory)}` : '';
    let cancelled = false;
    fetch(`/api/skills${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { project?: typeof availableSkills; global?: typeof availableSkills }) => {
        if (cancelled) return;
        setAvailableSkills([...(data.project ?? []), ...(data.global ?? [])]);
      })
      .catch(() => { if (!cancelled) setAvailableSkills([]); });
    return () => { cancelled = true; };
  }, [skillMenuOpen, pinnedSkillsKey, job.config.workingDirectory]);
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
  const hubLinked = useHubLinkStore((s) => s.known && !!s.hubUrl);
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
  const compactVisible =
    !!onCompact
    && (
      ((provider === 'codex' && resolvedCodexTransport === 'appserver') || provider === 'zai')
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
  // ULTRACODE_PLAN.md — sticky ultracode indicator. Read-only here (the toggle
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
    for (const file of files) {
      const result = await onUpload(file);
      if (result) {
        const isImage = file.type.startsWith('image/');
        addAttachment(job.id, {
          filename: result.filename,
          path: result.path,
          isImage,
          ...(isImage && { previewUrl: URL.createObjectURL(file) }),
        });
      }
    }
    setUploading(false);
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

  const handleSubmit = (kind?: 'steer' | 'follow-up') => {
    // Phase 3 — block sends while compacting; the worker has no history to
    // receive a turn until the summary lands. The takeover overlay + greyed
    // send already signal this; this is the hard guard.
    if (isCompacting) return;
    // A paste still uploading isn't staged yet — sending now would ship the
    // text without the image and leave the chip staged for the NEXT message.
    if (uploading) return;
    const trimmed = readDraft().trim();
    if (!trimmed && attachments.length === 0) return;

    // Intercept TUI-only slash commands. See TUI_ONLY_SLASH_COMMANDS. `/login`
    // gets the `[AUTH:claude]` prefix so ChatMessage renders a RE-LOGIN button;
    // the rest get a plain hint. Toolbox slash commands (e.g. skills) fall
    // through because their names never collide with these.
    const slashMatch = trimmed.match(/^\/([a-z-]+)(?:\s|$)/);
    // Cursor's real command is `/compress` (not `/compact`). Route it through
    // Arco's provider-native handler so the worker can send the command as an
    // isolated ACP prompt; normal Cursor turns prepend cluster/north-star text
    // and would prevent the slash dispatcher from recognizing it.
    if (slashMatch?.[1] === 'compress' && provider === 'cursor') {
      if (isBusy || !onCompact) {
        addMessage(job.id, {
          id: crypto.randomUUID(),
          role: 'system',
          content: isBusy
            ? 'Cursor compression runs between turns. Wait for the current turn to finish, then use `/compress` or COMPACT.'
            : 'Cursor compression is not available in this view.',
          isStreaming: false,
          timestamp: Date.now(),
        });
      } else {
        onCompact();
      }
      setValue('');
      clearAttachments(job.id);
      return;
    }
    if (slashMatch && TUI_ONLY_SLASH_COMMANDS.has(slashMatch[1])) {
      const cmd = slashMatch[1];
      const content = cmd === 'login' || cmd === 'logout'
        ? `[AUTH:claude] "/${cmd}" is a terminal-only Claude CLI command — Arco runs claude non-interactively so it can't reach that dispatcher. Click RE-LOGIN to trigger the OAuth flow, or run claude in a native terminal.`
        : `"/${cmd}" is a terminal-only Claude CLI command and won't reach the model from here. Run it in a native \`claude\` terminal instead.`;
      addMessage(job.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content,
        isStreaming: false,
        timestamp: Date.now(),
      });
      setValue('');
      clearAttachments(job.id);
      return;
    }

    // GOAL_NORTHSTAR_PLAN.md G3 — `/goal` composer shortcut. Dispatches the same
    // updatePrimaryConfig the CONFIG NORTH STAR field uses; it never sends a turn.
    //   /goal <objective>    set the standing north-star
    //   /goal                show the current north-star (no change)
    //   /goal clear | none   clear it
    // The server caps to GOAL_MAX_BYTES (2048) and echoes the stored value back
    // via goal_set, which refreshes the store + the NorthStarBar chip. The `[\s\S]`
    // arg allows a multi-line goal (Shift+Enter); `/goalkeeper` etc. don't match
    // (requires end-of-token or whitespace after "goal") so they send normally.
    const goalMatch = trimmed.match(/^\/goal(?:\s+([\s\S]*))?$/i);
    if (goalMatch) {
      const pushSys = (content: string) =>
        addMessage(job.id, { id: crypto.randomUUID(), role: 'system', content, isStreaming: false, timestamp: Date.now() });
      const arg = (goalMatch[1] ?? '').trim();
      const current = job.config.goal?.trim();
      // GOAL_RUN_PLAN.md — `/goal run [n]` arms the north-star auto-continue,
      // `/goal run stop` disarms. Parsed before the set/clear branches so a
      // literal objective of "run …" can't be typed by accident; use CONFIG →
      // NORTH STAR for an objective that genuinely starts with "run".
      const runMatch = arg.match(/^run(?:\s+(.*))?$/i);
      if (runMatch) {
        const runArg = (runMatch[1] ?? '').trim().toLowerCase();
        const run = job.config.goalRun;
        if (!onUpdatePrimary) {
          pushSys('Goal runs aren’t available in this view.');
        } else if (runArg === 'stop' || runArg === 'off') {
          onUpdatePrimary({ goalRun: { enabled: false } });
          pushSys('Stopping the goal run — no further automatic turns.');
        } else if (!runArg) {
          if (run?.enabled) {
            pushSys(`Goal run active: ${run.total - run.remaining}/${run.total} iterations used, ${run.remaining} left. \`/goal run stop\` to stop.`);
          } else {
            pushSys('No goal run active. `/goal run <n>` arms one for n iterations (default 10).');
          }
        } else {
          const n = Number.parseInt(runArg, 10);
          if (!Number.isFinite(n) || n < 1) {
            pushSys('Usage: `/goal run <iterations>` · `/goal run stop` · `/goal run` to check status.');
          } else if (!current) {
            pushSys('Set a north star first — a goal run continues toward it. `/goal <objective>`.');
          } else {
            onUpdatePrimary({ goalRun: { enabled: true, total: n } });
            pushSys(`Goal run armed for ${n} iteration${n === 1 ? '' : 's'}. A continuation turn fires after each settled turn until the budget runs out or you stop it.`);
          }
        }
        setValue('');
        clearAttachments(job.id);
        return;
      }
      if (!arg) {
        // Read-only query — needs no dispatch, so it works even in a degraded
        // view where onUpdatePrimary isn't wired.
        pushSys(current
          ? `North-star (standing objective for this tab): ${current}`
          : 'No north-star set. Type `/goal <objective>` to set one, or use CONFIG → NORTH STAR.');
      } else if (!onUpdatePrimary) {
        pushSys('Setting a north-star isn’t available in this view.');
      } else if (arg.toLowerCase() === 'clear' || arg.toLowerCase() === 'none') {
        onUpdatePrimary({ goal: '' });
        pushSys('North-star cleared.');
      } else {
        onUpdatePrimary({ goal: arg });
        pushSys(`North-star set: ${arg}`);
      }
      setValue('');
      clearAttachments(job.id);
      return;
    }

    // Send-time-fire for operator-armed plan mode. Emit the WS request
    // immediately before the user message so the server processes them in
    // order — pendingPlanModeEntry lands first, then the upcoming turn
    // picks it up. Auto-clear after every send (single-turn arming).
    if (planModeArmed && planModeToggleVisible && onArmPlanMode) {
      onArmPlanMode();
    }
    setPlanModeArmed(false);

    // Phase 4 — `kind` only flows when busy. The hook ignores it on idle
    // sends (where there's no queue to land in). Pre-Phase-4 callers passed
    // no kind; the server still defaults to follow-up for back-compat.
    const sent = onSend(
      trimmed,
      attachments.length > 0 ? attachments.map((a) => a.path) : undefined,
      isBusy ? kind : undefined,
      undefined,
      pickedSkills.length > 0 ? pickedSkills.map((s) => ({ scope: s.scope, slug: s.slug })) : undefined,
    );
    if (sent === false) return;
    setValue('');
    clearAttachments(job.id);
    setPickedSkills([]);
  };

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
    //   Shift+Enter          → newline (preserved at every state)
    // Both kinds drain post-turn in Phase 4; Phases 5–7 wire real mid-turn
    // delivery for steer per provider — the operator's intent is captured
    // now so the delivery upgrade is transparent later.
    if (e.key === 'Enter' && !e.shiftKey) {
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

      {/* EFFICIENCY_PLAN.md Phase 6b.1 / Phase D §8b — handoff nudge. Pure
          UI hint. The worker-authoritative `toolCallsSinceCompact`
          (Native, Phase D) is preferred when defined; the client-side
          `toolCallsSinceHandoff` recount stays as the audit fallback for
          non-Native tabs and for the first paint before the worker has
          emitted a value. */}
      {onHandoff && (
        <HandoffNudgeChip
          count={job.toolCallsSinceCompact ?? job.toolCallsSinceHandoff ?? 0}
          onClick={() => setShowHandoffDialog(true)}
        />
      )}

      {/* NATIVE_COMPACTION_PLAN Phase 3 — post-compaction "Continue" affordance.
          After native_compacted lands, the conversation is parked on a fresh
          summary seed. Default resume is MANUAL (per the autonomy fence — between-
          turn compaction means the turn already ended; auto-continuing is
          autonomous continuation, kept opt-in via config.nativeCompactAutoContinue,
          handled server-side). The operator clicks Continue to send the
          continuance prompt and resume; "Dismiss" parks silently. When the opt-in
          fired, the next primary_turn_started clears this before it's seen. */}
      {job.compactedResume && !isCompacting && (
        <div
          data-help="composer.compact-continue"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            marginBottom: '8px',
            padding: '7px 12px',
            border: '1px solid var(--color-accent-primary-dim)',
            borderRadius: '3px',
            background: 'var(--color-accent-primary-a15, transparent)',
          }}
        >
          <span className="display-font" style={{ fontSize: '11px', letterSpacing: '0.5px', color: 'var(--color-fg-muted)', flex: 1 }}>
            ⊟ COMPACTED
            {typeof job.compactedResume.foldedTurns === 'number'
              ? ` — folded ${job.compactedResume.foldedTurns} turn${job.compactedResume.foldedTurns === 1 ? '' : 's'} into a summary.`
              : ' — earlier history folded into a summary.'}
            {' '}History is parked; resume when ready.
          </span>
          <button
            onClick={() => {
              if (isBusy || isCompacting) return;
              clearCompacting(job.id);
              onSend(COMPACT_CONTINUE_PROMPT);
            }}
            disabled={isBusy}
            className="display-font"
            title="Send a short continuance prompt so the agent re-orients from the compacted summary and resumes the work."
            style={{
              padding: '4px 12px',
              background: 'transparent',
              border: '1px solid var(--color-accent-primary)',
              borderRadius: '3px',
              color: isBusy ? 'var(--color-fg-muted)' : 'var(--color-accent-primary)',
              cursor: isBusy ? 'default' : 'pointer',
              opacity: isBusy ? 0.5 : 1,
              fontSize: '10px',
              letterSpacing: '1px',
              whiteSpace: 'nowrap',
            }}
          >
            ▸ CONTINUE
          </button>
          <button
            onClick={() => clearCompacting(job.id)}
            className="display-font"
            title="Dismiss — resume on your own when ready."
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
            ✕
          </button>
        </div>
      )}

      {/* DD7 — project-trust prompt. This repo ships CLAUDE.md / project skills /
          .arco/settings.json that Arco SUPPRESSED from the turn until the
          operator vouches for it (the cloned-repo prompt-injection vector). The
          turn already ran with them suppressed; trusting folds them in next turn.
          Operator-prompt only — no auto-grant. */}
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
            ⚠ UNTRUSTED PROJECT — suppressed from the turn: {job.projectTrustPrompt.resources.join(', ')}. Trust this repo to fold them in (next turn).
          </span>
          <button
            onClick={() => onSetProjectTrust(job.projectTrustPrompt!.cwd, 'always')}
            className="display-font"
            title="Record this repo as trusted in ~/.arco/trust.json. Its CLAUDE.md / project skills / project settings fold into future turns. Reversible — edit trust.json to revoke."
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

      {/* Standing pins persist in WorkflowConfig/meta.json and are re-injected
          every turn. They remain visible until explicitly removed. */}
      {pinnedSkills.length > 0 && (
        <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
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
        <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
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

      {/* Queued-interjections indicator. Renders nothing when no messages
          are queued; otherwise shows a pill above the composer that opens
          a preview modal on click. Queued messages are intentionally kept
          OUT of the scrolling chat log until they're actually sent. */}
      {onCancelQueued && (
        <QueuedMessagesIndicator job={job} onCancel={onCancelQueued} />
      )}

      {/* ULTRACODE_PLAN.md — always-visible reminder that this tab is in sticky
          ultracode: every turn authors a Workflow + fans out a subagent fleet,
          unattended + heavy-spend. Toggle in CONFIG → TRANSPORT. */}
      {ultracodeActive && (
        <div
          className="display-font"
          title="Ultracode is ON for this tab — every turn fans out a subagent fleet (CLI + Workflow + xhigh). Toggle in CONFIG → TRANSPORT."
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
            marginBottom: '8px',
            width: 'fit-content',
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
        </div>
      )}

      {/* §D1 — context-refs chip bar. One chip per `@`-ref parsed from the
          draft, with a × remove affordance that strips the ref span from the
          composer. Purely visual — the server re-parses + expands at send. */}
      <ContextRefChips jobId={job.id} onRemove={removeContextRef} />

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
          title="Arm plan mode for the next turn — Write/Edit tools stay disabled until the model calls ExitPlanMode. Auto-clears on send."
          onClick={() => setPlanModeArmed((v) => !v)}
        >
          <input
            type="checkbox"
            checked={planModeArmed}
            onChange={(e) => setPlanModeArmed(e.target.checked)}
            style={{ margin: 0, cursor: 'pointer', accentColor: 'var(--color-warning)' }}
            onClick={(e) => e.stopPropagation()}
          />
          <span>⛔ PLAN MODE — GATE WRITE TOOLS FOR NEXT TURN</span>
        </div>
      )}

      {/* Input row — prompt text + CANCEL only. Tool buttons, status, and
          tokens all live on the dedicated toolbar row below so narrow
          windows don't crowd the prompt. */}
      <div
        className="glow-border"
        data-help="composer.input"
        style={{
          display: 'flex',
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
                  ? '↵ steer · ⌥↵ follow-up · ⎋ cancel turn'
                  : planModeArmed && planModeToggleVisible
                    ? 'Type your task — plan mode armed for next turn'
                    : 'Enter command... (drop / paste / attach files anywhere)'
          }
        />

        {isBusy && (
          <span
            className="display-font"
            title={`busy=${job.busy === true ? 1 : 0} · workers=${activeWorkerCount} · streaming=${hasStreaming ? 1 : 0} — which flag is keeping the composer in queue mode`}
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

      {/* Toolbar row — permanent second line. Primitives on the left,
          live status + tokens on the right. Stays visible at narrow widths
          because it's below the prompt instead of competing with it. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          marginTop: '4px',
          padding: '0 4px',
          flexWrap: 'wrap',
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
              ? 'This workflow is monitored remotely — it shows in the VPS console and pushes phone notifications. Click to stop sharing it.'
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
              : 'Allow approving/rejecting parked review gates from the phone console. Off by default — remote conversation never implies remote approval authority.'}
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
              ? 'Compact runs between turns — wait for the current turn to finish.'
              : provider === 'codex' || provider === 'zai'
                ? provider === 'zai'
                  ? 'Native /compact: Z.ai summarizes earlier native history in place and continues with a smaller prompt. App-server fallback uses Codex thread compact. Far cheaper than a Handoff.'
                  : 'Native /compact: Codex summarizes earlier thread history server-side so the next turn starts with a smaller prompt. App-server compact path; far cheaper than a Handoff.'
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
              ? 'Fold runs between turns — wait for the current turn to finish.'
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
              ? 'Server Fold runs between turns — wait for the current turn to finish.'
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
            title={job.config.primaryProvider === 'antigravity'
              ? 'Create handoff text and seed a fresh Antigravity cascade'
              : 'Rotate session — archive current, pre-warm fresh session with handoff context'}
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
            title="Spawn from here — fork this tab into a new tab seeded with current context"
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

        <button
          onClick={() => setShowPlanDialog(true)}
          data-help="composer.plan"
          className="display-font"
          title="Draft a project plan from this conversation and attach it to this workflow"
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
          title="Ask an agent to update repo docs (README, DEVLOG, etc.) — explicitly excludes plan files"
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
            title="Commit, push, open PR, or switch branch — bakes your decisions into the prompt"
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
            title="Compact this project's agent-instruction file (CLAUDE.md / AGENTS.md / GEMINI.md) — proposes a tightened version as a diff; backs up the original before writing"
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
            title="Run a bounded web-research turn — plan, search, read, and write a cited markdown report into the RESEARCH tab"
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
          title="Race one prompt across multiple providers side-by-side (read-only, no tools), optionally blinded, then vote a winner"
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
          ⚖ COMPARE
        </button>

        <div style={{ flex: 1 }} />

        {isBusy && <PrimaryStatus job={job} />}
        <span data-help="composer.footer.ctx" style={{ display: 'inline-flex' }}>
          <TokensFooter job={job} codexCatalog={codexCatalog} onRecalibrate={onRecalibrate} />
          <PendingQuestionsButton workflowId={job.id} />
        </span>
      </div>

      {/* Hint row — keyboard shortcuts + toolbox. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px', fontSize: '10px', fontFamily: 'var(--font-display)', color: 'var(--color-fg-muted)', letterSpacing: '1px', padding: '0 4px' }}>
        <span>
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
                redundant AND misleading — change effort via the MODEL picker
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
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
          <ToolboxMenu
            provider={job.config.primaryProvider ?? 'claude'}
            transport={job.config.primaryProvider === 'claude'
              ? (job.config.claudeTransport ?? settings?.claude?.transport ?? 'cli')
              : job.config.primaryProvider === 'codex'
                ? (job.config.codexTransport ?? settings?.codex?.transport ?? 'exec')
                : undefined}
            cwd={job.config.workingDirectory}
            providerAccountRef={job.config.providerAccountRef}
            onPick={(entry: ToolboxEntry) => {
              const prefix = `${entry.invocation} `;
              { const v = readDraft(); setValue(v.startsWith(prefix) ? v : prefix + v); }
              inputRef.current?.focus();
            }}
          />
          {/* DD8 — inline an Arco skill (incl. operator-only ones, hidden from
              the model manifest) into the next turn. */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setSkillMenuOpen((v) => !v)}
              title="Inline an operator skill's full body into the next turn (no Read round-trip). Operator-only skills live here."
              className="display-font"
              style={{
                padding: '3px 10px',
                background: skillMenuOpen ? 'var(--color-accent-secondary-a12)' : 'transparent',
                border: `1px solid ${skillMenuOpen ? 'var(--color-accent-secondary)' : 'var(--color-border-hairline)'}`,
                borderRadius: '3px',
                color: skillMenuOpen ? 'var(--color-accent-secondary)' : 'var(--color-accent-secondary-dim)',
                cursor: 'pointer',
                fontSize: '10px',
                letterSpacing: '1px',
                whiteSpace: 'nowrap',
              }}
            >
              +SKILL{(pickedSkills.length > 0 || pinnedSkills.length > 0) && (
                <span style={{ opacity: 0.6 }}> [{pickedSkills.length}×1 · {pinnedSkills.length} PIN]</span>
              )}
            </button>
            {skillMenuOpen && (
              <div
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 6px)',
                  left: 0,
                  width: '320px',
                  maxHeight: '300px',
                  overflowY: 'auto',
                  background: 'var(--color-bg-elevated)',
                  border: '1px solid var(--color-accent-secondary)',
                  borderRadius: '4px',
                  boxShadow: '0 0 18px var(--color-accent-secondary-a25)',
                  zIndex: 20,
                }}
              >
                {availableSkills.length === 0 ? (
                  <div style={{ padding: '14px', textAlign: 'center', color: 'var(--color-fg-muted)', fontSize: '11px', letterSpacing: '1px' }} className="display-font">
                    NO SKILLS
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
              </div>
            )}
          </div>
          <span>{isBusy ? '↵ STEER · ⌥↵ FOLLOW-UP' : 'ENTER TO SEND'}</span>
        </div>
      </div>

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
          onConfirm={(newConfig, newDirection, includePlan, joinClusterId) => {
            setShowSpawnDialog(false);
            onSpawn(newConfig, newDirection, includePlan, joinClusterId);
          }}
          onCancel={() => setShowSpawnDialog(false)}
        />
      )}

      {showTranscriptDialog && onTranscriptSend && clusterForJob && (
        <TranscriptSendDialog
          cluster={clusterForJob}
          fromWorkflowId={job.id}
          messages={job.messages}
          onConfirm={(to, content) => {
            setShowTranscriptDialog(false);
            onTranscriptSend(to, content);
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
            setPendingPlanCapture(job.id, effectiveMode);
            onSend(PLAN_DRAFT_PROMPT);
          }}
          onCancel={() => setShowPlanDialog(false)}
        />
      )}

      {showDocsDialog && onSpawn && (
        <DocsUpdateDialog
          parentConfig={job.config}
          onConfirm={(prompt) => {
            setShowDocsDialog(false);
            // OUTPUT_STYLE_PLAN.md §6 — DOCS in-tab dispatch tags the
            // user_message so the server forces outputStyle: normal for
            // the upcoming turn even if the tab is pinned to lite/terse.
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
            // OUTPUT_STYLE_PLAN.md §6 — see DOCS branch above. Forces
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
  'Context was just compacted into a summary. Re-orient from that summary and continue the work in progress — pick up exactly where we left off.';

const PLAN_DRAFT_PROMPT = `Please synthesize a project plan from everything we've discussed in this conversation. Cover:

- **Goal** — what we're building or trying to accomplish
- **Current state** — what's been done, what's working, what's been decided
- **Open questions / blockers** — anything unresolved
- **Next steps** — actionable items as a markdown checklist (\`- [ ] item\`) so progress can be ticked off (\`- [x]\`) as work happens

Write it as clean markdown starting with a single \`# Title\` line that names the project succinctly. This will become a living document we'll edit as work progresses, so prefer durable framings over a turn-by-turn recap.

Important: reply with the plan content **inline as your message body** — do not save it to disk yourself with a file-write tool. Arco will capture your reply and persist it as the plan automatically.`;

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
const CACHE_TTL_MS = 5 * 60 * 1000;

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
        <div style={popoverStyle}>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', padding: '4px 6px' }}>
            This model doesn't accept the effort flag.
          </div>
        </div>
      );
    }
    return (
      <div style={popoverStyle}>
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
              color: e === effort ? 'var(--color-accent-primary)' : 'var(--color-fg-default, #ccc)',
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
  } else if (provider === 'zai') {
    entries = (authStatus?.zai?.installedModels ?? [DEFAULT_ZAI_MODEL]).map((v) => ({
      value: v as ModelName,
      label: ZAI_MODEL_LABELS[v] ?? String(v).toUpperCase(),
      subline: v.startsWith('glm-5') ? 'CODING PLAN · HIGHER QUOTA USE' : 'CODING PLAN',
    }));
  } else if (provider === 'cursor') {
    // Cursor: inline family × effort × flags picker (effort is baked into the
    // id). CursorModelSelect reads the catalog from the store itself, so no
    // prop plumbing; it emits an exact catalog id.
    return (
      <div style={{ ...popoverStyle, padding: '8px', minWidth: '240px' }}>
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
      <div style={popoverStyle}>
        <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', padding: '4px 6px' }}>
          Switch model from the {provider.toUpperCase()} provider's CONFIG tab.
        </div>
      </div>
    );
  }
  return (
    <div style={{ ...popoverStyle, maxHeight: '60vh', overflowY: 'auto' }}>
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
            color: m.value === model ? 'var(--color-accent-primary)' : 'var(--color-fg-default, #ccc)',
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

function CacheWarmthTimer({ endedAt }: { endedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remainingMs = CACHE_TTL_MS - (now - endedAt);
  const cold = remainingMs <= 0;
  const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const mm = Math.floor(remainingSec / 60);
  const ss = remainingSec % 60;
  const color = cold
    ? 'var(--color-fg-muted)'
    : remainingSec > 120
      ? 'var(--color-accent-secondary)'
      : remainingSec > 30
        ? 'var(--color-warning)'
        : 'var(--color-danger)';
  const label = cold ? 'cache cold' : `cache ${mm}:${ss.toString().padStart(2, '0')}`;
  const tooltip = cold
    ? 'Prompt cache likely cold — next turn pays full input rate on the entire prefix. Anthropic\'s 5-min idle TTL has elapsed since the last turn ended.\n\nApproximate: doesn\'t account for prefix invalidation (model swap, tools/skills change, system-prompt edits) which kill the cache early.'
    : `Prompt cache likely warm for ~${mm}m ${ss}s more. Each cached turn resets the 5-min TTL. Walking away past 0:00 means the next turn pays full input rate on the entire prefix.\n\nApproximate: doesn\'t account for prefix invalidation (model swap, tools/skills change, system-prompt edits) which kill the cache early.`;
  return (
    <>
      <span style={{ color: 'var(--color-fg-muted)', opacity: 0.6 }}>·</span>
      <span title={tooltip} style={{ color, opacity: cold ? 0.7 : 1 }}>
        {label}
      </span>
    </>
  );
}

// Compact token readout for the composer footer.
// Phase 2: for Claude sessions, shows the byte-count context fill estimate
// (CTX: NNK / NNK  NN%) color-coded green/amber/red. Falls back to the
// per-turn ctx figure for non-Claude providers. ↑ OUT is cumulative output.
function TokensFooter({ job, codexCatalog, onRecalibrate }: { job: JobState; codexCatalog: ReturnType<typeof useAppStore.getState>['codexCatalog']; onRecalibrate?: () => void }) {
  const cu = job.contextUsage;
  const outCumulative = job.totalTokens.output;

  if (cu) {
    const fillColor = contextPercentColor(cu.percentOfWindow);
    const estK = compact(cu.estimatedTokens);
    const winK = compact(cu.windowSize);
    // Method marker: empty dot = byte-count (estimate only), half dot =
    // calibrated (zone-calibrated ratio from past /context reading), full dot
    // = ground-truth (freshest /context reading). Hover for details.
    const methodGlyph = cu.method === 'ground-truth' ? '●' : cu.method === 'calibrated' ? '◐' : '○';
    const methodColor =
      cu.method === 'ground-truth' ? 'var(--color-accent-primary)' :
      cu.method === 'calibrated' ? 'var(--color-accent-primary)' :
      'var(--color-fg-muted)';
    const calibratedAgo = cu.calibratedAt
      ? `${Math.max(1, Math.round((Date.now() - cu.calibratedAt) / 60000))}m ago`
      : 'never';
    // Only Claude sessions support ground-truth calibration, and only while
    // idle (server refuses during a primary turn — two claude processes
    // hitting the same JSONL corrupts state). Gate the click affordance on
    // the same conditions so we don't advertise a button that'll just bounce.
    const canRecalibrate =
      typeof onRecalibrate === 'function' &&
      job.config.primaryProvider !== 'gemini' &&
      job.config.primaryProvider !== 'codex' &&
      job.config.primaryProvider !== 'zai' &&
      job.config.primaryProvider !== 'ollama' &&
      job.config.primaryProvider !== 'antigravity' &&
      job.busy !== true;
    const isGroundTruth = cu.method === 'ground-truth';
    const headline = isGroundTruth
      ? 'Context fill (provider ground-truth)'
      : `Context fill estimate (${cu.method})`;
    const tokensLine = isGroundTruth
      ? `${cu.estimatedTokens.toLocaleString()} / ${cu.windowSize.toLocaleString()} tokens (${cu.percentOfWindow}%)`
      : `~${cu.estimatedTokens.toLocaleString()} / ${cu.windowSize.toLocaleString()} tokens (${cu.percentOfWindow}%)`;
    const lastLine = isGroundTruth
      ? `Last turn read: ${calibratedAgo}`
      : `Last calibration: ${calibratedAgo}`;
    const hoverText = [
      headline,
      tokensLine,
      `Messages: ~${cu.messagesTokens.toLocaleString()} tokens (${compact(cu.jsonlBytes)} JSONL)`,
      `Overhead: ~${cu.overheadTokens.toLocaleString()} tokens`,
      lastLine,
      outCumulative > 0 ? `Output (cumulative): ${outCumulative.toLocaleString()} tokens` : '',
      canRecalibrate && !isGroundTruth ? 'Click to force a fresh /context calibration.' : '',
    ].filter(Boolean).join('\n');
    return (
      <span style={{ whiteSpace: 'nowrap', display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
        <span
          title={hoverText}
          onClick={canRecalibrate ? onRecalibrate : undefined}
          style={{
            color: fillColor,
            cursor: canRecalibrate ? 'pointer' : 'default',
            textDecoration: canRecalibrate ? 'underline dotted transparent' : 'none',
            textUnderlineOffset: '3px',
            transition: 'text-decoration-color 0.15s',
          }}
          onMouseEnter={(e) => { if (canRecalibrate) (e.currentTarget as HTMLSpanElement).style.textDecorationColor = 'currentColor'; }}
          onMouseLeave={(e) => { if (canRecalibrate) (e.currentTarget as HTMLSpanElement).style.textDecorationColor = 'transparent'; }}
        >
          CTX: {estK} / {winK}
          {' '}
          <span style={{ fontWeight: 600 }}>{cu.percentOfWindow}%</span>
          {' '}
          <span style={{ color: methodColor, opacity: 0.9 }}>{methodGlyph}</span>
        </span>
        {/* Cache-warmth countdown — Claude only, idle only, and only when the
            context is large enough that a cold start would actually hurt
            (cache-miss cost scales linearly with prefix size). Below ~50k the
            miss is pennies; the timer would be alarmist noise. */}
        {!job.busy && job.lastTurnEndedAt && cu.estimatedTokens >= 50_000 && (
          <CacheWarmthTimer endedAt={job.lastTurnEndedAt} />
        )}
        <span style={{ color: 'var(--color-fg-muted)', opacity: 0.6 }}>·</span>
        <span data-help="composer.footer.tokens" style={{ color: 'var(--color-fg-muted)', opacity: 0.8 }}>
          ↑ {outCumulative > 0 ? compact(outCumulative) : '—'} OUT
        </span>
        <GenerationSpeedReadout job={job} />
      </span>
    );
  }

  // Fallback path: no server-emitted contextUsage (non-Claude providers, or
  // Claude pre-first-turn). For Codex we have actual token counts from the
  // turn.completed.usage event, so we can render a real CTX: NN / NN  NN%
  // bar against the model's known window. ctx for Codex is just `input`
  // (cacheRead is a subset, not additive — see contextTokens).
  const last = job.lastTurnTokens;
  const provider = job.config.primaryProvider;
  if (provider === 'cursor') {
    return (
      <span
        title="Cursor owns this ACP session's context and automatic summarization. ACP currently exposes no live retained-token count, so Arco cannot show an honest percentage. Use COMPACT for Cursor's native /compress or HANDOFF for a clean rotation."
        style={{ opacity: 0.75, whiteSpace: 'nowrap' }}
      >
        CTX: Cursor-managed
        <span style={{ color: 'var(--color-fg-muted)', opacity: 0.6 }}> · </span>
        ↑ {outCumulative > 0 ? compact(outCumulative) : '—'} OUT
      </span>
    );
  }
  if (provider === 'antigravity') {
    return (
      <span
        title="Antigravity owns this cascade's context, cache, checkpoints, and internal compaction. Arco has no trustworthy context percentage for this provider."
        style={{ opacity: 0.75, whiteSpace: 'nowrap' }}
      >
        CTX: Antigravity-managed
        <span style={{ color: 'var(--color-fg-muted)', opacity: 0.6 }}> · </span>
        ↑ {outCumulative > 0 ? compact(outCumulative) : '—'} OUT
      </span>
    );
  }
  if (last && (provider === 'codex' || provider === 'zai')) {
    const ctx = contextTokens(last, provider);
    // Prefer the provider-reported context window (set when Codex emits
    // model_context_window via primary_complete.modelContextWindow). Falls
    // back to provider-specific static metadata when the stream hasn't
    // reported one yet (first-turn race, older Codex CLI versions, or Z.ai's
    // sparse model metadata).
    const observedWindow = job.modelContextWindow;
    const catalogModel = provider === 'codex'
      ? codexCatalog?.models.find((model) => model.id === job.config.primaryModel)
      : undefined;
    const catalogRawWindow = job.config.codexContextPolicy === 'standard'
      ? catalogModel?.contextWindow
      : catalogModel?.maxContextWindow;
    const catalogWindow = catalogRawWindow
      ? Math.floor(catalogRawWindow * (catalogModel?.effectiveContextWindowPercent ?? 95) / 100)
      : undefined;
    const window = observedWindow ?? catalogWindow ?? providerOperationalWindow(provider, job.config.primaryModel);
    const windowSource = observedWindow ? 'reported' : 'estimate';
    const percent = Math.min(100, Math.round((ctx / window) * 100));
    const fillColor = contextPercentColor(percent);
    const reasoningOutput = last.reasoningOutput ?? 0;
    const totalReported = last.total;
    const cachePct = cacheHitPercent(last);
    const publishedWindow = providerPublishedContextWindow(provider, job.config.primaryModel);
    const maxOutput = provider === 'zai' ? null : codexPublishedMaxOutput(job.config.primaryModel);
    const providerLabel = provider === 'zai' ? 'Z.ai' : 'Codex';
    const hover = [
      `${providerLabel} context fill — last turn's input_tokens (already the full prompt)`,
      `~${ctx.toLocaleString()} / ${window.toLocaleString()} tokens (${percent}%) · window: ${windowSource}`,
      maxOutput === null
        ? `Configured model window: ${publishedWindow.toLocaleString()} context`
        : `Published model window: ${publishedWindow.toLocaleString()} context · ${maxOutput.toLocaleString()} max output`,
      `${last.input.toLocaleString()} input (of which ${(last.cacheRead ?? 0).toLocaleString()} served from prefix cache)`,
      cachePct !== null ? `Prompt-cache hit rate: ${cachePct}%` : '',
      reasoningOutput > 0
        ? `${last.output.toLocaleString()} output (of which ${reasoningOutput.toLocaleString()} reasoning trace — carries forward into next turn's prompt)`
        : `${last.output.toLocaleString()} output`,
      typeof totalReported === 'number'
        ? `Total reported by ${providerLabel}: ${totalReported.toLocaleString()}`
        : '',
      outCumulative > 0 ? `Output (cumulative): ${outCumulative.toLocaleString()} tokens` : '',
      windowSource === 'reported'
        ? `Window reported by ${providerLabel} via model_context_window — honest operational limit.`
        : `Window is a client-side operational estimate until ${providerLabel} reports model_context_window. The public model window includes output budget; this bar tracks usable input/context fill.`,
      `${providerLabel} manages its own compaction internally — no Arco auto-handoff fires on this bar.`,
    ].filter(Boolean).join('\n');
    return (
      <span style={{ whiteSpace: 'nowrap', display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
        <span title={hover} style={{ color: fillColor }}>
          CTX: {compact(ctx)} / {compact(window)}
          {' '}
          <span style={{ fontWeight: 600 }}>{percent}%</span>
          {' '}
          <span style={{ color: 'var(--color-fg-muted)', opacity: 0.6, fontSize: '9px' }}>
            {observedWindow ? '●' : '○'}
          </span>
        </span>
        <span style={{ color: 'var(--color-fg-muted)', opacity: 0.6 }}>·</span>
        <span style={{ color: 'var(--color-fg-muted)', opacity: 0.8 }}>
          ↑ {outCumulative > 0 ? compact(outCumulative) : '—'} OUT
        </span>
      </span>
    );
  }

  // Other non-Claude providers (Gemini, Ollama) or Claude
  // pre-first-turn: compact form. No model-window denominator because
  // these providers don't have a uniform window/usage shape today.
  const ctx = last ? contextTokens(last, provider) : 0;
  return (
    <span style={{ whiteSpace: 'nowrap', display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
      <span
        title={`Last turn ctx (${provider === 'codex' || provider === 'zai' ? 'input' : 'input + cacheCreate'}): ${ctx.toLocaleString()} · cumulative output across this tab: ${outCumulative.toLocaleString()}`}
        style={{ opacity: 0.7, whiteSpace: 'nowrap' }}
      >
        ↓ {ctx > 0 ? compact(ctx) : '—'} CTX · ↑ {outCumulative > 0 ? compact(outCumulative) : '—'} OUT
      </span>
      <GenerationSpeedReadout job={job} />
    </span>
  );
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(n / 1000) + 'k';
}

// EFFICIENCY_PLAN.md Phase 6b.1 — strategic-compact nudge. Renders only
// after the operator has accumulated enough tool calls without a handoff
// to make a /handoff worth offering. Defaults: first nudge at 50, then
// every 25 (50, 75, 100, ...). Pure UI suggestion — clicking opens the
// HandoffDialog; ignoring it does nothing.
const HANDOFF_NUDGE_FIRST = 50;
const HANDOFF_NUDGE_INTERVAL = 25;
function HandoffNudgeChip({ count, onClick }: { count: number; onClick: () => void }) {
  if (count < HANDOFF_NUDGE_FIRST) return null;
  // Show the chip on every multiple of HANDOFF_NUDGE_INTERVAL once the
  // first threshold's been crossed; in between thresholds the chip stays
  // visible (so it doesn't flicker mid-turn) but doesn't escalate styling.
  return (
    <button
      type="button"
      onClick={onClick}
      className="display-font"
      style={{
        marginBottom: '6px',
        padding: '4px 10px',
        fontSize: '10px',
        letterSpacing: '1px',
        background: 'transparent',
        color: 'var(--color-fg-muted)',
        border: '1px solid var(--color-border-hairline)',
        borderRadius: '2px',
        cursor: 'pointer',
        textAlign: 'left',
      }}
      title="Click to open handoff dialog. Tool calls accumulate context burn; handoff cycles to a fresh session with a summary seeded forward."
    >
      ⌁ {count} TOOL CALLS SINCE HANDOFF — CONSIDER /HANDOFF
    </button>
  );
}
