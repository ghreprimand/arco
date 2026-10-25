// Model-authored declarations, evaluated against factual snapshots, never code.
export type ConditionField = 'busy' | 'queued' | 'pending_mail' | 'has_work' | 'needs_input' | 'turns_finished' | 'turns_failed' | 'turns_interrupted' | 'mail_received' | 'context_percent' | 'context_tokens' | 'context_window' | 'compacting' | 'can_compact' | 'compactions_finished';
export type ConditionComparison = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
export type ConditionExpression =
  | { op: 'all' | 'any'; conditions: ConditionExpression[] }
  | { op: 'not'; condition: ConditionExpression }
  | { op: 'worker'; worker_id: string; field: ConditionField; cmp: ConditionComparison; value: number | boolean }
  | { op: 'group'; worker_ids: string[]; quantifier: 'all' | 'any' | 'none'; field: ConditionField; cmp: ConditionComparison; value: number | boolean }
  | { op: 'count'; worker_ids: string[]; field: ConditionField; test: ConditionComparison; value: number | boolean; cmp: ConditionComparison; count: number };
export type ConditionAction =
  | { kind: 'nudge_mail'; worker_ids: string[] }
  | { kind: 'nudge'; worker_ids: string[] }
  | { kind: 'send_message'; worker_id: string; text: string }
  | { kind: 'compact'; worker_id: string }
  | { kind: 'notify'; text: string }
  | { kind: 'tool'; name: string; args: Record<string, string> };
export function conditionActionTargets(action:ConditionAction):string[]{
  if(action.kind==='nudge_mail'||action.kind==='nudge')return action.worker_ids;
  if(action.kind==='send_message'||action.kind==='compact')return [action.worker_id];
  return [];
}
export interface ComputerConditionDefinition {
  label: string;
  cluster_ids: string[];
  hold_on_input: boolean;
  hold_worker_ids?: string[];
  stop_on_error: boolean;
  stop_on_interrupt: boolean;
  clauses: Array<{ id: string; when: ConditionExpression; actions: ConditionAction[]; repeat: 'once' | 'changes';
    watch?: Array<{ worker_id: string; field: ConditionField }>; after?: string[]; finish?: boolean }>;
  // Null means no operator-imposed limit; counters still accumulate.
  ttl_minutes: number | null;
  max_actions: number | null;
  max_worker_turns: number | null;
  cooldown_seconds: number;
}
export interface ComputerConditionRule {
  id: string; ownerId: string; definition: ComputerConditionDefinition;
  members: Array<{ id: string; clusterId: string; name: string }>;
  status: 'watching' | 'finished' | 'cancelled' | 'failed' | 'interrupted' | 'expired' | 'limited';
  reason: string; createdAt: number; expiresAt: number | null; paused?: boolean; private?: boolean;
  actions: number; workerTurns: Record<string, { count: number; at: number }>;
  fired: string[]; executions: Record<string, string[]>; mailSeen: Record<string, string[]>;
  activated?: string[];
  revision?: number;
  announcements: Array<{ id: string; text: string; at: number; claimed?: boolean }>;
}
export interface ConditionWorkerFacts {
  id: string; clusterId: string; name: string; busy: boolean; queued: number; pending_mail: number;
  has_work: boolean; needs_input: boolean | null; turns_finished: number; turns_failed: number; turns_interrupted: number; mail_received: number;
  pendingIds: string[]; context_percent: number | null; context_tokens: number | null; context_window: number | null; compacting: boolean; can_compact: boolean | null; compactions_finished: number;
}
