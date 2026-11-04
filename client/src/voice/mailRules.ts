import { create } from 'zustand';
import { voiceText, type ComputerMailRule } from '@arco/shared';
import { useComputerStore } from '../stores/computerStore';
import { useAppStore } from '../stores/appStore';

export const useComputerMailRules = create<{ rules: ComputerMailRule[]; error: string | null }>(() => ({ rules: [], error: null }));
export async function mailRuleRequest(ownerId: string, args?: Record<string, string>) {
  if (!useAppStore.getState().connected) throw Error('Disconnected. Mailbox rules were not changed.');
  const epoch = useComputerStore.getState().contextEpoch;
  const body: Record<string, unknown> | undefined = args ? { ...args,
    ...(args.worker_ids ? { worker_ids: JSON.parse(args.worker_ids) } : {}) } : undefined;
  const response = await fetch(`/api/voice/mail-rules?owner=${encodeURIComponent(ownerId)}`, {
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error ?? 'Mailbox rule request failed.');
  if (useComputerStore.getState().activeId === ownerId && useComputerStore.getState().contextEpoch === epoch) useComputerMailRules.setState({ rules: result.rules, error: result.warning ?? null });
  return mailRuleToolResult(result);
}
export function mailRuleToolResult(result: {rules: ComputerMailRule[]; rule?: ComputerMailRule; announce?: boolean; warning?: string}) {
  const compact = (r: ComputerMailRule) => ({ id: r.id, cluster_id: r.clusterId, label: voiceText(r.label, 80), status: r.status, paused: r.paused,
    workers: r.workers.map((w) => ({ id: w.id, name: voiceText(w.name, 60), nudges: w.nudges })), final_id: r.finalId, finalName: voiceText(r.finalName, 60),
    reason: voiceText(r.reason, 250), expiresAt: r.expiresAt, maxNudgesPerWorker: r.maxNudgesPerWorker, cooldownMs: r.cooldownMs });
  return JSON.stringify({ announce: result.announce, warning: result.warning, rule: result.rule ? compact(result.rule) : undefined,
    rules: result.rule ? undefined : [...result.rules.filter((r: ComputerMailRule) => r.status === 'watching'), ...result.rules.filter((r: ComputerMailRule) => r.status !== 'watching').slice(-3)].map((r) => ({ id: r.id, cluster_id: r.clusterId, label: voiceText(r.label, 60), status: r.status, paused: r.paused,
      workerCount: r.workers.length, nudges: r.workers.reduce((n, w) => n + w.nudges, 0), final_id: r.finalId })),
    note: 'Full identities, reasons, limits and history are in the Computer panel.' });
}
