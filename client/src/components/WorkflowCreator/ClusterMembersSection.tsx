import { DEFAULT_CODEX_MODEL, MEMBER_TIERS, ROLE_PRESETS, presetForText } from '@arco/shared';
import type { ModelName, MemberTier, ClusterMemberProvider } from '@arco/shared';
import { effortsForModel } from '../../utils/format';
import { deriveDisplayNames } from './modelOptions';
import { useAppStore } from '../../stores/appStore';
import { CursorModelSelect } from '../CursorModelSelect';
import type { ClusterMembersSectionProps } from './types';

// 2026-05-11 — CLUSTER mode's per-member list. Collapsed-by-default summary
// rows; click [↓ edit] to expand into a full per-member editor (display name,
// provider, model, effort, role, tier, permissions, fast-mode, filter,
// output-style). Cluster fence: per-row provider picker shows Claude, Codex,
// and local providers that can receive Arco-injected peer tools.
//
// `claudeModelsForPicker` / `codexModelsForPicker` are passed in from the
// parent so per-row pickers use the same live-catalog list as the
// DEFAULTS group above. Keeps everything in one place — adding a new
// Claude model to the catalog updates both surfaces simultaneously.
export function ClusterMembersSection({
  members,
  onAddMember,
  onRemoveMember,
  onUpdateMember,
  claudeModelsForPicker,
  codexModelsForPicker,
  ollamaModelsForPicker,
  llamacppModelsForPicker,
  cursorModelsForPicker,
  claudeNativeCatalog,
  codexCatalog,
  codexAccounts,
  selectStyle,
  labelStyle,
  inputStyle,
  hintStyle,
}: ClusterMembersSectionProps) {
  const cursorCatalog = useAppStore((s) => s.cursorCatalog);
  const modelsFor = (provider: ClusterMemberProvider): { value: ModelName; label: string; subline?: string }[] => {
    if (provider === 'codex') return codexModelsForPicker;

    if (provider === 'ollama') return ollamaModelsForPicker;
    if (provider === 'llamacpp') return llamacppModelsForPicker;
    if (provider === 'cursor') return cursorModelsForPicker;
    return claudeModelsForPicker;
  };
  const dotSep = (
    <span style={{ color: 'var(--color-fg-muted)', opacity: 0.5, padding: '0 6px' }}>·</span>
  );
  return (
    <div data-help="creator.cluster-members" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label className="display-font" style={{ ...labelStyle, marginBottom: 0 }}>
          MEMBERS ({members.length})
        </label>
        <button
          onClick={onAddMember}
          className="display-font"
          style={{
            padding: '4px 12px',
            background: 'transparent',
            border: '1px solid var(--color-accent-secondary-dim)',
            borderRadius: '3px',
            color: 'var(--color-accent-secondary)',
            cursor: 'pointer',
            fontSize: '10px',
            letterSpacing: '1px',
          }}
        >
          + ADD MEMBER
        </button>
      </div>

      {members.length < 2 && (
        <div style={{ ...hintStyle, color: 'var(--color-warning)' }}>
          Cluster requires at least 2 members.
        </div>
      )}

      <div
        className="display-font"
        style={{ fontSize: '9px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px', lineHeight: 1.4 }}
      >
        Clusters support Claude, Codex, and local peer-tool members.
      </div>

      {/* Derived names threaded into each row so the collapsed summary
          previews the same name the cluster will spawn with. */}
      {members.map((m, i, all) => {
        const derived = deriveDisplayNames(all);
        const summaryName = derived[i]!;
        const tierLabel = m.tier ? m.tier.toUpperCase() : '—';
        const matchedPreset = presetForText(m.role);
        const roleLabel = matchedPreset
          ? matchedPreset.label
          : m.role.trim().length > 0
            ? (m.role.length > 28 ? `${m.role.slice(0, 28)}…` : m.role)
            : '—';
        const modelLabel = String(m.model).toUpperCase();
        const account = m.provider === 'codex' ? codexAccounts.find((a) => a.id === m.providerAccountRef) : undefined;
        const accountLabel = account ? (account.shortLabel || account.label || account.id).toUpperCase() : undefined;
        return (
          <div
            key={m.key}
            style={{
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '4px',
              background: 'var(--color-bg-sunken)',
            }}
          >
            {!m.expanded ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '8px 12px',
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: '11px',
                }}
              >
                <span style={{ color: 'var(--color-accent-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 0 auto' }}>
                  {summaryName}
                </span>
                {dotSep}
                <span style={{ color: 'var(--color-fg-muted)' }}>{m.provider.toUpperCase()}</span>
                {accountLabel && (
                  <>
                    {dotSep}
                    <span style={{ color: 'var(--color-accent-secondary)' }}>{accountLabel}</span>
                  </>
                )}
                {dotSep}
                <span style={{ color: 'var(--color-fg-muted)' }}>{modelLabel}</span>
                {dotSep}
                <span style={{ color: 'var(--color-fg-muted)' }}>{(m.effort ?? 'medium').toUpperCase()}</span>
                {dotSep}
                <span style={{ color: 'var(--color-fg-muted)' }}>{roleLabel}</span>
                {dotSep}
                <span style={{ color: 'var(--color-fg-muted)' }}>{tierLabel}</span>
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => onUpdateMember(m.key, { expanded: true })}
                  className="display-font"
                  style={{
                    padding: '3px 8px',
                    background: 'transparent',
                    border: '1px solid var(--color-border-hairline)',
                    borderRadius: '3px',
                    color: 'var(--color-accent-secondary-dim)',
                    cursor: 'pointer',
                    fontSize: '10px',
                    letterSpacing: '0.5px',
                    marginRight: '6px',
                  }}
                  title="Expand to edit"
                >
                  ↓ EDIT
                </button>
                <button
                  onClick={() => onRemoveMember(m.key)}
                  className="display-font"
                  style={{
                    padding: '3px 8px',
                    background: 'transparent',
                    border: '1px solid var(--color-border-hairline)',
                    borderRadius: '3px',
                    color: 'var(--color-warning)',
                    cursor: 'pointer',
                    fontSize: '10px',
                    letterSpacing: '0.5px',
                  }}
                  title="Remove member"
                >
                  × REMOVE
                </button>
              </div>
            ) : (
              <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="display-font" style={{ color: 'var(--color-accent-primary)', fontSize: '11px', letterSpacing: '1.5px' }}>
                    {summaryName}
                  </span>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      onClick={() => onUpdateMember(m.key, { expanded: false })}
                      className="display-font"
                      style={{
                        padding: '3px 8px',
                        background: 'transparent',
                        border: '1px solid var(--color-border-hairline)',
                        borderRadius: '3px',
                        color: 'var(--color-accent-secondary-dim)',
                        cursor: 'pointer',
                        fontSize: '10px',
                        letterSpacing: '0.5px',
                      }}
                    >
                      ↑ COLLAPSE
                    </button>
                    <button
                      onClick={() => onRemoveMember(m.key)}
                      className="display-font"
                      style={{
                        padding: '3px 8px',
                        background: 'transparent',
                        border: '1px solid var(--color-border-hairline)',
                        borderRadius: '3px',
                        color: 'var(--color-warning)',
                        cursor: 'pointer',
                        fontSize: '10px',
                        letterSpacing: '0.5px',
                      }}
                    >
                      × REMOVE
                    </button>
                  </div>
                </div>

                {/* DISPLAY NAME */}
                <div>
                  <label className="display-font" style={labelStyle}>DISPLAY NAME</label>
                  <input
                    type="text"
                    value={m.displayName}
                    onChange={(e) => onUpdateMember(m.key, { displayName: e.target.value.slice(0, 64) })}
                    placeholder={(() => {
                      const preset = presetForText(m.role);
                      if (preset) return `(optional — defaults to "${preset.label.charAt(0)}${preset.label.slice(1).toLowerCase()}")`;
                      const role = m.role.trim();
                      if (role.length > 0) return `(optional — defaults to "${role.length > 24 ? role.slice(0, 24) + '…' : role}")`;
                      return `(optional — defaults to "Member #${i + 1}")`;
                    })()}
                    style={inputStyle}
                  />
                </div>

                {/* PROVIDER */}
                <div>
                  <label className="display-font" style={labelStyle}>PROVIDER</label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(86px, 1fr))', gap: '6px' }}>
                    {(['claude', 'codex', 'ollama', 'llamacpp', 'cursor'] as ClusterMemberProvider[]).map((p) => (
                      <button
                        key={p}
                        onClick={() => {
                          if (p === m.provider) return;
                          const nextModel: ModelName = modelsFor(p)[0]?.value
                            ?? (p === 'codex' ? DEFAULT_CODEX_MODEL : p === 'claude' ? 'opus' : p === 'cursor' ? 'auto' as ModelName : '' as ModelName);
                          onUpdateMember(m.key, {
                            provider: p,
                            model: nextModel,
                            providerAccountRef: p === 'codex' ? (m.providerAccountRef ?? codexAccounts[0]?.id) : undefined,
                          });
                        }}
                        style={{ ...selectStyle(m.provider === p), flex: 1, textAlign: 'center', padding: '6px 8px' }}
                      >
                        {p === 'llamacpp' ? 'LLAMA' : p.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>

                {m.provider === 'codex' && codexAccounts.length > 0 && (
                  <div>
                    <label className="display-font" style={labelStyle}>ACCOUNT</label>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {codexAccounts.map((acct) => {
                        const short = (acct.shortLabel || acct.label || acct.id).slice(0, 4).toUpperCase();
                        return (
                          <button
                            key={acct.id}
                            onClick={() => onUpdateMember(m.key, { providerAccountRef: acct.id })}
                            style={{ ...selectStyle(m.providerAccountRef === acct.id), padding: '6px 10px' }}
                          >
                            {acct.label.toUpperCase()} [{short}]
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* MODEL */}
                <div>
                  <label className="display-font" style={labelStyle}>MODEL</label>
                  {m.provider === 'cursor' && cursorCatalog?.models?.length ? (
                    // Cursor: family × effort × flags (effort baked into the id).
                    <CursorModelSelect
                      value={String(m.model)}
                      onChange={(id) => onUpdateMember(m.key, { model: id as ModelName })}
                      selectStyle={inputStyle}
                    />
                  ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))', gap: '6px' }}>
                    {modelsFor(m.provider).length === 0 && (
                      <div className="display-font" style={{ padding: '6px 8px', border: '1px dashed var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-warning)', fontSize: '10px', letterSpacing: '0.5px' }}>
                        No models available for this provider.
                      </div>
                    )}
                    {modelsFor(m.provider).map((mod) => (
                      <button
                        key={mod.value}
                        onClick={() => onUpdateMember(m.key, { model: mod.value })}
                        style={{ ...selectStyle(m.model === mod.value), textAlign: 'center', padding: '7px 8px', minHeight: '54px' }}
                        title={mod.subline}
                      >
                        <div style={{ fontSize: '11px', lineHeight: 1.25, whiteSpace: 'normal' }}>{mod.label}</div>
                        {mod.subline && (
                          <div style={{ fontSize: '8px', color: 'var(--color-fg-muted)', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {mod.subline}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                  )}
                </div>

                {/* EFFORT */}
                <div>
                  <label className="display-font" style={labelStyle}>EFFORT</label>
                  {(() => {
                    const honored = effortsForModel(m.provider, m.model, claudeNativeCatalog, codexCatalog);
                    if (honored.length === 0) {
                      return (
                        <div className="display-font" style={{ padding: '6px 8px', border: '1px dashed var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '0.5px' }}>
                          {m.provider === 'cursor' ? 'Cursor bakes effort into the model id — set it in the MODEL picker above.' : 'Provider does not honor effort.'}
                        </div>
                      );
                    }
                    return (
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {honored.map((e) => (
                          <button
                            key={e}
                            onClick={() => onUpdateMember(m.key, { effort: e })}
                            style={{ ...selectStyle(m.effort === e), flex: 1, textAlign: 'center', padding: '6px 8px' }}
                          >
                            {(e as string).toUpperCase()}
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                </div>

                {/* ROLE — preset pills + custom text. System stores role as
                    free-form text; presets are canonical strings the LLM
                    director reads literally. Click a pill to fill the text
                    input; type for custom roles. */}
                <div>
                  <label className="display-font" style={labelStyle}>ROLE</label>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '6px' }}>
                    {ROLE_PRESETS.map((p) => {
                      const active = presetForText(m.role)?.key === p.key;
                      return (
                        <button
                          key={p.key}
                          onClick={() => onUpdateMember(m.key, { role: active ? '' : p.text })}
                          title={p.text}
                          style={{ ...selectStyle(active), padding: '5px 10px', fontSize: '10px', letterSpacing: '1px' }}
                          className="display-font"
                        >
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                  <input
                    type="text"
                    value={m.role}
                    onChange={(e) => onUpdateMember(m.key, { role: e.target.value.slice(0, 120) })}
                    placeholder="(optional — pick a preset above or type a custom role, ≤120 chars)"
                    style={inputStyle}
                  />
                </div>

                {/* FOCUS — per-instance sub-specialty. Free-form text that
                    complements role/tier: where role/tier describe the kind
                    of work this member does, focus describes what THIS
                    specific member specializes in. Director reads it via
                    peer_list to disambiguate same-role peers. */}
                <div>
                  <label className="display-font" style={labelStyle}>FOCUS</label>
                  <input
                    type="text"
                    value={m.focus}
                    onChange={(e) => onUpdateMember(m.key, { focus: e.target.value.slice(0, 160) })}
                    placeholder="(optional — sub-specialty, e.g. 'React frontend' or 'database perf', ≤160 chars)"
                    style={inputStyle}
                  />
                </div>

                {/* TIER */}
                <div>
                  <label className="display-font" style={labelStyle}>TIER</label>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {([...MEMBER_TIERS, ''] as const).map((t) => (
                      <button
                        key={t || 'unset'}
                        onClick={() => onUpdateMember(m.key, { tier: (t as MemberTier | '') })}
                        style={{ ...selectStyle(m.tier === t), flex: 1, textAlign: 'center', padding: '6px 8px' }}
                      >
                        {t ? t.toUpperCase() : 'UNSET'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* PERMISSIONS */}
                <div>
                  <label className="display-font" style={labelStyle}>PERMISSIONS</label>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button onClick={() => onUpdateMember(m.key, { skipPermissions: true })} style={{ ...selectStyle(m.skipPermissions), flex: 1, textAlign: 'center', padding: '6px 8px' }}>AUTO</button>
                    <button onClick={() => onUpdateMember(m.key, { skipPermissions: false })} style={{ ...selectStyle(!m.skipPermissions), flex: 1, textAlign: 'center', padding: '6px 8px' }}>SAFE</button>
                  </div>
                </div>

                {/* FAST MODE (claude only) */}
                {m.provider === 'claude' && (
                  <div>
                    <label className="display-font" style={labelStyle}>FAST MODE</label>
                    <button
                      onClick={() => onUpdateMember(m.key, { fastMode: !m.fastMode })}
                      style={{ ...selectStyle(m.fastMode), width: '100%', textAlign: 'center', padding: '6px 8px' }}
                    >
                      {m.fastMode ? 'ON' : 'OFF'}
                    </button>
                  </div>
                )}

                {/* TOOL-RESULT FILTER (claude only) */}
                {m.provider === 'claude' && (
                  <div>
                    <label className="display-font" style={labelStyle}>TOOL-RESULT FILTER</label>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {(['off', 'conservative', 'aggressive'] as const).map((opt) => (
                        <button
                          key={opt}
                          onClick={() => onUpdateMember(m.key, { efficiencyToolFilter: opt })}
                          style={{ ...selectStyle(m.efficiencyToolFilter === opt), flex: 1, textAlign: 'center', padding: '6px 8px' }}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* OUTPUT STYLE (Claude Native, Codex app-server) */}
                {(m.provider === 'claude' || m.provider === 'codex') && (
                  <div>
                    <label className="display-font" style={labelStyle}>OUTPUT STYLE</label>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {(['normal', 'lite', 'terse'] as const).map((opt) => (
                        <button
                          key={opt}
                          onClick={() => onUpdateMember(m.key, { outputStyle: opt })}
                          style={{ ...selectStyle(m.outputStyle === opt), flex: 1, textAlign: 'center', padding: '6px 8px' }}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
