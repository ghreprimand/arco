import { create } from 'zustand';
import { voiceText, type ComputerWatch } from '@arco/shared';
import { useComputerStore } from '../stores/computerStore';
import { useAppStore } from '../stores/appStore';

export const useComputerWatches = create<{ watches: ComputerWatch[]; error: string | null }>(() => ({ watches: [], error: null }));
export async function watchRequest(ownerId: string, args?: Record<string, string>) {
  if (!useAppStore.getState().connected) throw Error('Disconnected. Watches were not changed.');
  const epoch = useComputerStore.getState().contextEpoch;
  const response = await fetch(`/api/voice/watches?owner=${encodeURIComponent(ownerId)}`, {
    ...(args ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (!response.ok) throw Error(body.error ?? 'Watch request failed.');
  if (useComputerStore.getState().activeId === ownerId && useComputerStore.getState().contextEpoch === epoch) useComputerWatches.setState({ watches: body.watches, error: body.warning ?? null });
  // Keep model replies inside the relay budget even with many watches or
  // large clusters. The panel retains the complete target list above.
  if (body.watch) {
    const w: ComputerWatch = body.watch;
    return JSON.stringify({ ...w, label: voiceText(w.label, 80), targetCount: w.targets.length,
      targets: w.targets.slice(0, 12).map((t) => ({ ...t, name: voiceText(t.name, 60) })),
      ...(w.targets.length > 12 ? { note: 'Full target list is in the Computer panel.' } : {}) });
  }
  const watches: ComputerWatch[] = body.watches;
  return JSON.stringify({ announce: body.announce, warning: body.warning,
    active: watches.filter((w) => w.status === 'watching').map((w) => ({ id: w.id, label: voiceText(w.label, 80), targets: w.targets.length, status: w.status })),
    recent: watches.filter((w) => w.status !== 'watching').slice(-5).map((w) => ({ id: w.id, label: voiceText(w.label, 80), status: w.status })),
    note: 'The Computer panel contains full targets and earlier watch history.' });
}
