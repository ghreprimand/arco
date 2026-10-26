# Settings

Settings (the gear in the header) groups every control by task. A search box
looks through all categories at once, including each control's help text.
Each section shows its scope and an "About this setting" disclosure with the
same contextual help as the `?` mode.

## Scopes

- **Global**: stored for this Arco server in the Arco home (`settings.json`
  and the related stores) and applied everywhere.
- **Global, for new workflows**: a default copied into a workflow when it is
  created. A workflow's CONFIG tab overrides it, and changing the default does
  not change existing workflows.
- **Project**: applies to one project folder.
- **Workflow**: per-workflow choices (provider, model, effort, permissions,
  transport, auto-handoff, north star and the rest) stay in the workflow
  creator and the workflow's CONFIG tab. They are not part of this dialog.

## Addresses

`#settings/<category>` opens a category and `#settings/<category>/<section>`
opens a section, for example `#settings/voice/voice-setup`. Unknown addresses
are ignored. The Connections view and the provider outage banner open the
matching section the same way.

## Control-location map

Every control the Settings dialog had before it was organized by task, and
where it now lives. The table has one row per section; `navigation.test.ts`
(`client/src/components/settings/`) checks that the rows match the sections
the dialog renders and that every Settings help entry is covered.

Sections: 21.

| Section id | Category | Section | Scope | Controls |
| --- | --- | --- | --- | --- |
| `themes` | Appearance | Theme | Global | Theme family and palette picker, search and categories |
| `phosphor` | Appearance | Phosphor effects and softness | Global | Phosphor glow, effects and softness (shown with a Phosphor theme) |
| `font-pack-override` | Appearance | Font pack override | Global | Font pack selector |
| `theme-brightness` | Appearance | Background and text brightness | Global | Background brightness, text brightness |
| `crisp-text` | Appearance | Crisp text | Global | Crisp text toggle |
| `frosted-glass` | Appearance | Frosted glass and opacity | Global | Frosted glass override, opacity |
| `operator-name` | Appearance | Operator name in chat | Global | Operator label shown in chat |
| `projects` | Projects | Project folders and default working folder | Global | Registered project folders (add, keep, remove), scanned and recent folders, default working directory for new workflows |
| `project-trust` | Projects | Project trust | Project, rules kept globally | Trusted and never-trusted project list, default trust |
| `enabled-providers` | Providers and models | Enabled providers | Global | Per-provider on/off toggles |
| `authentication` | Providers and models | Sign-in, accounts and local endpoints | Global | Provider sign-in rows (Claude, Gemini, Codex, Z.ai, Cursor, Ollama, llama.cpp, LM Studio, Strata, GitHub, Antigravity), Claude Native authentication, Codex accounts and profiles, Z.ai API key, Ollama endpoint, discovery and utility model (compaction summaries, session titles), LM Studio endpoint, Strata endpoint, DeepSeek through Xolotl |
| `llamacpp-catalog` | Providers and models | llama.cpp model registry | Global | llama.cpp registry editor and preload (shown when llama.cpp is enabled and installed) |
| `catalog` | Providers and models | Model catalog | Global | Model catalog editor |
| `auto-handoff-defaults` | Agents and clusters | Auto-handoff defaults | Global, for new workflows | Auto-handoff warn and handoff thresholds, summarizer |
| `claude-native-compact-default` | Agents and clusters | Anthropic compaction default | Global, for new workflows | Server-side compaction default for new Claude Native workflows |
| `skills` | Agents and clusters | Skills | Global or project (the active tab's folder) | Global and project skill lists, new, edit and delete |
| `handoff-prompts` | Agents and clusters | Handoff prompts | Global or project (the active tab's folder) | Handoff prompt overrides per mode |
| `voice-setup` | Voice | Voice setup | Global | Local speech status, install log, microphone test, test phrase, model notices |
| `media-access` | Files and media | Media folder access | Global | Outside-folder access switch, allowed folders, revoke all |
| `transport-defaults` | Advanced | Transport defaults | Global, for new workflows | Codex and Claude transport defaults for new workflows |
| `cli-versions` | Advanced | CLI and runtime versions | Global | Claude, Gemini, Codex CLI and Ollama daemon versions |

Requests that name a control inside a section open that section and focus the
control: `endpoint-discovery`, `ollama`, `lmstudio`, `strata-endpoint`,
`deepseek`, `codex-profiles`, `zai-api-key` and `native-auth` open
`authentication`; `media-unconfined` opens `media-access`;
`default-working-dir` opens `projects`.
