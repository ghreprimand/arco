import { randomUUID } from 'node:crypto';
import { broadcastWorkflow } from '../../server/broadcast.js';

type PermissionChoice = { optionId?: string; kind?: string; name?: string };
type Pending = { workflowId: string; gateId: string; toolName: string; args: Record<string, unknown>; resolve: (value: unknown) => void; options: PermissionChoice[] };
const pending = new Map<string, Pending>();

// ACP agents own execution; only the exact displayed request can be approved.
// No standing or edited approval is carried over to an ACP process.
export function requestAcpPermission(workflowId: string, params: Record<string, unknown>, skipPermissions = false): Promise<unknown> {
  const tool = params.toolCall && typeof params.toolCall === 'object' ? params.toolCall as Record<string, unknown> : {};
  const options = Array.isArray(params.options) ? params.options as PermissionChoice[] : [];
  const identity = [tool.title, tool.kind, tool.toolName, tool.name, JSON.stringify(tool.rawInput ?? {})].filter(v => typeof v === 'string').join(' ');
  if (/\b(schedule|scheduled|cron|automation)\b/i.test(identity)) {
    broadcastWorkflow(workflowId, { type: 'system_notice', workflowId, content: 'Antigravity scheduling requires unattended execution and was declined.' });
    const deny = options.find(o => o.kind === 'reject_once' && o.optionId);
    return Promise.resolve(deny ? { outcome: { outcome: 'selected', optionId: deny.optionId } } : { outcome: { outcome: 'cancelled' } });
  }
  if (skipPermissions) {
    const allow = options.find(o => o.kind === 'allow_once' && o.optionId);
    if (!allow) broadcastWorkflow(workflowId, { type: 'system_notice', workflowId, content: 'Antigravity offered no one-time approval; the request was declined.' });
    return Promise.resolve(allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } });
  }
  const gateId = randomUUID();
  const toolName = typeof tool.title === 'string' ? tool.title.slice(0, 256) : 'Antigravity tool';
  const args = tool.rawInput && typeof tool.rawInput === 'object' && !Array.isArray(tool.rawInput) ? tool.rawInput as Record<string, unknown> : {};
  return new Promise((resolve) => {
    pending.set(gateId, { workflowId, gateId, toolName, args, resolve, options });
    broadcastWorkflow(workflowId, { type: 'gate_required', workflowId, gateId, toolUseId: gateId, toolName, category: 'acp-permission', reason: 'Antigravity requests permission to run this tool.', proposedArgs: args, signature: gateId, createdAt: Date.now() });
  });
}

export function resolveAcpPermission(workflowId: string, gateId: string, decision: 'approve' | 'reject', edited: boolean): boolean {
  const entry = pending.get(gateId);
  if (!entry || entry.workflowId !== workflowId) return false;
  pending.delete(gateId);
  const allow = decision === 'approve' && !edited ? entry.options.find(o => o.kind === 'allow_once' && o.optionId) : undefined;
  const deny = entry.options.find(o => o.kind === 'reject_once' && o.optionId);
  const chosen = allow ?? deny;
  entry.resolve(chosen ? { outcome: { outcome: 'selected', optionId: chosen.optionId } } : { outcome: { outcome: 'cancelled' } });
  broadcastWorkflow(workflowId, { type: 'gate_resolved', workflowId, gateId, toolUseId: gateId, toolName: entry.toolName, decision: allow ? 'approve' : 'reject', wasEdited: false, liveArgsAtFire: entry.args, createdAt: Date.now() });
  return true;
}

export function cancelAcpPermissions(workflowId: string): void {
  for (const p of pending.values()) if (p.workflowId === workflowId) resolveAcpPermission(workflowId, p.gateId, 'reject', false);
}
