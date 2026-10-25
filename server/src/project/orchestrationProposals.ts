// Durable proposal cache for operator-armed orchestration assist.
//
// The task ledger remains the mutation source of truth. This file stores the
// reviewable proposal objects and lifecycle actions so UI/smoke can preview,
// reject, and later replay proposal state without inventing hidden routing.

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  OrchestrationAssistKind,
  OrchestrationAssistModelRef,
  OrchestrationInputRef,
  OrchestrationProposal,
  OrchestrationProposalAction,
  OrchestrationProposalItem,
  OrchestrationProposalStatus,
} from '@archon/shared';
import { atomicWriteFile } from '../atomicFile.js';

const VERSION = 1;
const PROMPT_MAX = 16 * 1024;
const RATIONALE_MAX = 16 * 1024;
const RAW_JSON_MAX = 64 * 1024;
const PROPOSAL_MAX_ITEMS = 64;

const VALID_KIND = new Set<OrchestrationAssistKind>([
  'task_graph',
  'assignments',
  'swarm',
  'recovery',
  'synthesis',
]);

const VALID_STATUS = new Set<OrchestrationProposalStatus>([
  'proposed',
  'partially_accepted',
  'accepted',
  'rejected',
]);

interface ProposalFile {
  version: typeof VERSION;
  proposals: OrchestrationProposal[];
}

function projectDir(cwd: string): string {
  return path.join(cwd, '.archon', 'project');
}

function proposalsPath(cwd: string): string {
  return path.join(projectDir(cwd), 'orchestration-proposals.json');
}

function safeRaw(raw: unknown): unknown {
  if (raw === undefined) return undefined;
  try {
    const json = JSON.stringify(raw);
    if (json.length > RAW_JSON_MAX) return { truncated: true, byteLength: json.length };
    return JSON.parse(json);
  } catch {
    return String(raw).slice(0, RAW_JSON_MAX);
  }
}

function cleanRefs(refs: unknown): OrchestrationInputRef[] {
  if (!Array.isArray(refs)) return [];
  const out: OrchestrationInputRef[] = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') continue;
    const obj = ref as Partial<OrchestrationInputRef>;
    if (!obj.kind || !obj.ref || typeof obj.ref !== 'string') continue;
    if (!['plan', 'workflow', 'task', 'run', 'review', 'url', 'text'].includes(obj.kind)) continue;
    out.push({
      kind: obj.kind,
      ref: obj.ref.slice(0, 2048),
      ...(typeof obj.label === 'string' && obj.label.trim() ? { label: obj.label.trim().slice(0, 200) } : {}),
    });
  }
  return out.slice(0, 64);
}

function cleanModel(model: OrchestrationAssistModelRef): OrchestrationAssistModelRef {
  return {
    provider: model.provider,
    ...(typeof model.model === 'string' && model.model.trim() ? { model: model.model.trim() } : {}),
    ...(typeof model.effort === 'string' && model.effort.trim() ? { effort: model.effort } : {}),
    ...(typeof model.providerAccountRef === 'string' && model.providerAccountRef.trim()
      ? { providerAccountRef: model.providerAccountRef.trim() }
      : {}),
    ...(typeof model.memberWorkflowId === 'string' && model.memberWorkflowId.trim()
      ? { memberWorkflowId: model.memberWorkflowId.trim() }
      : {}),
  };
}

function cleanItem(item: OrchestrationProposalItem): OrchestrationProposalItem | null {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.trim()) return null;
  const id = item.id.trim().slice(0, 120);
  if (item.type === 'task_create') {
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, 500) : '';
    if (!title) return null;
    return { ...item, id, title };
  }
  if (item.type === 'task_update') {
    if (typeof item.taskId !== 'string' || !item.taskId.trim() || !item.patch || typeof item.patch !== 'object') return null;
    return { ...item, id, taskId: item.taskId.trim() };
  }
  if (item.type === 'task_comment') {
    if (typeof item.taskId !== 'string' || !item.taskId.trim()) return null;
    const body = typeof item.body === 'string' ? item.body.trim().slice(0, 32 * 1024) : '';
    if (!body) return null;
    return { ...item, id, taskId: item.taskId.trim(), body };
  }
  if (item.type === 'note') {
    const body = typeof item.body === 'string' ? item.body.trim().slice(0, 32 * 1024) : '';
    if (!body) return null;
    return { ...item, id, body };
  }
  return null;
}

function cleanProposal(proposal: OrchestrationProposal): OrchestrationProposal | null {
  if (!proposal || typeof proposal !== 'object') return null;
  if (!VALID_KIND.has(proposal.kind) || !VALID_STATUS.has(proposal.status)) return null;
  const items = (Array.isArray(proposal.items) ? proposal.items : [])
    .map(cleanItem)
    .filter((x): x is OrchestrationProposalItem => !!x)
    .slice(0, PROPOSAL_MAX_ITEMS);
  return {
    id: proposal.id,
    clusterId: proposal.clusterId,
    workflowId: proposal.workflowId,
    ...(typeof proposal.requestId === 'string' && proposal.requestId ? { requestId: proposal.requestId } : {}),
    kind: proposal.kind,
    status: proposal.status,
    prompt: proposal.prompt.slice(0, PROMPT_MAX),
    inputRefs: cleanRefs(proposal.inputRefs),
    model: cleanModel(proposal.model),
    items,
    ...(typeof proposal.rationale === 'string' && proposal.rationale.trim()
      ? { rationale: proposal.rationale.trim().slice(0, RATIONALE_MAX) }
      : {}),
    ...(proposal.raw !== undefined ? { raw: safeRaw(proposal.raw) } : {}),
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    ...(Array.isArray(proposal.acceptedItemIds) ? { acceptedItemIds: proposal.acceptedItemIds.filter((id) => typeof id === 'string') } : {}),
    ...(typeof proposal.rejectedAt === 'number' ? { rejectedAt: proposal.rejectedAt } : {}),
    actions: Array.isArray(proposal.actions) ? proposal.actions.filter(isAction) : [],
  };
}

function isAction(action: unknown): action is OrchestrationProposalAction {
  if (!action || typeof action !== 'object') return false;
  const obj = action as Partial<OrchestrationProposalAction>;
  return (
    (obj.action === 'requested' || obj.action === 'proposed' || obj.action === 'accepted' || obj.action === 'rejected')
    && typeof obj.workflowId === 'string'
    && typeof obj.at === 'number'
  );
}

export async function load(cwd: string): Promise<OrchestrationProposal[]> {
  if (!cwd) return [];
  let raw: string;
  try {
    raw = await fs.readFile(proposalsPath(cwd), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProposalFile>;
    if (!Array.isArray(parsed.proposals)) return [];
    return parsed.proposals
      .map((proposal) => cleanProposal(proposal))
      .filter((proposal): proposal is OrchestrationProposal => !!proposal)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function save(cwd: string, proposals: OrchestrationProposal[]): Promise<void> {
  if (!cwd) return;
  const file: ProposalFile = {
    version: VERSION,
    proposals: proposals
      .map((proposal) => cleanProposal(proposal))
      .filter((proposal): proposal is OrchestrationProposal => !!proposal)
      .sort((a, b) => b.updatedAt - a.updatedAt),
  };
  await atomicWriteFile(proposalsPath(cwd), JSON.stringify(file, null, 2) + '\n');
}

export function create(input: {
  clusterId: string;
  workflowId: string;
  requestId?: string;
  kind: OrchestrationAssistKind;
  prompt: string;
  inputRefs?: OrchestrationInputRef[];
  model: OrchestrationAssistModelRef;
  items?: OrchestrationProposalItem[];
  rationale?: string;
  raw?: unknown;
}): OrchestrationProposal {
  const now = Date.now();
  const requested: OrchestrationProposalAction = {
    action: 'requested',
    workflowId: input.workflowId,
    at: now,
  };
  const proposed: OrchestrationProposalAction = {
    action: 'proposed',
    workflowId: input.workflowId,
    at: now,
  };
  return cleanProposal({
    id: randomUUID(),
    clusterId: input.clusterId,
    workflowId: input.workflowId,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    kind: input.kind,
    status: 'proposed',
    prompt: input.prompt.slice(0, PROMPT_MAX),
    inputRefs: cleanRefs(input.inputRefs),
    model: cleanModel(input.model),
    items: (input.items ?? []).slice(0, PROPOSAL_MAX_ITEMS),
    ...(input.rationale ? { rationale: input.rationale.slice(0, RATIONALE_MAX) } : {}),
    ...(input.raw !== undefined ? { raw: safeRaw(input.raw) } : {}),
    createdAt: now,
    updatedAt: now,
    actions: [requested, proposed],
  })!;
}

export function withRejected(
  proposal: OrchestrationProposal,
  workflowId: string,
  reason?: string,
): OrchestrationProposal {
  const now = Date.now();
  return {
    ...proposal,
    status: 'rejected',
    rejectedAt: now,
    updatedAt: now,
    actions: [
      ...proposal.actions,
      {
        action: 'rejected',
        workflowId,
        at: now,
        ...(reason && reason.trim() ? { reason: reason.trim().slice(0, 2048) } : {}),
      },
    ],
  };
}

export function withAcceptedItems(
  proposal: OrchestrationProposal,
  workflowId: string,
  itemIds: string[],
  taskIds: string[],
): OrchestrationProposal {
  const now = Date.now();
  const accepted = [...new Set([...(proposal.acceptedItemIds ?? []), ...itemIds])];
  const status: OrchestrationProposalStatus = accepted.length >= proposal.items.length ? 'accepted' : 'partially_accepted';
  return {
    ...proposal,
    status,
    acceptedItemIds: accepted,
    updatedAt: now,
    actions: [
      ...proposal.actions,
      {
        action: 'accepted',
        workflowId,
        at: now,
        itemIds,
        taskIds,
      },
    ],
  };
}
