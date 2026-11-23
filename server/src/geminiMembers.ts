// docs/PROTOCOL_CLUSTER.md "Gemini members". A Gemini (Antigravity) cluster
// member takes a turn only from the operator's own action: NUDGE, or a message
// typed in its composer. Mail to it waits in its mailbox, where the operator
// may read, edit or cancel it before pressing NUDGE; the member then reads it
// with peer_read like any other member. Each operator action gets a
// single-use ticket bound to the member and the exact text, and
// handleUserMessage (ws/turnEngine.ts) starts a Gemini member turn only with
// a valid ticket, checked again when a queued message is taken. Automatic
// turns (AUTO-PICKUP, Smart pickup, busy reminders, task dispatch,
// broadcasts, CONTINUE DIRECTOR, timers, retries) carry no ticket and never
// start one.

import { createHash, randomUUID } from 'node:crypto';
import { buildMessageGuardPolicy } from '@arco/shared';
import * as clusterStore from './clusterStore.js';
import * as clusterEfficiency from './clusterEfficiency.js';
import { buildClusterDirectorDoctrine } from './clusterDirector.js';
import { buildProgressDoctrine } from './clusterProgress.js';
import { readClusterPlan } from './clusterPlanBridge.js';
import { researchDirectorDoctrine } from './research/researchDoctrine.js';
import { loadResearch } from './research/researchState.js';
import { workflows } from './server/state.js';
import { listSkills, buildSkillsManifest } from './skills.js';
import { gateProjectResources } from './projectTrust.js';

export const GEMINI_PROVIDER = 'antigravity-cli';
export const GEMINI_OPERATOR_ONLY_REFUSAL = 'A Gemini member turn starts only from your NUDGE or a message you type in its composer.';

export function isGeminiMember(workflowId: string): boolean {
  return workflows.get(workflowId)?.config.primaryProvider === GEMINI_PROVIDER
    && clusterStore.getClusterIdForWorkflow(workflowId) !== undefined;
}

// A queued message may wait behind a long turn; six hours bounds memory
// without expiring an operator message that is still waiting its turn.
const TICKET_TTL_MS = 6 * 60 * 60 * 1000;
const tickets = new Map<string, { workflowId: string; digest: string; expiresAt: number }>();

function digestOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function prune(now: number): void {
  for (const [id, t] of tickets) if (t.expiresAt <= now) tickets.delete(id);
}

// Called only from the operator's WebSocket user_message (NUDGE or typed
// message) for a Gemini member.
export function issueGeminiSend(workflowId: string, content: string, now = Date.now()): string {
  prune(now);
  const id = randomUUID();
  tickets.set(id, { workflowId, digest: digestOf(content), expiresAt: now + TICKET_TTL_MS });
  return id;
}

export function geminiSendValid(ticket: string | undefined, workflowId: string, content: string, now = Date.now()): boolean {
  if (!ticket) return false;
  const t = tickets.get(ticket);
  return !!t && t.expiresAt > now && t.workflowId === workflowId && t.digest === digestOf(content);
}

// Single use: a valid ticket is removed when its turn starts.
export function consumeGeminiSend(ticket: string | undefined, workflowId: string, content: string, now = Date.now()): boolean {
  if (!ticket || !geminiSendValid(ticket, workflowId, content, now)) return false;
  tickets.delete(ticket);
  return true;
}

// The member's role and the cluster's standing instructions, as visible text
// at the start of its first NUDGE. Nothing is added out of view.
export async function geminiClusterInstructions(clusterId: string, workflowId: string): Promise<string> {
  const role = clusterStore.getMemberRole(clusterId, workflowId);
  const guard = clusterStore.getMessageGuard(clusterId);
  const roleLine = role ? `Your role in this cluster: ${role}` : undefined;
  const mailLine = 'Read your mail with the peer_read tool when nudged, and reply with peer_send. The board and plan tools work as usual.';
  const parts = clusterStore.getMemberAccessMode(clusterId, workflowId) !== 'standard'
    ? [roleLine, buildMessageGuardPolicy(guard), mailLine]
    : [
      roleLine,
      clusterEfficiency.buildDoctrine(clusterStore.getEfficiencyLevel(clusterId), clusterStore.getEfficiencyAddendum(clusterId), role, guard),
      buildClusterDirectorDoctrine(role),
      (await loadResearch(clusterId).catch(() => null))?.directorWorkflowId === workflowId ? researchDirectorDoctrine() : undefined,
      buildProgressDoctrine(clusterStore.getProgressTracking(clusterId), !!(await readClusterPlan(clusterId).catch(() => null))?.body?.trim(), clusterStore.isTaskBoardAttached(clusterId)),
      mailLine,
    ];
  return parts.filter((part): part is string => !!part && part.trim().length > 0).join('\n\n');
}

// Each NUDGE asks the member to read its current plan and mail before acting.
// Before the first turn, the visible role instructions and skill list lead
// the message; later nudges keep the same reminder without repeating them.
export async function geminiNudgeText(workflowId: string, nudge: string): Promise<string> {
  const clusterId = clusterStore.getClusterIdForWorkflow(workflowId);
  const wf = workflows.get(workflowId);
  if (!clusterId || !wf) return nudge;
  const reminder = 'Read the current plan and your mail with peer_read before acting.';
  if (wf.primarySessionId) return `${reminder}\n\n${nudge}`;
  const instructions = await geminiClusterInstructions(clusterId, workflowId);
  const cwd = wf.config.workingDirectory;
  let skills = '';
  if (cwd) {
    const trust = await gateProjectResources(cwd).catch(() => ({ includeProject: false }));
    const catalog = await listSkills(cwd, { includeProject: trust.includeProject }).catch(() => null);
    if (catalog) skills = buildSkillsManifest(catalog);
  }
  return [instructions, skills, reminder, nudge].filter(part => part.trim()).join('\n\n---\n\n');
}
