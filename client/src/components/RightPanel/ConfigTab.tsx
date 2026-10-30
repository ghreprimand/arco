import { useCallback, useState, useEffect } from 'react';
import { CLAUDE_MODEL_LABELS } from '@arco/shared';
import type { ProviderName, ModelName, EffortLevel, CliChangeEntry, OllamaPsAggregate, OllamaCompactionConfig } from '@arco/shared';
import { useAppStore, type JobState } from '../../stores/appStore';
import { useCodexCatalogFor } from '../../hooks/useCodexCatalog';
import { effortsForModel } from '../../utils/format';
import { CodebaseMemorySection } from './CodebaseMemorySection';
import { RunAsPicker, type RunAsSelection } from '../RunAsPicker';
import { CursorModelSelect } from '../CursorModelSelect';
import { McpRegistrySection, type McpSenders } from './McpRegistrySection';
import { useProjectTrust, type TrustStatus } from '../../hooks/useProjectTrust';
import { modelsFor } from './format';

export function ConfigTab({
  job,
  onUpdatePrimary,
  onAttachCodebaseMemory,
  onDetachCodebaseMemory,
  mcp,
}: {
  job: JobState;
  onUpdatePrimary?: (update: { model?: ModelName; effort?: EffortLevel; autoHandoff?: { enabled: boolean; warnAt: number; autoAt: number; mode?: 'original-worker' | 'fresh-summarizer'; summarizer?: { provider: ProviderName; model?: ModelName; effort?: EffortLevel } }; autoFold?: { enabled: boolean; foldAt: number; tailBudget?: number }; autoCompaction?: import('@arco/shared').AutoCompactionPolicy | null; codexTransport?: 'exec' | 'appserver'; codexContextPolicy?: 'max' | 'standard'; claudeTransport?: 'cli' | 'native'; ultracode?: boolean; webSearchMaxUses?: number; claudeNativeCompact?: boolean; claudeNativeForceInterleavedThinkingBeta?: boolean; claudeNativeThinkingDisplay?: 'omitted' | 'summarized' | 'updates'; nativeCompactAutoContinue?: boolean; efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive'; efficiencyFactForce?: 'on' | 'off'; efficiencyConfigProtection?: 'on' | 'off'; efficiencySandbox?: 'off' | 'on'; reviewSafeMode?: 'off' | 'on'; outputStyle?: 'normal' | 'lite' | 'terse'; goal?: string; ollamaParams?: Record<string, unknown> }) => void;
  onAttachCodebaseMemory?: (workflowId: string, indexPath?: string) => void;
  onDetachCodebaseMemory?: (workflowId: string) => void;
  mcp?: McpSenders;
}) {
  const c = job.config;
  const provider: ProviderName = c.primaryProvider ?? 'claude';
  const canEdit = Boolean(onUpdatePrimary);

  const settings = useAppStore((s) => s.settings);

  const codexAccountRow = (): [string, string] | null => {
    if (provider !== 'codex') return null;
    const profiles = settings?.providerAccounts?.codex ?? [];
    if (profiles.length === 0) return null;
    const ref = c.providerAccountRef;
    const matched = ref ? profiles.find((p) => p.id === ref) : undefined;
    const effective = matched ?? profiles[0];
    const label = effective.label || effective.id;
    const suffix = matched ? '' : ' (default)';
    return ['ACCOUNT', `${label}${suffix}`];
  };

  const staticRows: Array<[string, string]> = [
    ['CWD', c.workingDirectory || '—'],
    ['PROVIDER', provider === 'deepseek' ? 'XOLOTL' : provider.toUpperCase()],
    ...(codexAccountRow() ? [codexAccountRow()!] : []),
  ];
  const claudeSessionId = provider === 'claude' ? (job.claudeSessionId ?? null) : null;
  const suffixRows: Array<[string, string]> = [
    ['PERMISSIONS', c.skipPermissions ? 'AUTO (worker full access)' : 'SAFE'],
    ...(c.fastMode ? [['FAST MODE', 'ON'] as [string, string]] : []),
    ...(c.advanced?.additionalDirectories?.length
      ? [['ADD DIRS', c.advanced.additionalDirectories.join(', ')] as [string, string]]
      : []),
    ...(c.advanced?.fallbackModel
      ? [['FALLBACK', String(c.advanced.fallbackModel)] as [string, string]]
      : []),
    ...(c.resumeSessionId
      ? [['RESUMED FROM', c.resumeSessionId.slice(0, 8) + '…'] as [string, string]]
      : []),
  ];
  const claudeNativeCatalog = useAppStore((s) => s.claudeNativeCatalog);
  // Account-scoped: the CONFIG MODEL list reflects the workflow's selected
  // Codex profile, so flipping the ACCOUNT PROFILE toggle re-filters models to
  // that account's entitlements (e.g. WORK sees GPT-5.6 Sol, HOME doesn't).
  const codexCatalog = useCodexCatalogFor(c.providerAccountRef);
  const cursorCatalog = useAppStore((s) => s.cursorCatalog);
  const authStatus = useAppStore((s) => s.authStatus);
  // Match the live chip's model picker — when the catalog is populated, the
  // CONFIG dropdown shows the same set the chip popover does. Cold-start
  // falls back to the static compile-time list.
  const modelOptions: ModelName[] = (() => {
    if (provider === 'claude' && claudeNativeCatalog?.models?.length) {
      return claudeNativeCatalog.models.map((m) => m.id as ModelName);
    }
    if (provider === 'codex' && codexCatalog?.models?.length) {
      return codexCatalog.models.filter((m) => !m.hidden).map((m) => m.id as ModelName);
    }

    // Cursor's ~153-model roster is a live catalog (GET /api/cursor/catalog),
    // so the live-swap dropdown reads it here — mirrors RunAsPicker. Effort is
    // baked into the id, so there's no separate effort surface (below).
    if (provider === 'cursor' && cursorCatalog?.models?.length) {
      return cursorCatalog.models.map((m) => m.id as ModelName);
    }

    // Ollama models are discovered at runtime from the local daemon (no static
    // catalog). Empty list (daemon down / no models) falls through to static text.
    if (provider === 'ollama') {
      return (authStatus?.ollama?.installedModels ?? []) as ModelName[];
    }
    // LM Studio (M13) + llama.cpp: discovered at runtime from the local
    // endpoint/catalog (no static catalog). LM Studio's ids come from GET
    // /v1/models; llama.cpp's aliases from ~/.arco/llamacpp.json. Empty
    // (server down / no model loaded) falls through to the static text input.
    if ((provider === 'strata' || provider === 'deepseek')) {
      return (authStatus?.[provider]?.installedModels ?? []) as ModelName[];
    }
    if (provider === 'lmstudio') {
      return (authStatus?.lmstudio?.installedModels ?? []) as ModelName[];
    }
    if (provider === 'llamacpp') {
      return (authStatus?.llamacpp?.installedModels ?? []) as ModelName[];
    }
    return modelsFor(provider);
  })();
  const modelLabel = (id: ModelName): string => {
    const idStr = String(id);
    if ((provider === 'strata' || provider === 'deepseek')) return authStatus?.[provider]?.installedModelLabels?.[idStr] ?? idStr;
    if (provider === 'claude') {
      const live = claudeNativeCatalog?.models?.find((m) => m.id === idStr);
      if (live?.displayName) return live.displayName.replace(/^Claude\s+/, '');
      return CLAUDE_MODEL_LABELS[idStr] ?? idStr;
    }
    if (provider === 'codex') {
      const live = codexCatalog?.models?.find((m) => m.id === idStr);
      if (live?.displayName) return live.displayName;
    }

    if (provider === 'cursor') {
      const live = cursorCatalog?.models?.find((m) => m.id === idStr);
      if (live?.displayName) return live.displayName;
    }
    return idStr;
  };
  const honoredEfforts = effortsForModel(provider, c.primaryModel, claudeNativeCatalog, codexCatalog);
  const effortEditable = canEdit && honoredEfforts.length > 0;

  return (
    <div style={{ padding: '14px 16px', overflowY: 'auto' }}>
      <CliStatusCard />
      <div
        className="display-font"
        style={{
          fontSize: '10px',
          letterSpacing: '2px',
          color: 'var(--color-accent-secondary-dim)',
          marginBottom: '10px',
        }}
      >
        PRIMARY AGENT
      </div>
      <table style={{ width: '100%', fontSize: '11px', fontFamily: 'var(--font-body)', borderCollapse: 'collapse' }}>
        <tbody>
          {staticRows.map(([k, v]) => (
            <StaticRow key={k} k={k} v={v} />
          ))}

          {claudeSessionId && (
            <CopyableRow
              k="SESSION"
              v={claudeSessionId}
              copyValue={`claude --resume ${claudeSessionId}`}
            />
          )}

          {/* MODEL — editable when same-provider swap is possible */}
          <tr style={{ borderBottom: '1px solid var(--color-accent-primary-a05)' }}>
            <td
              className="display-font"
              style={{
                padding: '5px 8px 5px 0',
                color: 'var(--color-fg-muted)',
                fontSize: '10px',
                letterSpacing: '1.2px',
                whiteSpace: 'nowrap',
                verticalAlign: 'top',
              }}
            >
              MODEL
            </td>
            <td style={{ padding: '5px 0' }} data-help="rightpanel.config.model">
              {canEdit && provider === 'cursor' && cursorCatalog?.models?.length ? (
                // Cursor: family × effort × flags picker (effort is baked into
                // the id, so the EFFORT row below stays a note). Emits an exact
                // catalog id — never a synthesized one.
                <CursorModelSelect
                  value={String(c.primaryModel)}
                  onChange={(id) => onUpdatePrimary?.({ model: id as ModelName })}
                  selectStyle={selectStyle}
                  layout="stack"
                />
              ) : canEdit && modelOptions.length > 0 ? (
                // 2026-07-28 incident — when the tab's model isn't in the
                // option list (a family alias like `opus`, or a pinned id the
                // catalog has since dropped), a bare controlled select renders
                // the FIRST option instead. That made an alias tab read as
                // "Opus 5" while it was really on `opus`, AND made the bug
                // unfixable from here: picking the already-displayed option
                // fires no onChange. Surface the real value as its own option
                // so what's shown is what's set, and every pick is a change.
                <select
                  value={String(c.primaryModel)}
                  onChange={(e) => onUpdatePrimary?.({ model: e.target.value as ModelName })}
                  className="display-font"
                  style={selectStyle}
                >
                  {!modelOptions.some((m) => String(m) === String(c.primaryModel)) && (
                    <option value={String(c.primaryModel)}>
                      {modelLabel(c.primaryModel as ModelName)} (unlisted)
                    </option>
                  )}
                  {modelOptions.map((m) => (
                    <option key={m} value={String(m)}>{modelLabel(m)}</option>
                  ))}
                </select>
              ) : (
                <span style={{ color: 'var(--color-accent-primary)' }}>{String(c.primaryModel)}</span>
              )}
            </td>
          </tr>


          <tr style={{ borderBottom: '1px solid var(--color-accent-primary-a05)' }}>
            <td
              className="display-font"
              style={{
                padding: '5px 8px 5px 0',
                color: 'var(--color-fg-muted)',
                fontSize: '10px',
                letterSpacing: '1.2px',
                whiteSpace: 'nowrap',
                verticalAlign: 'top',
              }}
            >
              EFFORT
            </td>
            <td style={{ padding: '5px 0' }} data-help="rightpanel.config.effort">
              {effortEditable ? (
                <select
                  value={String(c.primaryEffort)}
                  onChange={(e) => onUpdatePrimary?.({ effort: e.target.value as EffortLevel })}
                  className="display-font"
                  style={selectStyle}
                >
                  {honoredEfforts.map((e) => (
                    <option key={e} value={e}>{e.toUpperCase()}</option>
                  ))}
                </select>
              ) : (
                <span style={{ color: 'var(--color-fg-muted)', fontStyle: 'italic' }}>
                  {provider === 'ollama' ? '(local models have no effort flag)'
                    : provider === 'cursor' ? '(set via the model picker above)'
                    : '(not honored)'}
                </span>
              )}
            </td>
          </tr>

          {suffixRows.map(([k, v]) => (
            <StaticRow key={k} k={k} v={v} />
          ))}
        </tbody>
      </table>
      <div
        className="display-font"
        style={{
          marginTop: '14px',
          fontSize: '9px',
          color: 'var(--color-fg-muted)',
          letterSpacing: '0.5px',
          lineHeight: 1.5,
        }}
      >
        Model and effort take effect on the next turn — no session rotation needed. To change provider, use Handoff (same tab) or Spawn (new tab).
      </div>

      {canEdit && <AutoCompactionSection job={job} onUpdatePrimary={onUpdatePrimary!} />}

      {/* Phase 3 — auto-handoff config. WP1: generalized beyond Claude to the
          providers that now keep wf.lastContextPercent fresh per turn
      (Codex via app-server usage, Ollama via prompt_eval_count). */}
      {(provider === 'claude' || provider === 'codex' || provider === 'ollama') && canEdit && (
        <AutoHandoffSection job={job} onUpdatePrimary={onUpdatePrimary!} />
      )}

      {/* WP3 — Ollama M8 auto-compaction (GLOBAL settings.ollama.compaction,
          used when no worker or cluster threshold policy is set). Ollama tabs
          only; writes via POST /api/settings like the Codex transport section. */}
      {provider === 'ollama' && canEdit && (
        <OllamaCompactionSection />
      )}

      {/* docs/PROVIDERS.md - per-tab Ollama param presets. Ollama
          tabs only; merged server-side through the typed allowlist. */}
      {provider === 'ollama' && canEdit && (
        <OllamaParamsSection job={job} onUpdatePrimary={onUpdatePrimary!} />
      )}

      {/* Hardware-synergy — VRAM budget readout + auto context-sizer. Ollama
          tabs only; probes the local GPU (nvidia-smi) + daemon, sizes num_ctx
          to fit, warns when primary + a local utility model won't coexist. */}
      {provider === 'ollama' && canEdit && (
        <OllamaVramSection job={job} onUpdatePrimary={onUpdatePrimary!} />
      )}

      {/* docs/PROVIDERS.md (Excellence LE-6) - model-lifecycle
          console. Ollama tabs only; aggregates /api/ps across backends with
          idle/expiry countdown + a keep_alive:0 unload button per model. */}
      {provider === 'ollama' && canEdit && (
        <OllamaLifecycleSection job={job} />
      )}

      {/* Phase 6e — Codex transport toggle (per-tab). Only on Codex tabs. */}
      {provider === 'codex' && canEdit && (
        <>
          <CodexTransportSection job={job} onUpdatePrimary={onUpdatePrimary!} />
          <CodexContextWindowSection job={job} onUpdatePrimary={onUpdatePrimary!} />
        </>
      )}

      {/* Phase 7a — Claude transport toggle (per-tab). Only on Claude tabs. */}
      {provider === 'claude' && canEdit && (
        <ClaudeTransportSection job={job} onUpdatePrimary={onUpdatePrimary!} />
      )}



      {/* Phase 7c-followup — Anthropic server-side compaction toggle.
          Native-only AND model-capability-gated (catalog `compact_20260112`). */}
      {provider === 'claude' && canEdit && (
        <ClaudeNativeCompactSection job={job} onUpdatePrimary={onUpdatePrimary!} />
      )}

      {/* NATIVE_COMPACTION_PLAN Phase 3 — opt-in auto-continue after a Native
          compaction. Native-only; default off (manual resume). */}
      {provider === 'claude' && canEdit && (
        <NativeCompactAutoContinueSection job={job} onUpdatePrimary={onUpdatePrimary!} />
      )}

      {/* Adaptive-thinking display picker. Native-only. 'omitted' (default,
          Claude Code parity) streams no thinking back — a long Fable/Opus
          think reads as total silence in Activity; 'summarized' streams
          summarized thinking rows and keeps the stuck clock fresh. */}
      {provider === 'claude' && canEdit && (
        <ClaudeNativeThinkingDisplaySection job={job} onUpdatePrimary={onUpdatePrimary!} />
      )}

      {/* Debug-only Native beta override for A/B testing adaptive-model tool reasoning. */}
      {provider === 'claude' && canEdit && (
        <ClaudeNativeInterleavedBetaSection job={job} onUpdatePrimary={onUpdatePrimary!} />
      )}

      {/* docs/PROVIDERS.md - Native tool-result filter mode toggle.
          Native-only; the filter pipeline lives inside the Native worker's
          dispatchTool. */}
      {provider === 'claude' && canEdit && (
        <ClaudeNativeToolFilterSection job={job} onUpdatePrimary={onUpdatePrimary!} />
      )}

      {/* Per-tab Claude Native web_search / web_fetch per-turn budget (the
          Anthropic server tools' max_uses). Native-only — CLI Claude uses the
          `claude` binary's own web budgeting. */}
      {provider === 'claude' && canEdit && (
        <ClaudeNativeWebBudgetSection job={job} onUpdatePrimary={onUpdatePrimary!} />
      )}

      {/* docs/PROVIDERS.md - Native fact-force first-edit gate.
          Native-only; CLI parity deferred (master section 3.3 F4). Defaults off;
          the operator explicitly opts in per tab. */}
      {provider === 'claude' && canEdit && (
        <ClaudeNativeFactForceSection job={job} onUpdatePrimary={onUpdatePrimary!} />
      )}

      {/* Config-protection write-gate. Native-only; default ON (safety gate).
          Flip to 'off' to relax the gate for this one workflow when a
          legitimate config edit (e.g. a new path mapping) is needed. */}
      {provider === 'claude' && canEdit && (
        <ClaudeNativeConfigProtectionSection job={job} onUpdatePrimary={onUpdatePrimary!} />
      )}


      {provider === 'claude' && canEdit && (
        <ClaudeNativeSandboxSection job={job} onUpdatePrimary={onUpdatePrimary!} />
      )}

      {/* docs/PROVIDERS.md - operator-armed durable review gate (review safe-mode).
          Native-only; default 'off' - operator opts in per tab. */}
      {provider === 'claude' && canEdit && (
        <ClaudeNativeReviewSafeModeSection job={job} onUpdatePrimary={onUpdatePrimary!} />
      )}

      {/* DD7 — project trust for this tab's cwd. Provider-agnostic: the gate
          suppresses CLAUDE.md / project skills / project settings on every
          transport. Standing surface for the one-shot composer prompt. */}
      {c.workingDirectory && <ProjectTrustSection cwd={c.workingDirectory} />}

      {/* docs/GOTCHAS.md - operator-set persistent north-star. Not
          provider-gated: honored on every transport that folds the prompt
          (Native, CLI Claude, both Codex, Ollama/llama.cpp/LM Studio). */}
      {canEdit && (
        <NorthStarSection job={job} onUpdatePrimary={onUpdatePrimary!} />
      )}

      {/* docs/PROVIDERS.md - operator-armed terseness picker. Honored by
          Claude Native and Codex app-server providers.
          Forced normal on Review / Handoff / DOCS / GIT regardless. */}
      {(provider === 'claude' || provider === 'codex') && canEdit && (
        <OutputStyleSection job={job} onUpdatePrimary={onUpdatePrimary!} />
      )}





      {onAttachCodebaseMemory && onDetachCodebaseMemory && (
        <CodebaseMemorySection
          job={job}
          onAttach={onAttachCodebaseMemory}
          onDetach={onDetachCodebaseMemory}
        />
      )}

      {/* docs/ARCHITECTURE.md - MCP registry per-tab enablement. Wired
          transports: Claude CLI (--disallowedTools denylist), Claude Native
          (in-process denylist by omission, E1-Native), and Codex (server-level
          enable only - no per-tool deny flag). Provider-gated, so both Claude
          transports show the same section. */}
      {mcp && (provider === 'claude' || provider === 'codex') && (
        <McpRegistrySection job={job} mcp={mcp} />
      )}
    </div>
  );
}

function CliStatusCard() {
  const changes = useAppStore((s) => s.cliChanges);
  const ack = useAppStore((s) => s.acknowledgeCliChange);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, { kind: 'loading' } | { kind: 'ok'; text: string } | { kind: 'error'; message: string }>>({});

  if (changes.length === 0) return null;

  const loadDiff = (name: string) => {
    if (diffs[name]) return;
    setDiffs((d) => ({ ...d, [name]: { kind: 'loading' } }));
    fetch(`/api/cli-snapshot?name=${encodeURIComponent(name)}`)
      .then(async (r) => {
        if (r.ok) return r.json() as Promise<{ contents: string }>;
        const body = await r.json().catch(() => ({ error: r.statusText })) as { error?: string };
        throw new Error(body.error || `HTTP ${r.status}`);
      })
      .then((d) => setDiffs((s) => ({ ...s, [name]: { kind: 'ok', text: d.contents } })))
      .catch((err: unknown) => setDiffs((s) => ({ ...s, [name]: { kind: 'error', message: err instanceof Error ? err.message : String(err) } })));
  };

  return (
    <div
      style={{
        marginBottom: '16px',
        padding: '10px 12px',
        border: '1px solid #ff4d4d55',
        borderLeft: '3px solid #ff4d4d',
        borderRadius: '3px',
        background: 'var(--color-bg-sunken)',
      }}
    >
      <div
        className="display-font"
        style={{
          fontSize: '10px',
          letterSpacing: '2px',
          color: '#ff6b6b',
          marginBottom: '8px',
        }}
      >
        CLI STATUS
      </div>
      {changes.map((c: CliChangeEntry) => {
        const isOpen = expanded === c.provider;
        const diffState = diffs[c.diffFileName];
        return (
          <div key={c.provider} style={{ marginBottom: '8px', fontSize: '11px', fontFamily: 'var(--font-body)' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--color-accent-primary)', fontFamily: 'var(--font-display)', letterSpacing: '1px' }}>
                {c.provider.toUpperCase()}
              </span>
              <span style={{ color: 'var(--color-fg-muted)' }}>
                {c.fromVersion} → {c.toVersion}
              </span>
              <span style={{ color: 'var(--color-fg-muted)' }}>
                (+{c.newFlags.length} / −{c.removedFlags.length} flags)
              </span>
            </div>
            {c.newFlags.length > 0 && (
              <div style={{ marginTop: '4px', color: 'var(--color-fg)', fontFamily: 'var(--font-mono, monospace)', fontSize: '10px' }}>
                new: {c.newFlags.slice(0, 8).join(', ')}{c.newFlags.length > 8 ? ` … +${c.newFlags.length - 8}` : ''}
              </div>
            )}
            <div style={{ marginTop: '6px', display: 'flex', gap: '8px' }}>
              <button
                type="button"
                onClick={() => {
                  if (!isOpen) loadDiff(c.diffFileName);
                  setExpanded(isOpen ? null : c.provider);
                }}
                className="display-font"
                style={miniBtnStyle}
              >
                {isOpen ? 'HIDE DIFF' : 'VIEW DIFF'}
              </button>
              <button
                type="button"
                onClick={() => ack(c.provider, c.toVersion)}
                className="display-font"
                style={miniBtnStyle}
              >
                ACK
              </button>
            </div>
            {isOpen && (
              <pre
                style={{
                  marginTop: '6px',
                  padding: '8px',
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-border-hairline)',
                  borderRadius: '2px',
                  fontSize: '10px',
                  maxHeight: '260px',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  color: 'var(--color-fg)',
                }}
              >
                {diffState?.kind === 'loading' && 'loading…'}
                {diffState?.kind === 'ok' && diffState.text}
                {diffState?.kind === 'error' && `error: ${diffState.message}`}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

const miniBtnStyle: React.CSSProperties = {
  padding: '3px 8px',
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  color: 'var(--color-fg-muted)',
  fontSize: '9px',
  letterSpacing: '1.5px',
  cursor: 'pointer',
  fontFamily: 'var(--font-display)',
};

function AutoCompactionSection({ job, onUpdatePrimary }: {
  job: JobState;
  onUpdatePrimary: (update: { autoCompaction?: import('@arco/shared').AutoCompactionPolicy | null }) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const clusters = useAppStore((s) => s.clusters);
  const cluster = Object.values(clusters).find((c) => c.members.some((m) => m.workflowId === job.id));
  const own = job.config.autoCompaction;
  const effective = own ?? cluster?.autoCompaction;
  const provider = job.config.primaryProvider ?? 'claude';
  const supported = (provider === 'claude' && (job.config.claudeTransport ?? settings?.claude?.transport) === 'native')
    || (provider === 'codex' && (job.config.codexTransport ?? settings?.codex?.transport) === 'appserver')
    || (provider === 'ollama' && job.config.kind !== 'chat');
  return <section data-help="rightpanel.config.auto-compaction" style={{ marginTop: 18, fontSize: 11 }}>
    <div className="display-font">AUTO-COMPACTION</div>
    <p>Compaction summarizes older context in place. Fold creates a deterministic digest; handoff starts a fresh session. Codex needs an existing app-server thread. Ollama compacts before the next turn using its configured context window; completed executions are summarized durably. Legacy or partial history without a safe boundary defers compaction. While enabled, automatic handoff waits for this policy; manual handoff remains available. Unknown usage does not trigger this policy.</p>
    {!supported && <p>Automatic compaction is unavailable for this provider or transport. Handoff remains available.</p>}
    <label>Policy <select aria-label="Worker auto-compaction" value={own ? own.enabled ? 'on' : 'off' : 'inherit'} onChange={(e) => onUpdatePrimary({ autoCompaction: e.target.value === 'inherit' ? null : { enabled: e.target.value === 'on', thresholdPercent: effective?.thresholdPercent ?? 80 } })}>
      <option value="inherit">{cluster ? 'Inherit cluster default' : 'Legacy provider behavior'}</option>
      <option value="off">Off</option><option value="on" disabled={!supported}>On</option>
    </select></label>
    {own && <label> Threshold {own.thresholdPercent}% <input type="range" aria-label="Worker auto-compaction threshold percent" min={50} max={95} value={own.thresholdPercent} onChange={(e) => onUpdatePrimary({ autoCompaction: { ...own, thresholdPercent: Number(e.target.value) } })} /></label>}
    {!own && cluster && <p>{effective ? `Cluster default: ${effective.enabled ? `on at ${effective.thresholdPercent}%` : 'off'}.` : 'Cluster uses legacy provider behavior.'}</p>}
  </section>;
}

function AutoHandoffSection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { autoHandoff?: { enabled: boolean; warnAt: number; autoAt: number; mode?: 'original-worker' | 'fresh-summarizer'; summarizer?: { provider: ProviderName; model?: ModelName; effort?: EffortLevel } }; autoFold?: { enabled: boolean; foldAt: number; tailBudget?: number } }) => void;
}) {
  // Fall back to the operator's global default (AUTO-HANDOFF DEFAULTS in
  // Settings) when the tab has no per-tab value yet, then the hardcoded
  // 75/90/on. New tabs arrive with config.autoHandoff already seeded by the
  // server, so this only covers older tabs created before a default was set.
  const settings = useAppStore((s) => s.settings);
  const gd = settings?.autoHandoffDefaults;
  const ah = job.config.autoHandoff ?? {
    enabled: gd?.enabled ?? true,
    warnAt: gd?.warnAt ?? 75,
    autoAt: gd?.autoAt ?? 90,
    mode: gd?.mode,
  };
  const cu = job.contextUsage;

  // WP6 — ORIGINAL is available for ALL providers. claude/codex truly resume
  // their session; local models (ollama/etc.) translate "original" server-side
  // to "the same model re-reads its transcript" (auto-falling back to a fresh
  // summarizer when the transcript overflows). No provider gating on the mode.
  const provider: ProviderName = job.config.primaryProvider ?? 'claude';
  const providerResumable = provider === 'claude' || provider === 'codex';
  const resolvedMode: 'original-worker' | 'fresh-summarizer' = ah.mode ?? gd?.mode ?? 'original-worker';

  const setAh = (patch: Partial<typeof ah>) => {
    const next = { ...ah, ...patch };
    onUpdatePrimary({ autoHandoff: next });
  };

  // §2.1 — auto-fold (Claude Native only). foldAt sits BELOW warnAt so the cheap
  // in-place Fold is tried before a handoff is recommended. Off by default.
  const resolvedClaudeTransportCfg: 'cli' | 'native' = job.config.claudeTransport
    ?? (settings?.claude?.transport === 'native' ? 'native' : 'cli');
  const foldEligible = provider === 'claude' && resolvedClaudeTransportCfg === 'native';
  const af = job.config.autoFold ?? { enabled: false, foldAt: Math.max(40, ah.warnAt - 10) };
  const setAf = (patch: Partial<typeof af>) => onUpdatePrimary({ autoFold: { ...af, ...patch } });

  // WP5 — the fresh-summarizer model picker. `current` = this tab's primary
  // (the reset target). `selection` = per-tab summarizer override → global
  // pinned summarizer → the primary. model/effort optional in storage; fill
  // from primary for the picker's concrete RunAsSelection.
  const sum = ah.summarizer ?? settings?.handoffSummarizer;
  const summarizerSelection: RunAsSelection = {
    provider: sum?.provider ?? provider,
    model: (sum?.model as ModelName) ?? job.config.primaryModel,
    effort: sum?.effort ?? job.config.primaryEffort,
  };
  const currentSelection: RunAsSelection = {
    provider,
    model: job.config.primaryModel,
    effort: job.config.primaryEffort,
  };

  return (
    <div style={{ marginTop: '18px' }} data-help="rightpanel.config.auto-handoff">
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        AUTO-HANDOFF
      </div>
      {cu && (
        <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', marginBottom: '8px', fontFamily: 'var(--font-body)' }}>
          Context: ~{cu.estimatedTokens.toLocaleString()} / {cu.windowSize.toLocaleString()} tokens ({cu.percentOfWindow}%)
        </div>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', fontFamily: 'var(--font-body)', marginBottom: '6px', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={ah.enabled}
          onChange={(e) => setAh({ enabled: e.target.checked })}
          style={{ accentColor: 'var(--color-accent-primary)' }}
        />
        <span style={{ color: 'var(--color-fg-muted)' }}>Enable auto-handoff</span>
      </label>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5, marginBottom: '8px' }}>
        Arco auto-rotates to a fresh session at the token threshold. Disable to lean on Anthropic's compact (Native only) or to handle context manually.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px', fontFamily: 'var(--font-body)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-fg-muted)' }}>
          <span style={{ minWidth: '42px', fontFamily: 'var(--font-display)', fontSize: '10px', letterSpacing: '1px' }}>WARN</span>
          <input
            type="range"
            min={60}
            max={85}
            value={ah.warnAt}
            onChange={(e) => setAh({ warnAt: Number(e.target.value) })}
            style={{ flex: 1, accentColor: 'var(--color-warning)' }}
          />
          <span style={{ minWidth: '28px', textAlign: 'right', color: 'var(--color-warning)' }}>{ah.warnAt}%</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-fg-muted)' }}>
          <span style={{ minWidth: '42px', fontFamily: 'var(--font-display)', fontSize: '10px', letterSpacing: '1px' }}>AUTO</span>
          <input
            type="range"
            min={75}
            max={95}
            value={ah.autoAt}
            onChange={(e) => setAh({ autoAt: Number(e.target.value) })}
            style={{ flex: 1, accentColor: 'var(--color-danger, #f04a4a)' }}
          />
          <span style={{ minWidth: '28px', textAlign: 'right', color: 'var(--color-danger, #f04a4a)' }}>{ah.autoAt}%</span>
        </label>
      </div>

      {/* WP5 — handoff MODE. Original-worker resumes the same session (only
          possible on claude/codex); fresh-summarizer spawns a strong agent to
          write the handoff. */}
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)', marginTop: '14px', marginBottom: '6px' }}>
        MODE
      </div>
      <div style={{ display: 'flex', gap: '6px' }}>
        <ModePill
          active={resolvedMode === 'original-worker'}
          title={providerResumable ? 'Resume the same session' : 'Same local model re-reads its transcript (auto-falls back to fresh if too big)'}
          onClick={() => setAh({ mode: 'original-worker' })}
        >
          ORIGINAL WORKER
        </ModePill>
        <ModePill
          active={resolvedMode === 'fresh-summarizer'}
          onClick={() => setAh({ mode: 'fresh-summarizer' })}
        >
          FRESH SUMMARIZER
        </ModePill>
      </div>

      {resolvedMode === 'fresh-summarizer' && (
        <div style={{ marginTop: '12px' }}>
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)', marginBottom: '6px' }}>
            Auto-handoff summarizer (which model writes it)
          </div>
          <RunAsPicker
            current={currentSelection}
            selection={summarizerSelection}
            onChange={(next) => setAh({ summarizer: { provider: next.provider, model: next.model, effort: next.effort } })}
          />
        </div>
      )}

      {/* §2.1 — AUTO-FOLD: a deterministic in-place trim that fires BEFORE the
          handoff thresholds. Native-only; off by default (operator-armed). */}
      {foldEligible && (
        <div style={{ marginTop: '18px' }} data-help="rightpanel.config.auto-fold">
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
            AUTO-FOLD (NATIVE)
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', fontFamily: 'var(--font-body)', marginBottom: '6px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={af.enabled}
              onChange={(e) => setAf({ enabled: e.target.checked })}
              style={{ accentColor: 'var(--color-accent-primary)' }}
            />
            <span style={{ color: 'var(--color-fg-muted)' }}>Enable auto-fold</span>
          </label>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5, marginBottom: '8px' }}>
            Before a handoff is recommended, deterministically fold older history into a digest and keep a verbatim recent tail — same session, instant, no model round. The raw transcript stays in events.jsonl. Fires when the context budget crosses FOLD AT (kept below WARN).
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-fg-muted)', fontSize: '11px', fontFamily: 'var(--font-body)' }}>
            <span style={{ minWidth: '52px', fontFamily: 'var(--font-display)', fontSize: '10px', letterSpacing: '1px' }}>FOLD AT</span>
            <input
              type="range"
              min={30}
              max={Math.max(35, ah.warnAt - 5)}
              value={Math.min(af.foldAt, Math.max(35, ah.warnAt - 5))}
              onChange={(e) => setAf({ foldAt: Number(e.target.value) })}
              style={{ flex: 1, accentColor: 'var(--color-accent-primary)' }}
            />
            <span style={{ minWidth: '28px', textAlign: 'right', color: 'var(--color-accent-primary)' }}>{af.foldAt}%</span>
          </label>
        </div>
      )}
    </div>
  );
}

function ModePill({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="display-font"
      style={{
        padding: '4px 9px',
        background: active ? 'var(--color-accent-primary-a10)' : 'transparent',
        border: `1px solid ${active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
        borderRadius: '3px',
        color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: '9px',
        letterSpacing: '1px',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

// Phase 6e — per-tab Codex transport toggle. Reads from
// `wf.config.codexTransport` (server-mirrored to meta.json + WS-broadcast on
// rehydrate); falls back to the cascade default ('exec'). Only renders on
// Codex tabs. Shows the §14-q5 first-time-enable warning when the operator
// flips a tab to APPSERVER and `settings.codex.appserverWarningSeen` is not
// truthy. The flag is cleared (back to undefined) whenever a tab is moved
// to EXEC so a re-enable on any tab re-shows the warning.
function CodexTransportSection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { codexTransport?: 'exec' | 'appserver' }) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const cascadeDefault: 'exec' | 'appserver' = settings?.codex?.transport === 'appserver' ? 'appserver' : 'exec';
  const current: 'exec' | 'appserver' = job.config.codexTransport ?? cascadeDefault;
  const warningSeen = settings?.codex?.appserverWarningSeen === true;

  const [pendingEnable, setPendingEnable] = useState(false);

  const patchSettingsCodex = async (codex: { transport?: 'exec' | 'appserver'; appserverWarningSeen?: boolean }) => {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codex }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as typeof settings;
      if (data) setSettings(data);
    } catch { /* best-effort; the per-tab field is the source of truth either way */ }
  };

  const apply = (next: 'exec' | 'appserver') => {
    onUpdatePrimary({ codexTransport: next });
    if (next === 'exec' && warningSeen) {
      // Re-arm the warning so the next enable explains the trade-off again.
      // Nullable update: setting to undefined isn't a sanitizer-honored value;
      // we model "unset" by writing `appserverWarningSeen: false`.
      patchSettingsCodex({ appserverWarningSeen: false });
    }
  };

  const onPick = (next: 'exec' | 'appserver') => {
    if (next === current) return;
    if (next === 'appserver' && !warningSeen) {
      setPendingEnable(true);
      return;
    }
    apply(next);
  };

  const confirmEnable = () => {
    setPendingEnable(false);
    apply('appserver');
    patchSettingsCodex({ appserverWarningSeen: true });
  };

  return (
    <div style={{ marginTop: '18px' }} data-help="rightpanel.config.transport">
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        TRANSPORT
      </div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
        {(['exec', 'appserver'] as const).map((t) => {
          const active = current === t;
          return (
            <button
              key={t}
              type="button"
              className="display-font"
              onClick={() => onPick(t)}
              style={{
                flex: 1,
                padding: '6px 10px',
                fontSize: '10px',
                letterSpacing: '1.5px',
                border: '1px solid ' + (active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
                background: active ? 'var(--color-accent-primary-a10, transparent)' : 'transparent',
                color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                borderRadius: '3px',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              {t.toUpperCase()}{t === 'appserver' ? ' *' : ''}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
        {current === 'appserver'
          ? 'APPSERVER: long-lived `codex app-server` worker — mid-turn steer, structured interrupt and interactive questions. Experimental upstream protocol.'
          : 'EXEC: per-turn `codex exec --json` worker — stable; queued steer drains post-turn.'}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', marginTop: '6px', fontStyle: 'italic' }}>
        Takes effect on the next operator turn. An active app-server child stays up until the tab closes, regardless of toggle.
      </div>

      {pendingEnable && (
        <CodexAppserverWarningModal
          onCancel={() => setPendingEnable(false)}
          onConfirm={confirmEnable}
        />
      )}
    </div>
  );
}

// First-time-enable warning modal for the Codex app-server transport.
// Transport behavior is documented in docs/PROVIDERS.md.
function CodexAppserverWarningModal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9400,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        style={{
          background: 'var(--color-bg)',
          border: '1px solid var(--color-accent-primary)',
          borderRadius: '4px',
          maxWidth: '520px',
          padding: '20px 24px',
          fontFamily: 'var(--font-body)',
          fontSize: '13px',
          color: 'var(--color-fg)',
          lineHeight: 1.55,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}
      >
        <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary)', marginBottom: '14px' }}>
          CODEX TRANSPORT: APPSERVER <span style={{ fontStyle: 'italic', color: 'var(--color-fg-muted)' }}>(experimental)</span>
        </div>
        <p style={{ margin: '0 0 12px 0' }}>
          Enables non-destructive mid-turn steer (operator messages typed during a Codex turn land between tool calls instead of waiting for the turn to settle).
        </p>
        <p style={{ margin: '0 0 16px 0' }}>
          Uses Codex's <code style={{ fontFamily: 'var(--font-code)', fontSize: '12px' }}>app-server</code> IPC, which is <code style={{ fontFamily: 'var(--font-code)', fontSize: '12px' }}>[experimental]</code> in the upstream CLI — wire shape may move on Codex CLI upgrades. Toggle back to <strong>EXEC</strong> to restore the always-stable per-turn-spawn behavior.
        </p>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="display-font"
            onClick={onCancel}
            style={{
              padding: '6px 14px',
              fontSize: '10px',
              letterSpacing: '1.5px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              color: 'var(--color-fg-muted)',
              borderRadius: '3px',
              cursor: 'pointer',
            }}
          >
            CANCEL
          </button>
          <button
            type="button"
            className="display-font"
            onClick={onConfirm}
            style={{
              padding: '6px 14px',
              fontSize: '10px',
              letterSpacing: '1.5px',
              background: 'var(--color-accent-primary-a10, transparent)',
              border: '1px solid var(--color-accent-primary)',
              color: 'var(--color-accent-primary)',
              borderRadius: '3px',
              cursor: 'pointer',
            }}
          >
            ENABLE APPSERVER
          </button>
        </div>
      </div>
    </div>
  );
}

function CodexContextWindowSection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { codexContextPolicy?: 'max' | 'standard' }) => void;
}) {
  const catalog = useCodexCatalogFor(job.config.providerAccountRef);
  const entry = catalog?.models.find((model) => model.id === job.config.primaryModel);
  const percent = entry?.effectiveContextWindowPercent ?? 95;
  const effective = (raw?: number) => raw ? Math.floor(raw * percent / 100) : undefined;
  const standard = effective(entry?.contextWindow);
  const maximum = effective(entry?.maxContextWindow);
  const current = job.config.codexContextPolicy ?? 'max';
  const label = (value?: number) => value ? `${Math.round(value / 1_000).toLocaleString()}K effective` : 'catalog value';

  return (
    <div style={{ marginTop: '18px' }} data-help="rightpanel.config.codex-context">
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        CONTEXT WINDOW
      </div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
        {(['max', 'standard'] as const).map((policy) => (
          <button
            key={policy}
            type="button"
            onClick={() => policy !== current && onUpdatePrimary({ codexContextPolicy: policy })}
            style={{
              flex: 1,
              padding: '7px 8px',
              border: `1px solid ${policy === current ? 'var(--color-accent-primary)' : 'var(--color-border)'}`,
              background: policy === current ? 'var(--color-accent-primary-dim)' : 'transparent',
              color: policy === current ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: policy === current ? 'default' : 'pointer',
              fontFamily: 'var(--font-display)',
              fontSize: '10px',
              letterSpacing: '1px',
            }}
          >
            {policy.toUpperCase()} · {label(policy === 'max' ? maximum : standard)}
          </button>
        ))}
      </div>
      <div style={{ fontSize: '10px', lineHeight: 1.45, color: 'var(--color-fg-muted)' }}>
        MAX is the Arco default and follows the selected model and account catalog. STANDARD leaves Codex at its conservative default. Applies next turn; Codex's reported CTX value remains authoritative.
      </div>
    </div>
  );
}

// Phase 7a — per-tab Claude transport toggle. Mirror of
// CodexTransportSection above. Reads `wf.config.claudeTransport`,
// falls back to `settings.claude.transport` cascade, defaults to 'cli'.
// Flipping to NATIVE shows a one-shot warning gated by
// `settings.claude.nativeWarningSeen`; flipping back to CLI clears the
// flag so a re-enable on any tab re-shows the warning.
function ClaudeTransportSection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { claudeTransport?: 'cli' | 'native'; ultracode?: boolean }) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const cascadeDefault: 'cli' | 'native' = settings?.claude?.transport === 'native' ? 'native' : 'cli';
  const current: 'cli' | 'native' = job.config.claudeTransport ?? cascadeDefault;
  const warningSeen = settings?.claude?.nativeWarningSeen === true;
  // docs/PROVIDERS.md - sticky ultracode mode. While on it forces CLI at turn
  // time without overwriting the stored transport above, so the buttons keep
  // showing the operator's base (restored when ultracode flips off).
  const ultracode = job.config.ultracode === true;

  const [pendingEnable, setPendingEnable] = useState(false);

  const patchSettingsClaude = async (claude: { transport?: 'cli' | 'native'; nativeWarningSeen?: boolean }) => {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claude }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as typeof settings;
      if (data) setSettings(data);
    } catch { /* per-tab field still applies */ }
  };

  const apply = (next: 'cli' | 'native') => {
    onUpdatePrimary({ claudeTransport: next });
    if (next === 'cli' && warningSeen) {
      patchSettingsClaude({ nativeWarningSeen: false });
    }
  };

  const onPick = (next: 'cli' | 'native') => {
    if (next === current) return;
    if (next === 'native' && !warningSeen) {
      setPendingEnable(true);
      return;
    }
    apply(next);
  };

  const confirmEnable = () => {
    setPendingEnable(false);
    apply('native');
    patchSettingsClaude({ nativeWarningSeen: true });
  };

  return (
    <div style={{ marginTop: '18px' }} data-help="rightpanel.config.transport">
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        TRANSPORT
      </div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
        {(['cli', 'native'] as const).map((t) => {
          const active = current === t;
          return (
            <button
              key={t}
              type="button"
              className="display-font"
              onClick={() => onPick(t)}
              style={{
                flex: 1,
                padding: '6px 10px',
                fontSize: '10px',
                letterSpacing: '1.5px',
                border: '1px solid ' + (active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
                background: active ? 'var(--color-accent-primary-a10, transparent)' : 'transparent',
                color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                borderRadius: '3px',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              {t.toUpperCase()}{t === 'native' ? ' *' : ''}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
        {current === 'native'
          ? 'NATIVE: in-process Anthropic-API worker — non-destructive mid-turn steer + CLAUDE.md auto-discovery. Experimental wire fingerprint.'
          : 'CLI: per-turn `claude` CLI spawn — stable, queued steer drains post-turn.'}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', marginTop: '6px', fontStyle: 'italic' }}>
        Takes effect on the next operator turn. An active Native worker stays cached until the tab closes, regardless of toggle.
        {ultracode ? ' Ultracode is forcing CLI this turn — the selection above is your base for when ultracode is off.' : ''}
      </div>

      {/* docs/PROVIDERS.md - sticky ultracode toggle. Forces CLI + the Workflow
          tool + xhigh while on (the harness WorkflowTool lives only in the
          `claude` binary). Operator-armed, reversible, takes effect next turn. */}
      <div style={{ marginTop: '18px', paddingTop: '14px', borderTop: '1px solid var(--color-border-hairline)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: ultracode ? 'var(--color-accent-primary)' : 'var(--color-accent-secondary-dim)' }}>
            ULTRACODE
          </div>
          <button
            type="button"
            className="display-font"
            onClick={() => onUpdatePrimary({ ultracode: !ultracode })}
            style={{
              padding: '4px 16px',
              fontSize: '10px',
              letterSpacing: '1.5px',
              border: '1px solid ' + (ultracode ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
              background: ultracode ? 'var(--color-accent-primary-a10, transparent)' : 'transparent',
              color: ultracode ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              borderRadius: '3px',
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            {ultracode ? 'ON' : 'OFF'}
          </button>
        </div>
        <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
          Deep multi-agent mode — Claude authors a Workflow that fans out a fleet of subagents (find → verify → synthesize), exactly like <code>ultracode</code> in the Claude CLI. Forces the CLI transport + the Workflow tool + xhigh effort while on.
        </div>
        {ultracode && (
          <div style={{ fontSize: '10px', color: 'var(--color-warning, #d08770)', fontFamily: 'var(--font-body)', lineHeight: 1.5, marginTop: '6px' }}>
            Runs a fleet of agents unattended with full system access and spends heavily. Per-subagent actions live in the harness workflow journal, not inline in the transcript.
          </div>
        )}
      </div>

      {pendingEnable && (
        <ClaudeNativeWarningModal
          onCancel={() => setPendingEnable(false)}
          onConfirm={confirmEnable}
        />
      )}
    </div>
  );
}

// Phase 7c-followup — Anthropic server-managed compaction toggle.
// Reads `wf.config.claudeNativeCompact` (server-mirrored to meta.json
// via update_primary_config); sends the toggle through the same WS
// message. Visible only when (provider === 'claude' && transport ===
// 'native' && active model exposes `compact_20260112` in the live
// /v1/models catalog) — checking the catalog gates against models that
// would 400 on the beta header. Coexists with auto-handoff above; the
// helper text spells out the no-conflict relationship.
// NATIVE_COMPACTION_PLAN Phase 1 — DEFAULT OFF: the server-side beta fires
// mid-turn at a flat ~150K tokens and can evict a Read-heavy coding tab's
// working set. Missing config now means OFF; explicit true is the opt-in.
function ClaudeNativeCompactSection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { claudeNativeCompact?: boolean }) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const catalog = useAppStore((s) => s.claudeNativeCatalog);
  const cascadeDefault: 'cli' | 'native' = settings?.claude?.transport === 'native' ? 'native' : 'cli';
  const transport: 'cli' | 'native' = job.config.claudeTransport ?? cascadeDefault;

  // Native-only — the CLI manages its own compaction. Hide entirely on CLI tabs.
  if (transport !== 'native') return null;

  // Catalog-capability gate. If the catalog is unloaded (cold start)
  // we hide the toggle rather than offer an action that would 400 —
  // the OAuth status row in Settings re-fetches the catalog as soon as
  // login lands.
  const modelEntry = catalog?.models.find((m) => m.id === job.config.primaryModel) ?? null;
  if (!modelEntry?.supportsCompact) return null;

  const enabled = job.config.claudeNativeCompact === true;

  return (
    <div style={{ marginTop: '18px' }}>
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        ANTHROPIC SERVER-SIDE COMPACTION
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', fontFamily: 'var(--font-body)', marginBottom: '6px', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onUpdatePrimary({ claudeNativeCompact: e.target.checked })}
          style={{ accentColor: 'var(--color-accent-primary)' }}
        />
        <span style={{ color: 'var(--color-fg-muted)' }}>Use Anthropic server-side compaction</span>
      </label>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-warning, var(--color-fg-muted))', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
        ⚠ Anthropic-managed compaction (server-side). Folded into the live turn — cheapest
        when it works — but opaque and triggered at a fixed ~150K tokens regardless of window.
        On large-window or Read-heavy coding tabs it can evict the working set mid-turn and cause
        a re-read spiral. Best for research / non-coding. Leave OFF to use Arco's between-turn
        compaction instead.
      </div>
    </div>
  );
}

// NATIVE_COMPACTION_PLAN Phase 3 — opt-in auto-continue after a Native
// compaction. Default OFF (manual resume): after compaction the operator clicks
// "Continue" in the composer. When ON, the server auto-sends a short continuance
// prompt once the compaction settles (manual COMPACT button OR the Phase 2
// between-turn auto path). Kept opt-in because between-turn compaction ends the
// turn — auto-continuing is autonomous continuation, which the autonomy fence
// keeps off by default.
function NativeCompactAutoContinueSection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { nativeCompactAutoContinue?: boolean }) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const cascadeDefault: 'cli' | 'native' = settings?.claude?.transport === 'native' ? 'native' : 'cli';
  const transport: 'cli' | 'native' = job.config.claudeTransport ?? cascadeDefault;
  // Native-only — between-turn compaction + resume is a Native-transport concept.
  if (transport !== 'native') return null;

  const enabled = job.config.nativeCompactAutoContinue === true;

  return (
    <div style={{ marginTop: '18px' }}>
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        COMPACTION AUTO-CONTINUE
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', fontFamily: 'var(--font-body)', marginBottom: '6px', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onUpdatePrimary({ nativeCompactAutoContinue: e.target.checked })}
          style={{ accentColor: 'var(--color-accent-primary)' }}
        />
        <span style={{ color: 'var(--color-fg-muted)' }}>Auto-continue after compaction</span>
      </label>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
        After an in-place compaction (manual COMPACT or between-turn auto), default is to PARK
        on the summary and wait for you to click Continue. Turn this ON to auto-send a short
        continuance prompt and resume immediately — CLI-style. Off by default: between-turn
        compaction ends the turn, so auto-continuing is autonomous continuation.
      </div>
    </div>
  );
}

// Adaptive-thinking display picker for Claude Native. 'omitted' (default) is
// Claude Code parity: the API streams no thinking back, so a long adaptive
// think (Fable at high effort can run many minutes) reads as total silence in
// the Activity tab and trips the stuck banner. 'summarized' streams summarized
// thinking deltas — they land as Activity thinking rows and refresh the
// stuck-detector clock. Only affects adaptive-thinking models (Opus 4.6+ /
// Sonnet 4.6+ / Fable / Mythos); budget-thinking models always summarize.
function ClaudeNativeThinkingDisplaySection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { claudeNativeThinkingDisplay?: 'omitted' | 'summarized' | 'updates' }) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const cascadeDefault: 'cli' | 'native' = settings?.claude?.transport === 'native' ? 'native' : 'cli';
  const transport: 'cli' | 'native' = job.config.claudeTransport ?? cascadeDefault;
  if (transport !== 'native') return null;

  const mode: 'omitted' | 'summarized' | 'updates' = job.config.claudeNativeThinkingDisplay ?? 'omitted';

  return (
    <div data-help="rightpanel.config.thinking-visibility" style={{ marginTop: '18px' }}>
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        THINKING VISIBILITY
      </div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
        {(['omitted', 'summarized', 'updates'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onUpdatePrimary({ claudeNativeThinkingDisplay: m })}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              fontFamily: 'var(--font-body)',
              border: '1px solid ' + (m === mode ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
              background: m === mode ? 'var(--color-accent-primary-dim)' : 'transparent',
              color: m === mode ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: 'pointer',
              borderRadius: '2px',
            }}
          >
            {m}
          </button>
        ))}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
        <code style={{ fontFamily: 'var(--font-code)' }}>summarized</code> streams the model's summarized
        thinking into the Activity tab during long reasoning stretches (Fable/Opus can think for minutes
        with no other output). <code style={{ fontFamily: 'var(--font-code)' }}>updates</code> (Fable 5 / 5.1,
        Opus 5.5) requests short progress notes with hidden reasoning; notes are not guaranteed
        (the September 1 Fable 5.1 acceptance run emitted none). Other models treat it as omitted.{' '}
        <code style={{ fontFamily: 'var(--font-code)' }}>omitted</code> is Claude Code
        parity: no thinking streamed, quieter transcript. Adaptive-thinking models only; takes effect next turn.
      </div>
    </div>
  );
}

// Debug override for Opus/Sonnet adaptive-thinking models. Default off:
// Anthropic says adaptive thinking already interleaves reasoning between
// tool calls, and current Pi skips this beta. Turning this on appends the
// legacy beta anyway so a suspicious workflow can be A/B tested.
function ClaudeNativeInterleavedBetaSection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { claudeNativeForceInterleavedThinkingBeta?: boolean }) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const cascadeDefault: 'cli' | 'native' = settings?.claude?.transport === 'native' ? 'native' : 'cli';
  const transport: 'cli' | 'native' = job.config.claudeTransport ?? cascadeDefault;
  if (transport !== 'native') return null;

  const enabled = job.config.claudeNativeForceInterleavedThinkingBeta === true;

  return (
    <div style={{ marginTop: '18px' }}>
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        INTERLEAVED THINKING BETA
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', fontFamily: 'var(--font-body)', marginBottom: '6px', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onUpdatePrimary({ claudeNativeForceInterleavedThinkingBeta: e.target.checked })}
          style={{ accentColor: 'var(--color-accent-primary)' }}
        />
        <span style={{ color: 'var(--color-fg-muted)' }}>Force legacy interleaved-thinking beta</span>
      </label>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
        Debug only. Adaptive Claude models already reason between tool calls; this forces <code>interleaved-thinking-2025-05-14</code> anyway on the next turn for A/B testing if Native starts repeating searches or missing tool results.
      </div>
    </div>
  );
}

// docs/PROVIDERS.md - per-tab Native tool-result filter mode.
// Filters run on the current turn's tool_result before it enters the
// Native worker's `messages[]` (cache invariant: prior turns are never
// rewritten). Default `off` until measured per the §13.3 doc-discipline
// rule (no aggressive defaults). `aggressive` resolves to the same pack
// list as `conservative` until promoted packs land in a follow-up phase.
function ClaudeNativeToolFilterSection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive' }) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const cascadeDefault: 'cli' | 'native' = settings?.claude?.transport === 'native' ? 'native' : 'cli';
  const transport: 'cli' | 'native' = job.config.claudeTransport ?? cascadeDefault;
  if (transport !== 'native') return null;

  const mode: 'off' | 'conservative' | 'aggressive' = job.config.efficiencyToolFilter ?? 'off';

  return (
    <div style={{ marginTop: '18px' }}>
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        TOOL-RESULT FILTER
      </div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
        {(['off', 'conservative', 'aggressive'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onUpdatePrimary({ efficiencyToolFilter: m })}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              fontFamily: 'var(--font-body)',
              border: '1px solid ' + (m === mode ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
              background: m === mode ? 'var(--color-accent-primary-dim)' : 'transparent',
              color: m === mode ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: 'pointer',
              borderRadius: '2px',
            }}
          >
            {m}
          </button>
        ))}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
        Trims noisy tool output (cargo/jest/pytest passing lines, find/grep/ls head-cap) before it enters context.
        Raw bytes are gzipped under <code style={{ fontFamily: 'var(--font-code)' }}>artifacts/raw-tools/</code> for recovery.
      </div>
    </div>
  );
}

// Per-tab Claude Native web_search / web_fetch per-turn budget. Sets the
// Anthropic server tools' `max_uses` for ordinary turns (the worker rebuilds
// the tool defs each turn). Absent ⇒ server default (15). Native-only — CLI
// Claude routes web tooling through the `claude` binary, which budgets itself.
function ClaudeNativeWebBudgetSection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { webSearchMaxUses?: number }) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const cascadeDefault: 'cli' | 'native' = settings?.claude?.transport === 'native' ? 'native' : 'cli';
  const transport: 'cli' | 'native' = job.config.claudeTransport ?? cascadeDefault;
  if (transport !== 'native') return null;

  const DEFAULT = 15;
  const current = job.config.webSearchMaxUses ?? DEFAULT;
  const presets = [10, 15, 25, 50] as const;

  return (
    <div style={{ marginTop: '18px' }} data-help="rightpanel.config.web-budget">
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        WEB LOOKUPS / TURN
      </div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
        {presets.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onUpdatePrimary({ webSearchMaxUses: n })}
            style={{
              padding: '4px 12px',
              fontSize: '11px',
              fontFamily: 'var(--font-body)',
              border: '1px solid ' + (n === current ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
              background: n === current ? 'var(--color-accent-primary-dim)' : 'transparent',
              color: n === current ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: 'pointer',
              borderRadius: '2px',
            }}
          >
            {n}
          </button>
        ))}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
        Per-turn cap on <code style={{ fontFamily: 'var(--font-code)' }}>web_search</code> +{' '}
        <code style={{ fontFamily: 'var(--font-code)' }}>web_fetch</code> calls (Arco-set, not an Anthropic limit). Resets each turn;
        when a turn hits it the model reports web access exhausted. Default {DEFAULT}. Takes effect next turn.
      </div>
    </div>
  );
}

// docs/PROVIDERS.md - fact-force first-edit gate toggle.
// Native-only. Defaults to 'off'; the operator explicitly opts in per tab.
function ClaudeNativeFactForceSection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { efficiencyFactForce?: 'on' | 'off' }) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const cascadeDefault: 'cli' | 'native' = settings?.claude?.transport === 'native' ? 'native' : 'cli';
  const transport: 'cli' | 'native' = job.config.claudeTransport ?? cascadeDefault;
  if (transport !== 'native') return null;

  const mode: 'on' | 'off' = job.config.efficiencyFactForce ?? 'off';

  return (
    <div data-help="rightpanel.config.fact-force" style={{ marginTop: '18px' }}>
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        FACT-FORCE FIRST EDIT
      </div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
        {(['off', 'on'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onUpdatePrimary({ efficiencyFactForce: m })}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              fontFamily: 'var(--font-body)',
              border: '1px solid ' + (m === mode ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
              background: m === mode ? 'var(--color-accent-primary-dim)' : 'transparent',
              color: m === mode ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: 'pointer',
              borderRadius: '2px',
            }}
          >
            {m}
          </button>
        ))}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
        First <code style={{ fontFamily: 'var(--font-code)' }}>Edit</code> / <code style={{ fontFamily: 'var(--font-code)' }}>Write</code> / <code style={{ fontFamily: 'var(--font-code)' }}>MultiEdit</code> per turn asks for importers + API surface + operator instruction before the edit lands. Silent on re-edits of the same file in the same turn.
      </div>
    </div>
  );
}

// Config-protection write-gate toggle. Native-only. The gate blocks
// `Edit`/`Write`/`MultiEdit` of lint / format / type-check config files
// (eslint.config.*, tsconfig*.json, .prettierrc*, ruff.toml, .editorconfig)
// so the model fixes the code instead of weakening the gate. Default 'on'
// (absent field ⇒ on); the operator flips to 'off' to relax it for one
// workflow when a legitimate config edit is needed.
function ClaudeNativeConfigProtectionSection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { efficiencyConfigProtection?: 'on' | 'off' }) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const cascadeDefault: 'cli' | 'native' = settings?.claude?.transport === 'native' ? 'native' : 'cli';
  const transport: 'cli' | 'native' = job.config.claudeTransport ?? cascadeDefault;
  if (transport !== 'native') return null;

  const mode: 'on' | 'off' = job.config.efficiencyConfigProtection ?? 'on';

  return (
    <div style={{ marginTop: '18px' }}>
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        CONFIG-PROTECTION GATE
      </div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
        {(['on', 'off'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onUpdatePrimary({ efficiencyConfigProtection: m })}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              fontFamily: 'var(--font-body)',
              border: '1px solid ' + (m === mode ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
              background: m === mode ? 'var(--color-accent-primary-dim)' : 'transparent',
              color: m === mode ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: 'pointer',
              borderRadius: '2px',
            }}
          >
            {m}
          </button>
        ))}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
        Blocks edits to lint / format / type-check config (<code style={{ fontFamily: 'var(--font-code)' }}>eslint.config.*</code>, <code style={{ fontFamily: 'var(--font-code)' }}>tsconfig*.json</code>, <code style={{ fontFamily: 'var(--font-code)' }}>.prettierrc*</code>, <code style={{ fontFamily: 'var(--font-code)' }}>ruff.toml</code>, <code style={{ fontFamily: 'var(--font-code)' }}>.editorconfig</code>) so the model fixes the code instead of weakening the gate. Set <code style={{ fontFamily: 'var(--font-code)' }}>off</code> to relax it for this workflow.
      </div>
    </div>
  );
}

// docs/PROVIDERS.md - operator-armed durable review gate (review safe-mode). Per-tab.
// The toggle flips WorkflowConfig.reviewSafeMode; when 'on', the Native worker's
// dispatchTool pauses on a sensitive tool call and surfaces an editable proposal
// the operator approves / edits / rejects. Native-only; default 'off'.
function ClaudeNativeReviewSafeModeSection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { reviewSafeMode?: 'off' | 'on' }) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const sendRaw = useAppStore((s) => s.wsSendRaw);
  const cascadeDefault: 'cli' | 'native' = settings?.claude?.transport === 'native' ? 'native' : 'cli';
  const transport: 'cli' | 'native' = job.config.claudeTransport ?? cascadeDefault;
  if (transport !== 'native') return null;

  const mode: 'on' | 'off' = job.config.reviewSafeMode ?? 'off';
  const standing = job.standingGateApprovals ?? [];

  return (
    <div style={{ marginTop: '18px' }}>
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        REVIEW SAFE-MODE
      </div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
        {(['off', 'on'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onUpdatePrimary({ reviewSafeMode: m })}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              fontFamily: 'var(--font-body)',
              border: '1px solid ' + (m === mode ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
              background: m === mode ? 'var(--color-accent-primary-dim)' : 'transparent',
              color: m === mode ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: 'pointer',
              borderRadius: '2px',
            }}
          >
            {m}
          </button>
        ))}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
        Pauses the turn on a sensitive tool call (<code style={{ fontFamily: 'var(--font-code)' }}>Bash</code>, <code style={{ fontFamily: 'var(--font-code)' }}>KillShell</code>, writes outside the project, <code style={{ fontFamily: 'var(--font-code)' }}>git push</code> / <code style={{ fontFamily: 'var(--font-code)' }}>reset --hard</code> / <code style={{ fontFamily: 'var(--font-code)' }}>clean</code>) so you can review, edit, and approve it before it runs. Default <code style={{ fontFamily: 'var(--font-code)' }}>off</code>.
      </div>
      {standing.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          <div style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', marginBottom: '4px' }}>
            STANDING APPROVALS ({standing.length})
          </div>
          {standing.map((a) => (
            <div
              key={a.signature}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0', borderTop: '1px solid var(--color-border-hairline)' }}
            >
              <code style={{ flex: 1, fontSize: '10px', fontFamily: 'var(--font-code)', color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.sample ?? `${a.toolName} ${a.signature.slice(0, 8)}`}
              </code>
              <button
                type="button"
                onClick={() => sendRaw?.({ type: 'gate_revoke', workflowId: job.id, signature: a.signature })}
                style={{ padding: '2px 8px', fontSize: '9px', fontFamily: 'var(--font-body)', border: '1px solid var(--color-error, #e0524f)', background: 'transparent', color: 'var(--color-error, #e0524f)', cursor: 'pointer', borderRadius: '2px' }}
              >
                REVOKE
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// docs/PROVIDERS.md - opt-in sandbox tools (ctx_execute /
// ctx_search / ctx_fetch). Per-tab. The toggle flips
// WorkflowConfig.efficiencySandbox; the CLEAR DB button hits
// POST /api/workflows/:wfId/sandbox/clear. The stats line is best-effort
// (pulled from /api/workflows/:wfId/sandbox/stats on mount + on every
// `sandbox_chunk_added` push that bumps the chip counter — refetch
// dedup'd at 750 ms).
function ClaudeNativeSandboxSection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { efficiencySandbox?: 'off' | 'on' }) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const cascadeDefault: 'cli' | 'native' = settings?.claude?.transport === 'native' ? 'native' : 'cli';
  const transport: 'cli' | 'native' = job.config.claudeTransport ?? cascadeDefault;

  const mode: 'off' | 'on' = job.config.efficiencySandbox ?? 'off';
  const chunkCount = job.sandboxChunkCount ?? 0;
  const [stats, setStats] = useState<{ chunkCount: number; totalBytes: number; dbPath: string } | null>(null);
  const [clearPending, setClearPending] = useState(false);

  const refetchStats = useCallback(() => {
    fetch(`/api/workflows/${encodeURIComponent(job.id)}/sandbox/stats`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && typeof data.chunkCount === 'number') {
          setStats({ chunkCount: data.chunkCount, totalBytes: data.totalBytes, dbPath: data.dbPath });
        }
      })
      .catch(() => { /* ignore */ });
  }, [job.id]);

  useEffect(() => {
    if (transport !== 'native' || mode !== 'on') {
      setStats(null);
      return;
    }
    refetchStats();
  }, [transport, mode, refetchStats, chunkCount]);

  const onClear = () => {
    if (clearPending) return;
    setClearPending(true);
    fetch(`/api/workflows/${encodeURIComponent(job.id)}/sandbox/clear`, { method: 'POST' })
      .then((r) => r.json())
      .catch(() => null)
      .finally(() => {
        setClearPending(false);
        refetchStats();
      });
  };

  const fmtKB = (n: number) => (n / 1024).toFixed(1) + ' KB';

  if (transport !== 'native') return null;

  return (
    <div style={{ marginTop: '18px' }}>
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        SANDBOX TOOLS
      </div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
        {(['off', 'on'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onUpdatePrimary({ efficiencySandbox: m })}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              fontFamily: 'var(--font-body)',
              border: '1px solid ' + (m === mode ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
              background: m === mode ? 'var(--color-accent-primary-dim)' : 'transparent',
              color: m === mode ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: 'pointer',
              borderRadius: '2px',
            }}
          >
            {m}
          </button>
        ))}
        {mode === 'on' && (
          <button
            type="button"
            onClick={onClear}
            disabled={clearPending}
            style={{
              marginLeft: 'auto',
              padding: '4px 10px',
              fontSize: '11px',
              fontFamily: 'var(--font-body)',
              border: '1px solid var(--color-border-hairline)',
              background: 'transparent',
              color: clearPending ? 'var(--color-fg-muted)' : 'var(--color-fg-secondary)',
              cursor: clearPending ? 'default' : 'pointer',
              borderRadius: '2px',
            }}
            title="Truncate this tab's sandbox.db. Operator-initiated; emits sandbox_db_cleared into events.jsonl."
          >
            CLEAR DB
          </button>
        )}
      </div>
      {mode === 'on' && stats && (
        <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', marginBottom: '6px' }}>
          {stats.chunkCount} chunks · {fmtKB(stats.totalBytes)}
        </div>
      )}
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
        Registers <code style={{ fontFamily: 'var(--font-code)' }}>ctx_execute</code> / <code style={{ fontFamily: 'var(--font-code)' }}>ctx_search</code> / <code style={{ fontFamily: 'var(--font-code)' }}>ctx_fetch</code> alongside the native tool set. Per-tab SQLite FTS5 index lives at <code style={{ fontFamily: 'var(--font-code)' }}>.arco/workflows/&lt;wfId&gt;/sandbox.db</code> and is unlinked on tab close.
      </div>
    </div>
  );
}

// docs/PROVIDERS.md - operator-armed terseness picker. Honored by Claude
// Native and Codex app-server providers (Codex). Hidden on transports
// that do not consume it. Three discrete levels:
// `normal` (default), `lite`, `terse`. Takes effect on the next turn.
// Renamed `caveman` → `terse` 2026-05-10 after measuring ~10–25%
// reduction on Opus 4.7 (well below upstream's 65–75% claim) — the
// new label sets honest expectations. Review / Handoff / DOCS / GIT
// primitives hard-code `normal` regardless of this picker — see plan §6.
// docs/GOTCHAS.md - operator-set persistent north-star. A short free-text
// objective pinned into the system prompt every turn, durable across restarts.
// Zero model authority — pure steering context. Cap mirrors the server's
// GOAL_MAX_BYTES (goalBlock.ts); the soft-warn threshold nudges before the cap.
const GOAL_MAX_BYTES = 2048;
const GOAL_SOFT_WARN_BYTES = 1536;

// DD7 — per-tab project-trust row. The turn-time gate raises its prompt once
// per cwd per server lifetime and only in the tab whose turn hit it first, so a
// missed banner used to mean hand-editing ~/.arco/trust.json. Trust is keyed
// by cwd, so setting it here also covers every cluster member sharing the repo.
// ASK re-arms the one-shot prompt. Takes effect on the next turn.
function ProjectTrustSection({ cwd }: { cwd: string }) {
  const { snapshot, busy, setTrust } = useProjectTrust(cwd);
  const info = snapshot?.cwd;
  if (!info) return null;

  const status: TrustStatus = info.status;
  const inherited = info.matchedPath && info.matchedPath !== info.path ? info.matchedPath : null;
  const options: Array<{ key: TrustStatus; label: string; write: 'always' | 'never' | 'clear' }> = [
    { key: 'always', label: 'TRUSTED', write: 'always' },
    { key: 'ask', label: 'ASK', write: 'clear' },
    { key: 'never', label: 'BLOCKED', write: 'never' },
  ];

  return (
    <div style={{ marginTop: '18px' }} data-help="rightpanel.config.project-trust">
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        PROJECT TRUST
      </div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            disabled={busy}
            onClick={() => { void setTrust(cwd, o.write); }}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              fontFamily: 'var(--font-body)',
              border: '1px solid ' + (o.key === status ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
              background: o.key === status ? 'var(--color-accent-primary-dim)' : 'transparent',
              color: o.key === status ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: busy ? 'default' : 'pointer',
              borderRadius: '2px',
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
        {info.resources.length > 0
          ? <>This repo ships <code style={{ fontFamily: 'var(--font-code)' }}>{info.resources.join(', ')}</code>. {status === 'always' ? 'Folded into every turn.' : 'Suppressed from every turn until trusted.'}</>
          : <>Nothing gated here — no <code style={{ fontFamily: 'var(--font-code)' }}>CLAUDE.md</code>, project skills, or <code style={{ fontFamily: 'var(--font-code)' }}>.arco/settings.json</code> in this cwd.</>}
        {' '}Applies to <code style={{ fontFamily: 'var(--font-code)' }}>{info.path}</code>{inherited ? <> (inherited from <code style={{ fontFamily: 'var(--font-code)' }}>{inherited}</code>)</> : null} and every tab or cluster member sharing it. Takes effect next turn.
      </div>
    </div>
  );
}

function NorthStarSection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { goal?: string; goalRun?: { enabled: boolean; total?: number; tokenBudget?: number } }) => void;
}) {
  const saved = job.config.goal ?? '';
  const [draft, setDraft] = useState(saved);
  // Re-sync the textarea when the persisted value changes out from under us
  // (rehydrate, another observer's goal_set, or a server-side cap/clear).
  useEffect(() => { setDraft(saved); }, [saved]);

  const byteLen = new TextEncoder().encode(draft).length;
  const overCap = byteLen > GOAL_MAX_BYTES;
  const nearCap = byteLen > GOAL_SOFT_WARN_BYTES;
  const dirty = draft !== saved;
  const counterColor = overCap
    ? 'var(--color-accent-danger, #e06c75)'
    : nearCap
      ? 'var(--color-accent-warning, #d19a66)'
      : 'var(--color-fg-muted)';

  return (
    <div style={{ marginTop: '18px' }} data-help="rightpanel.config.north-star">
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        NORTH STAR
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="What is this whole session ultimately in service of? (e.g. Ship the v2 billing rewrite; keep the public API stable.)"
        rows={3}
        spellCheck={false}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          resize: 'vertical',
          padding: '8px',
          fontSize: '12px',
          fontFamily: 'var(--font-body)',
          lineHeight: 1.5,
          color: 'var(--color-fg)',
          background: 'var(--color-bg-elevated, rgba(255,255,255,0.03))',
          border: '1px solid ' + (overCap ? 'var(--color-accent-danger, #e06c75)' : 'var(--color-border-hairline)'),
          borderRadius: '2px',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '6px' }}>
        <span style={{ fontSize: '10px', color: counterColor, fontFamily: 'var(--font-code)' }}>
          {byteLen} / {GOAL_MAX_BYTES}B{overCap ? ' · trimmed on save' : ''}
        </span>
        <div style={{ display: 'flex', gap: '6px' }}>
          {saved && (
            <button
              type="button"
              onClick={() => { setDraft(''); onUpdatePrimary({ goal: '' }); }}
              style={{
                padding: '4px 10px',
                fontSize: '11px',
                fontFamily: 'var(--font-body)',
                border: '1px solid var(--color-border-hairline)',
                background: 'transparent',
                color: 'var(--color-fg-muted)',
                cursor: 'pointer',
                borderRadius: '2px',
              }}
            >
              Clear
            </button>
          )}
          <button
            type="button"
            disabled={!dirty}
            onClick={() => onUpdatePrimary({ goal: draft })}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              fontFamily: 'var(--font-body)',
              border: '1px solid ' + (dirty ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
              background: dirty ? 'var(--color-accent-primary-dim)' : 'transparent',
              color: dirty ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: dirty ? 'pointer' : 'default',
              borderRadius: '2px',
            }}
          >
            Save
          </button>
        </div>
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5, marginTop: '6px' }}>
        A durable objective pinned into the prompt every turn until you clear it — it steers priorities and
        what "done" looks like. Pure context, <strong>not</strong> an instruction to act autonomously: it never
        loops, grades work, or spawns anything. Inherited by Review / Handoff / Spawn / DOCS / GIT.
      </div>
      <GoalRunControl job={job} onUpdatePrimary={onUpdatePrimary} hasNorthStar={!!saved.trim()} />
    </div>
  );
}

// docs/GOTCHAS.md - arming surface for the north-star auto-continue. Lives
// directly under the objective it runs toward; the composer's `/goal run <n>`
// and the NorthStarBar chip write the same field.
function GoalRunControl({
  job,
  onUpdatePrimary,
  hasNorthStar,
}: {
  job: JobState;
  onUpdatePrimary: (update: { goalRun?: { enabled: boolean; total?: number; tokenBudget?: number } }) => void;
  hasNorthStar: boolean;
}) {
  const run = job.config.goalRun;
  const armed = run?.enabled === true;
  const [iterations, setIterations] = useState('10');
  const [tokenBudget, setTokenBudget] = useState('');

  const parsedIterations = Number.parseInt(iterations, 10);
  const iterationsValid = Number.isFinite(parsedIterations) && parsedIterations >= 1;
  // Blank ⇒ no ceiling (iterations only). A typed value is read as millions of
  // tokens because that's the scale a run actually operates at — the incident
  // that motivated this feature burned 5.4M in 13 minutes.
  const parsedBudget = tokenBudget.trim() ? Number.parseFloat(tokenBudget) : undefined;
  const budgetValid = parsedBudget === undefined || (Number.isFinite(parsedBudget) && parsedBudget > 0);
  const canArm = hasNorthStar && iterationsValid && budgetValid;

  const numberInput = {
    width: '58px',
    padding: '3px 6px',
    fontSize: '11px',
    fontFamily: 'var(--font-code)',
    color: 'var(--color-fg)',
    background: 'var(--color-bg-elevated, rgba(255,255,255,0.03))',
    border: '1px solid var(--color-border-hairline)',
    borderRadius: '2px',
  } as const;

  return (
    <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--color-border-hairline)' }} data-help="rightpanel.config.goal-run">
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        GOAL RUN
      </div>

      {armed && run ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', fontFamily: 'var(--font-code)', color: 'var(--color-accent-warning, #d19a66)' }}>
            ▶ {run.total - run.remaining}/{run.total}
          </span>
          <span style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-code)' }}>
            {run.remaining} left · {run.tokensUsed >= 1_000_000
              ? `${(run.tokensUsed / 1_000_000).toFixed(1)}M`
              : run.tokensUsed >= 1_000 ? `${Math.round(run.tokensUsed / 1_000)}k` : run.tokensUsed} tokens
            {typeof run.tokenBudget === 'number' ? ` / ${(run.tokenBudget / 1_000_000).toFixed(1)}M cap` : ''}
          </span>
          <button
            type="button"
            onClick={() => onUpdatePrimary({ goalRun: { enabled: false } })}
            style={{
              marginLeft: 'auto',
              padding: '4px 10px',
              fontSize: '11px',
              fontFamily: 'var(--font-body)',
              border: '1px solid var(--color-accent-danger, #e06c75)',
              background: 'transparent',
              color: 'var(--color-accent-danger, #e06c75)',
              cursor: 'pointer',
              borderRadius: '2px',
            }}
          >
            Stop
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)' }}>
            iterations
            <input
              type="number"
              min={1}
              value={iterations}
              onChange={(e) => setIterations(e.target.value)}
              style={{ ...numberInput, marginLeft: '6px' }}
            />
          </label>
          <label style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)' }}>
            token cap
            <input
              type="number"
              min={0}
              step={0.5}
              placeholder="none"
              value={tokenBudget}
              onChange={(e) => setTokenBudget(e.target.value)}
              style={{ ...numberInput, marginLeft: '6px' }}
            />
            <span style={{ marginLeft: '4px', opacity: 0.7 }}>M</span>
          </label>
          <button
            type="button"
            disabled={!canArm}
            title={hasNorthStar ? undefined : 'Set a north star first — a goal run continues toward it.'}
            onClick={() => onUpdatePrimary({
              goalRun: {
                enabled: true,
                total: parsedIterations,
                ...(parsedBudget !== undefined ? { tokenBudget: Math.round(parsedBudget * 1_000_000) } : {}),
              },
            })}
            style={{
              marginLeft: 'auto',
              padding: '4px 10px',
              fontSize: '11px',
              fontFamily: 'var(--font-body)',
              border: '1px solid ' + (canArm ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
              background: canArm ? 'var(--color-accent-primary-dim)' : 'transparent',
              color: canArm ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: canArm ? 'pointer' : 'default',
              borderRadius: '2px',
            }}
          >
            Arm
          </button>
        </div>
      )}

      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5, marginTop: '8px' }}>
        {hasNorthStar
          ? <>Dispatches one automatic continuation turn after each settled turn, until the budget is spent. Also stops on a turn error, a rate-limited provider, context past 92%, or a cleared north star. Your own messages don{'’'}t stop it. Composer equivalents: <code style={{ fontFamily: 'var(--font-code)' }}>/goal run 10</code>, <code style={{ fontFamily: 'var(--font-code)' }}>/goal run stop</code>. A server restart ends any armed run.</>
          : <>Set a north star above to arm a run — the loop continues <em>toward</em> it.</>}
      </div>
    </div>
  );
}

function OutputStyleSection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { outputStyle?: 'normal' | 'lite' | 'terse' }) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const provider: ProviderName = job.config.primaryProvider ?? 'claude';
  if (provider === 'claude') {
    const cascadeDefault: 'cli' | 'native' = settings?.claude?.transport === 'native' ? 'native' : 'cli';
    const transport: 'cli' | 'native' = job.config.claudeTransport ?? cascadeDefault;
    if (transport !== 'native') return null;
  }
  if (provider === 'codex') {
    const cascadeDefault: 'exec' | 'appserver' = settings?.codex?.transport === 'appserver' ? 'appserver' : 'exec';
    const transport: 'exec' | 'appserver' = job.config.codexTransport ?? cascadeDefault;
    if (transport !== 'appserver') return null;
  }
  if (provider !== 'claude' && provider !== 'codex') return null;

  const mode: 'normal' | 'lite' | 'terse' = job.config.outputStyle ?? 'normal';

  return (
    <div style={{ marginTop: '18px' }} data-help="rightpanel.config.output-style">
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        OUTPUT STYLE
      </div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
        {(['normal', 'lite', 'terse'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onUpdatePrimary({ outputStyle: m })}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              fontFamily: 'var(--font-body)',
              border: '1px solid ' + (m === mode ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
              background: m === mode ? 'var(--color-accent-primary-dim)' : 'transparent',
              color: m === mode ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: 'pointer',
              borderRadius: '2px',
            }}
          >
            {m}
          </button>
        ))}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
        Appends a small stable prompt addendum telling the model how terse to be.
        <code style={{ fontFamily: 'var(--font-code)' }}>lite</code> drops fillers/hedging;
        <code style={{ fontFamily: 'var(--font-code)' }}>terse</code> also drops articles, fragments OK.
        Measures ~10–25% output reduction on Opus 4.7; Codex effect is model-dependent.
        Code blocks, error strings, file paths preserved verbatim.
        Review / Handoff / DOCS / GIT always run as <code style={{ fontFamily: 'var(--font-code)' }}>normal</code>.
      </div>
    </div>
  );
}

// First-time-enable warning modal for Claude Native.
// Transport behavior is documented in docs/PROVIDERS.md.
function ClaudeNativeWarningModal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9400,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        style={{
          background: 'var(--color-bg)',
          border: '1px solid var(--color-accent-primary)',
          borderRadius: '4px',
          maxWidth: '560px',
          padding: '20px 24px',
          fontFamily: 'var(--font-body)',
          fontSize: '13px',
          color: 'var(--color-fg)',
          lineHeight: 1.55,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}
      >
        <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary)', marginBottom: '14px' }}>
          CLAUDE TRANSPORT: NATIVE <span style={{ fontStyle: 'italic', color: 'var(--color-fg-muted)' }}>(experimental)</span>
        </div>
        <p style={{ margin: '0 0 12px 0' }}>
          Talks to Anthropic's API directly instead of running the <code style={{ fontFamily: 'var(--font-code)', fontSize: '12px' }}>claude</code> CLI. Unlocks mid-turn steer. Wire-fingerprints as Claude Code; billed against your Claude subscription. Native sessions are Arco-internal — they can't be resumed from a terminal <code style={{ fontFamily: 'var(--font-code)', fontSize: '12px' }}>claude --resume</code>.
        </p>
        <p style={{ margin: '0 0 16px 0' }}>
          Skipped on Native: MCP servers, NotebookEdit, the Skill tool, plugins, Claude-Code's agents system. Hooks still work. Toggle back to CLI to restore full Claude Code feature parity for this tab.
        </p>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="display-font"
            onClick={onCancel}
            style={{
              padding: '6px 14px',
              fontSize: '10px',
              letterSpacing: '1.5px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              color: 'var(--color-fg-muted)',
              borderRadius: '3px',
              cursor: 'pointer',
            }}
          >
            CANCEL
          </button>
          <button
            type="button"
            className="display-font"
            onClick={onConfirm}
            style={{
              padding: '6px 14px',
              fontSize: '10px',
              letterSpacing: '1.5px',
              background: 'var(--color-accent-primary-a10, transparent)',
              border: '1px solid var(--color-accent-primary)',
              color: 'var(--color-accent-primary)',
              borderRadius: '3px',
              cursor: 'pointer',
            }}
          >
            ENABLE NATIVE
          </button>
        </div>
      </div>
    </div>
  );
}

// docs/PROVIDERS.md (Excellence LE-6) - model-lifecycle console.
// Collapsible section, Ollama tabs only. Polls GET /api/ollama-ps WHILE OPEN
// (closed = no polling, same gating discipline as the header indicator) and
// renders the currently-loaded models per backend with size + an idle/expiry
// countdown + a keep_alive:0 unload button each. The countdown is computed
// server-side (secondsUntilExpiry at fetchedAt) and ticked down locally so it's
// live without re-fetching. Unload POSTs to /api/ollama-unload with the model's
// home backend baseUrl + this tab's workflowId so the eviction lands in the
// tab's events.jsonl (visible). The per-tab keep_alive that governs eviction
// lives in ADVANCED PARAMS above (M3) — surfaced here read-only so the operator
// sees the current value without leaving the console; we deliberately don't
// duplicate the editor (one source of truth, ollamaParams.keep_alive).
function fmtVram(bytes: number | null): string {
  if (bytes == null || bytes <= 0) return '—';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

// Format the live eviction countdown. null = forever-loaded (keep_alive:-1) or
// unknown; <=0 = overdue (the daemon evicts lazily, so this is normal for a few
// seconds). Otherwise mm:ss, or just "Ns" under a minute.
function fmtCountdown(sec: number | null): string {
  if (sec == null) return 'no expiry';
  if (sec <= 0) return 'evicting…';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

const OLLAMA_PS_POLL_MS = 5000;

function OllamaLifecycleSection({ job }: { job: JobState }) {
  const [open, setOpen] = useState(false);
  const [agg, setAgg] = useState<OllamaPsAggregate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Per-(backend|model) unload-in-flight flag so the clicked button disables
  // without disabling every unload button at once.
  const [unloading, setUnloading] = useState<Record<string, boolean>>({});
  // Local clock tick so the countdowns advance between polls.
  const [, setTick] = useState(0);

  const params = (job.config.ollamaParams ?? {}) as Record<string, unknown>;
  const keepAlive = params.keep_alive != null ? String(params.keep_alive) : null;

  const refresh = useCallback(() => {
    setLoading(true);
    fetch('/api/ollama-ps')
      .then((r) => r.json() as Promise<OllamaPsAggregate | { error: string }>)
      .then((d) => {
        if ('error' in d) { setError(d.error); return; }
        setError(null);
        setAgg(d);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  // Poll only while the section is open — closed = zero network work.
  useEffect(() => {
    if (!open) return;
    refresh();
    const id = setInterval(refresh, OLLAMA_PS_POLL_MS);
    return () => clearInterval(id);
  }, [open, refresh]);

  // 1Hz local tick for the countdowns (only while open + data present).
  useEffect(() => {
    if (!open || !agg) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [open, agg]);

  const unload = (backend: { baseUrl: string; label: string }, model: string) => {
    const key = `${backend.baseUrl}|${model}`;
    setUnloading((u) => ({ ...u, [key]: true }));
    fetch('/api/ollama-unload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, baseUrl: backend.baseUrl, label: backend.label, workflowId: job.id }),
    })
      .then((r) => r.json() as Promise<{ unloaded?: boolean; error?: string }>)
      .then((d) => { if (d.error) setError(d.error); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      // Re-poll so the unloaded model drops off the list (or shows as gone).
      .finally(() => { setUnloading((u) => ({ ...u, [key]: false })); refresh(); });
  };

  // Compute the live countdown off secondsUntilExpiry + elapsed-since-fetch so
  // it advances between the 5s polls without trusting the local clock for the
  // absolute value (server computed it; we just decay it).
  const liveCountdown = (sec: number | null): number | null => {
    if (sec == null || !agg) return sec;
    const elapsed = Math.floor((Date.now() - agg.fetchedAt) / 1000);
    return sec - elapsed;
  };

  const totalLoaded = agg?.backends.reduce((n, b) => n + b.loadedModels.length, 0) ?? 0;

  return (
    <div style={{ marginTop: '18px' }} data-help="rightpanel.config.ollama-lifecycle">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="display-font"
        style={{
          background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
          fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px',
          display: 'flex', alignItems: 'center', gap: '6px',
        }}
      >
        <span>{open ? '▾' : '▸'}</span>
        MODEL LIFECYCLE
        {open && totalLoaded > 0 && (
          <span style={{ color: 'var(--color-accent-primary)' }}>({totalLoaded})</span>
        )}
      </button>
      {open && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ fontSize: '9px', color: 'var(--color-fg-muted)', fontStyle: 'italic' }}>
              keep_alive: <code style={{ fontFamily: 'var(--font-code)', color: 'var(--color-fg-default)' }}>{keepAlive ?? 'default (10m)'}</code>
              {' '}— set in ADVANCED PARAMS
            </span>
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              className="display-font"
              style={{ ...miniBtnStyle, opacity: loading ? 0.5 : 1 }}
            >
              {loading ? '…' : '↻'}
            </button>
          </div>

          {error && (
            <div style={{ color: 'var(--color-danger)', fontSize: '10px', marginBottom: '6px' }}>{error}</div>
          )}

          {agg && agg.backends.length === 0 && (
            <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>No Ollama backends configured.</div>
          )}

          {agg?.backends.map((b) => (
            <div key={b.baseUrl} style={{ marginBottom: '10px', border: '1px solid var(--color-border-hairline)', borderRadius: '4px', padding: '8px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                <span style={{
                  fontSize: '9px',
                  color: b.reachable ? 'var(--color-success)' : 'var(--color-danger)',
                }}>{b.reachable ? '●' : '✕'}</span>
                <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-fg-default)' }}>
                  {b.label.toUpperCase()}
                </span>
                {b.cooling && (
                  <span style={{ fontSize: '8px', letterSpacing: '1px', color: 'var(--color-warning)' }}>COOLING</span>
                )}
              </div>
              {!b.reachable && (
                <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontStyle: 'italic' }}>
                  unreachable{b.error ? ` — ${b.error}` : ''}
                </div>
              )}
              {b.reachable && b.loadedModels.length === 0 && (
                <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>no models loaded</div>
              )}
              {b.loadedModels.map((m) => {
                const key = `${b.baseUrl}|${m.name}`;
                const busy = !!unloading[key];
                return (
                  <div key={m.name} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', padding: '3px 0' }}>
                    <span style={{ color: 'var(--color-fg-default)', flex: 1, wordBreak: 'break-word' }}>{m.name}</span>
                    <span style={{ color: 'var(--color-fg-muted)', minWidth: '54px', textAlign: 'right' }}>{fmtVram(m.sizeVram)}</span>
                    <span style={{ color: 'var(--color-fg-muted)', minWidth: '70px', textAlign: 'right' }}>{fmtCountdown(liveCountdown(m.secondsUntilExpiry))}</span>
                    <button
                      type="button"
                      onClick={() => unload({ baseUrl: b.baseUrl, label: b.label }, m.name)}
                      disabled={busy}
                      className="display-font"
                      title="keep_alive:0 — evict this model from VRAM now. The next turn reloads it from disk (non-destructive)."
                      style={{ ...miniBtnStyle, opacity: busy ? 0.5 : 1 }}
                    >
                      {busy ? '…' : 'UNLOAD'}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}

          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5, marginTop: '4px' }}>
            Loaded models across all configured Ollama backends with their VRAM footprint + idle-eviction countdown. UNLOAD frees VRAM immediately (<code style={{ fontFamily: 'var(--font-code)' }}>keep_alive:0</code>); the next turn reloads from disk.
          </div>
        </div>
      )}
    </div>
  );
}

// WP3 — Ollama M8 auto-compaction settings. GLOBAL (settings.ollama.compaction),
// not per-tab: compaction config isn't tab-scoped today, so this reads/writes
// the shared settings the same way the AUTO-HANDOFF DEFAULTS section does. The
// server sanitizer clamps to the env-parser bounds; a full-object POST replaces
// the compaction sub-object (mirror autoHandoffDefaults — POST the whole thing).
// The utility model (settings.ollama.utility.model) is surfaced read-only as a
// hint that it powers higher-fidelity summaries when configured.
function OllamaCompactionSection() {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const cfg = settings?.ollama?.compaction;
  // A paused utility (enabled:false) is treated as unset everywhere.
  const utilityModel = settings?.ollama?.utility?.enabled === false ? undefined : settings?.ollama?.utility?.model;

  // Defaults mirror ollamaRecovery.defaultCompactionConfig's hardcoded baseline
  // (env may override server-side; the UI shows the settings value when set, the
  // hardcoded default otherwise — env-only overrides aren't reflected here).
  const enabled = cfg?.enabled ?? true;
  const thresholdPct = Math.round((cfg?.threshold ?? 0.85) * 100);
  const warnPct = Math.round((cfg?.warn ?? 0.75) * 100);
  const keepLast = cfg?.keepLast ?? 10;

  const patch = async (next: OllamaCompactionConfig) => {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ollama: { compaction: next } }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as typeof settings;
      if (data) setSettings(data);
    } catch { /* best-effort; server stays source of truth */ }
  };

  // Whole-object writes (the merge replaces the compaction sub-object) so a
  // single field edit can't drop the others — assemble the full object each time
  // from the currently-displayed values.
  const setField = (field: Partial<OllamaCompactionConfig>) => {
    void patch({
      enabled,
      threshold: thresholdPct / 100,
      warn: warnPct / 100,
      keepLast,
      ...field,
    });
  };

  return (
    <div style={{ marginTop: '18px' }} data-help="rightpanel.config.ollama-compaction">
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px' }}>
        AUTO-COMPACTION
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', fontFamily: 'var(--font-body)', marginBottom: '6px', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setField({ enabled: e.target.checked })}
          style={{ accentColor: 'var(--color-accent-primary)' }}
        />
        <span style={{ color: 'var(--color-fg-muted)' }}>Enable auto-compaction</span>
      </label>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5, marginBottom: '8px' }}>
        At the threshold, Arco summarizes older messages in place on the local model so the turn fits the window. Global (applies to every Ollama tab). The COMPACT button forces it on the next turn regardless.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px', fontFamily: 'var(--font-body)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-fg-muted)' }}>
          <span style={{ minWidth: '60px', fontFamily: 'var(--font-display)', fontSize: '10px', letterSpacing: '1px' }}>THRESHOLD</span>
          <input
            type="range"
            min={50}
            max={99}
            value={thresholdPct}
            disabled={!enabled}
            onChange={(e) => setField({ threshold: Number(e.target.value) / 100 })}
            style={{ flex: 1, accentColor: 'var(--color-danger, #f04a4a)', opacity: enabled ? 1 : 0.5 }}
          />
          <span style={{ minWidth: '28px', textAlign: 'right', color: 'var(--color-danger, #f04a4a)' }}>{thresholdPct}%</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-fg-muted)' }}>
          <span style={{ minWidth: '60px', fontFamily: 'var(--font-display)', fontSize: '10px', letterSpacing: '1px' }}>WARN</span>
          <input
            type="range"
            min={40}
            max={98}
            value={warnPct}
            disabled={!enabled}
            onChange={(e) => setField({ warn: Number(e.target.value) / 100 })}
            style={{ flex: 1, accentColor: 'var(--color-warning)', opacity: enabled ? 1 : 0.5 }}
          />
          <span style={{ minWidth: '28px', textAlign: 'right', color: 'var(--color-warning)' }}>{warnPct}%</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-fg-muted)' }}>
          <span style={{ minWidth: '60px', fontFamily: 'var(--font-display)', fontSize: '10px', letterSpacing: '1px' }}>KEEP LAST</span>
          <input
            type="range"
            min={2}
            max={40}
            value={keepLast}
            disabled={!enabled}
            onChange={(e) => setField({ keepLast: Number(e.target.value) })}
            style={{ flex: 1, accentColor: 'var(--color-accent-primary)', opacity: enabled ? 1 : 0.5 }}
          />
          <span style={{ minWidth: '28px', textAlign: 'right', color: 'var(--color-accent-primary)' }}>{keepLast}</span>
        </label>
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5, marginTop: '8px' }}>
        Summaries use the utility model{utilityModel ? <> (<code>{utilityModel}</code>)</> : ' (none set — falls back to a deterministic digest)'} for higher fidelity. Set one under Settings → Ollama. WARN only flags context near the threshold; THRESHOLD triggers the cut; KEEP LAST messages stay verbatim.
      </div>
    </div>
  );
}

// docs/PROVIDERS.md - per-tab Ollama generation-param presets.
// Collapsible "advanced params" affordance, Ollama tabs only. Surfaces the
// four first-class fields (num_ctx / keep_alive / num_gpu / temperature — the
// LM Studio per-load menu, Excellence LE-2); the rest of the allowlist
// (top_p, num_predict, …) is reachable by power users via the raw-JSON field.
//
// The server owns the typed allowlist + coercion + the trusted-only num_ctx
// clamp (providers/ollamaParams.ts); the client just collects strings and
// sends the WHOLE edited blob (whole-replace, not a patch — clearing a field
// drops its key). PREFIX-CACHE: each save is an explicit operator-driven
// cache-invalidation event, logged server-side; we don't debounce per
// keystroke — the operator commits with the field blur / Save.
//
// num_ctx hint: the model's probed Modelfile window, else its arch max
// (authStatus), is shown as the trusted ceiling — the server clamps to it.
function OllamaParamsSection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { ollamaParams?: Record<string, unknown> }) => void;
}) {
  const authStatus = useAppStore((s) => s.authStatus);
  const [open, setOpen] = useState(false);

  const params = (job.config.ollamaParams ?? {}) as Record<string, unknown>;
  // Local draft so typing doesn't fire a save (and a prefix-cache-invalidation
  // log line) per keystroke. Committed on blur / Save. Seeded from the
  // persisted blob and re-seeded if the tab's stored params change underneath.
  const seed = useCallback((p: Record<string, unknown>): Record<string, string> => ({
    num_ctx: p.num_ctx != null ? String(p.num_ctx) : '',
    keep_alive: p.keep_alive != null ? String(p.keep_alive) : '',
    num_gpu: p.num_gpu != null ? String(p.num_gpu) : '',
    temperature: p.temperature != null ? String(p.temperature) : '',
  }), []);
  const [draft, setDraft] = useState<Record<string, string>>(() => seed(params));
  const persistedKey = JSON.stringify(params);
  useEffect(() => { setDraft(seed(params)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [persistedKey, seed]);

  // Trusted ceiling for the active model: Modelfile num_ctx, else arch max.
  const modelCaps = authStatus?.ollama?.installedModelCapabilities?.[String(job.config.primaryModel)];
  const probedNumCtx = modelCaps?.numCtx;
  const ctxCeiling = probedNumCtx ?? modelCaps?.archCtx;

  // Build the blob to persist: keep any non-UI keys the operator set via raw
  // JSON, overlay the four edited fields, drop empties. num_ctx/num_gpu coerce
  // to number client-side for a clean payload (server re-coerces anyway).
  const commit = (next: Record<string, string>) => {
    const blob: Record<string, unknown> = { ...params };
    const setNum = (k: string, v: string) => {
      const t = v.trim();
      if (t === '') delete blob[k];
      else { const n = Number(t); if (Number.isFinite(n)) blob[k] = n; }
    };
    setNum('num_ctx', next.num_ctx);
    setNum('num_gpu', next.num_gpu);
    setNum('temperature', next.temperature);
    // keep_alive accepts both a duration string ("10m") and seconds — pass the
    // string through verbatim; the server's allowlist handles both forms.
    const ka = next.keep_alive.trim();
    if (ka === '') delete blob.keep_alive; else blob.keep_alive = ka;
    onUpdatePrimary({ ollamaParams: blob });
  };

  const onReset = () => {
    setDraft(seed({}));
    onUpdatePrimary({ ollamaParams: {} });
  };

  const activeCount = ['num_ctx', 'keep_alive', 'num_gpu', 'temperature'].filter((k) => params[k] != null).length;

  const field = (key: keyof typeof draft, label: string, placeholder: string, hint?: string) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginBottom: '8px' }}>
      <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>{label}</span>
      <input
        type="text"
        value={draft[key]}
        placeholder={placeholder}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        style={ollamaInputStyle}
      />
      {hint && <span style={{ fontSize: '9px', color: 'var(--color-fg-muted)', fontStyle: 'italic' }}>{hint}</span>}
    </label>
  );

  return (
    <div style={{ marginTop: '18px' }} data-help="rightpanel.config.ollama-params">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="display-font"
        style={{
          background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
          fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px',
          display: 'flex', alignItems: 'center', gap: '6px',
        }}
      >
        <span>{open ? '▾' : '▸'}</span>
        ADVANCED PARAMS
        {activeCount > 0 && (
          <span style={{ color: 'var(--color-accent-primary)' }}>({activeCount})</span>
        )}
      </button>
      {open && (
        <div>
          {field('num_ctx', 'NUM_CTX', ctxCeiling ? `≤ ${ctxCeiling}` : 'unset → daemon default',
            probedNumCtx
              ? `Trusted-only: clamped to the model's Modelfile window (${probedNumCtx}).`
              : ctxCeiling
                ? `No Modelfile num_ctx — clamped to the model's trained max (${ctxCeiling}). Unset runs the daemon's VRAM-based default; use SET TO FIT for the largest window that fits.`
                : 'No probed window for this model — num_ctx is dropped (daemon default applies) until the model reports one.')}
          {field('keep_alive', 'KEEP_ALIVE', '10m', 'Duration ("10m", "1h") or seconds (-1 = forever, 0 = evict).')}
          {field('num_gpu', 'NUM_GPU', 'layers', 'GPU layers to offload; 0 = CPU-only.')}
          {field('temperature', 'TEMPERATURE', 'e.g. 0.7')}
          <button
            type="button"
            onClick={onReset}
            className="display-font"
            style={{ ...miniBtnStyle, marginTop: '2px' }}
            title="Clear all Ollama params for this tab; reverts to Modelfile/daemon defaults on the next turn."
          >
            RESET
          </button>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5, marginTop: '8px' }}>
            Per-tab Ollama generation params, merged into <code style={{ fontFamily: 'var(--font-code)' }}>/api/chat</code> through a typed allowlist. Takes effect next turn (and re-prefills the prompt — Ollama's prefix cache keys on a stable request). Power-user keys (top_p, num_predict, …) are accepted on the wire.
          </div>
        </div>
      )}
    </div>
  );
}

// ── VRAM budget readout + auto context-sizer (hardware-synergy) ──
//
// Hardware awareness for Ollama tabs. Two server probes:
//   GET  /api/ollama/vram — the LOCAL board's GPU VRAM vs what the local daemon
//                           has resident now (readout + headroom bar).
//   POST /api/ollama/fit  — predictive: max num_ctx the primary can use on this
//                           GPU, reserving headroom for a LOCAL utility model
//                           (a remote utility costs zero local VRAM).
//
// The "SET TO FIT" button writes num_ctx through the SAME onUpdatePrimary path
// the ADVANCED PARAMS fields use — so the prefix-cache invalidation is logged
// server-side and takes effect at the next turn boundary, never mid-turn. All
// numbers are estimates (coarse KV-cache heuristics); the UI says so.
const GIB = 1024 * 1024 * 1024;
function gib(bytes: number): string { return (bytes / GIB).toFixed(1); }
// A utility baseUrl that isn't localhost ⇒ the summarizer runs on another box,
// so it costs zero VRAM on this GPU (the 3070-on-Unraid payoff).
function isRemoteHost(url: string | undefined): boolean {
  if (!url || !url.trim()) return false;
  try {
    const h = new URL(url).hostname;
    return !/^(localhost|127\.|0\.0\.0\.0|::1|\[::1\])/.test(h);
  } catch { return false; }
}

interface VramReport {
  available: boolean; note?: string; backend: string;
  gpus: Array<{ name: string; vramBytes: number }>;
  totalVramBytes: number; daemonUp: boolean;
  loaded: Array<{ name: string; sizeVramBytes: number | null }>;
  usedVramBytes: number; availableVramBytes: number; fetchedAt: number;
}
interface FitReport {
  ok: boolean; available: boolean; note?: string;
  totalVramBytes: number; reservedForUtilityBytes: number;
  kvCacheType?: string;
  primary: { model: string; found: boolean; params?: number; quant?: string; contextMax?: number; currentNumCtx?: number; estimateMethod?: 'measured-live' | 'sliding-window' | 'needs-load' | 'unknown'; maxNumCtx?: number; estVramAtMaxBytes?: number; liveLoadedCtx?: number; liveSizeVramBytes?: number } | null;
  utility: { model: string; found: boolean; footprintBytes?: number; remote: boolean } | null;
  coexist: boolean; fetchedAt: number;
}

function OllamaVramSection({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary: (update: { ollamaParams?: Record<string, unknown> }) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const [open, setOpen] = useState(false);
  const [vram, setVram] = useState<VramReport | null>(null);
  const [fit, setFit] = useState<FitReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const primaryModel = String(job.config.primaryModel ?? '');
  const utilityPaused = settings?.ollama?.utility?.enabled === false;
  const utilityModel = utilityPaused ? '' : (settings?.ollama?.utility?.model ?? '');
  const utilityBaseUrl = utilityPaused ? undefined : settings?.ollama?.utility?.baseUrl;
  const utilityRemote = isRemoteHost(utilityBaseUrl);
  const params = (job.config.ollamaParams ?? {}) as Record<string, unknown>;
  const overrideNumCtx = typeof params.num_ctx === 'number' ? params.num_ctx : undefined;

  const refreshVram = useCallback(() => {
    fetch('/api/ollama/vram')
      .then((r) => r.json() as Promise<VramReport | { error: string }>)
      .then((d) => { if ('error' in d) setError(d.error); else { setError(null); setVram(d); } })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const refreshFit = useCallback(() => {
    if (!primaryModel) { setFit(null); return; }
    fetch('/api/ollama/fit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primary: primaryModel, utility: utilityModel || null, utilityRemote }),
    })
      .then((r) => r.json() as Promise<FitReport | { error: string }>)
      .then((d) => { if (!('error' in d)) setFit(d); })
      .catch(() => { /* fit is best-effort */ });
  }, [primaryModel, utilityModel, utilityRemote]);

  // Readout polls (VRAM use changes as models load/evict); fit re-fetches when
  // the model/utility config changes (cheap — /api/show is metadata-only).
  useEffect(() => {
    if (!open) return;
    refreshVram();
    refreshFit();
    const id = setInterval(refreshVram, 8000);
    return () => clearInterval(id);
  }, [open, refreshVram, refreshFit]);

  const method = fit?.primary?.estimateMethod;
  // Only a 'measured-live' estimate (derived from the model's ACTUAL loaded VRAM,
  // so it reflects the real KV-cache quant) drives SET TO FIT and the warning.
  // 'sliding-window' / 'needs-load' / 'unknown' must NOT restrict context.
  const measured = method === 'measured-live';
  const maxNumCtx = measured && fit?.primary?.maxNumCtx ? fit.primary.maxNumCtx : 0;
  const targetCtx = overrideNumCtx ?? fit?.primary?.currentNumCtx;
  // Round the suggestion down to a tidy 1024-multiple so the operator gets a
  // clean number, never the raw byte-derived ceiling.
  const suggested = maxNumCtx > 0 ? Math.floor(maxNumCtx / 1024) * 1024 : 0;
  const canSetFit = measured && suggested > 0 && suggested !== overrideNumCtx;

  const setToFit = () => {
    if (suggested <= 0) return;
    onUpdatePrimary({ ollamaParams: { ...params, num_ctx: suggested } });
    // Optimistic: the next fit refresh will reflect it; nudge immediately.
    setTimeout(refreshFit, 50);
  };

  const usedPct = vram && vram.totalVramBytes > 0
    ? Math.min(100, Math.round((vram.usedVramBytes / vram.totalVramBytes) * 100))
    : 0;
  const reserved = fit?.reservedForUtilityBytes ?? 0;

  return (
    <div style={{ marginTop: '18px' }} data-help="rightpanel.config.ollama-vram">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="display-font"
        style={{
          background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
          fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '8px',
          display: 'flex', alignItems: 'center', gap: '6px',
        }}
      >
        <span>{open ? '▾' : '▸'}</span>
        VRAM BUDGET
        {vram?.available && <span style={{ color: 'var(--color-accent-primary)' }}>({gib(vram.usedVramBytes)}/{gib(vram.totalVramBytes)} GB)</span>}
      </button>
      {open && (
        <div style={{ fontSize: '11px', fontFamily: 'var(--font-body)', color: 'var(--color-fg-muted)' }}>
          {error && <div style={{ color: 'var(--color-danger, #f04a4a)', marginBottom: '6px' }}>{error}</div>}

          {/* No CUDA GPU → the whole feature is moot; explain and stop. */}
          {vram && !vram.available && (
            <div style={{ lineHeight: 1.5 }}>
              VRAM probe unavailable{vram.note ? <> — {vram.note}</> : ''}. The budget readout and context-sizer need a local NVIDIA GPU (nvidia-smi).
            </div>
          )}

          {vram && vram.available && (
            <>
              {/* Headroom bar: used (+ a reserved slice for a local utility). */}
              <div style={{ marginBottom: '4px' }}>
                {gib(vram.usedVramBytes)} / {gib(vram.totalVramBytes)} GB used · {gib(vram.availableVramBytes)} GB free
                {vram.gpus[0] ? <span style={{ opacity: 0.7 }}> · {vram.gpus[0].name}</span> : null}
                {fit?.kvCacheType ? <span style={{ opacity: 0.7 }}> · KV cache {fit.kvCacheType}</span> : null}
              </div>
              <div style={{ height: '8px', borderRadius: '4px', background: 'var(--color-bg-sunken)', overflow: 'hidden', marginBottom: '6px', display: 'flex' }}>
                <div style={{ width: `${usedPct}%`, background: usedPct > 90 ? 'var(--color-danger, #f04a4a)' : 'var(--color-accent-primary)' }} />
              </div>
              {!vram.daemonUp && <div style={{ marginBottom: '6px', fontStyle: 'italic' }}>Local Ollama daemon not responding to /api/ps — "used" may be stale.</div>}
              {vram.loaded.length > 0 && (
                <div style={{ marginBottom: '8px', fontSize: '10px' }}>
                  {vram.loaded.map((m) => (
                    <div key={m.name} style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <code style={{ fontFamily: 'var(--font-code)' }}>{m.name}</code>
                      <span>{m.sizeVramBytes != null ? `${gib(m.sizeVramBytes)} GB` : '—'}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Coexistence warning / remote-utility note. */}
              {fit?.utility && fit.utility.remote && (
                <div style={{ marginBottom: '8px', padding: '6px 8px', borderRadius: '3px', background: 'var(--color-bg-sunken)', lineHeight: 1.5 }}>
                  Utility model <code style={{ fontFamily: 'var(--font-code)' }}>{fit.utility.model}</code> runs on a remote host — zero local VRAM. The primary gets the whole board.
                </div>
              )}
              {fit?.utility && !fit.utility.remote && fit.utility.found && !fit.coexist && (
                <div style={{ marginBottom: '8px', padding: '6px 8px', borderRadius: '3px', border: '1px solid var(--color-warning)', color: 'var(--color-warning)', lineHeight: 1.5 }}>
                  ⚠ Primary + local utility <code style={{ fontFamily: 'var(--font-code)' }}>{fit.utility.model}</code> (~{gib(fit.utility.footprintBytes ?? 0)} GB) won't both fit at the current context — Ollama will evict/reload between turns (slow). Lower num_ctx, use a smaller utility, or point the utility at a remote host (Settings → Ollama).
                </div>
              )}

              {/* Current setting won't fit — ONLY from a live measurement, which
                  reflects the real KV-cache quant. Never a static guess. */}
              {measured && suggested > 0 && targetCtx != null && targetCtx > suggested && (
                <div style={{ marginBottom: '8px', padding: '6px 8px', borderRadius: '3px', border: '1px solid var(--color-warning)', color: 'var(--color-warning)', lineHeight: 1.5 }}>
                  ⚠ Current num_ctx <strong>{targetCtx.toLocaleString()}</strong> exceeds the ~{suggested.toLocaleString()} that fits in VRAM — the model will spill to CPU/RAM (slow) or fail to load. SET TO FIT to right-size it.
                </div>
              )}

              {/* Context sizing, presented by how trustworthy the estimate is. */}
              {fit?.primary?.found ? (
                <div style={{ lineHeight: 1.6 }}>
                  <div>
                    {fit.primary.params ? `${fit.primary.params}B` : '?'} · {fit.primary.quant ?? '?'}
                    {fit.primary.contextMax ? ` · trained max ${fit.primary.contextMax.toLocaleString()}` : ''}
                  </div>
                  {measured && (
                    <>
                      <div>
                        Measured live at {(fit.primary.liveLoadedCtx ?? 0).toLocaleString()} ctx ({gib(fit.primary.liveSizeVramBytes ?? 0)} GB) → fits up to <strong style={{ color: 'var(--color-accent-primary)' }}>~{suggested.toLocaleString()}</strong> num_ctx
                        {reserved > 0 ? ` (after reserving ~${gib(reserved)} GB for the utility model)` : ''}.
                        {targetCtx ? ` Current: ${targetCtx.toLocaleString()}.` : ''}
                      </div>
                      <button
                        type="button"
                        onClick={setToFit}
                        disabled={!canSetFit}
                        className="display-font"
                        style={{ ...miniBtnStyle, marginTop: '6px', opacity: canSetFit ? 1 : 0.5, cursor: canSetFit ? 'pointer' : 'default' }}
                        title="Write this num_ctx into this tab's Ollama params. Takes effect next turn (re-prefills the prompt)."
                      >
                        {canSetFit ? `SET TO FIT (${suggested.toLocaleString()})` : 'AT FIT'}
                      </button>
                      <div style={{ fontSize: '10px', marginTop: '6px', lineHeight: 1.5 }}>
                        Derived from the model's actual VRAM right now{fit.kvCacheType ? ` (KV cache ${fit.kvCacheType})` : ''} — reflects your real KV-cache + flash-attention settings, no assumptions. SET TO FIT writes num_ctx to ADVANCED PARAMS; takes effect next turn.
                      </div>
                    </>
                  )}
                  {method === 'sliding-window' && (
                    <div style={{ marginTop: '2px' }}>
                      Sliding-window attention — KV cache stays small regardless of context, so context isn't the VRAM bottleneck. You can use the full trained window
                      {fit.primary.contextMax ? <> (<strong style={{ color: 'var(--color-accent-primary)' }}>{fit.primary.contextMax.toLocaleString()}</strong>)</> : null}
                      {targetCtx ? `; current ${targetCtx.toLocaleString()}.` : '.'} No need to cap — watch the VRAM bar above if you push it very high.
                    </div>
                  )}
                  {method === 'needs-load' && (
                    <div style={{ marginTop: '2px', fontStyle: 'italic' }}>
                      Run a turn on this tab to load the model, then reopen this — capacity is then measured from its actual VRAM (which reflects your KV-cache quant, so a static guess would be unreliable).
                      {fit.primary.contextMax ? ` Trained max ${fit.primary.contextMax.toLocaleString()}.` : ''}
                      {targetCtx ? ` Current: ${targetCtx.toLocaleString()}.` : ''}
                    </div>
                  )}
                  {method === 'unknown' && (
                    <div style={{ marginTop: '2px', fontStyle: 'italic' }}>
                      Couldn't measure or read enough metadata for a context estimate.
                      {fit.primary.contextMax ? ` Trained max ${fit.primary.contextMax.toLocaleString()}.` : ''} Set num_ctx to your need and watch the VRAM bar above.
                    </div>
                  )}
                </div>
              ) : (
                fit && <div style={{ fontStyle: 'italic' }}>Couldn't read enough metadata for <code style={{ fontFamily: 'var(--font-code)' }}>{primaryModel}</code> to size it (need /api/show details).</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const ollamaInputStyle: React.CSSProperties = {
  background: 'var(--color-bg-sunken)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary)',
  fontSize: '11px',
  letterSpacing: '0.5px',
  padding: '4px 6px',
  outline: 'none',
  fontFamily: 'var(--font-body)',
};

const selectStyle: React.CSSProperties = {
  background: 'var(--color-bg-sunken)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary)',
  fontSize: '11px',
  letterSpacing: '0.5px',
  padding: '3px 6px',
  outline: 'none',
  cursor: 'pointer',
};

function StaticRow({ k, v }: { k: string; v: string }) {
  return (
    <tr style={{ borderBottom: '1px solid var(--color-accent-primary-a05)' }}>
      <td
        className="display-font"
        style={{
          padding: '5px 8px 5px 0',
          color: 'var(--color-fg-muted)',
          fontSize: '10px',
          letterSpacing: '1.2px',
          whiteSpace: 'nowrap',
          verticalAlign: 'top',
        }}
      >
        {k}
      </td>
      <td
        style={{
          padding: '5px 0',
          color: 'var(--color-accent-primary)',
          wordBreak: 'break-all',
        }}
      >
        {v}
      </td>
    </tr>
  );
}

function CopyableRow({ k, v, copyValue }: { k: string; v: string; copyValue?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(copyValue ?? v).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <tr style={{ borderBottom: '1px solid var(--color-accent-primary-a05)' }}>
      <td
        className="display-font"
        style={{
          padding: '5px 8px 5px 0',
          color: 'var(--color-fg-muted)',
          fontSize: '10px',
          letterSpacing: '1.2px',
          whiteSpace: 'nowrap',
          verticalAlign: 'top',
        }}
      >
        {k}
      </td>
      <td style={{ padding: '5px 0' }}>
        <button
          onClick={copy}
          title={`Click to copy: ${copyValue ?? v}`}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            color: copied ? 'var(--color-accent-secondary)' : 'var(--color-accent-primary)',
            cursor: 'pointer',
            fontFamily: 'var(--font-body)',
            fontSize: '11px',
            wordBreak: 'break-all',
            textAlign: 'left',
          }}
        >
          {copied ? 'COPIED' : v}
        </button>
      </td>
    </tr>
  );
}
