import { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import type { ProviderName, ModelName, EffortLevel, PlanSummary, PlanFull, WorkflowConfig, ReviewContextRef } from '@archon/shared';
import { useAppStore, type JobState } from '../../stores/appStore';
import { SpawnDialog } from '../SpawnDialog';
import { ReviewDialog } from '../ReviewDialog';
import { PlanReviewPicker } from '../PlanReviewPicker';
import { PlanBodyRenderer, CHECKBOX_RE } from '../PlanBodyRenderer';
import { EmptyState } from './FilesTab';
import { MoveTargetModal } from './MoveTargetModal';
import { PlanListRow } from './PlanListRow';
import { PlanWorkflowsSection } from './PlanWorkflowsSection';
import { PlanRefsSection, PlanRefChips } from '../plans/PlanRefsSection';
import { usePlanRefs } from '../plans/planRefs';
import { openArchive } from '../../explorer/launch';
import { formatRelativeTime } from './format';

// Plan tab: long-form markdown brief attached to this workflow. Plans live
// at <cwd>/.archon/plans/<id>.md and are explicitly attached (never
// auto-bound by cwd, since one folder can host independent projects).
// Server prepends a one-line "active plan" header to every primary turn so
// the agent stays aware; on edit it injects the full body once.
export function PlanTab({
  job,
  onAttach,
  onDetach,
  onPromoteToCluster,
  onSpawn,
  onReview,
}: {
  job: JobState;
  onAttach?: (planId: string) => void;
  onDetach?: () => void;
  // Phase 2.6 — PROMOTE TO CLUSTER copies the attached plan body up to
  // the cluster's shared plan. PlanTab gates the button on cluster
  // membership via the appStore.
  onPromoteToCluster?: (body: string) => void;
  onSpawn?: (newConfig: WorkflowConfig, newDirection: string, includePlan: boolean) => void;
  onReview?: (
    reviewer: { provider: ProviderName; model: ModelName; effort: EffortLevel },
    contextRef: ReviewContextRef,
    includeGitDiff: boolean,
  ) => void;
}) {
  const cwd = job.config.workingDirectory;
  const plan = job.plan ?? null;
  // Phase 2.6 — PROMOTE TO CLUSTER gating. The button is visible only when
  // this workflow is currently a cluster member; we read the cluster map
  // straight from the store rather than threading a flag.
  const clusters = useAppStore((s) => s.clusters);
  const memberClusterId = useMemo(() => {
    for (const c of Object.values(clusters)) {
      if (c.members.some((m) => m.workflowId === job.id)) return c.clusterId;
    }
    return undefined;
  }, [clusters, job.id]);
  // Distinct cwds from every other open tab — MOVE TO PROJECT picker uses
  // these as one-click targets so the operator doesn't have to retype paths.
  // Select the raw jobs map (stable identity from Zustand) and derive in
  // useMemo so we don't return a fresh array per render and trip Zustand's
  // equality check (which would loop-render until the page locks up).
  const jobs = useAppStore((s) => s.jobs);
  const otherTabCwds: string[] = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const j of Object.values(jobs)) {
      const d = j.config.workingDirectory;
      if (!d || d === cwd) continue;
      if (seen.has(d)) continue;
      seen.add(d);
      out.push(d);
    }
    return out.sort();
  }, [jobs, cwd]);
  // MOVE TO PROJECT modal state. Null = closed; { planId, title } = open
  // for that specific plan. Local to PlanTab.
  const [moveTarget, setMoveTarget] = useState<{ planId: string; title: string } | null>(null);
  const [list, setList] = useState<PlanSummary[] | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  // When set, opens SpawnDialog prefilled with the task line text. Cleared
  // on confirm/cancel. Local to PlanTab so dismissing the dialog doesn't
  // also tear down the body fetch.
  const [spawnTaskText, setSpawnTaskText] = useState<string | null>(null);
  // Same shape as spawnTaskText but carries a phase block (H3 + everything
  // up to the next heading). Drives the Spawn-Phase dialog.
  const [spawnPhaseText, setSpawnPhaseText] = useState<string | null>(null);
  // When set, opens ReviewDialog prefilled with a plan-* ref. The label
  // is shown in the dialog's locked SCOPE row. Cleared on confirm/cancel.
  const [reviewPrefill, setReviewPrefill] = useState<{
    ref: Extract<ReviewContextRef, { kind: 'plan-whole' | 'plan-phase' | 'plan-items' }>;
    label: string;
    // VERIFY WORK / VERIFY PHASE set this so the dialog opens with
    // INCLUDE GIT DIFF already on. REVIEW PLAN / REVIEW PHASE leave it
    // unset (operator can still tick manually).
    initialIncludeGitDiff?: boolean;
  } | null>(null);
  // When true, opens PlanReviewPicker. On confirm the picker hands back
  // an itemIds[] + label which we feed into reviewPrefill.
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  // Tracks the planId currently rendered in `body`. Used to distinguish
  // "switched to a different plan" (clear body) from "same plan, refetch
  // because updatedAt bumped" (keep prior body until new one lands).
  const lastPlanIdRef = useRef<string | null>(null);
  // Reference docs for the attached plan + the open ref viewer (shared by the
  // list rows and the plan body's ref chips).
  const { refs, reload: reloadRefs } = usePlanRefs(cwd, plan?.id, plan?.updatedAt);
  const refSlugs = useMemo(() => (refs ? new Set(refs.map((r) => r.slug)) : null), [refs]);
  const [openRefSlug, setOpenRefSlug] = useState<string | null>(null);

  // List refetch helper — also called from the mark-complete / reopen /
  // delete handlers so the picker reflects the new state without waiting
  // for a tab switch.
  const refreshList = useCallback(async () => {
    if (!cwd) return;
    try {
      const r = await fetch(`/api/plans?path=${encodeURIComponent(cwd)}`);
      if (!r.ok) return;
      const d = (await r.json()) as { plans: PlanSummary[] };
      setList(d.plans);
    } catch { /* keep prior list */ }
  }, [cwd]);

  // List refresh — runs when cwd changes or the active plan's identity /
  // updatedAt changes (so a save bubbles into the picker too). Also runs on
  // visibilitychange so cross-tab attach/detach activity in another browser
  // window propagates as soon as the operator looks at this tab again.
  useEffect(() => {
    if (!cwd) return;
    refreshList();
    const onVisible = () => { if (document.visibilityState === 'visible') refreshList(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { document.removeEventListener('visibilitychange', onVisible); };
  }, [cwd, plan?.id, plan?.updatedAt, refreshList]);

  // Mark a plan complete (server auto-detaches from any attached workflows).
  const handleMarkComplete = useCallback(async (planId: string, title: string) => {
    if (!cwd) return;
    if (!window.confirm(`Mark "${title}" complete? It'll be archived and detached from any workflows currently using it.`)) return;
    try {
      const res = await fetch(`/api/plans?path=${encodeURIComponent(cwd)}&planId=${encodeURIComponent(planId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completedAt: Date.now() }),
      });
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      await refreshList();
    } catch (err) {
      window.alert(`Failed to mark complete: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [cwd, refreshList]);

  const handleReopen = useCallback(async (planId: string) => {
    if (!cwd) return;
    try {
      const res = await fetch(`/api/plans?path=${encodeURIComponent(cwd)}&planId=${encodeURIComponent(planId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completedAt: null }),
      });
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      await refreshList();
    } catch (err) {
      window.alert(`Failed to reopen: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [cwd, refreshList]);

  const handleDelete = useCallback(async (planId: string, title: string) => {
    if (!cwd) return;
    if (!window.confirm(`Delete plan "${title}" permanently? This removes the .md file and all attachment history. Cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/plans?path=${encodeURIComponent(cwd)}&planId=${encodeURIComponent(planId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      await refreshList();
    } catch (err) {
      window.alert(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [cwd, refreshList]);

  // Move a plan to a different project directory. Server validates the
  // target, detaches any source-cwd workflows from the plan, and atomically
  // moves the .md + index entry. Plan id is preserved; attachments aren't
  // (they refer to workflows in the old cwd).
  const handleMove = useCallback(async (planId: string, targetCwd: string) => {
    if (!cwd) return;
    const trimmed = targetCwd.trim();
    if (!trimmed) {
      window.alert('Pick a target project directory.');
      return;
    }
    if (trimmed === cwd) {
      window.alert('Target must differ from the source directory.');
      return;
    }
    try {
      const res = await fetch(
        `/api/plans/move?path=${encodeURIComponent(cwd)}&planId=${encodeURIComponent(planId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetCwd: trimmed }),
        },
      );
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      setMoveTarget(null);
      await refreshList();
    } catch (err) {
      window.alert(`Failed to move: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [cwd, refreshList]);

  // Body fetch — runs when the attached plan changes or its updatedAt bumps.
  // The latter fires after the server-side PATCH echoes plan_attached over WS.
  // We only clear the visible body when switching to a *different* plan;
  // on a same-plan refetch (after agent edits → watcher reconcile) the prior
  // body stays on screen until the new content lands so the panel doesn't
  // flicker through "loading…" on every agent edit.
  useEffect(() => {
    if (!cwd || !plan?.id) {
      setBody(null);
      setDraftTitle('');
      setDraftBody('');
      lastPlanIdRef.current = null;
      return;
    }
    if (lastPlanIdRef.current !== plan.id) {
      setBody(null);
      lastPlanIdRef.current = plan.id;
    }
    let cancelled = false;
    setBodyLoading(true);
    setBodyError(null);
    fetch(`/api/plans/body?path=${encodeURIComponent(cwd)}&planId=${encodeURIComponent(plan.id)}`)
      .then(async (r) => {
        if (r.ok) return (await r.json()) as { plan: PlanFull };
        const text = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}${text ? ` — ${text.slice(0, 200)}` : ''}`);
      })
      .then((d) => {
        if (cancelled) return;
        setBody(d.plan.body);
        // Don't clobber an in-flight edit — the operator's draft wins until
        // they save or cancel.
        if (!editing) {
          setDraftTitle(d.plan.title);
          setDraftBody(d.plan.body);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setBody(null);
        setBodyError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setBodyLoading(false); });
    return () => { cancelled = true; };
  // editing intentionally omitted — we don't want toggling edit mode to refetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, plan?.id, plan?.updatedAt]);

  if (!cwd) return <EmptyState text="No working directory bound to this tab." />;

  if (!plan) {
    return (
      <div style={{ padding: '14px 16px', overflowY: 'auto', flex: 1, minHeight: 0 }}>
        <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-fg-muted)', marginBottom: '10px' }}>
          NO PLAN ATTACHED
        </div>
        <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', marginBottom: '14px', lineHeight: 1.5 }}>
          A plan is an itemized checklist the agent sees as a one-line note before every turn (it reads the file on demand). Long-form detail goes in the plan's reference docs, linked from tasks. Attach an existing plan from this workspace, or create a new one. Plans live at <code>.archon/plans/</code>.
        </div>
        <button
          onClick={() => { void openArchive('plans'); }}
          data-help="plan.library"
          className="display-font"
          style={{ ...planMiniBtn, marginBottom: '14px' }}
          title="Browse and review every plan across all projects, without attaching one"
        >
          ⌸ ALL PLANS
        </button>

        {!creating && (() => {
          const activePlans = (list ?? []).filter((p) => p.completedAt == null);
          const completedPlans = (list ?? []).filter((p) => p.completedAt != null);
          return (
            <>
              {list === null && <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>loading…</div>}
              {activePlans.length > 0 && (
                <>
                  <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-accent-secondary-dim)', marginBottom: '6px' }}>
                    EXISTING PLANS
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
                    {activePlans.map((p) => (
                      <PlanListRow
                        key={p.id}
                        plan={p}
                        onAttach={() => onAttach?.(p.id)}
                        onComplete={() => handleMarkComplete(p.id, p.title)}
                        onDelete={() => handleDelete(p.id, p.title)}
                      />
                    ))}
                  </div>
                </>
              )}
              <button onClick={() => setCreating(true)} data-help="plan.new" className="display-font" style={planMiniBtn}>
                + NEW PLAN
              </button>
              {completedPlans.length > 0 && (
                <div style={{ marginTop: '14px' }}>
                  <button
                    onClick={() => setShowCompleted((v) => !v)}
                    data-help="plan.toggle-completed"
                    className="display-font"
                    style={{
                      padding: '4px 0',
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--color-fg-muted)',
                      fontSize: '10px',
                      letterSpacing: '1.2px',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    {showCompleted ? '▼' : '▶'} {completedPlans.length} completed
                  </button>
                  {showCompleted && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
                      {completedPlans.map((p) => (
                        <PlanListRow
                          key={p.id}
                          plan={p}
                          onReopen={() => handleReopen(p.id)}
                          onDelete={() => handleDelete(p.id, p.title)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          );
        })()}

        {creating && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Plan title"
              style={planInputStyle}
            />
            <textarea
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              placeholder="# Goal&#10;# Constraints&#10;# Open questions"
              rows={14}
              style={planTextareaStyle}
            />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                disabled={saving || !newTitle.trim()}
                onClick={async () => {
                  setSaving(true);
                  setError(null);
                  try {
                    const res = await fetch(`/api/plans?path=${encodeURIComponent(cwd)}`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ title: newTitle, body: newBody }),
                    });
                    if (!res.ok) throw new Error(await res.text());
                    const d = (await res.json()) as { plan: PlanFull };
                    onAttach?.(d.plan.id);
                    setCreating(false);
                    setNewTitle('');
                    setNewBody('');
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setSaving(false);
                  }
                }}
                className="display-font"
                style={planMiniBtn}
              >
                {saving ? 'SAVING…' : 'CREATE & ATTACH'}
              </button>
              <button
                onClick={() => { setCreating(false); setNewTitle(''); setNewBody(''); setError(null); }}
                className="display-font"
                style={planMiniBtn}
              >
                CANCEL
              </button>
            </div>
            {error && <div style={{ color: 'var(--color-warning)', fontSize: '10px' }}>{error}</div>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: '14px 16px', overflowY: 'auto', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div>
        <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)' }}>
          ACTIVE PLAN
        </div>
        <div style={{ fontSize: '13px', color: 'var(--color-accent-primary)', fontWeight: 600, marginTop: '2px', wordBreak: 'break-word' }}>
          {plan.title}
        </div>
        <div style={{ fontSize: '9px', color: 'var(--color-fg-muted)', marginTop: '2px' }}>
          edited {formatRelativeTime(plan.updatedAt)}
        </div>
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '8px' }}>
          {!editing && (
            <span data-help="plan.edit" style={{ display: 'inline-flex' }}>
            <button
              disabled={bodyLoading}
              onClick={() => setEditing(true)}
              className="display-font"
              style={planMiniBtn}
            >
              EDIT
            </button>
            </span>
          )}
          <button onClick={onDetach} data-help="plan.detach" className="display-font" style={planMiniBtn}>DETACH</button>
          {/* Phase 2.6 — copy this plan body to the cluster's shared plan.
              Only rendered for cluster-member workflows when the operator's
              hook is wired. One-click — operator confirms via window.confirm
              so an accidental click doesn't overwrite an existing cluster
              plan silently. */}
          {memberClusterId && onPromoteToCluster && body && (
            <button
              onClick={() => {
                if (!body || body.trim().length === 0) {
                  window.alert('Plan body is empty — nothing to promote.');
                  return;
                }
                if (body.length > 32768) {
                  window.alert(`Plan body is ${body.length} chars; cluster plan cap is 32768. Trim it first.`);
                  return;
                }
                if (!window.confirm('Promote this plan body to the cluster\'s shared plan?\n\nAny existing cluster plan will be overwritten, and this worker\'s local plan will be detached afterwards (the cluster plan becomes the single source of truth).')) return;
                onPromoteToCluster(body);
              }}
              className="display-font"
              style={planMiniBtn}
              title="Copy this plan body up to the cluster's shared plan"
            >
              PROMOTE TO CLUSTER
            </button>
          )}
          {!editing && onReview && plan && (
            <button
              onClick={() => setReviewPrefill({
                ref: { kind: 'plan-whole', planId: plan.id, mode: 'critique' },
                label: `PLAN: ${plan.title}`,
              })}
              data-help="plan.review-plan"
              className="display-font"
              style={planMiniBtn}
              title="Critique the plan structure — gaps, ordering, missing considerations"
            >
              REVIEW PLAN
            </button>
          )}
          {!editing && onReview && plan && (
            <button
              onClick={() => setReviewPrefill({
                ref: { kind: 'plan-whole', planId: plan.id, mode: 'verify' },
                label: `WORK: ${plan.title}`,
                initialIncludeGitDiff: true,
              })}
              data-help="plan.verify-work"
              className="display-font"
              style={planMiniBtn}
              title="Verify the claimed-done items against git diff + tools"
            >
              VERIFY WORK
            </button>
          )}
          {!editing && onReview && plan && body !== null && (
            <button
              onClick={() => setShowCustomPicker(true)}
              data-help="plan.custom-review"
              className="display-font"
              style={planMiniBtn}
              title="Pick specific items across phases to review"
            >
              CUSTOM REVIEW
            </button>
          )}
          {!editing && (
            <button
              onClick={() => setMoveTarget({ planId: plan.id, title: plan.title })}
              data-help="plan.move"
              className="display-font"
              style={planMiniBtn}
              title="Move this plan's .md file to a different project directory"
            >
              MOVE
            </button>
          )}
          {!editing && (
            <button
              onClick={() => handleMarkComplete(plan.id, plan.title)}
              data-help="plan.mark-complete"
              className="display-font"
              style={planMiniBtn}
              title="Archive this plan and detach it from any attached workflows"
            >
              ✓ DONE
            </button>
          )}
          {!editing && (
            <button
              onClick={() => handleDelete(plan.id, plan.title)}
              data-help="plan.delete"
              className="display-font"
              style={planMiniBtnDanger}
              title="Delete plan permanently"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <>
          <input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} style={planInputStyle} />
          <textarea
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            rows={20}
            style={planTextareaStyle}
          />
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              disabled={saving || !draftTitle.trim()}
              className="display-font"
              style={planMiniBtn}
              onClick={async () => {
                setSaving(true);
                setError(null);
                try {
                  const res = await fetch(`/api/plans?path=${encodeURIComponent(cwd)}&planId=${encodeURIComponent(plan.id)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: draftTitle, body: draftBody }),
                  });
                  if (!res.ok) throw new Error(await res.text());
                  const d = (await res.json()) as { plan: PlanFull };
                  setBody(d.plan.body);
                  setEditing(false);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? 'SAVING…' : 'SAVE'}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setDraftTitle(plan.title);
                if (body !== null) setDraftBody(body);
                setError(null);
              }}
              className="display-font"
              style={planMiniBtn}
            >
              CANCEL
            </button>
          </div>
          {error && <div style={{ color: 'var(--color-warning)', fontSize: '10px' }}>{error}</div>}
        </>
      ) : (
        <>
          {bodyError && (
            <div style={{ color: 'var(--color-warning)', fontSize: '10px', fontFamily: 'var(--font-body)' }}>
              Body fetch failed: {bodyError}
            </div>
          )}
          <PlanRefChips refs={refs} onOpenSlug={setOpenRefSlug} />
          <PlanBodyRenderer
            body={body}
            loading={bodyLoading}
            errorMessage={bodyError}
            onSpawnTask={onSpawn ? (taskText) => setSpawnTaskText(taskText) : undefined}
            onSpawnPhase={onSpawn ? (phaseText) => setSpawnPhaseText(phaseText) : undefined}
            onReviewPhase={onReview && plan ? (heading) => setReviewPrefill({
              ref: { kind: 'plan-phase', planId: plan.id, heading, mode: 'critique' },
              label: `PLAN PHASE: ${heading}`,
            }) : undefined}
            onVerifyPhase={onReview && plan ? (heading) => setReviewPrefill({
              ref: { kind: 'plan-phase', planId: plan.id, heading, mode: 'verify' },
              label: `WORK PHASE: ${heading}`,
              initialIncludeGitDiff: true,
            }) : undefined}
            onOpenRef={setOpenRefSlug}
            refSlugs={refSlugs}
            onToggleCheckbox={async (lineIndex) => {
              if (!cwd || body === null) return;
              const lines = body.split('\n');
              const m = lines[lineIndex]?.match(CHECKBOX_RE);
              if (!m) return;
              const [, indent, mark, rest] = m;
              const next = mark.toLowerCase() === 'x' ? ' ' : 'x';
              const newLine = `${indent}- [${next}] ${rest}`;
              const newLines = [...lines];
              newLines[lineIndex] = newLine;
              const newBody = newLines.join('\n');
              const prev = body;
              // Optimistic flip — server PATCH below will re-broadcast
              // plan_attached, which refetches and confirms the same value.
              setBody(newBody);
              try {
                const res = await fetch(
                  `/api/plans?path=${encodeURIComponent(cwd)}&planId=${encodeURIComponent(plan.id)}`,
                  {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ body: newBody }),
                  },
                );
                if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
              } catch (err) {
                setBody(prev);
                setBodyError(err instanceof Error ? err.message : String(err));
              }
            }}
          />
          <PlanRefsSection
            cwd={cwd}
            planId={plan.id}
            refs={refs}
            reload={reloadRefs}
            openSlug={openRefSlug}
            onOpenSlug={setOpenRefSlug}
          />
          <PlanWorkflowsSection
            attachments={list?.find((p) => p.id === plan.id)?.attachments}
            currentWorkflowId={job.id}
            showPast={showPast}
            onTogglePast={() => setShowPast((v) => !v)}
          />
        </>
      )}
      {spawnTaskText !== null && onSpawn && (
        <SpawnDialog
          parentConfig={job.config}
          parentPlanTitle={plan?.title ?? null}
          initialDirection={planTaskSpawnDirection(spawnTaskText)}
          initialIncludePlan
          onConfirm={(newConfig, newDirection, includePlan) => {
            setSpawnTaskText(null);
            onSpawn(newConfig, newDirection, includePlan);
          }}
          onCancel={() => setSpawnTaskText(null)}
        />
      )}
      {spawnPhaseText !== null && onSpawn && (
        <SpawnDialog
          parentConfig={job.config}
          parentPlanTitle={plan?.title ?? null}
          initialDirection={planPhaseSpawnDirection(spawnPhaseText)}
          initialIncludePlan
          onConfirm={(newConfig, newDirection, includePlan) => {
            setSpawnPhaseText(null);
            onSpawn(newConfig, newDirection, includePlan);
          }}
          onCancel={() => setSpawnPhaseText(null)}
        />
      )}
      {reviewPrefill !== null && onReview && (
        <ReviewDialog
          primary={{
            provider: job.config.primaryProvider ?? 'claude',
            model: job.config.primaryModel,
            effort: job.config.primaryEffort,
            providerAccountRef: job.config.providerAccountRef,
          }}
          prefilledPlanRef={reviewPrefill.ref}
          prefilledScopeLabel={reviewPrefill.label}
          initialIncludeGitDiff={reviewPrefill.initialIncludeGitDiff}
          onConfirm={(reviewer, contextRef, includeGitDiff) => {
            setReviewPrefill(null);
            onReview(reviewer, contextRef, includeGitDiff);
          }}
          onCancel={() => setReviewPrefill(null)}
        />
      )}
      {showCustomPicker && plan && body !== null && (
        <PlanReviewPicker
          planTitle={plan.title}
          planBody={body}
          onConfirm={(itemIds, label) => {
            setShowCustomPicker(false);
            setReviewPrefill({
              ref: { kind: 'plan-items', planId: plan.id, itemIds, mode: 'verify' },
              label,
            });
          }}
          onCancel={() => setShowCustomPicker(false)}
        />
      )}
      {moveTarget && (
        <MoveTargetModal
          planTitle={moveTarget.title}
          sourceCwd={cwd ?? ''}
          tabCwds={otherTabCwds}
          onConfirm={(target) => handleMove(moveTarget.planId, target)}
          onCancel={() => setMoveTarget(null)}
        />
      )}
    </div>
  );
}

// Compose the prefilled `direction` for a plan-task spawn. Three pieces
// are load-bearing for local thinking models:
//
//   1. "ONE task from the plan" — narrows scope so the spawn doesn't try
//      to take on the whole plan in one go.
//   2. "Sub-items below count as part of this task" — earlier wording
//      ("stay tightly in scope") was ambiguous about whether nested
//      bullets under the parent checkbox were part of "this task" or
//      "other tasks." Models read it conservatively and skipped sub-items.
//   3. "Items marked [x] are already done" — the agent has the full plan
//      attached but won't infer "do not redo completed work" without the
//      explicit instruction. Operator can still edit before confirming.
function planTaskSpawnDirection(taskBlock: string): string {
  return (
    `You are working on ONE task from the attached plan. The task is shown below, including any sub-items beneath it. ` +
    `Sub-items under the task line are part of THIS task — complete them all. ` +
    `Do NOT start unrelated tasks from elsewhere in the plan.\n\n` +
    `Items in the plan marked \`[x]\` are already done — do NOT redo them. Items marked \`[ ]\` are pending.\n\n` +
    `When you finish, write a short summary of what you did so I can verify before checking the box. If a sub-item turns out to be larger than expected and you ran out of budget, say so explicitly in the summary so I know which sub-items still need attention.\n\n` +
    `Task:\n${taskBlock}`
  );
}

// Spawn-phase direction. Same shape as planTaskSpawnDirection but framed at
// the phase level — the spawned worker should walk every `[ ]` task in this
// phase, not just one. The phase block carries the H3 heading + every line
// up to the next H1/H2/H3.
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

const planMiniBtn: React.CSSProperties = {
  padding: '5px 10px',
  background: 'transparent',
  border: '1px solid var(--color-accent-primary-dim)',
  color: 'var(--color-accent-primary)',
  cursor: 'pointer',
  fontSize: '10px',
  letterSpacing: '1.5px',
  fontFamily: 'var(--font-display)',
};

const planMiniBtnDanger: React.CSSProperties = {
  ...planMiniBtn,
  border: '1px solid var(--color-warning, #f04a4a)',
  color: 'var(--color-warning, #f04a4a)',
};

const planInputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--color-bg-sunken)',
  border: '1px solid var(--color-border-hairline)',
  color: 'var(--color-accent-primary)',
  padding: '6px 8px',
  fontSize: '12px',
  fontFamily: 'var(--font-body)',
  outline: 'none',
  boxSizing: 'border-box',
};

const planTextareaStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--color-bg-sunken)',
  border: '1px solid var(--color-border-hairline)',
  color: 'var(--color-accent-primary)',
  padding: '8px 10px',
  fontSize: '12px',
  fontFamily: 'var(--font-mono, monospace)',
  outline: 'none',
  resize: 'vertical',
  boxSizing: 'border-box',
  lineHeight: 1.5,
};
