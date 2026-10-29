# Extending Arco

Six recipes document how to add providers, primitives, skills, themes, shaders, and right-panel tabs. The contributor process is in [CONTRIBUTING.md](../CONTRIBUTING.md); development troubleshooting and hot-reload notes are in [DIAGNOSTICS.md](DIAGNOSTICS.md).

## Adding a new provider

Supported providers include: Claude (with `cli` + `native` transports), Codex (with `exec` + `appserver` transports), Gemini CLI (a native worker is not available), Ollama, llama.cpp, LM Studio (OpenAI-compat `/v1`), Strata (standalone `/v1`, shared HTTP worker), Cursor (`cursor-agent` via the Agent Client Protocol; long-lived `acp` worker by default + a stateless `print` one-shot `cursor-agent -p --mode ask` for read-only primitives; reasoning effort is part of the model id, with a catalog of about 150 models). To add a new one (let's call it `foo`):

> **Several providers use a subdirectory layout** rather than a single file (claude-native/, codex-appserver/, cursor/, and the gemini-native/ stub):
> - `server/src/providers/claude-native/`: in-process Anthropic SDK worker. Read `docs/PROVIDERS.md` under `Claude Native` and `docs/GOTCHAS.md` under `Claude Native transport` before touching it; the forced-first-system-block, replay-on-restart pair-flush, and depth-1 Task cap are load-bearing.
> - `server/src/providers/codex-appserver/`: long-lived per-tab `codex app-server` process. Read `docs/PROVIDERS.md` under `Codex app-server transport` and `docs/GOTCHAS.md` under `Codex app-server transport invariants`.
> - `server/src/providers/cursor/`: long-lived `cursor-agent acp` ACP worker + stateless `print.ts` one-shot. Read `docs/PROVIDERS.md` under `Cursor`; ACP is bidirectional JSON-RPC (the agent sends fs/permission requests mid-turn that must be answered), and cluster membership rides an in-process loopback HTTP MCP (`mcp/clusterMcpLoopback.ts`), not stdio.
>
> New single-transport providers should use a single file like `ollama.ts`; new dual-transport providers should use the subdirectory pattern.

### 1. Type system

In `shared/src/protocol/providers.ts` (the `ProviderName` union lives in the split protocol directory, re-exported via the `shared/src/protocol.ts` barrel):

```ts
export type ProviderName = 'claude' | 'gemini' | 'ollama' | 'codex' | 'llamacpp' | 'lmstudio' | 'cursor' | 'foo';
```

Add to `PRIMARY_PROVIDERS` if foo can be a primary.

### 2. Provider implementation

Create `server/src/providers/foo.ts`. It must implement the `ProviderProcess` interface from `types.ts`:

```ts
export class FooProcess implements ProviderProcess {
  id: string;
  status: 'spawning' | 'running' | 'completed' | 'failed';
  output: string;
  pid?: number;

  constructor(id: string, config: WorkerConfig) { ... }

  async spawn(prompt: string): Promise<void> { ... }
  async kill(): Promise<void> { ... }

  on<E extends keyof ProviderEvents>(event: E, handler: ProviderEvents[E]): void { ... }
}
```

The unified event stream you must emit:
- `init`: `{ model, sessionId? }` on first response
- `text`: `{ text }` deltas
- `thinking`: `{ text }` reasoning blocks (skip if not supported)
- `tool_use`: `{ tool, input, toolUseId? }` (skip if not supported)
- `result`: `{ costUsd, durationMs, tokens? }` on settle
- `error`: `{ error, detail? }` on failure
- `system_notice`: `{ text }` for transient out-of-band issues

Reference implementations: `claude.ts` is the most full-featured subprocess provider; `lmstudio.ts` is the smallest HTTP provider (it reuses the Ollama tool runtime rather than owning one).

### 3. Factory

In `server/src/providers/index.ts`:

```ts
import { FooProcess } from './foo';

export function createProviderProcess(id: string, config: WorkerConfig): ProviderProcess {
  switch (config.provider) {
    case 'claude': return new ClaudeWorkerProcess(id, config);
    // ...
    case 'foo': return new FooProcess(id, config);
  }
}
```

### 4. Capability detection

In `server/src/capabilities.ts`, add a probe:

```ts
async function probeFoo(): Promise<FooCapabilities> {
  // Run `foo --version`, parse, return supported efforts/models
}
```

Wire it into `probeCapabilities()` and add the result to the `Capabilities` shape under `shared/src/protocol/` (re-exported via the barrel).

### 5. Auth

In `server/src/auth.ts`, add a status check and a login trigger:

```ts
case 'foo':
  return { provider: 'foo', loggedIn: <bool>, email: <string|null>, ... };
```

And handle the `POST /api/auth-login?provider=foo` case.

### 6. Client

In the WorkflowCreator's provider dropdown and the CONFIG tab's provider/model selectors, add the new option. Most of this picks up automatically from `Capabilities` once the server reports it.

### 7. Chat, Incognito, clusters

Decide explicitly: nothing opts a provider in by default.

- **Chat**: add it to `CHAT_PROVIDERS` in `server/src/chatMode.ts` only if the transport can honor `WorkerConfig.interactionMode:'chat'` (no project tools, isolated cwd). Web support means adding it to `CHAT_WEB_PROVIDERS` *and* making the transport state armed/disarmed explicitly (mirror the client's `WEB_CAPABLE` set in `ChatModeView.tsx`).
- **Incognito**: add it to `INCOGNITO_CHAT_PROVIDERS` only if nothing the provider runs writes to disk (no session files, no daemon log). When in doubt, leave it out; Cursor and llama.cpp are excluded for exactly this.
- **Clusters**: `isClusterMemberProvider` + a peer-tool wiring path (in-process, stdio MCP, or loopback HTTP MCP). See [`docs/PROTOCOL_CLUSTER.md`](PROTOCOL_CLUSTER.md).

### 8. Docs

Update [`docs/PROVIDERS.md`](PROVIDERS.md) with a section matching the existing per-provider format (Spawn / Argv / Stdin / Event parsing / Session resume / Auth / Capability detection / Quirks).

### 9. Test

- Run `npm run typecheck` (all three workspaces) and `npm run test:chat-mode` if you touched the Chat sets.
- Smoke-test in the browser: open a tab, pick the new provider, send a prompt, observe streaming.
- Try cancel mid-turn.
- Try Review with the new provider as reviewer.
- Try Handoff (only if the provider supports `original-worker` mode).

---

## Adding a new primitive

The three operator primitives (Review / Handoff / Spawn) live under `server/src/primitives/`. Adding a fourth (call it `Bar`) requires:

> **Cluster substrate is not a primitive**, but if your primitive interacts with clusters (peer messaging, plan, mailbox) you must go through the cluster substrate layer rather than directly reading the cluster files:
> - `server/src/clusterStore.ts`: cluster record persistence (create/read/delete)
> - `server/src/clusterMailbox.ts`: file-per-message mailbox (`enqueue`, `peek`, `drain`, `discard`)
> - `server/src/clusterPeerOps.ts`: peer tool implementations (`peerList`, `peerSend`, `peerRead`, `peerPlanTick`, `peerPlanWrite`)
> - `server/src/clusterRehydrate.ts`: rehydrate-on-subscribe (re-emits undelivered `peer_message_sent` to reconnecting subscribers)
> - `server/src/clusterIdleNudger.ts`: idle detection + operator-armed toast (never sends prompts)
>
> Read [`docs/PROTOCOL_CLUSTER.md`](PROTOCOL_CLUSTER.md) and `docs/GOTCHAS.md` under `Cluster mode` before touching these files.

### 1. Protocol

Add the message types to the relevant file under `shared/src/protocol/` (e.g. a new `bar.ts`, exported from `protocol/index.ts`):

```ts
export interface BarRequestMessage {
  type: 'bar_request';
  workflowId: string;
  // ...params
}

export interface BarStartedMessage {
  type: 'bar_started';
  workflowId: string;
  barId: string;
  startedAt: number;
}

export interface BarArtifactReadyMessage {
  type: 'bar_artifact_ready';
  workflowId: string;
  barId: string;
  artifactName?: string;
  error?: string;
  completedAt: number;
}
```

Add them to the `ClientMessage` / `ServerMessage` unions. TS will error on the exhaustive switches until you handle them.

### 2. Server-side primitive

Create `server/src/primitives/runBar.ts` (or extend `exportContext.ts` if it's a Handoff/Spawn variant). Take a `broadcast` callback so events can be stamped to any workflow:

```ts
export async function runBar(
  ctx: { workflowId: string, cwd: string, manager: WorkerManager, broadcast: (msg) => void },
  config: BarConfig,
): Promise<BarResult> {
  // Spawn worker, collect output, write artifact, broadcast events.
}
```

### 3. Dispatcher

Put `handleBarRequest` in a per-domain module under `server/src/ws/` (e.g. `barHandlers.ts`, following `compareHandlers.ts`), and route the message type to it from the WS switch in `server/src/index.ts`:

```ts
case 'bar_request':
  await handleBarRequest(ws, msg);
  break;
```

`handleBarRequest` validates the workflow, broadcasts `bar_started`, calls `runBar`, broadcasts `bar_artifact_ready`. Pattern: copy `handleReviewRequest` and adapt.

### 4. Client

- Add a button to `TerminalInput.tsx` (next to REVIEW / HANDOFF / SPAWN) that opens a `BarDialog`.
- Create `BarDialog.tsx` modeled on `ReviewDialog.tsx`.
- Handle `bar_started` and `bar_artifact_ready` in `client/src/ws/handleServerMessage.ts`. Add `upsertBar` to the store.
- Add a `BarsPanel` under `RightPanel/` if you want a dedicated tab (see "Adding a right-panel tab").

### 5. Docs

Update [`docs/PRIMITIVES.md`](PRIMITIVES.md) with a new section, and [`docs/PROTOCOL.md`](PROTOCOL.md) with the new message shapes.

---

## Authoring an Arco skill

Operators create skills from the SettingsPanel SKILLS section. The on-disk shape is also hand-editable, which is useful when checking project skills into git.

Layout:

```
<cwd>/.arco/skills/<slug>/SKILL.md      # project (versioned with the repo)
~/.arco/skills/<slug>/SKILL.md          # global (user home)
```

`<slug>` is the directory name and the stable identifier: it survives renames of the user-facing `name` field. Slug pattern: `^[a-z0-9][a-z0-9-]{0,63}$`.

`SKILL.md` shape:

```markdown
---
name: <operator-facing name>
description: <one-line summary the agent reads to decide when to apply this skill>
operator-only: <true to withhold from the model manifest; available through the +SKILL composer pick>
---

<body: the playbook the agent follows>
```

Frontmatter is required (YAML, single-line values, optional surrounding quotes). Skills missing a `name:` are silently skipped during the scan. `operator-only` is optional (parsed case-insensitively; any value but `true` leaves it model-visible).

Per primary turn, the server scans both roots, builds an XML `<arco-skills>` manifest of name + description + absolute path, and prepends it to the system prompt. Only the manifest goes into the prompt; the agent reads the full body via its `Read` tool when it picks a skill (Pi's progressive-disclosure model). This bounds prompt cost while leaving the skill body unbounded.

Skills with `operator-only: true` are excluded from the `<arco-skills>` manifest the model sees; the user includes the body on demand via the `+SKILL` composer picker. Two related new surfaces: the SKILLS editor's AUDIT button (`POST /api/skills/audit`, diagnostic only) and the project-trust gate (skills from an untrusted repository are suppressed until a user approves the repository, `server/src/projectTrust.ts`).

Server module: `server/src/skills.ts`. HTTP surface: `/api/skills` (see `docs/HTTP_API.md`). UI: `SettingsPanel.tsx` SKILLS section + `SkillEditorDialog.tsx` (see `docs/CLIENT.md`).

---

## Adding a new theme

`client/src/themes/` separates Classic definitions from generated Phosphor palettes. The steps below add a **Classic** theme; Phosphor imports use the catalog/adapter procedure below.

### 1. Definition

Create `client/src/themes/definitions/myTheme.ts`:

```ts
import type { Theme } from '../types';

export const myTheme: Theme = {
  id: 'my-theme',
  name: 'My Theme',
  tokens: {
    'color-bg': '#0a0a0a',
    'color-fg': '#ffffff',
    'color-fg-muted': '#888888',
    'color-accent-primary': '#00ff00',
    // ...all 30+ role-based vars
  },
  density: { /* spacing-unit, border-width, radius-* */ },
  fonts: {
    display: "'IBM Plex Mono', monospace",
    body: "'Inter', sans-serif",
    code: "'IBM Plex Mono', monospace",
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=...&display=swap',
  },
  animations: { scan: true, pulseHalo: false, flicker: false, cursorBlink: true },
  shaderPreset: 'matrix-rain', // must match a supported Classic shader preset
  borderRenderer: 'css', // 'css' | 'rough'
};
```

Match the existing tokens by reading another theme: `matrix.ts` is the canonical reference.

### 2. Registry

In `client/src/themes/registry.ts`:

```ts
import { myTheme } from './definitions/myTheme';

export const CLASSIC_THEME_REGISTRY: Record<ThemeId, Theme> = {
  ...,
  'my-theme': myTheme,
};
```

Also add `'my-theme'` to `CLASSIC_THEME_IDS` (which feeds `VALID_THEME_IDS`) in `shared/src/protocol/themes.ts` (re-exported via the barrel).

### 3. Test

Open the SettingsPanel -> Theme picker. Switch to your theme. Verify:
- Chat is readable (operator/assistant/system contrast)
- Composer focus ring is visible
- Right-panel tab labels are legible
- The shader (if any) doesn't tank framerate

If you add a new shader, see "Adding a shader" below.

### 4. Docs

Update the theme list in [`docs/CLIENT.md`](CLIENT.md) "Available themes" section.

### Phosphor catalog updates

Do not add dozens of hand-written Classic definitions or reuse Classic IDs.
Update the traceable local `themes/phosphor/arco-palette.ts` snapshot and its
revision/hash notes, adapt roles in `paletteAdapter.ts`, and regenerate the ordered
`shared/src/protocol/phosphorPaletteIds.ts` allowlist. Both client registry and
server validation must accept the same namespaced IDs. Run `npm run test:phosphor`
and review representative palettes, Classic restoration, fonts/brightness/crisp,
reduced motion and effects-off. Keep the family-specific ambient renderer mutually
exclusive with Classic Three.js. See `docs/CLIENT.md` for the supported theme catalog and rendering rules.

### Documentation for operator-visible changes

Treat these as separate checks; a green link checker does not prove accuracy:

1. Update the relevant `client/src/help/content/` entries **and** manual sections.
2. Wire new controls with `data-help` (a wrapper is appropriate for disabled
   controls). Keep help clicks non-consequential and link to a real manual section.
3. Check names, defaults, provider/transport limits, failure recovery and privacy
   against code; do not copy a historical plan's intended behavior into current help.
4. Update README/current subsystem docs and add a dated DEVLOG entry. Preserve
   historical evidence; annotate stale deployment labels instead of guessing dates.
5. Run `npm run docs:check`, its `-- --self-test`, `npm run test:help-docs`, and
   client type/build checks. Open the actual manual, search new topics/table rows,
   and click contextual help. Record surfaces not exercised.

Use `docs/INDEX.md` to locate maintained documentation.

---

## Adding a shader

Shaders live under `client/src/themes/shaders/<name>.frag.glsl` and are imported as raw strings in `client/src/themes/shaders/index.ts`.

### Constraints

- Use `precision highp float;` (Mali GPU NaN cascades on `mediump`)
- Bound any `hash` inputs to a sane range: long-uptime drift can produce NaN that propagates through the whole pixel grid (see commit `8a5af37`)
- Keep instruction count low: these run per-pixel at 60fps
- **No smooth radial gradients (vignettes / atmospheric noise washes / breathing blobs / orbs) on dark themes.** They posterize visibly under 8-bit alpha compositing against near-black. Use structural elements only: particles, streaks, grids, dots, vein lines, scanlines, hard-edged cells. See `docs/GOTCHAS.md` under `Themes / shaders` for the current palette and shader constraints.

### Pattern

```glsl
#version 300 es
precision highp float;

uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uAccentPrimary;
uniform vec3 uAccentSecondary;

out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution.xy;
  // ...your shader logic
  fragColor = vec4(color, 1.0);
}
```

`ThemedBackgroundShader.tsx` provides the standard uniforms (`uTime`, `uResolution`, `uAccentPrimary`, `uAccentSecondary`).

---

## Adding a right-panel tab

`client/src/components/RightPanel/index.tsx`. RightPanel was split into a directory: each tab body lives as its own module under `client/src/components/RightPanel/<Name>Tab.tsx` (e.g. `ConfigTab.tsx`, `ActivityTab.tsx`, `ReviewTab.tsx`).

### 1. Component

Create `client/src/components/RightPanel/MyTabPanel.tsx` alongside the existing tab bodies. It receives the active job as a prop and renders its content.

### 2. Wire into RightPanel

`TABS` is an `{ id, label }` array, not a string union. Add your entry:

```tsx
const TABS: { id: RightTab; label: string }[] = [
  { id: 'files', label: 'FILES' },
  /* ...existing... */
  { id: 'mytab', label: 'MYTAB' },
];
```

Add `'mytab'` to the `RightTab` union in `RightPanel/types.ts`. Tabs are also bucketed into the WORKSPACE / AGENT / MEMORY / RUNTIME `GROUPS` array: add the new id to the relevant group's `tabs` list or it won't render. Then add the render-on-active block:

```tsx
{tab === 'mytab' && <MyTabPanel job={job} />}
```

### 3. Persist tab selection

The right panel persists the active tab to localStorage at `STORAGE_KEY`. Adding a new tab name means existing localStorage values are still valid; nothing else needs changing.

---
