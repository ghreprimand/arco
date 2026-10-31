import { MessageGuardControl } from '../ClusterRightPanel/MessageGuardControl';
import { CLUSTER_EFFICIENCY_CREATE_DEFAULT, CLUSTER_MESSAGE_GUARD_CREATE_DEFAULT, type ClusterMessageGuard, type ClusterTaskBoardMode, type ClusterProgressMode } from '@arco/shared';
import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useCodexCatalogFor } from '../../hooks/useCodexCatalog';
import { DEFAULT_CODEX_MODEL, PRIMARY_PROVIDERS, retiredProviderReason, presetForText, CLUSTER_EFFICIENCY_LEVELS, CLUSTER_EFFICIENCY_LABELS, CLUSTER_EFFICIENCY_ADDENDUM_MAX } from '@arco/shared';
import type { AuthLoginResult, ModelName, EffortLevel, SessionInfo, ProviderName, ArcoSettings, MemberTier, ClusterEfficiencyLevel, ClusterPreset, ClusterPresetMember, ClusterMemberProvider, WorkflowTemplate, WorkflowTemplateConfig } from '@arco/shared';
import { effortsForModel, clampEffortForProvider, clampEffortForModel } from '../../utils/format';
import { useClusterPresets } from '../../hooks/useClusterPresets';
import { useTemplates } from '../../hooks/useTemplates';
import { ClusterMembersSection } from './ClusterMembersSection';
import { CursorModelSelect } from '../CursorModelSelect';
import { LoginCommand } from '../LoginCommand';
import { ClusterPresetsRow } from './ClusterPresetsRow';
import { SavedClustersList } from '../SavedClustersList';
import { ExistingClustersList } from '../ExistingClustersList';
import { TemplatePickerRow } from './TemplatePickerRow';
import { PastChatsList } from './PastChatsList';
import { ProjectPicker } from './ProjectPicker';
import { DirectoryBrowser } from '../media/DirectoryPicker';
import { mintTemplateSpawnToken, registerPendingTemplateApply } from './pendingTemplateApply';
import { deriveDisplayNames, CLAUDE_MODELS,  CODEX_MODELS_UI_FALLBACK, MODELS, EFFORT_LABELS, FALLBACK_EFFORTS} from './modelOptions';
import type { Props, MemberDraft } from './types';

export function WorkflowCreator({ onCreate, onCreateCluster, onReopenCluster, initialProvider: suppliedProvider }: Props) {
  const [initialProvider] = useState(() => suppliedProvider ?? useAppStore.getState().creatorPrefill?.provider);
  const connected = useAppStore((s) => s.connected);
  const capabilities = useAppStore((s) => s.capabilities);
  const authStatus = useAppStore((s) => s.authStatus);
  const isProviderEnabled = useAppStore((s) => s.isProviderEnabled);
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const claudeNativeCatalog = useAppStore((s) => s.claudeNativeCatalog);
  // Hoisted above the Codex picker list (built at render-top) so that list is
  // scoped to the selected account profile's entitlements (HOME vs WORK).
  const wd = settings?.workflowDefaults;
  const [providerAccountRef, setProviderAccountRef] = useState<string | undefined>(wd?.providerAccountRef);
  const [codexLoginCommand, setCodexLoginCommand] = useState<string | null>(null);
  const codexCatalog = useCodexCatalogFor(providerAccountRef);
  const cursorCatalog = useAppStore((s) => s.cursorCatalog);
  const efforts: EffortLevel[] = capabilities?.efforts ?? FALLBACK_EFFORTS;
  // Live Codex picker list: prefer catalog, fall back to compile-time list
  // when catalog is empty (cold-start, app-server unavailable). Catalog
  // ships a one-line description per model that we surface as the subline.
  const codexModelsForPicker: { value: ModelName; label: string; subline?: string }[] = (() => {
    if (codexCatalog?.models?.length) {
      return codexCatalog.models
        .filter((m) => !m.hidden)
        .map((m) => ({
          value: m.id as ModelName,
          label: (m.displayName || m.id).toUpperCase(),
          subline: m.description || undefined,
        }));
    }
    return CODEX_MODELS_UI_FALLBACK;
  })();
  // Build the Claude picker from the live catalog when present (rich
  // labels + context-window subline). Falls back to the static aliases
  // when no Native auth has fetched a catalog yet.
  const claudeModelsForPicker: { value: ModelName; label: string; subline?: string }[] = (() => {
    if (claudeNativeCatalog?.models?.length) {
      return claudeNativeCatalog.models.map((m) => {
        const label = (m.displayName ?? m.id ?? '').replace(/^Claude\s+/, '').toUpperCase() || (m.id ?? 'UNKNOWN').toUpperCase();
        const ctxK = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K` : '?';
        const efforts = effortsForModel('claude', m.id as ModelName, claudeNativeCatalog, codexCatalog).join('/').toUpperCase() || 'NO EFFORT';
        return {
          value: (m.id ?? '') as ModelName,
          label,
          subline: `${ctxK} · ${efforts}`,
        };
      });
    }
    return CLAUDE_MODELS;
  })();
  const cursorModelsForPicker: { value: ModelName; label: string; subline?: string }[] = (() => {
    if (cursorCatalog?.models?.length) {
      return cursorCatalog.models.map((m) => ({
        value: m.id as ModelName,
        label: (m.displayName || m.id).toUpperCase(),
        subline: m.id,
      }));
    }
    return [{ value: 'auto' as ModelName, label: 'AUTO', subline: 'auto' }];
  })();
  const ollamaModelsForPicker: { value: ModelName; label: string; subline?: string }[] =
    (authStatus?.ollama?.installedModels ?? []).map((m) => ({ value: m as ModelName, label: m.toUpperCase(), subline: 'LOCAL · OLLAMA' }));
  const llamacppModelsForPicker: { value: ModelName; label: string; subline?: string }[] =
    (authStatus?.llamacpp?.installedModels ?? []).map((m) => ({ value: m as ModelName, label: m.toUpperCase(), subline: 'LOCAL · LLAMA.CPP' }));
  // LM Studio (M13) is a primary provider, not a cluster member, so its model
  // list is read inline in the MODEL picker below (from authStatus.lmstudio) —
  // no dedicated picker const needed here the way the cluster providers have.
  const clusterModelsForProvider = (provider: ClusterMemberProvider): { value: ModelName; label: string; subline?: string }[] => {
    if (provider === 'codex') return codexModelsForPicker;

    if (provider === 'ollama') return ollamaModelsForPicker;
    if (provider === 'llamacpp') return llamacppModelsForPicker;
    return claudeModelsForPicker;
  };
  const defaultClusterModelForProvider = (provider: ClusterMemberProvider): ModelName => {
    const first = clusterModelsForProvider(provider)[0]?.value;
    if (first) return first;
    if (provider === 'codex') return DEFAULT_CODEX_MODEL;

    if (provider === 'ollama' || provider === 'llamacpp') return '' as ModelName;
    return 'opus';
  };
  // Pull initial picker values from stored workflowDefaults so the operator
  // doesn't re-select their usual orchestrator / model / effort on every new
  // workflow. If settings hasn't arrived yet (cold-start), hardcoded fallbacks
  // kick in and a useEffect hydrates when settings lands. (`wd` and
  // providerAccountRef are hoisted above, near the catalog reads.)
  const [name, setName] = useState('');
  const [primaryProvider, setPrimaryProvider] = useState<ProviderName>(initialProvider ?? wd?.primaryProvider ?? 'claude');
  const [model, setModel] = useState<ModelName>(wd?.primaryModel ?? 'opus');
  const [effort, setEffort] = useState<EffortLevel>(wd?.primaryEffort ?? 'max');
  const [skipPermissions, setSkipPermissions] = useState(wd?.skipPermissions ?? true);
  const [fastMode, setFastMode] = useState(wd?.fastMode ?? false);
  // Efficiency/style defaults surfaced on the New-tab so the operator can
  // pick a default once. Tool filtering is Claude Native-only; output style
  // is honored by Claude Native, Codex app-server. Stored under
  // workflowDefaults regardless of the active provider so a transport flip
  // mid-tab picks supported values up automatically. Renamed `caveman` →
  // `terse` 2026-05-10 (see docs/PROVIDERS.md).
  const [efficiencyToolFilter, setEfficiencyToolFilter] = useState<'off' | 'conservative' | 'aggressive'>(wd?.efficiencyToolFilter ?? 'off');
  const [outputStyle, setOutputStyle] = useState<'normal' | 'lite' | 'terse'>(wd?.outputStyle ?? 'normal');
  // docs/PROVIDERS.md - start a tab already in sticky ultracode. Enabling it
  // auto-sets xhigh (mirrors `/effort ultracode`) and forces CLI at turn time.
  const [ultracode, setUltracode] = useState(false);

  // Re-clamp effort whenever the model or provider changes — picking max on
  // opus-4-6, then switching to sonnet (no max), would otherwise leave
  // effort=max with the picker hiding it. clampEffortForModel walks down to
  // the highest honored level for the new model.
  useEffect(() => {
    setEffort((prev) => clampEffortForModel(prev, primaryProvider, model, claudeNativeCatalog, codexCatalog));
  }, [primaryProvider, model, claudeNativeCatalog]);

  const providerAccounts = settings?.providerAccounts?.[primaryProvider === 'codex' ? 'codex' : primaryProvider === 'claude' ? 'claude' : 'codex'] ?? [];
  const visibleProviderAccounts = primaryProvider === 'codex' ? providerAccounts : [];
  const codexAccounts = settings?.providerAccounts?.codex ?? [];
  useEffect(() => {
    if (primaryProvider !== 'codex') {
      setProviderAccountRef(undefined);
      return;
    }
    const accounts = settings?.providerAccounts?.codex ?? [];
    if (accounts.length === 0) {
      setProviderAccountRef(undefined);
      return;
    }
    setProviderAccountRef((prev) => accounts.some((a) => a.id === prev) ? prev : accounts[0]?.id);
  }, [primaryProvider, settings?.providerAccounts?.codex]);

  // Hydrate picker state from stored defaults when settings arrives after
  // the component has already mounted (cold-start race). Ref-guarded so a
  // mid-edit settings refresh can't clobber the operator's in-progress picks.
  const appliedDefaultsRef = useRef(wd !== undefined);
  useEffect(() => {
    if (appliedDefaultsRef.current) return;
    if (!settings?.workflowDefaults) return;
    const d = settings.workflowDefaults;
    if (d.primaryProvider && !initialProvider) setPrimaryProvider(d.primaryProvider);
    if (d.primaryModel) setModel(d.primaryModel);
    if (d.primaryEffort) setEffort(d.primaryEffort);
    if (d.providerAccountRef) setProviderAccountRef(d.providerAccountRef);
    if (d.skipPermissions !== undefined) setSkipPermissions(d.skipPermissions);
    if (d.fastMode !== undefined) setFastMode(d.fastMode);
    if (d.efficiencyToolFilter !== undefined) setEfficiencyToolFilter(d.efficiencyToolFilter);
    if (d.outputStyle !== undefined) setOutputStyle(d.outputStyle);
    appliedDefaultsRef.current = true;
  }, [settings]);

  const activeModelOptions: { value: ModelName; label: string; subline?: string }[] | null = (() => {
    if (!PRIMARY_PROVIDERS.includes(primaryProvider) || primaryProvider === 'cursor') return null;

    if (primaryProvider === 'codex') return codexModelsForPicker;

    if (primaryProvider === 'ollama') return ollamaModelsForPicker;
    if (primaryProvider === 'llamacpp') return llamacppModelsForPicker;
    if (primaryProvider === 'strata' || primaryProvider === 'deepseek') {
      return (authStatus?.[primaryProvider]?.installedModels ?? []).map((m) => ({ value: m as ModelName, label: authStatus?.[primaryProvider]?.installedModelLabels?.[m] ?? m }));
    }
    if (primaryProvider === 'lmstudio') {
      return (authStatus?.lmstudio?.installedModels ?? []).map((m) => ({ value: m as ModelName, label: m }));
    }
    return claudeModelsForPicker;
  })();

  // 2026-07-28 incident — an HTML <select> whose `value` matches no <option>
  // renders the FIRST option while state keeps the unmatched value, and no
  // onChange ever fires to reconcile them. An operator whose stored default was
  // the `opus` family alias saw "OPUS 5 — 1000K" selected and created the
  // workflow on `opus`, which 404s on the Native transport. Snap state to what
  // is actually displayed so the picker can't disagree with itself. Runs after
  // the defaults hydrate above, so a stale stored default self-heals.
  useEffect(() => {
    if (!activeModelOptions || activeModelOptions.length === 0) return;
    if (activeModelOptions.some((m) => String(m.value) === String(model))) return;
    setModel(activeModelOptions[0].value);
  }, [activeModelOptions, model]);

  // Save-as-defaults affordance — persists the current picker state to
  // ~/.arco/settings.json under `workflowDefaults` so the next workflow
  // pre-selects the same orchestrator / model / effort / toggles.
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [defaultsSavedAt, setDefaultsSavedAt] = useState<number | null>(null);
  const saveAsDefaults = async () => {
    if (savingDefaults) return;
    setSavingDefaults(true);
    const patch: Partial<ArcoSettings> = {
      workflowDefaults: {
        primaryProvider,
        primaryModel: model,
        primaryEffort: effort,
        ...(primaryProvider === 'codex' && providerAccountRef ? { providerAccountRef } : {}),
        skipPermissions,
        fastMode,
        efficiencyToolFilter,
        outputStyle,
      },
    };
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json() as ArcoSettings;
      setSettings(data);
      setDefaultsSavedAt(Date.now());
    } catch { /* silently fail; next click retries */ }
    finally { setSavingDefaults(false); }
  };

  // 2026-05-11 — top-of-form mode toggle. Picks whether the +NEW form
  // creates a single workflow (legacy behaviour, default) or a cluster of
  // N fresh workers (new path). State is component-local; flipping does
  // NOT reset the shared fields (cwd / defaults stay).
  // Home pre-fill (mode/project/session) is read for the initial state here
  // and cleared once in the effect below; nothing launches by itself.
  const [mode, setMode] = useState<'single' | 'chat' | 'cluster' | 'genesis'>(() => useAppStore.getState().creatorPrefill?.mode ?? 'single');
  const [incognito, setIncognito] = useState(false);
  // docs/ARCHITECTURE.md - Genesis mode collects just a working name + the
  // Spark at creation; the staged conversation + the GENESIS right-panel tab
  // fill the rest of the seed. No working directory: the workflow is created
  // cwd-less and the server runs it in a scratch ideation dir until scaffold.
  const [spark, setSpark] = useState('');
  // 2026-05-11 — cluster-only optional name (≤64; empty = derived default).
  const [clusterName, setClusterName] = useState('');
  // 2026-06-15 — per-cluster efficiency level chosen at create time (cluster-
  // wide, not per-member). New creation uses Balanced independently of the
  // message guard; the optional NOTE appends to the generated policy.
  const [clusterEfficiency, setClusterEfficiency] = useState<ClusterEfficiencyLevel>(CLUSTER_EFFICIENCY_CREATE_DEFAULT);
  const [clusterEfficiencyNote, setClusterEfficiencyNote] = useState('');
  const [messageGuard, setMessageGuard] = useState<ClusterMessageGuard>({ ...CLUSTER_MESSAGE_GUARD_CREATE_DEFAULT });
  const [clusterBoard, setClusterBoard] = useState<ClusterTaskBoardMode>('cluster');
  const [clusterProgress, setClusterProgress] = useState<ClusterProgressMode>('both');
  // 2026-05-11 — cluster member draft list. Lazy-initialized to 2 rows
  // (the minimum to submit) the first time CLUSTER mode is opened.
  const [members, setMembers] = useState<MemberDraft[]>([]);
  // 2026-05-11 — cluster presets (operator-saved member templates). The
  // PRESETS row above the DEFAULT FOR NEW MEMBERS banner shows pills for
  // each saved shape; clicking a pill overwrites `members` (and `clusterName`
  // when blank). Cwd is intentionally NOT part of the preset surface — the
  // operator picks cwd independently each time.
  const clusterPresets = useClusterPresets();
  const [presetSaveOpen, setPresetSaveOpen] = useState(false);
  const [presetSaveName, setPresetSaveName] = useState('');
  const [presetSaveError, setPresetSaveError] = useState('');
  const [presetSavingBusy, setPresetSavingBusy] = useState(false);

  // §D4 — single-workflow templates ("recipes"). TEMPLATES row above the form
  // in SINGLE mode mirrors the cluster PRESETS row: pills apply a saved config
  // snapshot (provider/model/effort/permissions + optional cwd + optional
  // seedPrompt/plan); save captures the current creator config.
  const templates = useTemplates();
  const [tmplSaveOpen, setTmplSaveOpen] = useState(false);
  const [tmplSaveName, setTmplSaveName] = useState('');
  const [tmplSaveError, setTmplSaveError] = useState('');
  const [tmplSavingBusy, setTmplSavingBusy] = useState(false);
  // Set by applyTemplate so the deferred seedPrompt/plan land on the next tab
  // this creator mints. Drained when handleCreate threads it onto the spawn.
  const pendingTemplateRef = useRef<{ seedPrompt?: string; plan?: string } | null>(null);
  // 2026-05-11 — 2-col layout breakpoint. ≥1200px viewport => 2 columns,
  // otherwise single column (existing behaviour). Matched via matchMedia
  // rather than a CSS file so all styling stays inline + theme-token-driven.
  const [isWide, setIsWide] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 1200px)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(min-width: 1200px)');
    const handler = (e: MediaQueryListEvent) => setIsWide(e.matches);
    // Older Safari uses addListener / removeListener; modern browsers ship
    // addEventListener('change'). Use the modern API only — Arco targets
    // recent Chromium/Firefox/Safari.
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  // Advanced options
  const [showAdvanced, setShowAdvanced] = useState(false);
  // I5 — RUN OPTIONS band collapse (default expanded so nothing hides on first
  // paint) + working-directory tree collapse (Browse toggle, default open).
  const [showRunOptions, setShowRunOptions] = useState(true);
  // Folder tree stays collapsed: the project list above it is the primary pick.
  const [showBrowser, setShowBrowser] = useState(false);
  const [additionalDirsRaw, setAdditionalDirsRaw] = useState('');
  const [fallbackModel, setFallbackModel] = useState<ModelName | ''>('');

  // Working directory
  const [workDir, setWorkDir] = useState(() => {
    const prefill = useAppStore.getState().creatorPrefill;
    return prefill && prefill.mode !== 'chat' && prefill.mode !== 'genesis' ? prefill.workDir ?? '' : '';
  });
  const [browserPath, setBrowserPath] = useState('');
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(undefined);
  const [conversationMode, setConversationMode] = useState<'new' | 'resume'>('new');

  // Load sessions when workDir changes
  useEffect(() => {
    if (workDir) {
      fetchSessions(workDir);
      if (!name) setName(workDir.split('/').pop() || '');
    }
  }, [workDir]);

  async function fetchSessions(path: string): Promise<SessionInfo[]> {
    setSessionsLoading(true);
    try {
      const res = await fetch(`/api/sessions?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      const list: SessionInfo[] = Array.isArray(data.sessions) ? data.sessions : [];
      setSessions(list);
      if (list.length === 0) {
        setConversationMode('new');
        setSelectedSessionId(undefined);
      }
      return list;
    } catch {
      setSessions([]);
      return [];
    } finally {
      setSessionsLoading(false);
    }
  }

  const openResumeMode = () => {
    setConversationMode('resume');
    if (workDir) void fetchSessions(workDir);
  };

  // Selecting a session pins the provider to the session's CLI so
  // `--resume <uuid>` targets the right binary. Effort stays operator-chosen
  // (it's per-turn on every provider). Model would ideally stay fixed too,
  // but the CLIs accept a new -m on resume and it's handy for model-swap
  // experiments — leave it editable with the selected session's provider
  // narrowing the dropdown automatically.
  const selectSession = (s: SessionInfo) => {
    setSelectedSessionId(s.sessionId);
    if (s.providerAccountRef) setProviderAccountRef(s.providerAccountRef);
    if (s.provider !== primaryProvider) {
      setPrimaryProvider(s.provider);
      if (s.provider === 'claude') setModel(claudeModelsForPicker[0]?.value ?? 'opus');
      if (s.provider === 'codex') setModel(DEFAULT_CODEX_MODEL);


      setEffort(clampEffortForProvider(effort, s.provider));
    }
    if (s.arcoName && !name) setName(s.arcoName);
  };

  // Apply the rest of a Home pre-fill once: the folder listing, chat-capable
  // provider, and the chosen saved session selected in RESUME.
  useEffect(() => {
    const prefill = useAppStore.getState().takeCreatorPrefill();
    if (!prefill) return;

    const dir = prefill.mode === 'single' || prefill.mode === 'cluster' ? prefill.workDir : undefined;
    if (dir) setBrowserPath(dir);
    if (dir && prefill.resumeSessionId) {
      setConversationMode('resume');
      void fetchSessions(dir).then((list) => {
        const found = list.find((x) => x.sessionId === prefill.resumeSessionId);
        if (found) selectSession(found);
        else setConversationMode('new');
      });
    }
    // Mount-time only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draftFromDefaults = (): MemberDraft => {
    const provider: ClusterMemberProvider =
      primaryProvider === 'codex' || primaryProvider === 'ollama' || primaryProvider === 'llamacpp'
        ? primaryProvider
        : 'claude';
    const fallbackModel: ModelName = defaultClusterModelForProvider(provider);
    const isFencedModel = provider === primaryProvider;
    const m: ModelName = isFencedModel ? model : fallbackModel;
    const effortClamped = clampEffortForModel(effort, provider, m, claudeNativeCatalog, codexCatalog);
    return {
      key: crypto.randomUUID(),
      provider,
      model: m,
      effort: effortClamped,
      providerAccountRef: provider === 'codex' ? providerAccountRef : undefined,
      displayName: '',
      role: '',
      tier: '',
      focus: '',
      skipPermissions,
      fastMode,
      efficiencyToolFilter,
      outputStyle,
      expanded: false,
    };
  };

  // 2026-05-11 — first time the operator flips to CLUSTER mode, seed two
  // default rows so the form is immediately submittable after picking a cwd.
  // Subsequent flips back/forth preserve whatever they had built.
  useEffect(() => {
    if (mode === 'cluster' && members.length === 0) {
      setMembers([draftFromDefaults(), draftFromDefaults()]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const addMember = () => {
    setMembers((prev) => [...prev, draftFromDefaults()]);
  };
  const removeMember = (key: string) => {
    setMembers((prev) => prev.filter((m) => m.key !== key));
  };
  const updateMember = (key: string, patch: Partial<MemberDraft>) => {
    setMembers((prev) => prev.map((m) => {
      if (m.key !== key) return m;
      const next = { ...m, ...patch };
      // Re-clamp effort whenever provider or model changes from inside the
      // row editor (mirrors the top-level useEffect on primaryProvider/model).
      if (patch.provider !== undefined || patch.model !== undefined) {
        next.effort = clampEffortForModel(next.effort, next.provider, next.model, claudeNativeCatalog, codexCatalog);
      }
      return next;
    }));
  };

  const supportedProvider = PRIMARY_PROVIDERS.includes(primaryProvider);
  const canLaunch = supportedProvider && connected && workDir && (conversationMode !== 'resume' || Boolean(selectedSessionId));
  const canLaunchChat = supportedProvider && connected && Boolean(model && String(model).trim()) && (!incognito || (primaryProvider !== 'cursor' && primaryProvider !== 'llamacpp' && primaryProvider !== 'strata' && primaryProvider !== 'deepseek'));
  const clusterSubmitProblems = (() => {
    if (mode !== 'cluster') return [] as string[];
    const problems: string[] = [];
    if (!workDir) problems.push('Pick a working directory.');
    if (members.length < 2) problems.push('Cluster needs at least 2 members.');
    const localCount = members.filter((m) => m.provider === 'ollama' || m.provider === 'llamacpp').length;
    if (localCount > 1) problems.push('Use at most one local member; local turns are serialized on this machine.');
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      if (!m.model || String(m.model).trim().length === 0) {
        problems.push(`Member #${i + 1}: pick a model.`);
      }
    }
    return problems;
  })();
  const canLaunchCluster = connected && clusterSubmitProblems.length === 0;
  // Genesis launches with no cwd — gate on a working name + a Spark instead.
  const canLaunchGenesis = supportedProvider && connected && name.trim().length > 0 && spark.trim().length > 0;

  // 2026-05-11 — apply a saved preset: overwrite the MEMBERS list and
  // (if the operator hasn't typed a cluster name yet) seed clusterName from
  // the preset's optional template. Cwd is NEVER touched — presets are
  // project-agnostic by design. Each member from the preset spawns a fresh
  // MemberDraft (new react key, collapsed). Models stored in the preset are
  // applied as-is; if a model has since been renamed in the live catalog
  // the cluster-create path's apply-time validation will flag it.
  const applyPreset = (preset: ClusterPreset) => {
    const drafts: MemberDraft[] = preset.members.map((m) => ({
      key: crypto.randomUUID(),
      provider: m.provider,
      model: m.model as ModelName,
      effort: (m.effort as EffortLevel) ?? 'medium',
      providerAccountRef: m.provider === 'codex' ? m.providerAccountRef : undefined,
      displayName: m.displayName ?? '',
      role: m.role ?? '',
      tier: (m.tier as MemberTier | undefined) ?? '',
      focus: m.focus ?? '',
      skipPermissions: m.skipPermissions ?? skipPermissions,
      fastMode: m.fastMode ?? false,
      efficiencyToolFilter: m.efficiencyToolFilter ?? 'off',
      outputStyle: m.outputStyle ?? 'normal',
      expanded: false,
    }));
    setMembers(drafts);
    if (preset.clusterNameTemplate && clusterName.trim().length === 0) {
      setClusterName(preset.clusterNameTemplate.slice(0, 64));
    }
  };

  const deletePresetWithConfirm = async (preset: ClusterPreset) => {
    if (!window.confirm(`Delete preset "${preset.name}"?`)) return;
    try {
      await clusterPresets.delete(preset.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  };

  // Save the current cluster-mode form state as a new preset. Strips runtime-
  // only fields (key, expanded) and skips empty optional strings so the on-
  // disk shape stays minimal. CLUSTER NAME → clusterNameTemplate when non-
  // empty. Mirrors the gating used by the CREATE CLUSTER button.
  const saveCurrentAsPreset = async () => {
    const name = presetSaveName.trim();
    if (!name) {
      setPresetSaveError('Name required.');
      return;
    }
    if (members.length < 2) {
      setPresetSaveError('Need at least 2 members.');
      return;
    }
    setPresetSavingBusy(true);
    setPresetSaveError('');
    const derived = deriveDisplayNames(members);
    const presetMembers: ClusterPresetMember[] = members.map((m, i) => ({
      provider: m.provider,
      model: String(m.model),
      ...(m.effort ? { effort: m.effort } : {}),
      ...(m.provider === 'codex' && m.providerAccountRef ? { providerAccountRef: m.providerAccountRef } : {}),
      displayName: derived[i]!,
      ...(m.role.trim().length > 0 ? { role: m.role.trim() } : {}),
      ...(m.tier ? { tier: m.tier } : {}),
      ...(m.focus.trim().length > 0 ? { focus: m.focus.trim() } : {}),
      skipPermissions: m.skipPermissions,
      ...(m.fastMode ? { fastMode: true } : {}),
      ...(m.efficiencyToolFilter !== 'off' ? { efficiencyToolFilter: m.efficiencyToolFilter } : {}),
      ...(m.outputStyle !== 'normal' ? { outputStyle: m.outputStyle } : {}),
    }));
    try {
      await clusterPresets.save({
        name,
        ...(clusterName.trim().length > 0 ? { clusterNameTemplate: clusterName.trim() } : {}),
        members: presetMembers,
      });
      setPresetSaveOpen(false);
      setPresetSaveName('');
    } catch (err) {
      setPresetSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setPresetSavingBusy(false);
    }
  };

  // §D4 — apply a saved template: pre-fill provider/model/effort/permissions +
  // any captured native knobs. cwd pre-fills ONLY when the template baked one
  // in (project-pinned recipe); otherwise the operator's current cwd is left
  // untouched (portable recipe). Model is applied as-is — if it's been renamed
  // in the live catalog the picker below will reject the now-unknown value and
  // the operator re-picks (apply-time validation, mirrors cluster presets).
  // seedPrompt/plan are stashed for the NEXT create (composer + plan pre-fill,
  // never auto-sent).
  const applyTemplate = (t: WorkflowTemplate) => {
    const c = t.config;
    const provider: ProviderName = c.primaryProvider ?? 'claude';
    setPrimaryProvider(provider);
    setModel(c.primaryModel);
    setEffort(clampEffortForModel(c.primaryEffort, provider, c.primaryModel, claudeNativeCatalog, codexCatalog));
    setProviderAccountRef(provider === 'codex' ? c.providerAccountRef : undefined);
    setSkipPermissions(c.skipPermissions);
    setFastMode(c.fastMode ?? false);
    setEfficiencyToolFilter(c.efficiencyToolFilter ?? 'off');
    setOutputStyle(c.outputStyle ?? 'normal');
    if (c.workingDirectory) setWorkDir(c.workingDirectory);
    pendingTemplateRef.current = (t.seedPrompt || t.plan)
      ? { ...(t.seedPrompt ? { seedPrompt: t.seedPrompt } : {}), ...(t.plan ? { plan: t.plan } : {}) }
      : null;
  };

  const deleteTemplateWithConfirm = async (t: WorkflowTemplate) => {
    if (!window.confirm(`Delete template "${t.name}"?`)) return;
    try {
      await templates.delete(t.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  };

  // Save the current SINGLE-mode form as a template. Captures the config subset
  // (provider/model/effort/permissions + native knobs + current cwd). The
  // creator has no composer/plan field, so seedPrompt/plan are not captured
  // here — the apply path supports them for templates authored elsewhere.
  const saveCurrentAsTemplate = async () => {
    const tn = tmplSaveName.trim();
    if (!tn) {
      setTmplSaveError('Name required.');
      return;
    }
    setTmplSavingBusy(true);
    setTmplSaveError('');
    const config: WorkflowTemplateConfig = {
      ...(primaryProvider !== 'claude' ? { primaryProvider } : {}),
      primaryModel: model,
      primaryEffort: effort,
      skipPermissions,
      ...(workDir ? { workingDirectory: workDir } : {}),
      ...(primaryProvider === 'codex' && providerAccountRef ? { providerAccountRef } : {}),
      ...(fastMode ? { fastMode: true } : {}),
      ...(efficiencyToolFilter !== 'off' ? { efficiencyToolFilter } : {}),
      ...(outputStyle !== 'normal' ? { outputStyle } : {}),
    };
    try {
      await templates.save({ name: tn, config });
      setTmplSaveOpen(false);
      setTmplSaveName('');
    } catch (err) {
      setTmplSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setTmplSavingBusy(false);
    }
  };

  const handleCreate = () => {
    if (mode === 'cluster') {
      if (!canLaunchCluster || !onCreateCluster) return;
      const derived = deriveDisplayNames(members);
      onCreateCluster({
        cwd: workDir,
        ...(clusterName.trim().length > 0 ? { name: clusterName.trim() } : {}),
        efficiencyLevel: clusterEfficiency,
        messageGuard,
        taskBoardMode: clusterBoard,
        progressTracking: clusterProgress,
        ...(clusterEfficiencyNote.trim().length > 0 ? { efficiencyAddendum: clusterEfficiencyNote.trim() } : {}),
        members: members.map((m, i) => ({
          provider: m.provider,
          model: String(m.model),
          ...(m.effort ? { effort: m.effort } : {}),
          ...(m.provider === 'codex' && m.providerAccountRef ? { providerAccountRef: m.providerAccountRef } : {}),
          displayName: derived[i]!,
          ...(m.role.trim().length > 0 ? { role: m.role.trim() } : {}),
          ...(m.tier ? { tier: m.tier } : {}),
          ...(m.focus.trim().length > 0 ? { focus: m.focus.trim() } : {}),
          skipPermissions: m.skipPermissions,
          ...(m.fastMode ? { fastMode: true } : {}),
          ...(m.efficiencyToolFilter !== 'off' ? { efficiencyToolFilter: m.efficiencyToolFilter } : {}),
          ...(m.outputStyle !== 'normal' ? { outputStyle: m.outputStyle } : {}),
        })),
      });
      return;
    }
    if (mode === 'genesis') {
      if (!canLaunchGenesis) return;
      // Cwd-less create: the server assigns a scratch ideation dir and echoes
      // it back. genesisSeed rides the config (its durable home until scaffold).
      onCreate({
        name: name.trim(),
        ...(primaryProvider !== 'claude' && { primaryProvider }),
        primaryModel: model,
        primaryEffort: effort,
        skipPermissions,
        workingDirectory: '',
        genesisSeed: { title: name.trim(), spark: spark.trim(), concept: '', theCase: '', buildDirection: '' },
        ...(fastMode && { fastMode: true }),
        ...(providerAccountRef ? { providerAccountRef } : {}),
        ...(efficiencyToolFilter !== 'off' && { efficiencyToolFilter }),
        ...(outputStyle !== 'normal' && { outputStyle }),
      });
      return;
    }
    if (mode === 'chat') {
      if (!canLaunchChat) return;
      onCreate({
        kind: 'chat',
        name: name.trim() || 'New chat',
        ...(primaryProvider !== 'claude' && { primaryProvider }),
        primaryModel: model,
        primaryEffort: effort,
        skipPermissions: false,
        workingDirectory: '',
        ...(incognito ? { incognito: true } : {}),
        ...(providerAccountRef ? { providerAccountRef } : {}),
        ...(outputStyle !== 'normal' && { outputStyle }),
      });
      return;
    }
    if (!canLaunch) return;

    const additionalDirectories = additionalDirsRaw
      .split(/[,\n]/)
      .map((d) => d.trim())
      .filter(Boolean);
    const advanced = {
      ...(additionalDirectories.length > 0 && { additionalDirectories }),
      ...(fallbackModel && { fallbackModel }),
    };
    const hasAdvanced = Object.keys(advanced).length > 0;

    const selectedSession = conversationMode === 'resume'
      ? sessions.find((s) => s.sessionId === selectedSessionId)
      : undefined;
    // §D4 — if an applied template stashed a seedPrompt/plan, mint a one-shot
    // spawn token and register the deferred apply; the workflow_created handler
    // drains it onto the real workflow id (composer + plan pre-fill, never
    // auto-sent). Cleared after one create so it never leaks onto a later tab.
    const pendingTmpl = pendingTemplateRef.current;
    let templateSpawnToken: string | undefined;
    if (pendingTmpl) {
      templateSpawnToken = mintTemplateSpawnToken();
      registerPendingTemplateApply(templateSpawnToken, pendingTmpl);
      pendingTemplateRef.current = null;
    }
    onCreate({
      name: name.trim() || workDir.split('/').pop() || 'Untitled',
      ...(primaryProvider !== 'claude' && { primaryProvider }),
      primaryModel: model,
      primaryEffort: effort,
      skipPermissions,
      workingDirectory: workDir,
      ...(templateSpawnToken ? { templateSpawnToken } : {}),
      resumeSessionId: selectedSession && !selectedSession.arcoInternal ? selectedSession.sessionId : undefined,
      resumeWorkflowId: selectedSession?.arcoInternal ? selectedSession.arcoWorkflowId : undefined,
      ...(fastMode && { fastMode: true }),
      ...(providerAccountRef ? { providerAccountRef } : {}),
      // Efficiency/style knobs — only stamp on the new workflow when
      // non-default (so a `normal` / `off` pick stays absent from meta.json
      // and the server's cascade defaults apply). Stored regardless of
      // provider so transport/provider changes still see supported values.
      ...(efficiencyToolFilter !== 'off' && { efficiencyToolFilter }),
      ...(outputStyle !== 'normal' && { outputStyle }),
      // docs/PROVIDERS.md - only claude can host the WorkflowTool; stamp the
      // sticky flag so the tab starts in ultracode (turnEngine forces CLI).
      ...(ultracode && primaryProvider === 'claude' && { ultracode: true }),
      ...(hasAdvanced && { advanced }),
    });
  };

  const selectStyle = (selected: boolean) => ({
    padding: '7px 14px',
    border: `1px solid ${selected ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
    borderRadius: '4px',
    background: selected ? 'var(--color-accent-primary-a10)' : 'transparent',
    color: selected ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
    cursor: 'pointer' as const,
    fontFamily: 'var(--font-display)',
    fontSize: '11px',
    letterSpacing: '1px',
    transition: 'all 0.2s ease',
  });

  const labelStyle = {
    fontSize: '11px',
    letterSpacing: '2px',
    color: 'var(--color-accent-primary-dim)',
    display: 'block' as const,
    marginBottom: '6px',
  };

  const inputStyle = {
    width: '100%',
    padding: '8px 12px',
    background: 'var(--color-bg-sunken)',
    border: '1px solid var(--color-border-hairline)',
    borderRadius: '4px',
    color: 'var(--color-accent-primary)',
    fontFamily: 'var(--font-body)',
    fontSize: '13px',
    outline: 'none',
  };

  const hintStyle: React.CSSProperties = {
    fontSize: '9px',
    color: 'var(--color-fg-muted)',
    fontFamily: 'var(--font-display)',
    letterSpacing: '0.5px',
    marginTop: '4px',
  };

  // I5 — banded layout. The form is three bordered "band" cards (WHERE &
  // SESSION · AGENT · RUN OPTIONS), each with a header label and an internally
  // symmetric 2-col grid (1fr 1fr at ≥1200px, single column below). All three
  // share identical chrome so the stack reads as matched frames; greedy widgets
  // (dir tree, model grid) sit inside a band half so neither column towers over
  // an empty void the way the old single tall left column did. The mode toggle,
  // MEMBERS section, save-defaults + submit stay full-width regardless.
  const bandStyle: React.CSSProperties = {
    border: '1px solid var(--color-border-hairline)',
    borderRadius: '6px',
    padding: '16px 18px',
  };
  // Band titles outrank the field labels (which stay 11px dim) — bigger,
  // brighter, with a divider that splits each card's header from its content
  // so sections read as distinct blocks, not one continuous text stream.
  const bandHeaderStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '15px',
    letterSpacing: '4px',
    color: 'var(--color-accent-primary)',
    fontWeight: 400,
    marginBottom: '18px',
    paddingBottom: '12px',
    borderBottom: '1px solid var(--color-border-hairline)',
  };
  const bandGrid: React.CSSProperties = isWide
    ? { display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: '20px', rowGap: '16px', alignItems: 'start' }
    : { display: 'flex', flexDirection: 'column', gap: '16px' };
  const bandHalf: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 };
  // A band child that spans both columns (e.g. EFFORT under the model picker).
  const spanBoth: React.CSSProperties = isWide ? { gridColumn: '1 / -1' } : {};
  // Inner grid for the RUN OPTIONS knobs — each cell equal width (symmetry).
  const optionsGrid: React.CSSProperties = isWide
    ? { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', alignItems: 'start' }
    : { display: 'flex', flexDirection: 'column', gap: '16px' };

  // I4 — centered heading reflects the selected cwd's folder name (high-signal
  // token; the full path is in the field below). No cwd yet ⇒ show the subtitle
  // text alone, never a stale "ARCO" (the wordmark already lives top-left).
  const subtitleText = mode === 'cluster' ? 'NEW CLUSTER' : mode === 'genesis' ? 'NEW PROJECT · GENESIS' : mode === 'chat' ? 'NEW CONVERSATION' : 'NEW WORKFLOW';
  const cwdBasename = workDir.replace(/\/+$/, '').split('/').pop() ?? '';
  const headingText = cwdBasename.length > 28 ? `${cwdBasename.slice(0, 27)}…` : cwdBasename;
  const outputStyleProvider = primaryProvider === 'claude' || primaryProvider === 'codex';
  // Collapsed tuning summary so the config stays visible but quiet.
  // Claude has fast/filter/style; Codex app-server honor style only.
  const runOptionsSummary = primaryProvider === 'claude'
    ? `Fast ${fastMode ? 'on' : 'off'} · ${efficiencyToolFilter} · ${outputStyle}`
    : `Output ${outputStyle}`;

  // Per-row pill style for the SINGLE / CLUSTER mode toggle. Reuses the
  // existing selectStyle palette so the pills look like the other pickers.
  const modePill = (selected: boolean): React.CSSProperties => ({
    ...selectStyle(selected),
    flex: 1,
    textAlign: 'center',
    padding: '8px 10px',
  });

  return (
    <div style={{ overflowY: 'auto', padding: '24px 40px', display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: isWide ? '1100px' : '560px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div style={{ textAlign: 'center', marginBottom: '4px' }}>
          <h1 className="display-font glow-text-bright" style={{ fontSize: '28px', letterSpacing: '6px', fontWeight: 400, marginBottom: '4px', wordBreak: 'break-word' }} title={workDir || undefined}>
            {headingText || subtitleText}
          </h1>
          {headingText && (
            <p className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '12px', letterSpacing: '2px' }}>
              {subtitleText}
            </p>
          )}
        </div>

        {/* 2026-05-11 — top-of-form mode toggle. SINGLE = legacy single-workflow
            creation. CLUSTER = mint N fresh members at once, configured per-row
            below. Defaults to SINGLE; flipping does not reset shared fields. */}
        <div data-help="creator.cluster-mode">
          <label className="display-font" style={labelStyle}>MODE</label>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={() => setMode('single')} style={modePill(mode === 'single')}>
              <div>SINGLE WORKFLOW</div>
              <div style={{ fontSize: '9px', marginTop: '3px', opacity: 0.7 }}>One primary agent</div>
            </button>
            <button data-help="creator.chat-mode" onClick={() => {
              setMode('chat');

            }} style={modePill(mode === 'chat')}>
              <div>CHAT</div>
              <div style={{ fontSize: '9px', marginTop: '3px', opacity: 0.7 }}>Conversation, no project</div>
            </button>
            <button onClick={() => setMode('cluster')} style={modePill(mode === 'cluster')}>
              <div>CLUSTER</div>
              <div style={{ fontSize: '9px', marginTop: '3px', opacity: 0.7 }}>N members, shared cwd</div>
            </button>
            <button onClick={() => setMode('genesis')} style={modePill(mode === 'genesis')}>
              <div>GENESIS</div>
              <div style={{ fontSize: '9px', marginTop: '3px', opacity: 0.7 }}>Idea → scaffold, no folder yet</div>
            </button>
          </div>
        </div>

        {mode === 'cluster' && (
          <ClusterPresetsRow
            presets={clusterPresets.presets}
            isLoading={clusterPresets.isLoading}
            error={clusterPresets.error}
            onApply={applyPreset}
            onDelete={deletePresetWithConfirm}
            saveDisabled={members.length < 2 || members.some((m) => !m.model || String(m.model).trim().length === 0)}
            saveOpen={presetSaveOpen}
            saveName={presetSaveName}
            saveError={presetSaveError}
            saveBusy={presetSavingBusy}
            onSaveOpen={() => { setPresetSaveOpen(true); setPresetSaveError(''); setPresetSaveName(''); }}
            onSaveCancel={() => { setPresetSaveOpen(false); setPresetSaveError(''); setPresetSaveName(''); }}
            onSaveNameChange={(v) => { setPresetSaveName(v.slice(0, 64)); if (presetSaveError) setPresetSaveError(''); }}
            onSaveSubmit={saveCurrentAsPreset}
          />
        )}

        {mode === 'chat' && (
          <PastChatsList onReopen={(config) => onCreate(config)} />
        )}

        {/* SAVED CLUSTERS — restore a whole-cluster snapshot (config + members
            + full history) as a fresh cluster. Unlike presets (which fill the
            member form), restore mints the cluster server-side and it arrives
            via cluster_created. Passes the picked cwd as the restore target so
            the restored cluster lands where the operator is working (blank →
            the snapshot's original cwd). */}
        {mode === 'cluster' && (
          <>
            {onReopenCluster && <ExistingClustersList onReopen={onReopenCluster} />}
            <SavedClustersList targetCwd={workDir} />
          </>
        )}

        {mode === 'single' && (
          <TemplatePickerRow
            templates={templates.templates}
            isLoading={templates.isLoading}
            error={templates.error}
            onApply={applyTemplate}
            onDelete={deleteTemplateWithConfirm}
            saveDisabled={!model || String(model).trim().length === 0}
            saveOpen={tmplSaveOpen}
            saveName={tmplSaveName}
            saveError={tmplSaveError}
            saveBusy={tmplSavingBusy}
            onSaveOpen={() => { setTmplSaveOpen(true); setTmplSaveError(''); setTmplSaveName(''); }}
            onSaveCancel={() => { setTmplSaveOpen(false); setTmplSaveError(''); setTmplSaveName(''); }}
            onSaveNameChange={(v) => { setTmplSaveName(v.slice(0, 64)); if (tmplSaveError) setTmplSaveError(''); }}
            onSaveSubmit={saveCurrentAsTemplate}
          />
        )}

        {mode === 'cluster' && (
          <div
            className="display-font"
            style={{
              padding: '8px 12px',
              border: '1px solid var(--color-accent-secondary-dim)',
              borderRadius: '4px',
              color: 'var(--color-accent-secondary)',
              fontSize: '10px',
              letterSpacing: '0.5px',
              lineHeight: 1.5,
            }}
          >
            DEFAULT FOR NEW MEMBERS — Adding a member inherits these settings; expand the member row to override per-member.
          </div>
        )}

        {/* I5 Band 1 — WHERE & SESSION. Left half: working directory + tree.
            Right half: name + conversation. */}
        <div style={bandStyle}>
          <div className="display-font glow-text-bright" style={bandHeaderStyle}>{mode === 'genesis' ? 'THE IDEA' : mode === 'chat' ? 'CONVERSATION' : 'PROJECT & SESSION'}</div>
          <div style={bandGrid}>

        {/* Working directory — top-left cell (input only; the tree spans both
            columns below so neither cell towers over an empty void). Hidden in
            GENESIS mode: there is no folder yet (the server runs a scratch
            ideation dir until scaffold). */}
        {mode !== 'genesis' && mode !== 'chat' && (
        <div data-help="creator.cwd">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <label className="display-font" style={{ ...labelStyle, marginBottom: 0 }}>PROJECT FOLDER</label>
            <button onClick={() => setShowBrowser((v) => !v)} className="display-font" style={{ background: 'none', border: 'none', color: 'var(--color-accent-secondary-dim)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px' }}>
              {showBrowser ? 'Close folder browser' : 'Browse another folder'}
            </button>
          </div>
          <input
            type="text"
            value={workDir}
            onChange={(e) => setWorkDir(e.target.value)}
            placeholder="Pick a project below, or type a folder path"
            style={inputStyle}
          />
        </div>
        )}

        {mode === 'chat' && (
          <label data-help="creator.incognito" style={{ ...spanBoth, display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer', padding: '10px 12px', border: `1px solid ${incognito ? 'var(--color-accent-secondary)' : 'var(--color-border-hairline)'}`, borderRadius: '5px' }}>
            <input
              type="checkbox"
              checked={incognito}
              onChange={(e) => {
                const checked = e.target.checked;
                setIncognito(checked);
                if (checked && (primaryProvider === 'cursor' || primaryProvider === 'llamacpp')) {
                  setPrimaryProvider('claude');
                  setModel(claudeModelsForPicker[0]?.value ?? 'opus');
                }
              }}
              style={{ marginTop: '2px', accentColor: 'var(--color-accent-secondary)' }}
            />
            <span>
              <span className="display-font" style={{ display: 'block', color: incognito ? 'var(--color-accent-secondary)' : 'var(--color-fg-primary)', fontSize: '11px', letterSpacing: '1px' }}>INCOGNITO CHAT</span>
              <span style={{ display: 'block', marginTop: '4px', color: 'var(--color-fg-muted)', fontSize: '10px', lineHeight: 1.45 }}>
                Strict mode: Arco writes no transcript, metadata, operational log, notification, or worker registry entry. Closing or refreshing loses it, and it never appears in Past Chats. Provider-side API retention is governed by that provider.
              </span>
            </span>
          </label>
        )}

        {/* Workflow / cluster name — top-right cell, balancing the dir input. */}
        <div>
          <label data-help="creator.name" className="display-font" style={labelStyle}>
            {mode === 'cluster' ? 'CLUSTER NAME' : mode === 'genesis' ? 'WORKING NAME' : mode === 'chat' ? 'CHAT NAME' : 'WORKFLOW NAME'}
          </label>
          {mode === 'cluster' ? (
            <input
              type="text"
              value={clusterName}
              onChange={(e) => setClusterName(e.target.value.slice(0, 64))}
              placeholder="(optional, ≤64 chars — empty = derived default)"
              style={inputStyle}
            />
          ) : (
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={mode === 'genesis' ? 'e.g. PortWatch (rename anytime)' : mode === 'chat' ? 'New chat' : 'e.g. Code Review, Feature Build...'} style={inputStyle} />
          )}
        </div>

        {/* 2026-06-15 — cluster-wide efficiency level. One knob that dials how
            thorough vs. lean the whole cluster behaves (chunk size, cross-
            review restraint, peer chattiness). Changeable later from the
            cluster header chip. */}
        {mode === 'cluster' && (
          <div data-help="cluster.efficiency" style={spanBoth}>
            <label className="display-font" style={labelStyle}>EFFICIENCY</label>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {CLUSTER_EFFICIENCY_LEVELS.map((lvl) => {
                const active = lvl === clusterEfficiency;
                return (
                  <button
                    key={lvl}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setClusterEfficiency(lvl)}
                    className="display-font"
                    title={CLUSTER_EFFICIENCY_LABELS[lvl].blurb}
                    style={{
                      padding: '5px 10px',
                      background: active ? 'var(--color-accent-primary-a06)' : 'transparent',
                      border: '1px solid ' + (active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
                      color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                      cursor: 'pointer',
                      fontSize: '10px',
                      letterSpacing: '1px',
                    }}
                  >
                    {CLUSTER_EFFICIENCY_LABELS[lvl].label.toUpperCase()}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', marginTop: '4px' }}>
              {CLUSTER_EFFICIENCY_LABELS[clusterEfficiency].blurb}
            </div>
            <MessageGuardControl value={messageGuard} onChange={setMessageGuard} />
            <label className="arco-field-label" style={{ marginTop: 6, marginRight: 12 }}>Task board <select className="arco-field" aria-label="Cluster task board" value={clusterBoard} onChange={e => setClusterBoard(e.target.value as ClusterTaskBoardMode)}>
              <option value="cluster">Cluster-local</option><option value="project">Project</option><option value="none">None</option>
            </select></label>
            <label className="arco-field-label" style={{ marginTop: 6 }}>Keep current <select className="arco-field" aria-label="Keep current" value={clusterProgress} onChange={e => setClusterProgress(e.target.value as ClusterProgressMode)}>
              <option value="both">Both</option><option value="plan">Plan</option><option value="board">Board</option>
            </select></label>
            <input
              type="text"
              aria-label="Cluster NOTE"
              value={clusterEfficiencyNote}
              maxLength={CLUSTER_EFFICIENCY_ADDENDUM_MAX}
              onChange={(e) => setClusterEfficiencyNote(e.target.value)}
              placeholder="Optional note added to this cluster's coordination instructions"
              style={{ ...inputStyle, marginTop: '6px' }}
            />
          </div>
        )}

        {/* GENESIS — the Spark. Spans both columns; the only seed field collected
            at creation. The staged conversation + the GENESIS tab fill the rest. */}
        {mode === 'genesis' && (
          <div data-help="creator.genesis-spark" style={spanBoth}>
            <label className="display-font" style={labelStyle}>THE SPARK</label>
            <textarea
              value={spark}
              onChange={(e) => setSpark(e.target.value)}
              placeholder="The raw idea, in your own words — what sparked it, what it might do, what feels unresolved."
              rows={4}
              style={{ ...inputStyle, resize: 'vertical', minHeight: '88px', fontFamily: 'var(--font-body)' }}
            />
            <div style={hintStyle}>No folder yet — Genesis ideates in a scratch space, then CREATE &amp; SCAFFOLD (in the GENESIS tab) builds the real project.</div>
          </div>
        )}

          {/* Flat project list, then the folder tree; both span both columns. */}
          {mode !== 'genesis' && mode !== 'chat' && (
            <ProjectPicker workDir={workDir} onPick={setWorkDir} onBrowseRoot={path => { setBrowserPath(path); setShowBrowser(true); }} />
          )}
          {mode !== 'genesis' && mode !== 'chat' && showBrowser && <div style={spanBoth}>
            <DirectoryBrowser inline withFilename={false} initialPath={browserPath || workDir || settings?.defaultWorkingDirectory || ''} roots={settings?.projectRoots} title="Browse another folder" confirmLabel="Use for this session" onDone={result => { if (result) { setWorkDir(result.dir); setBrowserPath(result.dir); setShowBrowser(false); } }} />
            <p style={hintStyle}>Browsing and selecting a folder do not bookmark it. Use Bookmark folder to keep it listed independently of project locations.</p>
          </div>}

        {/* Conversation mode — spans both columns. Unified resume picker:
            native providers resume by provider session id; Arco-managed
            providers (Ollama) resume by workflow id from events.jsonl. */}
        {mode !== 'chat' && workDir && (
          <div data-help="creator.resume" style={spanBoth}>
            <label className="display-font" style={labelStyle}>CONVERSATION</label>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
              <button onClick={() => setConversationMode('new')} style={{ ...selectStyle(conversationMode === 'new'), flex: 1, textAlign: 'center' }}>
                <div>NEW</div>
                <div style={{ fontSize: '9px', marginTop: '3px', opacity: 0.6 }}>Fresh conversation</div>
              </button>
              <button
                onClick={openResumeMode}
                style={{ ...selectStyle(conversationMode === 'resume'), flex: 1, textAlign: 'center' }}
              >
                <div>RESUME</div>
                <div style={{ fontSize: '9px', marginTop: '3px', opacity: 0.6 }}>
                  {sessionsLoading ? 'Loading…' : sessions.length > 0 ? `${sessions.length} session(s)` : 'No sessions'}
                </div>
              </button>
            </div>
            {conversationMode === 'resume' && sessionsLoading && sessions.length === 0 && (
              <div style={{ padding: '10px 12px', border: '1px solid var(--color-border-hairline)', borderRadius: '4px', color: 'var(--color-fg-muted)', fontSize: '11px', fontStyle: 'italic' }}>
                Loading sessions…
              </div>
            )}
            {conversationMode === 'resume' && sessions.length > 0 && (
              <div style={{ maxHeight: '200px', overflowY: 'auto', border: '1px solid var(--color-border-hairline)', borderRadius: '4px' }}>
                {sessions.map((s) => {
                  const active = selectedSessionId === s.sessionId;
                  const providerTag = s.arcoInternal
                    ? 'ARCO'
                    : s.providerAccountShortLabel
                      ? `${s.provider.toUpperCase()}:${s.providerAccountShortLabel}`
                      : s.provider.toUpperCase();
                  const arco = Boolean(s.arcoWorkflowId);
                  // Heading = the conversation's TOPIC, not the folder/workflow
                  // name. `s.name` is the content-derived title (ai-title → first
                  // user message for provider sessions; the recall title for
                  // Arco-internal ones), so prefer it over `arcoName` (which
                  // is just the cwd folder, e.g. "Limits" — identical across
                  // every session in that dir). Fall back to the workflow name,
                  // then the session id. No LLM — all deterministic on-disk data.
                  const title = s.name || s.arcoName || s.sessionId.slice(0, 8);
                  // Subtitle = "last activity": prefer the live "what am I doing
                  // right now" preview over the static ai-title (Claude writes
                  // ai-title at most once; many sessions never get one). Skip if
                  // it duplicates the primary title.
                  const candidate = s.lastUserPreview || s.aiTitle;
                  const subtitle = candidate && candidate !== title ? candidate : null;
                  const when = s.startedAt ? new Date(s.startedAt).toLocaleString() : '—';
                  return (
                    <button
                      key={`${s.provider}:${s.sessionId}`}
                      onClick={() => selectSession(s)}
                      style={{
                        display: 'block',
                        width: '100%',
                        padding: '6px 12px',
                        background: active ? 'var(--color-accent-primary-a08)' : 'transparent',
                        border: 'none',
                        borderBottom: '1px solid var(--color-accent-primary-a05)',
                        color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                        cursor: 'pointer',
                        fontFamily: 'var(--font-display)',
                        fontSize: '11px',
                        textAlign: 'left',
                        letterSpacing: '0.5px',
                      }}
                      title={`${s.sessionId} — ${providerTag} — ${when}`}
                    >
                      <div style={{ fontWeight: 'bold' }}>
                        [{providerTag}]{arco ? ' ★' : ''} {title}
                      </div>
                      {s.arcoName && s.arcoName !== title && <div style={{ fontSize: '10px', opacity: 0.8 }}>Workspace: {s.arcoName}</div>}
                      {subtitle && (
                        <div style={{ fontSize: '10px', opacity: 0.8, marginTop: '2px', fontStyle: 'italic' }}>
                          {subtitle}
                        </div>
                      )}
                      <div style={{ fontSize: '10px', opacity: 0.7, marginTop: '2px' }}>
                        {when}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

          </div>
        </div>

        {!supportedProvider && <p role="alert">{retiredProviderReason(primaryProvider) ?? `Unsupported saved provider: ${primaryProvider}. Choose a supported provider explicitly.`}</p>}

        <div style={bandStyle}>
          <div className="display-font glow-text-bright" style={bandHeaderStyle}>{mode === 'cluster' ? 'MEMBER DEFAULTS' : mode === 'chat' ? 'CHAT MODEL' : 'AGENT'}</div>
          <div style={bandGrid}>
            <div style={bandHalf}>


        {authStatus && ((isProviderEnabled('claude') && authStatus.claude.loggedIn) || (isProviderEnabled('codex') && authStatus.codex.loggedIn) || (isProviderEnabled('cursor') && authStatus.cursor?.loggedIn)  || (isProviderEnabled('ollama') && authStatus.ollama.loggedIn) || (isProviderEnabled('llamacpp') && authStatus.llamacpp?.loggedIn) || (isProviderEnabled('deepseek') && authStatus.deepseek?.loggedIn) || (isProviderEnabled('strata') && authStatus.strata?.loggedIn) || (isProviderEnabled('lmstudio') && authStatus.lmstudio?.loggedIn)) && (
          <div data-help="creator.provider">
            <label className="display-font" style={labelStyle}>PRIMARY AGENT</label>
            <select
              value={primaryProvider}
              onChange={(e) => {
                const p = e.target.value as ProviderName;
                setPrimaryProvider(p);
                // Newest catalog model, not the `opus` family alias: the alias
                // isn't in the picker's option list, so hard-coding it here
                // left the select displaying a model the tab wasn't on (and
                // 404'd on Native). Cold catalog still falls back to the alias.
                if (p === 'claude') setModel(claudeModelsForPicker[0]?.value ?? 'opus');

                if (p === 'codex') setModel(DEFAULT_CODEX_MODEL);

                if (p === 'cursor') setModel('auto');

                // Default to the first installed local model so single-model
                // setups need no second pick; fall back to the historical
                // reviewer slot for Ollama, leave as-is for llama.cpp if empty.
                if (p === 'ollama') { const tags = authStatus.ollama?.installedModels ?? []; setModel(tags[0] ?? 'heretic'); }
                if (p === 'llamacpp') { const aliases = authStatus.llamacpp?.installedModels ?? []; if (aliases[0]) setModel(aliases[0]); }
                if (p === 'deepseek') { const ids = authStatus.deepseek?.installedModels ?? []; setModel((ids[0] ?? '') as ModelName); }
                if (p === 'strata') { const ids = authStatus.strata?.installedModels ?? []; setModel((ids[0] ?? '') as ModelName); }
                if (p === 'lmstudio') { const ids = authStatus.lmstudio?.installedModels ?? []; setModel((ids[0] ?? '') as ModelName); }
                // Re-normalize effort to what the new provider honors.
                setEffort(clampEffortForProvider(effort, p));
              }}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              {!supportedProvider && <option value={primaryProvider} disabled>Unavailable: {primaryProvider}</option>}
              {(['claude',  'codex', 'cursor',  'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek'] as ProviderName[])
                .filter((p) => !(mode === 'chat' && incognito && (p === 'cursor' || p === 'llamacpp' || p === 'strata' || p === 'deepseek')))
                .filter(isProviderEnabled).map((p) => {
                const authed = authStatus[p]?.loggedIn;
                const label = p === 'claude' ? 'CLAUDE' : p === 'codex' ? 'CODEX' : p === 'cursor' ? 'CURSOR' : p === 'ollama' ? 'OLLAMA' : p === 'deepseek' ? 'XOLOTL' : p === 'strata' ? 'STRATA' : p === 'lmstudio' ? 'LM STUDIO' : 'LLAMA';
                const sub = p === 'claude' ? 'default' : p === 'codex' ? 'GPT' : p === 'cursor' ? '~153 models' : p === 'ollama' ? 'local' : p === 'deepseek' ? 'DeepSeek · Exact / Light' : p === 'strata' ? 'Qwen · web · vision' : p === 'lmstudio' ? 'local · OpenAI-compat' : 'local · vision';
                return (
                  <option key={p} value={p} disabled={!authed}>
                    {label} — {sub}{authed ? '' : ' (not authenticated)'}
                  </option>
                );
              })}
            </select>

            {visibleProviderAccounts.length > 0 && (
              <div style={{ marginTop: '12px' }}>
                <label className="display-font" style={labelStyle}>ACCOUNT PROFILE</label>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {visibleProviderAccounts.map((account) => {
                    const active = providerAccountRef === account.id;
                    const status = authStatus?.codex?.accountStatuses?.find((s) => s.id === account.id);
                    const short = (account.shortLabel || account.label || account.id).slice(0, 4).toUpperCase();
                    return (
                      <button
                        key={account.id}
                        onClick={() => setProviderAccountRef(account.id)}
                        style={{ ...selectStyle(active), flex: '1 1 120px', textAlign: 'center', padding: '7px 10px' }}
                        title={status?.loggedIn ? `${account.label} authenticated` : `${account.label} not authenticated`}
                      >
                        <div>{account.label.toUpperCase()}</div>
                        <div style={{ fontSize: '9px', marginTop: '3px', opacity: 0.75 }}>
                          {short} · {status?.loggedIn ? 'LIVE' : 'AUTH'}
                        </div>
                      </button>
                    );
                  })}
                  {providerAccountRef && (
                    <button
                      onClick={() => {
                        void fetch(`/api/auth-login?provider=codex&account=${encodeURIComponent(providerAccountRef)}`, { method: 'POST' })
                          .then((r) => r.json() as Promise<AuthLoginResult>)
                          .then((d) => setCodexLoginCommand(d.command ?? null))
                          .catch(() => { /* row stays AUTH; Settings has the full flow */ });
                      }}
                      style={{ ...selectStyle(false), flex: '0 0 auto', padding: '7px 10px' }}
                      title="Open Codex login for the selected profile"
                    >
                      LOG IN
                    </button>
                  )}
                </div>
                {codexLoginCommand && (
                  <div style={{ marginTop: '8px' }}>
                    <LoginCommand command={codexLoginCommand} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

            </div>
            <div style={bandHalf}>



        {(
            <div data-help="creator.model">
              <label className="display-font" style={labelStyle}>MODEL</label>
              {primaryProvider === 'cursor' && cursorCatalog?.models?.length ? (
                // Cursor: family × effort × flags. Effort lives in the id, so
                // the EFFORT row below is a note. Emits an exact catalog id.
                <CursorModelSelect
                  value={String(model)}
                  onChange={(id) => setModel(id as ModelName)}
                  selectStyle={{ ...inputStyle, cursor: 'pointer', width: 'auto', flex: '1 1 auto', minWidth: 0 }}
                />
              ) : (primaryProvider === 'ollama' || primaryProvider === 'llamacpp' || primaryProvider === 'lmstudio' || (primaryProvider === 'strata' || primaryProvider === 'deepseek')) ? (() => {
                // All three local providers share the same picker shape: a list
                // of installed model identifiers + capability badges. Ollama's
                // tags come from /api/tags (live); llama.cpp's aliases come from
                // ~/.arco/llamacpp.json (operator-declared); LM Studio's ids
                // come from GET /v1/models (the loaded/available models).
                const which = primaryProvider;
                const tags = authStatus?.[which]?.installedModels ?? [];
                if (tags.length === 0) {
                  const guidance = which === 'ollama'
                    ? 'No Ollama models installed. Run `ollama pull <model>` and refresh.'
                    : which === 'deepseek' ? 'DeepSeek profiles are unavailable. Check the prepared Xolotl registry in Settings.' : which === 'strata' ? 'Strata is unavailable. Start its service at 127.0.0.1:8081 and refresh.' : which === 'lmstudio'
                      ? 'No LM Studio models found. Load a model in the LM Studio app (and start its local server) then refresh.'
                      : 'No llama.cpp models registered. Edit ~/.arco/llamacpp.json (see docs/PROVIDERS.md § llama.cpp) and refresh.';
                  return (
                    <div className="display-font" style={{ padding: '6px 8px', border: '1px dashed var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '0.5px' }}>
                      {guidance}
                    </div>
                  );
                }
                const caps = authStatus?.[which]?.installedModelCapabilities ?? {};
                return (
                  <select value={String(model)} onChange={(e) => setModel(e.target.value as ModelName)} style={{ ...inputStyle, cursor: 'pointer' }}>
                    {tags.map((tag) => {
                      const c = caps[tag];
                      const badges: string[] = [];
                      if (c?.tools) badges.push('tools');
                      if (c?.vision) badges.push('vision');
                      if (c?.thinking) badges.push('think');
                      const ctxLabel = c?.numCtx ? `${(c.numCtx / 1024).toFixed(0)}k` : '';
                      const meta = [badges.join(' · '), ctxLabel].filter(Boolean).join(' · ');
                      return (
                        <option key={tag} value={tag}>{authStatus?.[which]?.installedModelLabels?.[tag] ?? tag}{meta ? ` — ${meta}` : ''}</option>
                      );
                    })}
                  </select>
                );
              })() : (
                <select value={String(model)} onChange={(e) => setModel(e.target.value as ModelName)} style={{ ...inputStyle, cursor: 'pointer' }}>
                  {(activeModelOptions ?? claudeModelsForPicker).map((m) => (
                    <option key={String(m.value)} value={String(m.value)}>{m.label}{m.subline ? ` — ${m.subline}` : ''}</option>
                  ))}
                </select>
              )}
            </div>
        )}

            </div>
            <div style={bandHalf}>

        {(
            <div data-help="creator.effort">
              <label className="display-font" style={labelStyle}>EFFORT</label>
              {(() => {
                // Filter the effort options to what the selected provider AND
                // model actually honor. Per-model gating catches gpt-5.5's
                // xhigh and Claude opus-4-6's max. Empty array → render a
                // "no effort" notice instead of a useless picker. See
                // effortsForModel in utils/format for the rationale.
                const honored = effortsForModel(primaryProvider, model, claudeNativeCatalog, codexCatalog);
                if (honored.length === 0) {
                  const reason = (primaryProvider === 'strata' || primaryProvider === 'deepseek') ? 'None disables thinking; low, medium and high set reasoning effort.' : (primaryProvider === 'ollama' || primaryProvider === 'llamacpp' || primaryProvider === 'lmstudio') ? 'Local models have no effort flag.'
                    : primaryProvider === 'cursor' ? 'Cursor bakes effort into the model id — set it in the MODEL picker above.'
                    : 'Provider does not honor effort.';
                  return (
                    <div className="display-font" style={{ padding: '6px 8px', border: '1px dashed var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '0.5px' }}>
                      {reason}
                    </div>
                  );
                }
                return (
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {honored.map((e) => (
                      <button
                        key={e}
                        onClick={() => setEffort(e)}
                        style={{ ...selectStyle(effort === e), flex: 1, textAlign: 'center', padding: '6px 8px' }}
                      >
                        {EFFORT_LABELS[e] ?? e.toUpperCase()}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
        )}

            </div>
            <div style={bandHalf}>

        {/* Permissions — agent-execution config, paired with EFFORT so the AGENT
            band reads as a symmetric 2×2 (provider | model / effort | perms). */}
        {mode !== 'chat' && <div data-help="creator.permissions">
          <label className="display-font" style={labelStyle}>PERMISSIONS</label>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={() => setSkipPermissions(true)} style={{ ...selectStyle(skipPermissions), flex: 1, textAlign: 'center', padding: '6px 8px' }}>
              AUTO
            </button>
            <button onClick={() => setSkipPermissions(false)} style={{ ...selectStyle(!skipPermissions), flex: 1, textAlign: 'center', padding: '6px 8px' }}>
              SAFE
            </button>
          </div>
          {skipPermissions && (
            <div style={{ marginTop: '4px', fontSize: '9px', color: 'var(--color-warning)', fontFamily: 'var(--font-display)' }}>
              Full system access for workers
            </div>
          )}
        </div>}

            </div>
          </div>
        </div>

        {/* docs/PROVIDERS.md - start the tab in sticky ultracode. Its own box
            (Claude-only - the WorkflowTool lives only in the `claude` binary).
            Enabling pins effort to XHIGH (mirrors `/effort ultracode`); the
            server forces the CLI transport at turn time. */}
        {mode !== 'chat' && primaryProvider === 'claude' && (
        <div style={bandStyle} data-help="creator.ultracode">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="display-font glow-text-bright" style={{ color: 'var(--color-accent-primary)', fontSize: '15px', letterSpacing: '4px' }}>
              ⚡ ULTRACODE
            </span>
            <button
              onClick={() => {
                const next = !ultracode;
                setUltracode(next);
                if (next) setEffort(clampEffortForModel('xhigh' as EffortLevel, primaryProvider, model, claudeNativeCatalog, codexCatalog));
              }}
              style={{ ...selectStyle(ultracode), padding: '6px 18px', textAlign: 'center' }}
            >
              {ultracode ? 'ON' : 'OFF'}
            </button>
          </div>
          <div style={{ marginTop: '10px', fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
            Deep multi-agent mode — Claude authors a Workflow that fans out a subagent fleet (find → verify → synthesize), like <code>ultracode</code> in the Claude CLI. Forces the CLI transport + Workflow tool + xhigh effort.
          </div>
          {ultracode && (
            <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--color-warning)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
              Runs a fleet of agents unattended with full system access and spends heavily. Effort is pinned to XHIGH while on.
            </div>
          )}
        </div>
        )}

        {/* I5 Band 3 — AGENT TUNING. Claude shows its Native-only fast/filter
            controls plus output style; Codex app-server show output
            style only. */}
        {outputStyleProvider && (
        <div style={bandStyle}>
          <button
            onClick={() => setShowRunOptions((v) => !v)}
            className="display-font"
            style={{ width: '100%', background: 'transparent', border: 'none', borderBottom: showRunOptions ? '1px solid var(--color-border-hairline)' : 'none', padding: 0, paddingBottom: showRunOptions ? '12px' : 0, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--color-accent-primary)', fontSize: '15px', letterSpacing: '4px' }}
          >
            <span className="glow-text-bright">{primaryProvider === 'claude' ? 'CLAUDE TUNING' : 'OUTPUT TUNING'}</span>
            <span style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              {!showRunOptions && <span style={{ fontSize: '9px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px' }}>{runOptionsSummary}</span>}
              <span style={{ fontSize: '9px', color: 'var(--color-fg-muted)' }}>{showRunOptions ? '▼' : '▶'}</span>
            </span>
          </button>

          {showRunOptions && (
            <div style={{ marginTop: '16px' }}>
              <div style={optionsGrid}>

        {/* FAST MODE — Claude-only; spans the top of the tuning grid. */}
        {primaryProvider === 'claude' && (
        <div data-help="creator.fast-mode" style={spanBoth}>
            <label className="display-font" style={labelStyle} title="Passes --fast to the Claude primary for faster streaming output.">
              FAST MODE
            </label>
            <button
              onClick={() => setFastMode(!fastMode)}
              style={{ ...selectStyle(fastMode), width: '100%', textAlign: 'center', padding: '6px 8px' }}
            >
              {fastMode ? 'ON' : 'OFF'}
            </button>
            <div style={hintStyle}>Enables --fast on the Claude primary.</div>
        </div>
        )}

        {/* TOOL-RESULT FILTER — Claude Native-only efficiency knob. */}
        {primaryProvider === 'claude' && (
            <div data-help="creator.tool-filter">
              <label className="display-font" style={labelStyle} title="Trims noisy tool output (cargo/jest/pytest passing lines, find/grep/ls head-cap) before it enters context. Native-only.">
                TOOL-RESULT FILTER
              </label>
              <div style={{ display: 'flex', gap: '6px' }}>
                {(['off', 'conservative', 'aggressive'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setEfficiencyToolFilter(m)}
                    style={{ ...selectStyle(m === efficiencyToolFilter), flex: 1, textAlign: 'center', padding: '6px 8px' }}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <div style={hintStyle}>
                Trims noisy Bash output before it enters context. Native-only — no effect on CLI/Codex.
              </div>
            </div>
        )}

            <div data-help="creator.output-style">
              <label className="display-font" style={labelStyle} title="Appends a stable prompt addendum telling the model how terse to be.">
                OUTPUT STYLE
              </label>
              <div style={{ display: 'flex', gap: '6px' }}>
                {(['normal', 'lite', 'terse'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setOutputStyle(m)}
                    style={{ ...selectStyle(m === outputStyle), flex: 1, textAlign: 'center', padding: '6px 8px' }}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <div style={hintStyle}>
                Cuts output tokens. <code>lite</code> drops fillers/hedging; <code>terse</code> also drops articles, fragments OK. Claude Native, Codex app-server honor this on normal turns. Review/Handoff/DOCS/GIT always run as <code>normal</code>.
              </div>
            </div>
            </div>
          </div>
          )}
        </div>
        )}

        {/* ADVANCED OPTIONS — standalone full-width collapsible (all providers;
            additional dirs + fallback model are generic, not Claude tuning). */}
        {mode !== 'chat' && <div data-help="creator.advanced" style={{ border: '1px solid var(--color-border-hairline)', borderRadius: '4px' }}>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="display-font"
            style={{
              width: '100%',
              padding: '8px 12px',
              background: 'transparent',
              border: 'none',
              color: 'var(--color-accent-primary-dim)',
              cursor: 'pointer',
              fontSize: '11px',
              letterSpacing: '2px',
              textAlign: 'left',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>ADVANCED OPTIONS</span>
            <span style={{ fontSize: '9px', color: 'var(--color-fg-muted)' }}>
              {showAdvanced ? '▼' : '▶'}
            </span>
          </button>

          {showAdvanced && (
            <div style={{ padding: '4px 12px 12px', borderTop: '1px solid var(--color-border-hairline)', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div data-help="creator.additional-dirs">
                <label className="display-font" style={labelStyle}>
                  ADDITIONAL DIRECTORIES
                </label>
                <textarea
                  value={additionalDirsRaw}
                  onChange={(e) => setAdditionalDirsRaw(e.target.value)}
                  placeholder="One path per line or comma-separated. Grants workers tool access to these directories in addition to the cwd."
                  rows={2}
                  style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-body)' }}
                />
                <div style={hintStyle}>Passed to workers via <code>--add-dir</code>.</div>
              </div>

              <div data-help="creator.fallback-model">
                <label className="display-font" style={labelStyle}>FALLBACK MODEL</label>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button onClick={() => setFallbackModel('')} style={{ ...selectStyle(fallbackModel === ''), flex: 1, textAlign: 'center', padding: '6px 8px' }}>NONE</button>
                  {MODELS.map((m) => (
                    <button
                      key={m.value}
                      onClick={() => setFallbackModel(fallbackModel === m.value ? '' : m.value)}
                      style={{ ...selectStyle(fallbackModel === m.value), flex: 1, textAlign: 'center', padding: '6px 8px', fontSize: '10px' }}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <div style={hintStyle}>Used when primary model is overloaded. <code>--fallback-model</code>.</div>
              </div>
            </div>
          )}
        </div>}
        {/* ── END BANDED LAYOUT ── */}

        {/* CLUSTER mode: members list. Full-width below the defaults grid. */}
        {mode === 'cluster' && (
          <ClusterMembersSection
            members={members}
            onAddMember={addMember}
            onRemoveMember={removeMember}
            onUpdateMember={updateMember}
            claudeModelsForPicker={claudeModelsForPicker}
            codexModelsForPicker={codexModelsForPicker}
            ollamaModelsForPicker={ollamaModelsForPicker}
            llamacppModelsForPicker={llamacppModelsForPicker}
            cursorModelsForPicker={cursorModelsForPicker}
            claudeNativeCatalog={claudeNativeCatalog}
            codexCatalog={codexCatalog}
            codexAccounts={codexAccounts}
            selectStyle={selectStyle}
            labelStyle={labelStyle}
            inputStyle={inputStyle}
            hintStyle={hintStyle}
          />
        )}

        {mode === 'cluster' && clusterSubmitProblems.length > 0 && (
          <div className="display-font" style={{ ...hintStyle, color: 'var(--color-warning)' }}>
            {clusterSubmitProblems.join(' ')}
          </div>
        )}

        {/* Save-as-defaults — persists the current picker state to
            ~/.arco/settings.json so the next workflow pre-selects it.
            Available in both modes (the defaults seed both single + cluster
            new-member rows). */}
        <div data-help="creator.save-defaults" style={{ display: 'flex', flexDirection: 'column' }}>
        <button
          onClick={saveAsDefaults}
          disabled={savingDefaults}
          className="display-font"
          style={{
            padding: '8px 16px',
            background: 'transparent',
            border: '1px solid var(--color-accent-secondary-dim)',
            borderRadius: '4px',
            color: 'var(--color-accent-secondary)',
            cursor: savingDefaults ? 'default' : 'pointer',
            fontSize: '11px',
            letterSpacing: '2px',
            opacity: savingDefaults ? 0.6 : 1,
          }}
          title="Persist the current picker state (primary provider/model/effort, permissions, toggles) as the default for future workflows."
        >
          {savingDefaults
            ? 'SAVING…'
            : defaultsSavedAt && Date.now() - defaultsSavedAt < 3000
              ? 'SAVED ✓'
              : 'SAVE AS DEFAULTS'}
        </button>
        </div>

        {/* Launch — data-help on the wrapper, not the button: disabled
            <button> swallows clicks at the browser level so help-mode's
            capture handler never sees them. Wrapper is flex-column so the
            inner button still stretches to full width (the parent is also
            flex-column; without flex on the wrapper the inline-default
            button would shrink to content width). */}
        <div data-help="creator.launch" style={{ display: 'flex', flexDirection: 'column' }}>
        {mode === 'cluster' ? (
          <button
            onClick={handleCreate}
            disabled={!canLaunchCluster}
            className={canLaunchCluster ? 'glow-border' : ''}
            style={{
              padding: '12px 24px',
              background: canLaunchCluster ? 'var(--color-accent-primary-a08)' : 'transparent',
              border: `1px solid ${canLaunchCluster ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
              borderRadius: '4px',
              color: !connected ? 'var(--color-danger)' : 'var(--color-accent-primary)',
              cursor: canLaunchCluster ? 'pointer' : 'not-allowed',
              fontFamily: 'var(--font-display)',
              fontSize: '14px',
              letterSpacing: '3px',
            }}
          >
            {!connected ? 'DISCONNECTED' : 'CREATE CLUSTER'}
          </button>
        ) : mode === 'genesis' ? (
          <button
            onClick={handleCreate}
            disabled={!canLaunchGenesis}
            className={canLaunchGenesis ? 'glow-border' : ''}
            style={{
              padding: '12px 24px',
              background: canLaunchGenesis ? 'var(--color-accent-primary-a08)' : 'transparent',
              border: `1px solid ${canLaunchGenesis ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
              borderRadius: '4px',
              color: !connected ? 'var(--color-danger)' : canLaunchGenesis ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: canLaunchGenesis ? 'pointer' : 'not-allowed',
              fontFamily: 'var(--font-display)',
              fontSize: '14px',
              letterSpacing: '3px',
            }}
          >
            {!connected
              ? 'DISCONNECTED'
              : !name.trim()
                ? 'NAME YOUR PROJECT'
                : !spark.trim()
                  ? 'ADD A SPARK'
                  : 'START GENESIS'}
          </button>
        ) : mode === 'chat' ? (
          <button
            onClick={handleCreate}
            disabled={!canLaunchChat}
            className={canLaunchChat ? 'glow-border' : ''}
            style={{
              padding: '12px 24px',
              background: canLaunchChat ? 'var(--color-accent-primary-a08)' : 'transparent',
              border: `1px solid ${canLaunchChat ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
              borderRadius: '4px',
              color: canLaunchChat ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: canLaunchChat ? 'pointer' : 'not-allowed',
              fontFamily: 'var(--font-display)',
              fontSize: '14px',
              letterSpacing: '3px',
            }}
          >
            {!connected ? 'DISCONNECTED' : 'START CHAT'}
          </button>
        ) : (
          <button
            onClick={handleCreate}
            disabled={!canLaunch}
            className={canLaunch ? 'glow-border' : ''}
            style={{
              padding: '12px 24px',
              background: canLaunch ? 'var(--color-accent-primary-a08)' : 'transparent',
              border: `1px solid ${canLaunch ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
              borderRadius: '4px',
              color: !connected ? 'var(--color-danger)' : !workDir ? 'var(--color-fg-muted)' : 'var(--color-accent-primary)',
              cursor: canLaunch ? 'pointer' : 'not-allowed',
              fontFamily: 'var(--font-display)',
              fontSize: '14px',
              letterSpacing: '3px',
            }}
          >
            {!connected
              ? 'DISCONNECTED'
              : !workDir
                ? 'SELECT WORKING DIRECTORY'
                : 'LAUNCH WORKFLOW'}
          </button>
        )}
        </div>
      </div>
    </div>
  );
}
