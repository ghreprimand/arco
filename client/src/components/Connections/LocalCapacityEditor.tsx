import { useEffect, useState } from 'react';
import { LOCAL_CLUSTER_CAPACITY_MAX, LOCAL_CLUSTER_CAPACITY_MIN, LOCAL_RUNTIME_LABELS, localClusterCapacityFor, type ArcoSettings, type LocalClusterRuntime } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';

// Per-runtime cluster capacity. Default 1 keeps one local member per cluster.
export function LocalCapacityEditor({ runtime }: { runtime: LocalClusterRuntime }) {
  const settings = useAppStore(s => s.settings), setSettings = useAppStore(s => s.setSettings);
  const saved = localClusterCapacityFor(settings?.localClusterCapacity, runtime);
  const [draft, setDraft] = useState(String(saved)), [busy, setBusy] = useState(false), [note, setNote] = useState('');
  useEffect(() => { setDraft(String(saved)); }, [saved]);
  const id = `connection-capacity-${runtime}`;
  const label = LOCAL_RUNTIME_LABELS[runtime];
  const save = async () => {
    const value = Number(draft);
    if (!Number.isInteger(value) || value < LOCAL_CLUSTER_CAPACITY_MIN || value > LOCAL_CLUSTER_CAPACITY_MAX) {
      setNote(`Enter a whole number from ${LOCAL_CLUSTER_CAPACITY_MIN} to ${LOCAL_CLUSTER_CAPACITY_MAX}.`); return;
    }
    if (value === saved) { setNote(''); return; }
    setBusy(true); setNote('');
    try {
      const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ localClusterCapacity: { [runtime]: value } }) });
      const body = await res.json();
      if (!res.ok || !body?.enabledProviders) throw new Error();
      setSettings(body as ArcoSettings);
      setNote(`Saved. New clusters may give ${value} ${value === 1 ? 'member' : 'members'} ${label} at once.`);
    } catch { setNote('Capacity was not saved. Check the server connection and retry.'); }
    finally { setBusy(false); }
  };
  return <form noValidate onSubmit={e => { e.preventDefault(); void save(); }} className="connections-endpoint" data-help="connections.local-capacity">
    <label htmlFor={id}>Cluster members that may use this runtime at once</label>
    <input id={id} type="number" min={LOCAL_CLUSTER_CAPACITY_MIN} max={LOCAL_CLUSTER_CAPACITY_MAX} step={1} value={draft} disabled={busy} onChange={e => setDraft(e.target.value)} style={{ flex: '0 0 90px' }} />
    <button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save capacity'}</button>
    <p>Default 1. Each member on a different model loads its own copy of that model into memory; members on the same model share one copy. Raise this only when the machine has memory for it. Arco still runs local turns one at a time per runtime unless the server sets ARCO_LOCAL_PROVIDER_SERIAL_QUEUE=0; with that queue off, members send requests in parallel.{runtime === 'ollama' ? ' Ollama itself decides what it accepts through OLLAMA_MAX_LOADED_MODELS and OLLAMA_NUM_PARALLEL on the machine that runs it.' : ' llama.cpp serves the models and parallel slots its server was started with.'} Ollama and llama.cpp members together are limited by the larger of their two settings.</p>
    <p role="status">{note}</p>
  </form>;
}
