import type { useAppStore } from '../../stores/appStore';
import type { WorkflowConfig, ModelName, EffortLevel, ProviderName, ArcoSettings, MemberTier, ClusterPreset, ClusterMemberProvider, WorkflowTemplate } from '@arco/shared';

export interface ClusterCreatePayload {
  cwd: string;
  name?: string;
  members: Array<{
    provider: ClusterMemberProvider;
    model: string;
    effort?: string;
    providerAccountRef?: string;
    displayName?: string;
    role?: string;
    tier?: MemberTier;
    focus?: string;
    skipPermissions?: boolean;
    fastMode?: boolean;
    efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive';
    outputStyle?: 'normal' | 'lite' | 'terse';
  }>;
}

export interface Props {
  initialProvider?: ProviderName;
  onCreate: (config: WorkflowConfig) => void;
  // 2026-05-11 — operator picked CLUSTER mode in the top-of-form toggle and
  // submitted. Optional so the prop stays back-compat for any call sites
  // that haven't wired it yet (today: only App.tsx renders this component
  // and threads the WS sender through).
  onCreateCluster?: (payload: ClusterCreatePayload) => void;
  // Reopen an intact server-side cluster whose browser tab mirror was lost.
  // This preserves the original cluster/member ids; it is not snapshot restore.
  onReopenCluster?: (clusterId: string) => void;
}

// 2026-05-11 — per-member draft row used by CLUSTER mode. Mirrors the
// per-member shape on ClusterCreateFromScratchMessage but keeps a stable
// react key for list rendering and a local `expanded` flag for the
// collapsed-by-default summary <-> full editor toggle.
export interface MemberDraft {
  key: string;
  provider: ClusterMemberProvider;
  model: ModelName;
  effort: EffortLevel;
  providerAccountRef?: string;
  displayName: string;
  role: string;
  tier: MemberTier | '';
  focus: string;
  skipPermissions: boolean;
  fastMode: boolean;
  efficiencyToolFilter: 'off' | 'conservative' | 'aggressive';
  outputStyle: 'normal' | 'lite' | 'terse';
  expanded: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface ClusterMembersSectionProps {
  members: MemberDraft[];
  onAddMember: () => void;
  onRemoveMember: (key: string) => void;
  onUpdateMember: (key: string, patch: Partial<MemberDraft>) => void;
  claudeModelsForPicker: { value: ModelName; label: string; subline?: string }[];
  codexModelsForPicker: { value: ModelName; label: string; subline?: string }[];
  ollamaModelsForPicker: { value: ModelName; label: string; subline?: string }[];
  llamacppModelsForPicker: { value: ModelName; label: string; subline?: string }[];
  cursorModelsForPicker: { value: ModelName; label: string; subline?: string }[];
  claudeNativeCatalog: ReturnType<typeof useAppStore.getState>['claudeNativeCatalog'];
  codexCatalog: ReturnType<typeof useAppStore.getState>['codexCatalog'];
  codexAccounts: NonNullable<NonNullable<ArcoSettings['providerAccounts']>['codex']>;
  selectStyle: (selected: boolean) => React.CSSProperties;
  labelStyle: React.CSSProperties;
  inputStyle: React.CSSProperties;
  hintStyle: React.CSSProperties;
}

// §D4 — single-workflow template ("recipe") picker. Mirrors ClusterPresetsRow.
export interface TemplatePickerRowProps {
  templates: WorkflowTemplate[];
  isLoading: boolean;
  error: string | null;
  onApply: (template: WorkflowTemplate) => void;
  onDelete: (template: WorkflowTemplate) => void;
  saveDisabled: boolean;
  saveOpen: boolean;
  saveName: string;
  saveError: string;
  saveBusy: boolean;
  onSaveOpen: () => void;
  onSaveCancel: () => void;
  onSaveNameChange: (next: string) => void;
  onSaveSubmit: () => void;
}

export interface ClusterPresetsRowProps {
  presets: ClusterPreset[];
  isLoading: boolean;
  error: string | null;
  onApply: (preset: ClusterPreset) => void;
  onDelete: (preset: ClusterPreset) => void;
  saveDisabled: boolean;
  saveOpen: boolean;
  saveName: string;
  saveError: string;
  saveBusy: boolean;
  onSaveOpen: () => void;
  onSaveCancel: () => void;
  onSaveNameChange: (next: string) => void;
  onSaveSubmit: () => void;
}
