import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// Types that run code or change the system when opened. They stay downloadable
// but are never handed to the system's default app.
export const REFUSED_EXTENSIONS = [
  'exe', 'bat', 'cmd', 'com', 'scr', 'pif', 'msi', 'msp', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'cjs',
  'wsf', 'wsh', 'hta', 'cpl', 'reg', 'dll', 'jar', 'lnk', 'url', 'sh', 'bash', 'zsh', 'fish', 'csh', 'ksh', 'run', 'bin',
  'appimage', 'app', 'command', 'desktop', 'workflow', 'action', 'scpt', 'scptd', 'pkg', 'dmg', 'deb', 'rpm', 'apk', 'py', 'pl', 'rb', 'php',
] as const;
const refused = new Set<string>(REFUSED_EXTENSIONS);

export function refusalFor(name: string): string | null {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!ext) return 'Files without an extension are not opened from Arco. Use Download instead.';
  if (refused.has(ext)) return `.${ext} files can run code, so Arco does not open them. Use Download instead.`;
  return null;
}

export interface OpenerCommand { command: string; args: string[]; }
// One argument carries the path on every OS; no command string is ever built.
export function openerCommand(platform: NodeJS.Platform, file: string): OpenerCommand {
  if (platform === 'darwin') return { command: 'open', args: [file] };
  if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', file] };
  return { command: 'xdg-open', args: [file] };
}

export function desktopOpenAvailable(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, dockerenv = existsSync('/.dockerenv')): boolean {
  if (env.ARCO_OUTPUT_OPEN_STUB) return true;
  if (platform === 'darwin' || platform === 'win32') return true;
  if (dockerenv || env.ARCO_DOCKER === '1') return false;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// ARCO_OUTPUT_OPEN_STUB=<file> records the command instead of launching an app
// (used by tests so nothing real opens).
export async function launchOpener(cmd: OpenerCommand, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.ARCO_OUTPUT_OPEN_STUB) { appendFileSync(env.ARCO_OUTPUT_OPEN_STUB, JSON.stringify(cmd) + '\n'); return; }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd.command, cmd.args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
