// CLUSTER_MODE_PLAN.md Phase 2.6 — shared cluster plan editor. Lives as a
// sub-tab inside ClusterRightPanel. The body is injected into every cluster
// member's per-turn system block by the Native worker; edits propagate on
// the NEXT turn (in-flight turns aren't torn down).
//
// 32 KB hard cap (server-enforced); 28 KB soft warn surfaces inline below
// the textarea. Bumped from 8 KB → 32 KB on 2026-05-11 (CLUSTER_MODE_PLAN
// §13) — multi-phase plans were running into the old cap. Empty /
// whitespace bodies are rejected — operator must use CLEAR to wipe.
//
// 2026-05-11 — rich VIEW mode added: PlanBodyRenderer (the same component
// the worker PLAN tab uses) parses the body so checkboxes are clickable
// from the cluster panel and H3 phases get REVIEW PHASE PLAN / VERIFY
// PHASE WORK / SPAWN PHASE pills. REVIEW/VERIFY surfaces pop a member
// picker first (the existing review dialog needs a target workflow and a
// resolvable planId; cluster-plan reviews ride on the picked member's
// attached plan).

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ClusterStatePayload,
  ClusterMember,
  WorkflowConfig,
  ReviewContextRef,
  ProviderName,
  ModelName,
  EffortLevel,
  PlanSummary,
  PlanFull,
} from '@arco/shared';
import { ROLE_PRESETS } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { PlanBodyRenderer, CHECKBOX_RE } from './PlanBodyRenderer';
import { PlanRefsSection, PlanRefChips } from './plans/PlanRefsSection';
import { usePlanRefs } from './plans/planRefs';
import { ClusterMemberPicker } from './ClusterMemberPicker';
import { SpawnDialog } from './SpawnDialog';
import { ReviewDialog } from './ReviewDialog';

const PLAN_MAX_BYTES = 32768;
const PLAN_SOFT_WARN_BYTES = 28672;

// Same direction string the worker PLAN tab uses for SPAWN PHASE. Copied
// verbatim so the cluster surface produces a worker that interprets the
// task the same way; if the worker-side wording drifts, this should drift
// with it.
function planPhaseSpawnDirection(phaseBlock: string): string {
  return (
    `You are completing an entire PHASE of the attached plan. The phase is shown below, including all of its tasks. ` +
    `Walk through every \`[ ]\` task in this phase — sub-items under each task are part of that task. ` +
    `Do NOT start tasks from other phases.\n\n` +
    `Items marked \`[x]\` are already done — do NOT redo them. Items marked \`[ ]\` are pending.\n\n` +
    `When you finish, write a per-task summary of what you did so I can verify before checking each box. If you ran out of budget mid-phase, say which tasks remain.\n\n` +
    `Phase:\n${phaseBlock}`
  );
}

interface Props {
  cluster: ClusterStatePayload;
  onSetPlan?: (clusterId: string, body: string) => void;
  onAttachPlan?: (clusterId: string, planId: string) => void;
  onClearPlan?: (clusterId: string) => void;
  // Cluster-context wrappers around the same primitives the worker
  // PLAN tab calls. Threaded from App.tsx via ClusterTab → ClusterRightPanel.
  // When a handler isn't provided, the matching action pill / header
  // button is suppressed.
  //
  // SPAWN PHASE — spawns a fresh cluster member off the cluster's first
  // member's primary template, prefilled with a phase-scoped direction.
  // The new member's role defaults to BUILDER; operator can override before
  // confirming SpawnDialog.
  onSpawnPhase?: (newConfig: WorkflowConfig, newDirection: string, includePlan: boolean, joinClusterId: string) => void;
  // Review dispatch — pops the existing ReviewDialog after the operator
  // picks a member. `kind: 'plan-whole' | 'plan-phase'` rides on the
  // picked member's attached plan (cluster-plan bodies aren't backed by
  // a `.md` file, so the existing protocol can't resolve them directly).
  onReviewMember?: (
    workflowId: string,
    reviewer: { provider: ProviderName; model: ModelName; effort: EffortLevel },
    contextRef: ReviewContextRef,
    includeGitDiff: boolean,
  ) => void;
  // Cluster-routed review path (peer_send instead of sub-worker). Fired when
  // operator picks a cluster member as Reviewer in the ReviewDialog.
  onReviewViaMember?: (
    targetWorkflowId: string,
    reviewerWorkflowId: string,
    contextRef: ReviewContextRef,
    includeGitDiff: boolean,
  ) => void;
  // Snapshot the current cluster plan into a normal .arco/plans/ file and
  // attach that plan id to one chosen member's workflow.
  onAttachPlanToMember?: (workflowId: string, planId: string) => void;
}

// Pill row at the top of the PLAN tab. Cluster-flavoured: drops worker-only
// surfaces (DETACH / PROMOTE / MOVE / DONE) and replaces EDIT-in-place with
// an explicit VIEW/EDIT toggle. Sticks to the same letterSpacing + sizes
// as the worker tab so the two surfaces visually match.
const headerBtn: React.CSSProperties = {
  padding: '4px 9px',
  border: '1px solid var(--color-border-hairline)',
  background: 'transparent',
  color: 'var(--color-fg-muted)',
  fontSize: '10px',
  letterSpacing: '1.5px',
  cursor: 'pointer',
};
const headerBtnWarning: React.CSSProperties = {
  ...headerBtn,
  border: '1px solid var(--color-warning)',
  color: 'var(--color-warning)',
};

type ReviewPrefill = {
  ref: Extract<
    ReviewContextRef,
    { kind: 'plan-whole' | 'plan-phase' | 'plan-items' | 'cluster-plan-whole' | 'cluster-plan-phase' }
  >;
  label: string;
  initialIncludeGitDiff?: boolean;
};

// Pending action waiting on a member pick. The pill that triggered the
// picker stashes the eventual review prefill (or "custom prompt") shape so
// the picker's onPick can fire it with the resolved workflowId.
type PendingPick =
  | { kind: 'review-plan-whole'; mode: 'critique' | 'verify'; initialIncludeGitDiff?: boolean }
  | { kind: 'review-plan-phase'; heading: string; mode: 'critique' | 'verify'; initialIncludeGitDiff?: boolean }
  | { kind: 'review-custom' };

export function ClusterPlanTab({ cluster, onSetPlan, onAttachPlan, onClearPlan, onSpawnPhase, onReviewMember, onReviewViaMember, onAttachPlanToMember }: Props) {
  const remoteBody = cluster.plan?.body ?? '';
  const jobs = useAppStore((s) => s.jobs);
  const wsSendRaw = useAppStore((s) => s.wsSendRaw);

  // §10.7 P12.5 — plan→task bridge. Promote a plan checkbox into a durable
  // board task via the operator task_ledger_create path (first member is the
  // cwd-derived sender; boardKey follows the cluster's board mode). Only offered
  // when the board is attached, so the task lands on the board the operator sees.
  const boardAttached = cluster.taskBoardMode !== 'none';
  const promoteAnchor = cluster.members[0]?.workflowId ?? null;
  const promoteToTask = (taskText: string) => {
    const title = taskText.trim();
    if (!title || !promoteAnchor || !wsSendRaw) return;
    wsSendRaw({
      type: 'task_ledger_create',
      workflowId: promoteAnchor,
      ...(cluster.taskBoardKey ? { boardKey: cluster.taskBoardKey } : {}),
      title,
      links: [{ kind: 'plan', ref: cluster.plan?.id ?? cluster.clusterId }],
    });
  };
  // Auto-open in EDIT mode when there's no body yet — the operator's
  // intent on first visit is almost certainly "start typing." Subsequent
  // renders flip back to VIEW automatically after save.
  const { refs, reload: reloadRefs } = usePlanRefs(cluster.cwd, cluster.plan?.id, cluster.plan?.updatedAt);
  const refSlugs = useMemo(() => (refs ? new Set(refs.map((r) => r.slug)) : null), [refs]);
  const [openRefSlug, setOpenRefSlug] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'edit'>(remoteBody ? 'view' : 'edit');
  const [draft, setDraft] = useState(remoteBody);
  const [error, setError] = useState<string | null>(null);

  // When the upstream plan body changes (other tab edited, server pushed
  // cluster_state), sync the local draft only if the operator hasn't made
  // unsaved edits. Treat draft === prior remote as "no unsaved edit."
  const [lastRemote, setLastRemote] = useState(remoteBody);
  useEffect(() => {
    if (draft === lastRemote) {
      setDraft(remoteBody);
    }
    setLastRemote(remoteBody);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteBody]);

  // If a remote update drops the body to empty, auto-flip to EDIT.
  useEffect(() => {
    if (!remoteBody && mode === 'view') setMode('edit');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteBody]);

  const dirty = draft !== remoteBody;
  const byteLen = draft.length;
  const overSoft = byteLen > PLAN_SOFT_WARN_BYTES;
  const overHard = byteLen > PLAN_MAX_BYTES;

  // Existing-plans list — same `.arco/plans/` directory the per-workflow
  // PLAN tab reads from. Attaching one here binds the cluster to the same
  // canonical plan file workers use; future edits stay shared.
  const [plansList, setPlansList] = useState<PlanSummary[] | null>(null);
  const [importing, setImporting] = useState(false);
  // DUPLICATE PLAN — still available as an explicit duplicate action, but the
  // main SAVE path already writes through .arco/plans automatically.
  const [saveAsTitle, setSaveAsTitle] = useState<string | null>(null);
  const [saveAsBusy, setSaveAsBusy] = useState(false);
  const [attachSavedPlan, setAttachSavedPlan] = useState<{ plan: PlanFull; clearClusterAfterAttach: boolean } | null>(null);

  const refreshPlansList = useCallback(async () => {
    if (!cluster.cwd) return;
    try {
      const r = await fetch(`/api/plans?path=${encodeURIComponent(cluster.cwd)}`);
      if (!r.ok) return;
      const d = (await r.json()) as { plans: PlanSummary[] };
      setPlansList(d.plans);
    } catch { /* keep prior list */ }
  }, [cluster.cwd]);

  useEffect(() => {
    refreshPlansList();
    const onVisible = () => { if (document.visibilityState === 'visible') refreshPlansList(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { document.removeEventListener('visibilitychange', onVisible); };
  }, [refreshPlansList]);

  const handleAttachExisting = useCallback(async (planId: string, title: string) => {
    if (!onAttachPlan || !cluster.cwd) return;
    if (remoteBody && cluster.plan?.id !== planId && !window.confirm(`Attach "${title}" as the cluster plan?\n\nThe current cluster plan will be detached, but its .md file will remain available.`)) return;
    setImporting(true);
    setError(null);
    try {
      const r = await fetch(`/api/plans/body?path=${encodeURIComponent(cluster.cwd)}&planId=${encodeURIComponent(planId)}`);
      if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`);
      const d = (await r.json()) as { plan: PlanFull };
      const body = d.plan.body;
      if (body.trim().length === 0) {
        window.alert('That plan has an empty body — nothing to import.');
        return;
      }
      if (body.length > PLAN_MAX_BYTES) {
        window.alert(`Plan body is ${body.length} chars; cluster plan cap is ${PLAN_MAX_BYTES}. Trim it in the source plan first.`);
        return;
      }
      onAttachPlan(cluster.clusterId, planId);
      setDraft(body);
      setMode('view');
    } catch (err) {
      setError(`Failed to attach: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImporting(false);
    }
  }, [onAttachPlan, cluster.clusterId, cluster.cwd, cluster.plan?.id, remoteBody]);

  const createStandardPlanFromClusterBody = useCallback(async (): Promise<PlanFull | null> => {
    if (!cluster.cwd || saveAsTitle === null) return null;
    const title = saveAsTitle.trim();
    if (!title) return null;
    if (!remoteBody.trim()) {
      window.alert('Cluster plan is empty — nothing to save.');
      return null;
    }
    setSaveAsBusy(true);
    try {
      const r = await fetch(`/api/plans?path=${encodeURIComponent(cluster.cwd)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body: remoteBody }),
      });
      if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`);
      const d = (await r.json()) as { plan: PlanFull };
      await refreshPlansList();
      setSaveAsTitle(null);
      return d.plan;
    } catch (err) {
      window.alert(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      setSaveAsBusy(false);
    }
  }, [cluster.cwd, saveAsTitle, remoteBody, refreshPlansList]);

  const handleSaveAs = useCallback(async () => {
    await createStandardPlanFromClusterBody();
  }, [createStandardPlanFromClusterBody]);

  const handleSaveAndAttach = useCallback(async () => {
    if (!onAttachPlanToMember) return;
    const plan = await createStandardPlanFromClusterBody();
    if (plan) setAttachSavedPlan({ plan, clearClusterAfterAttach: false });
  }, [createStandardPlanFromClusterBody, onAttachPlanToMember]);

  const handleMoveAndAttach = useCallback(async () => {
    if (!onAttachPlanToMember || !onClearPlan) return;
    const plan = await createStandardPlanFromClusterBody();
    if (plan) setAttachSavedPlan({ plan, clearClusterAfterAttach: true });
  }, [createStandardPlanFromClusterBody, onAttachPlanToMember, onClearPlan]);

  // Pickers + dialogs.
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);
  const [reviewPrefill, setReviewPrefill] = useState<{
    workflowId: string;
    prefill?: ReviewPrefill;
    // Custom-prompt mode: dialog opens without a plan ref, operator types
    // a free-form review scope.
    custom?: boolean;
  } | null>(null);
  const [spawnPhase, setSpawnPhase] = useState<string | null>(null);

  const handleSave = () => {
    if (!onSetPlan) return;
    setError(null);
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setError('Plan body is empty. Use CLEAR PLAN to wipe.');
      return;
    }
    if (overHard) {
      setError(`Plan body exceeds the ${PLAN_MAX_BYTES}-char cap (${byteLen}). Trim it down before saving.`);
      return;
    }
    onSetPlan(cluster.clusterId, draft);
    // Optimistic flip; the server's cluster_state push will confirm the
    // body. Leaving the textarea open would force a second click.
    setMode('view');
  };

  const handleClear = () => {
    if (!onClearPlan) return;
    if (!window.confirm('Detach the shared cluster plan? The plan file stays available in this workspace. Members lose the plan block on their next turn.')) return;
    setError(null);
    setDraft('');
    onClearPlan(cluster.clusterId);
  };

  const handleDiscard = () => {
    setDraft(remoteBody);
    setError(null);
    if (remoteBody) setMode('view');
  };

  // VIEW-mode checkbox flip. Optimistic — the cluster_plan_set echo
  // re-broadcasts cluster_state which lands the same value. If the server
  // rejects (over hard cap is the only realistic reason), we revert on
  // the next remoteBody sync.
  const onToggleCheckbox = (lineIndex: number) => {
    if (!onSetPlan) return;
    const lines = remoteBody.split('\n');
    const m = lines[lineIndex]?.match(CHECKBOX_RE);
    if (!m) return;
    const [, indent, mark, rest] = m;
    const next = mark.toLowerCase() === 'x' ? ' ' : 'x';
    lines[lineIndex] = `${indent}- [${next}] ${rest}`;
    const newBody = lines.join('\n');
    setDraft(newBody);
    setLastRemote(newBody);
    onSetPlan(cluster.clusterId, newBody);
  };

  // SPAWN PHASE — open the existing SpawnDialog. Cluster context: the new
  // member joins this cluster, defaults to BUILDER role, primary inherited
  // from the cluster's first member (the existing parentConfig pipeline).
  const onClickSpawnPhase = (phaseText: string) => {
    setSpawnPhase(phaseText);
  };

  // Cluster-plan reviews don't need a target member — the plan body comes
  // from clusterStore (shared across the cluster), the code lives at the
  // cluster's cwd. The `workflowId` parameter on the review primitive only
  // roots the artifact filename + WS channel; using the first member is
  // arbitrary but safe. Skips the (confusing) "pick whose work" step.
  const dispatchPlanReview = (
    pick: { kind: 'review-plan-whole'; mode: 'critique' | 'verify'; initialIncludeGitDiff?: boolean }
        | { kind: 'review-plan-phase'; heading: string; mode: 'critique' | 'verify'; initialIncludeGitDiff?: boolean },
  ) => {
    const firstMember = cluster.members[0];
    if (!firstMember) return;
    const clusterLabel = cluster.name ?? cluster.clusterId.slice(0, 8);
    if (pick.kind === 'review-plan-whole') {
      setReviewPrefill({
        workflowId: firstMember.workflowId,
        prefill: {
          ref: { kind: 'cluster-plan-whole', clusterId: cluster.clusterId, mode: pick.mode },
          label: `CLUSTER PLAN: ${clusterLabel}`,
          ...(pick.initialIncludeGitDiff ? { initialIncludeGitDiff: true } : {}),
        },
      });
    } else {
      setReviewPrefill({
        workflowId: firstMember.workflowId,
        prefill: {
          ref: { kind: 'cluster-plan-phase', clusterId: cluster.clusterId, heading: pick.heading, mode: pick.mode },
          label: `${pick.mode === 'verify' ? 'WORK' : 'PLAN'} PHASE: ${pick.heading}`,
          ...(pick.initialIncludeGitDiff ? { initialIncludeGitDiff: true } : {}),
        },
      });
    }
  };

  // Picker resolves to a member; the pending action's `kind` decides what
  // dialog opens next. Only `review-custom` still uses this — it's
  // transcript-scoped (last-turn / last-N / full), so the operator does need
  // to pick whose transcript the review reads.
  const onMemberPicked = (member: ClusterMember) => {
    const pick = pendingPick;
    setPendingPick(null);
    if (!pick) return;
    if (pick.kind === 'review-plan-whole' || pick.kind === 'review-plan-phase') {
      // Cluster-plan-* refs carry the clusterId; the server reads the body
      // from clusterStore (meta.json) — no member planId needed. The picked
      // member is the worker that runs the review.
      const clusterLabel = cluster.name ?? cluster.clusterId.slice(0, 8);
      if (pick.kind === 'review-plan-whole') {
        setReviewPrefill({
          workflowId: member.workflowId,
          prefill: {
            ref: { kind: 'cluster-plan-whole', clusterId: cluster.clusterId, mode: pick.mode },
            label: `CLUSTER PLAN: ${clusterLabel}`,
            ...(pick.initialIncludeGitDiff ? { initialIncludeGitDiff: true } : {}),
          },
        });
      } else {
        setReviewPrefill({
          workflowId: member.workflowId,
          prefill: {
            ref: { kind: 'cluster-plan-phase', clusterId: cluster.clusterId, heading: pick.heading, mode: pick.mode },
            label: `${pick.mode === 'verify' ? 'WORK' : 'PLAN'} PHASE: ${pick.heading}`,
            ...(pick.initialIncludeGitDiff ? { initialIncludeGitDiff: true } : {}),
          },
        });
      }
    } else if (pick.kind === 'review-custom') {
      setReviewPrefill({ workflowId: member.workflowId, custom: true });
    }
  };

  // Cluster template — used for SpawnDialog parentConfig + BUILDER role
  // injection. Falls back to the focused member; if neither exists we
  // suppress the action pill (no member to clone from).
  const templateJob = jobs[cluster.members[0]?.workflowId ?? ''];

  return (
    <div data-help="cluster.plan-tab" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ color: 'var(--color-fg-muted)', fontSize: '10px', lineHeight: 1.4 }}>
        Shared per-cwd plan injected into every member&apos;s per-turn system block.
        Edits land on the NEXT turn — in-flight turns aren&apos;t torn down.
        Max {PLAN_MAX_BYTES} chars.
      </div>
      {cluster.plan && (
        <div className="display-font" style={{ color: 'var(--color-accent-secondary-dim)', fontSize: '10px', letterSpacing: '1.5px' }}>
          ACTIVE PLAN: {cluster.plan.title}
        </div>
      )}

      {/* Header action row — VIEW: render the rich body + a pill bar. EDIT:
          textarea + SAVE / CANCEL. Both modes share the CLEAR PLAN button
          and the byte-count footer below. */}
      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
        {mode === 'view' && remoteBody && (
          <button
            onClick={() => { setDraft(remoteBody); setMode('edit'); }}
            data-help="cluster.plan-tab.edit"
            className="display-font"
            style={headerBtn}
          >
            EDIT
          </button>
        )}
        {onClearPlan && cluster.plan && (
          <button
            onClick={handleClear}
            data-help="cluster.plan-tab.clear"
            className="display-font"
            style={headerBtnWarning}
          >
            CLEAR PLAN
          </button>
        )}
        {mode === 'view' && remoteBody && (
          <button
            onClick={() => {
              const fallback = cluster.name ?? `cluster ${cluster.clusterId.slice(0, 8)}`;
              setSaveAsTitle(fallback);
            }}
            data-help="cluster.plan-tab.save-as-plan"
            className="display-font"
            style={headerBtn}
            title="Duplicate this cluster plan body into a separate .md file"
          >
            DUPLICATE PLAN
          </button>
        )}
        {mode === 'view' && remoteBody && onReviewMember && (
          <>
            <button
              onClick={() => dispatchPlanReview({ kind: 'review-plan-whole', mode: 'critique' })}
              data-help="cluster.plan-tab.review-plan"
              className="display-font"
              style={headerBtn}
              title="Critique the whole cluster plan structure"
            >
              REVIEW PLAN
            </button>
            <button
              onClick={() => dispatchPlanReview({ kind: 'review-plan-whole', mode: 'verify', initialIncludeGitDiff: true })}
              data-help="cluster.plan-tab.verify-work"
              className="display-font"
              style={headerBtn}
              title="Verify claimed-done items against git diff (whole cluster plan)"
            >
              VERIFY WORK
            </button>
            <button
              onClick={() => setPendingPick({ kind: 'review-custom' })}
              data-help="cluster.plan-tab.custom-review"
              className="display-font"
              style={headerBtn}
              title="Free-form review prompt — pick a member to anchor"
            >
              CUSTOM REVIEW
            </button>
          </>
        )}
      </div>

      {/* DUPLICATE PLAN — inline title prompt. The active cluster plan is
          already stored under .arco/plans/ automatically; this creates a
          separate copy only when the operator asks for one. */}
      {saveAsTitle !== null && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            padding: '8px',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border-hairline)',
          }}
        >
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-accent-secondary-dim)' }}>
            DUPLICATE CLUSTER PLAN
          </div>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', lineHeight: 1.4 }}>
            Writes a separate file to <code>.arco/plans/</code>. The active cluster plan is already stored there automatically.
          </div>
          <input
            value={saveAsTitle}
            onChange={(e) => setSaveAsTitle(e.target.value)}
            placeholder="Plan title"
            autoFocus
            spellCheck={false}
            style={{
              background: 'var(--color-bg)',
              color: 'var(--color-fg)',
              border: '1px solid var(--color-border-hairline)',
              padding: '6px 8px',
              fontSize: '12px',
              fontFamily: 'var(--font-body)',
            }}
          />
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={handleSaveAs}
              disabled={saveAsBusy || !saveAsTitle.trim()}
              className="display-font"
              style={{
                ...headerBtn,
                color: saveAsBusy || !saveAsTitle.trim() ? 'var(--color-fg-muted)' : 'var(--color-accent-primary)',
                borderColor: saveAsBusy || !saveAsTitle.trim() ? 'var(--color-border-hairline)' : 'var(--color-accent-primary)',
              }}
            >
              {saveAsBusy ? 'SAVING…' : 'SAVE'}
            </button>
            {onAttachPlanToMember && (
              <button
                onClick={handleSaveAndAttach}
                disabled={saveAsBusy || !saveAsTitle.trim()}
                className="display-font"
                style={{
                  ...headerBtn,
                  color: saveAsBusy || !saveAsTitle.trim() ? 'var(--color-fg-muted)' : 'var(--color-accent-primary)',
                  borderColor: saveAsBusy || !saveAsTitle.trim() ? 'var(--color-border-hairline)' : 'var(--color-accent-primary)',
                }}
                title="Save a standard plan file, then choose which member workflow should attach it"
              >
                {saveAsBusy ? 'SAVING…' : 'SAVE & ATTACH…'}
              </button>
            )}
            {onAttachPlanToMember && onClearPlan && (
              <button
                onClick={handleMoveAndAttach}
                disabled={saveAsBusy || !saveAsTitle.trim()}
                className="display-font"
                style={{
                  ...headerBtn,
                  color: saveAsBusy || !saveAsTitle.trim() ? 'var(--color-fg-muted)' : 'var(--color-warning)',
                  borderColor: saveAsBusy || !saveAsTitle.trim() ? 'var(--color-border-hairline)' : 'var(--color-warning)',
                }}
                title="Save a standard plan file, attach it to a member, then clear the cluster plan"
              >
                {saveAsBusy ? 'SAVING…' : 'MOVE & ATTACH…'}
              </button>
            )}
            <button
              onClick={() => setSaveAsTitle(null)}
              className="display-font"
              style={headerBtn}
            >
              CANCEL
            </button>
          </div>
        </div>
      )}

      {/* EXISTING PLANS — surfaced in edit mode when there's no cluster body
          yet, mirroring the per-workflow PlanTab's empty-state list. Clicking
          a row attaches that existing plan id to the cluster. */}
      {mode === 'edit' && !remoteBody && onAttachPlan && plansList && plansList.filter((p) => p.completedAt == null).length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-accent-secondary-dim)' }}>
            ATTACH EXISTING PLAN
          </div>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', lineHeight: 1.4 }}>
            Uses the same <code>.arco/plans/</code> file workers can attach.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {plansList.filter((p) => p.completedAt == null).map((p) => (
              <button
                key={p.id}
                onClick={() => handleAttachExisting(p.id, p.title)}
                disabled={importing}
                data-help="cluster.plan-tab.import-existing"
                className="display-font"
                style={{
                  textAlign: 'left',
                  padding: '6px 8px',
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-border-hairline)',
                  color: importing ? 'var(--color-fg-muted)' : 'var(--color-fg)',
                  fontSize: '11px',
                  letterSpacing: '0.5px',
                  cursor: importing ? 'wait' : 'pointer',
                }}
                title="Click to attach this plan to the cluster"
              >
                {p.title}
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === 'edit' ? (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={'# Cluster plan\n- step 1: …\n- step 2: …'}
            spellCheck={false}
            style={{
              minHeight: '300px',
              background: 'var(--color-bg)',
              color: 'var(--color-fg)',
              border: '1px solid ' + (overHard ? 'var(--color-warning)' : 'var(--color-border-hairline)'),
              padding: '8px',
              fontSize: '12px',
              fontFamily: 'var(--font-code)',
              resize: 'vertical',
              lineHeight: 1.4,
            }}
          />

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '10px',
              color: overHard
                ? 'var(--color-warning)'
                : overSoft
                  ? 'var(--color-accent-secondary)'
                  : 'var(--color-fg-muted)',
            }}
          >
            <span>
              {byteLen} / {PLAN_MAX_BYTES} chars
              {overHard ? ' — over hard cap, cannot save' : overSoft ? ' — approaching cap' : ''}
            </span>
            {dirty && (
              <span style={{ marginLeft: 'auto', color: 'var(--color-accent-secondary)' }}>● unsaved</span>
            )}
          </div>

          {error && (
            <div style={{ color: 'var(--color-warning)', fontSize: '11px' }}>{error}</div>
          )}

          <div style={{ display: 'flex', gap: '6px' }}>
            {onSetPlan && (
              <button
                onClick={handleSave}
                disabled={!dirty || overHard || draft.trim().length === 0}
                className="display-font"
                style={{
                  padding: '6px 12px',
                  background: !dirty || overHard || draft.trim().length === 0
                    ? 'var(--color-bg)'
                    : 'var(--color-accent-primary)',
                  border: '1px solid ' + (
                    !dirty || overHard || draft.trim().length === 0
                      ? 'var(--color-border-hairline)'
                      : 'var(--color-accent-primary)'
                  ),
                  color: !dirty || overHard || draft.trim().length === 0
                    ? 'var(--color-fg-muted)'
                    : 'var(--color-bg)',
                  cursor: !dirty || overHard || draft.trim().length === 0 ? 'not-allowed' : 'pointer',
                  fontSize: '10px',
                  letterSpacing: '1px',
                }}
              >
                SAVE PLAN
              </button>
            )}
            <button
              onClick={handleDiscard}
              className="display-font"
              style={{
                padding: '6px 12px',
                background: 'transparent',
                border: '1px solid var(--color-border-hairline)',
                color: 'var(--color-fg-muted)',
                cursor: 'pointer',
                fontSize: '10px',
                letterSpacing: '1px',
              }}
            >
              {remoteBody ? 'CANCEL' : 'DISCARD'}
            </button>
          </div>
        </>
      ) : (
        <>
        <PlanRefChips refs={refs} onOpenSlug={setOpenRefSlug} />
        <PlanBodyRenderer
          body={remoteBody || null}
          loading={false}
          errorMessage={null}
          onToggleCheckbox={onToggleCheckbox}
          onOpenRef={setOpenRefSlug}
          refSlugs={refSlugs}
          onPromoteTask={boardAttached && promoteAnchor && wsSendRaw ? promoteToTask : undefined}
          onSpawnPhase={onSpawnPhase && templateJob ? (phaseText) => onClickSpawnPhase(phaseText) : undefined}
          onReviewPhase={onReviewMember
            ? (heading) => dispatchPlanReview({ kind: 'review-plan-phase', heading, mode: 'critique' })
            : undefined}
          onVerifyPhase={onReviewMember
            ? (heading) => dispatchPlanReview({ kind: 'review-plan-phase', heading, mode: 'verify', initialIncludeGitDiff: true })
            : undefined}
        />
        </>
      )}

      {!cluster.plan && mode === 'view' && (
        <div
          style={{
            padding: '8px',
            background: 'var(--color-bg)',
            border: '1px dashed var(--color-border-hairline)',
            color: 'var(--color-fg-muted)',
            fontSize: '11px',
          }}
        >
          No plan attached yet. Write one above + click SAVE PLAN, attach an
          existing plan from the list, or PROMOTE TO CLUSTER from any
          member&apos;s per-workflow PLAN tab. The plan is stored under this
          cwd&apos;s <code>.arco/plans/</code> directory.
        </div>
      )}

      {cluster.plan && (
        <div style={{ color: 'var(--color-fg-muted)', fontSize: '10px' }}>
          Last updated {new Date(cluster.plan.updatedAt).toLocaleString()}
        </div>
      )}

      {cluster.plan && cluster.cwd && (
        <PlanRefsSection
          cwd={cluster.cwd}
          planId={cluster.plan.id}
          refs={refs}
          reload={reloadRefs}
          openSlug={openRefSlug}
          onOpenSlug={setOpenRefSlug}
        />
      )}

      {pendingPick && (
        <ClusterMemberPicker
          cluster={cluster}
          title={
            pendingPick.kind === 'review-plan-whole'
              ? (pendingPick.mode === 'verify' ? 'STEP 1 of 2 — Whose work to verify?' : 'STEP 1 of 2 — Whose plan critique?')
              : pendingPick.kind === 'review-plan-phase'
                ? (pendingPick.mode === 'verify' ? 'STEP 1 of 2 — Whose phase work to verify?' : 'STEP 1 of 2 — Whose phase to critique?')
                : 'STEP 1 of 2 — Whose work to review?'
          }
          subtitle={
            pendingPick.kind === 'review-custom'
              ? "Pick whose transcript / context is being reviewed. The next screen picks who does the review (sub-worker or a cluster peer)."
              : "Pick whose work claims you're verifying — the reviewer reads this member's transcript as evidence. The next screen picks who does the review (sub-worker or a cluster peer)."
          }
          onPick={onMemberPicked}
          onCancel={() => setPendingPick(null)}
        />
      )}

      {attachSavedPlan && onAttachPlanToMember && (
        <ClusterMemberPicker
          cluster={cluster}
          title="ATTACH PLAN TO MEMBER"
          subtitle={`Attach "${attachSavedPlan.plan.title}" as a normal workflow plan. This replaces that member's currently attached worker plan, if any.${attachSavedPlan.clearClusterAfterAttach ? ' The cluster plan will be cleared after attach.' : ' The cluster plan remains unchanged.'}`}
          onPick={(member) => {
            onAttachPlanToMember(member.workflowId, attachSavedPlan.plan.id);
            if (attachSavedPlan.clearClusterAfterAttach && onClearPlan) {
              onClearPlan(cluster.clusterId);
            }
            setAttachSavedPlan(null);
          }}
          onCancel={() => setAttachSavedPlan(null)}
        />
      )}

      {spawnPhase !== null && onSpawnPhase && templateJob && (
        <SpawnDialog
          parentConfig={templateJob.config}
          parentPlanTitle={cluster.plan ? 'cluster plan' : null}
          // SPAWN PHASE in cluster context — default the new member's role
          // to BUILDER. The role text is the preset's canonical body; the
          // operator can override before confirming. (Role isn't a field
          // on SpawnDialog; it lands on the cluster member after the
          // member joins. We embed the role nudge in the direction so the
          // immediate first turn sees it. The post-spawn role chip can be
          // set from the cluster Members tab.)
          initialDirection={(() => {
            const builder = ROLE_PRESETS.find((p) => p.key === 'builder');
            const rolePrefix = builder ? `Role: ${builder.text}\n\n` : '';
            return rolePrefix + planPhaseSpawnDirection(spawnPhase);
          })()}
          initialIncludePlan
          clusterContext={{ clusterId: cluster.clusterId, name: cluster.name ?? cluster.clusterId.slice(0, 8) }}
          onConfirm={(newConfig, newDirection, includePlan) => {
            setSpawnPhase(null);
            onSpawnPhase(newConfig, newDirection, includePlan, cluster.clusterId);
          }}
          onCancel={() => setSpawnPhase(null)}
        />
      )}

      {reviewPrefill !== null && onReviewMember && (() => {
        const memberJob = jobs[reviewPrefill.workflowId];
        if (!memberJob) {
          // The picked member was torn down between pick and dialog open.
          // Fail closed — log + cancel.
          // eslint-disable-next-line no-console
          console.warn('[cluster-plan] picked member vanished before review dispatch');
          setReviewPrefill(null);
          return null;
        }
        return (
          <ReviewDialog
            primary={{
              provider: memberJob.config.primaryProvider ?? 'claude',
              model: memberJob.config.primaryModel,
              effort: memberJob.config.primaryEffort,
              providerAccountRef: memberJob.config.providerAccountRef,
            }}
            {...(reviewPrefill.prefill
              ? {
                  prefilledPlanRef: reviewPrefill.prefill.ref,
                  prefilledScopeLabel: reviewPrefill.prefill.label,
                  initialIncludeGitDiff: reviewPrefill.prefill.initialIncludeGitDiff,
                }
              : {})}
            onConfirm={(reviewer, contextRef, includeGitDiff) => {
              setReviewPrefill(null);
              onReviewMember(reviewPrefill.workflowId, reviewer, contextRef, includeGitDiff);
            }}
            onCancel={() => setReviewPrefill(null)}
            clusterContext={{
              clusterId: cluster.clusterId,
              selfWorkflowId: reviewPrefill.workflowId,
              members: cluster.members.map((m) => ({ workflowId: m.workflowId, displayName: m.displayName })),
            }}
            onConfirmViaMember={onReviewViaMember ? (reviewerWfid, contextRef, includeGitDiff) => {
              setReviewPrefill(null);
              onReviewViaMember(reviewPrefill.workflowId, reviewerWfid, contextRef, includeGitDiff);
            } : undefined}
          />
        );
      })()}
    </div>
  );
}
