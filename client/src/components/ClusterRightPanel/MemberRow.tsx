import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { ROLE_PRESETS, presetForText, MEMBER_TIERS } from '@archon/shared';
import type { ClusterStatePayload, MemberTier } from '@archon/shared';
import { ReplaceMemberDialog } from './ReplaceMemberDialog';

// Phase 2.6 — operator-set role hint cap, mirrored from the server enum in
// clusterStore.MEMBER_ROLE_MAX.
const ROLE_MAX = 120;

// Phase 2.6 — single member row in the Members sub-tab. Click the name
// to focus that member's tab; click the role pencil to edit the role hint
// inline. Empty / whitespace clears. Free-form ≤120 chars (server clamps).
export function MemberRow({
  cluster,
  member,
  memberName,
  onFocus,
  onSetRole,
  onSetTier,
  onSetFocus,
  onDetach,
}: {
  cluster: ClusterStatePayload;
  member: ClusterStatePayload['members'][number];
  memberName: string;
  onFocus?: (workflowId: string) => void;
  onSetRole?: (clusterId: string, workflowId: string, role: string) => void;
  onSetTier?: (clusterId: string, workflowId: string, tier: MemberTier | null) => void;
  onSetFocus?: (clusterId: string, workflowId: string, focus: string | null) => void;
  onDetach?: (clusterId: string, workflowId: string) => void;
}) {
  // Two distinct UI modes share the role surface:
  //   popoverOpen → preset list (5 presets + CLEAR + Custom…) anchored to SET
  //   editingCustom → inline text editor (the pre-popover affordance, kept
  //                   as the "Custom…" escape hatch).
  // Esc / click-outside dismisses the popover. Picking a preset commits +
  // closes. Custom… drops into the inline editor.
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [editingCustom, setEditingCustom] = useState(false);
  const [roleDraft, setRoleDraft] = useState(member.role ?? '');
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // 2026-05-11 — focus (sub-specialty) inline editor. Click to expand the
  // single-line summary into an editable input; ↵ commits, Esc cancels.
  const [focusEditing, setFocusEditing] = useState(false);
  const [focusDraft, setFocusDraft] = useState(member.focus ?? '');
  const [replaceOpen, setReplaceOpen] = useState(false);

  // F5 — per-member rename. Pencil-edit toggles inline input pre-filled
  // with the operator-set name (empty if not set, so the placeholder shows
  // the wfid prefix). ↵ commits via the store's wsSendRaw escape hatch
  // (renameWorkflow lives on the App.tsx useWebSocket hook return, not
  // threaded through this panel); Esc cancels; empty + ↵ clears the
  // override so the server falls back to the wfid prefix.
  const wsSendRaw = useAppStore((s) => s.wsSendRaw);
  const storedName = useAppStore((s) => s.jobs[member.workflowId]?.config.name ?? '');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  // Pre-fill only when the stored name isn't the wfid-prefix fallback; the
  // server-side rename clears the override by sending empty, so showing
  // "abc12345" as the draft (an editable copy of the fallback) would
  // confuse "clear" vs "name happens to match prefix". Compare
  // case-insensitively because `WorkflowConfig.name` is operator-typed
  // free text but the fallback is the literal prefix.
  const wfPrefix = member.workflowId.slice(0, 8);
  const hasOverride = storedName.trim().length > 0 && storedName.trim().toLowerCase() !== wfPrefix.toLowerCase();
  const currentName = hasOverride ? storedName : '';
  useEffect(() => {
    if (!renameOpen) setRenameDraft(currentName);
  }, [currentName, renameOpen]);
  const commitRename = () => {
    if (!wsSendRaw) return;
    wsSendRaw({ type: 'rename_workflow', workflowId: member.workflowId, name: renameDraft });
    setRenameOpen(false);
  };

  // Re-sync the draft when the upstream role changes while not editing.
  useEffect(() => {
    if (!editingCustom) setRoleDraft(member.role ?? '');
  }, [member.role, editingCustom]);

  // Click-outside / Esc closes the preset popover. Active only while open
  // so the listener doesn't leak.
  useEffect(() => {
    if (!popoverOpen) return;
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopoverOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [popoverOpen]);

  const commitCustom = () => {
    onSetRole?.(cluster.clusterId, member.workflowId, roleDraft);
    setEditingCustom(false);
  };
  const commitPreset = (text: string) => {
    onSetRole?.(cluster.clusterId, member.workflowId, text);
    setPopoverOpen(false);
  };
  const matchedPreset = member.role ? presetForText(member.role) : undefined;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '8px 10px',
        border: '1px solid var(--color-border-hairline)',
        fontSize: '11px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <div
          role={!renameOpen && onFocus ? 'button' : undefined}
          tabIndex={!renameOpen && onFocus ? 0 : undefined}
          data-help="cluster.right-panel.member-focus"
          onClick={() => {
            if (!renameOpen) onFocus?.(member.workflowId);
          }}
          onKeyDown={(e) => {
            if (renameOpen || !onFocus) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onFocus(member.workflowId);
            }
          }}
          className="display-font"
          style={{
            flex: 1,
            textAlign: 'left',
            background: 'transparent',
            border: 'none',
            color: 'var(--color-fg)',
            cursor: onFocus ? 'pointer' : 'default',
            padding: 0,
            fontSize: '11px',
            letterSpacing: '0.5px',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
            outline: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {renameOpen ? (
              <input
                autoFocus
                value={renameDraft}
                placeholder={member.workflowId.slice(0, 8)}
                onChange={(e) => setRenameDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commitRename();
                  else if (e.key === 'Escape') { setRenameDraft(currentName); setRenameOpen(false); }
                }}
                maxLength={64}
                style={{
                  flex: 1,
                  background: 'var(--color-bg)',
                  color: 'var(--color-fg)',
                  border: '1px solid var(--color-accent-primary)',
                  padding: '2px 5px',
                  fontSize: '11px',
                  fontFamily: 'var(--font-code)',
                }}
              />
            ) : (
              <span>{member.displayName}</span>
            )}
            {!renameOpen && (
              <span style={{ color: member.status === 'busy' ? 'var(--color-warning)' : 'var(--color-accent-primary)', fontSize: '10px' }}>
                {member.status.toUpperCase()}
              </span>
            )}
            {!renameOpen && member.tier && (
              <span
                className="display-font"
                title={`Builder tier: ${member.tier}. Visible to peers via peer_list.`}
                data-help="cluster.right-panel.tier-badge"
                style={{
                  padding: '1px 5px',
                  border: '1px solid var(--color-border-hairline)',
                  color: 'var(--color-fg-muted)',
                  fontSize: '9px',
                  letterSpacing: '1px',
                  background: 'transparent',
                }}
              >
                {member.tier.toUpperCase()}
              </span>
            )}
            {!renameOpen && member.accessMode && member.accessMode !== 'standard' && (
              <span
                className="display-font"
                data-help="cluster.member-access"
                title={member.accessMode === 'isolated'
                  ? 'Private scratch workspace; mailbox-only cluster access'
                  : 'Project-visible, but mailbox-only cluster access'}
                style={{
                  padding: '1px 5px',
                  border: '1px solid var(--color-accent-secondary)',
                  color: 'var(--color-accent-secondary)',
                  fontSize: '9px',
                  letterSpacing: '1px',
                }}
              >
                {member.accessMode.toUpperCase()}
              </span>
            )}
          </div>
          {!renameOpen && (
            <div style={{ color: 'var(--color-fg-muted)', fontSize: '10px' }}>
              {memberName}
            </div>
          )}
        </div>
        {wsSendRaw && (
          renameOpen ? (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); commitRename(); }}
                className="display-font"
                style={{
                  padding: '3px 8px',
                  background: 'var(--color-accent-primary)',
                  border: 'none',
                  color: 'var(--color-bg)',
                  cursor: 'pointer',
                  fontSize: '9px',
                  letterSpacing: '1px',
                }}
              >
                SAVE
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setRenameDraft(currentName); setRenameOpen(false); }}
                className="display-font"
                style={{
                  padding: '3px 6px',
                  background: 'transparent',
                  border: '1px solid var(--color-border-hairline)',
                  color: 'var(--color-fg-muted)',
                  cursor: 'pointer',
                  fontSize: '9px',
                  letterSpacing: '1px',
                }}
              >
                ESC
              </button>
            </>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); setRenameDraft(currentName); setRenameOpen(true); }}
              data-help="cluster.right-panel.rename"
              className="display-font"
              style={{
                padding: '2px 6px',
                background: 'transparent',
                border: '1px solid var(--color-border-hairline)',
                color: 'var(--color-fg-muted)',
                cursor: 'pointer',
                fontSize: '9px',
                letterSpacing: '1px',
              }}
              title="Rename this workflow (empty clears to wfid prefix)"
            >
              RENAME
            </button>
          )
        )}
      </div>

      {(wsSendRaw || onDetach) && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
          {wsSendRaw && (
            <button
              onClick={() => setReplaceOpen((v) => !v)}
              data-help="cluster.member-replace"
              className="display-font"
              style={{
                padding: '2px 6px',
                background: replaceOpen ? 'var(--color-accent-primary-a10)' : 'transparent',
                border: '1px solid var(--color-border-hairline)',
                color: 'var(--color-accent-primary)',
                cursor: 'pointer',
                fontSize: '9px',
                letterSpacing: '1px',
              }}
              title="Replace this slot with a new workflow and provider session"
            >
              REPLACE
            </button>
          )}
          {onDetach && (
          <button
            onClick={() => {
              const ok = window.confirm(
                `Detach ${member.displayName} from this cluster?\n\nThe workflow's history is preserved on disk; the next turn won't see peer tools. Same wire as the bottom-row × — single confirm, single click.`,
              );
              if (ok) onDetach(cluster.clusterId, member.workflowId);
            }}
            className="display-font"
            style={{
              padding: '2px 6px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              color: 'var(--color-warning)',
              cursor: 'pointer',
              fontSize: '9px',
              letterSpacing: '1px',
            }}
            title="Detach this member from the cluster (workflow history preserved)"
          >
            DETACH
          </button>
          )}
        </div>
      )}
      {replaceOpen && (
        <ReplaceMemberDialog cluster={cluster} member={member} onClose={() => setReplaceOpen(false)} />
      )}

      {onSetRole && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px', position: 'relative' }}>
          <span style={{ color: 'var(--color-fg-muted)', letterSpacing: '1px' }} className="display-font">
            ROLE
          </span>
          {editingCustom ? (
            <>
              <input
                autoFocus
                value={roleDraft}
                placeholder="free-form ≤120 chars"
                maxLength={ROLE_MAX}
                onChange={(e) => setRoleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { commitCustom(); }
                  else if (e.key === 'Escape') { setRoleDraft(member.role ?? ''); setEditingCustom(false); }
                }}
                style={{
                  flex: 1,
                  background: 'var(--color-bg)',
                  color: 'var(--color-fg)',
                  border: '1px solid var(--color-accent-primary)',
                  padding: '3px 5px',
                  fontSize: '10px',
                  fontFamily: 'var(--font-code)',
                }}
              />
              <button
                onClick={commitCustom}
                className="display-font"
                style={{
                  padding: '3px 8px',
                  background: 'var(--color-accent-primary)',
                  border: 'none',
                  color: 'var(--color-bg)',
                  cursor: 'pointer',
                  fontSize: '9px',
                  letterSpacing: '1px',
                }}
              >
                SAVE
              </button>
              <button
                onClick={() => { setRoleDraft(member.role ?? ''); setEditingCustom(false); }}
                className="display-font"
                style={{
                  padding: '3px 6px',
                  background: 'transparent',
                  border: '1px solid var(--color-border-hairline)',
                  color: 'var(--color-fg-muted)',
                  cursor: 'pointer',
                  fontSize: '9px',
                  letterSpacing: '1px',
                }}
              >
                ESC
              </button>
            </>
          ) : (
            <>
              <span
                style={{
                  flex: 1,
                  color: member.role ? 'var(--color-fg)' : 'var(--color-fg-muted)',
                  fontStyle: member.role ? 'normal' : 'italic',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={member.role ?? undefined}
              >
                {matchedPreset ? matchedPreset.label : (member.role ?? 'none')}
              </span>
              <button
                onClick={() => setPopoverOpen((v) => !v)}
                data-help={member.role ? 'cluster.right-panel.role-edit' : 'cluster.right-panel.role-set'}
                className="display-font"
                style={{
                  padding: '2px 6px',
                  background: popoverOpen ? 'var(--color-accent-primary-a06)' : 'transparent',
                  border: '1px solid ' + (popoverOpen ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
                  color: popoverOpen ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                  cursor: 'pointer',
                  fontSize: '9px',
                  letterSpacing: '1px',
                }}
                title="Edit role hint"
              >
                {member.role ? 'EDIT' : 'SET'}
              </button>
              {popoverOpen && (
                <div
                  ref={popoverRef}
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 4px)',
                    right: 0,
                    minWidth: '220px',
                    maxWidth: '280px',
                    zIndex: 50,
                    background: 'var(--color-bg-panel, var(--color-bg))',
                    border: '1px solid var(--color-border-hairline)',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
                    display: 'flex',
                    flexDirection: 'column',
                    padding: '4px',
                    gap: '2px',
                  }}
                >
                  {ROLE_PRESETS.map((p) => {
                    const isActive = matchedPreset?.key === p.key;
                    return (
                      <button
                        key={p.key}
                        onClick={() => commitPreset(p.text)}
                        data-help="cluster.right-panel.role-preset"
                        className="display-font"
                        title={p.text}
                        style={{
                          textAlign: 'left',
                          padding: '5px 8px',
                          background: isActive ? 'var(--color-accent-primary-a06)' : 'transparent',
                          border: '1px solid ' + (isActive ? 'var(--color-accent-primary)' : 'transparent'),
                          color: isActive ? 'var(--color-accent-primary)' : 'var(--color-fg)',
                          cursor: 'pointer',
                          fontSize: '10px',
                          letterSpacing: '1px',
                        }}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                  <div style={{ height: '1px', background: 'var(--color-border-hairline)', margin: '2px 0' }} />
                  <button
                    onClick={() => commitPreset('')}
                    data-help="cluster.right-panel.role-clear"
                    className="display-font"
                    style={{
                      textAlign: 'left',
                      padding: '5px 8px',
                      background: 'transparent',
                      border: '1px solid transparent',
                      color: member.role ? 'var(--color-warning)' : 'var(--color-fg-muted)',
                      cursor: 'pointer',
                      fontSize: '10px',
                      letterSpacing: '1px',
                    }}
                  >
                    CLEAR
                  </button>
                  <button
                    onClick={() => {
                      setRoleDraft(matchedPreset ? '' : (member.role ?? ''));
                      setEditingCustom(true);
                      setPopoverOpen(false);
                    }}
                    data-help="cluster.right-panel.role-custom"
                    className="display-font"
                    style={{
                      textAlign: 'left',
                      padding: '5px 8px',
                      background: !matchedPreset && member.role ? 'var(--color-accent-primary-a06)' : 'transparent',
                      border: '1px solid ' + (!matchedPreset && member.role ? 'var(--color-accent-primary)' : 'transparent'),
                      color: !matchedPreset && member.role ? 'var(--color-accent-primary)' : 'var(--color-fg)',
                      cursor: 'pointer',
                      fontSize: '10px',
                      letterSpacing: '1px',
                    }}
                  >
                    CUSTOM…
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {onSetTier && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px' }}>
          <span
            className="display-font"
            style={{ color: 'var(--color-fg-muted)', letterSpacing: '1px' }}
            title="Builder tier — operator hint to the cluster director. light = quick edits; standard = normal feature work; heavy = architectural changes. Visible in peer_list. The director (an LLM) decides routing; no server-side routing."
          >
            TIER
          </span>
          {MEMBER_TIERS.map((t) => {
            const active = member.tier === t;
            return (
              <button
                key={t}
                onClick={() => onSetTier(cluster.clusterId, member.workflowId, active ? null : t)}
                data-help="cluster.right-panel.tier-pill"
                className="display-font"
                title={
                  t === 'light'
                    ? 'Light — quick edits, renames, simple commands. Click again to unset.'
                    : t === 'standard'
                      ? 'Standard — normal feature work. Click again to unset.'
                      : 'Heavy — architectural changes, complex refactors. Click again to unset.'
                }
                style={{
                  padding: '3px 8px',
                  background: active ? 'var(--color-accent-primary-a06)' : 'transparent',
                  border: '1px solid ' + (active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
                  color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                  cursor: 'pointer',
                  fontSize: '9px',
                  letterSpacing: '1px',
                }}
              >
                {t.toUpperCase()}
              </button>
            );
          })}
          <button
            onClick={() => onSetTier(cluster.clusterId, member.workflowId, null)}
            disabled={!member.tier}
            data-help="cluster.right-panel.tier-unset"
            className="display-font"
            title="Unset the tier (no opinion). The director sees no tier field for this peer."
            style={{
              marginLeft: 'auto',
              padding: '3px 8px',
              background: 'transparent',
              border: '1px solid transparent',
              color: member.tier ? 'var(--color-warning)' : 'var(--color-fg-muted)',
              cursor: member.tier ? 'pointer' : 'default',
              fontSize: '9px',
              letterSpacing: '1px',
              opacity: member.tier ? 1 : 0.5,
            }}
          >
            UNSET
          </button>
        </div>
      )}

      {onSetFocus && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px' }}>
          <span
            className="display-font"
            style={{ color: 'var(--color-fg-muted)', letterSpacing: '1px' }}
            title="Sub-specialty — what THIS member specializes in (e.g. 'React frontend, Zustand patterns'). Surfaces in peer_list so the director can disambiguate same-role peers. Pure metadata."
          >
            FOCUS
          </span>
          {focusEditing ? (
            <>
              <input
                type="text"
                autoFocus
                value={focusDraft}
                onChange={(e) => setFocusDraft(e.target.value.slice(0, 160))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onSetFocus(cluster.clusterId, member.workflowId, focusDraft.trim().length > 0 ? focusDraft.trim() : null);
                    setFocusEditing(false);
                  } else if (e.key === 'Escape') {
                    setFocusDraft(member.focus ?? '');
                    setFocusEditing(false);
                  }
                }}
                onBlur={() => {
                  onSetFocus(cluster.clusterId, member.workflowId, focusDraft.trim().length > 0 ? focusDraft.trim() : null);
                  setFocusEditing(false);
                }}
                placeholder="e.g. React frontend, Zustand patterns"
                data-help="cluster.right-panel.focus-input"
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '3px 6px',
                  background: 'var(--color-bg-sunken)',
                  border: '1px solid var(--color-accent-primary)',
                  color: 'var(--color-fg)',
                  fontSize: '10px',
                  fontFamily: 'inherit',
                }}
              />
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  setFocusDraft(member.focus ?? '');
                  setFocusEditing(true);
                }}
                data-help="cluster.right-panel.focus-display"
                title={member.focus ? `${member.focus}\n\nClick to edit.` : 'Click to set focus.'}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '3px 6px',
                  background: 'transparent',
                  border: '1px dashed var(--color-border-hairline)',
                  color: member.focus ? 'var(--color-fg)' : 'var(--color-fg-muted)',
                  cursor: 'pointer',
                  fontSize: '10px',
                  textAlign: 'left',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: 'inherit',
                }}
              >
                {member.focus || '(not set — click to edit)'}
              </button>
              {member.focus && (
                <button
                  onClick={() => onSetFocus(cluster.clusterId, member.workflowId, null)}
                  data-help="cluster.right-panel.focus-clear"
                  className="display-font"
                  title="Clear focus (back to no opinion)."
                  style={{
                    padding: '3px 8px',
                    background: 'transparent',
                    border: '1px solid transparent',
                    color: 'var(--color-warning)',
                    cursor: 'pointer',
                    fontSize: '9px',
                    letterSpacing: '1px',
                  }}
                >
                  CLEAR
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
