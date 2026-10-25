// Workbench Expansion §D2 — Endpoint auto-discovery protocol types.
//
// Auto-discovery probes a BOUNDED candidate set (a small fixed port list ×
// tailscale peers + localhost, private IP ranges ONLY) for OpenAI-compatible
// or Ollama model-list endpoints, so the operator's workstation Ollama over
// Tailscale shows up as a suggestion instead of a hand-typed base URL.
//
// Fences (see docs/PROVIDERS.md § Endpoint auto-discovery): operator-triggered
// (no background daemon), suggestions-only (never auto-switches the endpoint),
// bounded probing (NOT a port scanner), private-ranges-only, 60s cache + per-
// host dead-host cooldown.

// One discovered, reachable endpoint. `baseUrl` is what the operator clicks to
// fill `settings.ollama.baseUrl`. `api` records which list-endpoint answered.
export interface DiscoveredEndpoint {
  baseUrl: string;
  host: string;
  port: number;
  // 'ollama'  → /api/tags answered ({ models: [{ name }] }).
  // 'openai'  → /v1/models answered ({ data: [{ id }] }).
  api: 'ollama' | 'openai';
  // Number of models the endpoint advertised (0 if the list was empty/unparsed).
  modelCount: number;
  // A few sample model names/ids for the UI (capped; not the full list).
  sampleModels: string[];
  // Where this candidate's host came from — for the UI to label the row.
  source: 'localhost' | 'tailscale';
  // Present only for tailscale-sourced hosts: the peer's hostname, if the
  // status JSON carried one.
  peerName?: string;
}

// GET /api/endpoints/discover response. `tailscaleAvailable:false` means the
// `tailscale` CLI was absent/errored — localhost was still probed.
export interface EndpointDiscoverResponse {
  endpoints: DiscoveredEndpoint[];
  tailscaleAvailable: boolean;
  // Whether this response came from the 60s cache vs a fresh probe.
  cached: boolean;
}
