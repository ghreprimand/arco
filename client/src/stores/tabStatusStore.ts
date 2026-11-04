import { create } from 'zustand';
import { useAppStore } from './appStore';

// Tabs whose turn finished while another tab (or Home) was showing. Cleared when
// the tab is opened. Kept out of appStore: it is derived view state, not
// workflow data, and is never persisted.
interface TabStatusState {
  unviewed: Record<string, true>;
}

export const tabKey = (kind: 'job' | 'cluster', id: string): string => `${kind}:${id}`;

export const useTabStatusStore = create<TabStatusState>(() => ({ unviewed: {} }));

function mark(keys: string[]): void {
  if (!keys.length) return;
  useTabStatusStore.setState((s) => {
    const next = { ...s.unviewed };
    for (const k of keys) next[k] = true;
    return { unviewed: next };
  });
}

function clear(key: string | null): void {
  if (!key) return;
  useTabStatusStore.setState((s) => {
    if (!s.unviewed[key]) return s;
    const next = { ...s.unviewed };
    delete next[key];
    return { unviewed: next };
  });
}

let started = false;

/** Subscribe once: mark a tab when a turn ends away from it, clear it when it opens. */
export function startTabStatusTracking(): void {
  if (started) return;
  started = true;
  const activeKey = (s: ReturnType<typeof useAppStore.getState>): string | null =>
    s.showHome || s.showCreator || s.showGithub ? null : s.activeClusterId ? tabKey('cluster', s.activeClusterId) : s.activeJobId ? tabKey('job', s.activeJobId) : null;
  clear(activeKey(useAppStore.getState()));
  useAppStore.subscribe((state, prev) => {
    const open = activeKey(state);
    if (open !== activeKey(prev)) clear(open);
    if (state.jobs === prev.jobs && state.clusters === prev.clusters) return;
    const memberOf = new Map<string, string>();
    for (const c of Object.values(state.clusters)) for (const m of c.members) memberOf.set(m.workflowId, c.clusterId);
    const finished: string[] = [];
    for (const [id, job] of Object.entries(state.jobs)) {
      if (!prev.jobs[id]?.busy || job.busy) continue;
      const clusterId = memberOf.get(id);
      const key = clusterId ? tabKey('cluster', clusterId) : tabKey('job', id);
      if (key !== open) finished.push(key);
    }
    mark(finished);
  });
}
