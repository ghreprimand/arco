// docs/PROTOCOL_CLUSTER.md + 2.5 - right-click affordance for cluster
// creation / membership.
//
// Three modes, picked at the top of the modal:
//
//   CREATE WITH EXISTING — original behavior. Multi-pick other Native Claude
//     tabs in the same cwd as the anchor; submit dispatches cluster_create
//     with [anchor, ...selected].
//   ADD TO EXISTING — when at least one cluster shares the anchor's cwd,
//     pick which cluster to join. Submit dispatches cluster_member_add. Only
//     available when the anchor isn't already in a cluster.
//   CREATE WITH FRESH — pick N (1–4) and an optional name. Submit dispatches
//     cluster_create_with_fresh_workers; server creates N new workflows
//     sharing the anchor's cwd + primary config, then creates the cluster.
//
// The Native-only fence (every member must be Native Claude) is enforced
// server-side in all three paths; the UI scopes candidates so the operator
// doesn't hit the error in the most common cases.

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { clusterDisplayName } from './TabBar';
import { DEFAULT_CODEX_MODEL } from '@arco/shared';
import type { ClusterMemberProvider } from '@arco/shared';
import { effortsForModel } from '../utils/format';
import { modelsForProvider, useModelCatalogs } from '../utils/modelCatalog';

type Mode = 'create-existing' | 'add-existing' | 'create-fresh';

interface Props {
  // The tab the operator right-clicked.
  anchorJobId: string;
  // Screen-coords for the modal anchor; not used yet (modal centers) but
  // reserved so we can switch to a popover later.
  position?: { x: number; y: number };
  onClose: () => void;
  onCreateCluster: (cwd: string, memberWorkflowIds: string[]) => void;
  onAddClusterMember: (clusterId: string, workflowId: string) => void;
  onCreateClusterWithFreshWorkers: (
    sourceWorkflowId: string,
    additionalCount: number,
    opts?: { name?: string; provider?: ClusterMemberProvider; model?: string; effort?: string; providerAccountRef?: string },
  ) => void;
}

export function TabContextMenu({
  anchorJobId,
  onClose,
  onCreateCluster,
  onAddClusterMember,
  onCreateClusterWithFreshWorkers,
}: Props) {
  const jobs = useAppStore((s) => s.jobs);
  const settings = useAppStore((s) => s.settings);
  const clusters = useAppStore((s) => s.clusters);

  const anchor = jobs[anchorJobId];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const effectiveClaudeTransport = useMemo(
    () => (job: typeof anchor): 'cli' | 'native' => {
      const tab = job.config.claudeTransport;
      if (tab === 'native' || tab === 'cli') return tab;
      return settings?.claude?.transport === 'native' ? 'native' : 'cli';
    },
    [settings],
  );

  const isClusterProvider = (provider: string): provider is ClusterMemberProvider =>
    provider === 'claude' || provider === 'codex' || provider === 'ollama' || provider === 'llamacpp';

  // Candidate same-cwd tabs whose providers can receive cluster peer tools.
  const existingCandidates = useMemo(() => {
    if (!anchor) return [];
    const cwd = anchor.config.workingDirectory;
    return Object.values(jobs).filter((j) => {
      if (j.id === anchor.id) return false;
      if (j.config.workingDirectory !== cwd) return false;
      const provider = j.config.primaryProvider ?? 'claude';
      if (!isClusterProvider(provider)) return false;
      void effectiveClaudeTransport; // both transports accepted; fence loose
      return true;
    });
  }, [jobs, anchor, effectiveClaudeTransport]);

  // Same-cwd clusters that don't already include the anchor (mode: add-existing).
  const addCandidates = useMemo(() => {
    if (!anchor) return [];
    const cwd = anchor.config.workingDirectory;
    return Object.values(clusters).filter((c) => {
      if (c.cwd !== cwd) return false;
      if (c.members.some((m) => m.workflowId === anchor.id)) return false;
      return true;
    });
  }, [clusters, anchor]);

  // Default mode picks the most actionable surface: if same-cwd clusters
  // exist, prefer "add to existing"; otherwise create-with-existing.
  // Operator can switch via the mode pills.
  const initialMode: Mode = addCandidates.length > 0 ? 'add-existing' : 'create-existing';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pickedClusterId, setPickedClusterId] = useState<string>(addCandidates[0]?.clusterId ?? '');
  const [freshCount, setFreshCount] = useState<number>(2);
  const [freshName, setFreshName] = useState<string>('');

  // 2026-05-11 — provider/model/effort picker for FRESH spawn. Mirrors the
  // ClusterRightPanel ADD FRESH picker (same shape; same defaults seeded
  // from the anchor's primary). Anchor here is the right-clicked tab.
  const catalogs = useModelCatalogs();
  const { claude: claudeNativeCatalog, codex: codexCatalog } = catalogs;
  const anchorProvider: 'claude' | 'codex' =
    (anchor?.config.primaryProvider ?? 'claude') === 'codex' ? 'codex' : 'claude';
  const anchorModel = String(anchor?.config.primaryModel ?? '');
  const anchorEffort = String(anchor?.config.primaryEffort ?? 'medium');
  const anchorAccountRef = anchor?.config.providerAccountRef;
  const codexAccounts = settings?.providerAccounts?.codex ?? [];
  const [freshProvider, setFreshProvider] = useState<'claude' | 'codex'>(anchorProvider);
  const [freshModel, setFreshModel] = useState<string>(anchorModel);
  const [freshEffort, setFreshEffort] = useState<string>(anchorEffort);
  const [freshAccountRef, setFreshAccountRef] = useState<string | undefined>(anchorProvider === 'codex' ? anchorAccountRef : undefined);

  // Fresh spawn is deliberately claude/codex only (2026-05-11 — mirrors the
  // ADD FRESH picker); the list itself comes from the shared resolver.
  const freshModelOptions: string[] = useMemo(
    () => modelsForProvider(freshProvider, catalogs).map(String),
    [freshProvider, catalogs],
  );

  const freshEffortOptions: string[] = useMemo(() => {
    return effortsForModel(freshProvider, freshModel, claudeNativeCatalog, codexCatalog);
  }, [freshProvider, freshModel, claudeNativeCatalog, codexCatalog]);

  // Clamp model to the option list (2026-07-28) — the anchor tab may be on a
  // family alias or a since-dropped id, and a select whose value matches no
  // option renders the first one while state keeps the unmatched value. The
  // fresh tab would then be created on something the operator never saw.
  useEffect(() => {
    if (freshModelOptions.length === 0) return;
    if (!freshModelOptions.includes(freshModel)) setFreshModel(freshModelOptions[0]);
  }, [freshModelOptions, freshModel]);

  // Clamp effort if it drops out of the per-model set.
  useEffect(() => {
    if (freshEffortOptions.length === 0) return;
    if (!freshEffortOptions.includes(freshEffort)) {
      setFreshEffort(freshEffortOptions[freshEffortOptions.length - 1]);
    }
  }, [freshEffortOptions, freshEffort]);

  // Changing provider resets model to first-available for that provider's
  // catalog (anchor's model name is wrong for the new provider).
  const onPickFreshProvider = (next: 'claude' | 'codex') => {
    setFreshProvider(next);
    if (next === anchorProvider) {
      setFreshModel(anchorModel);
      setFreshEffort(anchorEffort);
      setFreshAccountRef(next === 'codex' ? anchorAccountRef : undefined);
    } else {
      const firstModel = (next === 'claude'
        // Alias fallback only when the catalog is cold — the alias is not a
        // dispatchable id on the Native transport (worker resolves it).
        ? (claudeNativeCatalog?.models?.[0]?.id ?? 'opus')
        : (codexCatalog?.models?.find((m) => !m.hidden)?.id ?? DEFAULT_CODEX_MODEL));
      setFreshModel(firstModel);
      setFreshEffort('medium');
      setFreshAccountRef(next === 'codex' ? codexAccounts[0]?.id : undefined);
    }
  };

  if (!anchor) {
    onClose();
    return null;
  }

  // Anchor is eligible to seed/join a cluster if Arco can inject peer
  // tools into its provider.
  const anchorIsNative =
    isClusterProvider(anchor.config.primaryProvider ?? 'claude');

  const anchorInCluster = Object.values(clusters).some((c) =>
    c.members.some((m) => m.workflowId === anchor.id),
  );

  const submit = () => {
    if (!anchorIsNative) return;
    if (mode === 'create-existing') {
      if (selected.size === 0) return;
      onCreateCluster(anchor.config.workingDirectory, [anchor.id, ...selected]);
      onClose();
      return;
    }
    if (mode === 'add-existing') {
      if (!pickedClusterId) return;
      onAddClusterMember(pickedClusterId, anchor.id);
      onClose();
      return;
    }
    // create-fresh — pass through optional name + picker overrides. The
    // helper drops undefined fields; the server inherits-from-anchor when
    // we don't forward a value.
    const opts: { name?: string; provider?: ClusterMemberProvider; model?: string; effort?: string; providerAccountRef?: string } = {};
    if (freshName.trim().length > 0) opts.name = freshName.trim();
    if (freshProvider !== anchorProvider) opts.provider = freshProvider;
    if (freshModel && freshModel !== anchorModel) opts.model = freshModel;
    if (freshEffort && freshEffort !== anchorEffort) opts.effort = freshEffort;
    if (freshProvider === 'codex' && freshAccountRef && freshAccountRef !== anchorAccountRef) opts.providerAccountRef = freshAccountRef;
    onCreateClusterWithFreshWorkers(anchor.id, freshCount, Object.keys(opts).length > 0 ? opts : undefined);
    onClose();
  };

  // Mirrors ClusterRightPanel — if operator flipped provider away from
  // anchor's, model must be non-empty (server enforces; UI hides the
  // SPAWN action so the rejection path is reserved for protocol bugs).
  const freshSubmitBlocked = mode === 'create-fresh'
    && freshProvider !== anchorProvider
    && !freshModel;

  const submitDisabled =
    !anchorIsNative
    || (mode === 'create-existing' && selected.size === 0)
    || (mode === 'add-existing' && !pickedClusterId)
    || (mode === 'add-existing' && anchorInCluster)
    || freshSubmitBlocked;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="display-font"
        style={{
          // Elevated (not panel) so floating menus share one frosted opacity
          // level with the reader modals — the slider moves them together.
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border-hairline)',
          padding: '20px 24px',
          minWidth: '460px',
          maxWidth: '640px',
          color: 'var(--color-fg)',
          fontSize: '12px',
        }}
      >
        <div style={{ fontSize: '11px', letterSpacing: '1px', color: 'var(--color-accent-primary)', marginBottom: '12px' }}>
          CLUSTER ACTIONS
        </div>
        <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', marginBottom: '12px' }}>
          Anchor: <span style={{ color: 'var(--color-fg)' }}>{anchor.config.name.toUpperCase()}</span>
          <span style={{ marginLeft: '8px', opacity: 0.6 }}>{anchor.config.workingDirectory}</span>
        </div>

        {/* Mode picker */}
        <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
          <ModeChip active={mode === 'create-existing'} onClick={() => setMode('create-existing')}>
            CREATE WITH EXISTING
          </ModeChip>
          <ModeChip
            active={mode === 'add-existing'}
            onClick={() => setMode('add-existing')}
            disabled={addCandidates.length === 0 || anchorInCluster}
          >
            ADD TO EXISTING
          </ModeChip>
          <ModeChip active={mode === 'create-fresh'} onClick={() => setMode('create-fresh')}>
            CREATE WITH FRESH
          </ModeChip>
        </div>

        {!anchorIsNative ? (
          <div style={{ color: 'var(--color-warning)', padding: '12px 0' }}>
            Clusters accept only Claude or Codex tabs today. Gemini / Ollama / llama.cpp have no MCP wiring path.
          </div>
        ) : mode === 'create-existing' ? (
          existingCandidates.length === 0 ? (
            <div style={{ color: 'var(--color-fg-muted)', padding: '12px 0' }}>
              No other Claude/Codex tabs in this cwd. Open a second compatible tab in <span style={{ color: 'var(--color-fg)' }}>{anchor.config.workingDirectory}</span> first, or switch to CREATE WITH FRESH.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '320px', overflowY: 'auto' }}>
              {existingCandidates.map((j) => {
                const checked = selected.has(j.id);
                return (
                  <label
                    key={j.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '6px 8px',
                      border: '1px solid var(--color-border-hairline)',
                      cursor: 'pointer',
                      background: checked ? 'var(--color-accent-primary-a06)' : 'transparent',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = new Set(selected);
                        if (checked) next.delete(j.id);
                        else next.add(j.id);
                        setSelected(next);
                      }}
                    />
                    <span style={{ color: 'var(--color-fg)' }}>{j.config.name.toUpperCase()}</span>
                    <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--color-fg-muted)' }}>{j.id.slice(0, 8)}</span>
                  </label>
                );
              })}
            </div>
          )
        ) : mode === 'add-existing' ? (
          anchorInCluster ? (
            <div style={{ color: 'var(--color-warning)', padding: '12px 0' }}>
              This tab is already a member of a cluster. Detach it first via the cluster's Members tab.
            </div>
          ) : addCandidates.length === 0 ? (
            <div style={{ color: 'var(--color-fg-muted)', padding: '12px 0' }}>
              No clusters in this cwd. Create one via CREATE WITH EXISTING or CREATE WITH FRESH.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '320px', overflowY: 'auto' }}>
              {addCandidates.map((c) => {
                const picked = pickedClusterId === c.clusterId;
                return (
                  <label
                    key={c.clusterId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '6px 8px',
                      border: '1px solid var(--color-border-hairline)',
                      cursor: 'pointer',
                      background: picked ? 'var(--color-accent-primary-a06)' : 'transparent',
                    }}
                  >
                    <input
                      type="radio"
                      name="cluster-pick"
                      checked={picked}
                      onChange={() => setPickedClusterId(c.clusterId)}
                    />
                    <span style={{ color: 'var(--color-fg)' }}>{clusterDisplayName(c).toUpperCase()}</span>
                    <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--color-fg-muted)' }}>
                      {c.members.length} MEMBERS
                    </span>
                  </label>
                );
              })}
            </div>
          )
        ) : (
          // create-fresh
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {/* 2026-05-11 — provider / model / effort picker. Defaults clone
                the anchor; the operator can override any of the three for
                e.g. spawning Codex siblings off a Claude anchor. The 'NAME'
                + 'COUNT' rows live below, unchanged. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11px', color: 'var(--color-fg-muted)' }}>
              <span style={{ minWidth: '90px' }}>PROVIDER</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  data-help="cluster.fresh.provider"
                  onClick={() => onPickFreshProvider('claude')}
                  className="display-font"
                  style={{
                    padding: '4px 10px',
                    background: freshProvider === 'claude' ? 'var(--color-accent-primary-a10)' : 'transparent',
                    border: `1px solid ${freshProvider === 'claude' ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
                    color: freshProvider === 'claude' ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                    cursor: 'pointer',
                    fontSize: '11px',
                  }}
                >
                  CLAUDE
                </button>
                <button
                  data-help="cluster.fresh.provider"
                  onClick={() => onPickFreshProvider('codex')}
                  className="display-font"
                  style={{
                    padding: '4px 10px',
                    background: freshProvider === 'codex' ? 'var(--color-accent-primary-a10)' : 'transparent',
                    border: `1px solid ${freshProvider === 'codex' ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
                    color: freshProvider === 'codex' ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                    cursor: 'pointer',
                    fontSize: '11px',
                  }}
                >
                  CODEX
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11px', color: 'var(--color-fg-muted)' }}>
              <span style={{ minWidth: '90px' }}>MODEL</span>
              <select
                data-help="cluster.fresh.model"
                value={freshModel}
                onChange={(e) => setFreshModel(e.target.value)}
                className="display-font"
                style={{
                  flex: 1,
                  background: 'var(--color-bg-sunken)',
                  border: '1px solid var(--color-border-hairline)',
                  color: 'var(--color-fg)',
                  padding: '5px 8px',
                  fontSize: '11px',
                  fontFamily: 'var(--font-code)',
                }}
              >
                {freshModelOptions.length === 0 && <option value="">(no models)</option>}
                {freshModelOptions.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            {freshProvider === 'codex' && codexAccounts.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11px', color: 'var(--color-fg-muted)' }}>
                <span style={{ minWidth: '90px' }}>ACCOUNT</span>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {codexAccounts.map((acct) => {
                    const short = (acct.shortLabel || acct.label || acct.id).slice(0, 4).toUpperCase();
                    return (
                      <button
                        key={acct.id}
                        onClick={() => setFreshAccountRef(acct.id)}
                        className="display-font"
                        style={{
                          padding: '4px 10px',
                          background: freshAccountRef === acct.id ? 'var(--color-accent-primary-a10)' : 'transparent',
                          border: `1px solid ${freshAccountRef === acct.id ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
                          color: freshAccountRef === acct.id ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                          cursor: 'pointer',
                          fontSize: '11px',
                        }}
                      >
                        {acct.label.toUpperCase()} [{short}]
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11px', color: 'var(--color-fg-muted)' }}>
              <span style={{ minWidth: '90px' }}>EFFORT</span>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {freshEffortOptions.map((e) => (
                  <button
                    key={e}
                    data-help="cluster.fresh.effort"
                    onClick={() => setFreshEffort(e)}
                    className="display-font"
                    style={{
                      padding: '4px 10px',
                      background: freshEffort === e ? 'var(--color-accent-primary-a10)' : 'transparent',
                      border: `1px solid ${freshEffort === e ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
                      color: freshEffort === e ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                      cursor: 'pointer',
                      fontSize: '11px',
                    }}
                  >
                    {e.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11px', color: 'var(--color-fg-muted)' }}>
              FRESH WORKERS
              <div style={{ display: 'flex', gap: '6px' }}>
                {[1, 2, 3, 4].map((n) => (
                  <button
                    key={n}
                    onClick={() => setFreshCount(n)}
                    className="display-font"
                    style={{
                      padding: '4px 10px',
                      background: freshCount === n ? 'var(--color-accent-primary-a10)' : 'transparent',
                      border: `1px solid ${freshCount === n ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
                      color: freshCount === n ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                      cursor: 'pointer',
                      fontSize: '11px',
                    }}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <span style={{ marginLeft: 'auto', color: 'var(--color-fg-muted)', fontSize: '10px' }}>
                {`${freshCount + 1} members total (1 anchor + ${freshCount} fresh)`}
              </span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11px', color: 'var(--color-fg-muted)' }}>
              NAME
              <input
                value={freshName}
                onChange={(e) => setFreshName(e.target.value)}
                placeholder={`(default: ${anchor.config.workingDirectory.split(/[/\\]/).filter(Boolean).pop() ?? ''} · <id>)`}
                maxLength={64}
                style={{
                  flex: 1,
                  background: 'var(--color-bg-sunken)',
                  border: '1px solid var(--color-border-hairline)',
                  color: 'var(--color-fg)',
                  padding: '6px 10px',
                  fontSize: '12px',
                }}
              />
            </label>
            <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>
              Each fresh worker inherits the anchor's cwd and advanced flags;
              provider/model/effort default to the anchor's but can be
              overridden above (e.g. spawn Codex siblings off a Claude anchor).
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
          <button
            onClick={onClose}
            className="display-font"
            style={{
              padding: '6px 14px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              color: 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '11px',
              letterSpacing: '1px',
            }}
          >
            CANCEL
          </button>
          <button
            onClick={submit}
            disabled={submitDisabled}
            className="display-font"
            style={{
              padding: '6px 14px',
              background: submitDisabled ? 'transparent' : 'var(--color-accent-primary)',
              border: '1px solid var(--color-accent-primary)',
              color: submitDisabled ? 'var(--color-fg-muted)' : 'var(--color-bg)',
              cursor: submitDisabled ? 'not-allowed' : 'pointer',
              fontSize: '11px',
              letterSpacing: '1px',
            }}
          >
            {mode === 'create-existing' && `CREATE CLUSTER (${selected.size + 1})`}
            {mode === 'add-existing' && 'ADD TO CLUSTER'}
            {mode === 'create-fresh' && `CREATE + ${freshCount} FRESH`}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeChip({
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
      onClick={onClick}
      disabled={disabled}
      className="display-font"
      style={{
        padding: '6px 12px',
        background: active ? 'var(--color-accent-primary-a10)' : 'transparent',
        border: `1px solid ${active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
        borderRadius: '3px',
        color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        fontSize: '10px',
        letterSpacing: '1px',
      }}
    >
      {children}
    </button>
  );
}
