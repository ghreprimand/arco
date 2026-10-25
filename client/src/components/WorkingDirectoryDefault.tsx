import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import type { ArcoSettings } from '@arco/shared';

interface DirEntry {
  name: string;
  path: string;
}

// Settings → DEFAULT WORKING DIRECTORY. Sets the browser root the
// WorkflowCreator's "WORKING DIRECTORY" selector starts at (and the value its
// placeholder reflects). Lives in its own file so SettingsPanel stays under the
// size budget. Two ways to set it: type/paste an absolute path + SAVE, or
// BROWSE the same folder tree the creator uses and pick a folder as the root.
// Empty + SAVE clears it (the server then falls back to ~/Projects → $HOME).
export function WorkingDirectoryDefault() {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);

  const [draft, setDraft] = useState<string>(settings?.defaultWorkingDirectory ?? '');
  const [saving, setSaving] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [parentDir, setParentDir] = useState('');

  useEffect(() => {
    setDraft(settings?.defaultWorkingDirectory ?? '');
  }, [settings?.defaultWorkingDirectory]);

  async function fetchDirs(path: string) {
    try {
      const res = await fetch(`/api/list-dirs?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      setDirs(Array.isArray(data.dirs) ? data.dirs : []);
      setParentDir(typeof data.parent === 'string' ? data.parent : '');
    } catch { /* leave previous listing */ }
  }

  const openBrowser = () => {
    const next = !showBrowser;
    setShowBrowser(next);
    // Seed the tree at the current draft (or the server's default root when empty).
    if (next) void fetchDirs(draft.trim());
  };

  const commit = async (value: string) => {
    const next = value.trim();
    if (next === (settings?.defaultWorkingDirectory ?? '')) return;
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultWorkingDirectory: next }),
      });
      const data = (await res.json()) as ArcoSettings;
      setSettings(data);
      // Server may have rejected a non-absolute path (cleared it) — reflect truth.
      setDraft(data.defaultWorkingDirectory ?? '');
    } catch {
      setDraft(settings?.defaultWorkingDirectory ?? '');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-help="settings.default-working-dir">
      <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>
        DEFAULT WORKING DIRECTORY
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { void commit(draft); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
            if (e.key === 'Escape') { setDraft(settings?.defaultWorkingDirectory ?? ''); (e.target as HTMLInputElement).blur(); }
          }}
          placeholder="(unset — defaults to ~/Projects, then your home folder)"
          spellCheck={false}
          style={{
            flex: 1,
            minWidth: 0,
            padding: '6px 10px',
            background: 'var(--color-bg-sunken)',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: 'var(--color-accent-primary)',
            fontSize: '11px',
            fontFamily: 'var(--font-code)',
          }}
        />
        <button
          onClick={openBrowser}
          className="display-font"
          style={{ background: 'none', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-accent-secondary-dim)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px', padding: '5px 10px', whiteSpace: 'nowrap' }}
        >
          {showBrowser ? 'BROWSE ▼' : 'BROWSE ▶'}
        </button>
        <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)', minWidth: '46px', textAlign: 'right' }}>
          {saving ? 'SAVING…' : ''}
        </span>
      </div>

      {showBrowser && (
        <div style={{ maxHeight: '220px', overflowY: 'auto', border: '1px solid var(--color-border-hairline)', borderRadius: '4px', background: 'var(--color-bg-sunken)', marginBottom: '8px' }}>
          <div style={{ padding: '4px 8px', fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', borderBottom: '1px solid var(--color-border-hairline)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{parentDir || '…'}</span>
            {parentDir && (
              <button
                onClick={() => fetchDirs(parentDir.split('/').slice(0, -1).join('/') || '/')}
                style={{ background: 'none', border: 'none', color: 'var(--color-accent-secondary-dim)', cursor: 'pointer', fontSize: '10px', fontFamily: 'var(--font-display)' }}
              >
                ↑ UP
              </button>
            )}
            {parentDir && (
              <button
                onClick={() => { setDraft(parentDir); void commit(parentDir); }}
                className="display-font"
                title="Use this folder as the default working-directory root"
                style={{ background: 'transparent', border: '1px solid var(--color-accent-primary)', borderRadius: '3px', color: 'var(--color-accent-primary)', cursor: 'pointer', fontSize: '9px', letterSpacing: '1px', padding: '2px 8px' }}
              >
                ✓ USE THIS
              </button>
            )}
          </div>
          {dirs.map((d) => (
            <button
              key={d.path}
              onClick={() => { setDraft(d.path); void fetchDirs(d.path); }}
              style={{
                display: 'block',
                width: '100%',
                padding: '4px 12px',
                background: draft === d.path ? 'var(--color-accent-primary-a08)' : 'transparent',
                border: 'none',
                borderBottom: '1px solid var(--color-accent-primary-a05)',
                color: draft === d.path ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)',
                cursor: 'pointer',
                fontFamily: 'var(--font-body)',
                fontSize: '12px',
                textAlign: 'left',
              }}
            >
              {d.name}/
            </button>
          ))}
          {dirs.length === 0 && (
            <div style={{ padding: '8px 12px', fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', fontStyle: 'italic' }}>
              No sub-folders here. Use ↑ UP, or ✓ USE THIS to pick this folder.
            </div>
          )}
        </div>
      )}

      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', marginBottom: '14px', lineHeight: 1.5 }}>
        The folder the new-workflow "WORKING DIRECTORY" picker opens at. Set it per machine — useful when your
        projects don't live under <code>~/Projects</code> (e.g. a Mac). Leave blank to use the default.
      </div>
    </div>
  );
}
