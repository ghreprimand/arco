import { create } from 'zustand';
import { useDraftStore, dropDraftForJob } from './draftStore';
import { useComputerStore } from './computerStore';
import { persist } from 'zustand/middleware';
import type { ChatMessage, WorkflowConfig, ProviderName, ArcoSettings } from '@arco/shared';
import { THEME_REGISTRY, DEFAULT_THEME_ID } from '../themes/registry';
import { applyTheme, applyCrispText } from '../themes/apply';
import { applyPhosphorPreferences } from '../themes/phosphor/preferences';
import { PROVIDER_AUTO_ID, resolveProviderTheme } from '../themes/providerThemes';
import { writeCachedThemeId, writeCachedFontPackOverride, writeCachedFrostedOverride, writeCachedFrostedOpacity, writeCachedBgBrightness, writeCachedTextBrightness, writeCachedCrispText } from '../themes/bootstrap';
import {
  capMessages, capSessionChat, trimJobMemory, LOADED_HISTORY_PIN,
  capWorkerText, capToolInputText, capWorkers, capActivityEntry,
  MAX_WORKER_OUTPUT_BYTES_CLIENT, MAX_WORKER_THINKING_BYTES_CLIENT,
  MAX_WORKER_TOOL_CALLS, MAX_ACTIVITY_ENTRIES, MAX_TOOL_FILTERED_ENTRIES,
  TURN_TOKEN_USAGE_CAP,
} from './memoryTrim';
import { debouncedJSONStorage } from './persistence';
import { getAppMemoryStats } from './selectors';
import { setOllamaThinkingCatalog } from '../utils/format';
import {
  mergeTokens, compareHistoryEntries,
} from './appStore.types';
import type {
  AppState, AppMemoryStats, JobState, ReviewEntry, ResearchEntry, HandoffEntry, TaskChildEntry,
} from './appStore.types';

// ---------------------------------------------------------------------------
// Public API re-exports. The store's symbols were extracted into sibling
// modules (Phase 5 file-size refactor) but 72 importers still pull them from
// './appStore' — keep the surface unchanged by re-exporting here.
// ---------------------------------------------------------------------------
// `capMessages` / `capSessionChat` are the only cap helpers the original
// file exported (appStore.test.ts imports them); `trimJobMemory`,
// `mergeTokens`, `compareHistoryEntries` stayed module-internal — keep them
// imported (above) for internal use, not re-exported.
export { capMessages, capSessionChat } from './memoryTrim';
export type { MessageWindowOptions, SessionWindowOptions } from './memoryTrim';
export type {
  QuotaSnapshot, ArtifactItem, DraftAttachment, ReviewEntry, ResearchEntry, ActivityEntry,
  HandoffEntry, HandoffLockEntry, JobState, HistoryEventEntry, TaskChildEntry,
  AppMemoryStats, ClusterMemberLabel, ClusterCardLayout,
} from './appStore.types';
export { getAppMemoryStats } from './selectors';

function updateJob(state: AppState, jobId: string, updater: (job: JobState) => Partial<JobState>): Partial<AppState> {
  const job = state.jobs[jobId];
  if (!job) return {};
  return { jobs: { ...state.jobs, [jobId]: { ...job, ...updater(job) } } };
}

// Resolve + apply the right theme for the current selection. The only dynamic
// id is `provider-auto`, which tints to the active tab's provider (see
// themes/providerThemes.ts); every other id maps straight to THEME_REGISTRY.
// Centralized so setSettings / setThemeId / setActiveJob all agree.
function applyThemeForSelection(
  themeId: string | null | undefined,
  fontPack: string | null | undefined,
  provider: ProviderName | null | undefined,
  frosted: 'on' | 'off' | null | undefined,
  frostedOpacity?: number | null,
  brightness?: { bg?: number | null; text?: number | null } | null,
): void {
  const id = themeId ?? DEFAULT_THEME_ID;
  if (id === PROVIDER_AUTO_ID) {
    applyTheme(resolveProviderTheme(provider ?? null), fontPack ?? null, frosted ?? null, frostedOpacity ?? null, brightness ?? null);
    return;
  }
  applyTheme(THEME_REGISTRY[id] ?? THEME_REGISTRY[DEFAULT_THEME_ID], fontPack ?? null, frosted ?? null, frostedOpacity ?? null, brightness ?? null);
}

// Bundle the two signed brightness shifts from a settings object into the
// { bg, text } shape applyTheme expects. Used at every applyThemeForSelection
// call site so theme/font/frosted changes don't drop the operator's shifts.
function brightnessOf(s: ArcoSettings | null | undefined): { bg?: number; text?: number } {
  return { bg: s?.bgBrightness, text: s?.textBrightness };
}

function writeBrightnessCache(field: 'bgBrightness' | 'textBrightness', v: number | null | undefined): void {
  if (field === 'bgBrightness') writeCachedBgBrightness(v);
  else writeCachedTextBrightness(v);
}

// Shared optimistic-apply + persist + rollback for the two brightness sliders.
// Same shape as setFrostedOpacity, parameterized by which axis (bg/text) so the
// two sliders don't duplicate the whole body. `axis` is the applyTheme key;
// `field` is the settings/cache key.
async function commitBrightness(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  field: 'bgBrightness' | 'textBrightness',
  v: number | null | undefined,
): Promise<void> {
  const axis = field === 'bgBrightness' ? 'bg' : 'text';
  const prev = get().settings;
  const provider = get().getActiveJob()?.config.primaryProvider;
  applyThemeForSelection(prev?.themeId, prev?.fontPackOverride ?? null, provider, prev?.frostedOverride, prev?.frostedOpacity, { ...brightnessOf(prev), [axis]: v });
  writeBrightnessCache(field, v);
  set({ settings: prev ? { ...prev, [field]: v ?? undefined } : prev });
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: v ?? null }),
    });
    if (!res.ok) throw new Error(`settings POST ${res.status}`);
    const data = await res.json() as ArcoSettings;
    applyThemeForSelection(data.themeId, data.fontPackOverride, provider, data.frostedOverride, data.frostedOpacity, brightnessOf(data));
    writeBrightnessCache(field, data[field]);
    set({ settings: data });
  } catch {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json() as ArcoSettings;
      applyThemeForSelection(data.themeId, data.fontPackOverride, provider, data.frostedOverride, data.frostedOpacity, brightnessOf(data));
      writeBrightnessCache(field, data[field]);
      set({ settings: data });
    } catch { /* leave optimistic */ }
  }
}

export const useAppStore = create<AppState>()(persist((set, get) => ({
  connected: false,
  // ARCO_OPS_PLAN.md §C1 — richer connection overlay. Boots in 'connecting'
  // (WS never opened). Not persisted (absent from partialize) so a reload
  // always re-derives it from a live socket rather than a stale snapshot.
  connectionState: 'connecting',
  sessionId: null,
  capabilities: null,
  usage: null,
  codexUsage: null,
  cursorUsage: null,
  zaiUsage: null,
  shutdown: false,
  shutdownReason: null,
  authStatus: null,
  ollamaLive: null,
  llamacppLive: null,
  claudeNativeCatalog: null,
  codexCatalog: null,
  codexCatalogByAccount: {},
  geminiNativeCatalog: null,
  cursorCatalog: null,
  settings: null,
  showSettings: false,
  showGithub: false,
  showManual: false,
  showRecall: false,
  // I3 — restore the operator's last focus-mode choice across reloads.
  focusMode: (() => { try { return localStorage.getItem('arco.focusMode') === '1'; } catch { return false; } })(),
  mediaStudio: { open: false },
  helpMode: false,
  activeHelpPopover: null,
  activeHelpCard: null,
  activeDocRef: null,
  quotaState: null,
  cliChanges: [],
  taskLedger: {},
  mcpRegistry: [],
  mcpProbeResults: {},
  mcpAllow: {},
  mcpMalwareWarning: null,
  artifactQueue: [],
  detailWorker: null,
  jobs: {},
  activeJobId: null,
  showCreator: false,
  creatorRequested: false, showHome: true, creatorPrefill: null,
  attachments: {},
  clusters: {},
  bakeoffsByWorkflow: {},
  clusterMemberLabels: {},
  activeClusterId: null,
  clusterFocusedMember: {},
  clusterGridSplit: 0.35,
  clusterCardLayout: 'auto',
  handoffLocksByCwd: {},
  notifications: [],

  getActiveJob: () => {
    const { jobs, activeJobId } = get();
    return activeJobId ? jobs[activeJobId] : undefined;
  },

  // WORKBENCH_EXPANSION_PLAN.md A1 — live retention snapshot for the dev
  // MemoryHud and the mem-retention smoke. Pure read over current state; no
  // mutation. The store arrays are already capped (see memoryTrim.ts); this
  // surfaces the real footprint so a long session's growth can be measured.
  getRetentionStats: () => {
    const s = get();
    let attachmentUrls = 0;
    for (const list of Object.values(s.attachments)) {
      for (const a of list) if (a.previewUrl) attachmentUrls++;
    }
    const perJob = Object.values(s.jobs).map((j) => ({
      id: j.id,
      messages: j.messages?.length ?? 0,
      sessionChat: j.sessionChat?.length ?? 0,
      activity: j.activity?.length ?? 0,
      historyEvents: j.historyEvents?.length ?? 0,
      workers: Object.keys(j.workers ?? {}).length,
      toolFiltered: j.toolFiltered ? Object.keys(j.toolFiltered).length : 0,
      turnTokenUsage: j.turnTokenUsage?.length ?? 0,
    }));
    // performance.memory is a non-standard Chrome extension; absent elsewhere.
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    const heap = mem
      ? {
          usedMB: Math.round(mem.usedJSHeapSize / 1048576),
          totalMB: Math.round(mem.totalJSHeapSize / 1048576),
          limitMB: Math.round(mem.jsHeapSizeLimit / 1048576),
        }
      : undefined;
    return {
      jobs: Object.keys(s.jobs).length,
      attachmentUrls,
      notifications: s.notifications.length,
      perJob,
      heap,
    };
  },

  trimMemory: () =>
    set((s) => ({
      jobs: Object.fromEntries(
        Object.entries(s.jobs).map(([id, job]) => [id, trimJobMemory(job)]),
      ),
    })),

  getAuthedProviders: () => {
    const s = get().authStatus;
    if (!s) return [];
    const out: ProviderName[] = [];
    if (s.claude.loggedIn) out.push('claude');
    if (s.gemini.loggedIn) out.push('gemini');
    if (s.codex.loggedIn) out.push('codex');
    if (s.zai.loggedIn) out.push('zai');
    if (s.ollama.loggedIn) out.push('ollama');
    if (s.llamacpp.loggedIn) out.push('llamacpp');
    return out;
  },

  isProviderEnabled: (p: ProviderName) => {
    const s = get().settings;
    if (!s) return true; // fail-open during initial settings fetch
    const v = s.enabledProviders?.[p];
    return v !== false;
  },

  setConnected: (connected, sessionId) =>
    set((s) => {
      // Slot 2 — on disconnect, any prior snapshot is stale; reset so the
      // SYNCING overlay re-engages until the server re-sends snapshots on
      // the next reconnect. On connect, no-op (individual job flags flip
      // true as each snapshot arrives).
      const jobs = connected
        ? s.jobs
        : Object.fromEntries(Object.entries(s.jobs).map(([id, j]) => [id, { ...j, snapshotReceived: false }]));
      return { connected, sessionId: sessionId ?? s.sessionId, jobs };
    }),

  setConnectionState: (state) => set({ connectionState: state }),

  // §C1 — stamp the last primary content signal. Called from the WS dispatch
  // for primary_turn_started / text / thinking / tool_use / activity /
  // complete. The runtime deriver reads `now - lastPrimaryEventAt` to split a
  // live `busy` from a `stuck` (silent) worker. `at` is the message's own
  // timestamp when present, else client receive time.
  bumpPrimaryEvent: (jobId, at) =>
    set((s) => updateJob(s, jobId, () => ({ lastPrimaryEventAt: at }))),

  // §C2 — operator clicked DISMISS on the replay-recovered banner. Clear the
  // recovery anchor so deriveWorkflowState drops straight to idle instead of
  // waiting out REPLAY_RECOVERED_WINDOW_MS. The auto-dismiss-on-window-elapse
  // path still stands; this is just the manual ack.
  clearRecovered: (jobId) =>
    set((s) => updateJob(s, jobId, () => ({ recoveredAt: undefined }))),

  setCapabilities: (capabilities) => set({ capabilities }),

  setUsage: (usage) => set({ usage }),

  setCodexUsage: (codexUsage) => set({ codexUsage }),
  setCursorUsage: (cursorUsage) => set({ cursorUsage }),

  setZaiUsage: (zaiUsage) => set({ zaiUsage }),

  setShutdown: (shutdown, reason) => set({ shutdown, shutdownReason: reason ?? null }),

  setAuthStatus: (authStatus) => {
    setOllamaThinkingCatalog(authStatus?.ollama?.installedModelCapabilities);
    set({ authStatus });
  },

  setOllamaLive: (ollamaLive) => set({ ollamaLive }),

  setLlamacppLive: (llamacppLive) => set({ llamacppLive }),
  setClaudeNativeCatalog: (claudeNativeCatalog) => set({ claudeNativeCatalog }),
  setCodexCatalog: (codexCatalog) => set({ codexCatalog }),
  setCodexCatalogForAccount: (accountRef, snap) =>
    set((s) => ({ codexCatalogByAccount: { ...s.codexCatalogByAccount, [accountRef]: snap } })),
  setGeminiNativeCatalog: (geminiNativeCatalog) => set({ geminiNativeCatalog }),
  setCursorCatalog: (cursorCatalog) => set({ cursorCatalog }),

  setSettings: (settings) => {
    applyPhosphorPreferences(settings, true);
    // Themes Phase 2 — every settings refresh re-applies the theme so external
    // patches (auto-compact, provider toggles, another tab) don't drop the
    // active theme. applyTheme is idempotent; cost is trivial. Also mirror
    // the themeId + font-pack override to localStorage so the next page reload
    // paints the right theme on frame one (see themes/bootstrap.ts).
    applyThemeForSelection(
      settings.themeId,
      settings.fontPackOverride,
      get().getActiveJob()?.config.primaryProvider,
      settings.frostedOverride,
      settings.frostedOpacity,
      brightnessOf(settings),
    );
    writeCachedThemeId(settings.themeId ?? DEFAULT_THEME_ID);
    writeCachedFontPackOverride(settings.fontPackOverride ?? null);
    writeCachedFrostedOverride(settings.frostedOverride);
    writeCachedFrostedOpacity(settings.frostedOpacity);
    writeCachedBgBrightness(settings.bgBrightness);
    writeCachedTextBrightness(settings.textBrightness);
    applyCrispText(settings.crispText ?? false);
    writeCachedCrispText(settings.crispText);
    set({ settings });
  },

  setPhosphorPreference: async (field, value) => {
    const prev = get().settings;
    if (!prev) return;
    get().setSettings({ ...prev, [field]: value });
    try {
      const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: value }) });
      if (!res.ok) throw new Error(`settings POST ${res.status}`);
      get().setSettings(await res.json() as ArcoSettings);
    } catch {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) throw new Error('settings read failed');
        get().setSettings(await res.json() as ArcoSettings);
      } catch { get().setSettings({ ...get().settings!, [field]: prev[field] }); }
      get().pushNotification('error', 'Could not save Phosphor preference. The saved value has been restored.');
    }
  },

  setThemeId: async (id) => {
    const theme = THEME_REGISTRY[id];
    if (!theme) return;
    const prev = get().settings;
    applyThemeForSelection(id, prev?.fontPackOverride ?? null, get().getActiveJob()?.config.primaryProvider, prev?.frostedOverride, prev?.frostedOpacity, brightnessOf(prev));
    writeCachedThemeId(id);
    set({ settings: prev ? { ...prev, themeId: id } : prev });
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ themeId: id }),
      });
      if (!res.ok) throw new Error(`settings POST ${res.status}`);
      const data = await res.json() as ArcoSettings;
      // Re-apply from authoritative response in case the server normalized.
      applyThemeForSelection(data.themeId, data.fontPackOverride, get().getActiveJob()?.config.primaryProvider, data.frostedOverride, data.frostedOpacity, brightnessOf(data));
      writeCachedThemeId(data.themeId ?? DEFAULT_THEME_ID);
      writeCachedFontPackOverride(data.fontPackOverride ?? null);
      writeCachedFrostedOverride(data.frostedOverride);
      set({ settings: data });
    } catch {
      // Roll back — re-fetch authoritative settings and re-apply its theme.
      try {
        const res = await fetch('/api/settings');
        const data = await res.json() as ArcoSettings;
        applyThemeForSelection(data.themeId, data.fontPackOverride, get().getActiveJob()?.config.primaryProvider, data.frostedOverride, data.frostedOpacity, brightnessOf(data));
        writeCachedThemeId(data.themeId ?? DEFAULT_THEME_ID);
        writeCachedFontPackOverride(data.fontPackOverride ?? null);
        set({ settings: data });
      } catch { /* leave optimistic — unlikely path */ }
    }
  },

  // Font-pack override: optimistic apply + persist, mirror to settings cache.
  // Passing null/undefined clears the override (theme defaults take over).
  setFontPackOverride: async (id) => {
    const prev = get().settings;
    const provider = get().getActiveJob()?.config.primaryProvider;
    applyThemeForSelection(prev?.themeId, id ?? null, provider, prev?.frostedOverride, prev?.frostedOpacity, brightnessOf(prev));
    writeCachedFontPackOverride(id ?? null);
    set({ settings: prev ? { ...prev, fontPackOverride: id ?? undefined } : prev });
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fontPackOverride: id ?? null }),
      });
      if (!res.ok) throw new Error(`settings POST ${res.status}`);
      const data = await res.json() as ArcoSettings;
      applyThemeForSelection(data.themeId, data.fontPackOverride, provider, data.frostedOverride, data.frostedOpacity, brightnessOf(data));
      writeCachedFontPackOverride(data.fontPackOverride ?? null);
      set({ settings: data });
    } catch {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json() as ArcoSettings;
        applyThemeForSelection(data.themeId, data.fontPackOverride, provider, data.frostedOverride, data.frostedOpacity, brightnessOf(data));
        writeCachedFontPackOverride(data.fontPackOverride ?? null);
        set({ settings: data });
      } catch { /* leave optimistic */ }
    }
  },

  setFrostedOverride: async (v) => {
    const prev = get().settings;
    const provider = get().getActiveJob()?.config.primaryProvider;
    applyThemeForSelection(prev?.themeId, prev?.fontPackOverride ?? null, provider, v, prev?.frostedOpacity, brightnessOf(prev));
    writeCachedFrostedOverride(v);
    set({ settings: prev ? { ...prev, frostedOverride: v ?? undefined } : prev });
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frostedOverride: v ?? null }),
      });
      if (!res.ok) throw new Error(`settings POST ${res.status}`);
      const data = await res.json() as ArcoSettings;
      applyThemeForSelection(data.themeId, data.fontPackOverride, provider, data.frostedOverride, data.frostedOpacity, brightnessOf(data));
      writeCachedFrostedOverride(data.frostedOverride);
      set({ settings: data });
    } catch {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json() as ArcoSettings;
        applyThemeForSelection(data.themeId, data.fontPackOverride, provider, data.frostedOverride, data.frostedOpacity, brightnessOf(data));
        writeCachedFrostedOverride(data.frostedOverride);
        set({ settings: data });
      } catch { /* leave optimistic */ }
    }
  },

  // Frosted-glass panel opacity — same optimistic-apply + persist + rollback
  // shape as setFrostedOverride. Passing null/undefined clears the override so
  // the built-in 0.6 default applies. Only visible while frosted glass is on.
  setFrostedOpacity: async (v) => {
    const prev = get().settings;
    const provider = get().getActiveJob()?.config.primaryProvider;
    applyThemeForSelection(prev?.themeId, prev?.fontPackOverride ?? null, provider, prev?.frostedOverride, v, brightnessOf(prev));
    writeCachedFrostedOpacity(v);
    set({ settings: prev ? { ...prev, frostedOpacity: v ?? undefined } : prev });
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frostedOpacity: v ?? null }),
      });
      if (!res.ok) throw new Error(`settings POST ${res.status}`);
      const data = await res.json() as ArcoSettings;
      applyThemeForSelection(data.themeId, data.fontPackOverride, provider, data.frostedOverride, data.frostedOpacity, brightnessOf(data));
      writeCachedFrostedOpacity(data.frostedOpacity);
      set({ settings: data });
    } catch {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json() as ArcoSettings;
        applyThemeForSelection(data.themeId, data.fontPackOverride, provider, data.frostedOverride, data.frostedOpacity, brightnessOf(data));
        writeCachedFrostedOpacity(data.frostedOpacity);
        set({ settings: data });
      } catch { /* leave optimistic */ }
    }
  },

  // Live, non-persisting preview while the operator drags the opacity slider —
  // re-applies the theme CSS vars with the draft opacity but skips the POST.
  // setFrostedOpacity commits the final value on release.
  previewFrostedOpacity: (v) => {
    const prev = get().settings;
    const provider = get().getActiveJob()?.config.primaryProvider;
    applyThemeForSelection(prev?.themeId, prev?.fontPackOverride ?? null, provider, prev?.frostedOverride, v, brightnessOf(prev));
  },

  // Background / text brightness shifts (−30…+30, 0 = stock). Same optimistic-
  // apply + persist + rollback as setFrostedOpacity, via the shared
  // commitBrightness helper. Two independent axes so bg and text move
  // separately; both apply to every theme regardless of frosted glass.
  setBgBrightness: (v) => commitBrightness(get, set, 'bgBrightness', v),
  setTextBrightness: (v) => commitBrightness(get, set, 'textBrightness', v),

  // Live, non-persisting preview while the operator drags a brightness slider.
  // setBg/TextBrightness commit the final value on release.
  previewBgBrightness: (v) => {
    const prev = get().settings;
    const provider = get().getActiveJob()?.config.primaryProvider;
    applyThemeForSelection(prev?.themeId, prev?.fontPackOverride ?? null, provider, prev?.frostedOverride, prev?.frostedOpacity, { ...brightnessOf(prev), bg: v });
  },
  previewTextBrightness: (v) => {
    const prev = get().settings;
    const provider = get().getActiveJob()?.config.primaryProvider;
    applyThemeForSelection(prev?.themeId, prev?.fontPackOverride ?? null, provider, prev?.frostedOverride, prev?.frostedOpacity, { ...brightnessOf(prev), text: v });
  },

  // Global "crisp text" toggle — optimistic apply + persist + rollback. Unlike
  // the theme-token tweaks above this only flips a root attribute (data-crisp),
  // so it doesn't go through applyThemeForSelection; applyCrispText is enough.
  setCrispText: async (v) => {
    const prev = get().settings;
    applyCrispText(v);
    writeCachedCrispText(v);
    set({ settings: prev ? { ...prev, crispText: v } : prev });
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crispText: v }),
      });
      if (!res.ok) throw new Error(`settings POST ${res.status}`);
      const data = await res.json() as ArcoSettings;
      applyCrispText(data.crispText ?? false);
      writeCachedCrispText(data.crispText);
      set({ settings: data });
    } catch {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json() as ArcoSettings;
        applyCrispText(data.crispText ?? false);
        writeCachedCrispText(data.crispText);
        set({ settings: data });
      } catch { /* leave optimistic */ }
    }
  },

  // Slice 6a — operator-set top-row tab order. Optimistic local update + POST
  // to /api/settings; server re-broadcasts authoritative value via the
  // existing settings-watcher path. No event in events.jsonl: tab order is
  // operator preference, not a workflow-scoped action (autonomy fence #3 —
  // events.jsonl carries actions, not preferences).
  setTabOrder: async (tabOrder: string[]) => {
    const prev = get().settings;
    set({ settings: prev ? { ...prev, tabOrder } : prev });
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabOrder }),
      });
      if (!res.ok) throw new Error(`settings POST ${res.status}`);
      const data = await res.json() as ArcoSettings;
      set({ settings: data });
    } catch {
      // Roll back from authoritative settings on failure.
      try {
        const res = await fetch('/api/settings');
        const data = await res.json() as ArcoSettings;
        set({ settings: data });
      } catch { /* leave optimistic */ }
    }
  },

  setShowSettings: (showSettings) => set({ showSettings }),

  setShowGithub: (showGithub) => set({ showGithub }),
  setShowRecall: (showRecall) => set({ showRecall }),
  setFocusMode: (focusMode) => {
    try { localStorage.setItem('arco.focusMode', focusMode ? '1' : '0'); } catch { /* no-op */ }
    set({ focusMode });
  },

  setShowManual: (showManual) => set({ showManual }),

  setMediaStudio: (mediaStudio) => set({ mediaStudio }),

  setHelpMode: (helpMode) => set({ helpMode, activeHelpPopover: helpMode ? null : null }),

  setActiveHelpPopover: (activeHelpPopover) => set({ activeHelpPopover }),

  setActiveHelpCard: (activeHelpCard) => set({ activeHelpCard }),

  setActiveDocRef: (activeDocRef) => set({ activeDocRef }),

  setQuotaState: (quotaState) => set({ quotaState }),

  setCliChanges: (cliChanges) => set({ cliChanges }),

  setTaskLedger: (cwd, tasks, boardKey) =>
    set((s) => ({ taskLedger: { ...s.taskLedger, [boardKey ? `${cwd}::${boardKey}` : cwd]: tasks } })),

  setMcpRegistry: (defs) => set({ mcpRegistry: defs }),
  setMcpMalwareWarning: (w) => set({ mcpMalwareWarning: w }),
  setMcpProbeResult: (serverId, result) =>
    set((s) => ({ mcpProbeResults: { ...s.mcpProbeResults, [serverId]: result } })),
  setMcpAllow: (workflowId, allow) =>
    set((s) => ({ mcpAllow: { ...s.mcpAllow, [workflowId]: allow } })),

  acknowledgeCliChange: async (provider, toVersion) => {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acknowledgedCliVersions: { [provider]: toVersion } }),
      });
      if (res.ok) {
        const updated = (await res.json()) as ArcoSettings;
        set((s) => ({
          settings: updated,
          cliChanges: s.cliChanges.filter((c) => c.provider !== provider),
        }));
      }
    } catch {
      // Best-effort; a failed ack just leaves the dot on until next boot.
    }
  },

  enqueueArtifact: (a) =>
    set((s) => ({ artifactQueue: [...s.artifactQueue, a] })),

  dequeueArtifact: (artifactId) =>
    set((s) => ({ artifactQueue: s.artifactQueue.filter((x) => x.artifactId !== artifactId) })),

  setDetailWorker: (detailWorker) => set({ detailWorker }),

  createJob: (id, config, resumedVia, parentWorkflowId, backgroundCreated, restored) =>
    set((s) => {
      // Phase 7b — Task children mint a JobState (so promote can flip it
      // into the top tab strip without a server round-trip) but don't
      // claim active focus or replace the job-creator panel; the parent
      // stays in front and the child surfaces only via the inline card +
      // TASKS sub-tab on the parent's view.
      const isParentedChild = typeof parentWorkflowId === 'string' && parentWorkflowId.length > 0;
      // A restore never replaces a creator the operator explicitly opened.
      const keepFocus = isParentedChild || config.voiceOperator === true || backgroundCreated || (restored === true && (s.creatorRequested || s.showHome));
      return {
        jobs: {
          ...s.jobs,
          [id]: {
            id,
            currentSessionId: id,
            config,
            messages: [{
              id: crypto.randomUUID(),
              role: 'system',
              // Cursor bakes effort into the model id (grok-4.5-high) and ignores
              // primaryEffort, so "@ high" would be redundant/misleading — show the
              // id alone. Every other provider carries effort separately.
              content: config.primaryProvider === 'cursor'
                ? `Workflow "${config.name}" active :: ${config.primaryModel}`
                : `Workflow "${config.name}" active :: ${config.primaryModel} @ ${config.primaryEffort}`,
              isStreaming: false,
              timestamp: Date.now(),
            }],
            workers: {},
            reviews: [],
            research: [],
            handoffs: [],
            activity: [],
            sessionChat: [],
            totalCost: 0,
            totalTokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
            totalWorkers: 0,
            // Slot 2 — brand-new workflows skip the SYNCING gate (no server
            // state to reconcile yet). Resumed workflows do too: workflow_created
            // is the authoritative boot for that job.
            snapshotReceived: true,
            ...(resumedVia ? { resumedVia } : {}),
            // §C1 — a resumed workflow was rehydrated from disk/replay; stamp
            // the recovery anchor so the runtime deriver shows the transient
            // 'replay-recovered' badge for REPLAY_RECOVERED_WINDOW_MS.
            ...(resumedVia ? { recoveredAt: Date.now() } : {}),
            ...(isParentedChild ? { parentWorkflowId } : {}),
          },
        },
        activeJobId: keepFocus ? s.activeJobId : id,
        showCreator: keepFocus ? s.showCreator : false,
        creatorRequested: keepFocus ? s.creatorRequested : false,
        showHome: keepFocus ? s.showHome : false,
      };
    }),

  setBakeoffs: (workflowId, bakeoffs) =>
    set((s) => ({
      bakeoffsByWorkflow: {
        ...s.bakeoffsByWorkflow,
        [workflowId]: [...bakeoffs].sort((a, b) => b.createdAt - a.createdAt),
      },
    })),

  upsertBakeoff: (workflowId, bakeoff) =>
    set((s) => {
      const prior = s.bakeoffsByWorkflow[workflowId] ?? [];
      const next = [bakeoff, ...prior.filter((item) => item.id !== bakeoff.id)]
        .sort((a, b) => b.createdAt - a.createdAt);
      return { bakeoffsByWorkflow: { ...s.bakeoffsByWorkflow, [workflowId]: next } };
    }),

  setActiveJob: (id) => {
    if (get().jobs[id]?.config.voiceOperator) {
      useComputerStore.getState().setOpen(true);
      return;
    }
    set((s) => ({
      activeJobId: id,
      activeClusterId: null,    // mutually exclusive — selecting a workflow tab clears any active cluster
      showCreator: false,
      creatorRequested: false,
      showHome: false,
      // Switching tabs closes any open worker detail modal.
      detailWorker: s.detailWorker && s.detailWorker.jobId === id ? s.detailWorker : null,
    }));
    // Provider auto-tint — when `provider-auto` is the active theme, re-resolve
    // the palette to the newly-focused tab's provider so the UI tints to match
    // (Claude clay → OpenAI green → Google blue …). No-op for every other theme.
    const st = get();
    if (st.settings?.themeId === PROVIDER_AUTO_ID) {
      applyThemeForSelection(
        PROVIDER_AUTO_ID,
        st.settings?.fontPackOverride ?? null,
        st.jobs[id]?.config.primaryProvider,
        st.settings?.frostedOverride,
        st.settings?.frostedOpacity,
        brightnessOf(st.settings),
      );
    }
  },

  setClusterState: (clusterId, state) =>
    set((s) => {
      // Slice 6a — keep focusedMember pointing at a still-living member. If
      // the previously-focused member was just removed (or never set), pick
      // the first member as the new default.
      const prevFocus = s.clusterFocusedMember[clusterId];
      const memberIds = new Set(state.members.map((m) => m.workflowId));
      const nextFocus = prevFocus && memberIds.has(prevFocus)
        ? prevFocus
        : (state.members[0]?.workflowId ?? undefined);
      const focusPatch = nextFocus !== prevFocus && nextFocus
        ? { clusterFocusedMember: { ...s.clusterFocusedMember, [clusterId]: nextFocus } }
        : {};
      const priorMemberIds = new Set(s.clusters[clusterId]?.members.map((m) => m.workflowId) ?? []);
      const clusterMemberLabels = { ...s.clusterMemberLabels };
      for (const workflowId of priorMemberIds) delete clusterMemberLabels[workflowId];
      for (const member of state.members) {
        const role = member.role ?? null;
        const prior = s.clusterMemberLabels[member.workflowId];
        clusterMemberLabels[member.workflowId] = prior?.displayName === member.displayName && prior.role === role
          ? prior
          : { displayName: member.displayName, role };
      }
      return {
        clusters: { ...s.clusters, [clusterId]: state },
        clusterMemberLabels,
        ...focusPatch,
      };
    }),

  clearCluster: (clusterId) =>
    set((s) => {
      const { [clusterId]: _gone, ...rest } = s.clusters;
      const { [clusterId]: __, ...restFocus } = s.clusterFocusedMember;
      const clusterMemberLabels = { ...s.clusterMemberLabels };
      for (const member of s.clusters[clusterId]?.members ?? []) {
        delete clusterMemberLabels[member.workflowId];
      }
      return {
        clusters: rest,
        clusterMemberLabels,
        clusterFocusedMember: restFocus,
        activeClusterId: s.activeClusterId === clusterId ? null : s.activeClusterId,
        // If the operator was looking at the now-deleted cluster, fall back
        // to whichever workflow tab was last active (or showCreator if none).
        showCreator: s.activeClusterId === clusterId && !s.activeJobId ? true : s.showCreator,
      };
    }),

  setActiveCluster: (clusterId) =>
    set((s) => ({
      activeClusterId: clusterId,
      activeJobId: clusterId ? null : s.activeJobId,    // mutually exclusive
      showCreator: false,
      creatorRequested: false,
      showHome: false,
    })),

  setClusterFocusedMember: (clusterId, workflowId) =>
    set((s) => {
      const cluster = s.clusters[clusterId];
      if (!cluster) return {};
      if (!cluster.members.some((m) => m.workflowId === workflowId)) return {};
      if (s.clusterFocusedMember[clusterId] === workflowId) return {};
      return { clusterFocusedMember: { ...s.clusterFocusedMember, [clusterId]: workflowId } };
    }),

  setClusterGridSplit: (value) =>
    set(() => {
      const clamped = Math.max(0.1, Math.min(0.9, Number.isFinite(value) ? value : 0.35));
      return { clusterGridSplit: clamped };
    }),

  setClusterCardLayout: (layout) =>
    set(() => ({
      clusterCardLayout: ['auto', 'rows', 'columns', 'grid'].includes(layout) ? layout : 'auto',
    })),

  setHandoffLocks: (cwd, locks) =>
    set((s) => ({
      handoffLocksByCwd: {
        ...s.handoffLocksByCwd,
        [cwd]: locks,
      },
    })),

  // Phase 2.5.1 — also clear activeClusterId so App.tsx's routing branch
  // (which checks activeClusterId BEFORE showCreator) drops the cluster
  // body and renders WorkflowCreator. Without this, +NEW from inside a
  // cluster left the cluster panes visible — both surfaces highlighted
  // but the body unchanged.
  showJobCreator: () => set({ showCreator: true, activeClusterId: null, creatorRequested: true, showHome: false }),
  showHomeView: () => set({ showHome: true, showCreator: false, activeClusterId: null, creatorRequested: false, detailWorker: null }),
  openCreatorWith: (prefill) => set({ creatorPrefill: prefill, showCreator: true, activeClusterId: null, creatorRequested: true, showHome: false }),
  takeCreatorPrefill: () => { const prefill = get().creatorPrefill; if (prefill) set({ creatorPrefill: null }); return prefill; },

  pushNotification: (level, message) =>
    set((s) => ({
      notifications: [
        ...s.notifications.slice(-9),
        { id: crypto.randomUUID(), level, message, createdAt: Date.now() },
      ],
    })),

  dismissNotification: (id) =>
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),

  removeJob: (id) => {
    // Drafts live in draftStore (perf boundary — see stores/draftStore.ts).
    dropDraftForJob(id);
    set((s) => {
      const { [id]: _, ...rest } = s.jobs;
      const atts = s.attachments[id];
      if (atts) {
        for (const a of atts) {
          if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        }
      }
      const { [id]: ___, ...restAtts } = s.attachments;
      const { [id]: ____, ...restBakeoffs } = s.bakeoffsByWorkflow;
      const jobIds = Object.keys(rest).filter((jobId) => !rest[jobId].config.voiceOperator);
      return {
        jobs: rest,
        attachments: restAtts,
        bakeoffsByWorkflow: restBakeoffs,
        activeJobId: s.activeJobId === id ? (jobIds[0] ?? null) : s.activeJobId,
        showCreator: jobIds.length === 0 ? true : s.showCreator,
      };
    });
  },

  changeWorkflowSession: (jobId, newSessionId) =>
    set((s) => updateJob(s, jobId, () => ({ currentSessionId: newSessionId }))),

  replaceJobConfig: (jobId, config) =>
    set((s) => updateJob(s, jobId, () => ({ config }))),

  updateJobPrimary: (jobId, update) =>
    set((s) => updateJob(s, jobId, (j) => {
      const nextConfig = { ...j.config };
      if (update.provider !== undefined) {
        // WorkflowConfig.primaryProvider is undefined for 'claude' (legacy
        // default) — mirror that shape to stay consistent with create flow.
        nextConfig.primaryProvider = update.provider === 'claude' ? undefined : update.provider;
      }
      if (update.model !== undefined) nextConfig.primaryModel = update.model;
      if (update.effort !== undefined) nextConfig.primaryEffort = update.effort;
      if (update.providerAccountRef !== undefined) nextConfig.providerAccountRef = update.providerAccountRef || undefined;
      if (update.autoHandoff !== undefined) nextConfig.autoHandoff = { ...update.autoHandoff };
      if (update.autoFold !== undefined) nextConfig.autoFold = { ...update.autoFold };
      if (update.codexTransport !== undefined) nextConfig.codexTransport = update.codexTransport;
      if (update.codexContextPolicy !== undefined) nextConfig.codexContextPolicy = update.codexContextPolicy;
      if (update.claudeTransport !== undefined) nextConfig.claudeTransport = update.claudeTransport;
      if (update.ultracode !== undefined) nextConfig.ultracode = update.ultracode;
      if (update.webSearchMaxUses !== undefined) nextConfig.webSearchMaxUses = update.webSearchMaxUses;
      if (update.chatWebAccess !== undefined) nextConfig.chatWebAccess = update.chatWebAccess;
      if (update.zaiTransport !== undefined) nextConfig.zaiTransport = update.zaiTransport;
      if (update.claudeNativeCompact !== undefined) nextConfig.claudeNativeCompact = update.claudeNativeCompact;
      if (update.claudeNativeForceInterleavedThinkingBeta !== undefined) nextConfig.claudeNativeForceInterleavedThinkingBeta = update.claudeNativeForceInterleavedThinkingBeta;
      if (update.claudeNativeThinkingDisplay !== undefined) nextConfig.claudeNativeThinkingDisplay = update.claudeNativeThinkingDisplay;
      if (update.nativeCompactAutoContinue !== undefined) nextConfig.nativeCompactAutoContinue = update.nativeCompactAutoContinue;
      if (update.efficiencyToolFilter !== undefined) nextConfig.efficiencyToolFilter = update.efficiencyToolFilter;
      if (update.efficiencyFactForce !== undefined) nextConfig.efficiencyFactForce = update.efficiencyFactForce;
      if (update.efficiencyConfigProtection !== undefined) nextConfig.efficiencyConfigProtection = update.efficiencyConfigProtection;
      if (update.efficiencySandbox !== undefined) nextConfig.efficiencySandbox = update.efficiencySandbox;
      if (update.reviewSafeMode !== undefined) nextConfig.reviewSafeMode = update.reviewSafeMode;
      if (update.outputStyle !== undefined) nextConfig.outputStyle = update.outputStyle;
      // GOAL_NORTHSTAR_PLAN.md — optimistic north-star apply; empty ⇒ clear.
      if (update.goal !== undefined) nextConfig.goal = update.goal.trim() ? update.goal : undefined;
      if (update.pinnedSkills !== undefined) nextConfig.pinnedSkills = update.pinnedSkills.length
        ? update.pinnedSkills.map((s) => ({ ...s }))
        : undefined;
      if (update.remoteEnabled !== undefined) nextConfig.remoteEnabled = update.remoteEnabled;
      if (update.remoteGatesEnabled !== undefined) nextConfig.remoteGatesEnabled = update.remoteGatesEnabled;
      if (update.ollamaParams !== undefined) nextConfig.ollamaParams = update.ollamaParams;
      // When provider OR model changes, the cached resolvedPrimaryModel
      // (echoed by a *previous* turn) is now stale — clear it so the chip
      // shows "awaiting verification" until the next turn lands.
      const patch: Partial<JobState> = { config: nextConfig };
      if (update.provider !== undefined || update.model !== undefined) {
        patch.resolvedPrimaryModel = undefined;
      }
      return patch;
    })),

  setCodebaseMemoryState: (jobId, state) =>
    set((s) => updateJob(s, jobId, (j) => ({
      config: {
        ...j.config,
        codebaseMemory: {
          attached: state.attached,
          indexPath: state.indexPath,
          lastIndexedAt: state.lastIndexedAt,
          fileCount: state.fileCount,
        },
      },
    }))),

  setWorkflowName: (jobId, name) =>
    set((s) => updateJob(s, jobId, (j) => ({
      config: { ...j.config, name: name ?? '' },
    }))),

  // ARCO_OPS_PLAN.md M2 — Genesis. Mirror the server's genesis_seed_updated
  // (seed + advisory readiness + next-field prompt) onto the workflow. The seed
  // also rides config.genesisSeed so it survives reload via the persisted config
  // (the durable home while the workflow is still cwd-less).
  setGenesisSeed: (jobId, payload) =>
    set((s) => updateJob(s, jobId, (j) => ({
      genesisSeed: payload.seed,
      genesisReadiness: payload.readiness,
      genesisNextPrompt: payload.nextPrompt,
      config: { ...j.config, genesisSeed: payload.seed },
    }))),

  // Repoint a workflow's working directory in-place. Fired by workflow_cwd_bound
  // after a genesis scaffold rebinds the cwd from the scratch ideation dir to the
  // real project dir. Mutating config.workingDirectory persists it to localStorage
  // so the next rehydrate resumes the real project (and hides the GENESIS tab).
  setWorkflowCwd: (jobId, cwd) =>
    set((s) => updateJob(s, jobId, (j) => ({
      config: { ...j.config, workingDirectory: cwd },
    }))),

  // Record a completed scaffold result (bound cwd + written docs + optional repo)
  // for a one-shot success notice in the GENESIS tab.
  setGenesisScaffold: (jobId, result) =>
    set((s) => updateJob(s, jobId, () => ({ genesisScaffold: result }))),

  setGenesisAssistStarted: (jobId, payload) =>
    set((s) => updateJob(s, jobId, () => ({
      genesisAssist: { ...payload, status: 'running' },
    }))),

  setGenesisAssistProposed: (jobId, payload) =>
    set((s) => updateJob(s, jobId, () => ({
      genesisAssist: {
        requestId: payload.requestId,
        field: payload.field,
        intent: payload.intent,
        status: payload.error ? 'error' : 'proposed',
        suggestion: payload.suggestion,
        rationale: payload.rationale,
        options: payload.options,
        error: payload.error,
      },
    }))),

  clearGenesisAssist: (jobId, requestId) =>
    set((s) => updateJob(s, jobId, (j) => {
      if (requestId && j.genesisAssist?.requestId !== requestId) return {};
      return { genesisAssist: undefined };
    })),

  // ARCO_OPS_PLAN.md M3 — mirror the server's genesis_creative_armed. Stores the
  // (possibly prefilled) seed + readiness + next prompt like setGenesisSeed, plus the
  // armed flag and the codebase assessment. The seed rides config.genesisSeed so the
  // creative arming survives a reload via the persisted config.
  setGenesisCreative: (jobId, payload) =>
    set((s) => updateJob(s, jobId, (j) => ({
      genesisSeed: payload.seed,
      genesisReadiness: payload.readiness,
      genesisNextPrompt: payload.nextPrompt,
      genesisCreativeArmed: payload.armed,
      genesisCodebase: payload.codebase,
      config: { ...j.config, genesisSeed: payload.seed },
    }))),

  addMessage: (jobId, msg) =>
    set((s) => updateJob(s, jobId, (j) => {
      // Defense-in-depth dedupe by id. Streaming paths use updateMessage /
      // appendToStreamingMessage on an existing id, never re-add. Peer
      // events have deterministic ids (peer-sent-<msgId>) that the server
      // may re-emit on rehydrate; without this guard the chat doubles
      // every WS reconnect. Random-id messages (peer-rejected-<rand>,
      // primary user/assistant turns) never collide so the check is free.
      if (j.messages.some((m) => m.id === msg.id)) return {};
      const next = [...j.messages, msg];
      // Cap the message buffer so a runaway streaming session can't grow it
      // without bound. Older messages survive on disk in the Claude transcript
      // and rehydrate via RESUME if the operator wants them back.
      return { messages: capMessages(next) };
    })),

  removeMessage: (jobId, messageId) =>
    set((s) => updateJob(s, jobId, (j) => ({
      messages: j.messages.filter((m) => m.id !== messageId),
    }))),

  updateMessage: (jobId, messageId, patch) =>
    set((s) => updateJob(s, jobId, (j) => {
      const idx = j.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return {};
      const next = [...j.messages];
      next[idx] = { ...next[idx], ...patch };
      return { messages: next };
    })),

  setStandingGateApprovals: (jobId, approvals) =>
    set((s) => updateJob(s, jobId, () => ({ standingGateApprovals: approvals }))),

  // DEBAG (docs/DEBAG_PLAN.md) — merge resolution state into the synthetic
  // `gate::<gateId>` message's toolUse.input so the inline approval card flips
  // to its resolved state (survives re-render + reflects cross-tab resolution).
  resolveGate: (jobId, gateId, patch) =>
    set((s) => updateJob(s, jobId, (j) => {
      const id = `gate::${gateId}`;
      const idx = j.messages.findIndex((m) => m.id === id);
      if (idx === -1) return {};
      const m = j.messages[idx];
      if (!m.toolUse) return {};
      const next = [...j.messages];
      next[idx] = {
        ...m,
        toolUse: { ...m.toolUse, input: { ...(m.toolUse.input as Record<string, unknown>), ...patch } },
      };
      return { messages: next };
    })),

  // Prepend historical messages (from a resumed session transcript) in front
  // of the current chat. We dedupe by id so repeated hydrations (e.g. a
  // double-fetch) don't multiply the history.
  prependMessages: (jobId, msgs) =>
    set((s) => updateJob(s, jobId, (j) => {
      if (msgs.length === 0) return {};
      const existing = new Set(j.messages.map((m) => m.id));
      const fresh = msgs.filter((m) => !existing.has(m.id));
      if (fresh.length === 0) return {};
      return {
        messages: capMessages([...fresh, ...j.messages], {
          preserveStartCount: Math.min(fresh.length, LOADED_HISTORY_PIN),
        }),
      };
    })),

  appendToStreamingMessage: (jobId, messageId, text) =>
    set((s) => {
      const job = s.jobs[jobId];
      if (!job) return {};
      const messages = [...job.messages];
      const idx = messages.findIndex((m) => m.id === messageId);
      if (idx !== -1) {
        messages[idx] = { ...messages[idx], content: messages[idx].content + text };
      }
      return { jobs: { ...s.jobs, [jobId]: { ...job, messages: capMessages(messages) } } };
    }),

  finalizeMessage: (jobId, messageId) =>
    set((s) => {
      const job = s.jobs[jobId];
      if (!job) return {};
      const messages = [...job.messages];
      const idx = messages.findIndex((m) => m.id === messageId);
      if (idx !== -1) {
        messages[idx] = { ...messages[idx], isStreaming: false };
      }
      return { jobs: { ...s.jobs, [jobId]: { ...job, messages: capMessages(messages) } } };
    }),

  addCost: (jobId, amount) =>
    set((s) => updateJob(s, jobId, (j) => ({ totalCost: j.totalCost + amount }))),

  addTokens: (jobId, tokens) =>
    set((s) => updateJob(s, jobId, (j) => ({ totalTokens: mergeTokens(j.totalTokens, tokens) }))),

  setLastTurnTokens: (jobId, tokens) =>
    set((s) => updateJob(s, jobId, () => ({ lastTurnTokens: tokens }))),

  setLastGenSpeed: (jobId, speed) =>
    set((s) => updateJob(s, jobId, () => ({ lastGenSpeed: speed }))),

  appendTurnTokenUsage: (jobId, usage) =>
    set((s) => updateJob(s, jobId, (j) => {
      const list = (j.turnTokenUsage ?? []).concat(usage);
      const clipped = list.length > TURN_TOKEN_USAGE_CAP ? list.slice(-TURN_TOKEN_USAGE_CAP) : list;
      return { turnTokenUsage: clipped };
    })),

  bumpToolCallsSinceHandoff: (jobId) =>
    set((s) => updateJob(s, jobId, (j) => ({ toolCallsSinceHandoff: (j.toolCallsSinceHandoff ?? 0) + 1 }))),

  resetToolCallsSinceHandoff: (jobId) =>
    set((s) => updateJob(s, jobId, () => ({ toolCallsSinceHandoff: 0 }))),

  setToolCallsSinceCompact: (jobId, count) =>
    set((s) => updateJob(s, jobId, () => ({ toolCallsSinceCompact: count }))),
  bumpSandboxChunkCount: (jobId) =>
    set((s) => updateJob(s, jobId, (j) => ({ sandboxChunkCount: (j.sandboxChunkCount ?? 0) + 1 }))),
  resetSandboxChunkCount: (jobId) =>
    set((s) => updateJob(s, jobId, () => ({ sandboxChunkCount: 0 }))),
  setSandboxChunkCount: (jobId, count) =>
    set((s) => updateJob(s, jobId, () => ({ sandboxChunkCount: count }))),

  recordToolFiltered: (jobId, entry) =>
    set((s) => updateJob(s, jobId, (j) => {
      const next = { ...(j.toolFiltered ?? {}) };
      next[entry.toolUseId] = {
        filterName: entry.filterName,
        originalBytes: entry.originalBytes,
        filteredBytes: entry.filteredBytes,
        ...(entry.rawArtifactPath ? { rawArtifactPath: entry.rawArtifactPath } : {}),
      };
      const keys = Object.keys(next);
      if (keys.length > MAX_TOOL_FILTERED_ENTRIES) {
        for (const k of keys.slice(0, keys.length - MAX_TOOL_FILTERED_ENTRIES)) delete next[k];
      }
      return { toolFiltered: next };
    })),

  // §C3 — replace the diagnostics for one file. Empty items[] drops the key
  // (so the badge count and list shrink when an error is fixed).
  setDiagnostics: (jobId, file, items) =>
    set((s) => updateJob(s, jobId, (j) => {
      const next = { ...(j.diagnosticsByFile ?? {}) };
      if (items.length === 0) delete next[file];
      else next[file] = items;
      return { diagnosticsByFile: next };
    })),

  setModelContextWindow: (jobId, modelContextWindow) =>
    set((s) => updateJob(s, jobId, () => ({ modelContextWindow }))),

  setPrimaryModel: (jobId, resolvedModel) =>
    set((s) => updateJob(s, jobId, () => ({ resolvedPrimaryModel: resolvedModel }))),

  setToolPosture: (jobId, posture) =>
    set((s) => updateJob(s, jobId, () => ({ toolPosture: posture }))),

  // GOAL_NORTHSTAR_PLAN.md — sync the north-star from a server goal_set broadcast
  // (observer sync + reflects the server's capped/cleared value). null ⇒ cleared.
  setWorkflowGoal: (jobId, goal) =>
    set((s) => updateJob(s, jobId, (j) => ({ config: { ...j.config, goal: goal ?? undefined } }))),

  setGoalRun: (jobId, goalRun) =>
    set((s) => updateJob(s, jobId, (j) => ({ config: { ...j.config, goalRun } }))),

  setProjectTrustPrompt: (jobId, prompt) =>
    set((s) => updateJob(s, jobId, () => ({ projectTrustPrompt: prompt }))),

  recordTurnCancelled: (jobId, _reason) =>
    set((s) => updateJob(s, jobId, (j) => ({
      lastTurnCancelledAt: Date.now(),
      // Defensive busy clear. The server emits primary_turn_ended right after
      // turn_cancelled, but if that frame is dropped or arrives out of order,
      // the composer stays stuck in interjection mode. Mirroring endPrimaryTurn
      // here makes the cancel path self-sufficient. Idempotent — endPrimaryTurn
      // re-applies the same state on the trailing frame.
      busy: false,
      turnStartedAt: undefined,
      messages: capMessages(j.messages.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m))),
    }))),

  setWorkerModel: (jobId, workerId, resolvedModel) =>
    set((s) => {
      const job = s.jobs[jobId];
      if (!job || !job.workers[workerId]) return {};
      return {
        jobs: {
          ...s.jobs,
          [jobId]: {
            ...job,
            workers: {
              ...job.workers,
              [workerId]: { ...job.workers[workerId], resolvedModel },
            },
          },
        },
      };
    }),

  spawnWorker: (jobId, workerId, model, effort, task, provider) =>
    set((s) => {
      const now = Date.now();
      return updateJob(s, jobId, (j) => ({
        workers: {
          ...j.workers,
          [workerId]: {
            id: workerId,
            model,
            effort,
            status: 'running',
            task,
            output: '',
            thinking: '',
            toolCalls: [],
            spawnedAt: now,
            lastActivityAt: now,
            provider,
          },
        },
        totalWorkers: j.totalWorkers + 1,
      }));
    }),

  appendWorkerOutput: (jobId, workerId, text) =>
    set((s) => {
      const job = s.jobs[jobId];
      if (!job || !job.workers[workerId]) return {};
      const worker = job.workers[workerId];
      // Client-side cap on retained output. Server already enforces a 5MB
      // worker-output ceiling; this is a tighter UI-side limit so the
      // browser tab doesn't carry megabytes per active worker. Operator can
      // re-fetch the full output on demand later if we add that endpoint.
      let output = worker.output;
      if (output.length >= MAX_WORKER_OUTPUT_BYTES_CLIENT) {
        // Already capped; drop further chunks silently.
      } else if (output.length + text.length > MAX_WORKER_OUTPUT_BYTES_CLIENT) {
        const fit = MAX_WORKER_OUTPUT_BYTES_CLIENT - output.length;
        output = output + text.slice(0, fit) + '\n[client-side display truncated at 256KB — full output on server]';
      } else {
        output = output + text;
      }
      return {
        jobs: {
          ...s.jobs,
          [jobId]: {
            ...job,
            workers: {
              ...job.workers,
              [workerId]: { ...worker, output, lastActivityAt: Date.now() },
            },
          },
        },
      };
    }),

  appendWorkerThinking: (jobId, workerId, text) =>
    set((s) => {
      const job = s.jobs[jobId];
      if (!job || !job.workers[workerId]) return {};
      const worker = job.workers[workerId];
      const thinking = capWorkerText(
        worker.thinking + text,
        MAX_WORKER_THINKING_BYTES_CLIENT,
        'worker thinking',
      );
      return {
        jobs: {
          ...s.jobs,
          [jobId]: {
            ...job,
            workers: {
              ...job.workers,
              [workerId]: { ...worker, thinking, lastActivityAt: Date.now() },
            },
          },
        },
      };
    }),

  recordWorkerToolCall: (jobId, workerId, tool, input) =>
    set((s) => {
      const job = s.jobs[jobId];
      if (!job || !job.workers[workerId]) return {};
      const worker = job.workers[workerId];
      const now = Date.now();
      const next = [...worker.toolCalls, { tool, input: capToolInputText(input), timestamp: now }];
      // Keep only the most recent N tool calls. A runaway worker that fires
      // thousands of tool calls otherwise grows this array without bound and
      // re-renders the worker card on every push.
      const trimmed = next.length > MAX_WORKER_TOOL_CALLS ? next.slice(-MAX_WORKER_TOOL_CALLS) : next;
      return {
        jobs: {
          ...s.jobs,
          [jobId]: {
            ...job,
            workers: {
              ...job.workers,
              [workerId]: {
                ...worker,
                toolCalls: trimmed,
                lastActivityAt: now,
              },
            },
          },
        },
      };
    }),

  completeWorker: (jobId, workerId, costUsd, durationMs, tokens, permissionDenials) =>
    set((s) => {
      const job = s.jobs[jobId];
      if (!job) return {};
      const workers = {
        ...job.workers,
        [workerId]: {
          ...job.workers[workerId],
          status: 'completed' as const,
          costUsd,
          durationMs,
          tokens,
          permissionDenials,
          lastActivityAt: Date.now(),
        },
      };
      return {
        jobs: {
          ...s.jobs,
          [jobId]: {
            ...job,
            workers: capWorkers(workers),
            totalCost: job.totalCost + costUsd,
            totalTokens: mergeTokens(job.totalTokens, tokens),
          },
        },
      };
    }),

  failWorker: (jobId, workerId) =>
    set((s) => {
      const job = s.jobs[jobId];
      if (!job) return {};
      const workers = {
        ...job.workers,
        [workerId]: { ...job.workers[workerId], status: 'failed' as const, lastActivityAt: Date.now() },
      };
      return { jobs: { ...s.jobs, [jobId]: { ...job, workers: capWorkers(workers) } } };
    }),

  setWorkerActivity: (jobId, workerId, activity) =>
    set((s) => {
      const job = s.jobs[jobId];
      if (!job || !job.workers[workerId]) return {};
      const worker = job.workers[workerId];
      return {
        jobs: {
          ...s.jobs,
          [jobId]: {
            ...job,
            workers: {
              ...job.workers,
              [workerId]: {
                ...worker,
                activity: { ...activity, probedAt: Date.now() },
                // Treat any /proc activity as a fresh "we heard from this
                // worker" signal — keeps the idle-Ns indicator honest even
                // when the CLI is silent on stdout.
                lastActivityAt: Date.now(),
              },
            },
          },
        },
      };
    }),

  // Slot 1 — apply a server-truth snapshot on reconnect. Overwrite workers
  // with the server's map (clears ghost "running" cards the client held over
  // a WS drop), finalize any streaming messages when the server isn't busy
  // (unsticks the cancel button), and append any transcriptTail entries the
  // client doesn't already have by a content signature. Signature-dedup
  // rather than id-dedup because server-loaded JSONL rows use synthetic ids
  // (`hist-N`) that don't match the client's crypto UUIDs.
  applyWorkflowSnapshot: (jobId, workers, busy, transcriptTail) =>
    set((s) => {
      const job = s.jobs[jobId];
      if (!job) return {};
      const sig = (m: ChatMessage) => `${m.role}::${m.content.trim().slice(0, 300)}`;
      const existing = new Set(job.messages.map(sig));
      const additions = transcriptTail.filter((m) => !existing.has(sig(m)));
      const messages = busy
        ? job.messages
        : job.messages.map((m) => m.isStreaming ? { ...m, isStreaming: false } : m);
      return {
        jobs: {
          ...s.jobs,
          [jobId]: {
            ...job,
            workers: capWorkers(workers),
            messages: capMessages(additions.length > 0 ? [...messages, ...additions] : messages),
            // Snapshot's `busy` is authoritative on reconnect — sticks the
            // composer indicator on if the server was still mid-turn when
            // the client dropped.
            busy,
            // If we reconnected into an in-flight turn but have no local
            // turnStartedAt (browser reloaded), seed it with now so the
            // elapsed counter resumes from 0 rather than spiking negative.
            ...(busy && !job.turnStartedAt ? { turnStartedAt: Date.now() } : {}),
            ...(!busy ? { turnStartedAt: undefined } : {}),
          },
        },
      };
    }),

  updateLastSeq: (jobId, seq, force) =>
    set((s) => updateJob(s, jobId, (j) => ({
      lastSeq: force ? seq : Math.max(j.lastSeq ?? 0, seq),
    }))),

  markSnapshotReceived: (jobId) =>
    set((s) => updateJob(s, jobId, () => ({ snapshotReceived: true }))),

  upsertReview: (jobId, reviewId, patch) =>
    set((s) => updateJob(s, jobId, (j) => {
      const idx = j.reviews.findIndex((r) => r.reviewId === reviewId);
      if (idx === -1) {
        const seed: ReviewEntry = {
          reviewId,
          artifactName: patch.artifactName ?? '',
          reviewer: patch.reviewer ?? { provider: 'claude', model: 'unknown', effort: 'high' },
          startedAt: patch.startedAt ?? Date.now(),
          ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
          ...(patch.verdict ? { verdict: patch.verdict } : {}),
          ...(patch.error ? { error: patch.error } : {}),
        };
        return { reviews: [...j.reviews, seed] };
      }
      return {
        reviews: j.reviews.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
      };
    })),

  upsertResearch: (jobId, researchId, patch) =>
    set((s) => updateJob(s, jobId, (j) => {
      const list = j.research ?? [];
      const idx = list.findIndex((r) => r.researchId === researchId);
      if (idx === -1) {
        const seed: ResearchEntry = {
          researchId,
          artifactName: patch.artifactName ?? '',
          researcher: patch.researcher ?? { provider: 'claude', model: 'unknown', effort: 'high' },
          topic: patch.topic ?? '',
          maxRounds: patch.maxRounds ?? 0,
          isFollowUp: patch.isFollowUp ?? false,
          startedAt: patch.startedAt ?? Date.now(),
          ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
          ...(patch.roundsUsed !== undefined ? { roundsUsed: patch.roundsUsed } : {}),
          ...(patch.sourceCount !== undefined ? { sourceCount: patch.sourceCount } : {}),
          ...(patch.progressNote ? { progressNote: patch.progressNote } : {}),
          ...(patch.error ? { error: patch.error } : {}),
        };
        return { research: [...list, seed] };
      }
      return {
        research: list.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
      };
    })),

  beginPrimaryTurn: (jobId, startedAt) =>
    set((s) => updateJob(s, jobId, () => ({
      busy: true,
      turnStartedAt: startedAt,
      // Hide the cache-warmth timer while the turn runs — it'll restart from
      // 5:00 in endPrimaryTurn.
      lastTurnEndedAt: undefined,
      // Fresh turn ⇒ fresh activity feed. The prior turn's tool uses /
      // thinking are still in events.jsonl if we ever need to pull them back.
      activity: [],
      // Drop any prior ultracode fleet panel — this turn starts its own.
      ultracodeFleet: null,
    }))),

  endPrimaryTurn: (jobId) =>
    set((s) => updateJob(s, jobId, (j) => ({
      busy: false,
      turnStartedAt: undefined,
      lastTurnEndedAt: Date.now(),
      // Finalize any still-streaming messages. Normal `primary_complete`
      // flow finalizes the live message, but the cancel path skips that —
      // leaving `isStreaming: true` stuck on the last chunk, which keeps
      // TerminalInput's isBusy = (busy || hasActiveWorkers || hasStreaming)
      // pinned true and locks the composer in interjection mode even after
      // busy clears. Matches applyWorkflowSnapshot's busy=false handling.
      messages: j.messages.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m)),
    }))),

  appendActivity: (jobId, entry) =>
    set((s) => updateJob(s, jobId, (j) => {
      // Defensive init: jobs that existed in memory before the activity
      // field shipped won't have `activity: []` on them, and Array spread
      // would crash on undefined.
      const existing = Array.isArray(j.activity) ? j.activity : [];
      const cappedEntry = capActivityEntry(entry);
      if (entry.kind === 'tool_use' && (entry.itemId || entry.toolUseId)) {
        const idx = existing.findIndex((e) =>
          e.kind === 'tool_use' &&
          ((entry.itemId && e.itemId === entry.itemId) ||
            (entry.toolUseId && e.toolUseId === entry.toolUseId)));
        if (idx !== -1) {
          const next = [...existing];
          next[idx] = {
            ...next[idx],
            ...cappedEntry,
            input: cappedEntry.input || next[idx].input,
            output: cappedEntry.output || next[idx].output,
            at: cappedEntry.at,
          };
          return { activity: next };
        }
      }
      const next = [...existing, cappedEntry];
      // Never touch busy / turnStartedAt here. Prior iterations auto-corrected
      // busy=true on any tool_use / thinking arrival, which misfired on
      // replayed events: server event-log replay re-emits old primary_tool_use
      // rows on every reconnect, and this path stamped turnStartedAt=Date.now()
      // against each one — producing a permanent stuck "CHURNING Nm Ns"
      // indicator for any workflow whose events.jsonl has orphaned post-turn
      // events. The snapshot (applyWorkflowSnapshot) is the authoritative
      // signal for busy + turnStartedAt on reconnect; primary_turn_started/
      // primary_turn_ended drive it during a live turn.
      return {
        activity: next.length > MAX_ACTIVITY_ENTRIES ? next.slice(-MAX_ACTIVITY_ENTRIES) : next,
      };
    })),

  clearActivity: (jobId) =>
    set((s) => updateJob(s, jobId, () => ({ activity: [] }))),

  // ULTRACODE_PLAN.md — replace the fleet snapshot in place (latest wins).
  setUltracodeFleet: (jobId, snapshot) =>
    set((s) => updateJob(s, jobId, () => ({ ultracodeFleet: snapshot }))),

  setPrimaryBackgroundJobs: (jobId, jobs) =>
    set((s) => updateJob(s, jobId, () => ({ primaryBackgroundJobs: jobs }))),

  setContextUsage: (jobId, usage) =>
    set((s) => updateJob(s, jobId, () => ({ contextUsage: usage }))),

  // 2026-05-12 — fired on handoff_complete so the composer's CTX bar
  // drops the stale Claude-side estimator readout. Without this, swapping
  // a worker's primary from Claude to Codex via handoff leaves the bar
  // rendering the pre-handoff Claude window + cache TTL until the next
  // Claude turn would (never) fire. lastTurnTokens is also cleared so the
  // Codex fallback path (which reads lastTurnTokens) doesn't render
  // pre-handoff numbers attributed to the new provider.
  clearTurnUsageState: (jobId) =>
    set((s) => updateJob(s, jobId, () => ({ contextUsage: undefined, lastTurnTokens: undefined, lastGenSpeed: undefined }))),

  // NATIVE_COMPACTION_PLAN Phase 3 — compaction takeover lifecycle. The takeover
  // overlay reads `compacting`; the post-compaction banner reads `compactedResume`.
  beginCompacting: (jobId, foldedTurns) =>
    set((s) => updateJob(s, jobId, () => ({
      compacting: true,
      compactingFoldedTurns: foldedTurns,
      compactedResume: null,
    }))),
  endCompacting: (jobId, foldedTurns) =>
    set((s) => updateJob(s, jobId, () => ({
      compacting: false,
      compactingFoldedTurns: undefined,
      compactedResume: { foldedTurns, at: Date.now() },
    }))),
  clearCompacting: (jobId) =>
    set((s) => updateJob(s, jobId, () => ({
      compacting: false,
      compactingFoldedTurns: undefined,
      compactedResume: null,
    }))),

  setClaudeSessionId: (jobId, sessionId) =>
    set((s) => updateJob(s, jobId, () => ({ claudeSessionId: sessionId }))),

  setSessionMetadata: (jobId, metadata) =>
    set((s) => updateJob(s, jobId, (j) => ({
      sessionMetadata: metadata,
      ...(metadata?.opaqueContext ? { contextUsage: undefined, lastTurnTokens: undefined } : {}),
    }))),

  // Drafts moved to stores/draftStore.ts (perf boundary — a keystroke used to
  // notify every appStore subscriber; see that file for the measurements).
  // These stay as delegating wrappers so existing call sites — ReviewTab, the
  // terminal→composer bridge, the seed-prompt handler in handleServerMessage —
  // keep working unchanged. Behaviour is identical: same synchronous write,
  // same empty-string tombstoning.
  setDraft: (jobId, text) => useDraftStore.getState().setDraft(jobId, text),

  clearDraft: (jobId) => useDraftStore.getState().clearDraft(jobId),

  addAttachment: (jobId, att) =>
    set((s) => {
      // An upload that resolves after its tab closed must not resurrect the
      // entry — nothing would ever revoke its preview URL.
      if (!s.jobs[jobId]) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
        return {};
      }
      const existing = s.attachments[jobId] ?? [];
      return { attachments: { ...s.attachments, [jobId]: [...existing, att] } };
    }),

  removeAttachment: (jobId, index) =>
    set((s) => {
      const existing = s.attachments[jobId];
      if (!existing || index < 0 || index >= existing.length) return {};
      const removed = existing[index];
      if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      const next = existing.filter((_, i) => i !== index);
      if (next.length === 0) {
        const { [jobId]: _, ...rest } = s.attachments;
        return { attachments: rest };
      }
      return { attachments: { ...s.attachments, [jobId]: next } };
    }),

  clearAttachments: (jobId) =>
    set((s) => {
      const existing = s.attachments[jobId];
      if (!existing || existing.length === 0) return {};
      for (const a of existing) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
      const { [jobId]: _, ...rest } = s.attachments;
      return { attachments: rest };
    }),

  wsSendRaw: null,
  setWsSendRaw: (fn) => set({ wsSendRaw: fn }),

  flashTarget: null,
  flashChatMessage: (jobId, messageId) =>
    set({ flashTarget: { jobId, messageId, at: Date.now() } }),

  appendHistoryEvent: (jobId, entry) =>
    set((s) => updateJob(s, jobId, (j) => {
      const existing = j.historyEvents ?? [];
      // Dedup by seq: replay can re-emit (e.g. snapshot fallback resends a
      // line we already received live). Keep the first observation so the
      // wall-clock timestamp from live receive isn't overwritten by a
      // (possibly stale) replay value.
      if (existing.some((e) => e.seq === entry.seq)) return {};
      // Phase 8 — labels carry `anchorSeq` (the row they were pinned to) and
      // sort by that, not their own seq. Resolve `at` from the anchor row so
      // the label timestamp matches the moment it marks. Falls back to
      // `pinnedAt` if the anchor hasn't streamed in yet (rare; replay sends
      // events in seq order so the anchor lands first).
      let resolved = entry;
      if (entry.category === 'label' && entry.anchorSeq !== undefined && entry.at === undefined) {
        const anchor = existing.find((e) => e.seq === entry.anchorSeq);
        resolved = { ...entry, at: anchor?.at ?? entry.pinnedAt };
      }
      // Sort by anchor-or-own-seq, with labels placed after their anchor row
      // on a tie. Always re-sort so out-of-order arrivals (live event during
      // replay, label whose anchor arrives later) settle into the right slot.
      const next = [...existing, resolved].sort(compareHistoryEntries);
      // Cap at 1000 entries — drop oldest. v1 tabs sit well under this;
      // virtualization waits for Phase 9 if it ever bites.
      const capped = next.length > 1000 ? next.slice(-1000) : next;
      return { historyEvents: capped };
    })),

  recordTaskStarted: (jobId, payload) =>
    set((s) => updateJob(s, jobId, (j) => {
      const existing = j.taskChildren ?? {};
      // Inject a synthetic chat message so the inline card renders at the
      // chronological position of the Task call. ChatMessage already
      // special-cases `toolUse` rows; the dedicated Task render swaps in
      // when `tool === 'Task'`.
      const chatMsg: ChatMessage = {
        id: `task::${payload.toolUseId}`,
        role: 'assistant',
        content: '',
        isStreaming: false,
        timestamp: payload.startedAt,
        toolUse: {
          tool: 'Task',
          input: { description: payload.description, taskId: payload.taskId, childWorkflowId: payload.childWorkflowId },
          toolUseId: payload.toolUseId,
        },
      };
      const alreadyInMessages = j.messages.some((m) => m.id === chatMsg.id);
      const nextMessages = alreadyInMessages ? j.messages : capMessages([...j.messages, chatMsg]);
      // Preserve a prior entry's settled fields if `task_started` somehow
      // re-fires after settle (defensive against replay quirks); otherwise
      // seed a fresh `running` row.
      const seed: TaskChildEntry = {
        taskId: payload.taskId,
        childWorkflowId: payload.childWorkflowId,
        toolUseId: payload.toolUseId,
        description: payload.description,
        phase: 'running',
        startedAt: payload.startedAt,
      };
      return {
        taskChildren: {
          ...existing,
          [payload.taskId]: { ...seed, ...(existing[payload.taskId] ?? {}) },
        },
        messages: nextMessages,
      };
    })),

  recordTaskStatus: (jobId, payload) =>
    set((s) => updateJob(s, jobId, (j) => {
      const existing = j.taskChildren ?? {};
      const prior = existing[payload.taskId];
      // Out-of-order status without a prior start can happen on a partial
      // events.jsonl replay (start dropped, status survived). Skip rather
      // than fabricate a half-row — the next reconnect's snapshot will
      // restore the full state.
      if (!prior) return {};
      return {
        taskChildren: {
          ...existing,
          [payload.taskId]: {
            ...prior,
            phase: payload.phase,
            elapsedMs: payload.elapsedMs,
            ...(payload.phase !== 'running' ? { settledAt: prior.startedAt + payload.elapsedMs } : {}),
            ...(payload.summary !== undefined ? { summary: payload.summary } : {}),
          },
        },
      };
    })),

  promoteTaskChild: (childWorkflowId) =>
    set((s) => {
      const child = s.jobs[childWorkflowId];
      if (!child || !child.parentWorkflowId) return {};
      return {
        jobs: {
          ...s.jobs,
          [childWorkflowId]: { ...child, promoted: true },
        },
        activeJobId: childWorkflowId,
        showCreator: false,
        creatorRequested: false,
        showHome: false,
      };
    }),

  setEarlierState: (jobId, patch) =>
    set((s) => updateJob(s, jobId, () => patch)),

  upsertSessionChat: (jobId, entry, attachments) =>
    set((s) => updateJob(s, jobId, (j) => {
      // Tool-use entries get a stable key from the Anthropic toolUseId so
      // replays on reconnect dedup against the initial load. Message entries
      // use their JSONL uuid when present, falling back to role + content.
      let msg: ChatMessage;
      if (entry.kind === 'tool_use') {
        const sig = `tool::${entry.toolUseId}`;
        if (j.sessionChat?.some((m) => m.id === sig)) return {};
        msg = {
          id: sig,
          role: 'assistant',
          content: '',
          isStreaming: false,
          timestamp: entry.timestamp,
          toolUse: {
            tool: entry.tool,
            input: entry.input,
            filePath: entry.filePath,
            toolUseId: entry.toolUseId,
          },
        };
      } else {
        const sig = entry.uuid ?? `${entry.role}::${entry.content.slice(0, 120).replace(/\s+/g, ' ')}`;
        if (j.sessionChat?.some((m) => m.id === sig)) return {};
        // `attachments` is inherited from optimistic queued messages the
        // session_entry is about to replace. Claude's JSONL doesn't preserve
        // the uploaded file paths (only the processed image content embedded
        // inline in its own internal representation), so without carrying
        // them across here the attachment pills vanish once the real entry
        // lands. See useWebSocket.ts session_entry case.
        msg = {
          id: sig,
          role: entry.role,
          content: entry.content,
          isStreaming: false,
          timestamp: entry.timestamp,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        };
      }
      const existing = Array.isArray(j.sessionChat) ? j.sessionChat : [];
      const next = [...existing, msg];
      const oldestExistingTs = existing.reduce(
        (acc, m) => Math.min(acc, typeof m.timestamp === 'number' ? m.timestamp : Infinity),
        Infinity,
      );
      const isEarlierPageRow = typeof msg.timestamp === 'number' && msg.timestamp < oldestExistingTs;
      return {
        sessionChat: capSessionChat(next, {
          preserveOldestCount: isEarlierPageRow ? LOADED_HISTORY_PIN : 0,
        }),
      };
    })),

  setPlan: (jobId, plan) =>
    set((s) => updateJob(s, jobId, () => ({ plan }))),

  setPreview: (jobId, preview, freshlyBound) =>
    set((s) => updateJob(s, jobId, (job) => {
      const wasPort = job.preview?.port;
      const isPort = preview?.port;
      // Only arm previewUnread on a real fresh bind that produced a port the
      // operator hasn't seen yet (different port, or first bind ever).
      // Manual binds skip the arm — the operator typed it, they're already
      // looking. Hydration replays pass freshlyBound=undefined/false.
      const arm = preview && freshlyBound === true && !preview.manual && wasPort !== isPort;
      return { preview, ...(arm ? { previewUnread: true } : {}) };
    })),

  setPreviewHistory: (jobId, entries) =>
    set((s) => updateJob(s, jobId, () => ({ previewHistory: entries }))),

  markPreviewSeen: (jobId) =>
    set((s) => updateJob(s, jobId, () => ({ previewUnread: false }))),

  setPreviewCapturing: (jobId, capturing) =>
    set((s) => updateJob(s, jobId, () => ({ previewCapturing: capturing }))),

  // Prepend the newest capture; cap the in-memory list so a long session doesn't
  // accumulate unbounded records (the artifacts persist on disk regardless).
  addPreviewCapture: (jobId, capture) =>
    set((s) => updateJob(s, jobId, (job) => ({
      previewCapturing: false,
      previewCaptures: [capture, ...(job.previewCaptures ?? [])].slice(0, 10),
    }))),

  setPendingPlanCapture: (jobId, mode) =>
    set((s) => updateJob(s, jobId, () => ({ pendingPlanCapture: mode }))),

  setPlanCandidate: (jobId, candidate) =>
    set((s) => updateJob(s, jobId, () => ({ planCandidate: candidate }))),

  upsertHandoff: (jobId, handoffId, patch) =>
    set((s) => updateJob(s, jobId, (j) => {
      const idx = j.handoffs.findIndex((h) => h.handoffId === handoffId);
      if (idx === -1) {
        const seed: HandoffEntry = {
          handoffId,
          mode: patch.mode ?? 'fresh-summarizer',
          artifactName: patch.artifactName ?? '',
          startedAt: patch.startedAt ?? Date.now(),
          ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
          ...(patch.archivedSessionId ? { archivedSessionId: patch.archivedSessionId } : {}),
          ...(patch.newSessionId ? { newSessionId: patch.newSessionId } : {}),
          ...(patch.turnCount !== undefined ? { turnCount: patch.turnCount } : {}),
          ...(patch.error ? { error: patch.error } : {}),
        };
        return { handoffs: [...j.handoffs, seed] };
      }
      return {
        handoffs: j.handoffs.map((h, i) => (i === idx ? { ...h, ...patch } : h)),
      };
    })),
}), {
  name: 'arco-jobs',
  // Lazy-stringify storage — serialization happens once per debounced flush,
  // NOT per set(). Do not swap back to createJSONStorage(...): that pays a
  // full-state JSON.stringify on every store update (see persistence.ts).
  storage: debouncedJSONStorage(),
  // Slim partialize. Workers carry the most weight (5MB output cap each plus
  // tool logs and activity ticks every 1.5s); persisting them on every state
  // update is what blew up the browser tab's memory in the 2026-04-16 hard-
  // lock incident. Strip workers entirely — the server keeps the canonical
  // run state and rehydrate_workflows resends what we need on reconnect.
  // Same for the per-turn QC log and project-memory snapshot — both are
  // server-pushed on reconnect via memory_updated / quality_verdicts.
  partialize: (s) => ({
    jobs: Object.fromEntries(
      Object.entries(s.jobs).filter(([, j]) => !j.config.incognito).map(([id, j]) => [id, {
        id: j.id,
        currentSessionId: j.currentSessionId,
        config: j.config,
        // Keep at most the last 200 chat messages to bound persistence cost.
        // Older messages are rehydratable from the Claude transcript on the
        // disk if the operator picks RESUME on a long session.
        messages: j.messages.slice(-200),
        totalCost: j.totalCost,
        totalTokens: j.totalTokens,
        totalWorkers: j.totalWorkers,
        resolvedPrimaryModel: j.resolvedPrimaryModel,
        // Keep review history with the tab — cheap (metadata only; artifact
        // body lives on disk). Cap to avoid unbounded growth across hundreds
        // of reviews in a single tab.
        reviews: j.reviews.slice(-40),
        research: (j.research ?? []).slice(-40),
        handoffs: j.handoffs.slice(-40),
        // workers intentionally stripped — server pushes fresh snapshots on reconnect.
        workers: {} as Record<string, never>,
        // Slot 5 — persist the highest server-stamped seq so reconnect can
        // ask the server for events we missed since this point.
        lastSeq: j.lastSeq,
        // Phase 7b — Task lifecycle state. The synthetic Task chat rows
        // ride along in `messages`, but the matching `taskChildren` lookup
        // entries (phase + elapsed + summary) aren't replayed on rehydrate
        // (events.jsonl replay is gated on seq > clientLastSeq, so a refresh
        // after settle gets nothing). Persist them so TaskCard reads the
        // settled phase rather than falling back to the 'running' default.
        // parentWorkflowId/promoted persist so child workflows stay scoped
        // to their parent (TabBar filter) across refreshes.
        ...(j.taskChildren ? { taskChildren: j.taskChildren } : {}),
        ...(j.parentWorkflowId ? { parentWorkflowId: j.parentWorkflowId } : {}),
        ...(j.promoted ? { promoted: j.promoted } : {}),
        // Phase 8 — persist the last 500 narrative events so refresh on a
        // settled workflow still renders HISTORY. Replay only resends
        // events with seq > clientLastSeq, so without persistence a quiet
        // tab would come up empty until the operator sent another turn.
        ...(j.historyEvents && j.historyEvents.length > 0
          ? { historyEvents: j.historyEvents.slice(-500) }
          : {}),
      }]),
    ),
    activeJobId: s.activeJobId && !s.jobs[s.activeJobId]?.config.incognito ? s.activeJobId : null,
    activeClusterId: s.activeClusterId,
    // CLUSTER_MODE_PLAN.md Phase 2 — persist the cluster mirror so a reload
    // restores the cluster tab's [N] badge before the WS reconnects + the
    // server pushes a fresh cluster_state. The on-WS-open subscribe will
    // overwrite each entry with authoritative server state shortly after.
    clusters: s.clusters,
    clusterGridSplit: s.clusterGridSplit,
    clusterCardLayout: s.clusterCardLayout,
    showCreator: s.showCreator || Boolean(s.activeJobId && s.jobs[s.activeJobId]?.config.incognito),
    showHome: s.showHome,
  }),
  merge: (persisted, current) => {
    const saved = (persisted ?? {}) as Partial<AppState>;
    return { ...current, ...saved, showHome: saved.showHome ?? (!saved.activeJobId && !saved.activeClusterId) };
  },
  onRehydrateStorage: () => (state) => {
    if (!state) return;
    // Older builds persisted Computer as the active project tab. Keep its
    // history, but restore a workbench target for the voice tools.
    if (state.activeJobId && state.jobs[state.activeJobId]?.config.voiceOperator) {
      state.activeJobId = null;
      if (!state.activeClusterId || !state.clusters[state.activeClusterId]) {
        const members = new Set(Object.values(state.clusters).flatMap((c) => c.members.map((m) => m.workflowId)));
        state.activeJobId = Object.values(state.jobs).find((j) => !j.config.voiceOperator
          && (!j.parentWorkflowId || j.promoted) && !members.has(j.id))?.id ?? null;
        state.activeClusterId = state.activeJobId ? null : Object.keys(state.clusters)[0] ?? null;
      }
      state.showCreator = !state.activeJobId && !state.activeClusterId;
    }
    // Drop queued optimistic entries older than 30s. A genuinely-just-queued
    // message transitions to visible-in-chat within seconds of the server
    // drain (removed by the session_entry handler in useWebSocket), so the
    // optimistic never legitimately persists for 30s+. `queued:true` + age
    // > 30s is definitionally a stale entry — either a pre-fix ghost that
    // never got cleared, or a server restart that lost its in-memory queue
    // while the client retained the optimistic. Real content already lives
    // in sessionChat (rebuilt from Claude's JSONL on reconnect); the
    // optimistic was always just a render-placeholder. See
    // docs/QUEUE_FIX_PLAN.md — Change C.
    const STALE_QUEUED_MS = 30_000;
    const now = Date.now();
    for (const job of Object.values(state.jobs)) {
      // One-time historical dedupe — earlier builds of the peer_message_*
      // WS handler didn't dedupe by msgId, so rehydrate-on-subscribe +
      // tsx-watch restarts piled hundreds of identical `peer-sent-<msgId>`
      // / `peer-recv-<msgId>` rows into the persisted chat. Strip them on
      // restore so a reload clears the historical noise; the WS handler
      // now blocks fresh duplicates at intake time.
      const seenIds = new Set<string>();
      job.messages = job.messages
        .filter((m) => {
          if (seenIds.has(m.id)) return false;
          seenIds.add(m.id);
          return true;
        })
        .filter((m) => !(m.queued && (m.timestamp ?? 0) < now - STALE_QUEUED_MS))
        .map((m) => m.isStreaming ? { ...m, isStreaming: false } : m);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j = job as any;
      if (!j.workers) j.workers = {};
      if (!Array.isArray(j.reviews)) j.reviews = [];
      if (!Array.isArray(j.research)) j.research = [];
      if (!Array.isArray(j.handoffs)) j.handoffs = [];
      if (!Array.isArray(j.activity)) j.activity = [];
      if (!Array.isArray(j.historyEvents)) j.historyEvents = [];
      Object.assign(j, trimJobMemory(j as JobState));
      // Persisted `busy`/`turnStartedAt` would go stale across reloads —
      // the authoritative snapshot arrives within seconds of WS connect.
      j.busy = false;
      j.turnStartedAt = undefined;
      // Cache-warmth timer would lie across a reload: the underlying server
      // session is alive but the persisted timestamp doesn't reflect actual
      // cache state (which may have ticked over while the tab was closed).
      // Force "cold" until the next turn completes and gives us a fresh stamp.
      j.lastTurnEndedAt = undefined;
      // Persisted jobs always await a fresh server snapshot on restore.
      j.snapshotReceived = false;
      // sessionChat is rebuilt from session_entry WS messages on reconnect.
      j.sessionChat = [];
    }
  },
}));

if (typeof window !== 'undefined') {
  const arcoWindow = window as Window & {
    __ARCO_MEMORY_STATS__?: () => AppMemoryStats;
    __ARCO_TRIM_MEMORY__?: () => AppMemoryStats;
    __ARCO_TRIM_MEMORY_TIMER__?: ReturnType<typeof setInterval>;
  };
  arcoWindow.__ARCO_MEMORY_STATS__ = () => getAppMemoryStats(useAppStore.getState());
  arcoWindow.__ARCO_TRIM_MEMORY__ = () => {
    useAppStore.getState().trimMemory();
    return getAppMemoryStats(useAppStore.getState());
  };
  if (!arcoWindow.__ARCO_TRIM_MEMORY_TIMER__) {
    arcoWindow.__ARCO_TRIM_MEMORY_TIMER__ = setInterval(() => {
      useAppStore.getState().trimMemory();
    }, 30_000);
  }
}
