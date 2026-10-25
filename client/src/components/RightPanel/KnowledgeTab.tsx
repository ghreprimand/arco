import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import type { JobState } from '../../stores/appStore';
import type {
  KnowledgeArticle,
  KnowledgeArticleSummary,
  KnowledgeListResponse,
  RecallBacklinksResponse,
  RecallEntry,
} from '@archon/shared';
import { EmptyState } from './FilesTab';
import { KnowledgeWizard } from './KnowledgeWizard';

// WORKBENCH_EXPANSION_PLAN.md §B3 — Knowledge tab.
//
// List / search / edit the per-cwd, OPERATOR-OWNED knowledge base. Articles
// flagged "always include" fold into every turn's system prompt as a BOUNDED
// block; this tab shows the running always-include byte total against the
// injection budget so the operator sees how close they are to the cap.
//
// THE FENCE: pure operator-driven CRUD over REST (/api/knowledge). The only LLM
// involvement is the wizard's optional "distill from session" DRAFT, which is
// always followed by an explicit operator Save. Nothing is auto-saved.

export function KnowledgeTab({ job }: { job: JobState }) {
  const cwd = job.config.workingDirectory;
  const [data, setData] = useState<KnowledgeListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [nonce, setNonce] = useState(0);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<KnowledgeArticle | null>(null);

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    setError(null);
    const params = new URLSearchParams({ path: cwd });
    if (q.trim()) params.set('q', q.trim());
    fetch(`/api/knowledge?${params.toString()}`)
      .then((r) => r.json())
      .then((body: KnowledgeListResponse) => { if (!cancelled) setData(body); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [cwd, q, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const save = useCallback(
    async (fields: { title: string; body: string; tags: string[]; alwaysInclude: boolean }, editingId?: string) => {
      if (!cwd) return;
      const params = new URLSearchParams({ path: cwd });
      if (editingId) params.set('id', editingId);
      const res = await fetch(`/api/knowledge?${params.toString()}`, {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `save failed (${res.status})`);
      }
      refresh();
    },
    [cwd, refresh],
  );

  const openEdit = useCallback(async (id: string) => {
    if (!cwd) return;
    const params = new URLSearchParams({ path: cwd, id });
    const res = await fetch(`/api/knowledge/body?${params.toString()}`);
    if (!res.ok) return;
    const body = await res.json();
    setEditing(body.article as KnowledgeArticle);
    setWizardOpen(true);
  }, [cwd]);

  const toggleAlways = useCallback(async (a: KnowledgeArticleSummary) => {
    if (!cwd) return;
    const params = new URLSearchParams({ path: cwd, id: a.id });
    await fetch(`/api/knowledge?${params.toString()}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alwaysInclude: !a.alwaysInclude }),
    });
    refresh();
  }, [cwd, refresh]);

  const remove = useCallback(async (id: string) => {
    if (!cwd) return;
    const params = new URLSearchParams({ path: cwd, id });
    await fetch(`/api/knowledge?${params.toString()}`, { method: 'DELETE' });
    refresh();
  }, [cwd, refresh]);

  const budgetPct = useMemo(() => {
    if (!data || data.budget === 0) return 0;
    return Math.min(1, data.alwaysIncludeBytes / data.budget);
  }, [data]);

  if (!cwd) return <EmptyState text="No working directory for this workflow." />;

  if (wizardOpen) {
    return (
      <KnowledgeWizard
        job={job}
        editing={editing}
        onSave={save}
        onClose={() => { setWizardOpen(false); setEditing(null); }}
      />
    );
  }

  const articles = data?.articles ?? [];
  const overBudget = data ? data.alwaysIncludeBytes > data.budget : false;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div className="display-font" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px 4px', fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)' }}>
        <span>KNOWLEDGE</span>
        <button data-help="rightpanel.knowledge.add" onClick={() => { setEditing(null); setWizardOpen(true); }} style={btnStyle}>+ ADD</button>
      </div>

      {/* Injection budget bar — the bounded-context guarantee, made visible. */}
      {data && (
        <div data-help="rightpanel.knowledge.budget" style={{ padding: '2px 12px 6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: overBudget ? 'var(--color-danger, #d66)' : 'var(--color-fg-muted)' }}>
            <span>always-include in context</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {fmtBytes(data.alwaysIncludeBytes)} / {fmtBytes(data.budget)}{overBudget ? ' — over budget, will truncate' : ''}
            </span>
          </div>
          <div style={{ height: '4px', background: 'var(--color-border-hairline)', borderRadius: '2px', marginTop: '3px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${budgetPct * 100}%`, background: overBudget ? 'var(--color-danger, #d66)' : 'var(--color-accent-primary)' }} />
          </div>
        </div>
      )}

      <div style={{ padding: '0 12px 6px' }}>
        <input
          data-help="rightpanel.knowledge.search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search title / tags…"
          style={searchStyle}
        />
      </div>

      {error && <EmptyState text={`Couldn't load knowledge base: ${error}`} />}
      {!error && articles.length === 0 && (
        <EmptyState text="No articles yet. Click + ADD to build up operator-owned project knowledge — a curated companion to CLAUDE.md the agent reads each turn." />
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px' }}>
        {articles.map((a) => (
          <div key={a.id} style={{ borderBottom: '1px solid var(--color-border-hairline)', padding: '6px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
              <button onClick={() => openEdit(a.id)} style={{ ...linkBtnStyle, fontSize: '12px', color: 'var(--color-fg)', fontWeight: 600 }}>
                {a.title}
              </button>
              <span style={{ fontSize: '9px', color: 'var(--color-fg-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtBytes(a.bytes)}</span>
            </div>
            {a.tags.length > 0 && (
              <div style={{ fontSize: '9px', color: 'var(--color-fg-muted)', marginTop: '2px' }}>{a.tags.map((t) => `#${t}`).join(' ')}</div>
            )}
            <div style={{ display: 'flex', gap: '10px', marginTop: '4px', fontSize: '9px' }}>
              <button data-help="rightpanel.knowledge.toggle-always" onClick={() => toggleAlways(a)} style={{ ...linkBtnStyle, color: a.alwaysInclude ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)' }}>
                {a.alwaysInclude ? '● always include' : '○ on-demand'}
              </button>
              <button onClick={() => openEdit(a.id)} style={linkBtnStyle}>edit</button>
              <button data-help="rightpanel.knowledge.delete" onClick={() => remove(a.id)} style={{ ...linkBtnStyle, color: 'var(--color-danger, #d66)' }}>delete</button>
            </div>
            {/* §F4 — recall back-links: conversations the operator linked to this
                article (via Recall's "Distill to KB"). Click-through opens the
                conversation tab if it's open. */}
            <LinkedConversations articleId={a.id} cwd={cwd} />
          </div>
        ))}
      </div>
    </div>
  );
}

// §F4 — "Linked conversations" back-links for one article. Fetches
// GET /api/recall/backlinks?type=kb&id=<articleId>&cwd=<cwd> (cwd-scoped —
// article ids are unique per cwd). Read-only + degrades to nothing on failure
// or when there are no links (so an article with no back-links is silent).
function LinkedConversations({ articleId, cwd }: { articleId: string; cwd: string }) {
  const [entries, setEntries] = useState<RecallEntry[]>([]);
  const jobs = useAppStore((s) => s.jobs);
  const setActiveJob = useAppStore((s) => s.setActiveJob);
  const setActiveCluster = useAppStore((s) => s.setActiveCluster);
  const pushNotification = useAppStore((s) => s.pushNotification);

  useEffect(() => {
    if (!cwd || !articleId) return;
    let cancelled = false;
    const params = new URLSearchParams({ type: 'kb', id: articleId, cwd });
    fetch(`/api/recall/backlinks?${params.toString()}`)
      .then((r) => r.json())
      .then((body: RecallBacklinksResponse) => { if (!cancelled) setEntries(body.entries ?? []); })
      .catch(() => { if (!cancelled) setEntries([]); });
    return () => { cancelled = true; };
  }, [articleId, cwd]);

  if (entries.length === 0) return null;

  const open = (wfid: string) => {
    if (jobs[wfid]) {
      setActiveCluster(null);
      setActiveJob(wfid);
    } else {
      pushNotification('info', 'This conversation is not an open tab. Open its project folder to resume it.');
    }
  };

  return (
    <div data-help="rightpanel.knowledge.backlinks" style={{ marginTop: '4px', fontSize: '9px', color: 'var(--color-fg-muted)' }}>
      <div style={{ letterSpacing: '0.5px' }}>linked conversations</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', marginTop: '2px' }}>
        {entries.map((e) => (
          <button
            key={e.wfid}
            onClick={() => open(e.wfid)}
            title={`Open "${e.title}"`}
            style={{ ...linkBtnStyle, fontSize: '10px', color: 'var(--color-accent-primary-dim, var(--color-accent-primary))' }}
          >
            ↳ {e.title}
          </button>
        ))}
      </div>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

const btnStyle: React.CSSProperties = { background: 'transparent', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '9px', letterSpacing: '1px', padding: '2px 8px', fontFamily: 'var(--font-display)' };
const linkBtnStyle: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--color-fg-muted)', cursor: 'pointer', padding: 0, fontSize: '10px', fontFamily: 'var(--font-body)', textAlign: 'left' };
const searchStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: 'var(--color-bg-input, var(--color-bg))', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg)', fontSize: '11px', padding: '4px 7px', borderRadius: '3px', fontFamily: 'var(--font-body)' };
