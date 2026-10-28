import { useEffect, useState, type CSSProperties } from 'react';
import type { WorkflowConfig, ProviderName, ModelName, EffortLevel } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { effortsForModel, clampEffortForProvider } from '../utils/format';
import { claudeModelLabel, defaultModelForProvider, modelsForProvider, useModelCatalogs } from '../utils/modelCatalog';
import { CursorModelSelect } from './CursorModelSelect';

// Shared look for the Cursor family/effort dropdowns — matches the dialog's
// text inputs (sunken bg, hairline border, accent text).
const cursorSelectStyle: CSSProperties = {
  padding: '5px 8px',
  background: 'var(--color-bg-sunken)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary)',
  fontSize: '11px',
  outline: 'none',
  cursor: 'pointer',
};

type Mode = 'original-worker' | 'fresh-summarizer' | 'fresh-agent';

interface Props {
  currentConfig: WorkflowConfig;
  onConfirm: (
    mode: Mode,
    newPrimary?: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string },
    // WP2 — the agent that WRITES the handoff (fresh-summarizer mode). Passing a
    // fresh strong model here dodges the degraded-worker-summarizes-itself trap.
    summarizer?: { provider: ProviderName; model: ModelName; effort: EffortLevel },
  ) => void;
  onCancel: () => void;
}

export function HandoffDialog({ currentConfig, onConfirm, onCancel }: Props) {
  const authStatus = useAppStore((s) => s.authStatus);
  const isProviderEnabled = useAppStore((s) => s.isProviderEnabled);
  const settings = useAppStore((s) => s.settings);
  const catalogs = useModelCatalogs();
  const { claude: claudeNativeCatalog, codex: codexCatalog, cursor: cursorCatalog, ollamaModels, llamacppModels, lmstudioModels, strataModels, deepseekModels = [] } = catalogs;

  const [mode, setMode] = useState<Mode>('original-worker');

  const currentProvider: ProviderName = currentConfig.primaryProvider ?? 'claude';
  const [provider, setProvider] = useState<ProviderName>(currentProvider);
  const [model, setModel] = useState<ModelName>(currentConfig.primaryModel);
  const [effort, setEffort] = useState<EffortLevel>(currentConfig.primaryEffort);
  const [providerAccountRef, setProviderAccountRef] = useState<string | undefined>(currentConfig.providerAccountRef);
  const codexAccounts = settings?.providerAccounts?.codex ?? [];
  const accountChanged = provider === 'codex' && providerAccountRef !== currentConfig.providerAccountRef;

  // WP2/WP5 — summarizer (writes the handoff in fresh-summarizer mode).
  // Default resolution mirrors the server's auto-handoff chain: per-tab
  // override → global pinned summarizer → the tab's primary. The whole point is
  // to NOT let a degraded current worker summarize itself, so the picker is
  // shown for fresh-summarizer mode.
  const configuredSummarizer = currentConfig.autoHandoff?.summarizer ?? settings?.handoffSummarizer;
  const [sumProvider, setSumProvider] = useState<ProviderName>(configuredSummarizer?.provider ?? currentProvider);
  const [sumModel, setSumModel] = useState<ModelName>((configuredSummarizer?.model as ModelName) ?? currentConfig.primaryModel);
  const [sumEffort, setSumEffort] = useState<EffortLevel>(configuredSummarizer?.effort ?? currentConfig.primaryEffort);

  const primaryChanged =
    provider !== currentProvider ||
    model !== currentConfig.primaryModel ||
    effort !== currentConfig.primaryEffort ||
    accountChanged;

  const availableProviders = (['claude', 'codex', 'cursor', 'gemini', 'antigravity', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek'] as ProviderName[]).filter((p) => {
    // Antigravity isn't a toggleable provider; offer it unconditionally like the
    // Spawn / RUN AS / Review pickers (reachability is surfaced in CONFIG).
    if (p === 'antigravity') return true;
    if (!isProviderEnabled(p)) return false;
    if (p === 'ollama') return !!authStatus?.ollama?.loggedIn && ollamaModels.length > 0;
    if (p === 'llamacpp') return !!authStatus?.llamacpp?.loggedIn && llamacppModels.length > 0;
    if (p === 'strata') return !!authStatus?.strata?.loggedIn && strataModels.length > 0;
    if (p === 'deepseek') return !!authStatus?.deepseek?.loggedIn && deepseekModels.length > 0;
    if (p === 'lmstudio') return !!authStatus?.lmstudio?.loggedIn && lmstudioModels.length > 0;
    return !!authStatus?.[p]?.loggedIn;
  });

  // Clamp model to one that actually exists in the current pill set.
  // Catches: dialog opened before catalog loaded (default 'sonnet' alias),
  // catalog arriving mid-render (alias becomes invalid), provider switch
  // mid-edit. Same as ReviewDialog.
  useEffect(() => {
    const available = modelsForProvider(provider, catalogs);
    if (available.length === 0) return;
    if (!available.includes(model)) {
      setModel(defaultModelForProvider(provider, catalogs));
    }
  }, [provider, model, catalogs]);

  // Clamp the summarizer model to one that exists in its provider's pill set —
  // same rationale as the primary clamp above (catalog timing, provider switch).
  useEffect(() => {
    const available = modelsForProvider(sumProvider, catalogs);
    if (available.length === 0) return;
    if (!available.includes(sumModel)) {
      setSumModel(defaultModelForProvider(sumProvider, catalogs));
    }
  }, [sumProvider, sumModel, catalogs]);

  useEffect(() => {
    if (provider !== 'codex') {
      setProviderAccountRef(undefined);
      return;
    }
    if (!providerAccountRef && codexAccounts.length > 0) {
      setProviderAccountRef(codexAccounts[0]?.id);
      return;
    }
    if (providerAccountRef && !codexAccounts.some((a) => a.id === providerAccountRef)) {
      setProviderAccountRef(codexAccounts[0]?.id);
    }
  }, [provider, providerAccountRef, codexAccounts]);

  const confirm = () => {
    onConfirm(
      mode,
      primaryChanged ? { provider, model, effort, ...(provider === 'codex' && providerAccountRef ? { providerAccountRef } : {}) } : undefined,
      // WP2 — only fresh-summarizer mode uses a separate summarizer worker; the
      // original-worker path reflects on the live session and ignores this.
      mode === 'fresh-summarizer' ? { provider: sumProvider, model: sumModel, effort: sumEffort } : undefined,
    );
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
          style={{
            fontSize: '12px',
            letterSpacing: '3px',
            color: 'var(--color-accent-primary)',
            marginBottom: '6px',
          }}
        >
          ROTATE SESSION
        </div>
        <div
          className="display-font"
          style={{ fontSize: '10px', color: 'var(--color-fg-muted)', marginBottom: '14px', letterSpacing: '0.5px', lineHeight: 1.5 }}
        >
          {currentProvider === 'antigravity'
            ? 'Generates a handoff document and seeds a fresh Antigravity cascade in the same tab. This does not compact Antigravity internal context.'
            : 'Archives the current session, generates a handoff document, and seeds a fresh session in the same tab.'}
        </div>

        <div data-help="handoff.mode" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
          <ModePill
            active={mode === 'original-worker'}
            label="ORIGINAL WORKER"
            hint="Primary self-reflects with full session context: runs git, reads project docs, writes the handoff, updates DEVLOG.md/PLAN.md. Highest fidelity. Default."
            onClick={() => setMode('original-worker')}
          />
          <ModePill
            active={mode === 'fresh-summarizer'}
            label="FRESH SUMMARIZER"
            hint="Ephemeral worker reads a rendered transcript. Lower fidelity; use when the primary can't be resumed (e.g. Ollama)."
            onClick={() => setMode('fresh-summarizer')}
          />
        </div>

        {mode === 'fresh-summarizer' && (
          <div style={{ marginBottom: '16px', paddingBottom: '14px', borderBottom: '1px solid var(--color-border-hairline)' }}>
            <div
              className="display-font"
              style={{
                fontSize: '10px',
                letterSpacing: '2px',
                color: 'var(--color-accent-secondary-dim)',
                marginBottom: '6px',
              }}
            >
              SUMMARIZER (WRITES THE HANDOFF)
            </div>
            <div
              className="display-font"
              style={{ fontSize: '9px', color: 'var(--color-fg-muted)', marginBottom: '10px', letterSpacing: '0.5px', lineHeight: 1.5 }}
            >
              Picking a fresh strong model helps when the current worker is out of context — it shouldn't summarize its own degraded session.
            </div>

            <Field label="PROVIDER" helpKey="handoff.summarizer.provider">
              <Row>
                {availableProviders.map((p) => (
                  <Pill
                    key={p}
                    active={sumProvider === p}
                    onClick={() => {
                      setSumProvider(p);
                      if (!modelsForProvider(p, catalogs).includes(sumModel)) {
                        setSumModel(defaultModelForProvider(p, catalogs));
                      }
                      setSumEffort(clampEffortForProvider(sumEffort, p));
                    }}
                  >
                    {p === 'llamacpp' ? 'LLAMA' : p === 'lmstudio' ? 'LM STUDIO' : p === 'antigravity' ? 'ANTIGRAV' : p === 'deepseek' ? 'XOLOTL' : p.toUpperCase()}
                  </Pill>
                ))}
              </Row>
            </Field>

            <Field label="MODEL" helpKey="handoff.summarizer.model">
              {sumProvider === 'cursor' && cursorCatalog?.models?.length ? (
                // Cursor: family × effort × flags (effort baked into the id) — ~150 ids
                // is too many for a pill row. Same picker as SpawnDialog / composer.
                <CursorModelSelect
                  value={String(sumModel)}
                  onChange={(id) => setSumModel(id as ModelName)}
                  selectStyle={cursorSelectStyle}
                />
              ) : (
                <Row>
                  {modelsForProvider(sumProvider, catalogs).map((m) => {
                    const desc = sumProvider === 'codex' ? codexCatalog?.models?.find((cm) => cm.id === m)?.description : undefined;
                    return (
                      <Pill key={m} active={sumModel === m} onClick={() => setSumModel(m)} small title={desc}>
                        {sumProvider === 'claude' ? claudeModelLabel(String(m), claudeNativeCatalog) : String(m)}
                      </Pill>
                    );
                  })}
                </Row>
              )}
            </Field>

            {(() => {
              const honored = effortsForModel(sumProvider, sumModel, claudeNativeCatalog, codexCatalog);
              if (honored.length === 0) return null;
              return (
                <Field label="EFFORT" helpKey="handoff.summarizer.effort">
                  <Row>
                    {honored.map((e) => (
                      <Pill key={e} active={sumEffort === e} onClick={() => setSumEffort(e)} small>
                        {e.toUpperCase()}
                      </Pill>
                    ))}
                  </Row>
                </Field>
              );
            })()}
          </div>
        )}

        <div
          className="display-font"
          style={{
            fontSize: '10px',
            letterSpacing: '2px',
            color: 'var(--color-accent-secondary-dim)',
            marginBottom: '8px',
          }}
        >
          NEW PRIMARY (OPTIONAL)
        </div>
        <div
          className="display-font"
          style={{ fontSize: '9px', color: 'var(--color-fg-muted)', marginBottom: '10px', letterSpacing: '0.5px', lineHeight: 1.5 }}
        >
          Swap provider / model / effort for the post-handoff session. Leave unchanged to keep the current primary.
        </div>

        <Field label="PROVIDER" helpKey="handoff.provider">
          <Row>
            {availableProviders.map((p) => (
              <Pill
                key={p}
                active={provider === p}
                onClick={() => {
                  setProvider(p);
                  if (p === 'codex') {
                    setProviderAccountRef(currentProvider === 'codex' ? currentConfig.providerAccountRef : codexAccounts[0]?.id);
                  } else {
                    setProviderAccountRef(undefined);
                  }
                  if (!modelsForProvider(p, catalogs).includes(model)) {
                    setModel(defaultModelForProvider(p, catalogs));
                  }
                  setEffort(clampEffortForProvider(effort, p));
                }}
              >
                {p === 'llamacpp' ? 'LLAMA' : p === 'lmstudio' ? 'LM STUDIO' : p === 'antigravity' ? 'ANTIGRAV' : p === 'deepseek' ? 'XOLOTL' : p.toUpperCase()}
              </Pill>
            ))}
          </Row>
        </Field>

        {provider === 'codex' && codexAccounts.length > 0 && (
          <Field label="ACCOUNT" helpKey="handoff.account">
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

        <Field label="MODEL" helpKey="handoff.model">
          {provider === 'cursor' && cursorCatalog?.models?.length ? (
            // Cursor: family × effort × flags (effort baked into the id) — ~150 ids
            // is too many for a pill row. Same picker as SpawnDialog / composer.
            <CursorModelSelect
              value={String(model)}
              onChange={(id) => setModel(id as ModelName)}
              selectStyle={cursorSelectStyle}
            />
          ) : (
            <Row>
              {modelsForProvider(provider, catalogs).map((m) => {
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

        {(() => {
          const honored = effortsForModel(provider, model, claudeNativeCatalog, codexCatalog);
          if (honored.length === 0) {
            const reason = provider === 'gemini' ? 'Gemini CLI has no effort flag.'
              : provider === 'ollama' ? 'Local models have no effort flag.'
              : provider === 'antigravity' ? 'Effort is set inside the Antigravity desktop app.'
              : provider === 'cursor' ? 'Cursor bakes effort into the model id — set it in the MODEL picker above.'
              : 'Provider does not honor effort.';
            return (
              <Field label="EFFORT" helpKey="handoff.effort">
                <div className="display-font" style={{ padding: '6px 10px', border: '1px dashed var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '0.5px' }}>
                  {reason}
                </div>
              </Field>
            );
          }
          return (
            <Field label="EFFORT" helpKey="handoff.effort">
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

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '10px' }}>
          <span data-help="handoff.cancel" style={{ display: 'inline-flex' }}>
            <Btn onClick={onCancel}>CANCEL</Btn>
          </span>
          <span data-help="handoff.confirm" style={{ display: 'inline-flex' }}>
            <Btn primary onClick={confirm}>{primaryChanged ? 'ROTATE & SWAP' : 'ROTATE'}</Btn>
          </span>
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

function ModePill({
  active,
  label,
  hint,
  disabled,
  onClick,
}: {
  active: boolean;
  label: string;
  hint: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="display-font"
      style={{
        textAlign: 'left',
        padding: '10px 12px',
        background: active ? 'var(--color-accent-primary-a10)' : 'transparent',
        border: `1px solid ${active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
        borderRadius: '3px',
        color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <div style={{ fontSize: '11px', letterSpacing: '1.5px' }}>{label}</div>
      <div style={{ fontSize: '10px', letterSpacing: '0.5px', marginTop: '4px', opacity: 0.7, fontFamily: 'var(--font-body)' }}>
        {hint}
      </div>
    </button>
  );
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
