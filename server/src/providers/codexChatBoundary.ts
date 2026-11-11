import { spawnSync } from 'node:child_process';
import { commandArgs } from '../windowsCommand.js';

// Keep arbitrary disk readers and extension-owned readers out of ordinary Chat.
const disabledFeatures = ['shell_tool', 'view_image', 'apps', 'plugins', 'remote_plugin',
  'multi_agent', 'image_generation', 'memories', 'hooks', 'computer_use', 'code_mode', 'code_mode_host'] as const;
const requiredFeatures = ['shell_tool', 'view_image'];
const nonFeatureOverrides = ['skills.include_instructions=false', 'skills.bundled.enabled=false',
  'cloud.skills.enabled=false', 'project_doc_max_bytes=0'];
const listed = (features: string, name: string) => new RegExp(`^${name}\\s`, 'm').test(features);
export function codexChatOverrides(features: string): readonly string[] {
  return [...disabledFeatures.filter(name => requiredFeatures.includes(name) || listed(features, name))
    .map(name => `features.${name}=false`), ...nonFeatureOverrides];
}
const unavailable = 'Codex Chat is unavailable: the installed Codex cannot enforce attachment-only access. Update Codex and try again.';

export interface ChatCapabilityProbe { version?: string; listedFeatures?: string; features?: string; execHelp?: string; resumeHelp?: string; }
export function supportsCodexChat(probe: ChatCapabilityProbe): boolean {
  const version = probe.version?.match(/\bcodex-cli (\d+)\.(\d+)\.(\d+)\s*$/);
  const supportedVersion = !!version && (Number(version[1]) > 0 || Number(version[2]) >= 167);
  return supportedVersion && requiredFeatures.every(name => listed(probe.listedFeatures ?? '', name))
    && disabledFeatures.filter(name => requiredFeatures.includes(name) || listed(probe.listedFeatures ?? '', name)).every(name => new RegExp(`^${name}\\s+(?:${requiredFeatures.includes(name) ? 'stable|experimental|under development' : 'stable|experimental|under development|removed'})\\s+false\\s*$`, 'm').test(probe.features ?? ''))
    && [probe.execHelp, probe.resumeHelp].every(help => help?.includes('--ignore-user-config') && help.includes('--ignore-rules') && help.includes('--strict-config'));
}
let cached: { key: string; expires: number; supported: boolean; overrides: readonly string[] } | undefined;
export function requireCodexChatCapabilities(codexHome?: string): readonly string[] {
  const key = `${process.env.PATH}\0${codexHome ?? process.env.CODEX_HOME ?? ''}`;
  if (!cached || cached.key !== key || cached.expires <= Date.now()) {
    const env = { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) };
    const read = (args: string[]): string | undefined => {
      const result = spawnSync(...commandArgs('codex', args), {
        env, encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
      return result.status === 0 ? result.stdout : undefined;
    };
    const listedFeatures = read(['features', 'list']);
    const overrides = codexChatOverrides(listedFeatures ?? '');
    const flags = overrides.flatMap(value => ['-c', value]);
    const probe = { listedFeatures, version: read(['--version']), features: read([...flags, 'features', 'list']),
      execHelp: read(['exec', '--help']), resumeHelp: read(['exec', 'resume', '--help']) };
    cached = { key, expires: Date.now() + 60_000, supported: supportsCodexChat(probe), overrides };
  }
  if (!cached.supported) throw new Error(unavailable);
  return cached.overrides;
}
