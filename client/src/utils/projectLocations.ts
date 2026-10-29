import type { ArcoSettings } from '@arco/shared';
import { rootsOf, pathWithin, type HomeRoot } from './homeModel';
export interface LocationDraft { name: string; path: string; }
export interface LocationSaved { list: unknown; settings: ArcoSettings; message: string; }
export class LocationConflict extends Error {
  constructor(public location: HomeRoot, public editing: boolean) {
    super(editing ? `The folder already belongs to "${location.name}". Choose a different folder; both locations are unchanged.` : `This folder is already the project location "${location.name}". The entered name has been kept.`);
  }
}
const samePath = (a: string, b: string) => pathWithin(a, b) && pathWithin(b, a);
export async function saveProjectLocation(draft: LocationDraft, editingPath?: string): Promise<LocationSaved> {
  const check = await fetch(`/api/projects?locationPath=${encodeURIComponent(draft.path.trim())}`, { cache: 'no-store' });
  const list = await check.json();
  if (!check.ok || typeof list.locationPath !== 'string') throw new Error(list.error || 'The folder path could not be checked. Retry.');
  const locations = rootsOf(list);
  if (!locations) throw new Error('Project locations could not be loaded. Nothing was changed.');
  const canonical = list.locationPath as string;
  const existing = locations.find(location => samePath(location.path, canonical));
  const before = editingPath ? locations.find(location => samePath(location.path, editingPath)) : undefined;
  if (editingPath && !before) throw new Error('This location changed elsewhere. Refresh before editing.');
  if (existing && (!before || !samePath(existing.path, before.path))) throw new LocationConflict(existing, !!editingPath);
  const next = { name: draft.name.trim(), path: canonical };
  const projectRoots = before ? locations.map(location => samePath(location.path, before.path) ? next : location) : [...locations, next];
  const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectRoots }) });
  const settings = await res.json();
  if (!res.ok) throw new Error(settings.error || 'The location was not saved. Retry.');
  const saved = (settings as ArcoSettings).projectRoots?.find(location => samePath(location.path, canonical));
  if (!saved) throw new Error('The saved location could not be confirmed. Refresh the list.');
  const refreshed = await fetch('/api/projects', { cache: 'no-store' });
  if (!refreshed.ok) throw new Error('The location was saved, but the list could not be refreshed. Reload the list.');
  return { settings, list: await refreshed.json(), message: before && before.name !== saved.name ? `Renamed location "${before.name}" to "${saved.name}".` : before ? `Location "${saved.name}" saved.` : `Location "${saved.name}" added.` };
}
