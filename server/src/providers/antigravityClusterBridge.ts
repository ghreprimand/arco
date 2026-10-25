import { chmod, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

export const ANTIGRAVITY_CLUSTER_TOOL_NAMES = [
  'peer_list',
  'peer_send',
  'peer_read',
  'cluster_plan_tick',
  'cluster_plan_write',
] as const;

export type AntigravityClusterToolName = typeof ANTIGRAVITY_CLUSTER_TOOL_NAMES[number];

export const ANTIGRAVITY_RPC_READONLY_DISCOVERY_METHODS = [
  'GetMcpServerTemplates',
  'GetMcpServerStates',
  'ListMcpResources',
  'ListMcpPrompts',
  'GetUserSettings',
] as const;

export const ANTIGRAVITY_RPC_TOOL_REGISTRATION_CANDIDATES = [
  'RegisterTool',
  'RegisterLocalTool',
  'RegisterDynamicTool',
  'RegisterMcpServer',
  'SetMcpServerConfig',
] as const;

export function antigravityClusterBridgeEnabled(): boolean {
  return process.env.ARCO_ANTIGRAVITY_CLUSTER_BRIDGE === '1';
}

export function antigravityClusterCliPath(cwd: string): string {
  return join(cwd, '.arco', 'bin', 'cluster-tool');
}

export function buildAntigravityClusterToolStub(): string {
  return `#!/usr/bin/env bash
set -euo pipefail

cmd="\${1:-}"
shift || true

need_env() {
  local missing=0
  for name in ARCO_PORT ARCO_CLUSTER_ID ARCO_WORKFLOW_ID; do
    if [[ -z "\${!name:-}" ]]; then
      echo "cluster-tool: missing $name" >&2
      missing=1
    fi
  done
  if [[ "$missing" -ne 0 ]]; then
    echo "cluster-tool: this bridge is a Phase D stub and is not wired into Antigravity clusters yet" >&2
    exit 2
  fi
}

json_escape() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1] ?? ""))' "$1"
}

post_json() {
  local op="$1"
  local body="$2"
  curl -fsS \\
    -H 'Content-Type: application/json' \\
    -X POST \\
    --data "$body" \\
    "http://127.0.0.1:\${ARCO_PORT}/api/clusters/\${ARCO_CLUSTER_ID}/peer/$op"
}

case "$cmd" in
  peer_list)
    need_env
    curl -fsS "http://127.0.0.1:\${ARCO_PORT}/api/clusters/\${ARCO_CLUSTER_ID}/peer/list?workflowId=\${ARCO_WORKFLOW_ID}"
    ;;
  peer_read)
    need_env
    post_json read "{\\"workflowId\\":$(json_escape "$ARCO_WORKFLOW_ID")}"
    ;;
  peer_send)
    need_env
    to="\${1:-}"
    content="\${2:-}"
    if [[ -z "$to" || -z "$content" ]]; then
      echo 'usage: cluster-tool peer_send <peer> <content>' >&2
      exit 2
    fi
    post_json send "{\\"from\\":$(json_escape "$ARCO_WORKFLOW_ID"),\\"to\\":$(json_escape "$to"),\\"content\\":$(json_escape "$content")}"
    ;;
  cluster_plan_tick)
    need_env
    if [[ "\${1:-}" == "--line-index" ]]; then
      post_json plan-tick "{\\"workflowId\\":$(json_escape "$ARCO_WORKFLOW_ID"),\\"lineIndex\\":$2}"
    elif [[ "\${1:-}" == "--task-text" ]]; then
      post_json plan-tick "{\\"workflowId\\":$(json_escape "$ARCO_WORKFLOW_ID"),\\"taskText\\":$(json_escape "\${2:-}")}"
    else
      echo 'usage: cluster-tool cluster_plan_tick (--line-index <n> | --task-text <text>)' >&2
      exit 2
    fi
    ;;
  cluster_plan_write)
    need_env
    body="\${1:-}"
    if [[ -z "$body" ]]; then
      echo 'usage: cluster-tool cluster_plan_write <markdown-body>' >&2
      exit 2
    fi
    post_json plan-write "{\\"workflowId\\":$(json_escape "$ARCO_WORKFLOW_ID"),\\"body\\":$(json_escape "$body")}"
    ;;
  ""|-h|--help|help)
    cat <<'HELP'
cluster-tool (Phase D stub)

Commands:
  peer_list
  peer_send <peer> <content>
  peer_read
  cluster_plan_tick --line-index <n>
  cluster_plan_tick --task-text <text>
  cluster_plan_write <markdown-body>

Required environment when this is eventually wired:
  ARCO_PORT
  ARCO_CLUSTER_ID
  ARCO_WORKFLOW_ID

Antigravity remains cluster-disabled until this bridge is generated, injected,
and smoke-tested as a visible shell/tool action.
HELP
    ;;
  *)
    echo "cluster-tool: unknown command: $cmd" >&2
    exit 2
    ;;
esac
`;
}

export async function writeAntigravityClusterToolStub(cwd: string): Promise<string> {
  const target = antigravityClusterCliPath(cwd);
  await mkdir(join(cwd, '.arco', 'bin'), { recursive: true });
  await writeFile(target, buildAntigravityClusterToolStub(), 'utf8');
  await chmod(target, 0o755);
  return target;
}
