import { useEffect, useRef, useState } from 'react';
import { ProjectLocationForm } from '../ProjectLocationForm';
import { WorkSurfaceControls } from '../workSurface/WorkSurfaceControls';
import type { LocationSaved } from '../../utils/projectLocations';
export function LocationDialog({ initialPath, onSaved, onClose }: { initialPath: string; onSaved: (saved: LocationSaved) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const closing = useRef(onClose), saving = useRef(busy); closing.current = onClose; saving.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving.current) { event.preventDefault(); event.stopPropagation(); closing.current(); }
      if (event.key === 'Tab' && !dialog.current?.contains(document.activeElement)) { event.preventDefault(); dialog.current?.focus(); }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); previous?.focus(); };
  }, []);
  return <div className="home-add-backdrop" onClick={() => { if (!busy) onClose(); }}><div className="home-add-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="location-dialog-title" onClick={e => e.stopPropagation()} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[role="alert"][tabindex="-1"]') ?? [])].filter(el => el.getClientRects().length);
    if (!controls.length) { event.preventDefault(); dialog.current?.focus(); return; }
    if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === dialog.current)) { event.preventDefault(); controls.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
  }}><header><div><h2 id="location-dialog-title">Add project location</h2><p>Choose a folder containing projects, such as Work or Personal.</p></div><WorkSurfaceControls surface={dialog} /><button type="button" aria-label="Close location dialog" disabled={busy} onClick={onClose}>Done</button></header>
    <div className="home-add-body"><ProjectLocationForm onBusyChange={setBusy} initialPath={initialPath} onSaved={onSaved} /></div>
  </div></div>;
}
