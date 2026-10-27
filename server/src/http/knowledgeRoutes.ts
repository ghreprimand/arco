import { IncomingMessage, ServerResponse } from 'http';
import {
  alwaysIncludeBytes,
  createArticle,
  deleteArticle,
  listArticles,
  readArticle,
  updateArticle,
} from '../knowledge/store.js';
import { KNOWLEDGE_INJECT_BUDGET } from '@arco/shared';
import type {
  KnowledgeBodyResponse,
  KnowledgeCreateRequest,
  KnowledgeListResponse,
  KnowledgeUpdateRequest,
} from '@arco/shared';

// docs/ARCHITECTURE.md - Knowledge base CRUD (per-cwd, REST).
//
//   GET    /api/knowledge?path=<cwd>[&q=<text>]   → { articles, alwaysIncludeBytes, budget }
//   GET    /api/knowledge/body?path=<cwd>&id=<id> → { article }
//   POST   /api/knowledge?path=<cwd>              → { article } (create)
//   PATCH  /api/knowledge?path=<cwd>&id=<id>      → { article } (update)
//   DELETE /api/knowledge?path=<cwd>&id=<id>      → { ok: true }
//
// CRUD is REST (not workflow-scoped WS) — it's per-cwd, mirroring the Plans
// surface. THE FENCE: these are the ONLY knowledge write paths and every one is
// operator-driven (UI buttons). No agent reaches them; the distill DRAFT (WS)
// produces text the operator then POSTs here via Save.

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

export async function tryHandleKnowledgeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!req.url?.startsWith('/api/knowledge')) return false;
  const json = (code: number, body: unknown): true => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  };
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const cwd = url.searchParams.get('path');
  if (!cwd) return json(400, { error: 'path query required' });

  try {
    // One full article.
    if (url.pathname === '/api/knowledge/body' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) return json(400, { error: 'id query required' });
      const article = await readArticle(cwd, id);
      if (!article) return json(404, { error: 'article not found' });
      return json(200, { article } satisfies KnowledgeBodyResponse);
    }

    // List + budget summary.
    if (url.pathname === '/api/knowledge' && req.method === 'GET') {
      const q = url.searchParams.get('q') || undefined;
      const articles = await listArticles(cwd, q);
      const bytes = await alwaysIncludeBytes(cwd);
      return json(200, {
        articles,
        alwaysIncludeBytes: bytes,
        budget: KNOWLEDGE_INJECT_BUDGET,
      } satisfies KnowledgeListResponse);
    }

    // Create.
    if (url.pathname === '/api/knowledge' && req.method === 'POST') {
      const parsed = JSON.parse((await readBody(req)) || '{}') as KnowledgeCreateRequest;
      const article = await createArticle(cwd, {
        title: parsed.title ?? '',
        body: parsed.body ?? '',
        tags: parsed.tags,
        alwaysInclude: parsed.alwaysInclude,
      });
      return json(200, { article } satisfies KnowledgeBodyResponse);
    }

    // Update (any subset).
    if (url.pathname === '/api/knowledge' && req.method === 'PATCH') {
      const id = url.searchParams.get('id');
      if (!id) return json(400, { error: 'id query required' });
      const patch = JSON.parse((await readBody(req)) || '{}') as KnowledgeUpdateRequest;
      const article = await updateArticle(cwd, id, patch);
      if (!article) return json(404, { error: 'article not found' });
      return json(200, { article } satisfies KnowledgeBodyResponse);
    }

    // Delete.
    if (url.pathname === '/api/knowledge' && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return json(400, { error: 'id query required' });
      const ok = await deleteArticle(cwd, id);
      return json(ok ? 200 : 404, ok ? { ok: true } : { error: 'article not found' });
    }
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : String(err) });
  }
  return false;
}
