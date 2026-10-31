import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useCodexCatalogFor } from '../../hooks/useCodexCatalog';
import { DEFAULT_CODEX_MODEL} from '@arco/shared';
import type { ClusterMemberAccessMode, ClusterMemberProvider, ClusterStatePayload, EffortLevel, ModelName, ProviderName } from '@arco/shared';
import { effortsForModel } from '../../utils/format';
import { capDefaultEffort } from '../../utils/effortDefaults';
import { modelsForProvider, useModelCatalogs } from '../../utils/modelCatalog';
import { CursorModelSelect } from '../CursorModelSelect';

// Phase 2.5.1 — in-cluster add-worker affordance. Lives above the member
// list in the Members sub-tab. Two modes:
//   FRESH — spawn N (1–4) new workflows inheriting the cluster's template
//   EXISTING — pick a same-cwd standalone Native tab to join
// Native fence enforced server-side. The picker is collapsed by default;
// clicking either mode button expands it inline.
export function AddWorkerSection({
  cluster,
  onAddFresh,
  onAddExisting,
}: {
  cluster: ClusterStatePayload;
  // 2026-05-11 — optional `opts` triple overrides provider/model/effort on
  // freshly spawned cluster members. Undefined fields → inherit-from-template.
  onAddFresh?: (
    clusterId: string,
    count: number,
    opts?: { provider?: ClusterMemberProvider; model?: string; effort?: string; providerAccountRef?: string; accessMode?: ClusterMemberAccessMode },
  ) => void;
  onAddExisting?: (clusterId: string, workflowId: string) => void;
}) {
  const jobs = useAppStore((s) => s.jobs);
  const clusters = useAppStore((s) => s.clusters);
  const settings = useAppStore((s) => s.settings);
  const authStatus = useAppStore((s) => s.authStatus);
  const [mode, setMode] = useState<'idle' | 'fresh' | 'existing'>('idle');
  const [count, setCount] = useState(1);
  const [accessMode, setAccessMode] = useState<ClusterMemberAccessMode>('standard');

  // 2026-05-11 — picker state for FRESH-spawn provider/model/effort overrides.
  // Anchor = cluster template (members[0]). Defaults clone the template's
  // primary config; changing provider resets model to the first-available
  // catalog entry for that provider and clamps effort. The CONFIG-tab picker
  // wires the same fields (RightPanel.tsx ~1297), so this mirrors that shape.
  const templateJob = jobs[cluster.members[0]?.workflowId ?? ''];
  const templateProvider: ClusterMemberProvider = (() => {
    const p = templateJob?.config.primaryProvider ?? 'claude';
    return p === 'codex' || p === 'ollama' || p === 'llamacpp' || p === 'cursor' ? p : 'claude';
  })();
  const templateModel = templateJob?.config.primaryModel ?? '';
  // A new worker never inherits an effort above HIGH; XHIGH/MAX stay an explicit pick.
  const templateEffort = capDefaultEffort(templateJob?.config.primaryEffort ?? 'medium');
  const templateAccountRef = templateJob?.config.providerAccountRef;
  const codexAccounts = settings?.providerAccounts?.codex ?? [];
  const [provider, setProvider] = useState<ClusterMemberProvider>(templateProvider);
  const [model, setModel] = useState<string>(String(templateModel));
  const [effort, setEffort] = useState<string>(String(templateEffort));
  const [providerAccountRef, setProviderAccountRef] = useState<string | undefined>(templateAccountRef);
  // Account-scoped so a fresh Codex member's model list matches the chosen
  // account profile's entitlements (HOME vs WORK).
  const codexCatalog = useCodexCatalogFor(providerAccountRef);
  const catalogs = useModelCatalogs({ codex: codexCatalog });
  const { claude: claudeNativeCatalog, cursor: cursorCatalog } = catalogs;

  // Re-seed picker state whenever the template's identity changes (e.g.
  // the cluster's first member rotates after a detach).
  useEffect(() => {
    setProvider(templateProvider);
    setModel(String(templateModel));
    setEffort(String(templateEffort));
    setProviderAccountRef(templateProvider === 'codex' ? templateAccountRef : undefined);
  }, [templateProvider, templateModel, templateEffort, templateAccountRef]);

  // Per-provider model list — live catalog when available, static otherwise.
  // Cursor gets auto + the full frontier catalog, same picker depth as a
  // standalone tab (`auto` is a convenient default, not a forced lane).
  const modelOptions: string[] = useMemo(
    () => modelsForProvider(provider, catalogs).map(String),
    [provider, catalogs],
  );

  // Per-model effort set — same source as the CONFIG picker (effortsForModel).
  const effortOptions: string[] = useMemo(() => {
    return effortsForModel(provider, model, claudeNativeCatalog, codexCatalog);
  }, [provider, model, claudeNativeCatalog, codexCatalog]);

  // Changing provider resets model to first-available for that provider's
  // catalog (the inherited template name is wrong for the new provider) and
  // clamps effort. Anchor-default reuse only when provider matches anchor's.
  const onPickProvider = (next: ClusterMemberProvider) => {
    if (accessMode === 'isolated' && next !== 'claude') return;
    setProvider(next);
    if (next === templateProvider) {
      setModel(String(templateModel));
      setEffort(String(templateEffort));
      setProviderAccountRef(next === 'codex' ? templateAccountRef : undefined);
    } else {
      const firstModel = next === 'claude'
        ? (claudeNativeCatalog?.models?.[0]?.id ?? 'opus')
        : next === 'codex'
          ? (codexCatalog?.models?.find((m) => !m.hidden)?.id ?? DEFAULT_CODEX_MODEL)
          : next === 'ollama'
            ? (authStatus?.ollama?.installedModels?.[0] ?? '')
          : next === 'cursor'
            ? (cursorCatalog?.models?.find((m) => m.isDefault)?.id ?? 'auto')
            : (authStatus?.llamacpp?.installedModels?.[0] ?? '');
      setModel(firstModel);
      // Effort gets clamped post-hoc by effortOptions; pick 'medium' as the
      // pragmatic default until the per-model set narrows it.
      setEffort('medium');
      setProviderAccountRef(next === 'codex' ? codexAccounts[0]?.id : undefined);
    }
  };

  // Clamp effort whenever the effort set changes so an inherited value
  // that's no longer valid (e.g. provider flipped) snaps to the highest
  // available entry.
  useEffect(() => {
    if (effortOptions.length === 0) return;
    if (!effortOptions.includes(effort)) {
      setEffort(capDefaultEffort(effort as EffortLevel, provider as ProviderName, model as ModelName, claudeNativeCatalog, codexCatalog));
    }
  }, [effortOptions, effort]);

  // Submit guard — if the operator flipped provider away from the anchor's,
  // model must be non-empty (server enforces; UI mirrors).
  const submitDisabled = provider !== templateProvider && !model;

  const memberIds = useMemo(() => new Set(cluster.members.map((m) => m.workflowId)), [cluster.members]);

  // Same-cwd standalone tabs whose providers can receive cluster peer tools.
  const candidates = useMemo(() => {
    const allClusterMembers = new Set<string>();
    for (const c of Object.values(clusters)) {
      for (const m of c.members) allClusterMembers.add(m.workflowId);
    }
    return Object.values(jobs).filter((j) => {
      if (j.config.workingDirectory !== cluster.cwd) return false;
      const provider = j.config.primaryProvider ?? 'claude';
      // Cursor is fresh-only for cluster membership (Phase 6). A standalone
      // Cursor tab's ACP session was opened WITHOUT the loopback peer-tools MCP
      // (mcpServers is fixed at session/new), so joining it here would produce a
      // member that can't peer_send/peer_read until its worker respawns — a mute
      // member, which we don't ship. Fresh Cursor members (spawned already
      // inside the cluster) get the MCP at bootstrap and work immediately.
      if (provider !== 'claude' && provider !== 'codex' && provider !== 'ollama' && provider !== 'llamacpp') return false;
      if (memberIds.has(j.id)) return false;
      if (allClusterMembers.has(j.id)) return false;
      // Both Claude transports + both Codex transports accepted; local
      // providers use Arco's in-process tool runtime.
      void settings;
      return true;
    });
  }, [jobs, clusters, cluster.cwd, memberIds, settings]);

  return (
    <div
      style={{
        padding: '8px',
        border: '1px solid var(--color-border-hairline)',
        background: 'var(--color-bg)',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }}
    >
      <div style={{ display: 'flex', gap: '6px' }}>
        {onAddFresh && (
          <button
            onClick={() => setMode(mode === 'fresh' ? 'idle' : 'fresh')}
            data-help="cluster.add-fresh"
            className="display-font"
            style={{
              flex: 1,
              padding: '6px 8px',
              background: mode === 'fresh' ? 'var(--color-accent-primary-a06)' : 'transparent',
              border: '1px solid ' + (mode === 'fresh' ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
              color: mode === 'fresh' ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
            }}
          >
            + ADD FRESH
          </button>
        )}
        {onAddExisting && (
          <button
            onClick={() => setMode(mode === 'existing' ? 'idle' : 'existing')}
            disabled={candidates.length === 0}
            data-help="cluster.add-existing"
            className="display-font"
            style={{
              flex: 1,
              padding: '6px 8px',
              background: mode === 'existing' ? 'var(--color-accent-primary-a06)' : 'transparent',
              border: '1px solid ' + (mode === 'existing' ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
              color: candidates.length === 0
                ? 'var(--color-fg-subtle, var(--color-fg-muted))'
                : mode === 'existing' ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: candidates.length === 0 ? 'not-allowed' : 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              opacity: candidates.length === 0 ? 0.5 : 1,
            }}
            title={candidates.length === 0 ? 'No same-cwd standalone Native tabs available' : undefined}
          >
            + ADD EXISTING ({candidates.length})
          </button>
        )}
      </div>
      {mode === 'fresh' && onAddFresh && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
          {/* Row 1 — PROVIDER pills + MODEL dropdown + EFFORT pills */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span
              data-help="cluster.fresh.access"
              style={{ color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '1px' }}
            >
              ACCESS
            </span>
            {(['standard', 'blind', 'isolated'] as ClusterMemberAccessMode[]).map((access) => (
              <button
                key={access}
                data-help="cluster.fresh.access"
                onClick={() => {
                  setAccessMode(access);
                  if (access === 'isolated' && provider !== 'claude') onPickProvider('claude');
                }}
                className="display-font"
                title={access === 'standard'
                  ? 'Normal cluster context and project access'
                  : access === 'blind'
                    ? 'Project access, but only mailbox cluster tools and no plan/board/roster context'
                    : 'Private scratch workspace outside the project; Claude Native; mailbox tools only'}
                style={{
                  padding: '3px 8px',
                  background: accessMode === access ? 'var(--color-accent-primary-a10)' : 'transparent',
                  border: `1px solid ${accessMode === access ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
                  color: accessMode === access ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                  cursor: 'pointer',
                  fontSize: '10px',
                  letterSpacing: '1px',
                }}
              >
                {access.toUpperCase()}
              </button>
            ))}
          </div>
          {accessMode !== 'standard' && (
            <div style={{ color: 'var(--color-fg-muted)', fontSize: '10px', lineHeight: 1.4 }}>
              {accessMode === 'blind'
                ? 'BLIND hides cluster plan, board, roster, role/focus, coordination doctrine, and task tools. The project cwd remains available; board transitions must be handed back by peer mail.'
                : 'ISOLATED runs a fresh Claude Native worker in a private durable scratch directory. No project files, shell, project instructions, or cluster surfaces beyond mail.'}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '1px' }}>PROVIDER</span>
            {(['claude', 'codex', 'ollama', 'llamacpp', 'cursor'] as ClusterMemberProvider[]).map((p) => (
              <button
                key={p}
                disabled={accessMode === 'isolated' && p !== 'claude'}
                data-help="cluster.fresh.provider"
                onClick={() => onPickProvider(p)}
                className="display-font"
                style={{
                  padding: '3px 8px',
                  background: provider === p ? 'var(--color-accent-primary-a10)' : 'transparent',
                  border: `1px solid ${provider === p ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
                  color: provider === p ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                  cursor: accessMode === 'isolated' && p !== 'claude' ? 'not-allowed' : 'pointer',
                  opacity: accessMode === 'isolated' && p !== 'claude' ? 0.35 : 1,
                  fontSize: '10px',
                  letterSpacing: '1px',
                }}
              >
                {p === 'llamacpp' ? 'LLAMA' : p.toUpperCase()}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '1px' }}>MODEL</span>
            {provider === 'cursor' && cursorCatalog?.models?.length ? (
              // Cursor: family × effort × flags (effort baked into the id, so
              // the EFFORT pills below read "baked into model" for cursor).
              <CursorModelSelect
                value={model}
                onChange={(id) => setModel(id)}
                selectStyle={{
                  background: 'var(--color-bg)',
                  color: 'var(--color-fg)',
                  border: '1px solid var(--color-border-hairline)',
                  padding: '3px 6px',
                  fontSize: '10px',
                  fontFamily: 'var(--font-code)',
                  cursor: 'pointer',
                }}
              />
            ) : (
              <select
                data-help="cluster.fresh.model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="display-font"
                style={{
                  flex: 1,
                  minWidth: '120px',
                  background: 'var(--color-bg)',
                  color: 'var(--color-fg)',
                  border: '1px solid var(--color-border-hairline)',
                  padding: '3px 6px',
                  fontSize: '10px',
                  fontFamily: 'var(--font-code)',
                }}
              >
                {modelOptions.length === 0 && <option value="">(no models)</option>}
                {modelOptions.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            )}
          </div>
          {provider === 'codex' && codexAccounts.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '1px' }}>ACCOUNT</span>
              {codexAccounts.map((acct) => {
                const short = (acct.shortLabel || acct.label || acct.id).slice(0, 4).toUpperCase();
                return (
                  <button
                    key={acct.id}
                    onClick={() => setProviderAccountRef(acct.id)}
                    className="display-font"
                    style={{
                      padding: '3px 8px',
                      background: providerAccountRef === acct.id ? 'var(--color-accent-primary-a10)' : 'transparent',
                      border: `1px solid ${providerAccountRef === acct.id ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
                      color: providerAccountRef === acct.id ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                      cursor: 'pointer',
                      fontSize: '10px',
                      letterSpacing: '1px',
                    }}
                  >
                    {acct.label.toUpperCase()} [{short}]
                  </button>
                );
              })}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '1px' }}>EFFORT</span>
            {effortOptions.length === 0 && (
              <span className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '0.5px' }}>
                {provider === 'cursor' ? 'BAKED INTO MODEL' : 'LOCAL MODEL'}
              </span>
            )}
            {effortOptions.map((e) => (
              <button
                key={e}
                data-help="cluster.fresh.effort"
                onClick={() => setEffort(e)}
                className="display-font"
                style={{
                  padding: '3px 8px',
                  background: effort === e ? 'var(--color-accent-primary-a10)' : 'transparent',
                  border: `1px solid ${effort === e ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
                  color: effort === e ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                  cursor: 'pointer',
                  fontSize: '10px',
                  letterSpacing: '1px',
                }}
              >
                {e.toUpperCase()}
              </button>
            ))}
          </div>
          {/* Row 2 — COUNT + SPAWN button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '1px' }}>COUNT</span>
            <input
              type="number"
              min={1}
              max={4}
              data-help="cluster.fresh.count"
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(4, parseInt(e.target.value, 10) || 1)))}
              style={{
                width: '60px',
                background: 'var(--color-bg)',
                color: 'var(--color-fg)',
                border: '1px solid var(--color-border-hairline)',
                padding: '4px 6px',
                fontSize: '11px',
                fontFamily: 'var(--font-code)',
              }}
            />
            <button
              onClick={() => {
                if (submitDisabled) return;
                // Only forward overrides when they diverge from the template
                // — undefined means "inherit" on the server.
                const opts: { provider?: ClusterMemberProvider; model?: string; effort?: string; providerAccountRef?: string; accessMode?: ClusterMemberAccessMode } = {};
                if (provider !== templateProvider) opts.provider = provider;
                if (model && model !== String(templateModel)) opts.model = model;
                if (effort && effort !== String(templateEffort)) opts.effort = effort;
                if (provider === 'codex' && providerAccountRef && providerAccountRef !== templateAccountRef) opts.providerAccountRef = providerAccountRef;
                if (accessMode !== 'standard') opts.accessMode = accessMode;
                onAddFresh(cluster.clusterId, count, Object.keys(opts).length > 0 ? opts : undefined);
                setMode('idle');
              }}
              disabled={submitDisabled}
              className="display-font"
              style={{
                marginLeft: 'auto',
                padding: '4px 10px',
                background: submitDisabled ? 'transparent' : 'var(--color-accent-primary)',
                border: submitDisabled ? '1px solid var(--color-border-hairline)' : 'none',
                color: submitDisabled ? 'var(--color-fg-muted)' : 'var(--color-bg)',
                cursor: submitDisabled ? 'not-allowed' : 'pointer',
                fontSize: '10px',
                letterSpacing: '1px',
              }}
              title={submitDisabled ? 'Pick a model for the new provider' : undefined}
            >
              SPAWN
            </button>
          </div>
        </div>
      )}
      {mode === 'existing' && onAddExisting && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '180px', overflowY: 'auto' }}>
          {candidates.map((j) => (
            <button
              key={j.id}
              onClick={() => { onAddExisting(cluster.clusterId, j.id); setMode('idle'); }}
              className="display-font"
              style={{
                textAlign: 'left',
                padding: '6px 8px',
                background: 'transparent',
                border: '1px solid var(--color-border-hairline)',
                color: 'var(--color-fg)',
                cursor: 'pointer',
                fontSize: '10px',
                letterSpacing: '0.5px',
              }}
            >
              {j.config.name.toUpperCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
