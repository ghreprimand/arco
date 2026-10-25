// Antigravity provider capability surface — extracted so `antigravityManager`
// can read it without importing the RPC module (which itself imports the
// manager for `ensureRunning()`). Splitting these constants out breaks the
// import cycle.
//
// Values reflect what Archon's RPC integration actually drives today, not
// what Antigravity-the-desktop-app supports. Keep this list narrow: any field
// that flips to `true` / `supported` must have a smoke test or docs entry
// backing it.
//
//   modelAccess            — `GetAvailableModels` + cascade dispatch works.
//   webSearch              — observed in trajectories; rich citation surface
//                            still TODO.
//   shellTools             — observed start/exit rows merged into Activity.
//   pathAttachments        — operator file paths appended to the prompt body.
//   nativeImageAttachments — `SendUserCascadeMessage.items[]` image schema is
//                            unprobed; default unknown to discourage misuse.
//   clusterTools           — `peer_*` / `cluster_plan_*` not bridged yet.
//   artifacts              — conservative artifact ingestion copies newly
//                            created .md/.txt/.json and common image files
//                            from the workflow cwd, plus exact cascade brain
//                            dirs when present. Generated-image RPC shapes
//                            remain unproven, so this stays `partial`.
//   contextAccounting      — Antigravity owns context; Archon does not invent
//                            CTX percentages for this provider.

export type AntigravityCapabilityState =
  | 'supported'
  | 'unsupported'
  | 'observed'
  | 'partial'
  | 'opaque'
  | 'unknown';

export interface AntigravityCapabilities {
  modelAccess: boolean;
  webSearch: AntigravityCapabilityState;
  shellTools: AntigravityCapabilityState;
  pathAttachments: boolean;
  nativeImageAttachments: AntigravityCapabilityState;
  clusterTools: boolean;
  artifacts: AntigravityCapabilityState;
  contextAccounting: AntigravityCapabilityState;
}

export const ANTIGRAVITY_CAPABILITIES: AntigravityCapabilities = {
  modelAccess: true,
  webSearch: 'observed',
  shellTools: 'observed',
  pathAttachments: true,
  nativeImageAttachments: 'unknown',
  clusterTools: false,
  artifacts: 'partial',
  contextAccounting: 'opaque',
};

// Default Antigravity RPC model id. The RPC dispatcher uses this when
// `ANTIGRAVITY_RPC_MODEL` is unset. Exported so diagnostics and the smoke
// script can show what the provider is configured to dispatch without
// importing the RPC layer.
export const DEFAULT_ANTIGRAVITY_MODEL_ID = 'gemini-3-flash-agent';

export function configuredAntigravityModelId(): string {
  return process.env.ANTIGRAVITY_RPC_MODEL?.trim() || DEFAULT_ANTIGRAVITY_MODEL_ID;
}

export function configuredAntigravityModelDisplayName(modelId = configuredAntigravityModelId()): string | undefined {
  if (modelId === DEFAULT_ANTIGRAVITY_MODEL_ID) return 'Gemini 3.5 Flash (High)';
  return undefined;
}
