import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  CLAUDE_MODELS,
  DEFAULT_CODEX_MODEL,
  type ClusterMemberAccessMode,
  type ClusterMemberProvider,
  type ClusterStatePayload,
  type EffortLevel,
} from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { useCodexCatalogFor } from '../../hooks/useCodexCatalog';
import { effortsForModel } from '../../utils/format';
import { modelsForProvider, useModelCatalogs } from '../../utils/modelCatalog';

const menuStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'var(--color-bg-sunken)',
  color: 'var(--color-accent-primary)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  padding: '4px 7px',
  outline: 'none',
  cursor: 'pointer',
  fontFamily: 'var(--font-code)',
  fontSize: '11px',
  letterSpacing: '0.5px',
  colorScheme: 'dark',
};

export function ReplaceMemberDialog({
  cluster,
  member,
  onClose,
}: {
  cluster: ClusterStatePayload;
  member: ClusterStatePayload['members'][number];
  onClose: () => void;
}) {
  const job = useAppStore((s) => s.jobs[member.workflowId]);
  const wsSendRaw = useAppStore((s) => s.wsSendRaw);
  const settings = useAppStore((s) => s.settings);
  const authStatus = useAppStore((s) => s.authStatus);
  const originalProvider = (job?.config.primaryProvider ?? 'claude') as ClusterMemberProvider;
  const originalModel = String(job?.config.primaryModel ?? '');
  const originalEffort = String(job?.config.primaryEffort ?? 'medium');
  const originalAccount = job?.config.providerAccountRef;
  const [provider, setProvider] = useState<ClusterMemberProvider>(originalProvider);
  const [model, setModel] = useState(originalModel);
  const [effort, setEffort] = useState<EffortLevel>(originalEffort as EffortLevel);
  const [account, setAccount] = useState<string | undefined>(originalAccount);
  const [accessMode, setAccessMode] = useState<ClusterMemberAccessMode>(member.accessMode ?? 'standard');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [transferTasks, setTransferTasks] = useState(true);
  const codexAccounts = settings?.providerAccounts?.codex ?? [];
  const codexCatalog = useCodexCatalogFor(account);
  const catalogs = useModelCatalogs({ codex: codexCatalog });
  const { claude: claudeCatalog, cursor: cursorCatalog } = catalogs;

  const modelOptions = useMemo(
    () => modelsForProvider(provider, catalogs).map(String),
    [provider, catalogs],
  );
  const effortOptions = useMemo(
    () => effortsForModel(provider, model, claudeCatalog, codexCatalog),
    [provider, model, claudeCatalog, codexCatalog],
  );

  useEffect(() => {
    if (effortOptions.length > 0 && !effortOptions.includes(effort)) {
      setEffort(effortOptions[effortOptions.length - 1]);
    }
  }, [effortOptions, effort]);

  const pickProvider = (next: ClusterMemberProvider) => {
    if (accessMode === 'isolated' && next !== 'claude') return;
    setProvider(next);
    if (next === originalProvider) {
      setModel(originalModel);
      setEffort(originalEffort as EffortLevel);
      setAccount(next === 'codex' ? originalAccount : undefined);
      return;
    }
    const first = next === 'claude'
      ? (claudeCatalog?.models?.[0]?.id ?? CLAUDE_MODELS[0])
      : next === 'codex'
        ? (codexCatalog?.models?.find((m) => !m.hidden)?.id ?? DEFAULT_CODEX_MODEL)
        : next === 'ollama'
            ? (authStatus?.ollama?.installedModels?.[0] ?? '')
            : next === 'llamacpp'
              ? (authStatus?.llamacpp?.installedModels?.[0] ?? '')
              : (cursorCatalog?.models?.find((m) => m.isDefault)?.id ?? 'auto');
    setModel(first);
    setEffort('medium');
    setAccount(next === 'codex' ? codexAccounts[0]?.id : undefined);
  };

  const pickAccess = (next: ClusterMemberAccessMode) => {
    setAccessMode(next);
    if (next === 'isolated') {
      if (provider !== 'claude') pickProvider('claude');
      setIncludeHistory(false);
      setTransferTasks(false);
    }
  };

  const submit = () => {
    if (!wsSendRaw || !model) return;
    wsSendRaw({
      type: 'cluster_member_replace',
      clusterId: cluster.clusterId,
      workflowId: member.workflowId,
      ...(provider !== originalProvider ? { provider } : {}),
      ...(model !== originalModel ? { model } : {}),
      ...(effort !== originalEffort ? { effort } : {}),
      ...(provider === 'codex' && account !== originalAccount ? { providerAccountRef: account } : {}),
      accessMode,
      includeHistory,
      transferActiveTasks: transferTasks,
    });
    onClose();
  };

  return (
    <div style={{ border: '1px solid var(--color-accent-primary)', padding: '8px', display: 'flex', flexDirection: 'column', gap: '7px' }}>
      <div
        className="display-font"
        data-help="cluster.member-replace"
        style={{ fontSize: '10px', color: 'var(--color-accent-primary)', letterSpacing: '1px' }}
      >
        REPLACE WITH A NEW WORKER
      </div>
      <div style={{ color: 'var(--color-fg-muted)', fontSize: '10px', lineHeight: 1.4 }}>
        Name, role, tier, focus, and all tab settings are cloned. The provider session and workflow ID are always new.
      </div>
      <label
        className="display-font"
        data-help="cluster.replace.provider"
        style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px' }}
      >
        PROVIDER
        <select
          className="display-font"
          data-help="cluster.replace.provider"
          value={provider}
          onChange={(e) => pickProvider(e.target.value as ClusterMemberProvider)}
          style={menuStyle}
        >
          {(['claude', 'codex', 'ollama', 'llamacpp', 'cursor'] as ClusterMemberProvider[]).map((p) => (
            <option key={p} value={p} disabled={accessMode === 'isolated' && p !== 'claude'}>{p.toUpperCase()}</option>
          ))}
        </select>
      </label>
      <label
        className="display-font"
        data-help="cluster.replace.model"
        style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px' }}
      >
        MODEL
        <select
          className="display-font"
          data-help="cluster.replace.model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          style={menuStyle}
        >
          {modelOptions.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </label>
      {effortOptions.length > 0 && (
        <label
          className="display-font"
          data-help="cluster.replace.effort"
          style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px' }}
        >
          EFFORT
          <select
            className="display-font"
            data-help="cluster.replace.effort"
            value={effort}
            onChange={(e) => setEffort(e.target.value as EffortLevel)}
            style={menuStyle}
          >
            {effortOptions.map((id) => <option key={id} value={id}>{id.toUpperCase()}</option>)}
          </select>
        </label>
      )}
      {provider === 'codex' && codexAccounts.length > 0 && (
        <label
          className="display-font"
          data-help="cluster.replace.account"
          style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px' }}
        >
          ACCOUNT
          <select
            className="display-font"
            data-help="cluster.replace.account"
            value={account ?? ''}
            onChange={(e) => setAccount(e.target.value || undefined)}
            style={menuStyle}
          >
            {codexAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
      )}
      <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
        {(['standard', 'blind', 'isolated'] as ClusterMemberAccessMode[]).map((mode) => (
          <button
            key={mode}
            data-help="cluster.replace.access"
            onClick={() => pickAccess(mode)}
            className="display-font"
            style={{
              padding: '3px 7px',
              background: accessMode === mode ? 'var(--color-accent-primary-a10)' : 'transparent',
              border: `1px solid ${accessMode === mode ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
              color: accessMode === mode ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              fontSize: '9px',
              letterSpacing: '1px',
              cursor: 'pointer',
            }}
          >
            {mode.toUpperCase()}
          </button>
        ))}
      </div>
      <div style={{ color: 'var(--color-fg-muted)', fontSize: '10px', lineHeight: 1.35 }}>
        {accessMode === 'standard'
          ? 'Normal cluster context and project access.'
          : accessMode === 'blind'
            ? 'Project access remains, but only peer_send / peer_read and no cluster coordination context or task tools. A standard member must perform board transitions from mailed completion reports.'
            : 'Claude Native in a private scratch workspace outside the project. No history or task transfer.'}
      </div>
      <label
        className="display-font"
        data-help="cluster.replace.history"
        style={{ fontSize: '10px', color: 'var(--color-fg)', opacity: accessMode === 'isolated' ? 0.45 : 1 }}
      >
        <input
          type="checkbox"
          data-help="cluster.replace.history"
          checked={includeHistory}
          disabled={accessMode === 'isolated'}
          onChange={(e) => setIncludeHistory(e.target.checked)}
          style={{ accentColor: 'var(--color-accent-primary)' }}
        /> INCLUDE PRIOR WORKFLOW HISTORY
      </label>
      <label
        className="display-font"
        data-help="cluster.replace.tasks"
        style={{ fontSize: '10px', color: 'var(--color-fg)', opacity: accessMode === 'isolated' ? 0.45 : 1 }}
      >
        <input
          type="checkbox"
          data-help="cluster.replace.tasks"
          checked={transferTasks}
          disabled={accessMode === 'isolated'}
          onChange={(e) => setTransferTasks(e.target.checked)}
          style={{ accentColor: 'var(--color-accent-primary)' }}
        /> TRANSFER ACTIVE TASK ASSIGNMENTS
      </label>
      {includeHistory && (
        <div style={{ color: 'var(--color-warning)', fontSize: '10px' }}>
          This starts one visible seed turn and spends a model call. No provider session is reused.
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
        <button
          type="button"
          onClick={onClose}
          className="display-font"
          style={{
            padding: '4px 10px',
            background: 'transparent',
            border: '1px solid var(--color-border-hairline)',
            color: 'var(--color-fg-muted)',
            cursor: 'pointer',
            fontSize: '10px',
            letterSpacing: '1px',
          }}
        >
          CANCEL
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!model}
          data-help="cluster.replace.confirm"
          className="display-font"
          style={{
            padding: '4px 10px',
            background: model ? 'var(--color-accent-primary)' : 'transparent',
            border: model ? '1px solid var(--color-accent-primary)' : '1px solid var(--color-border-hairline)',
            color: model ? 'var(--color-bg)' : 'var(--color-fg-muted)',
            cursor: model ? 'pointer' : 'not-allowed',
            fontSize: '10px',
            letterSpacing: '1px',
          }}
        >
          REPLACE
        </button>
      </div>
    </div>
  );
}
