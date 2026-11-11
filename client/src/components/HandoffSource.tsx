import { latestHandoffSeed } from '../utils/handoffSeeds';
import { useEffect, useState } from 'react';
import type { WorkflowConfig } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { requestVoicePanel } from '../voice/panels';

const sourceButtonStyle = { padding: '4px 10px', marginRight: 8, marginBottom: 4, border: '1px solid var(--color-border-hairline)', borderLeft: '2px solid var(--color-accent-secondary-dim)', borderRadius: 3, background: 'transparent', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', fontSize: 12, cursor: 'pointer' } as const;

type Source = { key: string; name: string; throughSeq: number; available: boolean };

/** Re-fetch durable, server-owned provenance; never trust client config lineage. */
export function HandoffSource({ workflowId, requireSeed = false }: { workflowId?: string; requireSeed?: boolean }) {
  const config = useAppStore(s => workflowId ? s.jobs[workflowId]?.config : undefined);
  const sourceKey = useAppStore(s => workflowId ? latestHandoffSeed(s.jobs[workflowId]?.messages ?? [])?.handoffSourceKey : undefined);
  const clusters = useAppStore(s => s.clusters);
  const restricted = Object.values(clusters).some(c => c.members.some(m => m.workflowId === workflowId && m.accessMode && m.accessMode !== 'standard'));
  const [sources, setSources] = useState<Source[]>([]);
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState('');
  const allowed = !!workflowId && !!config && config.kind !== 'chat' && !config.incognito && !restricted && (!requireSeed || !!sourceKey);
  useEffect(() => {
    if (!allowed) { setSources([]); return; }
    const controller = new AbortController();
    fetch(`/api/handoff-sources?workflowId=${encodeURIComponent(workflowId!)}&offset=${offset}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() : { sources: [] })
      .then(data => { setSources(data.currentSourceKey && (!requireSeed || data.currentSourceKey === sourceKey) ? data.sources ?? [] : []); setNextOffset(data.nextOffset ?? null); })
      .catch(() => {});
    return () => controller.abort();
  }, [workflowId, allowed, offset, sourceKey, requireSeed]);
  if (!allowed || !sources.length) return null;
  async function open(source: Source) {
    try {
      const response = await fetch(`/api/handoff-sources?workflowId=${encodeURIComponent(workflowId!)}&source=${encodeURIComponent(source.key)}`);
      const data = await response.json() as { workflowId: string; config: WorkflowConfig; error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Earlier conversation is unavailable.');
      const store = useAppStore.getState();
      if (store.jobs[data.workflowId]) store.setActiveJob(data.workflowId);
      else store.wsSendRaw?.({ type: 'create_workflow', config: data.config });
      requestVoicePanel(data.workflowId, 'history', source.throughSeq);
      setError('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Earlier conversation is unavailable.'); }
  }
  return <div data-help="chat.seed-pill.source" style={{ margin: '4px 0', fontSize: 12 }}>
    {sources.map((source, index) => <button key={source.key} type="button" disabled={!source.available}
      title={source.available ? 'Open the earlier conversation' : 'Earlier conversation was deleted, archived or is unavailable'}
      onClick={() => void open(source)} style={sourceButtonStyle}>
      {offset === 0 && index === 0 ? 'From ' : 'Earlier: '}{source.name}{!source.available ? ' (unavailable)' : ''}
    </button>)}
    {offset > 0 && <button type="button" style={sourceButtonStyle} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous sources</button>}
    {nextOffset !== null && <button type="button" style={sourceButtonStyle} onClick={() => setOffset(nextOffset)}>More sources</button>}
    {error && <span role="status">{error}</span>}
  </div>;
}
