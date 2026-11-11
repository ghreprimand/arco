import { spawnSync } from 'node:child_process';
import { commandArgs } from '../windowsCommand.js';

// Keep disk readers and extension-owned readers out of ordinary Chat.
// Live web tools use the exec host; WEB off keeps that host disabled.
const disabledFeatures = ['shell_tool', 'view_image', 'apps', 'plugins', 'remote_plugin',
  'multi_agent', 'goals', 'image_generation', 'memories', 'hooks', 'computer_use', 'code_mode', 'code_mode_host'] as const;
const requiredFeatures = ['shell_tool', 'view_image', 'goals'];
// Keep nested builtin mutation tools out of the host while retaining its web namespace.
const nonFeatureOverrides = ['skills.include_instructions=false', 'skills.bundled.enabled=false',
  'cloud.skills.enabled=false', 'project_doc_max_bytes=0', 'agents.enabled=false',
  'features.code_mode.excluded_tool_namespaces=["functions"]'];
const listed = (features: string, name: string) => new RegExp(`^${name}\\s`, 'm').test(features);
export function codexChatOverrides(features: string, web = false): readonly string[] {
  return [...disabledFeatures.filter(name => requiredFeatures.includes(name) || listed(features, name))
    .map(name => `features.${name}=${web && name === 'code_mode_host'}`), ...nonFeatureOverrides];
}
const unavailable = 'Codex Chat is unavailable: the installed Codex cannot enforce Chat tool restrictions. Update Codex and try again.';

export interface ChatCapabilityProbe { version?: string; listedFeatures?: string; features?: string; execHelp?: string; resumeHelp?: string; startupConfig?: string; }
export function supportsCodexChat(probe: ChatCapabilityProbe, web = false): boolean {
  const version = probe.version?.match(/\bcodex-cli (\d+)\.(\d+)\.(\d+)\s*$/);
  const supportedVersion = !!version && (Number(version[1]) > 0 || Number(version[2]) >= 167);
  let validated = false;
  try { const startup = JSON.parse(probe.startupConfig ?? ''); validated = typeof startup.appServerVersion === 'string' && !startup.error; } catch { /* Unsupported or failed strict configuration probe. */ }
  return supportedVersion && validated && (!web || listed(probe.listedFeatures ?? '', 'code_mode_host')) && requiredFeatures.every(name => listed(probe.listedFeatures ?? '', name))
    && disabledFeatures.filter(name => requiredFeatures.includes(name) || listed(probe.listedFeatures ?? '', name)).every(name => new RegExp(`^${name}\\s+(?:${requiredFeatures.includes(name) || (web && name === 'code_mode_host') ? 'stable|experimental|under development' : 'stable|experimental|under development|removed'})\\s+${web && name === 'code_mode_host'}\\s*$`, 'm').test(probe.features ?? ''))
    && [probe.execHelp, probe.resumeHelp].every(help => help?.includes('--ignore-user-config') && help.includes('--ignore-rules') && help.includes('--strict-config'));
}
const cache = new Map<string, { expires: number; supported: boolean; overrides: readonly string[] }>();
export function requireCodexChatCapabilities(codexHome?: string, web = false): readonly string[] {
  const key = `${process.env.PATH}\0${codexHome ?? process.env.CODEX_HOME ?? ''}\0${web}`;
  const now = Date.now();
  for (const [entryKey, entry] of cache) if (entry.expires <= now) cache.delete(entryKey);
  let cached = cache.get(key);
  if (!cached) {
    const env = { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) };
    const read = (args: string[]): string | undefined => {
      const result = spawnSync(...commandArgs('codex', args), {
        env, encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
      return result.status === 0 ? result.stdout : undefined;
    };
    const listedFeatures = read(['features', 'list']);
    const overrides = codexChatOverrides(listedFeatures ?? '', web);
    const flags = overrides.flatMap(value => ['-c', value]);
    const probe = { listedFeatures, version: read(['--version']), features: read([...flags, 'features', 'list']),
      execHelp: read(['exec', '--help']), resumeHelp: read(['exec', 'resume', '--help']),
      startupConfig: read([...flags, 'app-server', '--print-startup-config', '--strict-config']) };
    cached = { expires: Date.now() + 60_000, supported: supportsCodexChat(probe, web), overrides };
    cache.set(key, cached);
  }
  if (!cached.supported) throw new Error(unavailable);
  return cached.overrides;
}
