// Workbench Expansion §D4 — deferred template post-create actions.
//
// Mirrors terminalInput/research.ts pendingResearch: a one-shot map keyed by
// the spawn token threaded onto the new tab's config
// (WorkflowConfig.templateSpawnToken). When the freshly created tab
// materializes in the workflow_created WS handler, the deferred seedPrompt
// (composer pre-fill) + plan (POST /api/plans attach) are applied against the
// real workflow id, then drained. Pre-fill only — NEVER auto-sends (§D4
// design decision 2).

export interface PendingTemplateApply {
  // Optional composer pre-fill — seeded into the new tab's draft, not sent.
  seedPrompt?: string;
  // Optional plan body (markdown) — POSTed to /api/plans (attach:true).
  plan?: string;
}

const pending = new Map<string, PendingTemplateApply>();

export function mintTemplateSpawnToken(): string {
  return `tmpl-spawn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function registerPendingTemplateApply(token: string, req: PendingTemplateApply): void {
  pending.set(token, req);
}

// Called from the WS workflow_created handler. Returns the pending apply (and
// removes it) if this freshly created workflow carried a template spawn token.
export function takePendingTemplateApply(token: string | undefined): PendingTemplateApply | undefined {
  if (!token) return undefined;
  const req = pending.get(token);
  if (req) pending.delete(token);
  return req;
}
