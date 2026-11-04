import { execFileSync } from 'node:child_process';
// Must match the identity required by scripts/public-audit.mjs.
const [, name, email] = /^(.+) <(.+)>$/.exec('ghreprimand <203024559+ghreprimand@users.noreply.github.com>');
for (const [key, value] of Object.entries({
  'core.hooksPath': '.githooks',
  'user.name': name,
  'user.email': email,
  'commit.gpgsign': 'false',
})) execFileSync('git', ['config', '--local', key, value]);
console.log('Installed project-local public-history hooks and project commit identity.');
