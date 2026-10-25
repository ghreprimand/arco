import { C } from './shared';
import type { HelpEntry } from './shared';

// Workbench Expansion §F3 — contextual help for the top-level Recall view.
// Keyed by the data-help attributes on RecallView / RecallResultRow /
// SystemHeader's RECALL button. All entries link to the 'recall-search' manual
// section.

export const recallHelp: Record<string, HelpEntry> = {
  'header.recall': {
    title: 'Recall',
    body: (
      <p>
        Opens the top-level <strong>Recall</strong> search — keyword search over
        every conversation Arco has ever run, across all projects. Also
        reachable from the command palette (<C>Ctrl/Cmd+P</C> → "Recall: search
        conversations").
      </p>
    ),
    manualSection: 'recall-search',
  },
  'recall.view': {
    title: 'Recall search',
    body: (
      <>
        <p>
          Cross-session, cross-project conversation search. Backed by the
          machine-global recall index (every workflow ever run) and a
          deterministic search engine — <strong>no LLM</strong>: SQLite FTS5
          over titles / summaries / tags, plus optional ripgrep over transcripts.
        </p>
        <p>Type to search; results rank by relevance and show a match snippet.</p>
      </>
    ),
    manualSection: 'recall-search',
  },
  'recall.search-input': {
    title: 'Search query',
    body: (
      <p>
        Keywords matched against conversation titles, summaries, and tags via
        FTS5 (prefix-matched, so <C>refac</C> finds <C>refactor</C>). Empty query
        lists your most-recent conversations.
      </p>
    ),
    manualSection: 'recall-search',
  },
  'recall.filter.project': {
    title: 'Project filter',
    body: <p>Narrow results to one project (the conversation's cwd basename).</p>,
    manualSection: 'recall-search',
  },
  'recall.filter.provider': {
    title: 'Provider filter',
    body: <p>Narrow results to one provider (Claude / Codex / Gemini / …).</p>,
    manualSection: 'recall-search',
  },
  'recall.filter.date': {
    title: 'Date range',
    body: <p>Inclusive bounds on a conversation's last-active date.</p>,
    manualSection: 'recall-search',
  },
  'recall.filter.transcripts': {
    title: 'Transcript full-text',
    body: (
      <>
        <p>
          Operator toggle (default OFF). When on, the query also runs as a
          ripgrep full-text scan over each conversation's <C>events.jsonl</C> —
          finds keywords that appear only in the body, not the title/summary/tags.
        </p>
        <p>
          Heavier than the FTS index pass; disabled when <C>rg</C> isn't on PATH.
        </p>
      </>
    ),
    manualSection: 'recall-search',
  },
  'recall.result': {
    title: 'Search result',
    body: (
      <p>
        One matched conversation — title, project / provider / date, the match
        snippet, and where it matched (title / summary / tags / transcript).
      </p>
    ),
    manualSection: 'recall-search',
  },
  'recall.action.open': {
    title: 'Jump to transcript / Resume',
    body: (
      <p>
        If the conversation is an open tab, switches to it. If it's an archived
        conversation that isn't open, you'll be pointed to its project folder to
        resume it.
      </p>
    ),
    manualSection: 'recall-search',
  },
  'recall.action.summary': {
    title: 'Summarize / Open summary',
    body: (
      <p>
        When a conversation has no summary yet, this generates one — a dense,
        durable recap (goal, key decisions, current state, open threads) saved to{' '}
        <code>~/.archon/recall/&lt;wfid&gt;/summary.md</code>. When a summary already
        exists, it opens it inline. Summaries are <strong>operator-triggered</strong>{' '}
        (this button) or operator-armed on tab close — never generated automatically
        in the agent loop. If no provider is authenticated the summary degrades to a
        deterministic structural digest rather than failing.
      </p>
    ),
    manualSection: 'recall-search',
  },
  'recall.summarize-on-close': {
    title: 'Summarize on tab close',
    body: (
      <p>
        Operator-armed (default OFF). When on, closing a conversation tab{' '}
        <em>offers</em> to summarize it — you still confirm. It never summarizes
        automatically without your explicit arm and confirm.
      </p>
    ),
    manualSection: 'recall-search',
  },
  'recall.summary-viewer': {
    title: 'Summary viewer',
    body: (
      <p>
        Shows the saved <code>summary.md</code> for the selected conversation. The
        full transcript remains the source of truth — this is an additive recap you
        can delete to regenerate.
      </p>
    ),
    manualSection: 'recall-search',
  },
  'recall.action.reference': {
    title: 'Reference in current tab',
    body: (
      <p>
        Will inject an excerpt of this conversation as context into the active
        tab. Deferred — ships with <strong>D1</strong> context references.
      </p>
    ),
    manualSection: 'recall-search',
  },
  // ── §F4 — tags + pin-as-memory + links + distill-to-KB ──
  'recall.action.pin': {
    title: 'Pin as memory',
    body: (
      <>
        <p>
          Marks this conversation as important — pinned conversations sort to the
          top of the list and can be isolated with the <strong>pinned only</strong>{' '}
          filter. Click again to unpin (fully reversible).
        </p>
        <p>
          This is a <strong>manual operator action</strong> on your own
          conversation — there is <strong>no LLM</strong> and nothing is ever
          pinned automatically. It is not the rejected "self-writing memory"
          pattern (an AI profiling you); it's just a bookmark you set.
        </p>
      </>
    ),
    manualSection: 'recall-search',
  },
  'recall.tags': {
    title: 'Tags',
    body: <p>Operator-set tags on this conversation. Tags are searchable (FTS5) and removable. Click ✕ on a chip to remove it.</p>,
    manualSection: 'recall-search',
  },
  'recall.tags.add': {
    title: 'Add a tag',
    body: <p>Type a tag and press Enter to add it to this conversation. Tags are deduped and bounded server-side.</p>,
    manualSection: 'recall-search',
  },
  'recall.links': {
    title: 'Links',
    body: (
      <p>
        Operator-curated links from this conversation to knowledge-base articles
        (and, once the task track ships, tasks). A <code>kb</code> link is created
        when you Distill to KB. Click ✕ to unlink (reversible).
      </p>
    ),
    manualSection: 'recall-search',
  },
  'recall.filter.pinned': {
    title: 'Pinned only',
    body: <p>Narrow the list to conversations you've pinned as memories.</p>,
    manualSection: 'recall-search',
  },
  'recall.action.distill-kb': {
    title: 'Distill to KB',
    body: (
      <>
        <p>
          Pre-fills a knowledge-base article draft from this conversation's saved
          summary (title from the conversation, body from the summary). Enabled
          only once a summary exists.
        </p>
        <p>
          <strong>No new agent call</strong> is made — it reuses the existing
          summary. You edit the draft and <strong>Save</strong> it through the
          normal knowledge-base create flow; nothing is written until you Save.
          Saving also links the new article back to this conversation.
        </p>
      </>
    ),
    manualSection: 'recall-search',
  },
  'recall.distill-kb': {
    title: 'Distill-to-KB draft',
    body: <p>An editable knowledge-article draft pre-filled from the summary. Nothing is saved until you click Save to KB.</p>,
    manualSection: 'recall-search',
  },
  'recall.distill-kb.title': {
    title: 'Article title',
    body: <p>The knowledge-base article title (pre-filled from the conversation title; editable).</p>,
    manualSection: 'recall-search',
  },
  'recall.distill-kb.body': {
    title: 'Article body',
    body: <p>The knowledge-base article body (pre-filled from the saved summary; edit freely before saving).</p>,
    manualSection: 'recall-search',
  },
  'recall.distill-kb.save': {
    title: 'Save to KB',
    body: (
      <p>
        Creates the knowledge-base article in this conversation's project (the
        existing create flow) and links it back to the conversation. This is the
        only persist step — there is no auto-save.
      </p>
    ),
    manualSection: 'recall-search',
  },
};
