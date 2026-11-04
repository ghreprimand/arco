// docs/VOICE.md - the "Computer" voice operator. A projectless Chat
// tab with `voiceOperator: true` exposes only bounded operator tools.
// Codex carries one MCP child (`arco-voice`); Native/local APIs use the
// same definitions and relay. Tools execute in the browser that owns the
// hands-free session, through the same bounded VoiceExecutor actions the
// direct voice commands use. The server only relays.
export const VOICE_OPERATOR_TOOLS = [
  'arco_condition', 'arco_compact', 'arco_activity', 'arco_mail_rule', 'arco_watch', 'arco_usage', 'arco_computer', 'arco_targets', 'arco_select', 'arco_open_panel', 'arco_send_message',
  'arco_nudge', 'arco_cancel_turn', 'arco_read_latest', 'arco_read_recent', 'arco_status', 'arco_open', 'arco_open_dialog', 'arco_screen', 'arco_act', 'arco_read_text',
] as const;
export type VoiceOperatorTool = typeof VOICE_OPERATOR_TOOLS[number];
export const VOICE_TOOL_TIMEOUT_MS = 20_000;

export interface ComputerContextState {
  // Undefined uses the provider default (50% subscription, 75% local).
  resetAtPercent?: number | null;
  keepContext: boolean;
  resets: number;
  pendingFresh?: boolean;
  pendingFreshReason?: 'operator' | 'recovery';
  lastResetAt?: number;
  lastResetSeq?: number;
  lastResetReason?: 'operator' | 'threshold' | 'recovery';
  previousSessionId?: string;
}
export const DEFAULT_COMPUTER_RESET_PERCENT = 50;
export interface ComputerContextControlMessage {
  type: 'computer_context_control';
  workflowId: string;
  action: 'fresh' | 'configure';
  resetAtPercent?: number | null;
  keepContext?: boolean;
}
export interface ComputerContextUpdatedMessage {
  type: 'computer_context_updated';
  workflowId: string;
  state: ComputerContextState;
  fresh?: boolean;
  discardTranscript?: boolean;
  // Authoritative clean turn/queue boundary for provider/privacy switches.
  settled?: boolean;
}

export interface VoiceToolCallMessage {
  type: 'voice_tool_call';
  workflowId: string;        // the Computer chat whose model called the tool
  requestId: string;
  tool: VoiceOperatorTool;
  args: Record<string, string>;
}
export interface VoiceToolResultMessage {
  type: 'voice_tool_result';
  workflowId: string;
  requestId: string;
  ok: boolean;
  result?: string;           // spoken-style one-liner or JSON for arco_targets
  error?: string;
}
export function isVoiceOperatorTool(value: unknown): value is VoiceOperatorTool {
  return typeof value === 'string' && (VOICE_OPERATOR_TOOLS as readonly string[]).includes(value);
}

export const COMPUTER_PROVIDERS = ['codex', 'claude', 'ollama', 'strata'] as const;
export type ComputerProvider = typeof COMPUTER_PROVIDERS[number];
export function computerResetPercent(provider: string): number {
  return provider === 'ollama' || provider === 'strata' ? 75 : 50;
}

// Watches bind current busy generations, never a model's completion judgment.
export interface ComputerWatch {
  id: string;
  ownerId: string;
  label: string;
  targets: Array<{ id: string; name: string; status: 'working' | 'finished' | 'interrupted' | 'failed' }>;
  status: 'watching' | 'finished' | 'interrupted' | 'failed' | 'cancelled';
  createdAt: number;
  endedAt?: number;
  announcedAt?: number;
  private?: boolean;
}

// Operator-armed finite mailbox sequence; completion means final nudge sent.
export interface ComputerMailRule {
  id: string;
  ownerId: string;
  clusterId: string;
  label: string;
  memberIds: string[];
  workers: Array<{ id: string; name: string; nudges: number; lastNudgedAt?: number }>;
  finalId: string;
  finalName: string;
  status: 'watching' | 'finished' | 'cancelled' | 'interrupted' | 'failed' | 'expired' | 'limited';
  reason: string;
  createdAt: number;
  expiresAt: number;
  cooldownMs: number;
  maxNudgesPerWorker: number;
  paused?: boolean;
  endedAt?: number;
  announcedAt?: number;
  private?: boolean;
}

export type ComputerActivityKind = 'worker_started' | 'worker_finished' | 'worker_failed' | 'worker_interrupted' | 'worker_removed'
  | 'queue_changed' | 'mail_arrived' | 'mail_read' | 'mail_discarded' | 'cluster_changed' | 'condition_matched' | 'condition_stopped' | 'worker_state_changed'
  | 'worker_compaction_started' | 'worker_compaction_finished' | 'worker_compaction_failed';
export interface ComputerActivityEvent {
  id: string;
  at: number;
  kind: ComputerActivityKind;
  workflowId?: string;
  clusterId?: string;
  name?: string;
  detail?: string;
  ownerId?: string;
  private?: boolean;
}
export interface ComputerActivityPolicy {
  enabled: boolean;
  agentUpdates: 'off' | 'matches' | 'workers';
}
export interface ComputerActivityDelivery {
  id: string;
  ownerId: string;
  event: ComputerActivityEvent;
  status: 'queued' | 'delivering' | 'delivered' | 'failed' | 'interrupted' | 'cancelled';
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  reason?: string;
  private?: boolean;
}
export interface ComputerActivitySnapshot {
  policy: ComputerActivityPolicy;
  ledger: ComputerActivityEvent[];
  deliveries: ComputerActivityDelivery[];
  pending: number;
  updatesPerHour: number;
  updatesThisHour?: number;
  nextUpdateAt?: number;
  warning?: string;
}
export interface ComputerActivityChangedMessage {
  type: 'computer_activity_changed';
  workflowId: string;
  revision: number;
}
