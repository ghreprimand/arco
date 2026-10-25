// WORKBENCH_EXPANSION_PLAN.md A1 — dev-only memory HUD.
//
// The store arrays are already capped (memoryTrim.ts) and the component
// observer/interval/listener teardown audits came back clean, so a residual
// "memory runs away after a while" leak can't be located by static reading —
// it has to be measured live. This overlay polls `getRetentionStats()` every
// 2s and prints the JS heap (Chrome) plus per-tab hot-array counts so the
// growth curve is visible during a long soak.
//
// Enable with `?memhud=1` in the URL or `localStorage.setItem('arco:memhud','1')`.
// Renders nothing otherwise, so it's inert in normal use. Reading the diagnosis:
//   - heap climbs but counts stay flat ⇒ leak is non-store (detached DOM,
//     highlight cache, blob URLs, an iframe/webview) — chase that.
//   - a per-job count climbs without bound ⇒ a cap isn't firing on some append
//     path — fix that path.
import { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/appStore';

function hudEnabled(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get('memhud') === '1') return true;
    return window.localStorage.getItem('arco:memhud') === '1';
  } catch {
    return false;
  }
}

export function MemoryHud() {
  const [enabled] = useState(hudEnabled);
  const getRetentionStats = useAppStore((s) => s.getRetentionStats);
  const [stats, setStats] = useState(() => (enabled ? getRetentionStats() : null));

  useEffect(() => {
    if (!enabled) return;
    const tick = () => setStats(getRetentionStats());
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => window.clearInterval(timer);
  }, [enabled, getRetentionStats]);

  if (!enabled || !stats) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 8,
        left: 8,
        zIndex: 99999,
        maxHeight: '40vh',
        overflowY: 'auto',
        background: 'rgba(0,0,0,0.82)',
        color: '#9ef',
        font: '10px/1.4 ui-monospace, monospace',
        padding: '8px 10px',
        border: '1px solid #2a4',
        borderRadius: 4,
        pointerEvents: 'none',
        whiteSpace: 'pre',
      }}
    >
      <div style={{ color: '#6f6', marginBottom: 4 }}>MEM HUD</div>
      {stats.heap && (
        <div style={{ color: stats.heap.usedMB > stats.heap.limitMB * 0.7 ? '#f96' : '#9ef' }}>
          heap {stats.heap.usedMB}MB / {stats.heap.totalMB}MB (lim {stats.heap.limitMB}MB)
        </div>
      )}
      <div>
        jobs {stats.jobs} · blobURLs {stats.attachmentUrls} · toasts {stats.notifications}
      </div>
      <div style={{ color: '#789', marginTop: 4 }}>per-tab  msg/sess/act/hist/wrk/tf/tok</div>
      {stats.perJob.map((j) => (
        <div key={j.id}>
          {j.id.slice(0, 8)}  {j.messages}/{j.sessionChat}/{j.activity}/{j.historyEvents}/{j.workers}/{j.toolFiltered}/{j.turnTokenUsage}
        </div>
      ))}
    </div>
  );
}
