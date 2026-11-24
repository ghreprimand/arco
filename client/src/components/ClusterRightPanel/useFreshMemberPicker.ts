import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_CODEX_MODEL, isClusterMemberProvider, type ClusterMemberProvider, type EffortLevel, type ModelName, type ProviderName } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { useCodexCatalogFor } from '../../hooks/useCodexCatalog';
import { effortsForModel } from '../../utils/format';
import { capDefaultEffort } from '../../utils/effortDefaults';
import { modelsForProvider, useModelCatalogs } from '../../utils/modelCatalog';
import { availableMemberProviders } from '../WorkflowCreator/memberProviders';

// Picker state for FRESH-spawn provider/model/effort overrides.
// Anchor = cluster template (members[0]). Defaults clone the template's
// primary config; changing provider resets model to the first-available
// catalog entry for that provider and clamps effort. The CONFIG-tab picker
// wires the same fields (RightPanel.tsx ~1297), so this mirrors that shape.
export function useFreshMemberPicker(template: { provider?: string; model?: string; effort?: string; accountRef?: string }) {
  const settings = useAppStore(s => s.settings);
  const authStatus = useAppStore(s => s.authStatus);
  const isProviderEnabled = useAppStore(s => s.isProviderEnabled);
  const templateProvider: ClusterMemberProvider = isClusterMemberProvider(template.provider) ? template.provider : 'claude';
  const templateModel = template.model ?? '';
  // A new worker never inherits an effort above HIGH; XHIGH/MAX stay an explicit pick.
  const templateEffort = capDefaultEffort((template.effort ?? 'medium') as EffortLevel);
  const templateAccountRef = template.accountRef;
  const codexAccounts = settings?.providerAccounts?.codex ?? [];
  const [provider, setProvider] = useState<ClusterMemberProvider>(templateProvider);
  const [model, setModel] = useState(String(templateModel));
  const [effort, setEffort] = useState(String(templateEffort));
  const [providerAccountRef, setProviderAccountRef] = useState<string | undefined>(templateProvider === 'codex' ? templateAccountRef : undefined);
  // Account-scoped so a fresh Codex member's model list matches the chosen
  // account profile's entitlements (HOME vs WORK).
  const codexCatalog = useCodexCatalogFor(providerAccountRef);
  const catalogs = useModelCatalogs({ codex: codexCatalog });
  const { claude: claudeNativeCatalog, cursor: cursorCatalog } = catalogs;
  // Per-provider model list — live catalog when available, static otherwise.
  // Cursor gets auto + the full frontier catalog, same picker depth as a
  // standalone tab (`auto` is a convenient default, not a forced lane).
  const modelOptions = useMemo(() => modelsForProvider(provider, catalogs).map(String), [provider, catalogs]);
  // Per-model effort set — same source as the CONFIG picker (effortsForModel).
  const effortOptions: string[] = useMemo(() => effortsForModel(provider, model, claudeNativeCatalog, codexCatalog), [provider, model, claudeNativeCatalog, codexCatalog]);
  const available = availableMemberProviders(authStatus, isProviderEnabled);
  const providerOptions = available.includes(provider) ? available : [provider, ...available];
  const providerUnavailable = !available.includes(provider);
  // Re-seed picker state whenever the template's identity changes (e.g.
  // the cluster's first member rotates after a detach).
  useEffect(() => {
    setProvider(templateProvider); setModel(String(templateModel)); setEffort(String(templateEffort));
    setProviderAccountRef(templateProvider === 'codex' ? templateAccountRef : undefined);
  }, [templateProvider, templateModel, templateEffort, templateAccountRef]);
  // Clamp model to the option list — the anchor tab may be on a
  // family alias or a since-dropped id, and a select whose value matches no
  // option renders the first one while state keeps the unmatched value. The
  // fresh tab would then be created on something the operator never saw.
  useEffect(() => {
    if (modelOptions.length && !modelOptions.includes(model)) setModel(modelOptions[0]);
  }, [modelOptions, model]);
  // Clamp effort whenever the effort set changes so an inherited value
  // that's no longer valid (e.g. provider flipped) snaps to the highest
  // available entry.
  useEffect(() => {
    if (effortOptions.length && !effortOptions.includes(effort)) setEffort(capDefaultEffort(effort as EffortLevel, provider as ProviderName, model as ModelName, claudeNativeCatalog, codexCatalog));
  }, [effortOptions, effort, provider, model, claudeNativeCatalog, codexCatalog]);
  // Changing provider resets model to first-available for that provider's
  // catalog (the inherited template name is wrong for the new provider) and
  // clamps effort. Anchor-default reuse only when provider matches anchor's.
  const onPickProvider = (next: ClusterMemberProvider) => {
    setProvider(next);
    if (next === templateProvider) {
      setModel(String(templateModel)); setEffort(String(templateEffort)); setProviderAccountRef(next === 'codex' ? templateAccountRef : undefined);
    } else {
      const firstModel = next === 'claude' ? (claudeNativeCatalog?.models?.[0]?.id ?? 'opus')
        : next === 'codex' ? (codexCatalog?.models?.find(m => !m.hidden)?.id ?? DEFAULT_CODEX_MODEL)
        : next === 'ollama' ? (authStatus?.ollama?.installedModels?.[0] ?? '')
        : next === 'cursor' ? (cursorCatalog?.models?.find(m => m.isDefault)?.id ?? 'auto')
        : next === 'antigravity-cli' ? (authStatus?.['antigravity-cli']?.installedModels?.[0] ?? '')
        : (authStatus?.llamacpp?.installedModels?.[0] ?? '');
      // Effort gets clamped post-hoc by effortOptions; pick 'medium' as the
      // pragmatic default until the per-model set narrows it.
      setModel(firstModel); setEffort('medium'); setProviderAccountRef(next === 'codex' ? codexAccounts[0]?.id : undefined);
    }
  };
  return { provider, model, effort, providerUnavailable, providerAccountRef, setModel, setEffort, setProviderAccountRef, modelOptions, effortOptions, providerOptions, codexAccounts, cursorCatalog, onPickProvider, templateProvider, templateModel, templateEffort, templateAccountRef };
}
