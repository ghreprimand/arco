// DD7 — project-trust HTTP surface.
//
// The turn-time gate raises ONE `project_trust_prompt` per cwd per server
// lifetime, and that banner renders only in the composer of the member tab whose
// turn happened to hit the gate first (TerminalInput). Miss it — you were on the
// cluster parent tab, or a peer consumed the prompt — and the only way back was
// hand-editing ~/.archon/trust.json. These routes are the standing operator
// surface for the same decision: list what's recorded, record/flip one, or drop
// one so the prompt re-arms.
//
// HTTP rather than WS because the trust file is user-scope, not workflow-scope:
// the global SettingsPanel has no workflowId to send `set_project_trust` with.
// The workflow-scoped WS message stays as-is for the in-tab banner buttons.
// Writes still land in events.jsonl — every live workflow whose cwd the decision
// covers gets a `project_trust_set` broadcast (visibility leg of the
// four-question test) and any stale banner in those tabs clears.

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  canonicalizePath,
  decideTrust,
  hasTrustRequiringProjectResources,
  isAncestorOrSelf,
  readDefaultProjectTrust,
  readTrustFile,
  removeTrustDecision,
  writeTrustDecision,
  clearPromptPending,
  type TrustDecision,
} from '../projectTrust.js';
import { broadcastWorkflow } from '../server/broadcast.js';
import { workflows } from '../server/state.js';

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

// Snapshot the whole trust file plus (optionally) the resolved status for one
// cwd, so a caller renders the list and the "is THIS repo trusted?" answer in a
// single round-trip.
async function snapshot(cwd?: string) {
  const [file, defaultProjectTrust] = await Promise.all([readTrustFile(), readDefaultProjectTrust()]);
  const entries = Object.entries(file.entries)
    .map(([path, e]) => ({ path, decision: e.decision, at: e.at }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!cwd) return { defaultProjectTrust, entries };
  const { status, matchedPath } = decideTrust(file.entries, cwd, defaultProjectTrust);
  // The suppressed-resource list is what makes the status actionable — an 'ask'
  // repo with no CLAUDE.md / skills / settings never gates anything.
  const resources = await hasTrustRequiringProjectResources(cwd).catch(() => [] as string[]);
  return {
    defaultProjectTrust,
    entries,
    cwd: { path: canonicalizePath(cwd), status, matchedPath, resources },
  };
}

// Tell every live workflow the decision covers. Keyed by cwd, not by tab, so a
// grant from the settings panel clears the banner in every cluster member
// sharing that repo — the same fan-out the gate's per-cwd prompt dedup assumes.
function broadcastToCoveredWorkflows(key: string, decision: TrustDecision): void {
  for (const [workflowId, wf] of workflows) {
    const wfCwd = wf.config?.workingDirectory;
    if (!wfCwd) continue;
    if (!isAncestorOrSelf(key, canonicalizePath(wfCwd))) continue;
    broadcastWorkflow(workflowId, { type: 'project_trust_set', workflowId, cwd: wfCwd, decision });
  }
}

export async function tryHandleProjectTrustRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!req.url || !req.url.startsWith('/api/project-trust')) return false;
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/project-trust') return false;

  if (req.method === 'GET') {
    try {
      const cwd = url.searchParams.get('cwd') || undefined;
      return json(res, 200, await snapshot(cwd));
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (req.method === 'POST') {
    try {
      const parsed = JSON.parse((await readBody(req)) || '{}') as { cwd?: unknown; decision?: unknown };
      const cwd = typeof parsed.cwd === 'string' ? parsed.cwd.trim() : '';
      const decision = parsed.decision;
      if (!cwd) return json(res, 400, { error: 'expected { cwd: string }' });
      if (decision !== 'always' && decision !== 'never' && decision !== 'clear') {
        return json(res, 400, { error: "decision must be 'always' | 'never' | 'clear'" });
      }
      if (decision === 'clear') {
        const removed = await removeTrustDecision(cwd);
        // Re-arm the one-shot prompt for this cwd so the next turn asks again
        // rather than silently suppressing with no way back.
        clearPromptPending(cwd);
        console.log(`[archon] project trust cleared for ${removed ?? canonicalizePath(cwd)}`);
        return json(res, 200, { ...(await snapshot(cwd)), removed: removed ?? null });
      }
      const key = await writeTrustDecision(cwd, decision, Date.now());
      clearPromptPending(cwd);
      broadcastToCoveredWorkflows(key, decision);
      console.log(`[archon] project trust recorded: ${decision} for ${key}`);
      return json(res, 200, await snapshot(cwd));
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return json(res, 405, { error: `${req.method} not allowed on /api/project-trust` });
}
