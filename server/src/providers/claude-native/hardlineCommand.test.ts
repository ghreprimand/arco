// H17 — hardline command floor tests. Pure detector over real command strings:
// Arco self-restart/self-kill + catastrophic rm -rf, and the legitimate
// commands that must STILL pass. Not adversary-proof by design.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectHardlineCommand, checkHardlineCommand } from './pretoolGuards.js';

const CWD = '/home/operator/Projects/Arco';

test('refuses Arco service self-termination', () => {
  assert(detectHardlineCommand('systemctl --user restart arco.service', CWD));
  assert(detectHardlineCommand('systemctl --user stop arco', CWD));
  assert(detectHardlineCommand('sudo systemctl restart arco.service', CWD));
});

test('refuses Arco process self-kill', () => {
  assert(detectHardlineCommand('pkill -f arco', CWD));
  assert(detectHardlineCommand('killall node-arco || killall arco', CWD));
});

test('refuses catastrophic rm -rf targets', () => {
  assert(detectHardlineCommand('rm -rf /', CWD), 'root');
  assert(detectHardlineCommand('rm -rf ~', CWD), 'home tilde');
  assert(detectHardlineCommand('rm -rf $HOME', CWD), 'HOME var');
  assert(detectHardlineCommand('rm -rf .', CWD), 'repo root via dot');
  assert(detectHardlineCommand('rm -fr ./', CWD), 'flag order + ./');
  assert(detectHardlineCommand('rm -rf /home/operator/Projects/Arco', CWD), 'absolute repo root');
  assert(detectHardlineCommand('rm -rf ..', CWD), 'ancestor of cwd');
  assert(detectHardlineCommand('cd /tmp && rm -rf /', CWD), 'in a compound command');
});

test('allows legitimate commands', () => {
  assert.equal(detectHardlineCommand('rm -rf node_modules', CWD), null, 'subdir delete ok');
  assert.equal(detectHardlineCommand('rm -rf dist build', CWD), null, 'build artifacts ok');
  assert.equal(detectHardlineCommand('rm file.txt', CWD), null, 'non-recursive ok');
  assert.equal(detectHardlineCommand('npm run build', CWD), null);
  assert.equal(detectHardlineCommand('systemctl --user status other.service', CWD), null, 'unrelated service ok');
  assert.equal(detectHardlineCommand('grep -r arco src/', CWD), null, 'arco as a search term ok');
  assert.equal(detectHardlineCommand('', CWD), null, 'empty ok');
});

test('checkHardlineCommand only gates Bash + returns a synthetic result', () => {
  assert.equal(checkHardlineCommand('Read', { command: 'rm -rf /' }, CWD).blocked, false, 'non-Bash passes');
  const d = checkHardlineCommand('Bash', { command: 'rm -rf /' }, CWD);
  assert.equal(d.blocked, true);
  if (d.blocked) assert.match(d.syntheticResult, /hardline-command-floor/);
  assert.equal(checkHardlineCommand('Bash', { command: 'ls' }, CWD).blocked, false, 'safe Bash passes');
});
