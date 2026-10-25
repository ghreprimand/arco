// Workbench Expansion §F1 — Recall: machine-global session index.
//
// A cross-cwd index of every workflow ever run, each carrying a non-blank
// title, so "what conversations do I have and where" is answerable in one
// place. Today listing is per-project-folder and only Claude auto-titles; this
// fixes both.
//
// FENCE-CLEARANCE (docs/RECALL.md, Part F preamble): this is a deterministic
// PROJECTION of meta.json + events.jsonl — operator-driven retrospective recall
// over their OWN conversations. It indexes *conversations*, it does NOT model
// the operator, and there is NO LLM in this phase (summaries are F2, operator-
// triggered). Pure deterministic index.
//
// Storage: SQLite (better-sqlite3 — already a server dep, first usage here) at
// ~/.archon/recall/recall.db. MACHINE-GLOBAL, never per-cwd. The DB is a
// rebuildable projection: delete it and the next backfill reconstructs it from
// disk. The schema reserves `summaryRef` (F2) + `tags` (F4) columns now so
// those phases don't migrate the table, and the `entries` table is shaped so
// F3 can add an FTS5 virtual table over titles/summaries/transcripts WITHOUT
// touching this table. FTS5 / full-text search is NOT built here (that's F3).
//
// Interface: load() / save() / query() is the contract (Part E storage
// rationale). The incremental hook (upsertFromMeta, wired into writeMeta) is a
// single cheap synchronous statement and is failure-isolated by its caller.

import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import type { ProviderName, RecallEntry, RecallLink } from '@archon/shared';
import { readMeta, listWorkflowMetas, latestCliSessionFor, type WorkflowMeta } from '../workflowMeta.js';
import { extractSessionName } from '../workflows/sessionDiscovery.js';
import { encodeProjectDir } from '../http/fileRead.js';

const WFID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const TITLE_MAX = 80;
// §F2 — bound how much summary body we mirror into the FTS5 `summary` column.
// The full body lives on disk at ~/.archon/recall/<wfid>/summary.md (source of
// truth); FTS only needs enough text for keyword search to hit it. Keeps the
// DB small even with thousands of summarized conversations.
const FTS_SUMMARY_MAX = 8000;

// §F2 — machine-global recall home (where summaries live). Shared with the
// recall-summary HTTP route + summarize.ts so the location is computed in ONE
// place, cross-platform (os.homedir(), never a hardcoded /home/...).
export function recallHomeDir(): string {
  return path.join(os.homedir(), '.archon', 'recall');
}

// §F2 — the summary.md path for one workflow. wfid MUST be validated by the
// caller (WFID_PATTERN) before this is joined into a path — see setSummary /
// summarize.ts. Returns null for an invalid wfid so a traversal attempt can't
// escape the recall home.
export function recallSummaryPath(wfid: string): string | null {
  if (!WFID_PATTERN.test(wfid)) return null;
  return path.join(recallHomeDir(), wfid, 'summary.md');
}

function defaultDbPath(): string {
  return path.join(recallHomeDir(), 'recall.db');
}

// §F2 — read a workflow's persisted summary body off disk (best-effort). Used
// by save()/rebuildFts() so re-indexing FTS keeps the summary BODY (the source
// of truth lives in summary.md, not in `entries`). Empty string when absent.
//
// Honors the RecallIndex dbPath override: smokes/tests point dbPath at a temp
// dir, and the summary.md fixtures live under that same temp recall home, so we
// derive the recall home from the DB's parent dir rather than os.homedir().
function readSummaryBodyFrom(recallHome: string, wfid: string): string {
  if (!WFID_PATTERN.test(wfid)) return '';
  try {
    return fsSync.readFileSync(path.join(recallHome, wfid, 'summary.md'), 'utf8');
  } catch {
    return '';
  }
}

// Registry of cwds Archon has touched — backfill walks these. Mirrors
// crashRecovery.ts's known-cwds.json (the single source of truth for "where
// have workflows lived").
function knownCwdsPath(): string {
  return path.join(os.homedir(), '.archon', 'known-cwds.json');
}

export interface RecallQuery {
  project?: string;
  provider?: ProviderName;
  // §F4 — when set, narrow to pinned (true) / unpinned (false) entries.
  pinned?: boolean;
}

// §F4 — bound operator tag input (mirrors knowledge/store.ts's tag discipline).
const TAG_MAX = 40;
const TAGS_MAX = 24;
function sanitizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const clean = t.trim().slice(0, TAG_MAX);
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= TAGS_MAX) break;
  }
  return out;
}

// §F4 — a well-formed link: known type + a non-empty id within a sane bound.
const LINK_ID_MAX = 128;
function isValidLink(link: unknown): link is RecallLink {
  if (!link || typeof link !== 'object') return false;
  const l = link as Record<string, unknown>;
  if (l.type !== 'kb' && l.type !== 'task') return false;
  return typeof l.id === 'string' && l.id.length > 0 && l.id.length <= LINK_ID_MAX;
}

// §F3 — one FTS5 match row joined to its `entries` row, with a per-column
// snippet. search.ts picks the first non-empty snippet to set matchedIn.
export interface RecallFtsRow {
  entry: RecallEntry;
  snippetTitle: string;
  snippetSummary: string;
  snippetTags: string;
}

export class RecallIndex {
  private readonly dbPath: string;
  // §F2 — recall home (where <wfid>/summary.md live). Derived from the DB's
  // parent dir so the dbPath test-override also relocates summary reads.
  private readonly recallHome: string;
  private db: Database.Database | null = null;

  // dbPath override exists for smokes/tests — point the index at a temp dir
  // so a test never writes to the real ~/.archon/recall/.
  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? defaultDbPath();
    this.recallHome = path.dirname(this.dbPath);
  }

  // load() — open (creating dir + schema if missing). Idempotent.
  load(): void {
    if (this.db) return;
    fsSync.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    // F3-ready: keep this table free of any FTS-specific columns so F3 can add
    // a `CREATE VIRTUAL TABLE ... USING fts5(...)` alongside it without a
    // migration here. summaryRef (F2) + tags (F4) reserved now.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        wfid         TEXT PRIMARY KEY,
        cwd          TEXT NOT NULL,
        project      TEXT NOT NULL,
        provider     TEXT NOT NULL,
        title        TEXT NOT NULL,
        createdAt    INTEGER NOT NULL,
        lastActiveAt INTEGER NOT NULL,
        turnCount    INTEGER NOT NULL,
        summaryRef   TEXT,
        tags         TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_entries_lastActive ON entries(lastActiveAt DESC);
      CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project);
      CREATE INDEX IF NOT EXISTS idx_entries_provider ON entries(provider);
    `);
    this.migrateF4();
    this.ensureFts();
  }

  // §F4 — idempotent migration adding `pinned` + `links` to an EXISTING
  // entries table. CREATE TABLE IF NOT EXISTS above won't add columns to a table
  // that already exists on a real F1/F2 user's disk, so we PRAGMA-check each
  // column and ALTER TABLE only the missing ones. Guarded independently and safe
  // to run repeatedly (load() is idempotent; this is a no-op once columns exist).
  private migrateF4(): void {
    const db = this.db!;
    const cols = new Set(
      (db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('pinned')) {
      db.exec("ALTER TABLE entries ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    }
    if (!cols.has('links')) {
      db.exec("ALTER TABLE entries ADD COLUMN links TEXT NOT NULL DEFAULT '[]'");
    }
  }

  // §F3 — FTS5 virtual table ALONGSIDE `entries` (never a migration to it).
  //
  // Design (docs/RECALL.md § F3): a standalone (non-contentless) FTS5 table
  // keyed by `wfid` over the searchable text — title + summary + tags. We keep
  // the searchable text IN the FTS table (not a contentless mirror of
  // `entries`) so search.ts can read snippet()/bm25() directly and we never
  // have to JOIN back to a content table. Transcript full-text is deliberately
  // NOT stored here — that's the operator-toggle ripgrep pass in search.ts
  // (keeps this DB small; the title/summary/tag side is the must-have).
  //
  // Sync: indexFts() is called from save() on every upsert and during
  // backfill, so the FTS rows track `entries` without triggers. rebuildFts()
  // re-derives every FTS row from `entries` (the rebuild escape hatch). The FTS
  // table is itself a projection of `entries`, which is a projection of disk —
  // so it's always reconstructable.
  private ftsReady = false;
  private ensureFts(): void {
    if (this.ftsReady) return;
    this.db!.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        wfid UNINDEXED,
        title,
        summary,
        tags,
        tokenize = 'unicode61'
      );
    `);
    this.ftsReady = true;
  }

  // Upsert one entry's FTS row. Delete-then-insert keyed by wfid keeps the
  // single FTS row per workflow (FTS5 has no UPSERT).
  //
  // §F2: the `summary` FTS column carries the resolved summary BODY when one
  // exists (so §F3 search hits the summary text), bounded to FTS_SUMMARY_MAX
  // chars to keep the DB small. `summaryBody` is the optional override passed by
  // setSummary(); without it the column falls back to the `summaryRef` string
  // (the pre-F2 shape — just the ref, no body to index yet).
  indexFts(entry: RecallEntry, summaryBody?: string): void {
    this.ensureFts();
    const db = this.conn;
    const summaryText =
      summaryBody && summaryBody.trim()
        ? summaryBody.slice(0, FTS_SUMMARY_MAX)
        : entry.summaryRef ?? '';
    db.prepare('DELETE FROM entries_fts WHERE wfid = ?').run(entry.wfid);
    db.prepare(
      'INSERT INTO entries_fts (wfid, title, summary, tags) VALUES (?, ?, ?, ?)',
    ).run(
      entry.wfid,
      entry.title ?? '',
      summaryText,
      (entry.tags ?? []).join(' '),
    );
  }

  // rebuildFts() — re-derive every FTS row from `entries`. Cheap full rebuild
  // (the index is small); used by rebuild() and recoverable if the FTS table is
  // ever suspected stale. Reads summaryRef/tags off `entries` (F2/F4 columns).
  rebuildFts(): void {
    this.ensureFts();
    const db = this.conn;
    db.exec('DELETE FROM entries_fts');
    const rows = db.prepare('SELECT * FROM entries').all() as Array<Record<string, unknown>>;
    const insert = db.prepare(
      'INSERT INTO entries_fts (wfid, title, summary, tags) VALUES (?, ?, ?, ?)',
    );
    const tx = db.transaction((entries: RecallEntry[]) => {
      for (const e of entries) {
        // §F2 — re-derive the FTS summary text from the on-disk body when a
        // summary exists, so a rebuild keeps search hitting summary content.
        const body = e.summaryRef ? readSummaryBodyFrom(this.recallHome, e.wfid) : '';
        const summaryText = body && body.trim() ? body.slice(0, FTS_SUMMARY_MAX) : e.summaryRef ?? '';
        insert.run(e.wfid, e.title ?? '', summaryText, (e.tags ?? []).join(' '));
      }
    });
    tx(rows.map(rowToEntry));
  }

  private get conn(): Database.Database {
    if (!this.db) this.load();
    return this.db!;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // save() — upsert one entry by wfid. Single cheap statement; safe to call on
  // the meta-write hot path. Re-running is idempotent (replaces in place).
  save(entry: RecallEntry): void {
    this.conn
      .prepare(
        `INSERT INTO entries
           (wfid, cwd, project, provider, title, createdAt, lastActiveAt, turnCount, summaryRef, tags, pinned, links)
         VALUES (@wfid, @cwd, @project, @provider, @title, @createdAt, @lastActiveAt, @turnCount, @summaryRef, @tags, @pinned, @links)
         ON CONFLICT(wfid) DO UPDATE SET
           cwd=excluded.cwd, project=excluded.project, provider=excluded.provider,
           title=excluded.title, createdAt=excluded.createdAt, lastActiveAt=excluded.lastActiveAt,
           turnCount=excluded.turnCount`,
      )
      .run({
        wfid: entry.wfid,
        cwd: entry.cwd,
        project: entry.project,
        provider: entry.provider,
        title: entry.title,
        createdAt: entry.createdAt,
        lastActiveAt: entry.lastActiveAt,
        turnCount: entry.turnCount,
        // summaryRef/tags/pinned/links are owned by F2/F4 — never clobber an
        // existing value from the F1 projection upsert. On FIRST insert they
        // take these supplied defaults; on CONFLICT the DO UPDATE SET above
        // deliberately omits all four, so a meta-write upsert leaves operator
        // summaries / tags / pins / links intact.
        summaryRef: entry.summaryRef,
        tags: JSON.stringify(entry.tags ?? []),
        pinned: entry.pinned ? 1 : 0,
        links: JSON.stringify(entry.links ?? []),
      });
    // Keep the §F3 FTS5 row in lockstep. Read back the persisted row so the FTS
    // text reflects the F2/F4 columns we deliberately DON'T clobber on upsert
    // (the `entry` arg's summaryRef/tags are the F1 projection's empty values;
    // the row may already carry richer F2/F4 data). Failure-isolated — an FTS
    // hiccup must never break the index write on the meta hot path.
    try {
      const row = this.conn.prepare('SELECT * FROM entries WHERE wfid = ?').get(entry.wfid) as
        | Record<string, unknown>
        | undefined;
      if (row) {
        const persisted = rowToEntry(row);
        // §F2 — if a summary was already generated, keep its BODY in FTS (read
        // from disk) so a later meta-write upsert doesn't downgrade the FTS
        // `summary` column back to the bare ref string.
        const body = persisted.summaryRef ? readSummaryBodyFrom(this.recallHome, persisted.wfid) : undefined;
        this.indexFts(persisted, body);
      }
    } catch (err) {
      console.error('[archon] recall FTS index failed:', err);
    }
  }

  // §F2 — set (or clear) one workflow's summary ref + re-index its FTS summary
  // text. Upserts ONLY the `summaryRef` column on the existing row (or inserts
  // a placeholder row if the workflow isn't backfilled yet — defensive; the
  // operator can only Summarize a workflow that's already indexed). Deliberately
  // does NOT touch F1's projection columns or F4's `tags` — symmetric with how
  // save()'s ON CONFLICT refuses to clobber summaryRef/tags going the other way.
  //
  // `summaryBody` is the resolved summary text (LLM or deterministic fallback).
  // When present we index a bounded prefix of the BODY into the FTS `summary`
  // column so §F3 search hits the summary content (not just the ref string the
  // F1 placeholder carried). When omitted, FTS falls back to the ref string —
  // the same shape as before F2. The DELETE-then-INSERT-read-back-row shape of
  // indexFts is preserved by routing through a small body override.
  setSummary(wfid: string, ref: string | null, summaryBody?: string): void {
    if (!WFID_PATTERN.test(wfid)) return;
    const db = this.conn;
    // Upsert just summaryRef. If the row doesn't exist yet, insert a minimal
    // placeholder — but the normal path is an UPDATE of an already-indexed row.
    const updated = db
      .prepare('UPDATE entries SET summaryRef = ? WHERE wfid = ?')
      .run(ref, wfid);
    if (updated.changes === 0) {
      // No projection row yet — nothing to attach the summary to. Skip rather
      // than fabricate a partial entry (the meta-write hook will create the
      // real row, and save() won't clobber summaryRef once we set it).
      return;
    }
    // Re-index FTS with the resolved summary BODY (bounded) so search hits the
    // text, not the ref. Failure-isolated — an FTS hiccup must never bubble.
    try {
      const row = db.prepare('SELECT * FROM entries WHERE wfid = ?').get(wfid) as
        | Record<string, unknown>
        | undefined;
      if (row) this.indexFts(rowToEntry(row), summaryBody);
    } catch (err) {
      console.error('[archon] recall FTS summary index failed:', err);
    }
  }

  // §F4 — replace the entry's tag set. Operator CRUD (single UPDATE); validates
  // wfid + no-ops if the row is absent (returns null). Re-indexes FTS because
  // `tags` is an FTS column. Returns the updated entry so the route echoes it.
  setTags(wfid: string, tags: string[]): RecallEntry | null {
    if (!WFID_PATTERN.test(wfid)) return null;
    const db = this.conn;
    const clean = sanitizeTags(tags);
    const res = db.prepare('UPDATE entries SET tags = ? WHERE wfid = ?').run(JSON.stringify(clean), wfid);
    if (res.changes === 0) return null;
    return this.reindexAndGet(wfid);
  }

  // §F4 — set/clear the operator's "pin as memory" flag. Pin-as-memory is the
  // operator MANUALLY marking one of their OWN conversations as important — it
  // is NOT the fenced self-writing-memory pattern (no LLM, no auto-profile, no
  // automatic pinning, ever; reversible via setPinned(wfid, false)). Not an FTS
  // column → no re-index. Returns the updated entry, or null if absent.
  setPinned(wfid: string, pinned: boolean): RecallEntry | null {
    if (!WFID_PATTERN.test(wfid)) return null;
    const res = this.conn
      .prepare('UPDATE entries SET pinned = ? WHERE wfid = ?')
      .run(pinned ? 1 : 0, wfid);
    if (res.changes === 0) return null;
    return this.get(wfid);
  }

  // §F4 — add a link (recall ↔ KB article / task). Read-modify-write the JSON
  // array, deduped on type+id. Not an FTS column → no re-index. Returns the
  // updated entry, or null if absent.
  addLink(wfid: string, link: RecallLink): RecallEntry | null {
    if (!WFID_PATTERN.test(wfid)) return null;
    const current = this.get(wfid);
    if (!current) return null;
    if (!isValidLink(link)) return current;
    const exists = current.links.some((l) => l.type === link.type && l.id === link.id);
    const next = exists ? current.links : [...current.links, { type: link.type, id: link.id }];
    this.conn.prepare('UPDATE entries SET links = ? WHERE wfid = ?').run(JSON.stringify(next), wfid);
    return this.get(wfid);
  }

  // §F4 — remove a link by type+id. No-op (returns the entry unchanged) when the
  // link isn't present. Returns null if the row is absent.
  removeLink(wfid: string, link: RecallLink): RecallEntry | null {
    if (!WFID_PATTERN.test(wfid)) return null;
    const current = this.get(wfid);
    if (!current) return null;
    const next = current.links.filter((l) => !(l.type === link.type && l.id === link.id));
    if (next.length === current.links.length) return current;
    this.conn.prepare('UPDATE entries SET links = ? WHERE wfid = ?').run(JSON.stringify(next), wfid);
    return this.get(wfid);
  }

  // §F4 — back-links: every entry whose `links` includes {type,id}. KB articles
  // are cwd-scoped, so when `cwd` is given we also match it (an article id is
  // only unique within its cwd). The index is small → a full scan + filter is
  // fine (no JSON1 dependency). Returns [] on a bad/empty result.
  backlinks(type: RecallLink['type'], id: string, cwd?: string): RecallEntry[] {
    if (!id) return [];
    const rows = this.conn.prepare('SELECT * FROM entries').all() as Array<Record<string, unknown>>;
    return rows
      .map(rowToEntry)
      .filter((e) => (cwd ? e.cwd === cwd : true))
      .filter((e) => e.links.some((l) => l.type === type && l.id === id));
  }

  // Shared by setTags: re-index FTS (tags changed) then read the persisted row
  // back. Failure-isolated FTS (mirrors save()).
  private reindexAndGet(wfid: string): RecallEntry | null {
    const entry = this.get(wfid);
    if (!entry) return null;
    try {
      const body = entry.summaryRef ? readSummaryBodyFrom(this.recallHome, entry.wfid) : undefined;
      this.indexFts(entry, body);
    } catch (err) {
      console.error('[archon] recall FTS reindex failed:', err);
    }
    return entry;
  }

  // query() — F1 surface: list all entries, optionally filtered by project /
  // provider / pinned, sorted pinned-first then lastActiveAt desc. (§F4 adds the
  // ORDER BY pinned DESC so pinned "memories" float to the top of the index list
  // exactly like the client sorts them — kept consistent in both places. Rich
  // FTS search is F3.)
  query(q: RecallQuery = {}): RecallEntry[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (q.project) { where.push('project = @project'); params.project = q.project; }
    if (q.provider) { where.push('provider = @provider'); params.provider = q.provider; }
    if (q.pinned !== undefined) { where.push('pinned = @pinned'); params.pinned = q.pinned ? 1 : 0; }
    const sql =
      `SELECT * FROM entries${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY pinned DESC, lastActiveAt DESC`;
    const rows = this.conn.prepare(sql).all(params) as Array<Record<string, unknown>>;
    return rows.map(rowToEntry);
  }

  count(): number {
    const row = this.conn.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number };
    return row.n;
  }

  // Lookup one entry by wfid (used by §F3 search to project a transcript hit's
  // wfid back to a full row). Null when unknown.
  get(wfid: string): RecallEntry | null {
    const row = this.conn.prepare('SELECT * FROM entries WHERE wfid = ?').get(wfid) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToEntry(row) : null;
  }

  // Conversation purge — drop this workflow's recall row (+ FTS mirror) so it
  // leaves recall/search/resume immediately rather than waiting for the next
  // projection GC. Best-effort; safe to call for an unknown wfid.
  delete(wfid: string): void {
    try {
      this.conn.prepare('DELETE FROM entries WHERE wfid = ?').run(wfid);
      this.ensureFts();
      this.conn.prepare('DELETE FROM entries_fts WHERE wfid = ?').run(wfid);
    } catch (err) {
      console.error(`[archon] recall delete failed for ${wfid.slice(0, 8)}:`, err);
    }
  }

  // §F3 — raw FTS5 match. search.ts owns the public search() surface (filters,
  // transcript pass, ranking shape); this is the narrow DB primitive it calls.
  // Returns rows joined back to `entries` (for project/provider/date filtering
  // + the full hit projection), ordered by bm25 relevance, each with the FTS5
  // snippet() of whichever indexed column matched + which column it was.
  //
  // `match` is a raw FTS5 MATCH expression — callers MUST sanitize the operator
  // query into a safe FTS expression before passing it (see search.ts
  // toFtsQuery), since FTS5 has its own query syntax (`"` phrases, `*`, `OR`).
  searchFtsRaw(opts: {
    match: string;
    project?: string;
    provider?: ProviderName;
    from?: number;
    to?: number;
    limit?: number;
  }): RecallFtsRow[] {
    this.ensureFts();
    const where: string[] = ['entries_fts MATCH @match'];
    const params: Record<string, unknown> = { match: opts.match };
    if (opts.project) { where.push('e.project = @project'); params.project = opts.project; }
    if (opts.provider) { where.push('e.provider = @provider'); params.provider = opts.provider; }
    if (typeof opts.from === 'number') { where.push('e.lastActiveAt >= @from'); params.from = opts.from; }
    if (typeof opts.to === 'number') { where.push('e.lastActiveAt <= @to'); params.to = opts.to; }
    params.limit = opts.limit ?? 50;
    // snippet(table, colIndex, open, close, ellipsis, tokens). colIndex order
    // matches the CREATE VIRTUAL TABLE column order: 0 wfid, 1 title, 2 summary,
    // 3 tags. We pull a snippet per searchable column; search.ts picks the
    // first non-empty one and labels matchedIn accordingly.
    const sql = `
      SELECT e.*,
             bm25(entries_fts) AS rank,
             snippet(entries_fts, 1, '[', ']', '…', 8) AS snip_title,
             snippet(entries_fts, 2, '[', ']', '…', 8) AS snip_summary,
             snippet(entries_fts, 3, '[', ']', '…', 8) AS snip_tags
      FROM entries_fts
      JOIN entries e ON e.wfid = entries_fts.wfid
      WHERE ${where.join(' AND ')}
      ORDER BY rank
      LIMIT @limit`;
    const rows = this.conn.prepare(sql).all(params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      entry: rowToEntry(row),
      snippetTitle: String(row.snip_title ?? ''),
      snippetSummary: String(row.snip_summary ?? ''),
      snippetTags: String(row.snip_tags ?? ''),
    }));
  }

  // Incremental hook — wired into writeMeta. Builds the projection entry for a
  // single workflow and upserts it. The caller MUST wrap this in try/catch so
  // an index hiccup never breaks the real meta write.
  async upsertFromMeta(meta: WorkflowMeta): Promise<void> {
    const entry = await projectEntry(meta);
    this.save(entry);
  }

  // backfill() — walk every known cwd, project each workflow's meta into an
  // index entry, upsert. Idempotent (upsert by wfid → re-running doesn't
  // duplicate). Returns the number of entries (re)indexed.
  async backfill(): Promise<number> {
    this.load();
    const cwds = await readKnownCwds();
    let n = 0;
    for (const cwd of cwds) {
      let summaries;
      try {
        summaries = await listWorkflowMetas(cwd);
      } catch {
        continue;
      }
      for (const s of summaries) {
        let meta: WorkflowMeta | null = null;
        try {
          meta = await readMeta(cwd, s.workflowId);
        } catch { /* skip unreadable */ }
        if (!meta) continue;
        try {
          await this.upsertFromMeta(meta);
          n++;
        } catch { /* skip — one bad workflow shouldn't abort the backfill */ }
      }
    }
    return n;
  }

  // rebuild() — drop everything and re-backfill from disk. The escape hatch
  // that makes the DB a pure projection: if recall.db is deleted OR suspected
  // stale, rebuild reconstructs it.
  async rebuild(): Promise<number> {
    this.load();
    this.conn.exec('DELETE FROM entries');
    this.ensureFts();
    this.conn.exec('DELETE FROM entries_fts');
    return this.backfill();
  }
}

function rowToEntry(row: Record<string, unknown>): RecallEntry {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(String(row.tags ?? '[]'));
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
  } catch { /* default [] */ }
  // §F4 — defensive links parse, same shape as tags: a bad/legacy value (or a
  // pre-migration row read before this process re-opened the DB) degrades to [].
  let links: RecallLink[] = [];
  try {
    const parsed = JSON.parse(String(row.links ?? '[]'));
    if (Array.isArray(parsed)) links = parsed.filter(isValidLink).map((l) => ({ type: l.type, id: l.id }));
  } catch { /* default [] */ }
  return {
    wfid: String(row.wfid),
    cwd: String(row.cwd),
    project: String(row.project),
    provider: row.provider as ProviderName,
    title: String(row.title),
    createdAt: Number(row.createdAt),
    lastActiveAt: Number(row.lastActiveAt),
    turnCount: Number(row.turnCount),
    summaryRef: row.summaryRef == null ? null : String(row.summaryRef),
    tags,
    // §F4 — SQLite stores the flag as 0/1; coerce to boolean. Absent on a row
    // read before migration → falsy → false.
    pinned: Number(row.pinned ?? 0) === 1,
    links,
  };
}

// ── Projection: meta.json + events.jsonl → RecallEntry ──

async function projectEntry(meta: WorkflowMeta): Promise<RecallEntry> {
  const project = projectName(meta.cwd);
  const { turnCount, firstMessage } = await scanEvents(meta.cwd, meta.workflowId);
  const title = await resolveTitle(meta, project, firstMessage);
  return {
    wfid: meta.workflowId,
    cwd: meta.cwd,
    project,
    provider: meta.primaryProvider,
    title,
    createdAt: meta.createdAt,
    lastActiveAt: meta.lastActiveAt,
    turnCount,
    summaryRef: null,
    tags: [],
    // §F4 — projection defaults; save()'s ON CONFLICT never clobbers these on an
    // existing row, so a re-backfill won't wipe an operator's pin / links.
    pinned: false,
    links: [],
  };
}

function projectName(cwd: string): string {
  const base = path.basename(cwd);
  return base || cwd || 'unknown';
}

// Title fallback chain — NEVER blank:
//   1. Claude `ai-title` (the existing auto-title, read from the workflow's
//      Claude session JSONL — see sessionDiscovery.extractSessionName).
//   2. First operator message (trimmed), from events.jsonl.
//   3. `<provider> · <project> · <date>` derived label.
async function resolveTitle(meta: WorkflowMeta, project: string, firstMessage: string): Promise<string> {
  const aiTitle = await findAiTitle(meta);
  if (aiTitle) return trim(aiTitle);
  if (firstMessage) return trim(firstMessage);
  const date = new Date(meta.createdAt || Date.now()).toISOString().slice(0, 10);
  return `${meta.primaryProvider} · ${project} · ${date}`;
}

function trim(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1).trimEnd() + '…' : t;
}

// Resolve a workflow's Claude ai-title, if any. Claude writes at most one
// ai-title per session into ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl.
// We check the latest Claude CLI session bound to the workflow. Non-Claude
// workflows (or Claude workflows without an ai-title) return undefined and the
// chain falls through.
async function findAiTitle(meta: WorkflowMeta): Promise<string | undefined> {
  const claude = latestCliSessionFor(meta, 'claude');
  if (!claude) return undefined;
  const jsonl = path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(meta.cwd), `${claude.sessionId}.jsonl`);
  try {
    await fs.access(jsonl);
  } catch {
    return undefined;
  }
  const { aiTitle } = await extractSessionName(jsonl);
  return aiTitle;
}

// Scan a workflow's events.jsonl for the operator-turn count + first operator
// message. `user_message_echo` is the canonical operator-turn marker (one per
// submitted prompt), so its count is turnCount and its first `content` is the
// first operator message used by the title chain.
async function scanEvents(cwd: string, wfid: string): Promise<{ turnCount: number; firstMessage: string }> {
  if (!WFID_PATTERN.test(wfid)) return { turnCount: 0, firstMessage: '' };
  const eventsPath = path.join(cwd, '.archon', 'workflows', wfid, 'events.jsonl');
  let raw: string;
  try {
    raw = await fs.readFile(eventsPath, 'utf8');
  } catch {
    return { turnCount: 0, firstMessage: '' };
  }
  let turnCount = 0;
  let firstMessage = '';
  for (const line of raw.split('\n')) {
    if (!line || !line.includes('"user_message_echo"')) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'user_message_echo') continue;
    turnCount++;
    if (!firstMessage && typeof entry.content === 'string' && entry.content.trim()) {
      firstMessage = entry.content.trim();
    }
  }
  return { turnCount, firstMessage };
}

async function readKnownCwds(): Promise<string[]> {
  try {
    const raw = await fs.readFile(knownCwdsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return [];
  }
}

// Process-wide singleton. The meta-write hook + the HTTP route share one
// connection; better-sqlite3 connections are cheap to keep open.
let singleton: RecallIndex | null = null;

// A missing better-sqlite3 binding is the ONE recall failure with a known,
// one-command fix, and it used to read like any other error — one line, buried,
// while the server booted fine and recall was silently dead. npm 12 blocks
// install scripts unless the root package.json `allowScripts` pins cover them
// (and those pins are version-keyed, so a dep bump can silently un-cover the
// package). Say so explicitly instead of printing a bindings-path dump.
function isMissingNativeBinding(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('Could not locate the bindings file')
    || (message.includes('better_sqlite3') && message.includes('MODULE_NOT_FOUND'));
}

export function getRecallIndex(): RecallIndex {
  if (!singleton) {
    singleton = new RecallIndex();
    try {
      singleton.load();
    } catch (err) {
      if (isMissingNativeBinding(err)) {
        console.error('[archon] ─────────────────────────────────────────────────────────────');
        console.error('[archon] RECALL DISABLED — better-sqlite3 native binding is not built.');
        console.error('[archon] Fix:  npm rebuild better-sqlite3');
        console.error('[archon] Cause: npm 12 blocks install scripts unless the root');
        console.error('[archon]        package.json `allowScripts` entry matches the INSTALLED');
        console.error('[archon]        version. Check `npm install-scripts ls` after a dep bump.');
        console.error('[archon] Everything else works; transcript recall/search is off.');
        console.error('[archon] ─────────────────────────────────────────────────────────────');
      } else {
        console.error('[archon] recall index load failed:', err);
      }
    }
  }
  return singleton;
}
