import { useEffect, useRef, useState } from 'react';

// Phase 1 — Arco-managed skills CRUD dialog. Operator types Name +
// Description + Body, picks scope (project / global), and saves. The server
// writes <root>/.arco/skills/<slug>/SKILL.md with YAML frontmatter; the
// next primary turn picks the new manifest entry up automatically (no
// restart). Used for both create (no `slug` prop) and edit (slug + scope
// pre-supplied; body fetched on mount via /api/skills/body).

export interface SkillEditorTarget {
  scope: 'project' | 'global';
  slug?: string; // present on edit
}

interface Props {
  cwd: string; // workflow cwd; required for project scope, ignored for global
  target: SkillEditorTarget;
  onClose: () => void;
  onSaved: () => void; // parent re-fetches the catalog
}

export function SkillEditorDialog({ cwd, target, onClose, onSaved }: Props) {
  const isEdit = Boolean(target.slug);
  const [scope, setScope] = useState<'project' | 'global'>(target.scope);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  // DD8 — operator-only: withhold from the model manifest; operator inlines on pick.
  const [operatorOnly, setOperatorOnly] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // H35 — operator-triggered diagnostic audit of the current body.
  const [auditing, setAuditing] = useState(false);
  const [audit, setAudit] = useState<Array<{ severity: 'info' | 'warn'; kind: string; detail: string }> | null>(null);

  useEffect(() => {
    if (!isEdit) {
      // Create — focus the name field after the modal animates in.
      const t = setTimeout(() => nameRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
    // Edit — fetch the current body. Scope is fixed once an existing skill
    // is open (moving a skill across scopes would mean delete-then-create
    // and isn't supported in v1).
    const params = new URLSearchParams({
      scope: target.scope,
      slug: target.slug!,
    });
    if (target.scope === 'project') params.set('cwd', cwd);
    fetch(`/api/skills/body?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(errBody.error || res.statusText);
        }
        return res.json() as Promise<{ skill: { name: string; description: string; body: string; operatorOnly?: boolean } }>;
      })
      .then((data) => {
        setName(data.skill.name);
        setDescription(data.skill.description);
        setBody(data.skill.body);
        setOperatorOnly(Boolean(data.skill.operatorOnly));
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [isEdit, target.scope, target.slug, cwd]);

  const onAudit = async () => {
    if (auditing) return;
    setAuditing(true);
    setAudit(null);
    try {
      const res = await fetch('/api/skills/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      const data = (await res.json().catch(() => ({}))) as { findings?: Array<{ severity: 'info' | 'warn'; kind: string; detail: string }>; error?: string };
      if (!res.ok || data.error) throw new Error(data.error || res.statusText);
      setAudit(data.findings ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuditing(false);
    }
  };

  const onSave = async () => {
    if (saving) return;
    setError(null);
    if (!name.trim()) {
      setError('name required');
      return;
    }
    setSaving(true);
    try {
      const params = scope === 'project' ? `?cwd=${encodeURIComponent(cwd)}` : '';
      const res = await fetch(`/api/skills${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          ...(target.slug ? { slug: target.slug } : {}),
          name: name.trim(),
          description: description.trim(),
          body,
          operatorOnly,
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || res.statusText);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9300,
        padding: '20px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '560px',
          maxHeight: 'calc(calc(100vh / var(--ui-scale, 1)) - 80px)',
          overflowY: 'auto',
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-accent-primary-dim)',
          borderRadius: '6px',
          padding: '18px 22px',
          fontFamily: 'var(--font-body)',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span
            className="display-font"
            style={{ fontSize: '12px', letterSpacing: '3px', color: 'var(--color-accent-primary)' }}
          >
            {isEdit ? 'EDIT SKILL' : 'NEW SKILL'}
          </span>
          <button onClick={onClose} className="display-font" style={cancelBtnStyle}>
            CLOSE ✕
          </button>
        </div>

        {loading ? (
          <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)' }}>Loading…</div>
        ) : (
          <>
            <Field label="NAME">
              <input
                ref={nameRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                spellCheck={false}
                style={inputStyle}
                disabled={saving}
              />
            </Field>

            <Field label="DESCRIPTION">
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={240}
                spellCheck={false}
                style={inputStyle}
                placeholder="One-line summary the agent reads to decide when to apply this skill"
                disabled={saving}
              />
            </Field>

            <Field label="BODY">
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                spellCheck={false}
                rows={14}
                style={{ ...inputStyle, resize: 'vertical', minHeight: '180px', fontFamily: 'var(--font-body)' }}
                placeholder="The full SKILL.md body. The agent reads this on demand via its Read tool."
                disabled={saving}
              />
            </Field>

            <Field label="SCOPE">
              {isEdit ? (
                <span
                  className="display-font"
                  style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)' }}
                >
                  {scope === 'project' ? 'PROJECT' : 'GLOBAL'} (fixed — re-create the skill in the other scope to move it)
                </span>
              ) : (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <ScopePill
                    active={scope === 'project'}
                    onClick={() => setScope('project')}
                    disabled={!cwd}
                  >
                    PROJECT
                  </ScopePill>
                  <ScopePill active={scope === 'global'} onClick={() => setScope('global')}>
                    GLOBAL
                  </ScopePill>
                </div>
              )}
            </Field>

            <Field label="MODEL VISIBILITY">
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={operatorOnly}
                  onChange={(e) => setOperatorOnly(e.target.checked)}
                  disabled={saving}
                  style={{ marginTop: '2px' }}
                />
                <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
                  <strong style={{ color: 'var(--color-accent-primary-dim)' }}>Operator-only</strong> — withhold
                  this skill from the model's skills manifest (the agent is never told it exists). It stays
                  listed here and you inline its full body into a turn by picking it from the composer.
                </span>
              </label>
            </Field>

            {scope === 'project' && !cwd && (
              <div style={{ fontSize: '10px', color: 'var(--color-warning)' }}>
                No active workflow — switch to a tab with a working directory to save a project skill.
              </div>
            )}

            {error && (
              <div style={{ fontSize: '11px', color: 'var(--color-warning)', fontFamily: 'var(--font-body)' }}>
                {error}
              </div>
            )}

            {/* H35 — diagnostic audit findings (read-only; never gates save). */}
            {audit && (
              <div
                style={{
                  border: `1px solid ${audit.some((f) => f.severity === 'warn') ? 'var(--color-warning)' : 'var(--color-border-hairline)'}`,
                  borderRadius: '3px',
                  padding: '8px 10px',
                  background: 'var(--color-bg-sunken)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '5px',
                }}
              >
                <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)' }}>
                  AUDIT — DIAGNOSTIC ONLY (does not block save)
                </span>
                {audit.map((f, i) => (
                  <div key={i} style={{ fontSize: '10px', lineHeight: 1.45, color: f.severity === 'warn' ? 'var(--color-warning)' : 'var(--color-fg-muted)' }}>
                    {f.severity === 'warn' ? '⚠' : '✓'} <strong>{f.kind}</strong> — {f.detail}
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              <button
                onClick={onSave}
                disabled={saving || (scope === 'project' && !cwd)}
                className="display-font"
                style={{
                  ...primaryBtnStyle,
                  opacity: saving || (scope === 'project' && !cwd) ? 0.5 : 1,
                  cursor: saving ? 'default' : 'pointer',
                }}
              >
                {saving ? 'SAVING…' : 'SAVE'}
              </button>
              <button
                onClick={onAudit}
                disabled={auditing}
                className="display-font"
                style={{ ...cancelBtnStyle, opacity: auditing ? 0.5 : 1 }}
                title="Scan the body for invisible unicode + threat patterns (read-only diagnostic)"
              >
                {auditing ? 'AUDITING…' : 'AUDIT'}
              </button>
              <button onClick={onClose} disabled={saving} className="display-font" style={cancelBtnStyle}>
                CANCEL
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span
        className="display-font"
        style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)' }}
      >
        {label}
      </span>
      {children}
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
        padding: '6px 14px',
        background: active ? 'var(--color-accent-primary-a10)' : 'transparent',
        border: `1px solid ${active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
        borderRadius: '3px',
        color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: '10px',
        letterSpacing: '1.5px',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  background: 'var(--color-bg-sunken)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary)',
  fontSize: '11px',
  fontFamily: 'var(--font-body)',
  letterSpacing: '0.5px',
  boxSizing: 'border-box',
};

const primaryBtnStyle: React.CSSProperties = {
  flex: 1,
  padding: '8px 14px',
  background: 'var(--color-accent-primary-a10)',
  border: '1px solid var(--color-accent-primary)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary)',
  fontSize: '10px',
  letterSpacing: '2px',
};

const cancelBtnStyle: React.CSSProperties = {
  padding: '6px 14px',
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-fg-muted)',
  fontSize: '10px',
  letterSpacing: '1.5px',
  cursor: 'pointer',
};
