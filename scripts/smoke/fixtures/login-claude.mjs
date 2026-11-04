#!/usr/bin/env node
// Claude CLI protocol fixture for onboarding checks: prints the same shape of
// sign-in output as the real CLI, takes the pasted code on stdin, and records
// the login as a marker file. No network, credentials or inference.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const marker = join(homedir(), '.claude', 'fixture-login');
if (argv.includes('--version')) { console.log('2.1.302 (Claude Code)'); process.exit(0); }
if (argv[0] === 'auth' && argv[1] === 'status') {
  const loggedIn = existsSync(marker);
  console.log(JSON.stringify(loggedIn ? { loggedIn: true, email: 'fixture@example.test', subscriptionType: 'max' } : { loggedIn: false }));
  process.exit(loggedIn ? 0 : 1);
}
if (argv[0] === 'auth' && argv[1] === 'logout') { try { unlinkSync(marker); } catch { /* not logged in */ } process.exit(0); }
if (argv[0] === 'auth' && argv[1] === 'login') {
  console.log('Opening browser to sign in…');
  console.log("If the browser didn't open, visit: https://auth.example.test/claude/authorize?code=true");
  process.stdout.write('Paste code here if prompted > ');
  const line = await new Promise(resolve => readline.createInterface({ input: process.stdin }).once('line', resolve));
  if (line.trim() === 'ARCO-FIXTURE-PASTE') {
    mkdirSync(join(homedir(), '.claude'), { recursive: true });
    writeFileSync(marker, '');
    console.log('Login successful');
    process.exit(0);
  }
  console.error('Invalid code');
  process.exit(1);
}
if (argv.includes('--help')) { console.log('claude --print --resume --model --output-format'); process.exit(0); }
process.exit(0);
