import { useState } from 'react';
import type { RecallSearchHit, RecallLink } from '@arco/shared';

// Workbench Expansion §F3 + §F4 — one Recall search result row.
//
// Renders the conversation title, project/provider/date meta, a match snippet
// (the FTS5 snippet() brackets the matched terms — we render them as plain text
// with a subtle highlight), and the result actions:
//   - LIVE now: Jump to transcript / Resume (open the workflow tab if open).
//   - §F2: Summarize (when no summaryRef → generate) / Open summary (when a
//     summaryRef exists → read it). Shows "Summarizing…" while in-flight.
//   - §F4: a pin-as-memory toggle (operator manually marks their OWN convo as
//     important — pinned rows sort to top; NOT the fenced self-writing memory),
//     editable tag chips, rendered links, and "Distill to KB" (only when a
//     summary exists — pre-fills the KB wizard from the summary; the operator
//     edits + Saves through the normal create flow, no auto-save, no LLM here).
//   - Graceful stub: Reference in current tab (D1 — deferred; disabled).

interface Props {
  hit: RecallSearchHit;
  selected: boolean;
  isOpenTab: boolean;
  // §F2 — true while a summary request is in flight for this conversation.
  summarizing: boolean;
  onHover: () => void;
  onOpen: () => void;
  // §F2 — open the saved summary, or generate it when none exists yet.
  onOpenSummary: () => void;
  // §F4 — operator CRUD callbacks (resolve through the recall store → HTTP).
  onTogglePin: () => void;
  onSetTags: (tags: string[]) => void;
  onRemoveLink: (link: RecallLink) => void;
  // §F4 — pre-fill the KB wizard from this conversation's summary. Enabled only
  // when a summaryRef exists (the distill source). Reuses the existing wizard +
  // POST /api/knowledge create flow — nothing is saved without the operator.
  onDistillToKb: () => void;
}

const FIELD_LABEL: Record<RecallSearchHit['matchedIn'], string> = {
  title: 'TITLE', summary: 'SUMMARY', tags: 'TAGS', transcript: 'TRANSCRIPT',
};

// Render an FTS5 snippet() string: `[matched]` segments become highlighted
// spans, the rest is plain text. Transcript snippets carry no brackets — shown
// as-is. Keeps it XSS-safe (no dangerouslySetInnerHTML; we split on brackets).
function renderSnippet(snippet: string) {
  const parts = snippet.split(/(\[[^\]]*\])/g);
  return parts.map((p, i) => {
    if (p.startsWith('[') && p.endsWith(']')) {
      return (
        <mark key={i} style={{ background: 'var(--color-accent-primary-a10)', color: 'var(--color-fg)', padding: '0 1px', borderRadius: 2 }}>
          {p.slice(1, -1)}
        </mark>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

export function RecallResultRow({
  hit, selected, isOpenTab, summarizing, onHover, onOpen, onOpenSummary,
  onTogglePin, onSetTags, onRemoveLink, onDistillToKb,
}: Props) {
  const date = new Date(hit.lastActiveAt || 0).toISOString().slice(0, 10);
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState('');

  const commitTag = () => {
    const t = tagDraft.trim();
    setAddingTag(false);
    setTagDraft('');
    if (!t || hit.tags.includes(t)) return;
    onSetTags([...hit.tags, t]);
  };
  const removeTag = (tag: string) => onSetTags(hit.tags.filter((t) => t !== tag));

  return (
    <div
      data-idx
      data-help="recall.result"
      onMouseEnter={onHover}
      style={{
        padding: '10px 16px', cursor: 'default', display: 'flex', flexDirection: 'column', gap: 4,
        background: selected ? 'var(--color-accent-primary-a10)' : 'transparent',
        borderLeft: selected ? '2px solid var(--color-accent-primary)' : '2px solid transparent',
        borderBottom: '1px solid var(--color-border-hairline)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        {/* §F4 — pin-as-memory toggle. Operator-manual mark; pinned rows sort to top. */}
        <button
          type="button"
          data-help="recall.action.pin"
          onClick={onTogglePin}
          title={hit.pinned ? 'Unpin this conversation (remove from memories)' : 'Pin as memory — mark this conversation important; it sorts to the top'}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13, padding: 0, color: hit.pinned ? 'var(--color-accent-primary)' : 'var(--color-fg-faint)' }}
        >
          {hit.pinned ? '★' : '☆'}
        </button>
        <span style={{ color: 'var(--color-fg)', fontSize: 14, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {hit.title}
        </span>
        <span style={{ color: 'var(--color-fg-muted)', fontSize: 10, letterSpacing: 1 }}>
          {FIELD_LABEL[hit.matchedIn]}
        </span>
      </div>
      <div style={{ color: 'var(--color-fg-muted)', fontSize: 11, display: 'flex', gap: 10 }}>
        <span>{hit.project}</span>
        <span>·</span>
        <span>{hit.provider}</span>
        <span>·</span>
        <span>{date}</span>
        {isOpenTab && <span style={{ color: 'var(--color-accent-primary-dim)' }}>· open tab</span>}
      </div>
      {hit.snippet && (
        <div style={{ color: 'var(--color-fg-dim)', fontSize: 12, lineHeight: 1.5, fontFamily: hit.matchedIn === 'transcript' ? 'var(--font-code)' : 'var(--font-body)' }}>
          {renderSnippet(hit.snippet)}
        </div>
      )}

      {/* §F4 — tag chips (each removable) + an add-tag affordance. */}
      <div data-help="recall.tags" style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', marginTop: 2 }}>
        {hit.tags.map((tag) => (
          <span key={tag} style={chipStyle}>
            #{tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              title={`Remove tag #${tag}`}
              style={{ background: 'transparent', border: 'none', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: 10, padding: '0 0 0 3px' }}
            >
              ✕
            </button>
          </span>
        ))}
        {addingTag ? (
          <input
            autoFocus
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onBlur={commitTag}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitTag(); }
              else if (e.key === 'Escape') { e.preventDefault(); setAddingTag(false); setTagDraft(''); }
            }}
            placeholder="tag"
            style={{ background: 'var(--color-bg-input, transparent)', border: '1px solid var(--color-border-hairline)', borderRadius: 8, color: 'var(--color-fg)', fontSize: 10, padding: '1px 6px', width: 70, fontFamily: 'var(--font-body)' }}
          />
        ) : (
          <button
            type="button"
            data-help="recall.tags.add"
            onClick={() => setAddingTag(true)}
            title="Add a tag to this conversation"
            style={{ ...chipStyle, cursor: 'pointer', color: 'var(--color-fg-muted)' }}
          >
            + tag
          </button>
        )}
      </div>

      {/* §F4 — operator-curated links to KB articles / tasks. Task links persist
          but have no resolver until the E-track ships — shown as inert chips. */}
      {hit.links.length > 0 && (
        <div data-help="recall.links" style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
          {hit.links.map((link) => (
            <span key={`${link.type}:${link.id}`} style={{ ...chipStyle, borderStyle: 'dashed' }}>
              {link.type === 'kb' ? '📄 kb' : '✓ task'}
              <button
                type="button"
                onClick={() => onRemoveLink(link)}
                title={`Unlink this ${link.type}`}
                style={{ background: 'transparent', border: 'none', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: 10, padding: '0 0 0 3px' }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
        <button
          type="button"
          data-help="recall.action.open"
          onClick={onOpen}
          title={isOpenTab ? 'Switch to this conversation and jump to the match' : 'This conversation is not an open tab — open its project to resume'}
          style={btnStyle(true)}
        >
          {isOpenTab ? 'JUMP TO TRANSCRIPT' : 'RESUME'}
        </button>
        <button
          type="button"
          data-help="recall.action.summary"
          onClick={onOpenSummary}
          disabled={summarizing}
          title={
            summarizing
              ? 'Generating a summary…'
              : hit.summaryRef
                ? 'Open the saved summary'
                : 'Generate a recall summary of this conversation'
          }
          style={btnStyle(!summarizing)}
        >
          {summarizing ? 'SUMMARIZING…' : hit.summaryRef ? 'OPEN SUMMARY' : 'SUMMARIZE'}
        </button>
        <button
          type="button"
          data-help="recall.action.distill-kb"
          onClick={onDistillToKb}
          disabled={!hit.summaryRef}
          title={
            hit.summaryRef
              ? 'Distill to KB — pre-fill a knowledge article draft from this summary; you edit and Save'
              : 'Summarize this conversation first — Distill to KB pre-fills from the summary'
          }
          style={btnStyle(!!hit.summaryRef)}
        >
          DISTILL TO KB
        </button>
        <button
          type="button"
          data-help="recall.action.reference"
          disabled
          title="Reference in current tab — ships with D1 context refs (not built yet)"
          style={btnStyle(false)}
        >
          REFERENCE IN TAB
        </button>
      </div>
    </div>
  );
}

const chipStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', fontSize: 10, lineHeight: 1.4,
  color: 'var(--color-fg-dim)', background: 'var(--color-bg-input, transparent)',
  border: '1px solid var(--color-border-hairline)', borderRadius: 8, padding: '1px 6px',
  fontFamily: 'var(--font-body)',
};

function btnStyle(enabled: boolean): React.CSSProperties {
  return {
    fontSize: 10, letterSpacing: 0.5, padding: '3px 8px', borderRadius: 3,
    border: '1px solid var(--color-border-hairline)',
    background: 'transparent',
    color: enabled ? 'var(--color-fg-muted)' : 'var(--color-fg-faint)',
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontFamily: 'var(--font-body)',
  };
}
