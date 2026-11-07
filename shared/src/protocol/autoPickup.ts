// Cluster AUTO-PICKUP modes and the Smart pickup limits (docs/PROTOCOL_CLUSTER.md).
//
// Off is the default. Rule-based uses deterministic acknowledgement, loop and budget guards. Smart: Observe-only asks an operator-chosen evaluator whether an
// idle member's waiting mail warrants a turn and only logs the answer. Smart:
// Automatic acts on that answer through the deterministic server gate. The
// evaluator only ever proposes wake, defer or ask for one recipient; server
// code owns every action, budget and limit.

export const AUTO_PICKUP_MODES = ['off', 'rule', 'smart-observe', 'smart-auto'] as const;
export type AutoPickupMode = typeof AUTO_PICKUP_MODES[number];

export const AUTO_PICKUP_MODE_LABELS: Record<AutoPickupMode, { label: string; chip: string }> = {
  off: { label: 'Off', chip: 'OFF' },
  rule: { label: 'Rule-based', chip: 'RULE' },
  'smart-observe': { label: 'Smart: Observe-only', chip: 'OBSERVE' },
  'smart-auto': { label: 'Smart: Automatic', chip: 'SMART' },
};

export function isAutoPickupMode(value: unknown): value is AutoPickupMode {
  return typeof value === 'string' && (AUTO_PICKUP_MODES as readonly string[]).includes(value);
}

export function isSmartPickupMode(mode: AutoPickupMode | undefined): mode is 'smart-observe' | 'smart-auto' {
  return mode === 'smart-observe' || mode === 'smart-auto';
}

// Modes that can start worker turns without an operator click.
export function autoPickupWakes(mode: AutoPickupMode | undefined): boolean {
  return mode === 'rule' || mode === 'smart-auto';
}

// Saved clusters from before the modes existed carry only the boolean.
export function resolveAutoPickupMode(mode: unknown, legacyEnabled: unknown): AutoPickupMode {
  if (isAutoPickupMode(mode)) return mode;
  return legacyEnabled === true ? 'rule' : 'off';
}

export const SMART_PICKUP_EVALUATOR_PROVIDERS = ['claude', 'codex', 'cursor', 'ollama', 'lmstudio', 'llamacpp', 'strata', 'deepseek'] as const;
export type SmartPickupEvaluatorProvider = typeof SMART_PICKUP_EVALUATOR_PROVIDERS[number];

export interface SmartPickupEvaluator {
  provider: SmartPickupEvaluatorProvider;
  model: string;
}

export const SMART_PICKUP_MODEL_MAX = 200;

export function sanitizeSmartPickupEvaluator(raw: unknown): SmartPickupEvaluator | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.provider !== 'string' || !(SMART_PICKUP_EVALUATOR_PROVIDERS as readonly string[]).includes(r.provider)) return null;
  if (typeof r.model !== 'string') return null;
  const model = r.model.trim();
  if (model.length === 0 || model.length > SMART_PICKUP_MODEL_MAX) return null;
  return { provider: r.provider as SmartPickupEvaluatorProvider, model };
}

export interface SmartPickupLimits {
  maxInFlight: number;
  callsPerClusterHour: number;
  callsPerMemberHour: number;
  wakesPerMemberHour: number;
  wakesPerSession: number;
  sessionMinutes: number;
  timeoutSeconds: number;
  maxInputBytes: number;
  maxOutputTokens: number;
}

export interface SmartPickupLimitSpec { default: number; min: number; max: number; label: string; unit: string }

export const SMART_PICKUP_LIMIT_SPECS: Record<keyof SmartPickupLimits, SmartPickupLimitSpec> = {
  maxInFlight: { default: 1, min: 1, max: 4, label: 'Evaluator requests at once in this cluster', unit: 'requests' },
  callsPerClusterHour: { default: 12, min: 1, max: 120, label: 'Evaluator requests per hour, whole cluster', unit: 'per hour' },
  callsPerMemberHour: { default: 3, min: 1, max: 60, label: 'Evaluator requests per hour, each member', unit: 'per hour' },
  wakesPerMemberHour: { default: 3, min: 1, max: 60, label: 'Automatic wakes per hour, each member', unit: 'per hour' },
  wakesPerSession: { default: 12, min: 1, max: 200, label: 'Automatic wakes per armed session', unit: 'wakes' },
  sessionMinutes: { default: 30, min: 5, max: 480, label: 'Armed session length', unit: 'minutes' },
  timeoutSeconds: { default: 30, min: 5, max: 120, label: 'Evaluator time limit', unit: 'seconds' },
  maxInputBytes: { default: 12288, min: 2048, max: 65536, label: 'Most mail and context sent per request', unit: 'bytes' },
  maxOutputTokens: { default: 64, min: 16, max: 512, label: 'Longest evaluator answer', unit: 'tokens' },
};

export const SMART_PICKUP_LIMIT_KEYS = Object.keys(SMART_PICKUP_LIMIT_SPECS) as (keyof SmartPickupLimits)[];

export const DEFAULT_SMART_PICKUP_LIMITS: SmartPickupLimits = Object.fromEntries(
  SMART_PICKUP_LIMIT_KEYS.map((k) => [k, SMART_PICKUP_LIMIT_SPECS[k].default]),
) as unknown as SmartPickupLimits;

// Whole numbers within each limit's bounds; anything missing or invalid reads
// as the default, so a hand-edited file can never raise a limit past its max.
export function sanitizeSmartPickupLimits(raw: unknown): SmartPickupLimits {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const out = { ...DEFAULT_SMART_PICKUP_LIMITS };
  for (const key of SMART_PICKUP_LIMIT_KEYS) {
    const spec = SMART_PICKUP_LIMIT_SPECS[key];
    const value = r[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max) out[key] = value;
  }
  return out;
}

export interface SmartPickupSession {
  id: string;
  armedAt: number;
  expiresAt: number;
}

export type SmartPickupAction = 'wake' | 'defer' | 'ask';

// Reasons an evaluator may give, plus the ones the server assigns without
// asking (empty, truncated, unverifiable).
export const SMART_PICKUP_REASONS = [
  'assignment', 'blocker', 'question', 'failure', 'completion',
  'ack_or_status', 'progress', 'superseded', 'stale', 'duplicate',
  'ambiguous', 'conflict', 'ownership', 'injection',
  'empty', 'truncated', 'unverifiable',
] as const;
export type SmartPickupReason = typeof SMART_PICKUP_REASONS[number];

// Whether a provider can serve as a Smart evaluator here, and why not.
export interface SmartPickupEvaluatorCapability {
  provider: SmartPickupEvaluatorProvider;
  available: boolean;
  reason?: string;
}

export interface SmartPickupDecisionRecord {
  at: number;
  recipientWorkflowId?: string;
  // The evaluator's proposal, or null when no proposal was made (an error,
  // a limit, or a disarm).
  action: SmartPickupAction | null;
  // Short machine reason, e.g. 'armed', 'disarmed', 'session_expired',
  // 'limit_calls_cluster_hour', 'evaluator_error'.
  reason: string;
  // What the server did with it: 'logged', 'woke', 'skipped', 'none'.
  outcome: string;
}

export interface SmartPickupCounters {
  inFlight: number;
  callsLastHour: number;
  callsThisSession: number;
  wakesLastHour: number;
  wakesThisSession: number;
}

export interface ClusterAutoPickupState {
  remindBusy?: boolean;
  mode: AutoPickupMode;
  limits: SmartPickupLimits;
  evaluator?: SmartPickupEvaluator;
  // The last explicitly chosen evaluator, offered again only while its
  // provider is still enabled and connected.
  lastEvaluator?: SmartPickupEvaluator;
  session?: SmartPickupSession;
  counters?: SmartPickupCounters;
  lastDecision?: SmartPickupDecisionRecord;
  ruleLimits?: RulePickupLimits;
  ruleStatus?: { wakes: number; budgetPaused: boolean; pausedPair?: [string, string]; ledgerUnavailable?: boolean };
}

// Operator sets the mode. Smart modes need an evaluator; limits are
// optional and default per SMART_PICKUP_LIMIT_SPECS.
export interface ClusterAutoPickupSetMessage {
  type: 'cluster_auto_pickup_set';
  clusterId: string;
  mode: AutoPickupMode;
  evaluator?: SmartPickupEvaluator;
  limits?: Partial<SmartPickupLimits>;
  ruleLimits?: Partial<RulePickupLimits>;
  resumeRule?: boolean;
  remindBusy?: boolean;
}

export interface RulePickupLimits {
  pingPongWakes: number;
  wakesPerMemberHour: number;
  wakesPerArming: number;
  maxChainDepth: number;
}

export const RULE_PICKUP_LIMIT_SPECS: Record<keyof RulePickupLimits, SmartPickupLimitSpec> = {
  pingPongWakes: { default: 4, min: 2, max: 10, label: 'Alternating wakes before pause', unit: 'wakes' },
  wakesPerMemberHour: { default: 6, min: 1, max: 30, label: 'Automatic wakes per member', unit: 'per hour' },
  wakesPerArming: { default: 40, min: 5, max: 200, label: 'Automatic wakes per arming', unit: 'wakes' },
  maxChainDepth: { default: 8, min: 1, max: 20, label: 'Maximum chain depth', unit: 'depth' },
};
export const RULE_PICKUP_LIMIT_KEYS = Object.keys(RULE_PICKUP_LIMIT_SPECS) as (keyof RulePickupLimits)[];
export const DEFAULT_RULE_PICKUP_LIMITS = Object.fromEntries(RULE_PICKUP_LIMIT_KEYS.map((key) => [key, RULE_PICKUP_LIMIT_SPECS[key].default])) as unknown as RulePickupLimits;

export function sanitizeRulePickupLimits(raw: unknown): RulePickupLimits {
  const values = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const result = { ...DEFAULT_RULE_PICKUP_LIMITS };
  for (const key of RULE_PICKUP_LIMIT_KEYS) {
    const spec = RULE_PICKUP_LIMIT_SPECS[key];
    const value = values[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max) result[key] = value;
  }
  return result;
}
