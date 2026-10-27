// Settings organized by task (P3.4). Every control that SettingsPanel renders
// belongs to exactly one section; a section belongs to one page. The control
// map in docs/SETTINGS.md lists the same sections, and navigation.test.ts keeps
// the three in step (sections, settings help keys, the map).

export const SETTINGS_PAGES = [
  { id: 'appearance', label: 'Appearance', description: 'Theme, fonts, brightness and how chat labels the operator.' },
  { id: 'projects', label: 'Projects', description: 'Where new workflows start and which project folders are trusted.' },
  { id: 'providers', label: 'Providers and models', description: 'Which providers are on, sign-in and accounts, local endpoints and model catalogs.' },
  { id: 'agents', label: 'Agents and clusters', description: 'Defaults for new workflows, skills and handoff prompts. A workflow\'s CONFIG tab can override defaults.' },
  { id: 'voice', label: 'Voice', description: 'Local speech install, microphone test and model notices.' },
  { id: 'files', label: 'Files and media', description: 'Which folders Media Studio may read and write.' },
  { id: 'advanced', label: 'Advanced', description: 'Provider transport defaults and runtime versions.' },
] as const;
export type SettingsPage = typeof SETTINGS_PAGES[number]['id'];

export interface SettingsSectionDef {
  id: string;
  page: SettingsPage;
  label: string;
  // Starts with Global, Project or Workflow: where the value is stored and applies.
  scope: string;
  // Contextual help keys (client/src/help/content/settings.tsx) shown with the section.
  help: string[];
  // Other names a request may use for a control inside this section.
  aliases?: string[];
  keywords?: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'themes', page: 'appearance', label: 'Theme', scope: 'Global', help: ['settings.themes'], keywords: 'classic phosphor palette family color colour' },
  { id: 'phosphor', page: 'appearance', label: 'Phosphor effects and softness', scope: 'Global', help: ['settings.phosphor-effects', 'settings.phosphor-softness'], aliases: ['phosphor-effects', 'phosphor-softness'], keywords: 'glow crt reduced motion' },
  { id: 'font-pack-override', page: 'appearance', label: 'Font pack override', scope: 'Global', help: ['settings.font-pack-override'], keywords: 'typography typeface' },
  { id: 'theme-brightness', page: 'appearance', label: 'Background and text brightness', scope: 'Global', help: ['settings.theme-brightness'] },
  { id: 'crisp-text', page: 'appearance', label: 'Crisp text', scope: 'Global', help: ['settings.crisp-text'] },
  { id: 'frosted-glass', page: 'appearance', label: 'Frosted glass and opacity', scope: 'Global', help: ['settings.frosted-glass'], keywords: 'transparency blur' },
  { id: 'operator-name', page: 'appearance', label: 'Operator name in chat', scope: 'Global', help: ['settings.operator-name'] },
  { id: 'projects', page: 'projects', label: 'Project folders and default working folder', scope: 'Global', help: ['settings.projects', 'settings.default-working-dir', 'settings.first-run'], aliases: ['default-working-dir'], keywords: 'register remove keep scan recent folder directory cwd start new workflow Docker mount welcome onboarding run setup again' },
  { id: 'project-trust', page: 'projects', label: 'Project trust', scope: 'Project, rules kept globally', help: ['settings.project-trust'], keywords: 'untrusted claude.md skills settings.json vouch' },
  { id: 'enabled-providers', page: 'providers', label: 'Enabled providers', scope: 'Global', help: ['settings.enabled-providers'], keywords: 'hide show provider on off' },
  { id: 'authentication', page: 'providers', label: 'Sign-in, accounts and local endpoints', scope: 'Global', help: ['settings.authentication', 'settings.endpoint-discovery', 'settings.codex-profiles', 'settings.zai-api-key', 'settings.deepseek', 'settings.strata-endpoint'],
    aliases: ['endpoint-discovery', 'codex-profiles', 'zai-api-key', 'deepseek', 'strata-endpoint', 'ollama', 'lmstudio', 'native-auth'],
    keywords: 'Claude Gemini Codex Z.ai Cursor GitHub Ollama llama.cpp LM Studio Strata DeepSeek Xolotl Antigravity login logout API key URL host profile utility compaction session titles' },
  { id: 'llamacpp-catalog', page: 'providers', label: 'llama.cpp model registry', scope: 'Global', help: ['settings.llamacpp-catalog'], keywords: 'gguf preload load' },
  { id: 'catalog', page: 'providers', label: 'Model catalog', scope: 'Global', help: ['settings.catalog'], keywords: 'models context window' },
  { id: 'auto-handoff-defaults', page: 'agents', label: 'Auto-handoff defaults', scope: 'Global, for new workflows', help: ['settings.auto-handoff-defaults'], keywords: 'warn threshold context summarizer' },
  { id: 'claude-native-compact-default', page: 'agents', label: 'Anthropic compaction default', scope: 'Global, for new workflows', help: ['settings.claude-native-compact-default'], keywords: 'native compact' },
  { id: 'skills', page: 'agents', label: 'Skills', scope: 'Global or project (the active tab\'s folder)', help: ['settings.skills'] },
  { id: 'handoff-prompts', page: 'agents', label: 'Handoff prompts', scope: 'Global or project (the active tab\'s folder)', help: ['settings.handoff-prompts'] },
  { id: 'voice-setup', page: 'voice', label: 'Voice setup', scope: 'Global', help: ['settings.voice-setup'], keywords: 'microphone speech recognizer install uv python models notices' },
  { id: 'media-access', page: 'files', label: 'Media folder access', scope: 'Global', help: ['settings.media-unconfined'], aliases: ['media-unconfined'], keywords: 'media studio folders outside confined revoke' },
  { id: 'transport-defaults', page: 'advanced', label: 'Transport defaults', scope: 'Global, for new workflows', help: ['settings.transport-defaults'], keywords: 'codex exec app-server claude cli native' },
  { id: 'cli-versions', page: 'advanced', label: 'CLI and runtime versions', scope: 'Global', help: ['settings.cli-versions', 'settings.app-updates'], keywords: 'version diagnostics' },
];

// A request may name a section id, a help key (with or without `settings.`)
// or an alias for a control inside a section.
export function settingsSection(value: string): SettingsSectionDef | undefined {
  const id = value.replace(/^settings\./, '');
  return SETTINGS_SECTIONS.find((s) => s.id === id)
    ?? SETTINGS_SECTIONS.find((s) => s.help.includes(`settings.${id}`) || s.aliases?.includes(id));
}

// #settings/<page> or #settings/<page>/<section>. Anything else is ignored.
export function settingsHash(value: string): { page: SettingsPage; section?: SettingsSectionDef } | undefined {
  const match = /^#settings\/([a-z]+)(?:\/([a-z-]+))?$/.exec(value);
  if (!match) return undefined;
  const page = SETTINGS_PAGES.find((p) => p.id === match[1]);
  if (!page) return undefined;
  if (!match[2]) return { page: page.id };
  const section = SETTINGS_SECTIONS.find((s) => s.id === match[2]);
  return section && section.page === page.id ? { page: page.id, section } : undefined;
}

// Every word must appear in the label, id, page, scope, keywords or help text.
export function settingsMatches(section: SettingsSectionDef, query: string, helpText: (key: string) => string = () => ''): boolean {
  const page = SETTINGS_PAGES.find((p) => p.id === section.page)?.label ?? '';
  const text = [section.label, section.id, page, section.scope, section.keywords ?? '', ...(section.aliases ?? []), ...section.help.map(helpText)].join(' ').toLowerCase();
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => text.includes(w));
}
