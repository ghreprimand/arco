import { appendFile, mkdir } from 'fs/promises';
import { execFile } from 'child_process';
import { join } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { promisify } from 'util';
import type { WorkerConfig } from '@arco/shared';
import { antigravityManager } from './antigravityManager.js';
import { configuredAntigravityModelId } from './antigravityCapabilities.js';
import {
  ANTIGRAVITY_RPC_READONLY_DISCOVERY_METHODS,
  ANTIGRAVITY_RPC_TOOL_REGISTRATION_CANDIDATES,
} from './antigravityClusterBridge.js';

const execFileAsync = promisify(execFile);
const SERVICE = 'exa.language_server_pb.LanguageServerService';
const RPC_TIMEOUT_MS = 10 * 60_000;
const TOOL_STALL_MS = Number(process.env.ANTIGRAVITY_RPC_TOOL_TIMEOUT_MS ?? 45_000);
// Check at call time so tests can set ANTIGRAVITY_RPC_TRACE_STEPS=1 after import.
const traceEnabled = () => process.env.ANTIGRAVITY_RPC_TRACE_STEPS === '1';
// Full redacted raw-step dump for field-shape discovery. Distinct from the
// distilled trace above, which only writes a fixed set of known fields.
const traceRawEnabled = () => process.env.ANTIGRAVITY_RPC_TRACE_RAW === '1';

interface RpcEndpoint {
  pid: number;
  httpPort: number;
  csrfToken: string;
}

// Permission interaction shape within requestedInteraction.
interface PermissionShape {
  permissionType?: string;
  command?: string;
  path?: string;
  scope?: string;
  action?: string;
  detail?: string;
}

// Tool call result that Antigravity may put in metadata.
interface ToolCallMeta {
  id?: string;
  name?: string;
  argumentsJson?: string;
  result?: string;
}

// Shell-command output that may appear inside metadata alongside runCommand.
interface CommandOutputMeta {
  output?: string;
  exitCode?: number;
  error?: string;
}

// Typed observed step shapes from Phase A/B/C smokes. Unknown fields are kept as
// unknown so new Antigravity step shapes don't crash the poll loop.
interface PlannerStep {
  type?: string;
  status?: string;
  metadata?: {
    toolCall?: ToolCallMeta;
    commandOutput?: CommandOutputMeta;
    modelUsage?: {
      inputTokens?: string;
      outputTokens?: string;
      responseOutputTokens?: string;
      thinkingOutputTokens?: string;
      model?: string;
    };
    requestedModel?: { model?: string };
    generatorModel?: string;
    sourceTrajectoryStepInfo?: {
      trajectoryId?: string;
      stepIndex?: number;
      cascadeId?: string;
    };
  };
  plannerResponse?: {
    response?: string;
    modifiedResponse?: string;
    thinking?: string;
    toolCalls?: Array<{
      id?: string;
      name?: string;
      argumentsJson?: string;
    }>;
  };
  // Run-command steps: shell command details surfaced at the step level.
  runCommand?: {
    commandLine?: string;
    proposedCommandLine?: string;
    cwd?: string;
    shouldAutoRun?: boolean;
    blocking?: boolean;
    output?: string;
    exitCode?: number;
    exitStatus?: number;
  };
  // CORTEX_STEP_TYPE_VIEW_FILE: file path at step level. The live shape uses a
  // `file://` URI (`absolutePathUri`); the plain-path fields are legacy guesses.
  viewFile?: {
    absolutePathUri?: string;
    absolutePath?: string;
    path?: string;
    relativePath?: string;
    content?: string;
  };
  // CORTEX_STEP_TYPE_CODE_ACTION: code editing action at step level. The live
  // shape nests the target file URI under `actionSpec.command.file.absoluteUri`
  // (and echoes it in `actionResult.edit.absoluteUri`); the top-level
  // path/edits fields are legacy guesses kept as fallbacks.
  codeAction?: {
    toolName?: string;
    absolutePath?: string;
    path?: string;
    newContent?: string;
    oldContent?: string;
    actionSpec?: {
      command?: {
        file?: {
          absoluteUri?: string;
          workspaceUrisToRelativePaths?: Record<string, string>;
        };
      };
    };
    actionResult?: {
      edit?: { absoluteUri?: string };
    };
    edits?: Array<{
      absolutePath?: string;
      path?: string;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  // CORTEX_STEP_TYPE_SEARCH_WEB: web search at step level.
  searchWeb?: {
    query?: string;
    results?: unknown[];
  };
  // CORTEX_STEP_TYPE_LIST_DIRECTORY: directory path at step level as a `file://`
  // URI. The arg-level path is under PascalCase `DirectoryPath`.
  listDirectory?: {
    directoryPathUri?: string;
  };
  // CORTEX_STEP_TYPE_GREP_SEARCH: search root as a `file://` URI + the query at
  // step level. Arg-level keys are PascalCase `SearchPath` / `Query`.
  grepSearch?: {
    searchPathUri?: string;
    query?: string;
  };
  // Generated-image / file-output shapes are not yet observed in live
  // Antigravity trajectories. These guarded fields document the names we
  // inspect if they appear in a future trace; otherwise Phase F relies on
  // filesystem detection.
  generatedImage?: {
    path?: string;
    savedPath?: string;
    absolutePath?: string;
  };
  imageGeneration?: {
    path?: string;
    savedPath?: string;
    absolutePath?: string;
    result?: string;
  };
  fileOutput?: {
    path?: string;
    savedPath?: string;
    absolutePath?: string;
  };
  artifact?: {
    path?: string;
    savedPath?: string;
    absolutePath?: string;
  };
  // requestedInteraction appears on WAITING steps that need operator approval.
  requestedInteraction?: {
    permission?: PermissionShape | true | null;
    [key: string]: unknown;
  };
  error?: {
    shortError?: string;
    fullError?: string;
  };
  // Catch-all for unrecognised fields so new step shapes don't crash.
  [key: string]: unknown;
}

interface StepsResponse {
  steps?: PlannerStep[];
}

interface ModelsResponse {
  response?: {
    models?: Record<string, {
      displayName?: string;
      model?: string;
      maxTokens?: number;
      maxOutputTokens?: number;
    }>;
  };
}

export interface AntigravityRpcTurnResult {
  text: string;
  cascadeId: string;
  modelId: string;
  modelDisplayName: string;
  modelEnum: string;
  usage?: Record<string, number>;
  generatedFilePaths?: string[];
}

export interface AntigravityRpcMethodProbe {
  method: string;
  ok: boolean;
  httpStatus?: number;
  responseKeys?: string[];
  summary?: Record<string, unknown>;
  error?: string;
}

export interface AntigravityRpcSkippedMethodProbe {
  method: string;
  invoked: false;
  skipped: true;
  source: 'static_candidate';
  reason: string;
}

export interface AntigravityRpcToolBridgeProbe {
  endpoint: {
    pid: number;
    httpPort: number;
  };
  liveInvokedMethods: string[];
  readonlyMethods: AntigravityRpcMethodProbe[];
  registrationCandidates: AntigravityRpcSkippedMethodProbe[];
  mcpSurface: {
    methodsAvailable: string[];
    serverStateMethod: boolean;
    resourceMethod: boolean;
    promptMethod: boolean;
    settingsMentionMcp: boolean;
  };
  customToolRegistration: 'not_discovered_readonly_only';
  conclusion: string;
}

// Phase A smoke helper.
export async function probeAntigravityRpcModel(): Promise<{
  modelId: string;
  modelDisplayName: string;
  modelEnum: string;
  catalogModelIds: string[];
}> {
  const endpoint = await discoverEndpoint();
  const requested = configuredAntigravityModelId();
  const catalog = await callRpc<ModelsResponse>(endpoint, 'GetAvailableModels', { forceRefresh: false }, 30_000);
  const catalogModelIds = Object.keys(catalog.response?.models ?? {});
  const model = catalog.response?.models?.[requested];
  if (!model?.model) {
    throw new Error(`Antigravity RPC model "${requested}" not found in catalog (saw ${catalogModelIds.length} models).`);
  }
  return {
    modelId: requested,
    modelDisplayName: model.displayName ?? requested,
    modelEnum: model.model,
    catalogModelIds,
  };
}

// Ground-truth model label/enum from Antigravity's own GetAvailableModels
// catalog, cached so the auth-status hot path pays the RPC at most once per TTL.
// Returns {} on any failure (callers fall back to the hardcoded display label).
// IMPORTANT: only call when the desktop is already reachable — this resolves an
// endpoint via discoverEndpoint → ensureRunning, which would otherwise spawn the
// desktop on a routine diagnostics poll.
let catalogModelCache: { displayName?: string; modelEnum?: string; expiresAt: number } | null = null;
const CATALOG_MODEL_TTL_MS = 10 * 60_000;
const CATALOG_MODEL_FAIL_TTL_MS = 60_000;

export async function cachedConfiguredModelCatalog(): Promise<{ displayName?: string; modelEnum?: string }> {
  if (catalogModelCache && Date.now() < catalogModelCache.expiresAt) {
    return { displayName: catalogModelCache.displayName, modelEnum: catalogModelCache.modelEnum };
  }
  try {
    const r = await Promise.race([
      probeAntigravityRpcModel(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('catalog resolve timeout')), 5_000)),
    ]);
    catalogModelCache = { displayName: r.modelDisplayName, modelEnum: r.modelEnum, expiresAt: Date.now() + CATALOG_MODEL_TTL_MS };
    return { displayName: r.modelDisplayName, modelEnum: r.modelEnum };
  } catch {
    catalogModelCache = { expiresAt: Date.now() + CATALOG_MODEL_FAIL_TTL_MS };
    return {};
  }
}

function hasKeyDeep(value: unknown, needle: string, depth = 0): boolean {
  if (depth > 6 || value == null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => hasKeyDeep(v, needle, depth + 1));
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.toLowerCase().includes(needle.toLowerCase())) return true;
    if (hasKeyDeep(child, needle, depth + 1)) return true;
  }
  return false;
}

function countDeep(value: unknown, needle: string, depth = 0): number | undefined {
  if (depth > 6 || value == null || typeof value !== 'object') return undefined;
  let count = 0;
  let matched = false;
  if (Array.isArray(value)) {
    for (const child of value) {
      const n = countDeep(child, needle, depth + 1);
      if (n !== undefined) {
        matched = true;
        count += n;
      }
    }
    return matched ? count : undefined;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.toLowerCase().includes(needle.toLowerCase())) {
      matched = true;
      if (Array.isArray(child)) count += child.length;
      else if (child && typeof child === 'object') count += Object.keys(child).length;
      else count += 1;
    } else {
      const n = countDeep(child, needle, depth + 1);
      if (n !== undefined) {
        matched = true;
        count += n;
      }
    }
  }
  return matched ? count : undefined;
}

function summarizeProbeResponse(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const obj = body as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    topLevelKeys: Object.keys(obj).sort().slice(0, 12),
  };
  const templateCount = countDeep(body, 'templates');
  const stateCount = countDeep(body, 'states');
  const resourceCount = countDeep(body, 'resources');
  const promptCount = countDeep(body, 'prompts');
  if (templateCount !== undefined) summary.templateCount = templateCount;
  if (stateCount !== undefined) summary.stateCount = stateCount;
  if (resourceCount !== undefined) summary.resourceCount = resourceCount;
  if (promptCount !== undefined) summary.promptCount = promptCount;
  if (hasKeyDeep(body, 'mcp')) summary.mentionsMcp = true;
  if (hasKeyDeep(body, 'tool')) summary.mentionsTool = true;
  return summary;
}

async function probeRpcMethod(endpoint: RpcEndpoint, method: string, body: Record<string, unknown> = {}): Promise<AntigravityRpcMethodProbe> {
  try {
    const res = await fetch(`http://127.0.0.1:${endpoint.httpPort}/${SERVICE}/${method}`, {
      method: 'POST',
      headers: connectHeaders(endpoint.csrfToken),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!res.ok) {
      const message = parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message?: unknown }).message)
        : text;
      return {
        method,
        ok: false,
        httpStatus: res.status,
        error: redactString(message).slice(0, 240),
      };
    }
    const responseKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.keys(parsed as Record<string, unknown>).sort()
      : undefined;
    return {
      method,
      ok: true,
      httpStatus: res.status,
      ...(responseKeys ? { responseKeys } : {}),
      summary: summarizeProbeResponse(parsed),
    };
  } catch (err) {
    return {
      method,
      ok: false,
      error: redactString(err instanceof Error ? err.message : String(err)).slice(0, 240),
    };
  }
}

// Phase D discovery helper. Read-only probes intentionally summarize shape
// only: no process args, CSRF tokens, settings bodies, or MCP config contents
// are returned.
export async function probeAntigravityRpcToolBridge(): Promise<AntigravityRpcToolBridgeProbe> {
  const endpoint = await discoverEndpoint();
  const readonlyMethods: AntigravityRpcMethodProbe[] = [];
  for (const method of ANTIGRAVITY_RPC_READONLY_DISCOVERY_METHODS) {
    readonlyMethods.push(await probeRpcMethod(endpoint, method));
  }
  const registrationCandidates: AntigravityRpcSkippedMethodProbe[] =
    ANTIGRAVITY_RPC_TOOL_REGISTRATION_CANDIDATES.map((method) => ({
      method,
      invoked: false,
      skipped: true,
      source: 'static_candidate',
      reason: 'mutating-shaped registration/config methods are not called during Phase D read-only discovery',
    }));
  const methodsAvailable = readonlyMethods.filter((m) => m.ok).map((m) => m.method);
  const settings = readonlyMethods.find((m) => m.method === 'GetUserSettings');
  return {
    endpoint: {
      pid: endpoint.pid,
      httpPort: endpoint.httpPort,
    },
    liveInvokedMethods: readonlyMethods.map((m) => m.method),
    readonlyMethods,
    registrationCandidates,
    mcpSurface: {
      methodsAvailable,
      serverStateMethod: methodsAvailable.includes('GetMcpServerStates'),
      resourceMethod: methodsAvailable.includes('ListMcpResources'),
      promptMethod: methodsAvailable.includes('ListMcpPrompts'),
      settingsMentionMcp: settings?.summary?.mentionsMcp === true,
    },
    customToolRegistration: 'not_discovered_readonly_only',
    conclusion:
      'Phase D live discovery invoked only read-only RPC methods. Mutating-shaped registration/config candidates were reported as static skipped candidates; schema and side effects must be understood before any live call.',
  };
}

// ── Process / endpoint discovery ─────────────────────────────────────────────

function parseToken(args: string): string | null {
  const eq = args.match(/--csrf_token=([^\s]+)/);
  if (eq) return eq[1];
  const spaced = args.match(/--csrf_token\s+([^\s]+)/);
  return spaced?.[1] ?? null;
}

function parseLanguageServerProcesses(psOutput: string): Array<{ pid: number; args: string; csrfToken: string; workspace: boolean }> {
  const out: Array<{ pid: number; args: string; csrfToken: string; workspace: boolean }> = [];
  for (const line of psOutput.split('\n')) {
    if (!line.includes('language_server_linux_x64') || !line.includes('--csrf_token')) continue;
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const token = parseToken(match[2]);
    if (!token) continue;
    out.push({
      pid: Number(match[1]),
      args: match[2],
      csrfToken: token,
      workspace: match[2].includes('--enable_lsp'),
    });
  }
  return out.sort((a, b) => Number(b.workspace) - Number(a.workspace));
}

function parsePortsForPid(ssOutput: string, pid: number): number[] {
  const ports = new Set<number>();
  for (const line of ssOutput.split('\n')) {
    if (!line.includes(`pid=${pid},`)) continue;
    const match = line.match(/127\.0\.0\.1:(\d+)/);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports].sort((a, b) => a - b);
}

async function isHttpLanguageServerPort(port: number, csrfToken: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/${SERVICE}/GetStatus`, {
      method: 'POST',
      headers: connectHeaders(csrfToken),
      body: '{}',
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function discoverEndpoint(): Promise<RpcEndpoint> {
  await antigravityManager.ensureRunning();

  const [ps, ss] = await Promise.all([
    execFileAsync('ps', ['-eo', 'pid,args'], { maxBuffer: 1024 * 1024 }),
    execFileAsync('ss', ['-ltnp'], { maxBuffer: 1024 * 1024 }),
  ]);
  const processes = parseLanguageServerProcesses(ps.stdout);
  if (processes.length === 0) {
    throw new Error('No Antigravity language_server process with a CSRF token is running.');
  }

  for (const proc of processes) {
    for (const port of parsePortsForPid(ss.stdout, proc.pid)) {
      if (await isHttpLanguageServerPort(port, proc.csrfToken)) {
        return { pid: proc.pid, httpPort: port, csrfToken: proc.csrfToken };
      }
    }
  }
  throw new Error('Found Antigravity language_server processes, but no reachable HTTP Connect port accepted their CSRF token.');
}

function connectHeaders(csrfToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
    'x-codeium-csrf-token': csrfToken,
  };
}

async function callRpc<T>(
  endpoint: RpcEndpoint,
  method: string,
  body: Record<string, unknown>,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${endpoint.httpPort}/${SERVICE}/${method}`, {
    method: 'POST',
    headers: connectHeaders(endpoint.csrfToken),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      message = parsed.message ?? text;
    } catch { /* plain text */ }
    throw new Error(`Antigravity RPC ${method} failed: ${message}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

async function resolveModel(endpoint: RpcEndpoint): Promise<{ modelId: string; modelDisplayName: string; modelEnum: string }> {
  const requested = configuredAntigravityModelId();
  const catalog = await callRpc<ModelsResponse>(endpoint, 'GetAvailableModels', { forceRefresh: false }, 30_000);
  const model = catalog.response?.models?.[requested];
  if (!model?.model) {
    const available = Object.keys(catalog.response?.models ?? {})
      .filter((id) => id.includes('gemini-3') || id.includes('gemini-pro'))
      .sort()
      .join(', ');
    throw new Error(`Antigravity RPC model "${requested}" not found. Available Gemini agent models: ${available}`);
  }
  return { modelId: requested, modelDisplayName: model.displayName ?? requested, modelEnum: model.model };
}

async function startCascade(endpoint: RpcEndpoint, cwd?: string): Promise<string> {
  const workspaceUris = cwd ? [pathToFileURL(cwd).href] : undefined;
  const res = await callRpc<{ cascadeId?: string }>(endpoint, 'StartCascade', {
    ...(workspaceUris ? { workspaceUris } : {}),
    source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
    trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
  }, 30_000);
  if (!res.cascadeId) throw new Error('Antigravity RPC StartCascade returned no cascadeId.');
  return res.cascadeId;
}

async function getSteps(endpoint: RpcEndpoint, cascadeId: string): Promise<PlannerStep[]> {
  const res = await callRpc<StepsResponse>(endpoint, 'GetCascadeTrajectorySteps', {
    cascadeId,
    stepOffset: 0,
  }, 30_000);
  return res.steps ?? [];
}

function extractLatestPlannerResponse(steps: PlannerStep[], baselineCount: number): PlannerStep | null {
  const candidates = steps.slice(baselineCount).filter((step) => {
    const text = step.plannerResponse?.modifiedResponse ?? step.plannerResponse?.response;
    // A planner response that still carries toolCalls is mid-agent-loop (the
    // model is about to act), not the final answer — even when it also includes
    // narration text. Returning on such a step ends the turn at a preamble like
    // "I will begin by listing...". Only a DONE response with text AND no
    // pending toolCalls is terminal.
    const hasToolCalls = (step.plannerResponse?.toolCalls?.length ?? 0) > 0;
    return step.status === 'CORTEX_STEP_STATUS_DONE' && !!text && !hasToolCalls;
  });
  return candidates[candidates.length - 1] ?? null;
}

function usageFromStep(step: PlannerStep): Record<string, number> | undefined {
  const usage = step.metadata?.modelUsage;
  if (!usage) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    responseOutputTokens: usage.responseOutputTokens,
    thinkingOutputTokens: usage.thinkingOutputTokens,
  })) {
    const parsed = value ? Number(value) : NaN;
    if (Number.isFinite(parsed)) out[key] = parsed;
  }
  return Object.keys(out).length ? out : undefined;
}

function maybeLocalPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const s = value.trim();
  if (s.startsWith('/')) return s;
  if (s.startsWith('file://')) {
    try {
      const url = new URL(s);
      return url.pathname || null;
    } catch {
      return null;
    }
  }
  return null;
}

function collectGeneratedFilePaths(steps: PlannerStep[], baselineCount: number): string[] {
  const out = new Set<string>();
  for (const step of steps.slice(baselineCount)) {
    const shaped = [
      step.generatedImage,
      step.imageGeneration,
      step.fileOutput,
      step.artifact,
    ];
    for (const obj of shaped) {
      if (!obj || typeof obj !== 'object') continue;
      for (const key of ['savedPath', 'absolutePath', 'path', 'result'] as const) {
        const p = maybeLocalPath((obj as Record<string, unknown>)[key]);
        if (p) out.add(p);
      }
    }
  }
  return [...out];
}

// ── Step → Arco Activity normalization ──────────────────────────────────────

// Non-tool step types that should never surface in Activity.
const SKIP_STEP_TYPES = new Set([
  'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
  'CORTEX_STEP_TYPE_USER_INPUT',
  'CORTEX_STEP_TYPE_CONVERSATION_HISTORY',
  'CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE',
  'CORTEX_STEP_TYPE_CHECKPOINT',
]);

// Maps Antigravity tool names to Arco Activity display names.
const TOOL_NAME_MAP: Record<string, string> = {
  run_command: 'Bash',
  bash: 'Bash',
  shell: 'Bash',
  execute: 'Bash',
  search_web: 'WebSearch',
  web_search: 'WebSearch',
  search: 'WebSearch',
  read_file: 'ReadFile',
  view_file: 'ReadFile',
  open_file: 'ReadFile',
  cat: 'ReadFile',
  write_file: 'WriteFile',
  create_file: 'WriteFile',
  replace_file: 'WriteFile',
  replace_file_content: 'WriteFile',
  edit_file: 'WriteFile',
  patch_file: 'WriteFile',
  str_replace_editor: 'WriteFile',
  list_dir: 'ListDir',
  list_files: 'ListDir',
  ls: 'ListDir',
  find_files: 'FindFiles',
  glob: 'FindFiles',
  find: 'FindFiles',
  grep: 'Grep',
  ripgrep: 'Grep',
  search_code: 'Grep',
};

function toolStatus(status?: string): 'started' | 'in_progress' | 'completed' | 'failed' {
  if (status === 'CORTEX_STEP_STATUS_DONE') return 'completed';
  if (status === 'CORTEX_STEP_STATUS_ERROR' || status === 'CORTEX_STEP_STATUS_CANCELED') return 'failed';
  if (status === 'CORTEX_STEP_STATUS_WAITING' || status === 'CORTEX_STEP_STATUS_RUNNING') return 'in_progress';
  return 'started';
}

function toolNameFromStep(step: PlannerStep): string {
  const rawName = step.metadata?.toolCall?.name ?? step.codeAction?.toolName;
  if (rawName) return TOOL_NAME_MAP[rawName.toLowerCase()] ?? rawName;
  if (step.runCommand?.commandLine !== undefined) return 'Bash';
  if (step.type === 'CORTEX_STEP_TYPE_VIEW_FILE') return 'ReadFile';
  if (step.type === 'CORTEX_STEP_TYPE_CODE_ACTION') return 'WriteFile';
  if (step.type === 'CORTEX_STEP_TYPE_SEARCH_WEB') return 'WebSearch';
  if (step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND') return 'Bash';
  return step.type?.replace(/^CORTEX_STEP_TYPE_/, '').toLowerCase() ?? 'antigravity_tool';
}

function isCommandProgressStep(step: PlannerStep): boolean {
  const rawName = (step.metadata?.toolCall?.name ?? step.codeAction?.toolName ?? '').toLowerCase();
  return step.type === 'CORTEX_STEP_TYPE_COMMAND_STATUS'
    || step.type === 'CORTEX_STEP_TYPE_SEND_COMMAND_INPUT'
    || rawName === 'command_status'
    || rawName === 'send_command_input';
}

function hasLaterCommandProgress(steps: PlannerStep[], index: number): boolean {
  return steps.slice(index + 1).some(isCommandProgressStep);
}

function toolIdFromStep(step: PlannerStep, index: number): string {
  return step.metadata?.toolCall?.id
    ?? `${step.metadata?.sourceTrajectoryStepInfo?.cascadeId ?? 'antigravity'}:${step.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? index}`;
}

// Convert an Antigravity `file://` URI to a plain filesystem path. Falls back
// to the raw string for non-file URIs or anything that doesn't parse.
function fileUriToPath(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  if (!uri.startsWith('file:')) return uri;
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

// Resolve the target file path for VIEW_FILE / CODE_ACTION steps from the live
// step shapes, preferring URI fields and falling back to legacy plain-path
// guesses.
function viewFilePath(step: PlannerStep): string | undefined {
  return fileUriToPath(step.viewFile?.absolutePathUri)
    ?? step.viewFile?.absolutePath ?? step.viewFile?.path ?? step.viewFile?.relativePath;
}

function codeActionPath(step: PlannerStep): string | undefined {
  return fileUriToPath(step.codeAction?.actionSpec?.command?.file?.absoluteUri)
    ?? fileUriToPath(step.codeAction?.actionResult?.edit?.absoluteUri)
    ?? step.codeAction?.absolutePath ?? step.codeAction?.path
    ?? step.codeAction?.edits?.[0]?.absolutePath ?? step.codeAction?.edits?.[0]?.path;
}

function listDirPath(step: PlannerStep): string | undefined {
  return fileUriToPath(step.listDirectory?.directoryPathUri);
}

function grepSearchPath(step: PlannerStep): string | undefined {
  return fileUriToPath(step.grepSearch?.searchPathUri);
}

// Find a file-path-like value in a tool-call args object. Antigravity uses
// PascalCase keys (`AbsolutePath` for view_file, `TargetFile` for
// replace_file_content) alongside the snake_case names other tools use, so the
// lookup is case-insensitive over a broad key set.
function pathFromArgs(args: Record<string, unknown>): string | undefined {
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) lower[k.toLowerCase()] = v;
  const keys = [
    'path', 'file_path', 'filepath', 'filename', 'absolutepath', 'absolute_path',
    'targetfile', 'target_file', 'targetpath', 'file', 'directory', 'directorypath',
    'searchpath', 'search_path', 'dir',
  ];
  for (const k of keys) {
    const v = lower[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

// Case-insensitive query lookup — Antigravity uses PascalCase `Query` for
// grep_search alongside the snake_case keys other search tools use.
function queryFromArgs(args: Record<string, unknown>): string | undefined {
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) lower[k.toLowerCase()] = v;
  for (const k of ['query', 'q', 'search_query', 'pattern']) {
    const v = lower[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

// Extract a meaningful, non-bulky input summary from the step.
function toolInputFromStep(step: PlannerStep): string {
  const argsJson = step.metadata?.toolCall?.argumentsJson;
  const rawName = (step.metadata?.toolCall?.name ?? step.codeAction?.toolName ?? '').toLowerCase();

  if (argsJson) {
    try {
      const args = JSON.parse(argsJson) as Record<string, unknown>;
      if (/search_web|web_search/.test(rawName)) {
        const query = args.query ?? args.q ?? args.search_query;
        return JSON.stringify({ query });
      }
      if (/read|view|open|cat/.test(rawName)) {
        const path = pathFromArgs(args) ?? viewFilePath(step);
        return JSON.stringify({ path: path ?? null });
      }
      if (/write|create|replace|edit|patch|str_replace/.test(rawName)) {
        const path = pathFromArgs(args) ?? codeActionPath(step);
        return JSON.stringify({ path: path ?? null });
      }
      if (/list|find|glob|grep|search_code|ripgrep/.test(rawName)) {
        const path = pathFromArgs(args) ?? listDirPath(step) ?? grepSearchPath(step);
        const query = queryFromArgs(args) ?? step.grepSearch?.query;
        return JSON.stringify({ path: path ?? null, ...(query ? { query } : {}) });
      }
      return argsJson;
    } catch {
      return argsJson;
    }
  }

  // Step-level path fields for VIEW_FILE and CODE_ACTION step types.
  if (step.type === 'CORTEX_STEP_TYPE_VIEW_FILE') {
    return JSON.stringify({ path: viewFilePath(step) ?? null });
  }
  if (step.type === 'CORTEX_STEP_TYPE_CODE_ACTION') {
    return JSON.stringify({ tool: step.codeAction?.toolName, path: codeActionPath(step) ?? null });
  }
  if (step.type === 'CORTEX_STEP_TYPE_LIST_DIRECTORY') {
    return JSON.stringify({ path: listDirPath(step) ?? null });
  }
  if (step.type === 'CORTEX_STEP_TYPE_GREP_SEARCH') {
    return JSON.stringify({ path: grepSearchPath(step) ?? null, ...(step.grepSearch?.query ? { query: step.grepSearch.query } : {}) });
  }
  if (step.type === 'CORTEX_STEP_TYPE_SEARCH_WEB') {
    return JSON.stringify({ query: step.searchWeb?.query });
  }

  if (step.runCommand?.commandLine) {
    return JSON.stringify({
      command: step.runCommand.commandLine,
      ...(step.runCommand.cwd ? { cwd: step.runCommand.cwd } : {}),
    });
  }
  return '{}';
}

// Extract output/result summary from the step. Keeps blobs small.
function toolOutputFromStep(step: PlannerStep): string | undefined {
  if (step.error?.shortError) return `error: ${step.error.shortError}`;

  const result = step.metadata?.toolCall?.result;
  if (result) {
    try {
      const parsed = JSON.parse(result) as Record<string, unknown>;
      const exitCode = parsed.exitCode ?? parsed.exit_code;
      if (exitCode !== undefined) {
        const out = typeof parsed.output === 'string' ? parsed.output.slice(0, 400) : undefined;
        return JSON.stringify({ exitCode, ...(out ? { output: out } : {}) });
      }
      return result.slice(0, 400);
    } catch {
      return result.slice(0, 400);
    }
  }

  // Shell exit code from runCommand when present.
  const rc = step.runCommand?.exitCode ?? step.runCommand?.exitStatus;
  if (rc !== undefined) {
    const out = step.runCommand?.output;
    return JSON.stringify({ exitCode: rc, ...(out ? { output: out.slice(0, 400) } : {}) });
  }

  // Command output from metadata.
  const cmdOut = step.metadata?.commandOutput;
  if (cmdOut?.exitCode !== undefined || cmdOut?.output) {
    return JSON.stringify({
      ...(cmdOut.exitCode !== undefined ? { exitCode: cmdOut.exitCode } : {}),
      ...(cmdOut.output ? { output: cmdOut.output.slice(0, 400) } : {}),
    });
  }

  return undefined;
}

// ── Redaction ─────────────────────────────────────────────────────────────────

function redactString(s: string): string {
  return s
    // Authorization header and standalone Bearer tokens.
    .replace(/Authorization:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer [REDACTED]')
    // CSRF tokens.
    .replace(/x-codeium-csrf-token[=:\s]+\S+/gi, 'x-codeium-csrf-token=[REDACTED]')
    .replace(/--csrf_token[=\s]+\S+/g, '--csrf_token=[REDACTED]')
    .replace(/csrf_token[=:\s]+\S+/gi, 'csrf_token=[REDACTED]')
    // Common env-var-style secrets: *_API_KEY=, TOKEN=, SECRET=, PASSWORD=.
    .replace(/(\b\w*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)\S+/gi, '$1[REDACTED]')
    // URLs with embedded credentials: https://user:pass@host.
    .replace(/(https?:\/\/)[^@\s/]+:[^@\s/]+@/gi, '$1[REDACTED]@');
}

// Redact a string-typed trace field, or return undefined if the input is undefined.
function redactField(s: string | undefined): string | undefined {
  return s != null ? redactString(s) : undefined;
}

// ── Debug trace ───────────────────────────────────────────────────────────────

interface TraceEntry {
  cascadeId: string;
  stepIndex: number;
  type: string | undefined;
  status: string | undefined;
  toolName: string | undefined;
  toolId: string | undefined;
  command: string | undefined;
  path: string | undefined;
  query: string | undefined;
  interactionKind: string | undefined;
}

function buildTraceEntry(step: PlannerStep, index: number, cascadeId: string): TraceEntry {
  const rawName = step.metadata?.toolCall?.name ?? step.codeAction?.toolName;
  let path: string | undefined;
  let query: string | undefined;
  let command: string | undefined;

  if (step.metadata?.toolCall?.argumentsJson) {
    try {
      const args = JSON.parse(step.metadata.toolCall.argumentsJson) as Record<string, unknown>;
      path = pathFromArgs(args);
      query = queryFromArgs(args);
    } catch { /* ok */ }
  }
  // Step-level path for VIEW_FILE / CODE_ACTION / LIST_DIRECTORY / GREP_SEARCH.
  if (!path) {
    path = viewFilePath(step) ?? codeActionPath(step) ?? listDirPath(step) ?? grepSearchPath(step);
  }
  if (!query) {
    query = step.grepSearch?.query ?? (step.type === 'CORTEX_STEP_TYPE_SEARCH_WEB' ? step.searchWeb?.query : undefined);
  }
  if (step.runCommand?.commandLine) command = step.runCommand.commandLine;

  let interactionKind: string | undefined;
  if (step.requestedInteraction) {
    const perm = step.requestedInteraction.permission;
    if (perm && typeof perm === 'object' && !Array.isArray(perm)) {
      const p = perm as PermissionShape;
      interactionKind = p.permissionType ?? p.action ?? 'permission';
    } else if (perm) {
      interactionKind = 'permission';
    } else {
      interactionKind = Object.keys(step.requestedInteraction).filter((k) => k !== 'permission')[0];
    }
  }

  return {
    cascadeId,
    stepIndex: step.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? index,
    type: step.type,
    status: step.status,
    toolName: rawName,
    toolId: step.metadata?.toolCall?.id ?? step.metadata?.sourceTrajectoryStepInfo?.stepIndex?.toString(),
    command: redactField(command),
    path: redactField(path),
    query: redactField(query),
    interactionKind,
  };
}

async function traceStepToFile(
  entry: TraceEntry,
  traceFile: string,
  traceDir: string,
  dirCreated: { done: boolean },
): Promise<void> {
  try {
    if (!dirCreated.done) {
      await mkdir(traceDir, { recursive: true });
      dirCreated.done = true;
    }
    await appendFile(traceFile, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Trace failure must never abort a turn.
  }
}

// Full redacted raw step JSON for shape discovery (ANTIGRAVITY_RPC_TRACE_RAW=1).
// Each line is { stepIndex, raw } where `raw` is the redacted step object, with
// bulky content fields truncated so the dump stays inspectable.
async function traceRawStepToFile(
  step: PlannerStep,
  index: number,
  rawFile: string,
  traceDir: string,
  dirCreated: { done: boolean },
): Promise<void> {
  try {
    if (!dirCreated.done) {
      await mkdir(traceDir, { recursive: true });
      dirCreated.done = true;
    }
    const line = redactString(JSON.stringify({ stepIndex: index, raw: step })).slice(0, 20_000);
    await appendFile(rawFile, line + '\n', 'utf8');
  } catch {
    // Trace failure must never abort a turn.
  }
}

// ── Activity emission ─────────────────────────────────────────────────────────

type ToolUseCallback = (data: {
  id?: string;
  name: string;
  input: string;
  status?: 'started' | 'in_progress' | 'completed' | 'failed';
  output?: string;
  exitCode?: number;
}) => void;

// Extract a numeric exit code from the step using all known locations.
function exitCodeFromStep(step: PlannerStep): number | undefined {
  // Prefer metadata.toolCall.result (parsed JSON exitCode / exit_code).
  const result = step.metadata?.toolCall?.result;
  if (result) {
    try {
      const parsed = JSON.parse(result) as Record<string, unknown>;
      const code = parsed.exitCode ?? parsed.exit_code;
      if (typeof code === 'number') return code;
    } catch { /* ignore */ }
  }
  // runCommand step-level fields.
  if (typeof step.runCommand?.exitCode === 'number') return step.runCommand.exitCode;
  if (typeof step.runCommand?.exitStatus === 'number') return step.runCommand.exitStatus;
  // metadata.commandOutput.
  if (typeof step.metadata?.commandOutput?.exitCode === 'number') return step.metadata.commandOutput.exitCode;
  return undefined;
}

function emitToolActivity(
  step: PlannerStep,
  index: number,
  emitted: Map<string, string>,
  onToolUse?: ToolUseCallback,
): void {
  if (!onToolUse) return;
  if (!step.type || SKIP_STEP_TYPES.has(step.type)) return;
  if (!step.type.startsWith('CORTEX_STEP_TYPE_')) return;

  const id = toolIdFromStep(step, index);
  const status = toolStatus(step.status);
  const output = toolOutputFromStep(step);
  const exitCode = exitCodeFromStep(step);
  const signature = `${status}:${output ?? ''}`;
  if (emitted.get(id) === signature) return;
  emitted.set(id, signature);

  onToolUse({
    id,
    name: toolNameFromStep(step),
    input: toolInputFromStep(step),
    status,
    ...(output !== undefined ? { output } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  });
}

// Emit or update a permission-request row. Uses a stable "perm:<id>" key so it
// merges with subsequent approval updates rather than duplicating.
function emitPermissionRow(
  step: PlannerStep,
  index: number,
  status: 'in_progress' | 'completed',
  emitted: Map<string, string>,
  onToolUse?: ToolUseCallback,
  approvedBy?: string,
): void {
  if (!onToolUse) return;
  const id = `perm:${toolIdFromStep(step, index)}`;
  const toolLabel = toolNameFromStep(step);
  const cmdOrTool = step.runCommand?.commandLine ?? step.metadata?.toolCall?.name ?? 'tool';
  const output = status === 'completed' ? `approved (${approvedBy ?? 'auto'})` : undefined;
  const signature = `${status}:${output ?? ''}`;
  if (status === 'in_progress' && emitted.get(id)?.startsWith('completed:')) return;
  if (emitted.get(id) === signature) return;
  emitted.set(id, signature);
  onToolUse({
    id,
    name: `PermissionRequest`,
    input: JSON.stringify({ tool: toolLabel, request: cmdOrTool }),
    status,
    ...(output ? { output } : {}),
  });
}

// Emit a stall-state row exactly once per stable key.
function emitStallRow(
  id: string,
  stallKind: 'waiting_permission' | 'waiting_unbridged_tool' | 'timed_out',
  detail: string,
  emitted: Map<string, string>,
  onToolUse?: ToolUseCallback,
): void {
  if (!onToolUse) return;
  const key = `stall:${id}`;
  const signature = `${stallKind}:${detail}`;
  if (emitted.get(key) === signature) return;
  emitted.set(key, signature);
  onToolUse({
    id: key,
    name: stallKind,
    input: JSON.stringify({ detail }),
    status: stallKind === 'timed_out' ? 'failed' : 'in_progress',
  });
}

// ── Permission approval ───────────────────────────────────────────────────────

async function approvePermissionInteraction(endpoint: RpcEndpoint, cascadeId: string, step: PlannerStep): Promise<void> {
  const info = step.metadata?.sourceTrajectoryStepInfo;
  if (!info?.trajectoryId || typeof info.stepIndex !== 'number') return;
  await callRpc(endpoint, 'HandleCascadeUserInteraction', {
    cascadeId,
    interaction: {
      trajectoryId: info.trajectoryId,
      stepIndex: info.stepIndex,
      permission: {
        allow: true,
        scope: 'PERMISSION_SCOPE_WORKSPACE',
      },
    },
  }, 10_000);
}

// ── Main turn entry point ─────────────────────────────────────────────────────

export async function runAntigravityRpcTurn(
  prompt: string,
  config: WorkerConfig,
  onInit: (data: { model?: string; sessionId?: string }) => void,
  isAborted: () => boolean,
  onToolUse?: ToolUseCallback,
  onSystemNotice?: (notice: string) => void,
): Promise<AntigravityRpcTurnResult> {
  const endpoint = await discoverEndpoint();
  const { modelId, modelDisplayName, modelEnum } = await resolveModel(endpoint);
  const cascadeId = config.resumeSessionId || await startCascade(endpoint, config.cwd);
  onInit({ model: `antigravity-rpc (${modelDisplayName})`, sessionId: cascadeId });

  // The baseline marks where THIS turn's steps start. Defaulting a failed
  // read to [] on a resumed cascade counted every historical step as new and
  // returned the previous answer as this turn's reply. Retry once; on a
  // resumed cascade a second failure fails the turn (a fresh cascade really
  // is empty, so [] stays correct there).
  let baseline: PlannerStep[];
  try {
    baseline = await getSteps(endpoint, cascadeId);
  } catch {
    if (isAborted()) throw new Error('cancelled');
    try {
      baseline = await getSteps(endpoint, cascadeId);
    } catch (err) {
      if (config.resumeSessionId) {
        throw new Error(`Antigravity: could not read the resumed cascade's existing steps (${err instanceof Error ? err.message : String(err)}); not sending the turn`);
      }
      baseline = [];
    }
  }
  if (isAborted()) throw new Error('cancelled');

  await callRpc(endpoint, 'SendUserCascadeMessage', {
    cascadeId,
    items: [{ text: prompt }],
    blocking: false,
    cascadeConfig: {
      plannerConfig: {
        conversational: { agenticMode: true },
        requestedModel: { model: modelEnum },
        planModel: modelEnum,
        modelName: modelId,
      },
    },
  });
  if (isAborted()) throw new Error('cancelled');

  // Trace-file setup (no-op when TRACE_STEPS is false or cwd/workflowId missing).
  const wfId = config.workflowId;
  const traceDir = config.cwd && wfId
    ? join(config.cwd, '.arco', 'workflows', wfId, 'debug')
    : null;
  const traceFile = traceDir ? join(traceDir, 'antigravity-rpc-steps.jsonl') : null;
  const rawTraceFile = traceDir ? join(traceDir, 'antigravity-rpc-steps-raw.jsonl') : null;
  const dirCreated = { done: false };
  const tracedIndices = new Set<number>();
  if (traceEnabled() && traceFile) {
    onSystemNotice?.(`[ANTIGRAVITY RPC] step trace: ${traceFile}`);
  }
  if (traceRawEnabled() && rawTraceFile) {
    onSystemNotice?.(`[ANTIGRAVITY RPC] raw step trace: ${rawTraceFile}`);
  }

  const deadline = Date.now() + RPC_TIMEOUT_MS;
  const emittedTools = new Map<string, string>();
  const approvedPermissionSteps = new Set<string>();
  const waitingSince = new Map<string, number>();

  while (Date.now() < deadline) {
    const steps = await getSteps(endpoint, cascadeId);

    for (const [index, candidate] of steps.entries()) {
      if (index < baseline.length) continue;

      // Debug trace — write each new step once.
      if (traceEnabled() && traceFile && traceDir && !tracedIndices.has(index)) {
        const entry = buildTraceEntry(candidate, index, cascadeId);
        void traceStepToFile(entry, traceFile, traceDir, dirCreated);
      }
      if (traceRawEnabled() && rawTraceFile && traceDir && !tracedIndices.has(index)) {
        void traceRawStepToFile(candidate, index, rawTraceFile, traceDir, dirCreated);
      }
      if ((traceEnabled() || traceRawEnabled()) && !tracedIndices.has(index)) {
        tracedIndices.add(index);
      }

      // Standard tool activity row.
      emitToolActivity(candidate, index, emittedTools, onToolUse);

      const isWaitingPermission =
        candidate.status === 'CORTEX_STEP_STATUS_WAITING' &&
        candidate.requestedInteraction?.permission != null;

      if (isWaitingPermission) {
        const key = toolIdFromStep(candidate, index);
        const approvable = config.skipPermissions || candidate.runCommand?.shouldAutoRun;

        // Emit permission-request row before deciding to approve.
        emitPermissionRow(candidate, index, 'in_progress', emittedTools, onToolUse);

        if (!approvedPermissionSteps.has(key) && approvable) {
          const label = candidate.runCommand?.commandLine ?? candidate.metadata?.toolCall?.name ?? 'tool request';
          onSystemNotice?.(`[ANTIGRAVITY RPC] approving ${toolNameFromStep(candidate)}: ${label}`);
          try {
            await approvePermissionInteraction(endpoint, cascadeId, candidate);
            approvedPermissionSteps.add(key);
            // Update the permission row to completed.
            emitPermissionRow(candidate, index, 'completed', emittedTools, onToolUse, 'workspace auto-approve');
          } catch (err) {
            onSystemNotice?.(`[ANTIGRAVITY RPC] permission approval failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (approvedPermissionSteps.has(key)) {
          // Antigravity keeps the original permission step in WAITING even after
          // approval while later command-status/tool steps advance. Treat this
          // step as a historical gate once the approval RPC returns.
          continue;
        } else {
          // Not auto-approvable — surface as a stall if it lingers.
          const since = waitingSince.get(key) ?? Date.now();
          waitingSince.set(key, since);
          const elapsed = Date.now() - since;
          // Emit waiting_permission stall row at half-timeout (mirrors waiting_unbridged_tool pattern).
          if (elapsed > TOOL_STALL_MS / 2) {
            emitStallRow(key, 'waiting_permission', toolNameFromStep(candidate), emittedTools, onToolUse);
          }
          if (elapsed > TOOL_STALL_MS) {
            throw new Error(`Antigravity RPC is waiting on a permission step (${toolNameFromStep(candidate)}) that cannot be auto-approved. Set skipPermissions or run Antigravity in AUTO mode.`);
          }
        }
        continue;
      }

      // Track unbridged waiting/running steps.
      if (candidate.status === 'CORTEX_STEP_STATUS_WAITING' || candidate.status === 'CORTEX_STEP_STATUS_RUNNING') {
        if (isCommandProgressStep(candidate)) {
          // command_status/send_command_input are Antigravity's normal polling
          // steps for shell commands. They often remain RUNNING for their
          // requested wait duration before a later poll marks them completed.
          continue;
        }
        if (candidate.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' && hasLaterCommandProgress(steps, index)) {
          // The launcher step can remain RUNNING while Antigravity appends
          // command_status/send_command_input steps for the actual command.
          // Follow those later steps instead of timing out the historical Bash
          // launcher row.
          continue;
        }
        const key = toolIdFromStep(candidate, index);
        const since = waitingSince.get(key) ?? Date.now();
        waitingSince.set(key, since);
        const elapsed = Date.now() - since;

        if (elapsed > TOOL_STALL_MS / 2) {
          // Emit a visible stall row so Activity shows what we're blocked on.
          emitStallRow(
            key,
            'waiting_unbridged_tool',
            `${toolNameFromStep(candidate)}: ${candidate.runCommand?.commandLine ?? candidate.metadata?.toolCall?.name ?? 'unknown'}`,
            emittedTools,
            onToolUse,
          );
        }

        if (elapsed > TOOL_STALL_MS) {
          const toolLabel = toolNameFromStep(candidate);
          const detail = candidate.runCommand?.commandLine ?? candidate.metadata?.toolCall?.name ?? 'unknown';
          // Upgrade to timed_out before throwing.
          emitStallRow(key, 'timed_out', `${toolLabel}: ${detail}`, emittedTools, onToolUse);
          throw new Error(`Antigravity RPC is waiting on an unbridged tool step (${toolLabel}: ${detail}). Model access is working, but full Antigravity tool execution still needs a tool bridge.`);
        }
      }
    }

    const step = extractLatestPlannerResponse(steps, baseline.length);
    if (step) {
      const text = step.plannerResponse?.modifiedResponse ?? step.plannerResponse?.response ?? '';
      const usage = usageFromStep(step);
      const generatedFilePaths = collectGeneratedFilePaths(steps, baseline.length);
      return {
        text: text.trim(),
        cascadeId,
        modelId,
        modelDisplayName,
        modelEnum,
        ...(usage ? { usage } : {}),
        ...(generatedFilePaths.length > 0 ? { generatedFilePaths } : {}),
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (isAborted()) throw new Error('cancelled');
  }

  // Hard deadline — emit a timed_out row for any still-running step.
  try {
    const steps = await getSteps(endpoint, cascadeId);
    for (const [index, candidate] of steps.entries()) {
      if (index < baseline.length) continue;
      if (candidate.status === 'CORTEX_STEP_STATUS_WAITING' || candidate.status === 'CORTEX_STEP_STATUS_RUNNING') {
        const key = toolIdFromStep(candidate, index);
        emitStallRow(key, 'timed_out', toolNameFromStep(candidate), emittedTools, onToolUse);
        break;
      }
    }
  } catch { /* best-effort */ }

  throw new Error(`No Antigravity RPC planner response detected within ${Math.round(RPC_TIMEOUT_MS / 1000)}s.`);
}
