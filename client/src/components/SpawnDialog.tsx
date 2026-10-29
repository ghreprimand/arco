import { useEffect, useState, type CSSProperties } from 'react';
import type { WorkflowConfig, ProviderName, ModelName, EffortLevel } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useCodexCatalogFor } from '../hooks/useCodexCatalog';
import { effortsForModel, clampEffortForProvider } from '../utils/format';
import { claudeModelLabel, defaultModelForProvider, modelsForProvider, useModelCatalogs } from '../utils/modelCatalog';
import { CursorModelSelect } from './CursorModelSelect';

// Shared look for the Cursor family/effort dropdowns — matches the dialog's
// text inputs (sunken bg, hairline border, accent text).
const pickerSelectStyle: CSSProperties = {
  padding: '5px 8px',
  background: 'var(--color-bg-sunken)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary)',
  fontSize: '11px',
  outline: 'none',
  cursor: 'pointer',
};

interface Props {
  parentConfig: WorkflowConfig;
  // Title of the parent's attached plan, if any. When set, the dialog
  // exposes the "Include plan from parent" checkbox; the title is shown
  // for context. Empty / undefined hides the row entirely.
  parentPlanTitle?: string | null;
  // Pre-fills the direction textarea. Used by the "spawn from plan task"
  // flow in PlanTab, where the operator is launching a focused workflow
  // for one specific checkbox row from the attached plan. Default '' (the
  // existing TerminalInput → SPAWN button leaves it blank).
  initialDirection?: string;
  // Pre-checks "include plan from parent." Same use case as
  // initialDirection — when spawning a task from a plan, the spawn should
  // carry the plan with it by default. Operator can still untick.
  initialIncludePlan?: boolean;
  // Phase 2.5b — when the source tab is a cluster member, render an extra
  // checkbox ("Spawn into cluster <name>") default-checked. Unchecking
  // reverts to standalone behaviour (escape hatch). Absent → no checkbox,
  // never joins a cluster. The provider-support fence applies server-side.
  clusterContext?: { clusterId: string; name: string };
  onConfirm: (
    newConfig: WorkflowConfig,
    newDirection: string,
    includePlan: boolean,
    joinClusterId?: string,
  ) => void;
  onCancel: () => void;
}

// Phase 7 dialog — fork a tab. Pre-fills provider/model/effort/name from
// parent, lets operator override + add a direction prompt. Confirm submits
// a `spawn_from_here_request` via WS; parent tab stays active until the
// server's `spawn_from_here_complete` auto-switches to the new tab.
export function SpawnDialog({ parentConfig, parentPlanTitle, initialDirection, initialIncludePlan, clusterContext, onConfirm, onCancel }: Props) {
  const authStatus = useAppStore((s) => s.authStatus);
  const isProviderEnabled = useAppStore((s) => s.isProviderEnabled);
  const settings = useAppStore((s) => s.settings);
  const [provider, setProvider] = useState<ProviderName>(parentConfig.primaryProvider ?? 'claude');
  const [model, setModel] = useState<ModelName>(parentConfig.primaryModel);
  const [effort, setEffort] = useState<EffortLevel>(parentConfig.primaryEffort);
  const [providerAccountRef, setProviderAccountRef] = useState<string | undefined>(parentConfig.providerAccountRef);
  // Account-scoped so the model list follows the selected Codex profile.
  const codexCatalog = useCodexCatalogFor(providerAccountRef);
  const catalogs = useModelCatalogs({ codex: codexCatalog });
  const { claude: claudeNativeCatalog, cursor: cursorCatalog } = catalogs;
  const codexAccounts = settings?.providerAccounts?.codex ?? [];
  const [name, setName] = useState<string>(`${parentConfig.name} (spawn)`);
  const [direction, setDirection] = useState<string>(initialDirection ?? '');
  // Default false — spawn is plan-free unless the operator opts in.
  const [includePlan, setIncludePlan] = useState<boolean>(initialIncludePlan ?? false);
  // Phase 2.5b — default-checked when the source tab is a cluster member.
  const [joinCluster, setJoinCluster] = useState<boolean>(Boolean(clusterContext));
  // Phase 4 — cluster-join supports Claude (Native + CLI) and Codex
  // (exec + appserver). Other providers grey out the checkbox; auto-
  // uncheck so a stale `true` doesn't submit and silently fail.
  const canJoinCluster = provider === 'claude' || provider === 'codex';
  useEffect(() => {
    if (!canJoinCluster && joinCluster) setJoinCluster(false);
  }, [canJoinCluster, joinCluster]);
  useEffect(() => {
    if (provider !== 'codex') {
      setProviderAccountRef(undefined);
      return;
    }
    if (!providerAccountRef && codexAccounts.length > 0) {
      setProviderAccountRef(parentConfig.primaryProvider === 'codex' ? parentConfig.providerAccountRef : codexAccounts[0]?.id);
      return;
    }
    if (providerAccountRef && !codexAccounts.some((a) => a.id === providerAccountRef)) {
      setProviderAccountRef(codexAccounts[0]?.id);
    }
  }, [provider, providerAccountRef, codexAccounts, parentConfig.primaryProvider, parentConfig.providerAccountRef]);

  const availableProviders = (['claude', 'codex', 'cursor', 'gemini',  'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek'] as ProviderName[]).filter((p) => {
    if (!isProviderEnabled(p)) return false;

    return Boolean(authStatus?.[p]?.loggedIn);
  });

  const modelChoices: ModelName[] = modelsForProvider(provider, catalogs);

  // Clamp model to one that actually exists in the current pill set.
  // Catches: dialog opened before catalog loaded (default 'sonnet' alias),
  // catalog arriving mid-render (alias becomes invalid), provider switch
  // mid-edit. Same as ReviewDialog.
  useEffect(() => {
    if (modelChoices.length === 0) return;
    if (!modelChoices.includes(model)) {
      setModel(defaultModelForProvider(provider, catalogs));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, model, catalogs]);

  const submit = () => {
    const newConfig: WorkflowConfig = {
      ...parentConfig,
      name: name.trim() || `${parentConfig.name} (spawn)`,
      // claude is the implicit default — encoded as undefined; everything
      // else needs primaryProvider set explicitly so the server picks the
      // right CLI / HTTP client.
      ...(provider !== 'claude' ? { primaryProvider: provider } : { primaryProvider: undefined }),
      primaryModel: model,
      primaryEffort: effort,
      providerAccountRef: provider === 'codex' ? providerAccountRef : undefined,
      resumeSessionId: undefined,
      resumeWorkflowId: undefined,
    };
    const joinClusterId = clusterContext && joinCluster ? clusterContext.clusterId : undefined;
    onConfirm(newConfig, direction, parentPlanTitle ? includePlan : false, joinClusterId);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-accent-primary-dim)',
          borderRadius: '6px',
          padding: '18px 22px',
          width: 'min(520px, calc(94vw / var(--ui-scale, 1)))',
          maxHeight: 'calc(88vh / var(--ui-scale, 1))',
          overflowY: 'auto',
          fontFamily: 'var(--font-body)',
        }}
      >
        <div
          className="display-font"
          style={{ fontSize: '12px', letterSpacing: '3px', color: 'var(--color-accent-primary)', marginBottom: '14px' }}
        >
          SPAWN FROM HERE
        </div>

        <Field label="NAME" helpKey="spawn.name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              width: '100%',
              padding: '6px 10px',
              background: 'var(--color-bg-sunken)',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-accent-primary)',
              fontSize: '12px',
              outline: 'none',
            }}
          />
        </Field>

        <Field label="PRIMARY PROVIDER" helpKey="spawn.provider">
          <Row>
            {availableProviders.map((p) => (
              <Pill
                key={p}
                active={provider === p}
                onClick={() => {
                  setProvider(p);
                  // Reset model to a sensible default for the new provider.
                  // For local providers, the default is the first installed
                  // alias; if none are installed the model picker below will
                  // show empty (operator can't spawn without one — same
                  // behavior as the current provider's no-model path).
                  if (!modelsForProvider(p, catalogs).includes(model)) {
                    setModel(defaultModelForProvider(p, catalogs));
                  }
                  if (p === 'codex') {
                    setProviderAccountRef(parentConfig.primaryProvider === 'codex' ? parentConfig.providerAccountRef : codexAccounts[0]?.id);
                  } else {
                    setProviderAccountRef(undefined);
                  }
                  setEffort(clampEffortForProvider(effort, p));
                }}
              >
                {p === 'llamacpp' ? 'LLAMA' : p === 'lmstudio' ? 'LM STUDIO' : p === 'deepseek' ? 'XOLOTL' : p.toUpperCase()}
              </Pill>
            ))}
          </Row>
        </Field>

        {provider === 'codex' && codexAccounts.length > 0 && (
          <Field label="ACCOUNT" helpKey="spawn.account">
            <Row>
              {codexAccounts.map((account) => {
                const status = authStatus?.codex?.accountStatuses?.find((s) => s.id === account.id);
                const short = (account.shortLabel || account.label || account.id).slice(0, 4).toUpperCase();
                return (
                  <Pill
                    key={account.id}
                    active={providerAccountRef === account.id}
                    onClick={() => setProviderAccountRef(account.id)}
                    small
                    title={status?.loggedIn ? `${account.label} authenticated` : `${account.label} not authenticated`}
                  >
                    {account.label.toUpperCase()} [{short}]
                  </Pill>
                );
              })}
            </Row>
          </Field>
        )}


        {(
          <Field label="MODEL" helpKey="spawn.model">
            {provider === 'cursor' && cursorCatalog?.models?.length ? (
              // Cursor: family × effort × flags (effort baked into the id).
              <CursorModelSelect
                value={String(model)}
                onChange={(id) => setModel(id as ModelName)}
                selectStyle={pickerSelectStyle}
              />
            ) : modelChoices.length === 0 ? (
              <div className="display-font" style={{ padding: '6px 10px', border: '1px dashed var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '0.5px' }}>
                {provider === 'ollama'
                  ? 'No Ollama models installed. Run `ollama pull <model>` and refresh.'
                  : provider === 'llamacpp'
                    ? 'No llama.cpp models registered. Edit ~/.arco/llamacpp.json (see docs/PROVIDERS.md § llama.cpp) and refresh.'
                    : 'No models available for this provider.'}
              </div>
            ) : (
              <Row>
                {modelChoices.map((m) => {
                  const desc = provider === 'codex' ? codexCatalog?.models?.find((cm) => cm.id === m)?.description : undefined;
                  return (
                    <Pill key={m} active={model === m} onClick={() => setModel(m)} small title={desc}>
                      {provider === 'claude' ? claudeModelLabel(String(m), claudeNativeCatalog) : String(m)}
                    </Pill>
                  );
                })}
              </Row>
            )}
          </Field>
        )}

        {(() => {
          const honored = effortsForModel(provider, model, claudeNativeCatalog, codexCatalog);
          if (honored.length === 0) {
            const reason = provider === 'gemini' ? 'Gemini CLI has no effort flag.'
              : provider === 'ollama' ? 'Local models have no effort flag.'
              : provider === 'cursor' ? 'Cursor bakes effort into the model id — set it in the MODEL picker above.'
              : 'Provider does not honor effort.';
            return (
              <Field label="EFFORT" helpKey="spawn.effort">
                <div className="display-font" style={{ padding: '6px 10px', border: '1px dashed var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '0.5px' }}>
                  {reason}
                </div>
              </Field>
            );
          }
          return (
            <Field label="EFFORT" helpKey="spawn.effort">
              <Row>
                {honored.map((e) => (
                  <Pill key={e} active={effort === e} onClick={() => setEffort(e)} small>
                    {e.toUpperCase()}
                  </Pill>
                ))}
              </Row>
            </Field>
          );
        })()}

        <Field label="NEW DIRECTION (optional)" helpKey="spawn.direction">
          <textarea
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
            rows={3}
            placeholder="What should the spawned agent focus on? Leave blank to let it pick up where the parent left off."
            style={{
              width: '100%',
              padding: '6px 10px',
              background: 'var(--color-bg-sunken)',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-accent-primary)',
              fontSize: '12px',
              outline: 'none',
              resize: 'vertical',
              fontFamily: 'var(--font-body)',
            }}
          />
        </Field>

        {parentPlanTitle && (
          <Field label="PLAN" helpKey="spawn.plan">
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '11px',
                color: 'var(--color-fg-muted)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={includePlan}
                onChange={(e) => setIncludePlan(e.target.checked)}
                style={{ accentColor: 'var(--color-accent-primary)' }}
              />
              <span>
                Include plan from parent —{' '}
                <span style={{ color: 'var(--color-accent-primary)' }}>{parentPlanTitle}</span>
              </span>
            </label>
          </Field>
        )}

        {clusterContext && (
          <Field label="CLUSTER" helpKey="spawn.cluster">
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '11px',
                color: canJoinCluster ? 'var(--color-fg-muted)' : 'var(--color-fg-subtle, var(--color-fg-muted))',
                cursor: canJoinCluster ? 'pointer' : 'not-allowed',
                opacity: canJoinCluster ? 1 : 0.55,
              }}
              title={canJoinCluster ? undefined : 'Cluster membership is Claude or Codex only today (Gemini / Ollama / llama.cpp have no MCP wiring path).'}
            >
              <input
                type="checkbox"
                checked={joinCluster}
                disabled={!canJoinCluster}
                onChange={(e) => setJoinCluster(e.target.checked)}
                style={{ accentColor: 'var(--color-accent-primary)' }}
              />
              <span>
                Spawn into cluster —{' '}
                <span style={{ color: canJoinCluster ? 'var(--color-accent-primary)' : 'inherit' }}>{clusterContext.name}</span>
                {!canJoinCluster && (
                  <span style={{ marginLeft: '8px', color: 'var(--color-warning)' }}>
                    (Claude or Codex only)
                  </span>
                )}
              </span>
            </label>
          </Field>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '6px' }}>
          <span data-help="spawn.cancel" style={{ display: 'inline-flex' }}>
            <Btn onClick={onCancel}>CANCEL</Btn>
          </span>
          <span data-help="spawn.confirm" style={{ display: 'inline-flex' }}>
            <Btn primary onClick={submit}>SPAWN</Btn>
          </span>
        </div>

        <div
          className="display-font"
          style={{ marginTop: '10px', fontSize: '9px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px' }}
        >
          Parent tab stays live. A fresh session opens in a new tab pre-warmed with a handoff of the parent's context.
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, helpKey }: { label: string; children: React.ReactNode; helpKey?: string }) {
  return (
    <div data-help={helpKey} style={{ marginBottom: '10px' }}>
      <div
        className="display-font"
        style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '4px' }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>{children}</div>;
}

function Pill({
  active,
  onClick,
  disabled,
  children,
  small,
  title,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  small?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="display-font"
      style={{
        padding: small ? '4px 8px' : '6px 10px',
        background: active ? 'var(--color-accent-primary-a10)' : 'transparent',
        border: `1px solid ${active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
        borderRadius: '3px',
        color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: small ? '10px' : '11px',
        letterSpacing: '1px',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

function Btn({ onClick, children, primary }: { onClick: () => void; children: React.ReactNode; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="display-font"
      style={{
        padding: '6px 14px',
        background: primary ? 'var(--color-accent-primary-a10)' : 'transparent',
        border: `1px solid ${primary ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
        borderRadius: '3px',
        color: primary ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
        cursor: 'pointer',
        fontSize: '11px',
        letterSpacing: '2px',
      }}
    >
      {children}
    </button>
  );
}
