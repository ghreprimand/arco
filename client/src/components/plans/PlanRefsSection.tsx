// REFERENCE DOCS section + viewer for one plan. Shared by the workflow PLAN
// tab, the cluster PLAN sub-tab, and the explorer PLANS lens. The plan stays a
// lean checklist; long-form detail lives in refs the checklist links to
// (`[label](ref:slug)`), so this is where the operator reads/edits that detail.
//
// Controlled `openSlug` so the plan body's ref chips (PlanBodyRenderer
// `onOpenRef`) open the same viewer the list rows do.

import { useEffect, useState, type CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PlanRefSummary } from '@arco/shared';
import { fetchPlanRef, removePlanRef, savePlanRef, REF_SLUG_RE, slugify } from './planRefs';

interface Props {
  cwd: string;
  planId: string;
  refs: PlanRefSummary[] | null;
  reload: () => void | Promise<void>;
  openSlug: string | null;
  onOpenSlug: (slug: string | null) => void;
}

export function PlanRefsSection({ cwd, planId, refs, reload, openSlug, onOpenSlug }: Props) {
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const slug = newSlug.trim();
    if (!REF_SLUG_RE.test(slug)) { setError('slug: lowercase letters, digits, dashes'); return; }
    if (refs?.some((r) => r.slug === slug)) { setError('a ref with that slug exists'); return; }
    setBusy(true);
    setError(null);
    try {
      await savePlanRef(cwd, planId, slug, `# ${newTitle.trim() || slug}\n\n`);
      setCreating(false);
      setNewTitle('');
      setNewSlug('');
      setSlugTouched(false);
      await reload();
      onOpenSlug(slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-help="plan.refs" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-accent-secondary-dim)' }}>
          REFERENCE DOCS{refs ? ` · ${refs.length}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {!creating && (
          <button className="display-font" style={miniBtn} onClick={() => { setCreating(true); setError(null); }} title="Add a reference doc to this plan">
            + REF
          </button>
        )}
      </div>
      {creating && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            autoFocus
            placeholder="Title"
            value={newTitle}
            onChange={(e) => { setNewTitle(e.target.value); if (!slugTouched) setNewSlug(slugify(e.target.value)); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setCreating(false); }}
            style={{ ...inputStyle, flex: '2 1 140px' }}
          />
          <input
            placeholder="slug"
            value={newSlug}
            onChange={(e) => { setNewSlug(e.target.value); setSlugTouched(true); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setCreating(false); }}
            style={{ ...inputStyle, flex: '1 1 90px' }}
          />
          <button className="display-font" style={miniBtn} disabled={busy} onClick={() => void create()}>CREATE</button>
          <button className="display-font" style={miniBtn} onClick={() => { setCreating(false); setError(null); }}>CANCEL</button>
        </div>
      )}
      {error && <div style={{ color: 'var(--color-warning)', fontSize: '10px' }}>{error}</div>}
      {refs === null ? (
        <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>loading…</div>
      ) : refs.length === 0 ? (
        <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
          None. Keep the plan a checklist — put specs, research, and design detail here and link it from a task as <code>[label](ref:slug)</code>.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--color-border-hairline)' }}>
          {refs.map((r) => (
            <button
              key={r.slug}
              onClick={() => onOpenSlug(r.slug)}
              className="archive-row"
              style={{
                display: 'flex', alignItems: 'baseline', gap: '8px', textAlign: 'left',
                padding: '5px 8px', background: 'transparent', border: 'none',
                borderBottom: '1px solid var(--color-border-hairline)', cursor: 'pointer',
                color: 'var(--color-accent-primary)', fontSize: '11px', fontFamily: 'var(--font-body)', minWidth: 0,
              }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
              <span style={{ fontSize: '9px', color: 'var(--color-fg-muted)', flexShrink: 0 }}>ref:{r.slug}</span>
              <span style={{ fontSize: '9px', color: 'var(--color-fg-muted)', flexShrink: 0 }}>{fmtBytes(r.bytes)}</span>
            </button>
          ))}
        </div>
      )}
      {openSlug && (
        <PlanRefViewer
          cwd={cwd}
          planId={planId}
          slug={openSlug}
          exists={refs === null || refs.some((r) => r.slug === openSlug)}
          onClose={() => onOpenSlug(null)}
          onChanged={() => void reload()}
        />
      )}
    </div>
  );
}

// Compact strip of a plan's refs for the top of a plan view, so the docs are
// visible without scrolling past a long checklist to the REFERENCE DOCS list.
// Opens the same viewer (via the shared `onOpenSlug`). Renders nothing when
// the plan has no refs.
export function PlanRefChips({ refs, onOpenSlug }: { refs: PlanRefSummary[] | null; onOpenSlug: (slug: string) => void }) {
  if (!refs || refs.length === 0) return null;
  return (
    <div data-help="plan.refs" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '5px' }}>
      <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1.5px', color: 'var(--color-accent-secondary-dim)' }}>
        REFS
      </span>
      {refs.map((r) => (
        <button
          key={r.slug}
          type="button"
          onClick={() => onOpenSlug(r.slug)}
          title={`${r.title}\nref:${r.slug} · ${fmtBytes(r.bytes)} — click to read`}
          style={{
            padding: '1px 7px', background: 'var(--color-accent-secondary-a10)',
            border: '1px solid var(--color-accent-secondary-dim)', borderRadius: '3px',
            color: 'var(--color-accent-secondary)', cursor: 'pointer', fontSize: '10px',
            fontFamily: 'var(--font-body)', maxWidth: '220px', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          ⧉ {r.title}
        </button>
      ))}
    </div>
  );
}

// Exported for surfaces that open one ref without the full section (the
// cluster board's task drawer).
export function PlanRefViewer({ cwd, planId, slug, exists, onClose, onChanged }: {
  cwd: string; planId: string; slug: string; exists: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [title, setTitle] = useState(slug);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBody(null);
    setError(null);
    setEditing(false);
    if (!exists) {
      // A link to a ref nobody wrote yet — offer to create it in place.
      setBody('');
      setDraft(`# ${slug}\n\n`);
      setEditing(true);
      return;
    }
    fetchPlanRef(cwd, planId, slug)
      .then((r) => { if (!cancelled) { setBody(r.body); setTitle(r.title); setDraft(r.body); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [cwd, planId, slug, exists]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !editing) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, onClose]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await savePlanRef(cwd, planId, slug, draft);
      setBody(draft);
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!window.confirm(`Delete reference doc "ref:${slug}"? Links to it in the plan will show as missing.`)) return;
    try {
      await removePlanRef(cwd, planId, slug);
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      onClick={editing ? undefined : onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.78)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, backdropFilter: 'blur(3px)' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glow-border"
        style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-accent-secondary)', borderRadius: '6px', width: 'min(860px, calc(94vw / var(--ui-scale, 1)))', maxHeight: 'calc(88vh / var(--ui-scale, 1))', display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border-hairline)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span className="display-font" style={{ fontSize: '10px', padding: '2px 6px', border: '1px solid var(--color-accent-secondary)', color: 'var(--color-accent-secondary)', letterSpacing: '2px', borderRadius: '2px' }}>
            REF
          </span>
          <span className="display-font glow-text" style={{ flex: 1, minWidth: 0, fontSize: '13px', letterSpacing: '1px', color: 'var(--color-accent-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </span>
          <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>ref:{slug}</span>
          {!editing && body !== null && (
            <button className="display-font" style={miniBtn} onClick={() => { setDraft(body); setEditing(true); }}>EDIT</button>
          )}
          {!editing && exists && <button className="display-font" style={dangerBtn} onClick={() => void del()}>✕</button>}
          {!editing && <button onClick={onClose} title="Close (Esc)" style={closeBtn}>×</button>}
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: editing ? '10px 14px' : '16px', minHeight: 0 }}>
          {error && <div style={{ color: 'var(--color-warning)', fontSize: '11px', marginBottom: '8px' }}>{error}</div>}
          {editing ? (
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              style={{ width: '100%', minHeight: 'calc(52vh / var(--ui-scale, 1))', background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)', color: 'var(--color-accent-primary)', padding: '8px', fontSize: '12px', fontFamily: 'var(--font-body)', resize: 'vertical', outline: 'none', boxSizing: 'border-box' }}
            />
          ) : body === null ? (
            !error && <div style={{ color: 'var(--color-fg-muted)', fontSize: '12px' }}>loading…</div>
          ) : (
            <div className="arco-markdown" style={{ color: 'var(--color-accent-primary)', fontFamily: 'var(--font-body)', fontSize: '13px', lineHeight: 1.55 }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
            </div>
          )}
        </div>
        {editing && (
          <div style={{ padding: '10px 14px', borderTop: '1px solid var(--color-border-hairline)', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            {!exists && <span style={{ flex: 1, fontSize: '10px', color: 'var(--color-fg-muted)', alignSelf: 'center' }}>This ref doesn't exist yet — saving creates it.</span>}
            <button className="display-font" style={miniBtn} onClick={() => { if (exists) setEditing(false); else onClose(); }}>CANCEL</button>
            <button className="display-font" style={miniBtn} disabled={saving} onClick={() => void save()}>{saving ? 'SAVING…' : 'SAVE'}</button>
          </div>
        )}
      </div>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}

const miniBtn: CSSProperties = {
  padding: '4px 9px',
  background: 'transparent',
  border: '1px solid var(--color-accent-primary-dim)',
  color: 'var(--color-accent-primary)',
  cursor: 'pointer',
  fontSize: '10px',
  letterSpacing: '1.5px',
  fontFamily: 'var(--font-display)',
};

const dangerBtn: CSSProperties = {
  ...miniBtn,
  border: '1px solid var(--color-warning, #f04a4a)',
  color: 'var(--color-warning, #f04a4a)',
};

const closeBtn: CSSProperties = {
  background: 'none', border: '1px solid var(--color-border-hairline)', borderRadius: '3px',
  color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '14px', padding: '0 8px', lineHeight: '22px',
};

const inputStyle: CSSProperties = {
  background: 'var(--color-bg-sunken)',
  border: '1px solid var(--color-border-hairline)',
  color: 'var(--color-accent-primary)',
  padding: '5px 7px',
  fontSize: '11px',
  fontFamily: 'var(--font-body)',
  outline: 'none',
  minWidth: 0,
};
