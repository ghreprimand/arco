import { useEffect, useState, useSyncExternalStore } from 'react';
const openPanels = new Set<symbol>();
const defaultPanel = Symbol();
const listeners = new Set<() => void>();
const dismissers = new Set<() => void>();
export function dismissProviderHovers(): void { for (const dismiss of dismissers) dismiss(); }
export function setProviderPanelOpen(value: boolean, panel: symbol = defaultPanel): void {
  if (value) openPanels.add(panel); else openPanels.delete(panel);
  for (const notify of listeners) notify();
}
export function useProviderHover(): [boolean, (value: boolean) => void] {
  const blocked = useSyncExternalStore((notify) => { listeners.add(notify); return () => { listeners.delete(notify); }; }, () => openPanels.size > 0, () => false);
  const [open, setOpen] = useState(false);
  useEffect(() => { const dismiss = () => setOpen(false); dismissers.add(dismiss); return () => { dismissers.delete(dismiss); }; }, []);
  useEffect(() => { if (blocked) setOpen(false); }, [blocked]);
  return [open && !blocked, (value) => setOpen(value && openPanels.size === 0)];
}
