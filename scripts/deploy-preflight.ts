// Read live primary-turn state before a deployment. Never sends a prompt.
import WebSocket from 'ws';
import { pathToFileURL } from 'node:url';
import type { ClusterStateMessage, ServerMessage, WorkflowStateSnapshotMessage } from '@arco/shared';

type ActiveTurn = { workflowId: string; name?: string };
export function activeClusterMembers(members: ClusterStateMessage['state']['members']): ActiveTurn[] {
  return members.flatMap((member) => {
    // Cluster members use status, whereas standalone snapshots use busy.
    // Treat an unfamiliar wire shape as an error, never as an idle member.
    if (member.status !== 'busy' && member.status !== 'idle') throw new Error(`Unknown member status: ${member.workflowId}`);
    return member.status === 'busy' ? [{ workflowId: member.workflowId, name: member.displayName }] : [];
  });
}

export async function deploymentPreflight(base = 'http://127.0.0.1:3001'): Promise<{ checked: number; active: ActiveTurn[] }> {
  const auth = await fetch(base + '/api/session', { method: 'POST', headers: {
    Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
  } });
  if (!auth.ok) throw new Error(`Session mint failed: ${auth.status}`);
  const cookie = auth.headers.get('set-cookie')?.split(';')[0];
  const url = new URL('/ws', base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url, { headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}) } });
  return await new Promise((resolve, reject) => {
    let remaining: Set<string> | undefined;
    let checked = 0;
    const active: ActiveTurn[] = [];
    const timeout = setTimeout(() => fail(new Error(`Preflight timed out: ${[...(remaining ?? [])].join(', ')}`)), 20_000);
    function fail(error: Error) { clearTimeout(timeout); ws.terminate(); reject(error); }
    function finish() {
      if (remaining?.size !== 0) return;
      clearTimeout(timeout); ws.close(); resolve({ checked, active });
    }
    ws.on('open', () => ws.send(JSON.stringify({ type: 'workspace_sync', adopt: false, workflows: [], clusterIds: [] })));
    ws.on('error', fail);
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ServerMessage;
        if (msg.type === 'workspace_snapshot') {
          const { workflows, clusters } = msg.workspace;
          remaining = new Set([...workflows.map((w) => 'w:' + w.workflowId), ...clusters.map((c) => 'c:' + c.clusterId)]);
          if (workflows.length) ws.send(JSON.stringify({ type: 'rehydrate_workflows', workflows: workflows.map((w) => ({
            ...w, currentSessionId: w.workflowId, lastSeq: Number.MAX_SAFE_INTEGER,
          })) }));
          for (const c of clusters) ws.send(JSON.stringify({ type: 'cluster_subscribe', clusterId: c.clusterId }));
        } else if (msg.type === 'workflow_state_snapshot' && remaining?.delete('w:' + msg.workflowId)) {
          const snapshot: WorkflowStateSnapshotMessage = msg;
          if (typeof snapshot.busy !== 'boolean') throw new Error('Missing workflow busy state');
          checked++; if (snapshot.busy) active.push({ workflowId: snapshot.workflowId });
        } else if (msg.type === 'cluster_state' && remaining?.delete('c:' + msg.clusterId)) {
          checked += msg.state.members.length;
          active.push(...activeClusterMembers(msg.state.members));
        }
        finish();
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  deploymentPreflight(process.env.ARCO_PREFLIGHT_URL).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (result.active.length) process.exitCode = 2;
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
