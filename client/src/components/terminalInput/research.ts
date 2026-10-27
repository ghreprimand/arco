// Deep Research composer-button helpers - docs/ARCHITECTURE.md
//
// Extracted from TerminalInput.tsx to keep that file under the 2000-line cap
// (the RESEARCH button's handler + the new-tab "spawn a fresh tab that issues
// its own research_request once created" plumbing live here).
//
// New-tab dispatch can't address the spawned workflow by id at click time —
// the server mints the id. So we stash a one-shot pending entry keyed by a
// client-minted `spawnToken` carried on the new WorkflowConfig; when the
// matching `workflow_created` lands, the WS layer drains it and fires the
// `research_request`. This mirrors how DOCS/GIT spawn a fresh tab, except the
// new tab issues a structured research request rather than a chat turn.

import type { ProviderName, ModelName, EffortLevel } from '@arco/shared';

export interface PendingResearch {
  topic: string;
  maxRounds: number;
  researcher: {
    provider: ProviderName;
    model: ModelName;
    effort: EffortLevel;
    providerAccountRef?: string;
  };
}

// Keyed by the client-minted spawn token threaded onto the new tab's config
// (WorkflowConfig.researchSpawnToken). One-shot — drained on workflow_created.
const pending = new Map<string, PendingResearch>();

export function mintResearchSpawnToken(): string {
  return `res-spawn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function registerPendingResearch(token: string, req: PendingResearch): void {
  pending.set(token, req);
}

// Called from the WS workflow_created handler. Returns the pending request (and
// removes it) if this freshly created workflow carried a research spawn token.
export function takePendingResearch(token: string | undefined): PendingResearch | undefined {
  if (!token) return undefined;
  const req = pending.get(token);
  if (req) pending.delete(token);
  return req;
}
