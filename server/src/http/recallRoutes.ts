import { IncomingMessage, ServerResponse } from 'http';
import { promises as fs } from 'fs';
import { PORT } from '../server/constants.js';
import { getRecallIndex, recallSummaryPath } from '../recall/index.js';
import { search as recallSearch } from '../recall/search.js';
import type {
  ProviderName,
  RecallIndexResponse,
  RecallSearchResponse,
  RecallEntryResponse,
  RecallBacklinksResponse,
  RecallLink,
} from '@arco/shared';

// §F2 — only basenames matching this can index a recall path. Blocks traversal
// (`..`, slashes) before joining into ~/.arco/recall/<wfid>/summary.md.
const WFID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

// Workbench Expansion §F1 + §F3 — Recall index + search endpoints.
//
//   GET /api/recall/index[?project=<p>][&provider=<name>]  → { entries: [...] }
//   GET /api/recall/search?q[&project][&provider][&from][&to][&transcripts=1]
//                                                          → { hits: [...] }
//
// /index: the machine-global, cross-cwd list of every workflow ever run, each
// with a non-blank title (the F1 title chain). Sorted lastActiveAt desc.
//
// /search (§F3): keyword search over titles/summaries/tags (FTS5) + optional
// transcript full-text (ripgrep, ?transcripts=1). Ranked hits with snippets.
// Both always 200 with a structured body — a read failure degrades to an empty
// list rather than a 500, so the client renders an empty Recall view instead
// of an error.

// Record<ProviderName, true> so adding a provider to the union fails the
const PROVIDER_FLAGS: Record<ProviderName, true> = {
  claude: true, codex: true, gemini: true, ollama: true, llamacpp: true,
   lmstudio: true, strata: true, deepseek: true, cursor: true,
};
const PROVIDERS = new Set<ProviderName>(Object.keys(PROVIDER_FLAGS) as ProviderName[]);

function parseProvider(raw: string | null | undefined): ProviderName | undefined {
  return raw && PROVIDERS.has(raw as ProviderName) ? (raw as ProviderName) : undefined;
}

function parseEpoch(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// §F4 — read a request body to a string (mirrors knowledgeRoutes.ts).
async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

// §F4 — validate an operator-supplied link payload before it hits the index.
function asLink(raw: unknown): RecallLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;
  if ((l.type !== 'kb' && l.type !== 'task') || typeof l.id !== 'string' || !l.id) return null;
  return { type: l.type, id: l.id };
}

export async function tryHandleRecallRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const send = (code: number, body: unknown): true => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  };

  // §F2 — serve a conversation's saved summary.md. The recall home lives
  // OUTSIDE any cwd the /api/workflows/artifact endpoint serves, so summaries
  // need their own route. wfid is validated against WFID_PATTERN (no `..`, no
  // separators) BEFORE it's joined into a path — recallSummaryPath re-checks
  // and returns null on a bad wfid, so a traversal attempt can't escape
  // ~/.arco/recall/<wfid>/. Always serves only summary.md under that dir.
  if (req.url?.startsWith('/api/recall/summary') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const wfid = url.searchParams.get('wfid') || '';
      if (!WFID_PATTERN.test(wfid)) {
        return send(400, { error: 'invalid wfid' });
      }
      const summaryPath = recallSummaryPath(wfid);
      if (!summaryPath) {
        return send(400, { error: 'invalid wfid' });
      }
      let body: string;
      try {
        body = await fs.readFile(summaryPath, 'utf8');
      } catch {
        return send(404, { error: 'no summary for this conversation yet' });
      }
      return send(200, { wfid, summary: body });
    } catch (err) {
      console.error('[arco] recall summary read failed:', err);
      return send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // §F3 — search (checked before /index so the prefix match is unambiguous).
  if (req.url?.startsWith('/api/recall/search') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const body: RecallSearchResponse = await recallSearch({
        q: url.searchParams.get('q') || undefined,
        project: url.searchParams.get('project') || undefined,
        provider: parseProvider(url.searchParams.get('provider')),
        from: parseEpoch(url.searchParams.get('from')),
        to: parseEpoch(url.searchParams.get('to')),
        includeTranscripts: url.searchParams.get('transcripts') === '1',
      });
      return send(200, body);
    } catch (err) {
      console.error('[arco] recall search failed:', err);
      const body: RecallSearchResponse = { hits: [], transcriptsAvailable: false };
      return send(200, body);
    }
  }

  // §F4 — back-links: conversations linking to a KB article / task. Always 200
  // with a structured body; a read failure degrades to an empty list (like
  // /index and /search) so the KB tab's "Linked conversations" never errors.
  if (req.url?.startsWith('/api/recall/backlinks') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const type = url.searchParams.get('type');
      const id = url.searchParams.get('id') || '';
      const cwd = url.searchParams.get('cwd') || undefined;
      if ((type !== 'kb' && type !== 'task') || !id) {
        const body: RecallBacklinksResponse = { entries: [] };
        return send(200, body);
      }
      const entries = getRecallIndex().backlinks(type, id, cwd);
      const body: RecallBacklinksResponse = { entries };
      return send(200, body);
    } catch (err) {
      console.error('[arco] recall backlinks failed:', err);
      const body: RecallBacklinksResponse = { entries: [] };
      return send(200, body);
    }
  }

  // §F4 — set the tag set for one conversation. Operator-initiated; 400 on a bad
  // wfid (mutations may 400, unlike the degrade-to-empty reads above).
  if (req.url?.startsWith('/api/recall/tags') && req.method === 'POST') {
    try {
      const parsed = JSON.parse((await readBody(req)) || '{}') as { wfid?: unknown; tags?: unknown };
      const wfid = typeof parsed.wfid === 'string' ? parsed.wfid : '';
      if (!WFID_PATTERN.test(wfid)) return send(400, { error: 'invalid wfid' });
      const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : [];
      const entry = getRecallIndex().setTags(wfid, tags);
      if (!entry) return send(404, { error: 'conversation not in recall index' });
      const body: RecallEntryResponse = { entry };
      return send(200, body);
    } catch (err) {
      console.error('[arco] recall setTags failed:', err);
      return send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // §F4 — pin-as-memory. The operator MANUALLY marks one of their OWN
  // conversations as important (sorts to the top + a "pinned only" filter). This
  // is NOT the fenced self-writing memory — no LLM, no auto-profile, fully
  // reversible (pinned: false). See docs/RECALL.md § Pin-as-memory.
  if (req.url?.startsWith('/api/recall/pin') && req.method === 'POST') {
    try {
      const parsed = JSON.parse((await readBody(req)) || '{}') as { wfid?: unknown; pinned?: unknown };
      const wfid = typeof parsed.wfid === 'string' ? parsed.wfid : '';
      if (!WFID_PATTERN.test(wfid)) return send(400, { error: 'invalid wfid' });
      const entry = getRecallIndex().setPinned(wfid, parsed.pinned === true);
      if (!entry) return send(404, { error: 'conversation not in recall index' });
      const body: RecallEntryResponse = { entry };
      return send(200, body);
    } catch (err) {
      console.error('[arco] recall setPinned failed:', err);
      return send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // §F4 — add (POST) / remove (DELETE) a link (recall ↔ KB article / task).
  if (req.url?.startsWith('/api/recall/link') && (req.method === 'POST' || req.method === 'DELETE')) {
    try {
      const parsed = JSON.parse((await readBody(req)) || '{}') as { wfid?: unknown; link?: unknown };
      const wfid = typeof parsed.wfid === 'string' ? parsed.wfid : '';
      if (!WFID_PATTERN.test(wfid)) return send(400, { error: 'invalid wfid' });
      const link = asLink(parsed.link);
      if (!link) return send(400, { error: 'invalid link' });
      const idx = getRecallIndex();
      const entry = req.method === 'POST' ? idx.addLink(wfid, link) : idx.removeLink(wfid, link);
      if (!entry) return send(404, { error: 'conversation not in recall index' });
      const body: RecallEntryResponse = { entry };
      return send(200, body);
    } catch (err) {
      console.error('[arco] recall link failed:', err);
      return send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (req.url?.startsWith('/api/recall/index') && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const project = url.searchParams.get('project') || undefined;
      const provider = parseProvider(url.searchParams.get('provider'));
      const entries = getRecallIndex().query({ project, provider });
      const body: RecallIndexResponse = { entries };
      return send(200, body);
    } catch (err) {
      console.error('[arco] recall index query failed:', err);
      const body: RecallIndexResponse = { entries: [] };
      return send(200, body);
    }
  }

  return false;
}
