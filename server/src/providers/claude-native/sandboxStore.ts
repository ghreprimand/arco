// EFFICIENCY_PLAN.md Phase E §9a — per-tab sandbox store. SQLite + FTS5
// virtual table holds chunks produced by ctx_execute. Stored at
// <cwd>/.archon/workflows/<wfid>/sandbox.db so the file lives next to the
// workflow's events.jsonl + meta.json. Cleared on tab close (the
// remove_workflow handler unlinks the file) and on explicit
// POST /api/workflows/:wfId/sandbox/clear.
//
// Trust model: the database is operator-curated. Only ctx_execute writes
// (chunks are bytes the model itself chose to spill via stdout-redirect or
// `archon.chunks.put(...)`), and only ctx_search / ctx_fetch read. No
// silent retroactive mutation of chunk contents; updates are append-only.
//
// The default `unicode61` tokenizer survives 'added' and 'fix' (both
// pass-through in the smoke test). FTS5 stopwords are opt-in via the
// tokenizer config, so the GOTCHA the brief asked us to document is the
// inverse of what we shipped: the tokenizer does NOT strip stopwords —
// future contributors should beware of CHANGING the tokenizer.

import Database from 'better-sqlite3';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SandboxChunkSummary {
  chunkId: number;
  language: string;
  byteLen: number;
  createdAt: number;
  preview: string;
}

export interface SandboxSearchHit {
  chunkId: number;
  language: string;
  byteLen: number;
  createdAt: number;
  snippet: string;
  score: number;
}

export interface SandboxStats {
  chunkCount: number;
  totalBytes: number;
  dbPath: string;
}

export class SandboxStore {
  private db: Database.Database;

  constructor(public readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        language TEXT NOT NULL,
        content TEXT NOT NULL,
        byte_len INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, content='chunks', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;
    `);
  }

  insertChunk(language: string, content: string): { chunkId: number; byteLen: number } {
    const byteLen = Buffer.byteLength(content, 'utf8');
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO chunks (language, content, byte_len, created_at) VALUES (?, ?, ?, ?)`,
    );
    const info = stmt.run(language, content, byteLen, now);
    return { chunkId: Number(info.lastInsertRowid), byteLen };
  }

  search(query: string, limit = 5): SandboxSearchHit[] {
    // BM25 returns negative scores; lowest (most negative) = best match.
    // We expose ascending order so smaller numeric values are "better."
    const stmt = this.db.prepare(`
      SELECT c.id AS chunkId, c.language, c.byte_len AS byteLen, c.created_at AS createdAt,
             snippet(chunks_fts, 0, '«', '»', '…', 12) AS snippet,
             bm25(chunks_fts) AS score
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `);
    try {
      return stmt.all(query, limit) as SandboxSearchHit[];
    } catch (err) {
      // FTS5 throws on malformed queries (e.g. unbalanced quotes). Treat
      // as zero hits — the model can refine.
      if (err instanceof Error && /fts5/i.test(err.message)) return [];
      throw err;
    }
  }

  fetch(chunkId: number): { content: string; language: string; byteLen: number; createdAt: number } | null {
    const row = this.db
      .prepare(`SELECT language, content, byte_len AS byteLen, created_at AS createdAt FROM chunks WHERE id = ?`)
      .get(chunkId) as { language: string; content: string; byteLen: number; createdAt: number } | undefined;
    return row ?? null;
  }

  recentChunks(limit = 20): SandboxChunkSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id AS chunkId, language, byte_len AS byteLen, created_at AS createdAt,
                substr(content, 1, 200) AS preview
         FROM chunks ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as SandboxChunkSummary[];
    return rows;
  }

  stats(): SandboxStats {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS chunkCount, COALESCE(SUM(byte_len), 0) AS totalBytes FROM chunks`)
      .get() as { chunkCount: number; totalBytes: number };
    return { chunkCount: row.chunkCount, totalBytes: row.totalBytes, dbPath: this.dbPath };
  }

  clear(): void {
    this.db.exec(`DELETE FROM chunks;`);
    this.db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild');`);
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

// Singleton-per-workflow cache. Stores stay open across turns so FTS5
// caches stay warm; closed on remove_workflow + clear endpoint. The store
// itself is cheap to open, but we don't want N opens per turn.
const cache = new Map<string, SandboxStore>();

function dbPathFor(cwd: string, workflowId: string): string {
  return join(cwd, '.archon', 'workflows', workflowId, 'sandbox.db');
}

export function getSandboxStore(cwd: string, workflowId: string): SandboxStore {
  const key = `${cwd}::${workflowId}`;
  let s = cache.get(key);
  if (!s) {
    s = new SandboxStore(dbPathFor(cwd, workflowId));
    cache.set(key, s);
  }
  return s;
}

export function disposeSandboxStore(cwd: string, workflowId: string): void {
  const key = `${cwd}::${workflowId}`;
  const s = cache.get(key);
  if (s) {
    s.close();
    cache.delete(key);
  }
}

// remove_workflow path: close handle AND unlink the file. WAL sidecars
// (sandbox.db-wal, sandbox.db-shm) are removed on a clean close, but we
// best-effort-remove them too in case the process was killed.
export function destroySandbox(cwd: string, workflowId: string): void {
  disposeSandboxStore(cwd, workflowId);
  const dbPath = dbPathFor(cwd, workflowId);
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${dbPath}${suffix}`;
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* best-effort */ }
    }
  }
}

export function getSandboxDbPath(cwd: string, workflowId: string): string {
  return dbPathFor(cwd, workflowId);
}
