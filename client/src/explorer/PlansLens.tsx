import { useEffect, useMemo, useState } from 'react';
import type { PlanFull, PlanLibraryEntry, PlanLibraryProject } from '@arco/shared';
import { formatRelativeTime } from '../components/RightPanel/format';
import { PlanBodyRenderer, CHECKBOX_RE } from '../components/PlanBodyRenderer';
import { PlanWorkflowsSection } from '../components/RightPanel/PlanWorkflowsSection';
import { PlanRefsSection, PlanRefChips } from '../components/plans/PlanRefsSection';
import { usePlanRefs } from '../components/plans/planRefs';

// PLANS lens — the plans library. Every plan across every known project
// (GET /api/explorer/plans), browsable and reviewable without attaching it to
// a workflow. Left: filter + search, grouped by project. Right: the selected
// plan rendered (checkbox ticks allowed), its reference docs, attachment
// history, and edit / done / reopen / delete through the ordinary /api/plans
// routes — so attached tabs see the same plan_attached refresh they always do.
// Pure HTTP, refetch on `focusTick` like the other lenses.

type StatusFilter = 'active' | 'completed' | 'all';

interface Selection { cwd: string; planId: string }

export function PlansLens({ focusTick }: { focusTick: number }) {
  const [projects, setProjects] = useState<PlanLibraryProject[] | null>(null);
  const [status, setStatus] = useState<StatusFilter>('active');
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<Selection | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/explorer/plans')
      .then((r) => r.json() as Promise<{ projects?: PlanLibraryProject[] }>)
      .then((d) => { if (!cancelled) setProjects(d.projects ?? []); })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, [focusTick, tick]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (projects ?? [])
      .map((p) => ({
        ...p,
        plans: p.plans.filter((pl) => {
          const done = pl.completedAt != null;
          if (status === 'active' && done) return false;
          if (status === 'completed' && !done) return false;
          return !q || pl.title.toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
        }),
      }))
      .filter((p) => p.plans.length > 0);
  }, [projects, status, query]);

  const selectedEntry = useMemo(() => {
    if (!sel) return null;
    const proj = projects?.find((p) => p.cwd === sel.cwd);
    const plan = proj?.plans.find((p) => p.id === sel.planId);
    return proj && plan ? { project: proj, plan } : null;
  }, [projects, sel]);

  const total = (projects ?? []).reduce((n, p) => n + p.plans.length, 0);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
      <div style={{ width: '360px', flexShrink: 0, borderRight: '1px solid var(--color-border-hairline)', display: 'flex', flexDirection: 'column', padding: '14px 14px 0', minHeight: 0 }}>
        <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
          {(['active', 'completed', 'all'] as StatusFilter[]).map((s) => (
            <button key={s} onClick={() => setStatus(s)} className="display-font" style={chip(status === s)}>{s.toUpperCase()}</button>
          ))}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: '11px', color: 'var(--color-fg-muted)', alignSelf: 'center' }}>{total} plans</span>
        </div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search plan or project…" style={searchStyle} />
        <div style={{ flex: 1, overflowY: 'auto', marginTop: '10px', paddingBottom: '12px' }}>
          {projects === null ? (
            <Muted text="Loading plans…" />
          ) : filtered.length === 0 ? (
            <Muted text={query || status !== 'all' ? 'No plans match.' : 'No plans in any known project.'} />
          ) : filtered.map((proj) => (
            <div key={proj.cwd} style={{ marginBottom: '12px' }}>
              <div className="display-font" title={proj.cwd} style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {proj.name.toUpperCase()} <span style={{ color: 'var(--color-fg-muted)' }}>· {proj.plans.length}</span>
              </div>
              {proj.plans.map((pl) => (
                <PlanRow
                  key={pl.id}
                  plan={pl}
                  active={sel?.cwd === proj.cwd && sel.planId === pl.id}
                  onClick={() => setSel({ cwd: proj.cwd, planId: pl.id })}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selectedEntry ? (
          <PlanDetail
            key={`${selectedEntry.project.cwd}:${selectedEntry.plan.id}`}
            cwd={selectedEntry.project.cwd}
            projectName={selectedEntry.project.name}
            entry={selectedEntry.plan}
            onChanged={() => setTick((t) => t + 1)}
            onDeleted={() => { setSel(null); setTick((t) => t + 1); }}
          />
        ) : (
          <Muted text="Select a plan to review it." />
        )}
      </div>
    </div>
  );
}

function PlanRow({ plan, active, onClick }: { plan: PlanLibraryEntry; active: boolean; onClick: () => void }) {
  const done = plan.completedAt != null;
  return (
    <button
      onClick={onClick}
      className="archive-row"
      style={{
        display: 'flex', alignItems: 'center', gap: '8px', width: '100%', textAlign: 'left',
        padding: '7px 8px', border: 'none', borderLeft: `2px solid ${active ? 'var(--color-accent-primary)' : 'transparent'}`,
        background: active ? 'var(--color-accent-primary-a10)' : 'transparent', cursor: 'pointer',
        color: 'var(--color-fg)', fontFamily: 'var(--font-body)', fontSize: '13px',
      }}
    >
      <span title={done ? 'Completed' : plan.attached ? 'Attached' : 'Not attached'} style={{ width: '10px', flexShrink: 0, color: done ? 'var(--color-fg-muted)' : plan.attached ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)' }}>
        {done ? '✓' : plan.attached ? '●' : '○'}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: done ? 0.65 : 1 }}>{plan.title}</span>
      {plan.refCount > 0 && <span title={`${plan.refCount} reference docs`} style={{ fontSize: '10px', color: 'var(--color-accent-secondary-dim)', flexShrink: 0 }}>⧉{plan.refCount}</span>}
      <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', flexShrink: 0 }}>{formatRelativeTime(plan.updatedAt)}</span>
    </button>
  );
}

function PlanDetail({ cwd, projectName, entry, onChanged, onDeleted }: {
  cwd: string; projectName: string; entry: PlanLibraryEntry; onChanged: () => void; onDeleted: () => void;
}) {
  const [plan, setPlan] = useState<PlanFull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [openRef, setOpenRef] = useState<string | null>(null);
  const { refs, reload } = usePlanRefs(cwd, entry.id, entry.updatedAt);
  const refSlugs = useMemo(() => (refs ? new Set(refs.map((r) => r.slug)) : null), [refs]);
  const planUrl = `/api/plans?path=${encodeURIComponent(cwd)}&planId=${encodeURIComponent(entry.id)}`;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/plans/body?path=${encodeURIComponent(cwd)}&planId=${encodeURIComponent(entry.id)}`)
      .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return (await r.json()) as { plan: PlanFull }; })
      .then((d) => { if (!cancelled) { setPlan(d.plan); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [cwd, entry.id, entry.updatedAt]);

  const patch = async (body: Record<string, unknown>): Promise<boolean> => {
    try {
      const r = await fetch(planUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
      const d = (await r.json()) as { plan: PlanFull };
      setPlan(d.plan);
      onChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const done = (plan?.completedAt ?? entry.completedAt) != null;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="display-font glow-text-cyan" style={{ fontSize: '17px', letterSpacing: '1px', wordBreak: 'break-word' }}>{plan?.title ?? entry.title}</div>
          <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)', marginTop: '2px' }} title={cwd}>
            {projectName} · {done ? 'completed' : entry.attached ? 'attached' : 'not attached'} · updated {formatRelativeTime(plan?.updatedAt ?? entry.updatedAt)}
            {entry.clusters.length > 0 && <> · cluster {entry.clusters.map((c) => c.name).join(', ')}</>}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', marginTop: '2px' }}>.arco/plans/{entry.id}.md</div>
        </div>
        {!editing && plan && (
          <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
            <button className="display-font" style={btn} onClick={() => { setDraftTitle(plan.title); setDraftBody(plan.body); setEditing(true); }}>EDIT</button>
            {done ? (
              <button className="display-font" style={btn} onClick={() => void patch({ completedAt: null })}>REOPEN</button>
            ) : (
              <button
                className="display-font"
                style={btn}
                title="Archive this plan and detach it from any attached workflows"
                onClick={() => { if (window.confirm(`Mark "${plan.title}" complete? It is detached from any workflow using it.`)) void patch({ completedAt: Date.now() }); }}
              >✓ DONE</button>
            )}
            <button
              className="display-font"
              style={dangerBtn}
              title="Delete plan permanently (with its reference docs)"
              onClick={async () => {
                if (!window.confirm(`Delete "${plan.title}" permanently, including its reference docs? Attached workflows are detached first.`)) return;
                const r = await fetch(planUrl, { method: 'DELETE' }).catch(() => null);
                if (r?.ok) onDeleted(); else setError('delete failed');
              }}
            >✕</button>
          </div>
        )}
      </div>
      {error && <div style={{ color: 'var(--color-warning)', fontSize: '12px' }}>{error}</div>}
      {!editing && <PlanRefChips refs={refs} onOpenSlug={setOpenRef} />}
      {editing ? (
        <>
          <input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} style={searchStyle} />
          <textarea value={draftBody} onChange={(e) => setDraftBody(e.target.value)} rows={24} style={{ ...searchStyle, fontSize: '13px', resize: 'vertical', minHeight: 'calc(45vh / var(--ui-scale, 1))' }} />
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="display-font" style={btn} disabled={saving || !draftTitle.trim()} onClick={async () => {
              setSaving(true);
              if (await patch({ title: draftTitle, body: draftBody })) setEditing(false);
              setSaving(false);
            }}>{saving ? 'SAVING…' : 'SAVE'}</button>
            <button className="display-font" style={btn} onClick={() => setEditing(false)}>CANCEL</button>
          </div>
        </>
      ) : (
        <PlanBodyRenderer
          body={plan?.body ?? null}
          loading={!plan && !error}
          errorMessage={error}
          onOpenRef={setOpenRef}
          refSlugs={refSlugs}
          onToggleCheckbox={(lineIndex) => {
            if (!plan) return;
            const lines = plan.body.split('\n');
            const m = lines[lineIndex]?.match(CHECKBOX_RE);
            if (!m) return;
            const [, indent, mark, rest] = m;
            lines[lineIndex] = `${indent}- [${mark.toLowerCase() === 'x' ? ' ' : 'x'}] ${rest}`;
            const prev = plan;
            setPlan({ ...plan, body: lines.join('\n') });
            void patch({ body: lines.join('\n') }).then((ok) => { if (!ok) setPlan(prev); });
          }}
        />
      )}
      <PlanRefsSection cwd={cwd} planId={entry.id} refs={refs} reload={reload} openSlug={openRef} onOpenSlug={setOpenRef} />
      <PlanWorkflowsSection attachments={entry.attachments} currentWorkflowId="" showPast={showPast} onTogglePast={() => setShowPast((v) => !v)} />
    </div>
  );
}

function Muted({ text }: { text: string }) {
  return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-fg-muted)', fontSize: '13px', fontStyle: 'italic', padding: '24px', textAlign: 'center' }}>{text}</div>;
}

const chip = (on: boolean): React.CSSProperties => ({
  background: on ? 'var(--color-accent-primary-a10)' : 'transparent',
  border: `1px solid ${on ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
  borderRadius: '3px', color: on ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)',
  cursor: 'pointer', fontSize: '11px', letterSpacing: '1px', padding: '4px 9px',
});
const btn: React.CSSProperties = {
  background: 'transparent', border: '1px solid var(--color-accent-primary-dim)', borderRadius: '3px',
  color: 'var(--color-accent-primary)', cursor: 'pointer', fontSize: '11px', letterSpacing: '1.5px', padding: '5px 10px',
};
const dangerBtn: React.CSSProperties = { ...btn, border: '1px solid var(--color-warning, #f04a4a)', color: 'var(--color-warning, #f04a4a)' };
const searchStyle: React.CSSProperties = {
  background: 'var(--color-bg-panel)', border: '1px solid var(--color-border-hairline)', borderRadius: '4px',
  color: 'var(--color-fg)', fontFamily: 'var(--font-body)', fontSize: '13px', padding: '7px 10px', outline: 'none', boxSizing: 'border-box', width: '100%',
};
