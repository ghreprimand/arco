import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../../stores/appStore';
import { useRecallStore, EMPTY_FILTERS, type RecallSearchFilters } from '../../stores/recallStore';
import { RecallResultRow } from './RecallResultRow';
import type { ProviderName, ModelName, EffortLevel, RecallLink } from '@arco/shared';
import { WorkSurfaceControls } from '../workSurface/WorkSurfaceControls';

// Workbench Expansion §F3 — top-level Recall search view.
//
// A full-screen overlay (NOT a per-tab RightPanel sub-tab) — the single place
// to keyword-search every conversation Arco has ever run. Backed by the F1
// machine-global index + the F3 FTS5/ripgrep search engine (GET
// /api/recall/search). Deterministic; NO LLM (Part F fence).
//
// Entry points: the command palette ("Recall: search conversations") and the
// header RECALL button (both flip appStore.showRecall). Mounts like UserManual
// — a portal modal dismissed with Escape / backdrop click.
//
// Search runs debounced as the operator types; filters (project / provider /
// date / transcript toggle) re-run on change. The empty query returns the
// recent list so the view is never blank on open.
//
// Result actions (RecallResultRow):
//   - LIVE: Jump to transcript / Resume — if the hit's workflow is an open tab,
//     switch to it (+ flash the matching point when we have an anchor; today
//     hits are conversation-level so we just activate the tab). If it's not an
//     open tab, we can't silently resume an arbitrary archived workflow from
//     here (that needs the WorkflowCreator resume path); the button explains via
//     its tooltip rather than erroring. Opening the conversation is "enough" per
//     the plan's "if only a wfid is known, opening the workflow is enough".
//   - STUB: Open summary (F2 — summaryRef is null → "no summary yet"); Reference
//     in current tab (D1 context-refs — DEFERRED, disabled with a TODO tooltip).

const PROVIDERS: ProviderName[] = ['claude', 'codex',  'ollama', 'llamacpp'];

interface Props {
  onClose: () => void;
  // §F2 — fire a Recall summary over WS. Resolved like the reviewer/research
  // path. Returns false if the socket is closed.
  requestRecallSummary: (
    wfid: string,
    summarizer: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string },
  ) => boolean;
}

export function RecallView({ onClose, requestRecallSummary }: Props) {
  const [filters, setFilters] = useState<RecallSearchFilters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState(0);
  // §F4 — client-side "pinned only" view filter (hits already carry `pinned`).
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);

  const allHits = useRecallStore((s) => s.hits);
  // §F4 — apply the client-side "pinned only" filter. The store already sorts
  // pinned-first; this just narrows the view.
  const hits = useMemo(() => (pinnedOnly ? allHits.filter((h) => h.pinned) : allHits), [allHits, pinnedOnly]);
  const searching = useRecallStore((s) => s.searching);
  const searchError = useRecallStore((s) => s.searchError);
  const transcriptsAvailable = useRecallStore((s) => s.transcriptsAvailable);
  const runSearch = useRecallStore((s) => s.runSearch);
  // §F2 — summary state.
  const summarizing = useRecallStore((s) => s.summarizing);
  const summaryBodies = useRecallStore((s) => s.summaryBodies);
  const fetchSummary = useRecallStore((s) => s.fetchSummary);
  const setSummarizing = useRecallStore((s) => s.setSummarizing);
  // §F4 — operator CRUD.
  const setTags = useRecallStore((s) => s.setTags);
  const setPinned = useRecallStore((s) => s.setPinned);
  const addLink = useRecallStore((s) => s.addLink);
  const removeLink = useRecallStore((s) => s.removeLink);
  // §F4 — the in-progress "Distill to KB" draft (null = closed). Pre-filled from
  // the recall summary; the operator edits + Saves through POST /api/knowledge.
  const [distillDraft, setDistillDraft] = useState<{ wfid: string; cwd: string; title: string; body: string } | null>(null);
  const [savingDistill, setSavingDistill] = useState(false);
  const summarizeOnClose = useRecallStore((s) => s.summarizeOnClose);
  const setSummarizeOnClose = useRecallStore((s) => s.setSummarizeOnClose);
  // The currently-open summary (rendered inline over the result list).
  const [openSummaryView, setOpenSummaryView] = useState<{ wfid: string; title: string; body: string } | null>(null);

  const jobs = useAppStore((s) => s.jobs);
  const setActiveJob = useAppStore((s) => s.setActiveJob);
  const setActiveCluster = useAppStore((s) => s.setActiveCluster);
  const pushNotification = useAppStore((s) => s.pushNotification);

  // Project options come from whatever conversations exist in the hit set plus
  // a stable manual entry; deriving from hits keeps the filter honest without a
  // second fetch. (The index endpoint could populate it, but hits suffice for
  // the common "narrow what I see" flow.)
  const projectOptions = useMemo(() => {
    const set = new Set<string>();
    for (const h of hits) set.add(h.project);
    if (filters.project) set.add(filters.project);
    return [...set].sort();
  }, [hits, filters.project]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  // Debounced search on any filter change. 180ms mirrors the command palette.
  useEffect(() => {
    const t = window.setTimeout(() => { void runSearch(filters); }, 180);
    return () => window.clearTimeout(t);
  }, [filters, runSearch]);

  useEffect(() => { setSelected(0); }, [hits]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const patch = (p: Partial<RecallSearchFilters>) => setFilters((f) => ({ ...f, ...p }));

  const openHit = (wfid: string) => {
    if (jobs[wfid]) {
      setActiveCluster(null);
      setActiveJob(wfid);
      onClose();
    } else {
      // Not an open tab — opening an arbitrary archived workflow needs the
      // resume flow (out of F3 scope). Surface a non-error hint.
      pushNotification('info', 'This conversation is not an open tab. Open its project folder to resume it.');
    }
  };

  // §F2 — resolve the summarizer config for a hit. If the conversation is an
  // open tab, use its primary's provider/model/effort/account; otherwise fall
  // back to the hit's provider with a default model/effort (the server degrades
  // to the deterministic digest if that provider isn't authed — fence-clear).
  const summarizerFor = (hit: typeof hits[number]) => {
    const job = jobs[hit.wfid];
    const cfg = job?.config;
    return {
      provider: (cfg?.primaryProvider ?? hit.provider) as ProviderName,
      model: (cfg?.primaryModel ?? 'default') as ModelName,
      effort: (cfg?.primaryEffort ?? 'high') as EffortLevel,
      providerAccountRef: cfg?.providerAccountRef,
    };
  };

  // §F2 — open a saved summary inline, generating it first if none exists.
  // When a summaryRef is present we fetch (cached) and show it; otherwise we
  // fire a summary request over WS and let recall_summary_ready flip the row
  // (the operator clicks Open again, or it pre-fetched the body on ready).
  const onSummaryAction = async (hit: typeof hits[number]) => {
    if (hit.summaryRef) {
      const cached = summaryBodies[hit.wfid];
      const body = cached ?? (await fetchSummary(hit.wfid));
      if (body != null) {
        setOpenSummaryView({ wfid: hit.wfid, title: hit.title, body });
      } else {
        pushNotification('info', 'Summary not found on disk — regenerate it with Summarize.');
      }
      return;
    }
    // No summary yet → generate. Operator-triggered (this click) — never the loop.
    const sent = requestRecallSummary(hit.wfid, summarizerFor(hit));
    if (!sent) {
      pushNotification('error', 'Not connected — could not request a summary.');
      return;
    }
    setSummarizing(hit.wfid, true);
    pushNotification('info', 'Summarizing this conversation… it will appear here when ready.');
  };

  // §F4 — open the Distill-to-KB draft for a hit. The summary ALREADY exists
  // (button is disabled without a summaryRef) — we reuse it as the article body
  // and the recall title as the article title. NO distiller worker is spawned
  // and NO new LLM call is made (the F2 summary is the source). Nothing is saved
  // until the operator clicks Save in the draft form below (POST /api/knowledge).
  const onDistillToKb = async (hit: typeof hits[number]) => {
    if (!hit.summaryRef) return;
    const cached = summaryBodies[hit.wfid];
    const body = cached ?? (await fetchSummary(hit.wfid));
    if (body == null) {
      pushNotification('info', 'Summary not found on disk — regenerate it with Summarize first.');
      return;
    }
    setDistillDraft({ wfid: hit.wfid, cwd: hit.cwd, title: hit.title, body });
  };

  // §F4 — the operator Save: create the KB article via the EXISTING create flow
  // (POST /api/knowledge?path=<cwd>), then link recall↔kb (the Save is the
  // operator's confirmation). This is the ONLY persist path — there is no
  // auto-save and no agent write.
  const saveDistill = async () => {
    if (!distillDraft) return;
    setSavingDistill(true);
    try {
      const res = await fetch(`/api/knowledge?path=${encodeURIComponent(distillDraft.cwd)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: distillDraft.title, body: distillDraft.body, tags: [], alwaysInclude: false }),
      });
      if (!res.ok) {
        pushNotification('error', 'Could not save the knowledge article.');
        return;
      }
      const created = (await res.json()) as { article?: { id?: string } };
      const id = created.article?.id;
      if (id) await addLink(distillDraft.wfid, { type: 'kb', id });
      pushNotification('info', 'Saved to the knowledge base and linked to this conversation.');
      setDistillDraft(null);
    } catch {
      pushNotification('error', 'Could not save the knowledge article.');
    } finally {
      setSavingDistill(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(s + 1, Math.max(0, hits.length - 1))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const h = hits[selected]; if (h) openHit(h.wfid); }
  };

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        ref={surface}
        role="dialog" aria-modal="true" aria-label="Recall"
        onKeyDown={e => {
          if (e.defaultPrevented) return;
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
          if (e.key !== 'Tab') return;
          const items = [...(surface.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]') ?? [])].filter(el => el.getClientRects().length > 0);
          if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1)?.focus(); }
          else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0]?.focus(); }
        }}
        data-help="recall.view"
        style={{
          width: 'min(1440px, calc(92vw / var(--ui-scale, 1)))', height: 'calc(88vh / var(--ui-scale, 1))', maxWidth: 'calc(96vw / var(--ui-scale, 1))', maxHeight: 'calc(94vh / var(--ui-scale, 1))', boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
          background: 'var(--color-bg-panel)', border: '1px solid var(--color-border-bright)',
          borderRadius: 8, boxShadow: '0 12px 40px rgba(0,0,0,0.5)', overflowY: 'auto',
          fontFamily: 'var(--font-body)',
        }}
      >
        <div style={{ padding: '12px 16px 8px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <span className="display-font" style={{ fontSize: 12, letterSpacing: 2, color: 'var(--color-accent-primary)' }}>
            RECALL
          </span>
          <span style={{ fontSize: 11, color: 'var(--color-fg-muted)' }}>
            search every conversation Arco has run
          </span>
          <span style={{ marginLeft: 'auto' }}><WorkSurfaceControls surface={surface} /></span>
          <button type="button" aria-label="Close Recall" onClick={onClose} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: 16 }}>
            ✕
          </button>
        </div>

        <input
          ref={inputRef}
          value={filters.q}
          onChange={(e) => patch({ q: e.target.value })}
          onKeyDown={onKeyDown}
          data-help="recall.search-input"
          placeholder="Search titles, summaries, tags…  (toggle TRANSCRIPTS to full-text the conversations)"
          style={{
            border: 'none', borderTop: '1px solid var(--color-border-hairline)',
            borderBottom: '1px solid var(--color-border-hairline)',
            background: 'transparent', color: 'var(--color-fg)', fontSize: 15,
            padding: '12px 16px', outline: 'none', fontFamily: 'var(--font-body)',
          }}
        />

        {/* Filters */}
        <div style={{ display: 'flex', gap: 10, padding: '8px 16px', flexWrap: 'wrap', alignItems: 'center', borderBottom: '1px solid var(--color-border-hairline)' }}>
          <select data-help="recall.filter.project" value={filters.project} onChange={(e) => patch({ project: e.target.value })} style={selStyle}>
            <option value="">all projects</option>
            {projectOptions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select data-help="recall.filter.provider" value={filters.provider} onChange={(e) => patch({ provider: e.target.value as ProviderName | '' })} style={selStyle}>
            <option value="">all providers</option>
            {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <label style={dateLabel}>from
            <input data-help="recall.filter.date" type="date" value={filters.from} onChange={(e) => patch({ from: e.target.value })} style={dateInput} />
          </label>
          <label style={dateLabel}>to
            <input type="date" value={filters.to} onChange={(e) => patch({ to: e.target.value })} style={dateInput} />
          </label>
          <label style={{ ...dateLabel, marginLeft: 'auto', cursor: 'pointer' }} data-help="recall.filter.pinned">
            <input type="checkbox" checked={pinnedOnly} onChange={(e) => setPinnedOnly(e.target.checked)} />
            pinned only
          </label>
          <label style={{ ...dateLabel, cursor: transcriptsAvailable ? 'pointer' : 'not-allowed' }} data-help="recall.filter.transcripts">
            <input
              type="checkbox"
              checked={filters.includeTranscripts}
              disabled={!transcriptsAvailable}
              onChange={(e) => patch({ includeTranscripts: e.target.checked })}
            />
            transcripts{!transcriptsAvailable && ' (rg unavailable)'}
          </label>
        </div>

        {/* Results */}
        <div ref={listRef} role="region" aria-label="Recall results" style={{ overflowY: 'auto', flex: '1 0 60px', minHeight: 60 }}>
          {searchError && (
            <div style={{ padding: '12px 16px', color: 'var(--color-danger, #c33)', fontSize: 13 }}>{searchError}</div>
          )}
          {!searchError && hits.length === 0 && (
            <div style={{ padding: '16px', color: 'var(--color-fg-muted)', fontSize: 13 }}>
              {searching ? 'Searching…' : filters.q.trim() ? 'No matching conversations.' : 'No conversations indexed yet.'}
            </div>
          )}
          {hits.map((hit, i) => (
            <div key={hit.wfid + ':' + i} data-row={i}>
              <RecallResultRow
                hit={hit}
                selected={i === selected}
                isOpenTab={!!jobs[hit.wfid]}
                summarizing={!!summarizing[hit.wfid]}
                onHover={() => setSelected(i)}
                onOpen={() => openHit(hit.wfid)}
                onOpenSummary={() => { void onSummaryAction(hit); }}
                onTogglePin={() => { void setPinned(hit.wfid, !hit.pinned); }}
                onSetTags={(tags) => { void setTags(hit.wfid, tags); }}
                onRemoveLink={(link: RecallLink) => { void removeLink(hit.wfid, link); }}
                onDistillToKb={() => { void onDistillToKb(hit); }}
              />
            </div>
          ))}
        </div>

        {/* §F2 — inline summary viewer (the saved summary.md, plain-text). */}
        {openSummaryView && (
          <div
            data-help="recall.summary-viewer"
            style={{
              borderTop: '1px solid var(--color-border-bright)', background: 'var(--color-bg)',
              maxHeight: '30%', flex: '0 1 30%', minHeight: 0, display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid var(--color-border-hairline)' }}>
              <span style={{ fontSize: 11, letterSpacing: 1, color: 'var(--color-accent-primary)' }}>SUMMARY</span>
              <span style={{ fontSize: 12, color: 'var(--color-fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {openSummaryView.title}
              </span>
              <button type="button" onClick={() => setOpenSummaryView(null)} style={{ background: 'transparent', border: 'none', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
            <pre style={{ margin: 0, padding: '10px 16px', overflowY: 'auto', minHeight: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--font-code)', fontSize: 12, lineHeight: 1.5, color: 'var(--color-fg-dim)' }}>
              {openSummaryView.body}
            </pre>
          </div>
        )}

        {/* §F4 — Distill-to-KB draft. Pre-filled from the F2 summary; the
            operator edits and Saves through the existing POST /api/knowledge
            create flow. No auto-save, no LLM call here (the summary exists). */}
        {distillDraft && (
          <div
            data-help="recall.distill-kb"
            style={{
              borderTop: '1px solid var(--color-border-bright)', background: 'var(--color-bg)',
              maxHeight: '35%', flex: '0 1 35%', minHeight: 0, display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid var(--color-border-hairline)' }}>
              <span style={{ fontSize: 11, letterSpacing: 1, color: 'var(--color-accent-primary)' }}>DISTILL TO KB</span>
              <span style={{ fontSize: 11, color: 'var(--color-fg-muted)', flex: 1 }}>
                draft pre-filled from the summary — edit, then Save. Nothing is saved until you click Save.
              </span>
              <button type="button" onClick={() => setDistillDraft(null)} style={{ background: 'transparent', border: 'none', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
            <div style={{ padding: '8px 16px', display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', flex: 1, minHeight: 0 }}>
              <input
                data-help="recall.distill-kb.title"
                value={distillDraft.title}
                onChange={(e) => setDistillDraft((d) => (d ? { ...d, title: e.target.value } : d))}
                placeholder="Article title"
                style={{ ...selStyle, fontSize: 13, padding: '5px 7px' }}
              />
              <textarea
                data-help="recall.distill-kb.body"
                value={distillDraft.body}
                onChange={(e) => setDistillDraft((d) => (d ? { ...d, body: e.target.value } : d))}
                placeholder="Markdown body"
                style={{ ...selStyle, minHeight: 160, resize: 'vertical', fontFamily: 'var(--font-code)', fontSize: 12 }}
              />
            </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '6px 16px', flexShrink: 0 }}>
                <button type="button" onClick={() => setDistillDraft(null)} style={{ ...selStyle, cursor: 'pointer' }}>CANCEL</button>
                <button
                  type="button"
                  data-help="recall.distill-kb.save"
                  onClick={() => { void saveDistill(); }}
                  disabled={savingDistill || (!distillDraft.title.trim() && !distillDraft.body.trim())}
                  style={{ ...selStyle, cursor: 'pointer', borderColor: 'var(--color-accent-primary)', opacity: savingDistill ? 0.5 : 1 }}
                >
                  {savingDistill ? 'SAVING…' : 'SAVE TO KB'}
                </button>
              </div>
          </div>
        )}

        <div style={{ padding: '6px 16px', borderTop: '1px solid var(--color-border-hairline)', color: 'var(--color-fg-muted)', fontSize: 11, display: 'flex', gap: 16, alignItems: 'center' }}>
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
          {/* §F2 step 3 — operator-armed "summarize on tab close" (default OFF). */}
          <label data-help="recall.summarize-on-close" style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', marginLeft: 'auto' }}>
            <input type="checkbox" checked={summarizeOnClose} onChange={(e) => setSummarizeOnClose(e.target.checked)} />
            summarize on tab close
          </label>
          <span>{hits.length} result{hits.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const selStyle: React.CSSProperties = {
  background: 'var(--color-bg-input, transparent)', color: 'var(--color-fg)',
  border: '1px solid var(--color-border-hairline)', borderRadius: 3, fontSize: 12,
  padding: '3px 6px', fontFamily: 'var(--font-body)',
};
const dateLabel: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5, color: 'var(--color-fg-muted)', fontSize: 11,
};
const dateInput: React.CSSProperties = {
  background: 'var(--color-bg-input, transparent)', color: 'var(--color-fg)',
  border: '1px solid var(--color-border-hairline)', borderRadius: 3, fontSize: 11,
  padding: '2px 4px', fontFamily: 'var(--font-body)',
};
