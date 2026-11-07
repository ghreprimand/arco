import type { AttentionKind } from './protocol/notifications.js';

const PHRASE: Record<AttentionKind, string> = {
  finished: 'finished', failed: 'hit an error', waiting: 'is waiting for you',
};
const line = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Names a tab or a cluster member using the same fallback as the tab bar. */
export function noticeSourceLabel(workflowName: string, cluster: { name?: string; cwd: string; clusterId: string } | null): string {
  const member = line(workflowName);
  if (!cluster) return member;
  const root = cluster.cwd.replace(/[/\\]+$/, '');
  const project = root.split(/[/\\]/).pop() ?? '';
  const name = line(cluster.name ?? '') || (project ? `${project} · ${cluster.clusterId.slice(0, 8)}` : cluster.clusterId.slice(0, 8));
  return member ? `${member} in ${line(name)}` : line(name);
}
export function attentionTitle(source: string, kind: AttentionKind): string {
  return `${line(source)} ${PHRASE[kind]}`.trim();
}
export function scopedNoticeTitle(source: string, title: string): string {
  const prefix = line(source); const detail = line(title);
  return prefix ? `${prefix}: ${detail}` : detail;
}
