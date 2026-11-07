import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const owned of [false, true, 'reused', 'trailing']) test(`B192: launcher stop signals only a matching recorded owner (${owned})`, { skip: process.platform === 'win32' }, () => {
  const temp = mkdtempSync(join(tmpdir(), 'arco-launcher-owner-'));
  mkdirSync(join(temp, 'checkout'));
  const checkout = realpathSync(join(temp, 'checkout'));
  const valid = owned === true || owned === 'trailing';
  const raw = readFileSync(new URL('../arco', import.meta.url), 'utf8');
  const definitions = raw.slice(0, raw.lastIndexOf('\ncase "${1:-start}"'));
  const script = definitions + `
notify() { :; }
sleep() { :; }
trace() { :; }
port_in_use() { return 0; }
pid_on_port() { printf '202'; }
process_cwd() { if [ "$1" = 101 ]; then printf '%s' "$OTHER_CWD"; else printf '%s/other' "$HOME"; fi; }
process_home() { printf '%s' "$HOME/.arco"; }
process_start_id() { printf '%s' "$CURRENT_START"; }
process_group() { printf '%s' "$1"; }
kill() { if [ "$1" != '-0' ]; then printf 'SIGNAL %s\\n' "$*"; fi; return 0; }
pkill() { printf 'GLOBAL %s\\n' "$*"; }
curl() { printf 'API called\\n' >> "$HOME/actions"; return 0; }
printf '%s\\n' 101 expected "$ARCO_DIR" "$HOME/.arco" > "$PID_FILE"
stop
`;
  try {
    const file = join(temp, 'launcher.sh'); writeFileSync(file, script);
    const result = spawnSync('bash', [file], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: temp, XDG_CACHE_HOME: join(temp, 'cache'), ARCO_DIR: checkout + (owned === 'trailing' ? '/' : ''), OTHER_CWD: owned !== false ? checkout : join(temp, 'other'), CURRENT_START: valid ? 'expected' : 'reused' } });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /GLOBAL/);
    if (!valid) { assert.doesNotMatch(result.stdout, /SIGNAL/); assert.equal(existsSync(join(temp, 'actions')), false); }
    else assert.match(result.stdout, /SIGNAL .*101/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
