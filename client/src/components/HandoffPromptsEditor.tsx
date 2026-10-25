import { useEffect, useState } from 'react';

// Phase 3 (operator-features) — Handoff prompt editor.
//
// Two cards (one per mode), each with: scope toggle (project / global), edit
// textarea seeded from the currently-saved override or the default template,
// validation banner (advisory; save not blocked), [SAVE] / [RESET TO DEFAULT].
//
// Server: GET /api/handoff-prompts returns defaults + project/global bodies +
// "which scope is winning"; POST writes one (scope, mode); DELETE reverts.

type Mode = 'original-worker' | 'fresh-summarizer' | 'ollama-compaction';
type Scope = 'project' | 'global';

interface HandoffPromptsResponse {
  defaults: Record<Mode, string>;
  project: Record<Mode, string | null>;
  global: Record<Mode, string | null>;
  effective: Record<Mode, { source: string; sourcePath: string | null }>;
}

const MODE_LABEL: Record<Mode, string> = {
  'original-worker': 'ORIGINAL-WORKER REFLECTION',
  'fresh-summarizer': 'FRESH-SUMMARIZER FRAMING',
  'ollama-compaction': 'OLLAMA COMPACTION SUMMARY FRAMING',
};

const MODE_DESCRIPTION: Record<Mode, string> = {
  'original-worker': 'The reflection prompt the primary reads when handing off via --resume. Must instruct the agent to Write to {{handoffPath}} and end with [HANDOFF_COMPLETE].',
  'fresh-summarizer': 'The framing prepended to the rendered transcript when an ephemeral summarizer worker writes the handoff (lower-fidelity fallback path). The worker writes the file from its collected output — no Write tool involved.',
  'ollama-compaction': 'The system framing for Ollama auto-compaction: when the context window fills, the utility model summarizes the older half of the transcript using this prompt. Plain prose framing — no template variables.',
};

interface Props {
  cwd: string;
}

export function HandoffPromptsEditor({ cwd }: Props) {
  const [data, setData] = useState<HandoffPromptsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    try {
      const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
      const res = await fetch(`/api/handoff-prompts${params}`);
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || res.statusText);
      }
      const body = (await res.json()) as HandoffPromptsResponse;
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => { void refresh(); }, [cwd]);

  return (
    <div data-help="settings.handoff-prompts">
      <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>
        HANDOFF PROMPTS
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: '1.6', marginBottom: '8px' }}>
        Override the prompts the Handoff primitive uses. Project overrides live at <code>{'<cwd>/.archon/handoff.prompt.md'}</code> and <code>{'.archon/handoff.summarizer.prompt.md'}</code>; global at <code>~/.archon/</code>. Project beats global beats default. Variables: <code>{'{{cwd}}'}</code>, <code>{'{{wfid}}'}</code>, <code>{'{{handoffPath}}'}</code>, <code>{'{{seedPrefix}}'}</code>.
      </div>
      {error && (
        <div style={{ fontSize: '10px', color: 'var(--color-warning)', fontFamily: 'var(--font-body)', marginBottom: '6px' }}>
          {error}
        </div>
      )}
      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {(['original-worker', 'fresh-summarizer', 'ollama-compaction'] as Mode[]).map((mode) => (
            <PromptCard
              key={mode}
              mode={mode}
              cwd={cwd}
              defaults={data.defaults}
              project={data.project[mode]}
              global={data.global[mode]}
              effective={data.effective[mode]}
              onChanged={() => { void refresh(); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface PromptCardProps {
  mode: Mode;
  cwd: string;
  defaults: Record<Mode, string>;
  project: string | null;
  global: string | null;
  effective: { source: string; sourcePath: string | null };
  onChanged: () => void;
}

function PromptCard({ mode, cwd, defaults, project, global, effective, onChanged }: PromptCardProps) {
  const [scope, setScope] = useState<Scope>(cwd ? 'project' : 'global');
  // Draft = the body currently in the editor for the chosen scope. Initial
  // value is the saved override (if any) or the default template (so the
  // operator sees something concrete to edit instead of a blank box that
  // would, on save, deactivate the override). Re-seeded when scope flips.
  const initialFor = (s: Scope): string => {
    const saved = s === 'project' ? project : global;
    return saved ?? defaults[mode];
  };
  const [draft, setDraft] = useState<string>(initialFor(scope));
  const [savedOverride, setSavedOverride] = useState<string | null>(scope === 'project' ? project : global);
  const [saving, setSaving] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [statusLine, setStatusLine] = useState<string | null>(null);

  // Re-seed the draft when scope flips OR when an external refresh delivers
  // a new project/global body (e.g. another tab saved). Keeps the editor in
  // lockstep with disk truth without trampling an in-progress edit when the
  // saved value is unchanged.
  useEffect(() => {
    setDraft(initialFor(scope));
    setSavedOverride(scope === 'project' ? project : global);
    setWarnings([]);
    setStatusLine(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, project, global]);

  // Live validation — purely client-side, mirrors the server's checks. Save
  // is never blocked; this just primes the operator.
  useEffect(() => {
    if (mode !== 'original-worker') {
      setWarnings([]);
      return;
    }
    const w: string[] = [];
    if (!draft.includes('{{handoffPath}}')) {
      w.push('Missing `{{handoffPath}}` — the agent will not know where to write the handoff document.');
    }
    if (!draft.includes('[HANDOFF_COMPLETE]')) {
      w.push('Missing `[HANDOFF_COMPLETE]` sentinel — without it the reflection turn has no clean end-of-output marker.');
    }
    setWarnings(w);
  }, [draft, mode]);

  const onSave = async () => {
    if (saving) return;
    if (scope === 'project' && !cwd) return;
    setSaving(true);
    setStatusLine(null);
    try {
      const params = scope === 'project' ? `?cwd=${encodeURIComponent(cwd)}` : '';
      const res = await fetch(`/api/handoff-prompts${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, mode, body: draft }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || res.statusText);
      }
      setStatusLine('saved.');
      onChanged();
    } catch (err) {
      setStatusLine(`save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const onReset = async () => {
    if (saving) return;
    if (scope === 'project' && !cwd) return;
    if (savedOverride === null) {
      // Nothing on disk — just snap the editor back to the default.
      setDraft(defaults[mode]);
      setStatusLine('already at default.');
      return;
    }
    setSaving(true);
    setStatusLine(null);
    try {
      const params = new URLSearchParams({ scope, mode });
      if (scope === 'project') params.set('cwd', cwd);
      const res = await fetch(`/api/handoff-prompts?${params.toString()}`, { method: 'DELETE' });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || res.statusText);
      }
      setDraft(defaults[mode]);
      setStatusLine('reverted to default.');
      onChanged();
    } catch (err) {
      setStatusLine(`revert failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const isOverridden = savedOverride !== null;
  const winning = effective.source;
  const winningLabel = winning === 'default' ? 'DEFAULT'
    : winning === 'project' ? 'PROJECT'
    : winning === 'global' ? 'GLOBAL'
    : winning.toUpperCase();

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '10px 12px',
        border: '1px solid var(--color-border-hairline)',
        borderRadius: '4px',
        background: 'var(--color-bg-sunken)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
        <span className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary)' }}>
          {MODE_LABEL[mode]}
        </span>
        <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)' }}>
          ACTIVE: {winningLabel}
        </span>
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: '1.5' }}>
        {MODE_DESCRIPTION[mode]}
      </div>

      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)', minWidth: '40px' }}>
          SCOPE:
        </span>
        <ScopePill active={scope === 'project'} onClick={() => setScope('project')} disabled={!cwd}>
          PROJECT{project !== null ? ' •' : ''}
        </ScopePill>
        <ScopePill active={scope === 'global'} onClick={() => setScope('global')}>
          GLOBAL{global !== null ? ' •' : ''}
        </ScopePill>
        <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', marginLeft: '4px' }}>
          {isOverridden ? 'override exists' : '(default — saving creates an override)'}
        </span>
      </div>

      {scope === 'project' && !cwd && (
        <div style={{ fontSize: '10px', color: 'var(--color-warning)', fontFamily: 'var(--font-body)' }}>
          No active workflow — switch to a tab with a working directory to save a project override.
        </div>
      )}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        rows={14}
        style={{
          width: '100%',
          padding: '8px 10px',
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-border-hairline)',
          borderRadius: '3px',
          color: 'var(--color-accent-primary)',
          fontSize: '11px',
          fontFamily: 'var(--font-body)',
          lineHeight: '1.5',
          resize: 'vertical',
          boxSizing: 'border-box',
          minHeight: '180px',
        }}
        disabled={saving || (scope === 'project' && !cwd)}
      />

      {warnings.length > 0 && (
        <div
          style={{
            padding: '6px 10px',
            border: '1px solid var(--color-warning-dim)',
            borderRadius: '3px',
            background: 'var(--color-warning-a08, rgba(255, 180, 60, 0.06))',
            display: 'flex',
            flexDirection: 'column',
            gap: '3px',
          }}
        >
          {warnings.map((w, i) => (
            <div key={i} style={{ fontSize: '10px', color: 'var(--color-warning)', fontFamily: 'var(--font-body)', lineHeight: '1.5' }}>
              ⚠ {w}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button
          onClick={() => { void onSave(); }}
          disabled={saving || (scope === 'project' && !cwd)}
          className="display-font"
          style={{
            padding: '6px 14px',
            background: 'var(--color-accent-primary-a10)',
            border: '1px solid var(--color-accent-primary)',
            borderRadius: '3px',
            color: 'var(--color-accent-primary)',
            cursor: saving ? 'default' : 'pointer',
            fontSize: '10px',
            letterSpacing: '1.5px',
            opacity: saving || (scope === 'project' && !cwd) ? 0.6 : 1,
          }}
        >
          {saving ? 'SAVING…' : 'SAVE'}
        </button>
        <button
          onClick={() => { void onReset(); }}
          disabled={saving}
          className="display-font"
          style={{
            padding: '6px 14px',
            background: 'transparent',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: 'var(--color-fg-muted)',
            cursor: saving ? 'default' : 'pointer',
            fontSize: '10px',
            letterSpacing: '1.5px',
          }}
          title="Delete the override at this scope and revert the editor to the default template"
        >
          RESET TO DEFAULT
        </button>
        {statusLine && (
          <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
            {statusLine}
          </span>
        )}
      </div>
    </div>
  );
}

function ScopePill({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="display-font"
      style={{
        padding: '4px 10px',
        background: active ? 'var(--color-accent-primary-a10)' : 'transparent',
        border: `1px solid ${active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
        borderRadius: '3px',
        color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: '9px',
        letterSpacing: '1.5px',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}
