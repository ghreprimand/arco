// Knowledge store - docs/ARCHITECTURE.md
//
// A per-cwd, OPERATOR-OWNED knowledge base under <cwd>/.arco/knowledge/:
//   - index.json   → { articles: [{ id, title, tags, alwaysInclude, ... }] }
//   - <id>.md      → markdown body
//
// Operator-readable/editable on disk (markdown bodies + a small JSON index),
// atomic temp+rename writes cloned from planStore.ts / workflowMeta.ts.
//
// Behind a deliberate load()/save()/query() interface (plan Part E storage
// rationale): the KB is the one Arco subsystem with a real SQLite+FTS5 future
// if article count / search latency grows. Keeping CRUD behind this boundary
// makes that migration a single-file swap rather than a rewrite. Until then,
// JSON/markdown keeps it consistent with the rest of the repo (and the bodies
// stay diff-able / hand-editable).
//
// THE FENCE (CLAUDE.md hard fences + plan Appendix B): this store is pure
// operator-driven CRUD. NOTHING here is ever called by an LLM to auto-save.
// The wizard's "distill from session" path produces a DRAFT the operator edits
// and Saves through the same create()/update() the manual paths use — there is
// no server-side write path an agent can reach. This file has no awareness of
// distillation at all, by design.

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  KNOWLEDGE_BODY_MAX,
  KNOWLEDGE_INJECT_BUDGET,
  type KnowledgeArticle,
  type KnowledgeArticleSummary,
} from '@arco/shared';
import { atomicWriteFile } from '../atomicFile.js';

const ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const TITLE_MAX = 200;
const TAG_MAX = 40;
const TAGS_MAX = 24;

function knowledgeDir(cwd: string): string {
  return path.join(cwd, '.arco', 'knowledge');
}
function indexPath(cwd: string): string {
  return path.join(knowledgeDir(cwd), 'index.json');
}
function bodyPath(cwd: string, id: string): string {
  return path.join(knowledgeDir(cwd), `${id}.md`);
}

export function isValidKnowledgeId(id: string): boolean {
  return ID_PATTERN.test(id);
}

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

function bytesOf(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

// ── The interface boundary ──
// load() / save() / query() are the ONLY three primitives a future SQLite+FTS5
// backend has to reimplement. Everything else (CRUD, injection) is built on
// top of these. `save` upserts a full article (summary + body); `load` reads
// one by id; `query` returns matching summaries.

interface KnowledgeIndex {
  articles: KnowledgeArticleSummary[];
}

async function readIndex(cwd: string): Promise<KnowledgeIndex> {
  try {
    const raw = await fs.readFile(indexPath(cwd), 'utf8');
    const parsed = JSON.parse(raw) as KnowledgeIndex;
    if (!parsed || !Array.isArray(parsed.articles)) return { articles: [] };
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { articles: [] };
    throw err;
  }
}

async function writeIndex(cwd: string, idx: KnowledgeIndex): Promise<void> {
  await atomicWriteFile(indexPath(cwd), JSON.stringify(idx, null, 2) + '\n');
}

export interface KnowledgeStore {
  load(cwd: string, id: string): Promise<KnowledgeArticle | null>;
  save(cwd: string, article: KnowledgeArticle): Promise<void>;
  remove(cwd: string, id: string): Promise<boolean>;
  query(cwd: string, opts?: KnowledgeQuery): Promise<KnowledgeArticleSummary[]>;
}

export interface KnowledgeQuery {
  // Case-insensitive substring over title + tags (markdown bodies are NOT
  // scanned here — that's the FTS5 future; linear body scan stays out of the
  // hot list path). When absent, returns all summaries.
  text?: string;
  // When true, only articles flagged alwaysInclude (the injection set).
  alwaysIncludeOnly?: boolean;
}

// The JSON/markdown implementation. The body lives in <id>.md; the summary
// (incl. byte length) is mirrored in index.json so list/query stay O(N) with
// no per-row body read.
const jsonStore: KnowledgeStore = {
  async load(cwd, id) {
    if (!cwd || !isValidKnowledgeId(id)) return null;
    const { articles } = await readIndex(cwd);
    const summary = articles.find((a) => a.id === id);
    if (!summary) return null;
    let body: string;
    try {
      body = await fs.readFile(bodyPath(cwd, id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return { ...summary, body };
  },

  async save(cwd, article) {
    if (!cwd || !isValidKnowledgeId(article.id)) throw new Error('save: invalid cwd/id');
    const body = (article.body ?? '').slice(0, KNOWLEDGE_BODY_MAX);
    const summary: KnowledgeArticleSummary = {
      id: article.id,
      title: (article.title ?? '').trim().slice(0, TITLE_MAX) || 'Untitled',
      tags: sanitizeTags(article.tags),
      alwaysInclude: article.alwaysInclude === true,
      createdAt: article.createdAt,
      updatedAt: article.updatedAt,
      bytes: bytesOf(body),
    };
    const idx = await readIndex(cwd);
    const i = idx.articles.findIndex((a) => a.id === article.id);
    if (i === -1) idx.articles.push(summary);
    else idx.articles[i] = summary;
    // Body first, then index — if the index write fails the body is still
    // recoverable; an orphan body without an index entry is invisible (never
    // loaded) rather than corrupting the list.
    await atomicWriteFile(bodyPath(cwd, article.id), body);
    await writeIndex(cwd, idx);
  },

  async remove(cwd, id) {
    if (!cwd || !isValidKnowledgeId(id)) return false;
    const idx = await readIndex(cwd);
    const i = idx.articles.findIndex((a) => a.id === id);
    if (i === -1) return false;
    idx.articles.splice(i, 1);
    await writeIndex(cwd, idx);
    try { await fs.unlink(bodyPath(cwd, id)); } catch { /* ENOENT — already gone */ }
    return true;
  },

  async query(cwd, opts) {
    if (!cwd) return [];
    const { articles } = await readIndex(cwd);
    let rows = articles;
    if (opts?.alwaysIncludeOnly) rows = rows.filter((a) => a.alwaysInclude);
    if (opts?.text) {
      const needle = opts.text.toLowerCase();
      rows = rows.filter(
        (a) =>
          a.title.toLowerCase().includes(needle) ||
          a.tags.some((t) => t.toLowerCase().includes(needle)),
      );
    }
    return [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
  },
};

// The active store. A future SQLite+FTS5 backend swaps this binding (and adds a
// one-shot JSON→rows migration) without touching any caller.
export const store: KnowledgeStore = jsonStore;

// ── CRUD layer (operator-driven; the only write paths) ──

export async function listArticles(cwd: string, text?: string): Promise<KnowledgeArticleSummary[]> {
  return store.query(cwd, text ? { text } : undefined);
}

export async function readArticle(cwd: string, id: string): Promise<KnowledgeArticle | null> {
  return store.load(cwd, id);
}

export async function createArticle(
  cwd: string,
  input: { title: string; body: string; tags?: string[]; alwaysInclude?: boolean },
): Promise<KnowledgeArticle> {
  if (!cwd) throw new Error('createArticle: cwd required');
  const now = Date.now();
  const article: KnowledgeArticle = {
    id: randomUUID(),
    title: (input.title ?? '').trim().slice(0, TITLE_MAX) || 'Untitled',
    body: (input.body ?? '').slice(0, KNOWLEDGE_BODY_MAX),
    tags: sanitizeTags(input.tags),
    alwaysInclude: input.alwaysInclude === true,
    createdAt: now,
    updatedAt: now,
    bytes: bytesOf((input.body ?? '').slice(0, KNOWLEDGE_BODY_MAX)),
  };
  await store.save(cwd, article);
  return article;
}

export async function updateArticle(
  cwd: string,
  id: string,
  patch: { title?: string; body?: string; tags?: string[]; alwaysInclude?: boolean },
): Promise<KnowledgeArticle | null> {
  const existing = await store.load(cwd, id);
  if (!existing) return null;
  const next: KnowledgeArticle = {
    ...existing,
    title: typeof patch.title === 'string' ? patch.title : existing.title,
    body: typeof patch.body === 'string' ? patch.body : existing.body,
    tags: patch.tags !== undefined ? sanitizeTags(patch.tags) : existing.tags,
    alwaysInclude: patch.alwaysInclude !== undefined ? patch.alwaysInclude === true : existing.alwaysInclude,
    updatedAt: Date.now(),
  };
  await store.save(cwd, next);
  return store.load(cwd, id);
}

export async function deleteArticle(cwd: string, id: string): Promise<boolean> {
  return store.remove(cwd, id);
}

// Sum of always-include body bytes — drives the budget bar in the tab and the
// over-budget signal. Cheap (index-only; no body reads).
export async function alwaysIncludeBytes(cwd: string): Promise<number> {
  const rows = await store.query(cwd, { alwaysIncludeOnly: true });
  return rows.reduce((sum, a) => sum + a.bytes, 0);
}

// ── System-prompt injection (the bounded block) ──
//
// Assembles the always-include articles into ONE block to fold into the turn's
// appendSystemPrompt. BOUNDED is load-bearing: the combined body is hard-capped
// at KNOWLEDGE_INJECT_BUDGET. When the set exceeds the cap, articles are taken
// in updatedAt order (most-recently-curated first — the operator's freshest
// facts win the budget) until adding the next would overflow, and an explicit
// truncation notice is appended naming how many articles / bytes were dropped.
// The returned `bytes` (post-cap) is what the caller logs for the four-question
// test (events.jsonl context visibility) — never the pre-cap total.
export interface KnowledgeBlock {
  text: string;        // '' when no always-include articles
  bytes: number;       // bytes of `text` (post-cap)
  included: number;    // article count actually folded in
  total: number;       // total always-include article count
  truncated: boolean;
}

const DELIM = '--- Knowledge base ---';

export async function buildKnowledgeBlock(
  cwd: string,
  budget: number = KNOWLEDGE_INJECT_BUDGET,
): Promise<KnowledgeBlock> {
  const empty: KnowledgeBlock = { text: '', bytes: 0, included: 0, total: 0, truncated: false };
  if (!cwd) return empty;
  const summaries = await store.query(cwd, { alwaysIncludeOnly: true });
  if (summaries.length === 0) return empty;

  const header =
    `${DELIM}\n` +
    `Operator-curated facts for this project (from Arco's knowledge base). ` +
    `Treat these as authoritative project context.\n`;

  const parts: string[] = [];
  let used = bytesOf(header);
  let included = 0;
  for (const s of summaries) {
    const article = await store.load(cwd, s.id);
    if (!article) continue;
    const section = `## ${article.title}\n${article.tags.length ? `_tags: ${article.tags.join(', ')}_\n` : ''}\n${article.body.trim()}\n`;
    const sectionBytes = bytesOf('\n' + section);
    if (used + sectionBytes > budget) break;
    parts.push(section);
    used += sectionBytes;
    included++;
  }

  const truncated = included < summaries.length;
  let text = header + (parts.length ? '\n' + parts.join('\n') : '');
  if (truncated) {
    const dropped = summaries.length - included;
    text += `\n[... ${dropped} more always-include article${dropped === 1 ? '' : 's'} omitted: knowledge base exceeds the ${Math.round(budget / 1024)} KB injection budget. Trim or unflag articles in the Knowledge tab.]\n`;
  }
  return { text, bytes: bytesOf(text), included, total: summaries.length, truncated };
}
