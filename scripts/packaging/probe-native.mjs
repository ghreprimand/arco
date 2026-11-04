// Exercise collected Node-API bindings under the selected Node runtime.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (!process.argv[2]) throw new Error('Pass a native artifact directory.');
const dir = resolve(process.argv[2]);
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
new Database(':memory:', { nativeBinding: join(dir, 'better_sqlite3.node') }).close();
console.log('sqlite-ready');
const utils = require('node-pty/lib/utils.js'), original = utils.loadNativeModule;
utils.loadNativeModule = (name) => {
  const file = join(dir, 'pty', `${name}.node`);
  return existsSync(file) ? { dir: join(dir, 'pty'), module: require(file) } : original(name);
};
const pty = require('node-pty');
console.log('terminal-loaded');
const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
const args = process.platform === 'win32' ? ['/d', '/c', 'exit', '0'] : ['-c', 'exit 0'];
const term = pty.spawn(command, args, { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
console.log('terminal-started'); term.onData(() => {});
const timer = setTimeout(() => { console.log('terminal-timeout'); term.kill(); process.exit(1); }, 30000);
term.onExit(({ exitCode }) => { clearTimeout(timer); console.log('terminal-exited'); process.exit(exitCode); });
