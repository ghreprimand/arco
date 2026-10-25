import type { PickOptions, PickResult } from './DirectoryPicker';

// Part N2 (+ N3 picker) — the "SAVE TO…" affordance shared by the audio + video
// ops panels. Instead of typing a path, the operator clicks SAVE TO… and a
// click-through folder picker pops (DirectoryPicker); the chosen destination is
// shown as a chip and reused by the ops. Blank ⇒ alongside the source (or, for an
// imported file, the op-run pops the picker so output never silently lands in
// scratch — see the panels' runOp).
//
// The server still enforces the access fence — an out-of-workflow destination
// needs "Unconfined media access" — so this is purely an input surface.

interface Props {
  dir: string;
  setDir: (v: string) => void;
  basename: string;
  setBasename: (v: string) => void;
  disabled?: boolean;
  // Open the shared folder picker (owned by the panel).
  pick: (opts?: PickOptions) => Promise<PickResult | null>;
  // Where the picker starts browsing (the workflow cwd, usually).
  initialPath?: string;
}

export function MediaSaveControls({ dir, setDir, basename, setBasename, disabled, pick, initialPath }: Props) {
  const active = !!dir.trim();

  const choose = async () => {
    const r = await pick({ initialPath: dir.trim() || initialPath, defaultName: basename, title: 'Save output to…' });
    if (r) { setDir(r.dir); setBasename(r.basename); }
  };
  const clear = () => { setDir(''); setBasename(''); };

  return (
    <div data-help="media.save-to" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <button
          onClick={choose}
          disabled={disabled}
          className="display-font"
          title="Pick where the output file is written"
          style={{
            background: 'transparent',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
            cursor: 'pointer',
            fontSize: '10px',
            letterSpacing: '1.5px',
            padding: '4px 10px',
          }}
        >
          SAVE TO… {active ? '📁' : '▸'}
        </button>
        {active && (
          <>
            <span style={{ fontSize: '11px', fontFamily: 'var(--font-code, monospace)', color: 'var(--color-accent-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%', direction: 'rtl', textAlign: 'left' }} title={`${dir}${basename ? '/' + basename : ''}`}>
              {dir}{basename ? `/${basename}` : '/ (auto name)'}
            </span>
            <button onClick={clear} disabled={disabled} className="display-font" title="Clear — back to the default destination" style={{ background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '10px', padding: '3px 7px' }}>✕</button>
          </>
        )}
      </div>
      {!active && (
        <span style={{ fontSize: '9px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.4 }}>
          Default: alongside the source (an imported file would land in scratch, so you'll be prompted on run).
          A destination outside the workflow folder needs <strong>Unconfined media access</strong>.
        </span>
      )}
    </div>
  );
}
