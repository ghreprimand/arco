import { useEffect } from 'react';
import type { ProviderName, ModelName, EffortLevel } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { effortsForModel, clampEffortForProvider } from '../utils/format';
import { claudeModelLabel, defaultModelForProvider, modelsForProvider, useModelCatalogs } from '../utils/modelCatalog';

// Reusable provider / model / effort picker for "RUN AS" rows in dialogs
// that dispatch one-off prompts (GIT, DOCS). Defaults to the current tab's
// primary; if the operator picks something else, the parent dialog
// spawns a new tab with that config instead of dispatching to current.
//
// Mirrors the picker style in ReviewDialog/SpawnDialog. Eventually those
// could adopt this component too — current scope is just GIT + DOCS.

export interface RunAsSelection {
  provider: ProviderName;
  model: ModelName;
  effort: EffortLevel;
  providerAccountRef?: string;
}

interface Props {
  current: RunAsSelection;
  selection: RunAsSelection;
  onChange: (next: RunAsSelection) => void;
  hint?: string;
}

export function RunAsPicker({ current, selection, onChange, hint }: Props) {
  const authStatus = useAppStore((s) => s.authStatus);
  const isProviderEnabled = useAppStore((s) => s.isProviderEnabled);
  const settings = useAppStore((s) => s.settings);
  const catalogs = useModelCatalogs();
  const { claude: claudeNativeCatalog, codex: codexCatalog, ollamaModels, llamacppModels, lmstudioModels, strataModels, deepseekModels = [] } = catalogs;
  const codexAccounts = settings?.providerAccounts?.codex ?? [];

  const availableProviders = (['claude', 'codex', 'zai', 'cursor', 'gemini', 'antigravity', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek'] as ProviderName[]).filter((p) => {
    if (!isProviderEnabled(p)) return false;
    if (p === 'antigravity') return true;
    if (p === 'ollama') return !!authStatus?.ollama?.loggedIn && ollamaModels.length > 0;
    if (p === 'llamacpp') return !!authStatus?.llamacpp?.loggedIn && llamacppModels.length > 0;
    if (p === 'strata') return !!authStatus?.strata?.loggedIn && strataModels.length > 0;
    if (p === 'deepseek') return !!authStatus?.deepseek?.loggedIn && deepseekModels.length > 0;
    if (p === 'lmstudio') return !!authStatus?.lmstudio?.loggedIn && lmstudioModels.length > 0;
    return !!authStatus?.[p]?.loggedIn;
  });

  const setProvider = (p: ProviderName) => {
    const allowed = modelsForProvider(p, catalogs);
    const nextModel = allowed.includes(selection.model) ? selection.model : defaultModelForProvider(p, catalogs);
    const nextEffort = clampEffortForProvider(selection.effort, p);
    onChange({
      provider: p,
      model: nextModel,
      effort: nextEffort,
      ...(p === 'codex' ? { providerAccountRef: current.provider === 'codex' ? current.providerAccountRef : codexAccounts[0]?.id } : {}),
    });
  };
  const setModel = (m: ModelName) => onChange({ ...selection, model: m });
  const setEffort = (e: EffortLevel) => onChange({ ...selection, effort: e });

  const isCurrent = selection.provider === current.provider && selection.model === current.model && selection.effort === current.effort;
  const honoredEfforts = effortsForModel(selection.provider, selection.model, claudeNativeCatalog, codexCatalog);
  const modelChoices = modelsForProvider(selection.provider, catalogs);

  // Clamp selection.model to one that actually exists in the current pill
  // set. Catches: parent dialog opened before catalog loaded ('sonnet' alias),
  // catalog arriving mid-render (alias becomes invalid). Same as
  // ReviewDialog. Uses onChange because state is owned by the parent.
  useEffect(() => {
    if (modelChoices.length === 0) return;
    if (!modelChoices.includes(selection.model)) {
      onChange({
        ...selection,
        model: defaultModelForProvider(selection.provider, catalogs),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.provider, selection.model, catalogs]);
  useEffect(() => {
    if (selection.provider !== 'codex') return;
    if (selection.providerAccountRef && codexAccounts.some((a) => a.id === selection.providerAccountRef)) return;
    if (codexAccounts.length === 0) return;
    onChange({
      ...selection,
      providerAccountRef: current.provider === 'codex' && current.providerAccountRef ? current.providerAccountRef : codexAccounts[0]?.id,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.provider, selection.providerAccountRef, codexAccounts, current.provider, current.providerAccountRef]);

  return (
    <div data-help="composer.run-as">
      <div className="display-font" style={labelStyle}>
        RUN AS
        <button
          onClick={() => onChange(current)}
          disabled={isCurrent}
          className="display-font"
          style={{
            marginLeft: '8px',
            padding: '1px 6px',
            background: 'transparent',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: isCurrent ? 'var(--color-fg-muted)' : 'var(--color-accent-secondary-dim)',
            cursor: isCurrent ? 'default' : 'pointer',
            fontSize: '8px',
            letterSpacing: '1px',
            opacity: isCurrent ? 0.4 : 1,
          }}
          title="Reset to the tab's current primary agent"
        >
          ↻ RESET TO CURRENT
        </button>
      </div>
      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
        {availableProviders.map((p) => (
          <Pill key={p} active={selection.provider === p} onClick={() => setProvider(p)}>
            {p === 'llamacpp' ? 'LLAMA' : p === 'lmstudio' ? 'LM STUDIO' : p === 'antigravity' ? 'ANTIGRAV' : p === 'deepseek' ? 'XOLOTL' : p.toUpperCase()}
          </Pill>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
        {modelChoices.length === 0 && (
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontStyle: 'italic', padding: '4px' }}>
            No models available — install one in {selection.provider}.
          </div>
        )}
        {modelChoices.map((m) => {
          const desc = selection.provider === 'codex' ? codexCatalog?.models?.find((cm) => cm.id === m)?.description : undefined;
          return (
            <Pill key={m} active={selection.model === m} onClick={() => setModel(m)} small title={desc}>
              {selection.provider === 'claude' ? claudeModelLabel(String(m), claudeNativeCatalog) : String(m)}
            </Pill>
          );
        })}
      </div>
      {selection.provider === 'codex' && codexAccounts.length > 0 && (
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
          {codexAccounts.map((acct) => {
            const short = (acct.shortLabel || acct.label || acct.id).slice(0, 4).toUpperCase();
            return (
              <Pill
                key={acct.id}
                active={selection.providerAccountRef === acct.id}
                onClick={() => onChange({ ...selection, providerAccountRef: acct.id })}
                small
              >
                {acct.label.toUpperCase()} [{short}]
              </Pill>
            );
          })}
        </div>
      )}
      {honoredEfforts.length > 0 && (
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
          {honoredEfforts.map((e) => (
            <Pill key={e} active={selection.effort === e} onClick={() => setEffort(e)} small>
              {e.toUpperCase()}
            </Pill>
          ))}
        </div>
      )}
      <div style={hintStyle}>
        {hint ?? (isCurrent
          ? 'Will dispatch to the tab\'s current primary as a regular turn.'
          : 'Will spawn a new tab with this config so the work runs there. Current chat is left alone.')}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: '10px',
  letterSpacing: '2px',
  color: 'var(--color-accent-primary-dim)',
  marginBottom: '4px',
  display: 'flex',
  alignItems: 'center',
};

const hintStyle: React.CSSProperties = {
  fontSize: '9px',
  color: 'var(--color-fg-muted)',
  letterSpacing: '0.5px',
  lineHeight: 1.5,
  marginTop: '4px',
  fontFamily: 'var(--font-display)',
};

function Pill({
  active,
  onClick,
  children,
  small,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  small?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="display-font"
      style={{
        padding: small ? '3px 7px' : '4px 8px',
        background: active ? 'var(--color-accent-primary-a10)' : 'transparent',
        border: `1px solid ${active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
        borderRadius: '3px',
        color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
        cursor: 'pointer',
        fontSize: small ? '10px' : '11px',
        letterSpacing: '1px',
      }}
    >
      {children}
    </button>
  );
}

// Build a WorkflowConfig from the picked RUN AS selection, inheriting
// non-primary fields (cwd, name, theme, etc.) from the parent tab.
// Same shape SpawnDialog produces — keeps the spawn path uniform.
import type { WorkflowConfig } from '@arco/shared';
export function spawnConfigFromRunAs(parentConfig: WorkflowConfig, selection: RunAsSelection, nameSuffix: string): WorkflowConfig {
  // docs/PROVIDERS.md - DOCS / GIT one-off prompts must run with
  // outputStyle: 'normal' regardless of source tab. The dialog callers pass
  // nameSuffix='docs' | 'git'; force normal for both. Other RUN AS users
  // (currently none, but future call sites) inherit the parent value.
  const isPrimitiveOneOff = nameSuffix === 'docs' || nameSuffix === 'git' || nameSuffix === 'research';
  return {
    ...parentConfig,
    name: `${parentConfig.name} (${nameSuffix})`,
    primaryProvider: selection.provider === 'claude' ? undefined : selection.provider,
    primaryModel: selection.model,
    primaryEffort: selection.effort,
    providerAccountRef: selection.provider === 'codex' ? selection.providerAccountRef : undefined,
    resumeSessionId: undefined,
    resumeWorkflowId: undefined,
    ...(isPrimitiveOneOff ? { outputStyle: 'normal' as const } : {}),
  };
}
