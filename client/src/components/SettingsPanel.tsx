import { UI_SCALES, DEFAULT_UI_SCALE } from '@arco/shared';
import { AppVersionSection } from './settings/AppVersionSection';
import { EndpointHelp } from './EndpointHelp';
import { SettingsLayout, SettingsSection } from './settings/SettingsLayout';
import { MediaAccessSettings } from './MediaAccessSettings';
import { VoiceSetupSettings } from './VoiceSetupSettings';
import { DeepSeekControls } from './DeepSeekControls';
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { useStartupStore } from '../stores/startupStore';
import type { AuthStatus, AuthStatusByProvider, AuthLoginTarget, AuthLoginResult, ArcoSettings, ProviderName, ModelName, EffortLevel, ProviderAccountProfile, DiscoveredEndpoint, EndpointDiscoverResponse } from '@arco/shared';
import { RunAsPicker, type RunAsSelection } from './RunAsPicker';
import { LoginCommand } from './LoginCommand';
import { THEME_REGISTRY, DEFAULT_THEME_ID } from '../themes/registry';
import type { Theme } from '../themes/types';
import { FONT_PACKS } from '../themes/fontPacks';
import { Panel } from './primitives/Panel';
import { LlamacppCatalogEditor } from './LlamacppCatalogEditor';
import { SkillEditorDialog, type SkillEditorTarget } from './SkillEditorDialog';
import { HandoffPromptsEditor } from './HandoffPromptsEditor';
import { ProjectsSettings } from './ProjectsSettings';
import { useProjectTrust } from '../hooks/useProjectTrust';
import { PhosphorControls } from '../themes/phosphor/PhosphorControls';
import { themeCategories } from '../themes/phosphor/arco-palette';

interface SkillSummary {
  slug: string;
  name: string;
  description: string;
  scope: 'project' | 'global';
  path: string;
  // §5.2 — read-only usage telemetry from the server sidecar. Absent ⇒ unused.
  useCount?: number;
  lastUsed?: number;
  // DD8 — withheld from the model manifest; operator inlines on pick.
  operatorOnly?: boolean;
}

// §5.2 — compact "used 4× · 3d ago" / "unused" caption for a skill row.
function formatSkillUsage(skill: SkillSummary): string {
  const count = skill.useCount ?? 0;
  if (count <= 0) return 'unused';
  const times = `used ${count}×`;
  if (!skill.lastUsed) return times;
  const ageMs = Date.now() - skill.lastUsed;
  if (ageMs < 0) return times;
  const mins = Math.floor(ageMs / 60000);
  if (mins < 1) return `${times} · just now`;
  if (mins < 60) return `${times} · ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${times} · ${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${times} · ${days}d ago`;
}

// Slot 12 — auto-compact threshold bounds (mirrors server/src/settings.ts
// sanitizeAutoCompact; staying in sync matters because the server clamps
// silently — a number outside bounds just reverts to default).

interface Props {
  onClose: () => void;
}

export function SettingsPanel({ onClose }: Props) {
  const authStatus = useAppStore((s) => s.authStatus);
  const setAuthStatus = useAppStore((s) => s.setAuthStatus);
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const setThemeId = useAppStore((s) => s.setThemeId);
  const setFontPackOverride = useAppStore((s) => s.setFontPackOverride);
  const setFrostedOverride = useAppStore((s) => s.setFrostedOverride);
  const setFrostedOpacity = useAppStore((s) => s.setFrostedOpacity);
  const previewFrostedOpacity = useAppStore((s) => s.previewFrostedOpacity);
  const setBgBrightness = useAppStore((s) => s.setBgBrightness);
  const previewBgBrightness = useAppStore((s) => s.previewBgBrightness);
  const setTextBrightness = useAppStore((s) => s.setTextBrightness);
  const previewTextBrightness = useAppStore((s) => s.previewTextBrightness);
  const setCrispText = useAppStore((s) => s.setCrispText);
  const crispEffective = settings?.crispText ?? false;
  const activeThemeId = settings?.themeId ?? DEFAULT_THEME_ID;
  // Effective frosted state = operator override if set, else the active theme's
  // own `frosted` default. Drives the toggle's checked state + label.
  const themeFrostedDefault = !!THEME_REGISTRY[activeThemeId]?.frosted;
  const frostedEffective = settings?.frostedOverride === 'on' ? true
    : settings?.frostedOverride === 'off' ? false
    : themeFrostedDefault;
  // Opacity slider draft (percent, 30–95). Local so dragging is smooth; commits
  // on release. Re-syncs if another tab / a reset changes the persisted value.
  const [frostedOpacityDraft, setFrostedOpacityDraft] = useState(
    Math.round((settings?.frostedOpacity ?? 0.6) * 100),
  );
  useEffect(() => {
    setFrostedOpacityDraft(Math.round((settings?.frostedOpacity ?? 0.6) * 100));
  }, [settings?.frostedOpacity]);
  // Brightness slider drafts (signed −30…+30 L-points, 0 = stock). Same smooth-
  // drag-then-commit shape as the frosted opacity slider.
  const [bgBrightnessDraft, setBgBrightnessDraft] = useState(settings?.bgBrightness ?? 0);
  const [textBrightnessDraft, setTextBrightnessDraft] = useState(settings?.textBrightness ?? 30);
  useEffect(() => {
    setBgBrightnessDraft(settings?.bgBrightness ?? 0);
  }, [settings?.bgBrightness]);
  useEffect(() => {
    setTextBrightnessDraft(settings?.textBrightness ?? 30);
  }, [settings?.textBrightness]);
  const saveUiScale = async (uiScale: number) => {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, uiScale });
    try {
      const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uiScale }) });
      if (!response.ok) throw new Error('settings save failed');
      setSettings(await response.json() as ArcoSettings);
    } catch {
      setSettings(previous);
      useAppStore.getState().pushNotification('error', 'Could not save interface text size.');
    }
  };
  const activeFontPackId = settings?.fontPackOverride ?? '';
  const capabilities = useAppStore((s) => s.capabilities);
  const ollamaLive = useAppStore((s) => s.ollamaLive);
  const llamacppLive = useAppStore((s) => s.llamacppLive);
  const [loginPending, setLoginPending] = useState<AuthLoginTarget | null>(null);
  const [manualHint, setManualHint] = useState<string | null>(null);
  const [loginCommand, setLoginCommand] = useState<string | null>(null);
  const [savingProvider, setSavingProvider] = useState<ProviderName | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Operator name editor — local draft mirrors store on open, then debounced
  // back to /api/settings on blur or Enter so each keystroke isn't a request.
  const [operatorDraft, setOperatorDraft] = useState<string>(settings?.operatorName ?? '');
  const [operatorSaving, setOperatorSaving] = useState(false);
  const [ollamaBaseDraft, setOllamaBaseDraft] = useState<string>(settings?.ollama?.baseUrl ?? '');
  const [ollamaBaseSaving, setOllamaBaseSaving] = useState(false);
  const [ollamaUtilitySaving, setOllamaUtilitySaving] = useState(false);
  // Free-text model + host drafts: the utility model may live on a REMOTE host
  // (not in the local /api/tags list), so a dropdown can't offer it — the
  // operator types the name. Local models are offered as datalist suggestions.
  const [ollamaUtilityModelDraft, setOllamaUtilityModelDraft] = useState<string>(settings?.ollama?.utility?.model ?? '');
  const [ollamaUtilityBaseDraft, setOllamaUtilityBaseDraft] = useState<string>(settings?.ollama?.utility?.baseUrl ?? '');
  // M13 — LM Studio endpoint editor. Same shape as the Ollama one.
  const [strataBaseDraft, setStrataBaseDraft] = useState<string>(settings?.strata?.baseUrl ?? '');
  const [strataBaseSaving, setStrataBaseSaving] = useState(false);
  const [lmstudioBaseDraft, setLmstudioBaseDraft] = useState<string>(settings?.lmstudio?.baseUrl ?? '');
  const [lmstudioBaseSaving, setLmstudioBaseSaving] = useState(false);
  // §D2 — endpoint auto-discovery. Operator-triggered (button), suggestions
  // only: clicking a result fills ollamaBaseDraft; the operator still hits Save.
  const [discoverPending, setDiscoverPending] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredEndpoint[] | null>(null);
  const [discoverNote, setDiscoverNote] = useState<string | null>(null);
  useEffect(() => {
    setOperatorDraft(settings?.operatorName ?? '');
  }, [settings?.operatorName]);
  useEffect(() => {
    setOllamaBaseDraft(settings?.ollama?.baseUrl ?? '');
  }, [settings?.ollama?.baseUrl]);
  useEffect(() => {
    setOllamaUtilityModelDraft(settings?.ollama?.utility?.model ?? '');
  }, [settings?.ollama?.utility?.model]);
  useEffect(() => {
    setOllamaUtilityBaseDraft(settings?.ollama?.utility?.baseUrl ?? '');
  }, [settings?.ollama?.utility?.baseUrl]);
  useEffect(() => {
    setLmstudioBaseDraft(settings?.lmstudio?.baseUrl ?? '');
  }, [settings?.lmstudio?.baseUrl]);

  const commitOperatorName = async () => {
    const next = operatorDraft.trim().slice(0, 32);
    if (next === (settings?.operatorName ?? '')) return;
    setOperatorSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorName: next }),
      });
      const data = await res.json() as ArcoSettings;
      setSettings(data);
    } catch {
      // Revert draft to authoritative value on failure.
      setOperatorDraft(settings?.operatorName ?? '');
    } finally {
      setOperatorSaving(false);
    }
  };

  const toggleProviderEnabled = async (provider: ProviderName) => {
    if (savingProvider) return;
    const current = settings?.enabledProviders[provider] !== false;
    const next: ArcoSettings = {
      enabledProviders: {
        claude: settings?.enabledProviders.claude !== false,
        gemini: settings?.enabledProviders.gemini !== false,
        ollama: settings?.enabledProviders.ollama !== false,
        codex: settings?.enabledProviders.codex !== false,
        antigravity: settings?.enabledProviders.antigravity !== false,
        llamacpp: settings?.enabledProviders.llamacpp !== false,
        lmstudio: settings?.enabledProviders.lmstudio !== false,
        strata: settings?.enabledProviders.strata !== false,
        deepseek: settings?.enabledProviders.deepseek !== false,
        cursor: settings?.enabledProviders.cursor !== false,
        [provider]: !current,
      },
    };
    setSavingProvider(provider);
    setSettings(next); // optimistic
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const data = await res.json() as ArcoSettings;
      setSettings(data);
    } catch {
      // Revert on failure — re-fetch authoritative state.
      try {
        const res = await fetch('/api/settings');
        const data = await res.json() as ArcoSettings;
        setSettings(data);
      } catch { /* leave optimistic — unlikely path */ }
    } finally {
      setSavingProvider(null);
    }
  };

  const commitOllamaBaseUrl = async () => {
    const next = ollamaBaseDraft.trim().replace(/\/+$/, '');
    if (next === (settings?.ollama?.baseUrl ?? '')) return;
    setOllamaBaseSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ollama: next ? { baseUrl: next } : {} }),
      });
      const data = await res.json() as ArcoSettings;
      setSettings(data);
      const authRes = await fetch('/api/auth-status');
      const auth = await authRes.json() as AuthStatusByProvider;
      setAuthStatus(auth);
    } catch {
      setOllamaBaseDraft(settings?.ollama?.baseUrl ?? '');
    } finally {
      setOllamaBaseSaving(false);
    }
  };

  // M7/M8 — global compaction utility model (settings.ollama.utility.model).
  // This is the small Ollama model that WRITES auto-compaction summaries; with
  // none set, compaction falls back to a deterministic text digest. `null`
  // clears it (the server's ollama merge deletes the sub-key on explicit null).
  const commitOllamaUtility = async (modelRaw: string, baseRaw: string) => {
    // Commit BOTH fields together from their drafts — the server whole-replaces
    // the utility object and requires a non-empty model (a host alone is
    // meaningless). Empty model ⇒ null ⇒ clears the utility (deterministic
    // digest). Sending both avoids the chicken-and-egg where a remote-only
    // model couldn't be set because the host field was gated on a local pick.
    const model = modelRaw.trim();
    const baseUrl = baseRaw.trim();
    // Carry the enabled/titles flags through — the server whole-replaces the
    // utility object, so omitting them here silently re-armed a paused utility
    // and dropped the titles opt-in.
    const prev = settings?.ollama?.utility;
    const utility = model
      ? { model, ...(baseUrl ? { baseUrl } : {}), ...(prev?.titles ? { titles: true } : {}), ...(prev?.enabled === false ? { enabled: false } : {}) }
      : null;
    setOllamaUtilitySaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ollama: { utility } }),
      });
      const data = await res.json() as ArcoSettings;
      setSettings(data);
    } catch { /* HMR will reconcile */ }
    finally { setOllamaUtilitySaving(false); }
  };

  // Flip one utility flag (enabled / titles), keeping model + host + the other
  // flag. Whole-object POST, same as commitOllamaUtility.
  const setOllamaUtilityFlag = async (flag: 'enabled' | 'titles', on: boolean) => {
    const prev = settings?.ollama?.utility;
    if (!prev?.model) return;
    const next = { ...prev };
    if (flag === 'enabled') { if (on) delete next.enabled; else next.enabled = false; }
    else { if (on) next.titles = true; else delete next.titles; }
    setOllamaUtilitySaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ollama: { utility: next } }),
      });
      const data = await res.json() as ArcoSettings;
      setSettings(data);
    } catch { /* HMR will reconcile */ }
    finally { setOllamaUtilitySaving(false); }
  };

  useEffect(() => { setStrataBaseDraft(settings?.strata?.baseUrl ?? ''); }, [settings?.strata?.baseUrl]);

  const commitLmstudioBaseUrl = async () => {
    const next = lmstudioBaseDraft.trim().replace(/\/+$/, '');
    if (next === (settings?.lmstudio?.baseUrl ?? '')) return;
    setLmstudioBaseSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lmstudio: next ? { baseUrl: next } : {} }),
      });
      const data = await res.json() as ArcoSettings;
      setSettings(data);
      const authRes = await fetch('/api/auth-status');
      const auth = await authRes.json() as AuthStatusByProvider;
      setAuthStatus(auth);
    } catch {
      setLmstudioBaseDraft(settings?.lmstudio?.baseUrl ?? '');
    } finally {
      setLmstudioBaseSaving(false);
    }
  };
  const commitStrataBaseUrl = async () => {
    const next = strataBaseDraft.trim().replace(/\/+$/, '');
    if (next === (settings?.strata?.baseUrl ?? '')) return;
    setStrataBaseSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strata: next ? { baseUrl: next } : {} }),
      });
      const data = await res.json() as ArcoSettings;
      setSettings(data);
      const authRes = await fetch('/api/auth-status');
      const auth = await authRes.json() as AuthStatusByProvider;
      setAuthStatus(auth);
    } catch {
      setStrataBaseDraft(settings?.strata?.baseUrl ?? '');
    } finally {
      setStrataBaseSaving(false);
    }
  };

  // §D2 — probe tailscale peers + localhost for reachable Ollama / OpenAI-
  // compatible endpoints. Suggestions only — never auto-switches the endpoint.
  const discoverEndpoints = async () => {
    setDiscoverPending(true);
    setDiscoverNote(null);
    try {
      const res = await fetch('/api/endpoints/discover');
      const data = await res.json() as EndpointDiscoverResponse;
      setDiscovered(data.endpoints);
      if (data.endpoints.length === 0) {
        setDiscoverNote(
          data.tailscaleAvailable
            ? 'No endpoints found on localhost or tailscale peers.'
            : 'No endpoints found (tailscale not available — localhost only).',
        );
      } else if (!data.tailscaleAvailable) {
        setDiscoverNote('tailscale not available — localhost only.');
      }
    } catch {
      setDiscovered([]);
      setDiscoverNote('Discovery failed.');
    } finally {
      setDiscoverPending(false);
    }
  };

  // Phase 1 (operator-features) — skills CRUD. The catalog refreshes on
  // open + after every save/delete; project skills require an active
  // workflow's cwd, global skills don't. Edits propagate to the next
  // primary turn automatically (server scans on every turn) — no restart.
  const activeJob = useAppStore((s) => (s.activeJobId ? s.jobs[s.activeJobId] : undefined));
  const activeCwd = activeJob?.config.workingDirectory ?? '';
  const [skills, setSkills] = useState<{ project: SkillSummary[]; global: SkillSummary[] } | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skillEditor, setSkillEditor] = useState<SkillEditorTarget | null>(null);
  const refreshSkills = async () => {
    setSkillsError(null);
    try {
      const params = activeCwd ? `?cwd=${encodeURIComponent(activeCwd)}` : '';
      const res = await fetch(`/api/skills${params}`);
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || res.statusText);
      }
      const data = (await res.json()) as { project: SkillSummary[]; global: SkillSummary[] };
      setSkills(data);
    } catch (err) {
      setSkillsError(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => { void refreshSkills(); }, [activeCwd]);
  const deleteSkill = async (s: SkillSummary) => {
    // No native confirm — the surrounding settings modal already feels modal,
    // and an extra dialog is friction for what's a recoverable action (the
    // body is in git for project skills). If undo becomes a real ask we'll
    // add it, but for v1 the click is the commit.
    setSkillsError(null);
    try {
      const params = new URLSearchParams({ scope: s.scope, slug: s.slug });
      if (s.scope === 'project') params.set('cwd', activeCwd);
      const res = await fetch(`/api/skills?${params.toString()}`, { method: 'DELETE' });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || res.statusText);
      }
      await refreshSkills();
    } catch (err) {
      setSkillsError(err instanceof Error ? err.message : String(err));
    }
  };

  // Slot 12 — catalog editor state. Lazy-loaded when the operator opens the
  // editor; local edits hold in catalogDraft until SAVE commits them.
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalogDraft, setCatalogDraft] = useState<string>('');
  const [catalogSaving, setCatalogSaving] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const openCatalogEditor = async () => {
    setCatalogOpen(true);
    setCatalogError(null);
    if (catalogLoaded) return;
    try {
      const res = await fetch('/api/catalog');
      const data = await res.json() as { contents: string };
      setCatalogDraft(data.contents ?? '');
      setCatalogLoaded(true);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveCatalog = async () => {
    setCatalogSaving(true);
    setCatalogError(null);
    try {
      const res = await fetch('/api/catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: catalogDraft }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((body as { error?: string }).error ?? res.statusText);
      }
      setCatalogOpen(false);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : String(err));
    } finally {
      setCatalogSaving(false);
    }
  };

  const cancelCatalogEdit = async () => {
    // Re-fetch so any pending edits are discarded in favor of disk truth.
    setCatalogOpen(false);
    setCatalogError(null);
    if (catalogLoaded) {
      try {
        const res = await fetch('/api/catalog');
        const data = await res.json() as { contents: string };
        setCatalogDraft(data.contents ?? '');
      } catch { /* leave stale draft — edit button will re-read */ }
    }
  };

  const refresh = async () => {
    try {
      const res = await fetch('/api/auth-status');
      const data = (await res.json()) as AuthStatusByProvider;
      setAuthStatus(data);
    } catch { /* leave previous value */ }
  };

  useEffect(() => { refresh(); }, []);

  // Poll faster while a login is mid-flight so the row flips LIVE as soon as
  // credentials land on disk.
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (loginPending) {
      pollRef.current = setInterval(refresh, 1500);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loginPending]);

  // Clear loginPending once the target provider flips to loggedIn.
  useEffect(() => {
    if (!loginPending || !authStatus) return;
    if (authStatus[loginPending]?.loggedIn) {
      setLoginPending(null);
    }
  }, [authStatus, loginPending]);

  const startLogin = async (provider: AuthLoginTarget) => {
    setLoginPending(provider);
    setManualHint(null);
    setLoginCommand(null);
    try {
      const res = await fetch(`/api/auth-login?provider=${provider}`, { method: 'POST' });
      const data = (await res.json()) as AuthLoginResult;
      if (data.command) {
        // Keep loginPending so the fast poll flips the row LIVE when it lands.
        setLoginCommand(data.command);
        setManualHint(data.manual ?? null);
      } else if (!data.started && data.manual) {
        setManualHint(data.manual);
        setLoginPending(null);
      }
    } catch {
      setManualHint('Could not start login.');
      setLoginPending(null);
    }
  };

  const phosphorActive = THEME_REGISTRY[activeThemeId]?.family === 'phosphor';
  const llamacppReady = settings?.enabledProviders?.llamacpp !== false && !!authStatus?.llamacpp?.loggedIn;

  return (
    <SettingsLayout onClose={onClose} unavailable={{ phosphor: !phosphorActive, 'llamacpp-catalog': !llamacppReady }}>

        <SettingsSection id="themes">
        <div data-help="settings.themes">
          <ThemePicker activeThemeId={activeThemeId} onSelect={(id) => { void setThemeId(id); }} />
        </div>
        </SettingsSection>
        <SettingsSection id="phosphor">{phosphorActive && <PhosphorControls />}</SettingsSection>

        <SettingsSection id="font-pack-override">
        <div data-help="settings.font-pack-override">
          <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>
            FONT PACK OVERRIDE
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
            <select
              aria-label="Font pack override"
              value={activeFontPackId}
              onChange={(e) => {
                const v = e.target.value;
                void setFontPackOverride(v === '' ? null : v);
              }}
              style={{
                flex: 1,
                padding: '6px 10px',
                background: 'var(--color-bg-sunken)',
                border: '1px solid var(--color-border-hairline)',
                borderRadius: '3px',
                color: 'var(--color-accent-primary)',
                fontSize: '11px',
                fontFamily: 'var(--font-display)',
                letterSpacing: '1px',
              }}
            >
              <option value="">USE THEME DEFAULT</option>
              {FONT_PACKS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name.toUpperCase()} — {p.origin}
                </option>
              ))}
            </select>
          </div>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', marginBottom: '14px', lineHeight: 1.5 }}>
            Substitutes display / body / code fonts on every theme. Useful when you like one theme's palette but prefer another's typography.
          </div>
        </div>
        </SettingsSection>

        <SettingsSection id="interface-text-size">
          <div data-help="settings.interface-text-size">
            <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>INTERFACE TEXT SIZE</div>
            <div role="group" aria-label="Interface text size" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px' }}>
              {UI_SCALES.map(scale => <button key={scale} type="button" style={{ padding: '5px 8px', color: 'var(--color-accent-primary)', background: 'var(--color-bg-sunken)', border: `1px solid ${(settings?.uiScale ?? DEFAULT_UI_SCALE) === scale ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`, cursor: 'pointer' }} aria-pressed={(settings?.uiScale ?? DEFAULT_UI_SCALE) === scale} onClick={() => void saveUiScale(scale)}>{Math.round(scale * 100)}%</button>)}
              <button type="button" onClick={() => void saveUiScale(DEFAULT_UI_SCALE)}>Reset to default</button>
            </div>
          </div>
        </SettingsSection>
        <SettingsSection id="theme-brightness">
        <div data-help="settings.theme-brightness">
          <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>
            THEME BRIGHTNESS
          </div>
          {([
            { label: 'TEXT', draft: textBrightnessDraft, setDraft: setTextBrightnessDraft, preview: previewTextBrightness, commit: setTextBrightness, min: -30, max: 80 },
            { label: 'BACKGROUND', draft: bgBrightnessDraft, setDraft: setBgBrightnessDraft, preview: previewBgBrightness, commit: setBgBrightness, min: -30, max: 30 },
          ] as const).map((s) => (
            <label key={s.label} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', fontFamily: 'var(--font-body)', color: 'var(--color-fg-muted)', marginBottom: '8px' }}>
              <span style={{ minWidth: '80px', fontFamily: 'var(--font-display)', fontSize: '10px', letterSpacing: '1px' }}>{s.label}</span>
              <input
                type="range"
                min={s.min}
                max={s.max}
                value={s.draft}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  s.setDraft(v);
                  s.preview(v);
                }}
                onMouseUp={() => { void s.commit(s.draft); }}
                onTouchEnd={() => { void s.commit(s.draft); }}
                onKeyUp={() => { void s.commit(s.draft); }}
                style={{ flex: 1, accentColor: 'var(--color-accent-primary)' }}
              />
              <span style={{ minWidth: '32px', textAlign: 'right', color: 'var(--color-accent-primary)' }}>{s.draft > 0 ? `+${s.draft}` : String(s.draft)}</span>
            </label>
          ))}
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', marginBottom: '14px', lineHeight: 1.5 }}>
            Two independent shifts on every theme — drag right to brighten, left to darken; centre (0) is the theme's own colors. The default text shift is +30. TEXT moves the foreground / ink, BACKGROUND moves the panel surfaces.
            {(bgBrightnessDraft !== 0 || textBrightnessDraft !== 0) && (
              <> <button type="button" onClick={() => { setTextBrightnessDraft(0); setBgBrightnessDraft(0); void setTextBrightness(0); void setBgBrightness(0); }}
                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-accent-secondary)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}>
                reset to theme default
              </button></>
            )}
          </div>
        </div>
        </SettingsSection>

        <SettingsSection id="crisp-text">
        <div data-help="settings.crisp-text">
          <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>
            CRISP TEXT
          </div>
          <button
            type="button"
            onClick={() => { void setCrispText(!crispEffective); }}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '6px 10px', marginBottom: '8px',
              background: crispEffective ? 'var(--color-accent-primary-a10)' : 'var(--color-bg-sunken)',
              border: `1px solid ${crispEffective ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
              borderRadius: '3px',
              color: crispEffective ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)',
              fontSize: '11px', fontFamily: 'var(--font-display)', letterSpacing: '1px',
              cursor: 'pointer',
            }}
          >
            <span>{crispEffective ? '◉' : '○'}</span>
            <span>{crispEffective ? 'ON' : 'OFF'}</span>
          </button>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', marginBottom: '14px', lineHeight: 1.5 }}>
            Removes the phosphor text-glow that softens small text on glow-heavy themes. Border / LED glow keeps its treatment. Classic retains the ARCO wordmark glow; Phosphor makes the wordmark crisp too.
          </div>
        </div>
        </SettingsSection>

        <SettingsSection id="frosted-glass">
        <div data-help="settings.frosted-glass">
          <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>
            FROSTED GLASS
          </div>
          <button
            type="button"
            onClick={() => { void setFrostedOverride(frostedEffective ? 'off' : 'on'); }}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '6px 10px', marginBottom: '8px',
              background: frostedEffective ? 'var(--color-accent-primary-a10)' : 'var(--color-bg-sunken)',
              border: `1px solid ${frostedEffective ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
              borderRadius: '3px',
              color: frostedEffective ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)',
              fontSize: '11px', fontFamily: 'var(--font-display)', letterSpacing: '1px',
              cursor: 'pointer',
            }}
          >
            <span>{frostedEffective ? '◉' : '○'}</span>
            <span>{frostedEffective ? 'ON' : 'OFF'}</span>
          </button>
          {frostedEffective && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', fontFamily: 'var(--font-body)', color: 'var(--color-fg-muted)', marginBottom: '8px' }}>
              <span style={{ minWidth: '54px', fontFamily: 'var(--font-display)', fontSize: '10px', letterSpacing: '1px' }}>OPACITY</span>
              <input
                type="range"
                min={30}
                max={95}
                value={frostedOpacityDraft}
                onChange={(e) => {
                  const pct = Number(e.target.value);
                  setFrostedOpacityDraft(pct);
                  previewFrostedOpacity(pct / 100);
                }}
                onMouseUp={() => { void setFrostedOpacity(frostedOpacityDraft / 100); }}
                onTouchEnd={() => { void setFrostedOpacity(frostedOpacityDraft / 100); }}
                style={{ flex: 1, accentColor: 'var(--color-accent-primary)' }}
              />
              <span style={{ minWidth: '32px', textAlign: 'right', color: 'var(--color-accent-primary)' }}>{frostedOpacityDraft}%</span>
            </label>
          )}
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', marginBottom: '14px', lineHeight: 1.5 }}>
            Blurs the backdrop through panel surfaces. Overrides the theme's own default
            {settings?.frostedOverride === undefined ? ` (this theme: ${themeFrostedDefault ? 'on' : 'off'})` : ''}.
            {settings?.frostedOverride !== undefined && (
              <> <button type="button" onClick={() => { void setFrostedOverride(null); }}
                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-accent-secondary)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}>
                reset to theme default
              </button></>
            )}
          </div>
        </div>
        </SettingsSection>

        <SettingsSection id="operator-name">
        <div data-help="settings.operator-name">
          <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>
            OPERATOR NAME
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '14px' }}>
            <input
              type="text"
              value={operatorDraft}
              onChange={(e) => setOperatorDraft(e.target.value)}
              onBlur={() => { void commitOperatorName(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                if (e.key === 'Escape') { setOperatorDraft(settings?.operatorName ?? ''); (e.target as HTMLInputElement).blur(); }
              }}
              maxLength={32}
              placeholder="OPERATOR"
              spellCheck={false}
              style={{
                flex: 1,
                padding: '6px 10px',
                background: 'var(--color-bg-sunken)',
                border: '1px solid var(--color-border-hairline)',
                borderRadius: '3px',
                color: 'var(--color-accent-primary)',
                fontSize: '11px',
                fontFamily: 'var(--font-display)',
                letterSpacing: '1.5px',
              }}
            />
            <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)', minWidth: '52px', textAlign: 'right' }}>
              {operatorSaving ? 'SAVING…' : ''}
            </span>
          </div>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', marginTop: '-8px', marginBottom: '14px' }}>
            Replaces the "&gt; OPERATOR" label in chat. Leave blank to keep the default.
          </div>
        </div>
        </SettingsSection>

        <SettingsSection id="projects">
        <ProjectsSettings />
        <div data-help="settings.first-run">
          <button type="button" onClick={() => {
            useStartupStore.getState().setFirstRunOpen(true);
            onClose();
          }}>Run setup again</button>
          <p>Reopen the welcome, project-folder, provider and chat steps. Existing work stays saved.</p>
        </div>
        </SettingsSection>

        <SettingsSection id="media-access">
        <MediaAccessSettings />
        </SettingsSection>

        <SettingsSection id="voice-setup">
        <VoiceSetupSettings />
        </SettingsSection>

        <SettingsSection id="enabled-providers">
        <div data-help="settings.enabled-providers">
          <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>
            ENABLED PROVIDERS
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
            {(['claude', 'gemini', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek'] as ProviderName[]).map((p) => {
              const enabled = settings?.enabledProviders[p] !== false;
              const label = p === 'claude' ? 'CLAUDE'
                : p === 'gemini' ? 'GEMINI'
                : p === 'codex' ? 'CODEX'
                : p === 'cursor' ? 'CURSOR'
                : p === 'ollama' ? 'OLLAMA'
                : p === 'deepseek' ? 'XOLOTL' : p === 'strata' ? 'STRATA' : p === 'lmstudio' ? 'LM STUDIO'
                : 'LLAMA.CPP';
              const sub = p === 'ollama'
                ? 'Local worker provider — reserved use per the catalog'
                : p === 'llamacpp'
                  ? 'Local worker provider — manual model registry, vision-capable'
                  : p === 'deepseek' ? 'DeepSeek V4.1 Flash · Exact / Light · local inference' : p === 'strata' ? 'Standalone Qwen inference — web and image input' : p === 'lmstudio'
                    ? 'Local worker provider — OpenAI-compatible endpoint (default :1234)'
                  : p === 'cursor'
                    ? 'ACP Agent; print Chat/review — live model catalog (cursor-agent login)'
                  : p === 'gemini'
                    ? 'Agent and reviewer — CLI transport; no Chat mode'
                    : p === 'codex'
                      ? 'Agent, Chat and reviewer — catalog-driven GPT models'
                      : 'Agent, Chat and reviewer — CLI or Native transport';
              return (
                <div
                  key={p}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '8px 12px',
                    border: '1px solid var(--color-border-hairline)',
                    borderRadius: '4px',
                    background: enabled ? 'var(--color-accent-primary-a04)' : 'var(--color-bg-sunken)',
                    opacity: enabled ? 1 : 0.65,
                  }}
                >
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                    <span className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: enabled ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)' }}>
                      {label}
                    </span>
                    <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)' }}>
                      {sub}
                    </span>
                  </div>
                  <button
                    onClick={() => toggleProviderEnabled(p)}
                    disabled={savingProvider === p}
                    className="display-font"
                    style={{
                      padding: '4px 10px',
                      background: enabled ? 'var(--color-accent-primary-a10)' : 'transparent',
                      border: `1px solid ${enabled ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
                      borderRadius: '3px',
                      color: enabled ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                      cursor: savingProvider === p ? 'default' : 'pointer',
                      fontSize: '10px',
                      letterSpacing: '1.5px',
                      minWidth: '54px',
                      opacity: savingProvider === p ? 0.6 : 1,
                    }}
                  >
                    {savingProvider === p ? '…' : enabled ? 'ON' : 'OFF'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        </SettingsSection>
        <SettingsSection id="authentication">
        <div>
          <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>
            AUTHENTICATION
          </div>
          <div data-help="settings.authentication" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div id="connection-advanced-ollama" style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '10px 14px', border: '1px solid var(--color-border-hairline)', borderRadius: '4px', background: 'var(--color-bg-sunken)' }}>
              <label htmlFor="ollama-endpoint" className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)' }}>
                OLLAMA ENDPOINT
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input id="ollama-endpoint" aria-describedby="ollama-endpoint-help"
                  value={ollamaBaseDraft}
                  onChange={(e) => setOllamaBaseDraft(e.target.value)}
                  onBlur={commitOllamaBaseUrl}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') { setOllamaBaseDraft(settings?.ollama?.baseUrl ?? ''); (e.target as HTMLInputElement).blur(); }
                  }}
                  placeholder="http://localhost:11434"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '6px 10px',
                    background: 'var(--color-bg-elevated)',
                    border: '1px solid var(--color-border-hairline)',
                    borderRadius: '3px',
                    color: 'var(--color-accent-primary)',
                    fontSize: '11px',
                    fontFamily: 'var(--font-code)',
                  }}
                />
                <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)', minWidth: '52px', textAlign: 'right' }}>
                  {ollamaBaseSaving ? 'SAVING…' : ''}
                </span>
              </div>
              <EndpointHelp id="ollama-endpoint-help" />
              <div data-help="settings.endpoint-discovery" style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '2px' }}>
                <button
                  type="button"
                  onClick={discoverEndpoints}
                  disabled={discoverPending}
                  className="display-font"
                  style={{
                    alignSelf: 'flex-start',
                    fontSize: '10px',
                    letterSpacing: '1px',
                    padding: '4px 10px',
                    background: 'var(--color-bg-elevated)',
                    border: '1px solid var(--color-border-hairline)',
                    borderRadius: '3px',
                    color: 'var(--color-accent-primary)',
                    cursor: discoverPending ? 'default' : 'pointer',
                    opacity: discoverPending ? 0.6 : 1,
                  }}
                >
                  {discoverPending ? 'DISCOVERING…' : 'DISCOVER ENDPOINTS'}
                </button>
                {discoverNote && (
                  <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>{discoverNote}</span>
                )}
                {discovered && discovered.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {discovered.map((ep) => (
                      <button
                        key={ep.baseUrl}
                        type="button"
                        onClick={() => setOllamaBaseDraft(ep.baseUrl)}
                        title={ep.sampleModels.length ? ep.sampleModels.join(', ') : undefined}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '8px',
                          padding: '5px 10px',
                          background: 'var(--color-bg-elevated)',
                          border: '1px solid var(--color-border-hairline)',
                          borderRadius: '3px',
                          color: 'var(--color-accent-primary)',
                          fontSize: '11px',
                          fontFamily: 'var(--font-code)',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {ep.baseUrl}
                          {ep.peerName ? ` (${ep.peerName})` : ep.source === 'localhost' ? ' (local)' : ''}
                        </span>
                        <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-fg-muted)', flexShrink: 0 }}>
                          {ep.api.toUpperCase()} · {ep.modelCount}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '10px 14px', border: '1px solid var(--color-border-hairline)', borderRadius: '4px', background: 'var(--color-bg-sunken)' }}>
              <label className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)' }}>
                OLLAMA COMPACTION UTILITY MODEL
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  list="ollama-utility-models"
                  value={ollamaUtilityModelDraft}
                  onChange={(e) => setOllamaUtilityModelDraft(e.target.value)}
                  onBlur={() => { if (ollamaUtilityModelDraft.trim() !== (settings?.ollama?.utility?.model ?? '')) void commitOllamaUtility(ollamaUtilityModelDraft, ollamaUtilityBaseDraft); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') { setOllamaUtilityModelDraft(settings?.ollama?.utility?.model ?? ''); (e.target as HTMLInputElement).blur(); }
                  }}
                  placeholder="model name (blank = deterministic digest)"
                  disabled={ollamaUtilitySaving}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '6px 10px',
                    background: 'var(--color-bg-elevated)',
                    border: '1px solid var(--color-border-hairline)',
                    borderRadius: '3px',
                    color: 'var(--color-accent-primary)',
                    fontSize: '11px',
                    fontFamily: 'var(--font-code)',
                  }}
                />
                <datalist id="ollama-utility-models">
                  {(authStatus?.ollama?.installedModels ?? []).map((m) => <option key={m} value={m} />)}
                </datalist>
                <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)', minWidth: '52px', textAlign: 'right' }}>
                  {ollamaUtilitySaving ? 'SAVING…' : ''}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                <input
                  value={ollamaUtilityBaseDraft}
                  onChange={(e) => setOllamaUtilityBaseDraft(e.target.value)}
                  onBlur={() => {
                    // Only persist a host when a model is set (a host alone is
                    // meaningless and would clear the utility). Otherwise just
                    // retain the draft so model-then-host and host-then-model
                    // both work without wiping the field.
                    if (!ollamaUtilityModelDraft.trim()) return;
                    if (ollamaUtilityBaseDraft.trim() !== (settings?.ollama?.utility?.baseUrl ?? '')) void commitOllamaUtility(ollamaUtilityModelDraft, ollamaUtilityBaseDraft);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') { setOllamaUtilityBaseDraft(settings?.ollama?.utility?.baseUrl ?? ''); (e.target as HTMLInputElement).blur(); }
                  }}
                  placeholder="(optional) remote host e.g. http://tank:11434"
                  disabled={ollamaUtilitySaving}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '6px 10px',
                    background: 'var(--color-bg-elevated)',
                    border: '1px solid var(--color-border-hairline)',
                    borderRadius: '3px',
                    color: 'var(--color-accent-primary)',
                    fontSize: '11px',
                    fontFamily: 'var(--font-code)',
                  }}
                />
              </div>
              {settings?.ollama?.utility?.model && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '4px', fontSize: '10px', fontFamily: 'var(--font-code)' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', color: settings.ollama.utility.enabled === false ? 'var(--color-fg-muted)' : 'var(--color-accent-primary)' }}>
                    <input
                      type="checkbox"
                      checked={settings.ollama.utility.enabled !== false}
                      disabled={ollamaUtilitySaving}
                      onChange={(e) => void setOllamaUtilityFlag('enabled', e.target.checked)}
                    />
                    ENABLED{settings.ollama.utility.enabled === false ? ' (PAUSED — nothing is sent to this host)' : ''}
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', color: 'var(--color-fg-muted)' }}>
                    <input
                      type="checkbox"
                      checked={settings.ollama.utility.titles === true}
                      disabled={ollamaUtilitySaving}
                      onChange={(e) => void setOllamaUtilityFlag('titles', e.target.checked)}
                    />
                    SESSION TITLES
                  </label>
                </div>
              )}
              <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)' }}>
                ENABLED off pauses every utility job (compaction falls back to the deterministic digest, titles stop) while keeping the model + host saved. SESSION TITLES (opt-in) names RESUME-picker sessions with a short generated title. The small model that writes Ollama auto-compaction summaries (and any utility jobs). Type a model name — local models are offered as suggestions, but you can enter one that only exists on the remote host below. Blank ⇒ a deterministic text digest is used instead. Ollama-specific — Claude/Codex use their vendors' native compaction. Leave the host blank to use your default Ollama endpoint; set it to run the summarizer on a separate machine/GPU (e.g. a spare card on another box) so it never competes with your primary model for VRAM.
              </span>
            </div>
            <div id="connection-advanced-lmstudio" style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '10px 14px', border: '1px solid var(--color-border-hairline)', borderRadius: '4px', background: 'var(--color-bg-sunken)' }}>
              <label htmlFor="lmstudio-endpoint" className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)' }}>
                LM STUDIO ENDPOINT
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input id="lmstudio-endpoint" aria-describedby="lmstudio-endpoint-help"
                  value={lmstudioBaseDraft}
                  onChange={(e) => setLmstudioBaseDraft(e.target.value)}
                  onBlur={commitLmstudioBaseUrl}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') { setLmstudioBaseDraft(settings?.lmstudio?.baseUrl ?? ''); (e.target as HTMLInputElement).blur(); }
                  }}
                  placeholder="http://localhost:1234/v1"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '6px 10px',
                    background: 'var(--color-bg-elevated)',
                    border: '1px solid var(--color-border-hairline)',
                    borderRadius: '3px',
                    color: 'var(--color-accent-primary)',
                    fontSize: '11px',
                    fontFamily: 'var(--font-code)',
                  }}
                />
                <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)', minWidth: '52px', textAlign: 'right' }}>
                  {lmstudioBaseSaving ? 'SAVING…' : ''}
                </span>
              </div>
              <EndpointHelp id="lmstudio-endpoint-help" />
              <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)' }}>
                OpenAI-compatible REST endpoint (LM Studio app → Developer → Start Server). The /v1 suffix is added automatically if omitted.
              </span>
            </div>
            <DeepSeekControls />
            <div data-help="settings.strata-endpoint" style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '10px 14px', border: '1px solid var(--color-border-hairline)', borderRadius: '4px', background: 'var(--color-bg-sunken)' }}>
              <label htmlFor="strata-endpoint" className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)' }}>
                STRATA ENDPOINT
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input id="strata-endpoint" aria-describedby="strata-endpoint-help"
                  value={strataBaseDraft}
                  onChange={(e) => setStrataBaseDraft(e.target.value)}
                  onBlur={commitStrataBaseUrl}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') { setStrataBaseDraft(settings?.strata?.baseUrl ?? ''); (e.target as HTMLInputElement).blur(); }
                  }}
                  placeholder="http://127.0.0.1:8081/v1"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '6px 10px',
                    background: 'var(--color-bg-elevated)',
                    border: '1px solid var(--color-border-hairline)',
                    borderRadius: '3px',
                    color: 'var(--color-accent-primary)',
                    fontSize: '11px',
                    fontFamily: 'var(--font-code)',
                  }}
                />
                <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)', minWidth: '52px', textAlign: 'right' }}>
                  {strataBaseSaving ? 'SAVING…' : ''}
                </span>
              </div>
              <EndpointHelp id="strata-endpoint-help" />
              <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)' }}>
                Standalone Strata inference service. Prepared local profiles load on the next message; live context and image capabilities follow the service. The /v1 suffix is added automatically if omitted.
              </span>
            </div>
            <ProviderRow
              label="CLAUDE (ANTHROPIC)"
              provider="claude"
              status={authStatus?.claude}
              loginPending={loginPending === 'claude'}
              onLogin={() => startLogin('claude')}
            />
            <ProviderRow
              label="GEMINI (GOOGLE)"
              provider="gemini"
              status={authStatus?.gemini}
              loginPending={loginPending === 'gemini'}
              onLogin={() => startLogin('gemini')}
            />
            <CodexProfilesSection />


            <ProviderRow
              label="CURSOR (ACP)"
              provider="cursor"
              status={authStatus?.cursor}
              loginPending={loginPending === 'cursor'}
              onLogin={() => startLogin('cursor')}
            />
            <ProviderRow
              label="OLLAMA (LOCAL)"
              status={authStatus?.ollama}
              loginPending={loginPending === 'ollama'}
              onLogin={() => startLogin('ollama')}
              variant="ollama"
            />
            <ProviderRow
              label="LLAMA.CPP (LOCAL)"
              status={authStatus?.llamacpp}
              loginPending={false}
              onLogin={() => { /* no-op: llama.cpp has no login flow */ }}
              variant="llamacpp"
              loadedModel={llamacppLive?.loadedModel ?? null}
            />
            <ProviderRow
              label="LM STUDIO (LOCAL)"
              status={authStatus?.lmstudio}
              loginPending={false}
              onLogin={() => { /* no-op: LM Studio has no login flow */ }}
              variant="lmstudio"
            />
            <ProviderRow
              label="STRATA (LOCAL)"
              status={authStatus?.strata}
              loginPending={false}
              onLogin={() => { /* no-op: Strata has no login flow */ }}
              variant="strata"
            />
            <ProviderRow
              label="GITHUB (gh CLI)"
              status={authStatus?.github}
              loginPending={loginPending === 'github'}
              onLogin={() => startLogin('github')}
            />
            {/* Phase 7a — Claude Native OAuth row. Independent of CLI auth above
                so a tab on `claudeTransport: 'native'` can have its own status
                without affecting CLI tabs on the same machine. */}
            <ClaudeNativeAuthRow />
          </div>
          {manualHint && (
            <div style={{ fontSize: '10px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-body)', marginTop: '8px' }}>
              {manualHint}
            </div>
          )}
          {loginCommand && (
            <div style={{ marginTop: '8px' }}>
              <LoginCommand command={loginCommand} />
            </div>
          )}
        </div>
        </SettingsSection>

        {/* Phase 6e follow-up — global default transport for new Codex tabs.
            Writes settings.codex.transport via POST /api/settings; the
            cascade reader in handleUserMessage picks it up live (HMR). The
            per-tab override on `wf.config.codexTransport` always wins, so
            this only changes (a) tabs that have never been toggled and
            (b) the starting value for newly-created Codex tabs. Phase 7's
            plan-doc must mirror this for `claude.transport`. */}
        <SettingsSection id="transport-defaults">
        <CodexTransportDefaultsSection />
        </SettingsSection>

        {/* Global auto-handoff default for new tabs. Writes
            settings.autoHandoffDefaults via POST /api/settings; the server
            seeds config.autoHandoff on workflow create. Per-tab override on
            the CONFIG tab always wins. */}
        <SettingsSection id="auto-handoff-defaults">
        <AutoHandoffDefaultsSection />
        </SettingsSection>

        {/* Global default for Anthropic server-side compaction on new Native
            tabs. Writes settings.claudeNativeCompactDefault; the server seeds
            config.claudeNativeCompact on workflow create. Per-tab CONFIG
            toggle always wins. Default OFF (NATIVE_COMPACTION_PLAN §1). */}
        <SettingsSection id="claude-native-compact-default">
        <ClaudeNativeCompactDefaultSection />
        </SettingsSection>

        {/* DD7 — standing project-trust manager. Global (no tab needed), so it's
            the fallback when the gate's one-shot composer prompt was missed —
            including the cluster case, where the prompt lands in one member's
            composer and the parent tab has no CONFIG tab. */}
        <SettingsSection id="project-trust">
        <ProjectTrustSection activeCwd={activeCwd} />
        </SettingsSection>

        {/* llama.cpp model registry. Visible when the operator has llamacpp
            enabled in settings AND the auth probe sees the binary on disk
            (otherwise the editor's load button just produces 500s). The
            section pulls double-duty as both the registry editor and the
            "manually preload a model" affordance — operators can hide the
            20-30s cold-start by clicking LOAD before they fire a workflow. */}
        <SettingsSection id="llamacpp-catalog">
          {llamacppReady && <LlamacppCatalogEditor />}
        </SettingsSection>

        {/* Phase 1 (operator-features) — Arco-managed skills. Project
            skills live under <cwd>/.arco/skills/ and version with the
            project; global skills live under ~/.arco/skills/ and apply
            everywhere. Manifest of name+description gets injected into
            every primary turn's system prompt; the agent reads each
            SKILL.md on demand via its Read tool. */}
        <SettingsSection id="skills">
        <div data-help="settings.skills">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)' }}>
              SKILLS
            </span>
            <button
              onClick={() => setSkillEditor({ scope: activeCwd ? 'project' : 'global' })}
              className="display-font"
              style={{
                padding: '4px 10px',
                background: 'var(--color-accent-secondary-a08)',
                border: '1px solid var(--color-accent-secondary-dim)',
                borderRadius: '3px',
                color: 'var(--color-accent-secondary)',
                cursor: 'pointer',
                fontSize: '10px',
                letterSpacing: '1.5px',
              }}
            >
              + NEW
            </button>
          </div>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: '1.6', marginBottom: '8px' }}>
            Project skills live under <code>{'<cwd>/.arco/skills/'}</code> (version with the repo); global skills under <code>~/.arco/skills/</code>. Each is a SKILL.md with frontmatter (name, description). Edits take effect on the next turn — no restart.
          </div>
          {skillsError && (
            <div style={{ fontSize: '10px', color: 'var(--color-warning)', fontFamily: 'var(--font-body)', marginBottom: '6px' }}>
              {skillsError}
            </div>
          )}
          {skills && skills.project.length === 0 && skills.global.length === 0 && (
            <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', marginBottom: '6px', fontStyle: 'italic' }}>
              No skills yet. Click + NEW to create one.
            </div>
          )}
          {skills && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
              {skills.project.map((s) => (
                <SkillRow
                  key={`project:${s.slug}`}
                  skill={s}
                  onEdit={() => setSkillEditor({ scope: s.scope, slug: s.slug })}
                  onDelete={() => { void deleteSkill(s); }}
                />
              ))}
              {skills.global.length > 0 && (
                <div
                  className="display-font"
                  style={{ fontSize: '9px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)', marginTop: '6px', marginBottom: '2px' }}
                >
                  (GLOBAL)
                </div>
              )}
              {skills.global.map((s) => (
                <SkillRow
                  key={`global:${s.slug}`}
                  skill={s}
                  onEdit={() => setSkillEditor({ scope: s.scope, slug: s.slug })}
                  onDelete={() => { void deleteSkill(s); }}
                />
              ))}
            </div>
          )}
        </div>
        </SettingsSection>

        {skillEditor && (
          <SkillEditorDialog
            cwd={activeCwd}
            target={skillEditor}
            onClose={() => setSkillEditor(null)}
            onSaved={() => { void refreshSkills(); }}
          />
        )}

        {/* Phase 3 (operator-features) — Handoff prompt overrides. Edits the
            two reflection prompts (`original-worker` and `fresh-summarizer`)
            that runExportContext loads from .arco/handoff*.prompt.md;
            project beats global beats default. Variables {{cwd}} / {{wfid}}
            / {{handoffPath}} / {{seedPrefix}} substitute at runtime. */}
        <SettingsSection id="handoff-prompts">
        <HandoffPromptsEditor cwd={activeCwd} />
        </SettingsSection>

        {/* Slot 12 — model catalog editor. Inline expandable section instead
            of a separate modal; operator-edited models.md drives orchestrator
            first-turn routing injection, so exposing it in-app closes the
            "operator-configurable catalog overrides surfaced in UI" item
            without adding another header button. */}
        <SettingsSection id="catalog">
        <div data-help="settings.catalog">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)' }}>
              MODEL CATALOG
            </span>
            {!catalogOpen && (
              <button
                onClick={openCatalogEditor}
                className="display-font"
                style={{
                  padding: '4px 10px',
                  background: 'var(--color-accent-secondary-a08)',
                  border: '1px solid var(--color-accent-secondary-dim)',
                  borderRadius: '3px',
                  color: 'var(--color-accent-secondary)',
                  cursor: 'pointer',
                  fontSize: '10px',
                  letterSpacing: '1.5px',
                }}
              >
                EDIT
              </button>
            )}
          </div>
          {!catalogOpen && (
            <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: '1.6' }}>
              ~/.arco/models.md — routing brain injected to the orchestrator's first turn. Edits take effect on the next fresh / resumed / auto-compacted session.
            </div>
          )}
          {catalogOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <textarea
                value={catalogDraft}
                onChange={(e) => setCatalogDraft(e.target.value)}
                spellCheck={false}
                rows={18}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  background: 'var(--color-bg-sunken)',
                  border: '1px solid var(--color-border-hairline)',
                  borderRadius: '3px',
                  color: 'var(--color-accent-primary)',
                  fontSize: '11px',
                  fontFamily: 'var(--font-body)',
                  lineHeight: '1.5',
                  resize: 'vertical',
                  boxSizing: 'border-box',
                  minHeight: '240px',
                }}
              />
              {catalogError && (
                <div style={{ fontSize: '10px', color: 'var(--color-warning)', fontFamily: 'var(--font-body)' }}>
                  {catalogError}
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={saveCatalog}
                  disabled={catalogSaving}
                  className="display-font"
                  style={{
                    flex: 1,
                    padding: '6px 12px',
                    background: 'var(--color-accent-primary-a10)',
                    border: '1px solid var(--color-accent-primary)',
                    borderRadius: '3px',
                    color: 'var(--color-accent-primary)',
                    cursor: catalogSaving ? 'default' : 'pointer',
                    fontSize: '10px',
                    letterSpacing: '1.5px',
                    opacity: catalogSaving ? 0.6 : 1,
                  }}
                >
                  {catalogSaving ? 'SAVING…' : 'SAVE'}
                </button>
                <button
                  onClick={cancelCatalogEdit}
                  disabled={catalogSaving}
                  className="display-font"
                  style={{
                    flex: 1,
                    padding: '6px 12px',
                    background: 'transparent',
                    border: '1px solid var(--color-border-hairline)',
                    borderRadius: '3px',
                    color: 'var(--color-fg-muted)',
                    cursor: catalogSaving ? 'default' : 'pointer',
                    fontSize: '10px',
                    letterSpacing: '1.5px',
                  }}
                >
                  CANCEL
                </button>
              </div>
            </div>
          )}
        </div>
        </SettingsSection>

        <SettingsSection id="cli-versions">
          <AppVersionSection />
          {capabilities && (
          <div>
            <div data-help="settings.cli-versions" className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>
              CLI VERSIONS
            </div>
            <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: '1.6' }}>
              <div>Claude CLI: v{capabilities.cliVersion}</div>
              <div>Gemini CLI: {capabilities.geminiVersion && capabilities.geminiVersion !== 'unknown' ? `v${capabilities.geminiVersion}` : 'not installed'}</div>
              <div>Codex CLI: {capabilities.codexVersion && capabilities.codexVersion !== 'unknown' ? `v${capabilities.codexVersion}` : 'not installed'}</div>
              <div>Ollama daemon: {ollamaLive?.up && ollamaLive.version ? `v${ollamaLive.version}` : ollamaLive?.up ? 'up (version unknown)' : 'not running'}</div>
            </div>
          </div>
          )}
        </SettingsSection>

    </SettingsLayout>
  );
}

// Global default transport for newly-created Codex / Claude tabs. Visual
// style mirrors the per-tab CONFIG-tab toggles in RightPanel.tsx so
// operators reading both surfaces see the same chip shape. The per-tab
// override always wins; this section only writes the cascade defaults.
function CodexTransportDefaultsSection() {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const codexCurrent: 'exec' | 'appserver' = settings?.codex?.transport ?? 'appserver';
  const claudeCurrent: 'cli' | 'native' = settings?.claude?.transport ?? 'native';
  const [saving, setSaving] = useState<'codex' | 'claude' | null>(null);

  const applyCodex = async (next: 'exec' | 'appserver') => {
    if (next === codexCurrent || saving) return;
    setSaving('codex');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codex: { transport: next } }),
      });
      if (res.ok) {
        const data = (await res.json()) as ArcoSettings;
        setSettings(data);
      }
    } catch { /* HMR will reconcile */ }
    finally { setSaving(null); }
  };

  const applyClaude = async (next: 'cli' | 'native') => {
    if (next === claudeCurrent || saving) return;
    setSaving('claude');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claude: { transport: next } }),
      });
      if (res.ok) {
        const data = (await res.json()) as ArcoSettings;
        setSettings(data);
      }
    } catch { /* HMR will reconcile */ }
    finally { setSaving(null); }
  };

  const renderRow = <T extends string>(opts: {
    label: string;
    current: T;
    options: readonly T[];
    starOn: T;
    onPick: (v: T) => void;
    busyKey: 'codex' | 'claude';
    helper: string;
  }) => {
    const isBusy = saving === opts.busyKey;
    return (
      <>
        <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.6, marginBottom: '8px' }}>
          {opts.label}
        </div>
        <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
          {opts.options.map((t) => {
            const active = opts.current === t;
            return (
              <button
                key={t}
                type="button"
                className="display-font"
                onClick={() => { void opts.onPick(t); }}
                disabled={!!saving}
                style={{
                  flex: 1,
                  padding: '6px 10px',
                  fontSize: '10px',
                  letterSpacing: '1.5px',
                  border: '1px solid ' + (active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
                  background: active ? 'var(--color-accent-primary-a10, transparent)' : 'transparent',
                  color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                  borderRadius: '3px',
                  cursor: saving ? 'default' : 'pointer',
                  opacity: isBusy ? 0.7 : 1,
                  outline: 'none',
                }}
              >
                {t.toUpperCase()}{t === opts.starOn ? ' *' : ''}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5, marginBottom: '14px' }}>
          {opts.helper}
        </div>
      </>
    );
  };

  return (
    <div data-help="settings.transport-defaults">
      <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>
        TRANSPORT DEFAULTS
      </div>
      {renderRow({
        label: 'Codex transport for new tabs',
        current: codexCurrent,
        options: ['exec', 'appserver'] as const,
        starOn: 'appserver',
        onPick: applyCodex,
        busyKey: 'codex',
        helper: 'Default: app-server. New Codex tabs use this transport; existing tabs keep their setting.',
      })}
      {renderRow({
        label: 'Claude transport for new tabs',
        current: claudeCurrent,
        options: ['cli', 'native'] as const,
        starOn: 'native',
        onPick: applyClaude,
        busyKey: 'claude',
        helper: 'Default: native. New Claude tabs use this transport; existing tabs keep their setting.',
      })}
    </div>
  );
}

// Global auto-handoff default for newly-created tabs. Mirrors the per-tab
// AUTO-HANDOFF section in the CONFIG tab; the per-tab value always wins, so
// this only seeds tabs that have never been touched. Writes the full
// {enabled,warnAt,autoAt} via POST /api/settings — sliders commit on release
// (onMouseUp/onTouchEnd) so a drag doesn't hammer the settings file.
function AutoHandoffDefaultsSection() {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const gd = settings?.autoHandoffDefaults;
  const enabled = gd?.enabled ?? true;
  const warnAt = gd?.warnAt ?? 75;
  const autoAt = gd?.autoAt ?? 90;
  const mode: 'original-worker' | 'fresh-summarizer' = gd?.mode ?? 'original-worker';
  const [saving, setSaving] = useState(false);
  // Live slider positions while dragging; committed on release.
  const [warnDraft, setWarnDraft] = useState(warnAt);
  const [autoDraft, setAutoDraft] = useState(autoAt);
  useEffect(() => { setWarnDraft(warnAt); }, [warnAt]);
  useEffect(() => { setAutoDraft(autoAt); }, [autoAt]);

  const commit = async (next: { enabled: boolean; warnAt: number; autoAt: number; mode?: 'original-worker' | 'fresh-summarizer' }) => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoHandoffDefaults: next }),
      });
      if (res.ok) setSettings((await res.json()) as ArcoSettings);
    } catch { /* HMR will reconcile */ }
    finally { setSaving(false); }
  };

  // WP5 — global default summarizer setter (settings.handoffSummarizer). This
  // is the model that WRITES a handoff in fresh-summarizer mode; pinning a
  // strong fresh agent here is the fix for "a fried worker summarizing itself".
  // Persisted separately from autoHandoffDefaults so the same value backs both
  // manual handoffs (dialog default) and auto-handoffs. Provider is required;
  // model/effort optional (resolver fills from the tab's primary when absent).
  const hs = settings?.handoffSummarizer;
  const commitSummarizer = async (next: { provider: ProviderName; model?: ModelName; effort?: EffortLevel } | null) => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // null clears it back to "use the tab's current primary".
        body: JSON.stringify({ handoffSummarizer: next }),
      });
      if (res.ok) setSettings((await res.json()) as ArcoSettings);
    } catch { /* HMR will reconcile */ }
    finally { setSaving(false); }
  };
  // For the picker, default to claude when nothing is pinned. `current` is the
  // reset target — same default so RESET TO CURRENT clears any local drift.
  const summarizerSelection: RunAsSelection = {
    provider: hs?.provider ?? 'claude',
    model: (hs?.model as ModelName) ?? ('' as ModelName),
    effort: hs?.effort ?? 'medium',
  };

  return (
    <div data-help="settings.auto-handoff-defaults" style={{ marginTop: '18px' }}>
      <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>
        AUTO-HANDOFF DEFAULTS
      </div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
        {(['on', 'off'] as const).map((opt) => {
          const active = opt === (enabled ? 'on' : 'off');
          return (
            <button
              key={opt}
              type="button"
              className="display-font"
              disabled={saving}
              onClick={() => { void commit({ enabled: opt === 'on', warnAt, autoAt, mode }); }}
              style={{
                flex: 1,
                padding: '6px 10px',
                fontSize: '10px',
                letterSpacing: '1.5px',
                border: '1px solid ' + (active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
                background: active ? 'var(--color-accent-primary-a10, transparent)' : 'transparent',
                color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                borderRadius: '3px',
                cursor: saving ? 'default' : 'pointer',
                outline: 'none',
              }}
            >
              {opt === 'on' ? 'ENABLED' : 'DISABLED'}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px', fontFamily: 'var(--font-body)', marginBottom: '8px', opacity: enabled ? 1 : 0.45 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-fg-muted)' }}>
          <span style={{ minWidth: '42px', fontFamily: 'var(--font-display)', fontSize: '10px', letterSpacing: '1px' }}>WARN</span>
          <input
            type="range"
            min={60}
            max={85}
            value={warnDraft}
            disabled={saving || !enabled}
            onChange={(e) => setWarnDraft(Number(e.target.value))}
            onMouseUp={() => { if (warnDraft !== warnAt) void commit({ enabled, warnAt: warnDraft, autoAt, mode }); }}
            onTouchEnd={() => { if (warnDraft !== warnAt) void commit({ enabled, warnAt: warnDraft, autoAt, mode }); }}
            style={{ flex: 1, accentColor: 'var(--color-warning)' }}
          />
          <span style={{ minWidth: '28px', textAlign: 'right', color: 'var(--color-warning)' }}>{warnDraft}%</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-fg-muted)' }}>
          <span style={{ minWidth: '42px', fontFamily: 'var(--font-display)', fontSize: '10px', letterSpacing: '1px' }}>AUTO</span>
          <input
            type="range"
            min={75}
            max={95}
            value={autoDraft}
            disabled={saving || !enabled}
            onChange={(e) => setAutoDraft(Number(e.target.value))}
            onMouseUp={() => { if (autoDraft !== autoAt) void commit({ enabled, warnAt, autoAt: autoDraft, mode }); }}
            onTouchEnd={() => { if (autoDraft !== autoAt) void commit({ enabled, warnAt, autoAt: autoDraft, mode }); }}
            style={{ flex: 1, accentColor: 'var(--color-danger, #f04a4a)' }}
          />
          <span style={{ minWidth: '28px', textAlign: 'right', color: 'var(--color-danger, #f04a4a)' }}>{autoDraft}%</span>
        </label>
      </div>
      {/* WP5 — global default MODE. Per-tab CONFIG mode wins; non-resumable
          providers (ollama) always fall back to fresh-summarizer regardless. */}
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)', marginBottom: '6px' }}>
        DEFAULT MODE
      </div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
        {(['original-worker', 'fresh-summarizer'] as const).map((opt) => {
          const active = opt === mode;
          return (
            <button
              key={opt}
              type="button"
              className="display-font"
              disabled={saving}
              onClick={() => { void commit({ enabled, warnAt, autoAt, mode: opt }); }}
              style={{
                flex: 1,
                padding: '6px 10px',
                fontSize: '9px',
                letterSpacing: '1px',
                border: '1px solid ' + (active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
                background: active ? 'var(--color-accent-primary-a10, transparent)' : 'transparent',
                color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                borderRadius: '3px',
                cursor: saving ? 'default' : 'pointer',
                outline: 'none',
              }}
            >
              {opt === 'original-worker' ? 'ORIGINAL WORKER' : 'FRESH SUMMARIZER'}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5, marginBottom: '14px' }}>
        Starting auto-handoff state for new tabs. Existing tabs keep their per-tab setting. Disable to lean on Arco's between-turn compaction or manual context handling by default.
      </div>

      {/* WP6 — global default summarizer (settings.handoffSummarizer). Only
          relevant under fresh-summarizer mode, so the whole block is hidden
          when the global Default Mode is original-worker (mirrors the per-tab
          CONFIG panel, which only shows the summarizer picker for fresh). */}
      {mode === 'fresh-summarizer' && (
        <>
          <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '6px' }}>
            DEFAULT SUMMARIZER
            {hs && (
              <button
                type="button"
                className="display-font"
                disabled={saving}
                onClick={() => { void commitSummarizer(null); }}
                style={{
                  marginLeft: '8px',
                  padding: '1px 6px',
                  background: 'transparent',
                  border: '1px solid var(--color-border-hairline)',
                  borderRadius: '3px',
                  color: 'var(--color-accent-secondary-dim)',
                  cursor: saving ? 'default' : 'pointer',
                  fontSize: '8px',
                  letterSpacing: '1px',
                }}
                title="Clear the pin — handoffs fall back to the tab's current primary"
              >
                ✕ CLEAR
              </button>
            )}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5, marginBottom: '8px' }}>
            The model that WRITES a handoff in fresh-summarizer mode. Applies to BOTH manual handoffs (dialog default) and auto-handoffs — pin a strong fresh agent here to fix "a fried worker summarizing itself". Unset ⇒ falls back to the tab's current primary.
          </div>
          <RunAsPicker
            current={summarizerSelection}
            selection={summarizerSelection}
            onChange={(next) => { void commitSummarizer({ provider: next.provider, model: next.model, effort: next.effort }); }}
          />
        </>
      )}
    </div>
  );
}

// Global default for Anthropic server-side compaction (`compact_20260112`) on
// newly-created Claude Native tabs. Mirrors AutoHandoffDefaultsSection: writes
// settings.claudeNativeCompactDefault via POST /api/settings; the server seeds
// config.claudeNativeCompact on workflow create. Per-tab CONFIG toggle always
// wins. Default OFF — see NATIVE_COMPACTION_PLAN §1.
function ClaudeNativeCompactDefaultSection() {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const enabled = settings?.claudeNativeCompactDefault === true;
  const [saving, setSaving] = useState(false);

  const commit = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claudeNativeCompactDefault: next }),
      });
      if (res.ok) setSettings((await res.json()) as ArcoSettings);
    } catch { /* HMR will reconcile */ }
    finally { setSaving(false); }
  };

  return (
    <div style={{ marginTop: '18px' }} data-help="settings.claude-native-compact-default">
      <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>
        ANTHROPIC COMPACTION DEFAULT
      </div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
        {(['on', 'off'] as const).map((opt) => {
          const active = opt === (enabled ? 'on' : 'off');
          return (
            <button
              key={opt}
              type="button"
              className="display-font"
              disabled={saving}
              onClick={() => { void commit(opt === 'on'); }}
              style={{
                flex: 1,
                padding: '6px 10px',
                fontSize: '10px',
                letterSpacing: '1.5px',
                border: '1px solid ' + (active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
                background: active ? 'var(--color-accent-primary-a10, transparent)' : 'transparent',
                color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                borderRadius: '3px',
                cursor: saving ? 'default' : 'pointer',
                outline: 'none',
              }}
            >
              {opt === 'on' ? 'ENABLED' : 'DISABLED'}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5, marginBottom: '14px' }}>
        ⚠ Starting state for Anthropic server-side compaction on new Claude Native tabs. Defaults OFF: the server-side beta is folded into the live turn but fires mid-turn at a fixed ~150K tokens regardless of window, and on large-window or Read-heavy coding tabs it can evict the working set and cause a re-read spiral. Best for research / non-coding. Leave OFF to use Arco's between-turn compaction. Existing tabs keep their per-tab toggle; the per-tab CONFIG setting always wins.
      </div>
    </div>
  );
}

// DD7 — the standing project-trust manager. The turn-time gate raises ONE
// prompt per cwd per server lifetime, rendered in the composer of whichever tab
// hit the gate first; miss it (you were on the cluster parent tab, or a peer
// consumed it) and the repo stays silently suppressed with no way back short of
// hand-editing ~/.arco/trust.json. This is that way back, and it's global —
// no tab or cluster needed. Per-tab CONFIG and the cluster header chip write
// the same file.
function ProjectTrustSection({ activeCwd }: { activeCwd: string }) {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const { snapshot, busy, refresh, setTrust } = useProjectTrust();
  const [draft, setDraft] = useState('');
  const [savingDefault, setSavingDefault] = useState(false);

  const entries = snapshot?.entries ?? [];
  const fallback = snapshot?.defaultProjectTrust ?? settings?.defaultProjectTrust ?? 'ask';

  const commitDefault = async (next: 'ask' | 'always' | 'never') => {
    if (savingDefault) return;
    setSavingDefault(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultProjectTrust: next }),
      });
      if (res.ok) setSettings((await res.json()) as ArcoSettings);
      await refresh();
    } catch { /* next refresh reconciles */ }
    finally { setSavingDefault(false); }
  };

  const add = async (decision: 'always' | 'never') => {
    const path = draft.trim();
    if (!path) return;
    await setTrust(path, decision);
    setDraft('');
  };

  return (
    <div style={{ marginTop: '18px' }} data-help="settings.project-trust">
      <div className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>
        PROJECT TRUST
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.6, marginBottom: '10px' }}>
        An untrusted repo's <code>CLAUDE.md</code>, project skills, and <code>.arco/settings.json</code> stay out of every turn — a cloned repo can't inject instructions into your agent before you've read them. Decisions are keyed by directory (nearest ancestor wins) and cover every tab and cluster member pointed at it. Recorded in <code>~/.arco/trust.json</code>; effective on the next turn, no restart.
      </div>

      {/* Fallback for a cwd with no recorded decision. 'ask' is the safe
          default — 'always' blanket-trusts every repo you ever open. */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
        {(['ask', 'always', 'never'] as const).map((opt) => {
          const active = opt === fallback;
          return (
            <button
              key={opt}
              type="button"
              className="display-font"
              disabled={savingDefault}
              onClick={() => { void commitDefault(opt); }}
              title={
                opt === 'ask'
                  ? 'Prompt once per new repo (recommended).'
                  : opt === 'always'
                    ? 'Trust every repo by default — disables the injection gate.'
                    : 'Suppress project files in every repo unless explicitly trusted.'
              }
              style={{
                flex: 1,
                padding: '6px 10px',
                fontSize: '10px',
                letterSpacing: '1.5px',
                border: '1px solid ' + (active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
                background: active ? 'var(--color-accent-primary-a10, transparent)' : 'transparent',
                color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                borderRadius: '3px',
                cursor: savingDefault ? 'default' : 'pointer',
              }}
            >
              DEFAULT: {opt.toUpperCase()}
            </button>
          );
        })}
      </div>

      {/* Add / override a path. Prefilled with the active tab's cwd so the
          common case (the repo whose prompt you just missed) is one click. */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => { if (!draft && activeCwd) setDraft(activeCwd); }}
          placeholder={activeCwd || '/path/to/repo'}
          spellCheck={false}
          style={{
            flex: 1,
            padding: '5px 8px',
            fontSize: '11px',
            fontFamily: 'var(--font-code)',
            background: 'var(--color-bg-input, transparent)',
            border: '1px solid var(--color-border-hairline)',
            color: 'var(--color-text-primary)',
            borderRadius: '3px',
          }}
        />
        <button
          type="button"
          className="display-font"
          disabled={busy || !draft.trim()}
          onClick={() => { void add('always'); }}
          style={{ padding: '5px 10px', fontSize: '10px', letterSpacing: '1.5px', border: '1px solid var(--color-accent-primary-dim)', background: 'var(--color-accent-primary-a06, transparent)', color: 'var(--color-accent-primary)', borderRadius: '3px', cursor: busy || !draft.trim() ? 'default' : 'pointer' }}
        >
          TRUST
        </button>
        <button
          type="button"
          className="display-font"
          disabled={busy || !draft.trim()}
          onClick={() => { void add('never'); }}
          style={{ padding: '5px 10px', fontSize: '10px', letterSpacing: '1.5px', border: '1px solid var(--color-border-hairline)', background: 'transparent', color: 'var(--color-fg-muted)', borderRadius: '3px', cursor: busy || !draft.trim() ? 'default' : 'pointer' }}
        >
          BLOCK
        </button>
      </div>

      {entries.length === 0 ? (
        <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)' }}>
          No decisions recorded — every repo follows the default above.
        </div>
      ) : (
        entries.map((e) => (
          <div
            key={e.path}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', borderTop: '1px solid var(--color-border-hairline)' }}
          >
            <code
              title={e.path}
              style={{ flex: 1, fontSize: '10px', fontFamily: 'var(--font-code)', color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {e.path}
            </code>
            <span
              className="display-font"
              style={{ fontSize: '9px', letterSpacing: '1px', color: e.decision === 'always' ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)' }}
            >
              {e.decision === 'always' ? 'TRUSTED' : 'BLOCKED'}
            </span>
            <button
              type="button"
              className="display-font"
              disabled={busy}
              onClick={() => { void setTrust(e.path, e.decision === 'always' ? 'never' : 'always'); }}
              title={e.decision === 'always' ? 'Flip to blocked' : 'Flip to trusted'}
              style={{ padding: '2px 8px', fontSize: '9px', letterSpacing: '1px', border: '1px solid var(--color-border-hairline)', background: 'transparent', color: 'var(--color-fg-muted)', borderRadius: '2px', cursor: busy ? 'default' : 'pointer' }}
            >
              FLIP
            </button>
            <button
              type="button"
              className="display-font"
              disabled={busy}
              onClick={() => { void setTrust(e.path, 'clear'); }}
              title="Forget this decision — the next turn in that repo prompts again"
              style={{ padding: '2px 8px', fontSize: '9px', letterSpacing: '1px', border: '1px solid var(--color-error, #e0524f)', background: 'transparent', color: 'var(--color-error, #e0524f)', borderRadius: '2px', cursor: busy ? 'default' : 'pointer' }}
            >
              FORGET
            </button>
          </div>
        ))
      )}
    </div>
  );
}

interface ProviderRowProps {
  label: string;
  provider?: ProviderName;
  status?: AuthStatus;
  loginPending: boolean;
  onLogin: () => void;
  // Local providers are auth-less. The secondary line surfaces installed-models
  // count plus (for llama.cpp) the currently-loaded model alias from the
  // lifecycle manager — Ollama's daemon manages its own loaded-model state and
  // surfaces that elsewhere (header chip + ollamaLive snapshot).
  variant?: 'ollama' | 'llamacpp' | 'lmstudio' | 'strata';
  // llama.cpp-only: alias of the model currently in VRAM (lifecycle manager
  // state). Shown in the subline when present so operators see at a glance
  // which loadout is hot.
  loadedModel?: string | null;
}

type CodexProfileDraft = ProviderAccountProfile & { authArgsText?: string };

function defaultCodexProfileDraft(n: number): CodexProfileDraft {
  const id = n <= 1 ? 'work' : n === 2 ? 'home' : `profile${n}`;
  const label = n <= 1 ? 'Work' : n === 2 ? 'Home' : `Profile ${n}`;
  const shortLabel = n <= 1 ? 'W' : n === 2 ? 'H' : String(n);
  return {
    id,
    label,
    shortLabel,
    codexHome: `~/.arco/provider-accounts/codex-${id}`,
    authBrowser: { command: '' },
    authArgsText: '',
  };
}

function normalizeCodexProfiles(profiles: CodexProfileDraft[]): ProviderAccountProfile[] {
  return profiles
    .map((p) => {
      const id = p.id.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
      if (!id) return null;
      const label = (p.label.trim() || id).slice(0, 32);
      const shortLabel = p.shortLabel?.trim().slice(0, 4);
      const codexHome = p.codexHome?.trim();
      const command = p.authBrowser?.command?.trim();
      const args = (p.authArgsText ?? p.authBrowser?.args?.join(' ') ?? '')
        .split(/\s+/)
        .map((a) => a.trim())
        .filter(Boolean)
        .slice(0, 16);
      const out: ProviderAccountProfile = {
        id,
        label,
        ...(shortLabel ? { shortLabel } : {}),
        ...(codexHome ? { codexHome } : {}),
      };
      if (command) out.authBrowser = args.length > 0 ? { command, args } : { command };
      return out;
    })
    .filter((p): p is ProviderAccountProfile => Boolean(p));
}

function CodexProfilesSection() {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const authStatus = useAppStore((s) => s.authStatus);
  const setAuthStatus = useAppStore((s) => s.setAuthStatus);
  const [drafts, setDrafts] = useState<CodexProfileDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [loginPending, setLoginPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loginCommand, setLoginCommand] = useState<{ id: string; command: string } | null>(null);
  const [editingIds, setEditingIds] = useState<Set<string>>(new Set());
  const savedProfileIds = new Set((settings?.providerAccounts?.codex ?? []).map((p) => p.id));
  const providerLoggedIn = authStatus?.codex?.loggedIn === true;
  const profileCount = settings?.providerAccounts?.codex?.length ?? 0;
  const liveProfileCount = authStatus?.codex?.accountStatuses?.filter((s) => s.loggedIn).length ?? 0;
  const codexSubline = profileCount > 0
    ? `${profileCount} profile${profileCount === 1 ? '' : 's'} configured · ${liveProfileCount} live`
    : providerLoggedIn
      ? (authStatus?.codex?.email ? `${authStatus.codex.email} · default Codex auth` : 'default Codex auth live')
      : (authStatus?.codex?.error || 'not authenticated');

  useEffect(() => {
    const profiles = settings?.providerAccounts?.codex ?? [];
    setDrafts(profiles.map((p) => ({
      ...p,
      authArgsText: p.authBrowser?.args?.join(' ') ?? '',
    })));
  }, [settings?.providerAccounts?.codex]);

  const updateDraft = (id: string, patch: Partial<CodexProfileDraft>) => {
    setDrafts((prev) => prev.map((p) => p.id === id ? { ...p, ...patch } : p));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const codex = normalizeCodexProfiles(drafts);
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerAccounts: {
            ...(settings?.providerAccounts ?? {}),
            codex,
          },
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || res.statusText);
      }
      const data = await res.json() as ArcoSettings;
      setSettings(data);
      setEditingIds(new Set());
      const authRes = await fetch('/api/auth-status');
      if (authRes.ok) setAuthStatus(await authRes.json() as AuthStatusByProvider);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const login = async (id: string) => {
    setLoginPending(id);
    setError(null);
    try {
      await save();
      const res = await fetch(`/api/auth-login?provider=codex&account=${encodeURIComponent(id)}`, { method: 'POST' });
      const data = await res.json().catch(() => ({})) as AuthLoginResult & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error || res.statusText);
      if (data.command) {
        setLoginCommand({ id, command: data.command });
      } else if (data.manual) {
        setError(data.manual);
      }
      // Device-code login finishes minutes later in the terminal — poll until
      // this profile reads authenticated (or give up after 10 min).
      const startedAt = Date.now();
      const tick = async () => {
        const authRes = await fetch('/api/auth-status').catch(() => null);
        const status = authRes?.ok ? await authRes.json() as AuthStatusByProvider : null;
        if (status) setAuthStatus(status);
        const done = status?.codex.accountStatuses?.find((a) => a.id === id)?.loggedIn;
        if (done || !data.command || Date.now() - startedAt > 10 * 60 * 1000) {
          setLoginPending(null);
          if (done) setLoginCommand((cur) => (cur?.id === id ? null : cur));
          return;
        }
        setTimeout(() => { void tick(); }, 3000);
      };
      setTimeout(() => { void tick(); }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoginPending(null);
    }
  };

  const inputStyle = {
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box' as const,
    padding: '5px 7px',
    background: 'var(--color-bg-elevated)',
    border: '1px solid var(--color-border-hairline)',
    borderRadius: '3px',
    color: 'var(--color-accent-primary)',
    fontSize: '10px',
    fontFamily: 'var(--font-code)',
  };

  return (
    <div
      data-help="settings.codex-profiles"
      style={{
        border: '1px solid var(--color-border-hairline)',
        borderRadius: '4px',
        padding: '12px 14px',
        background: providerLoggedIn ? 'var(--color-accent-primary-a05)' : 'var(--color-bg-sunken)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '10px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
          <span className="display-font" style={{ fontSize: '12px', letterSpacing: '2px', color: providerLoggedIn ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)' }}>
            CODEX (OPENAI)
          </span>
          <span style={{ fontSize: '10px', color: providerLoggedIn ? 'var(--color-accent-primary-dim)' : 'var(--color-warning-dim)', fontFamily: 'var(--font-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {codexSubline}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {providerLoggedIn && (
            <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-accent-primary)', padding: '4px 10px', border: '1px solid var(--color-accent-primary)', borderRadius: '3px' }}>
              LIVE
            </span>
          )}
          <button
            onClick={() => setDrafts((prev) => [...prev, defaultCodexProfileDraft(prev.length + 1)])}
            className="display-font"
            style={{ padding: '4px 8px', fontSize: '9px', letterSpacing: '1px', background: 'transparent', border: '1px solid var(--color-border-hairline)', color: 'var(--color-accent-primary-dim)', borderRadius: '3px', cursor: 'pointer' }}
          >
            + ADD
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="display-font"
            style={{ padding: '4px 10px', fontSize: '9px', letterSpacing: '1px', background: 'var(--color-accent-primary-a10)', border: '1px solid var(--color-accent-primary)', color: 'var(--color-accent-primary)', borderRadius: '3px', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1 }}
          >
            {saving ? 'SAVING...' : 'SAVE'}
          </button>
        </div>
      </div>
      <div className="display-font" style={{ fontSize: '9px', letterSpacing: '1.5px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' }}>
        PROFILES
      </div>
      {drafts.length === 0 && (
        <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', marginBottom: '8px' }}>
          Add Work and Home profiles to route Codex tabs through separate CODEX_HOME directories.
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {drafts.map((profile, index) => {
          const status = authStatus?.codex?.accountStatuses?.find((s) => s.id === profile.id);
          const loggedIn = status?.loggedIn === true;
          const saved = savedProfileIds.has(profile.id);
          const editing = !saved || editingIds.has(profile.id);
          return (
            <div key={`${profile.id}:${index}`} style={{ border: '1px solid var(--color-border-hairline)', borderRadius: '3px', padding: '8px', background: 'var(--color-bg-panel)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-accent-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {(profile.label || profile.id || 'Codex profile').toUpperCase()}
                </span>
                <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: saved ? 'var(--color-accent-primary-dim)' : 'var(--color-warning-dim)', border: `1px solid ${saved ? 'var(--color-border-hairline)' : 'var(--color-warning-dim)'}`, borderRadius: '3px', padding: '2px 6px', flexShrink: 0 }}>
                  {saved ? 'SAVED' : 'DRAFT'}
                </span>
                {loggedIn && (
                  <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-accent-primary)', border: '1px solid var(--color-accent-primary)', borderRadius: '3px', padding: '2px 6px', flexShrink: 0 }}>
                    LIVE
                  </span>
                )}
              </div>
              {editing ? (
                <>
                  <div className="display-font" style={{ display: 'grid', gridTemplateColumns: 'minmax(70px, 0.8fr) minmax(90px, 1fr) 54px', gap: '6px', marginBottom: '3px', fontSize: '8px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
                    <span>PROFILE ID</span>
                    <span>NAME</span>
                    <span>BADGE</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(70px, 0.8fr) minmax(90px, 1fr) 54px', gap: '6px', marginBottom: '6px' }}>
                    <input
                      value={profile.id}
                      onChange={(e) => {
                        const nextId = e.target.value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
                        setDrafts((prev) => prev.map((p, i) => i === index ? { ...p, id: nextId } : p));
                      }}
                      placeholder="id"
                      style={inputStyle}
                      title="Profile id"
                    />
                    <input
                      value={profile.label}
                      onChange={(e) => updateDraft(profile.id, { label: e.target.value.slice(0, 32) })}
                      placeholder="Label"
                      style={inputStyle}
                    />
                    <input
                      value={profile.shortLabel ?? ''}
                      onChange={(e) => updateDraft(profile.id, { shortLabel: e.target.value.slice(0, 4) })}
                      placeholder="W"
                      style={{ ...inputStyle, textAlign: 'center' }}
                      title="Tab badge"
                    />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '6px', marginBottom: '6px' }}>
                    <input
                      value={profile.codexHome ?? ''}
                      onChange={(e) => updateDraft(profile.id, { codexHome: e.target.value })}
                      placeholder="~/.arco/provider-accounts/codex-work"
                      style={inputStyle}
                      title="CODEX_HOME"
                    />
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 0.8fr) minmax(120px, 1fr)', gap: '6px' }}>
                      <input
                        value={profile.authBrowser?.command ?? ''}
                        onChange={(e) => updateDraft(profile.id, { authBrowser: { ...(profile.authBrowser ?? { command: '' }), command: e.target.value } })}
                        placeholder="brave-browser"
                        style={inputStyle}
                        title="Auth browser command"
                      />
                      <input
                        value={profile.authArgsText ?? ''}
                        onChange={(e) => updateDraft(profile.id, { authArgsText: e.target.value })}
                        placeholder="optional args, use {url} if needed"
                        style={inputStyle}
                        title="Auth browser args"
                      />
                    </div>
                  </div>
                </>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '4px', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', gap: '8px', minWidth: 0, fontSize: '10px', fontFamily: 'var(--font-body)', color: 'var(--color-fg-muted)' }}>
                    <span className="display-font" style={{ minWidth: '58px', color: 'var(--color-accent-primary-dim)', letterSpacing: '1px' }}>ID</span>
                    <span style={{ color: 'var(--color-accent-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile.id}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', minWidth: 0, fontSize: '10px', fontFamily: 'var(--font-body)', color: 'var(--color-fg-muted)' }}>
                    <span className="display-font" style={{ minWidth: '58px', color: 'var(--color-accent-primary-dim)', letterSpacing: '1px' }}>HOME</span>
                    <span style={{ color: 'var(--color-accent-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile.codexHome || '~/.codex'}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', minWidth: 0, fontSize: '10px', fontFamily: 'var(--font-body)', color: 'var(--color-fg-muted)' }}>
                    <span className="display-font" style={{ minWidth: '58px', color: 'var(--color-accent-primary-dim)', letterSpacing: '1px' }}>BROWSER</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile.authBrowser?.command || 'system default'}{profile.authBrowser?.args?.length ? ` ${profile.authBrowser.args.join(' ')}` : ''}</span>
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <span style={{ fontSize: '10px', color: loggedIn ? 'var(--color-accent-primary-dim)' : 'var(--color-warning-dim)', fontFamily: 'var(--font-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {loggedIn ? `Authenticated${status?.email ? ` · ${status.email}` : ''}` : (status?.error || 'not authenticated')}
                </span>
                <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                  {saved && !editing && (
                    <button
                      onClick={() => setEditingIds((prev) => new Set(prev).add(profile.id))}
                      className="display-font"
                      style={{ padding: '3px 8px', fontSize: '9px', letterSpacing: '1px', background: 'transparent', border: '1px solid var(--color-border-hairline)', color: 'var(--color-accent-primary-dim)', borderRadius: '3px', cursor: 'pointer' }}
                    >
                      EDIT
                    </button>
                  )}
                  {saved && editing && (
                    <button
                      onClick={() => {
                        const savedProfile = settings?.providerAccounts?.codex?.find((p) => p.id === profile.id);
                        if (savedProfile) {
                          setDrafts((prev) => prev.map((p, i) => i === index ? { ...savedProfile, authArgsText: savedProfile.authBrowser?.args?.join(' ') ?? '' } : p));
                        }
                        setEditingIds((prev) => {
                          const next = new Set(prev);
                          next.delete(profile.id);
                          return next;
                        });
                      }}
                      className="display-font"
                      style={{ padding: '3px 8px', fontSize: '9px', letterSpacing: '1px', background: 'transparent', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg-muted)', borderRadius: '3px', cursor: 'pointer' }}
                    >
                      CANCEL
                    </button>
                  )}
                  {editing && (
                    <button
                      onClick={() => { void save(); }}
                      disabled={saving}
                      className="display-font"
                      style={{ padding: '3px 8px', fontSize: '9px', letterSpacing: '1px', background: 'var(--color-accent-primary-a10)', border: '1px solid var(--color-accent-primary)', color: 'var(--color-accent-primary)', borderRadius: '3px', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1 }}
                      title="Save profile metadata without re-authenticating"
                    >
                      {saving ? '...' : 'SAVE CHANGES'}
                    </button>
                  )}
                  <button
                    onClick={() => { void login(profile.id); }}
                    disabled={!profile.id || loginPending === profile.id}
                    className="display-font"
                    style={{ padding: '3px 8px', fontSize: '9px', letterSpacing: '1px', background: 'transparent', border: '1px solid var(--color-accent-primary)', color: 'var(--color-accent-primary)', borderRadius: '3px', cursor: loginPending === profile.id ? 'default' : 'pointer', opacity: loginPending === profile.id ? 0.7 : 1 }}
                  >
                    {loginPending === profile.id ? '...' : loggedIn ? 'RE-LOGIN' : 'LOGIN'}
                  </button>
                  <button
                    onClick={() => setDrafts((prev) => prev.filter((_, i) => i !== index))}
                    className="display-font"
                    style={{ padding: '3px 8px', fontSize: '10px', letterSpacing: '1px', background: 'transparent', border: '1px solid var(--color-warning-dim)', color: 'var(--color-warning-dim)', borderRadius: '3px', cursor: 'pointer' }}
                    title="Remove profile"
                  >
                    ×
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {loginCommand && (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ fontSize: '10px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-body)' }}>
            Log in profile "{loginCommand.id}": open the link it prints and enter the one-time code.
          </div>
          <LoginCommand command={loginCommand.command} />
        </div>
      )}
      {error && (
        <div style={{ fontSize: '10px', color: 'var(--color-warning-dim)', fontFamily: 'var(--font-body)', marginTop: '8px' }}>
          {error}
        </div>
      )}
    </div>
  );
}

function SkillRow({
  skill,
  onEdit,
  onDelete,
}: {
  skill: SkillSummary;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 10px',
        border: '1px solid var(--color-border-hairline)',
        borderRadius: '3px',
        background: 'var(--color-bg-sunken)',
      }}
    >
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
        <span
          className="display-font"
          style={{
            fontSize: '11px',
            letterSpacing: '1.5px',
            color: 'var(--color-accent-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {skill.name}
          {skill.operatorOnly && (
            <span
              className="display-font"
              style={{
                marginLeft: '8px',
                fontSize: '8px',
                letterSpacing: '1px',
                color: 'var(--color-warning)',
                border: '1px solid var(--color-warning)',
                borderRadius: '2px',
                padding: '1px 4px',
                opacity: 0.85,
              }}
              title="Operator-only — withheld from the model manifest; inline it by picking from the composer"
            >
              OPERATOR
            </span>
          )}
          <span
            className="display-font"
            style={{
              marginLeft: '8px',
              fontSize: '9px',
              letterSpacing: '0.5px',
              color: 'var(--color-fg-muted)',
              opacity: (skill.useCount ?? 0) > 0 ? 0.8 : 0.5,
            }}
            title="Counted when the agent Reads this skill's SKILL.md"
          >
            {formatSkillUsage(skill)}
          </span>
        </span>
        <span
          style={{
            fontSize: '10px',
            color: 'var(--color-fg-muted)',
            fontFamily: 'var(--font-body)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={skill.description}
        >
          {skill.description || <em style={{ opacity: 0.6 }}>(no description)</em>}
        </span>
      </div>
      <button
        onClick={onEdit}
        className="display-font"
        style={{
          padding: '3px 8px',
          background: 'transparent',
          border: '1px solid var(--color-border-hairline)',
          borderRadius: '3px',
          color: 'var(--color-accent-primary-dim)',
          cursor: 'pointer',
          fontSize: '9px',
          letterSpacing: '1px',
        }}
      >
        EDIT
      </button>
      <button
        onClick={onDelete}
        className="display-font"
        style={{
          padding: '3px 8px',
          background: 'transparent',
          border: '1px solid var(--color-warning-dim)',
          borderRadius: '3px',
          color: 'var(--color-warning-dim)',
          cursor: 'pointer',
          fontSize: '10px',
          letterSpacing: '1px',
        }}
        title="Delete skill"
      >
        ×
      </button>
    </div>
  );
}

function ProviderRow({ label, provider, status, loginPending, onLogin, variant, loadedModel }: ProviderRowProps) {
  const loggedIn = status?.loggedIn ?? false;
  const isOllama = variant === 'ollama';
  const isLlamacpp = variant === 'llamacpp';
  const isLmstudio = variant === 'lmstudio' || variant === 'strata';
  const usesOpenAiApiKey = provider === 'codex' && status?.apiProvider === 'openai-api-key';
  const endpoint = isOllama && status?.apiProvider?.startsWith('ollama:')
    ? status.apiProvider.slice('ollama:'.length)
    : variant === 'strata' && status?.apiProvider?.startsWith('strata:')
      ? status.apiProvider.slice('strata:'.length)
    : isLmstudio && status?.apiProvider?.startsWith('lmstudio:')
      ? status.apiProvider.slice('lmstudio:'.length)
      : '';
  const subline = (() => {
    if (isOllama || isLlamacpp || isLmstudio) {
      const count = status?.installedModels?.length ?? 0;
      const noun = 'model';
      if (loggedIn) {
        const base = count > 0 ? `${count} ${noun}${count === 1 ? '' : 's'} configured` : `no ${noun}s configured`;
        if (isLlamacpp) {
          return loadedModel ? `${base} · "${loadedModel}" loaded` : `${base} · idle (no model in VRAM)`;
        }
        if (variant === 'strata') return `${base} · available on demand${endpoint ? ` at ${endpoint}` : ''}`;
        if (isLmstudio) {
          return `server up${endpoint ? ` at ${endpoint}` : ''} · ${base.replace('configured', 'loaded')}`;
        }
        return `daemon up${endpoint ? ` at ${endpoint}` : ''} · ${base.replace('configured', 'installed')}`;
      }
      const missing = isLlamacpp ? 'llama-server unavailable' : isLmstudio ? 'server not reachable' : 'daemon not reachable';
      const target = endpoint ? ` at ${endpoint}` : '';
      return status?.error ? `${missing}${target}: ${status.error.slice(0, 60)}` : `${missing}${target}`;
    }
    if (usesOpenAiApiKey) return 'OPENAI_API_KEY fallback active';
    if (provider === 'codex' && status?.apiProvider === 'chatgpt-oauth') {
      return status?.email ? `${status.email} · ChatGPT OAuth` : 'ChatGPT OAuth';
    }
    if (loggedIn) return status?.email || 'authenticated';
    return status?.error ? `error: ${status.error.slice(0, 80)}` : 'not authenticated';
  })();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 14px',
        border: '1px solid var(--color-border-hairline)',
        borderRadius: '4px',
        background: usesOpenAiApiKey ? 'var(--color-warning-a10, rgba(255, 180, 60, 0.08))' : loggedIn ? 'var(--color-accent-primary-a05)' : 'var(--color-bg-sunken)',
      }}
    >
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
        <span className="display-font" style={{ fontSize: '12px', letterSpacing: '2px', color: loggedIn ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)' }}>
          {label}
        </span>
        <span style={{ fontSize: '10px', color: usesOpenAiApiKey ? 'var(--color-warning)' : loggedIn ? 'var(--color-accent-primary-dim)' : 'var(--color-warning-dim)', fontFamily: 'var(--font-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {subline}
        </span>
        {usesOpenAiApiKey && (
          <span style={{ fontSize: '10px', color: 'var(--color-warning-dim)', fontFamily: 'var(--font-body)' }}>
            Codex will inherit API-key billing from the Arco server environment.
          </span>
        )}
      </div>
      {loggedIn ? (
        <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: usesOpenAiApiKey ? 'var(--color-warning)' : 'var(--color-accent-primary)', padding: '4px 10px', border: `1px solid ${usesOpenAiApiKey ? 'var(--color-warning)' : 'var(--color-accent-primary)'}`, borderRadius: '3px' }}>
          {usesOpenAiApiKey ? 'API KEY' : 'LIVE'}
        </span>
      ) : (
        <button
          onClick={onLogin}
          disabled={loginPending}
          className="display-font"
          style={{
            padding: '6px 14px',
            background: loginPending ? 'transparent' : 'var(--color-accent-primary-a10)',
            border: '1px solid var(--color-accent-primary)',
            borderRadius: '3px',
            color: 'var(--color-accent-primary)',
            cursor: loginPending ? 'default' : 'pointer',
            fontSize: '10px',
            letterSpacing: '2px',
            opacity: loginPending ? 0.7 : 1,
          }}
        >
          {loginPending ? 'WAITING…' : (isOllama || isLlamacpp) ? 'HELP' : 'LOG IN'}
        </button>
      )}
    </div>
  );
}

// Collapsible theme picker. Default-collapsed because the full grid is
// 24+ cards and dominates the modal; the header line shows the active
// theme name so the operator knows what's set without expanding. When
// open, themes render as compact pills (name + 4-swatch strip) in their
// own palette; hovering a pill pops the full ThemeCard preview so the
// description + larger swatches are still one mouse-move away.
function ThemePicker({ activeThemeId, onSelect }: { activeThemeId: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const family = THEME_REGISTRY[activeThemeId]?.family ?? 'classic';
  const remembered = useRef({ classic: DEFAULT_THEME_ID, phosphor: 'phosphor:arco:arco-crt' });
  useEffect(() => { remembered.current[family] = activeThemeId; }, [family, activeThemeId]);
  const themes = Object.values(THEME_REGISTRY).filter(t => (t.family ?? 'classic') === family);
  const filtered = themes.filter(t => `${t.name} ${t.id}`.toLowerCase().includes(search.toLowerCase()) && (category === 'All' || t.category === category));
  const activeTheme = THEME_REGISTRY[activeThemeId] ?? THEME_REGISTRY[DEFAULT_THEME_ID];
  const controlStyle = { font: 'inherit', color: 'var(--color-fg)', background: 'var(--color-bg-input)', border: '1px solid var(--color-border-hairline)', padding: '4px 6px', maxWidth: '100%' };
  return (
    <div style={{ marginBottom: '14px' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="display-font"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: '100%',
          background: 'transparent',
          border: 'none',
          padding: 0,
          marginBottom: '8px',
          color: 'var(--color-accent-primary-dim)',
          cursor: 'pointer',
          fontSize: '11px',
          letterSpacing: '2px',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: '9px', width: '10px' }}>{open ? '▼' : '▶'}</span>
        <span>THEME · {family === 'phosphor' ? 'ARCO PHOSPHOR' : 'ARCO CLASSIC'}</span>
        <span style={{ color: 'var(--color-fg-muted)', letterSpacing: '1px' }}>— {activeTheme?.name ?? activeThemeId}</span>
      </button>
      {open && (
        <div>
          <label style={{ display: 'block', fontSize: '11px', marginBottom: '8px' }}>FAMILY <select aria-label="Theme family" value={family} style={controlStyle}
            onChange={e => { const next = e.target.value as 'classic' | 'phosphor'; setSearch(''); setCategory('All'); onSelect(remembered.current[next]); }}>
            <option value="classic">Arco Classic · 43 themes</option><option value="phosphor">Arco Phosphor · 68 palettes</option>
          </select></label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
            <input aria-label="Search themes" type="search" placeholder="Search name or ID…" value={search} onChange={e => setSearch(e.target.value)} style={{ ...controlStyle, minWidth: 0, flex: 1 }} />
            {family === 'phosphor' && <select aria-label="Palette category" value={category} onChange={e => setCategory(e.target.value)} style={controlStyle}><option>All</option>{themeCategories.map(c => <option key={c}>{c}</option>)}</select>}
            <span style={{ fontSize: '10px' }}>{filtered.length} / {themes.length}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {filtered.map((theme) => (
            <ThemePill
              key={theme.id}
              theme={theme}
              active={activeThemeId === theme.id}
              onSelect={() => onSelect(theme.id)}
            />
          ))}
          </div>
          {!filtered.length && <p>No matching palettes.</p>}
        </div>
      )}
    </div>
  );
}

function ThemePill({ theme, active, onSelect }: { theme: Theme; active: boolean; onSelect: () => void }) {
  const [hover, setHover] = useState(false);
  const bg = theme.tokens['color-bg-panel'] ?? theme.tokens['color-bg'] ?? '#000';
  const fg = theme.tokens['color-fg'] ?? theme.tokens['color-accent-primary'] ?? '#fff';
  const border = active
    ? (theme.tokens['color-accent-primary'] ?? '#fff')
    : (theme.tokens['color-border-hairline'] ?? 'rgba(255,255,255,0.18)');
  const swatches = [
    theme.tokens['color-bg'],
    theme.tokens['color-fg'],
    theme.tokens['color-accent-primary'],
    theme.tokens['color-accent-secondary'],
  ].filter(Boolean) as string[];
  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        data-theme-choice={theme.id}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 8px',
          background: bg,
          color: fg,
          border: `${active ? '2px' : '1px'} solid ${border}`,
          borderRadius: '3px',
          cursor: 'pointer',
          fontFamily: theme.fonts.display,
          fontSize: '11px',
          letterSpacing: '1px',
        }}
      >
        <span>{theme.name}</span>
        <span style={{ display: 'inline-flex', gap: '2px' }}>
          {swatches.map((c, i) => (
            <span
              key={i}
              style={{
                display: 'inline-block',
                width: '8px',
                height: '8px',
                background: c,
                border: `1px solid ${theme.tokens['color-border-hairline'] ?? 'rgba(0,0,0,0.2)'}`,
              }}
            />
          ))}
        </span>
        {active && <span style={{ fontSize: '10px' }}>✓</span>}
      </button>
      {hover && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            zIndex: 30,
            minWidth: '240px',
            pointerEvents: 'none',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
          }}
        >
          <ThemeCard theme={theme} active={active} onSelect={() => { /* hover preview only */ }} />
        </div>
      )}
    </div>
  );
}

// Themes Phase 2 — preview card. Renders in its own theme palette and display
// font so the operator compares at a glance without switching. The ✓ shows
// the currently-active selection; click calls setThemeId, which applies live.
function ThemeCard({ theme, active, onSelect }: { theme: Theme; active: boolean; onSelect: () => void }) {
  const bg = theme.tokens['color-bg-panel'] ?? theme.tokens['color-bg'] ?? '#000';
  const fg = theme.tokens['color-fg'] ?? theme.tokens['color-accent-primary'] ?? '#fff';
  const border = active
    ? (theme.tokens['color-accent-primary'] ?? '#fff')
    : (theme.tokens['color-border-hairline'] ?? 'rgba(255,255,255,0.12)');
  const swatches = [
    theme.tokens['color-bg'],
    theme.tokens['color-fg'],
    theme.tokens['color-accent-primary'],
    theme.tokens['color-accent-secondary'],
  ].filter(Boolean) as string[];
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '12px 14px',
        background: bg,
        color: fg,
        border: `${active ? '2px' : '1px'} solid ${border}`,
        borderRadius: '4px',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: theme.fonts.body,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' }}>
        <span style={{ fontSize: '13px', letterSpacing: '1px', fontFamily: theme.fonts.display, color: fg }}>
          {theme.name}
        </span>
        {active && (
          <span style={{ fontSize: '12px', color: theme.tokens['color-accent-primary'] ?? fg }}>✓</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: '3px' }}>
        {swatches.map((c, i) => (
          <span
            key={i}
            style={{
              display: 'inline-block',
              width: '18px',
              height: '10px',
              background: c,
              border: `1px solid ${theme.tokens['color-border-hairline'] ?? 'rgba(0,0,0,0.2)'}`,
            }}
          />
        ))}
      </div>
      <span style={{ fontSize: '10px', fontFamily: theme.fonts.display, letterSpacing: '1px', opacity: 0.85 }}>
        {theme.description}
      </span>
    </button>
  );
}

// Phase 7a — Claude Native OAuth status row. Lives alongside the CLI auth
// rows above. POST /api/auth/claude-native/login kicks off PKCE; on a
// machine where the local callback (port 53692) can bind, the operator's
// browser hits it directly. When EADDRINUSE / sandbox-block lands, we
// surface a manual-paste field so the operator can hand back the
// redirected URL.
function ClaudeNativeAuthRow() {
  const [status, setStatus] = useState<{ loggedIn: boolean; expiresAt?: number } | null>(null);
  const [busy, setBusy] = useState<'login' | 'logout' | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [manualValue, setManualValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const res = await fetch('/api/auth/claude-native');
      if (!res.ok) return;
      const data = (await res.json()) as { loggedIn: boolean; expiresAt?: number };
      setStatus(data);
    } catch { /* leave stale */ }
  };

  useEffect(() => { void refresh(); }, []);

  // While a login is pending, re-check so the row flips (and the paste box
  // hides) when the local callback completes it on its own.
  useEffect(() => {
    if (!authUrl || status?.loggedIn) return;
    const id = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(id);
  }, [authUrl, status?.loggedIn]);

  const startLogin = async () => {
    if (busy) return;
    setBusy('login');
    setError(null);
    try {
      const res = await fetch('/api/auth/claude-native/login', { method: 'POST' });
      const data = (await res.json()) as { authorizationUrl: string; state: string; manualFallback: boolean; manualReason?: string; error?: string };
      if (!res.ok) { setError(data.error || `HTTP ${res.status}`); return; }
      setAuthUrl(data.authorizationUrl);
      // Always offer the paste box: the redirect targets localhost:53692, which
      // only reaches this server when the browser runs on the same machine.
      // From a laptop/phone it ends on a "can't connect" page whose URL still
      // carries the code.
      setManualMode(true);
      if (data.manualReason) setError(data.manualReason);
      try { window.open(data.authorizationUrl, '_blank', 'noopener'); } catch { /* user can copy */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const submitManual = async () => {
    if (!manualValue || busy) return;
    setBusy('login');
    setError(null);
    try {
      const res = await fetch('/api/auth/claude-native/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: manualValue.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) { setError(data.error || `HTTP ${res.status}`); return; }
      setManualMode(false);
      setManualValue('');
      setAuthUrl(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const logout = async () => {
    if (busy) return;
    setBusy('logout');
    setError(null);
    try {
      const res = await fetch('/api/auth/claude-native/logout', { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const subline = !status
    ? 'checking…'
    : status.loggedIn
      ? `tokens valid until ${new Date(status.expiresAt ?? 0).toLocaleString()}`
      : 'not authenticated';

  return (
    <div style={{ padding: '8px 10px', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span className="display-font" style={{ fontSize: '11px', letterSpacing: '1.5px', color: 'var(--color-accent-primary)' }}>
            CLAUDE NATIVE (OAUTH)
          </span>
          <span style={{ fontSize: '10px', color: status?.loggedIn ? 'var(--color-accent-primary-dim)' : 'var(--color-warning-dim)', fontFamily: 'var(--font-body)' }}>
            {subline}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {status?.loggedIn ? (
            <button onClick={logout} disabled={!!busy} className="display-font" style={{ padding: '4px 10px', fontSize: '10px', letterSpacing: '1px', background: 'transparent', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg-muted)', borderRadius: '3px', cursor: busy ? 'default' : 'pointer' }}>
              {busy === 'logout' ? '…' : 'LOGOUT'}
            </button>
          ) : (
            <button onClick={startLogin} disabled={!!busy} className="display-font" style={{ padding: '4px 10px', fontSize: '10px', letterSpacing: '1px', background: 'transparent', border: '1px solid var(--color-accent-primary)', color: 'var(--color-accent-primary)', borderRadius: '3px', cursor: busy ? 'default' : 'pointer' }}>
              {busy === 'login' ? '…' : 'LOGIN'}
            </button>
          )}
        </div>
      </div>
      {authUrl && !status?.loggedIn && (
        <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', wordBreak: 'break-all' }}>
          If a browser didn't open: <a href={authUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent-primary)' }}>{authUrl}</a>
        </div>
      )}
      {manualMode && !status?.loggedIn && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)' }}>
            On another device the approval ends on a "can't connect" localhost page — paste that page's URL (starts with http://localhost:53692/callback?…):
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              type="text"
              value={manualValue}
              onChange={(e) => setManualValue(e.target.value)}
              placeholder="http://localhost:53692/callback?code=…&state=…"
              style={{ flex: 1, padding: '4px 6px', fontSize: '11px', fontFamily: 'var(--font-code)', background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)', color: 'var(--color-accent-primary)', borderRadius: '3px', outline: 'none' }}
            />
            <button onClick={submitManual} disabled={!manualValue || !!busy} className="display-font" style={{ padding: '4px 10px', fontSize: '10px', letterSpacing: '1px', background: 'transparent', border: '1px solid var(--color-accent-primary)', color: 'var(--color-accent-primary)', borderRadius: '3px', cursor: busy ? 'default' : 'pointer' }}>
              SUBMIT
            </button>
          </div>
        </div>
      )}
      {error && (
        <div style={{ fontSize: '10px', color: 'var(--color-warning-dim)', fontFamily: 'var(--font-body)' }}>
          {error}
        </div>
      )}
    </div>
  );
}
