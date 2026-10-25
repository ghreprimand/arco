import { useId, useState, type CSSProperties } from 'react';
import type { ArcoSettings } from '@arco/shared';
import { useAppStore } from '../stores/appStore';

// Settings -> MEDIA ACCESS. Media Studio is confined by default to the workflow
// folder, browser uploads and Arco's import scratch. Reaching anything else
// needs BOTH the global switch and an explicit allowed folder; the server
// enforces that and always blocks provider accounts, credentials and system
// folders, even when listed. Own file to keep SettingsPanel within budget.

export const MAX_MEDIA_ROOTS = 32;

export type MediaAccessState = 'confined' | 'switch-only' | 'folders-off' | 'allowed';

export function mediaAccessState(settings: Pick<ArcoSettings, 'mediaUnconfined' | 'mediaAllowedRoots'> | null | undefined): MediaAccessState {
  const on = settings?.mediaUnconfined === true;
  const roots = settings?.mediaAllowedRoots?.length ?? 0;
  if (on && roots > 0) return 'allowed';
  if (on) return 'switch-only';
  return roots > 0 ? 'folders-off' : 'confined';
}

export const MEDIA_ACCESS_SUMMARY: Record<MediaAccessState, string> = {
  confined: 'Confined (default). Media Studio uses the workflow folder, uploads and import scratch only.',
  'switch-only': 'Outside-folder access is on, but no folders are listed, so nothing outside the workflow folder is reachable. Add the folders you need below. (Older versions treated this switch alone as access to every path; that no longer applies.)',
  'folders-off': 'Folders are listed, but outside-folder access is off. They are not reachable until you turn it on.',
  allowed: 'Media Studio can also read and write inside the listed folders.',
};

const absolutePath = /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/;

// Client-side check before saving. The server normalizes and re-checks.
export function validateMediaRoot(input: string, existing: readonly string[]): { path: string } | { error: string } {
  const value = input.trim();
  if (!value) return { error: 'Enter a folder path.' };
  if (!absolutePath.test(value)) return { error: 'Use an absolute path on the Arco server, for example /media/library.' };
  if (/^(?:\/+|[A-Za-z]:[\\/]?)$/.test(value)) return { error: 'A whole drive or the filesystem root cannot be allowed. Choose a specific folder.' };
  const trimmed = value.length > 1 ? value.replace(/[\\/]+$/, '') : value;
  if (existing.includes(trimmed)) return { error: 'That folder is already listed.' };
  if (existing.length >= MAX_MEDIA_ROOTS) return { error: `At most ${MAX_MEDIA_ROOTS} folders can be allowed. Remove one first.` };
  return { path: trimmed };
}

// The server normalizes and silently drops invalid entries, so an add was
// accepted only if the saved list grew.
export function mediaRootAccepted(before: readonly string[], saved: readonly string[] | undefined): boolean {
  return (saved?.length ?? 0) > before.length;
}

export type MediaSaveResult = { settings: ArcoSettings; message: string } | { error: string };
type MediaPatch = Pick<ArcoSettings, 'mediaUnconfined' | 'mediaAllowedRoots'>;

// One settings write. A failure leaves the previous (server-side) settings in
// force and says so; nothing is applied optimistically.
export async function saveMediaAccess(patch: MediaPatch, message: string, fetcher: typeof fetch = fetch): Promise<MediaSaveResult> {
  try {
    const res = await fetcher('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const data = (await res.json().catch(() => null)) as (ArcoSettings & { error?: string }) | null;
    if (!res.ok || !data || typeof data !== 'object') throw new Error(data?.error || `HTTP ${res.status}.`);
    return { settings: data, message };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { error: `Not saved: ${reason} Your previous media access settings still apply.` };
  }
}

export async function addMediaRoot(path: string, roots: readonly string[], fetcher: typeof fetch = fetch): Promise<MediaSaveResult> {
  const result = await saveMediaAccess({ mediaAllowedRoots: [...roots, path] }, `Added ${path}.`, fetcher);
  if ('error' in result) return result;
  if (!mediaRootAccepted(roots, result.settings.mediaAllowedRoots)) {
    return { error: `The server did not accept ${path}. Use an absolute folder path on the Arco server.` };
  }
  return result;
}

const button = (active: boolean): CSSProperties => ({
  background: 'none', border: '1px solid var(--color-border-hairline)', borderRadius: '3px',
  color: active ? 'var(--color-accent-secondary)' : 'var(--color-fg-muted)', cursor: active ? 'pointer' : 'not-allowed',
  fontSize: '10px', letterSpacing: '1px', padding: '5px 10px', whiteSpace: 'nowrap',
});

export function MediaAccessSettings() {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const inputId = useId();
  const helpId = useId();
  const listId = useId();
  const on = settings?.mediaUnconfined === true;
  const roots = settings?.mediaAllowedRoots ?? [];
  const state = mediaAccessState(settings);

  async function apply(result: Promise<MediaSaveResult>, onSaved?: () => void) {
    setSaving(true);
    setError('');
    setStatus('Saving...');
    const outcome = await result;
    setSaving(false);
    if ('error' in outcome) { setError(outcome.error); setStatus(''); return; }
    setSettings(outcome.settings);
    setStatus(outcome.message);
    onSaved?.();
  }

  function add() {
    if (saving) return;
    const checked = validateMediaRoot(draft, roots);
    if ('error' in checked) { setError(checked.error); return; }
    void apply(addMediaRoot(checked.path, roots), () => setDraft(''));
  }

  const remove = (path: string) => { if (!saving) void apply(saveMediaAccess({ mediaAllowedRoots: roots.filter((p) => p !== path) }, `Removed ${path}. Access to it ends on the next request.`)); };
  const toggle = () => { if (!saving) void apply(saveMediaAccess({ mediaUnconfined: !on }, on ? 'Outside-folder access turned off.' : 'Outside-folder access turned on for the listed folders.')); };
  const revokeAll = () => { if (!saving) void apply(saveMediaAccess({ mediaUnconfined: false, mediaAllowedRoots: [] }, 'All outside-folder media access revoked.')); };

  return (
    <section data-help="settings.media-unconfined" aria-labelledby={`${listId}-heading`}>
      <div id={`${listId}-heading`} className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>
        MEDIA ACCESS
      </div>
      <p data-media-access-state={state} style={{ fontSize: '10px', color: state === 'switch-only' ? 'var(--color-warning)' : 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', margin: '0 0 8px', lineHeight: 1.5 }}>
        {MEDIA_ACCESS_SUMMARY[state]}
      </p>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap' }}>
        <button type="button" onClick={toggle} disabled={saving} aria-pressed={on} className="display-font" style={button(!saving)}>
          {on ? '● OUTSIDE-FOLDER ACCESS ON' : '○ OUTSIDE-FOLDER ACCESS OFF'}
        </button>
        <button type="button" onClick={revokeAll} disabled={saving || (!on && roots.length === 0)} className="display-font" style={button(!saving && (on || roots.length > 0))}>
          REVOKE ALL
        </button>
        <span role="status" aria-live="polite" className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>{status}</span>
      </div>
      <label htmlFor={inputId} style={{ display: 'block', fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', marginBottom: '4px' }}>
        Allowed folder (absolute path on the Arco server)
      </label>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
        <input
          id={inputId}
          type="text"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); if (error) setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="/media/library"
          spellCheck={false}
          aria-describedby={helpId}
          aria-invalid={error ? true : undefined}
          style={{ flex: 1, minWidth: 0, padding: '6px 10px', background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-accent-primary)', fontSize: '11px', fontFamily: 'var(--font-code)' }}
        />
        <button type="button" onClick={add} disabled={saving || !draft.trim() || roots.length >= MAX_MEDIA_ROOTS} className="display-font" style={button(!saving && !!draft.trim())}>
          + ADD FOLDER
        </button>
      </div>
      {error && <div role="alert" style={{ color: 'var(--color-warning)', fontSize: '10px', fontFamily: 'var(--font-body)', marginBottom: '6px' }}>{error}</div>}
      <ul aria-label="Allowed media folders" style={{ listStyle: 'none', margin: '0 0 8px', padding: 0, border: '1px solid var(--color-border-hairline)', borderRadius: '4px', background: 'var(--color-bg-sunken)', maxHeight: '180px', overflowY: 'auto' }}>
        {roots.map((p) => (
          <li key={p} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 10px', borderBottom: '1px solid var(--color-accent-primary-a05)', fontSize: '11px', fontFamily: 'var(--font-code)', color: on ? 'var(--color-accent-primary-dim)' : 'var(--color-fg-muted)' }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p}>{p}</span>
            <button type="button" onClick={() => remove(p)} disabled={saving} aria-label={`Remove allowed folder ${p}`} title="Remove and revoke access" style={{ background: 'none', border: 'none', color: 'var(--color-accent-secondary-dim)', cursor: 'pointer', fontSize: '11px' }}>✕</button>
          </li>
        ))}
        {roots.length === 0 && (
          <li style={{ padding: '6px 10px', fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', fontStyle: 'italic' }}>No allowed folders. Media Studio stays inside the workflow folder.</li>
        )}
      </ul>
      <div id={helpId} style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', marginBottom: '14px', lineHeight: 1.5 }}>
        Paths are on the machine running Arco. In Docker, use the path inside the container (a bind-mounted folder such
        as /media), not the path on your computer. Up to {MAX_MEDIA_ROOTS} folders. Provider accounts, credentials and
        system folders stay blocked even if listed. Removing a folder or turning access off takes effect on the next
        request. Leave access off if this Arco is reachable over a tunnel.
      </div>
    </section>
  );
}
