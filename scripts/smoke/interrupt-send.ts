// Isolated source server + deterministic providers. No inference or live tabs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { connect, type SmokeClient } from './lib.js';
import { UPSTREAM_ENV_PREFIX } from '../../server/src/envAliases.js';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'arco-interrupt-smoke-'));
  const bin = join(dir, 'bin'), home = join(dir, 'home'), journal = join(dir, 'provider.jsonl');
  mkdirSync(bin); mkdirSync(join(home, '.arco'), { recursive: true }); writeFileSync(journal, '');
  for (const name of ['claude', 'codex']) {
    const executable = join(bin, name);
    copyFileSync('scripts/smoke/fixtures/interrupt-cli.mjs', executable);
    writeFileSync(executable, '#!/usr/bin/env node\n' + readFileSync(executable, 'utf8')); chmodSync(executable, 0o755);
  }
  writeFileSync(join(home, '.arco/auth.json'), JSON.stringify({ claude: { native: {
    accessToken: 'fixture-token', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now(),
  } } }));
  const attachment = join(dir, 'note.txt'); writeFileSync(attachment, 'attachment fixture');
  const project = join(dir, 'project'); mkdirSync(project);
  writeFileSync(join(project, 'context.txt'), 'interrupt-context-fixture');
  const skillDir = join(home, '.arco', 'skills', 'interrupt-fixture'); mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: interrupt-fixture\ndescription: isolated fixture\n---\ninterrupt-skill-fixture');
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = (reserve.address() as { port: number }).port; await new Promise<void>((r) => reserve.close(() => r()));
  const log = openSync(join(dir, 'server.log'), 'w');
  // A home exported by the caller would win over the fixture home; drop it.
  const inherited = { ...process.env }; delete inherited.ARCO_HOME; delete inherited[`${UPSTREAM_ENV_PREFIX}HOME`];
  const child = spawn(process.execPath, ['--conditions', 'development', '--import', 'tsx', '--import', resolve('scripts/smoke/fixtures/interrupt-preload.mjs'), 'server/src/index.ts'], {
    env: { ...inherited, ARCO_INTERRUPT_HOME: home, ARCO_INTERRUPT_BIN: bin, ARCO_INTERRUPT_JOURNAL: journal,
      PATH: `${bin}:${process.env.PATH}`, ARCO_PORT: String(port), ARCO_UPDATE_CHECK: '0', ARCO_WS_AUTH: 'off', ARCO_SERVE_CLIENT: '0' },
    stdio: ['ignore', log, log],
  });
  let c: SmokeClient | undefined;
  const records = () => readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  try {
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error(`Server exited; see ${dir}/server.log`);
      try { if ((await fetch(`http://127.0.0.1:${port}/api/capabilities`)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    c = await connect(`ws://127.0.0.1:${port}/ws`);
    for (const [provider, transport] of [['codex', 'appserver'], ['codex', 'exec'], ['claude', 'cli'], ['claude', 'native']]) {
      const offset = records().length;
      c.send({ type: 'create_workflow', config: { kind: 'workflow', name: `Interrupt ${provider}/${transport}`,
        primaryProvider: provider, primaryModel: provider === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.5', primaryEffort: 'high',
        claudeTransport: transport, codexTransport: transport, workingDirectory: project, skipPermissions: false, chatWebAccess: false } });
      const created = await c.waitFor((m) => m.type === 'workflow_created', 10000);
      const workflowId = String(created.workflowId);
      const wait = (type: string, predicate: (m: any) => boolean = () => true) =>
        c!.waitFor((m) => m.workflowId === workflowId && m.type === type && predicate(m), 15000, `${provider}/${transport} ${type}`);
      const send = (content: string, kind?: string, files?: string[]) => c!.send({ type: 'user_message', workflowId,
        content, clientMessageId: content, ...(kind ? { interjection: true, kind } : {}), ...(files ? { attachments: files, pickedSkills: [{scope:'global',slug:'interrupt-fixture'}] } : {}) });
      send('HOLD original');
      await wait('primary_text', (m) => String(m.text).includes('READY HOLD'));
      send('earlier steer', 'steer'); send('FOLLOW after correction', 'follow-up');
      await wait('queue_update', (m) => m.steering?.length === 1 && m.followUp?.length === 1);
      send('CORRECTION urgent @file:context.txt', 'interrupt', [attachment]);
      await wait('user_message_echo', (m) => m.kind === 'interrupt');
      await wait('queue_update', (m) => m.steering?.some((q: any) => q.interrupt));
      await wait('primary_text', (m) => String(m.text).includes('READY CORRECTION'));
      await wait('primary_text', (m) => String(m.text).includes('READY FOLLOW'));
      await wait('primary_turn_ended', (m) => true); // Earlier end events can be buffered; journal verifies real completion below.
      for (let i = 0; i < 100 && records().slice(offset).filter((r) => r.event === 'completed').length < 2; i++)
        await new Promise((r) => setTimeout(r, 25));
      const events = records().slice(offset), starts = events.filter((r) => r.event === 'start');
      assert.equal(starts.length, 3, `${provider}/${transport}: original, correction, then preserved queue`);
      assert(starts[1].prompt.includes('CORRECTION urgent'));
      assert(starts[1].prompt.includes(attachment), 'interrupt attachments survive');
      assert(starts[1].prompt.includes('interrupt-context-fixture'), 'expanded refs survive');
      assert(starts[1].prompt.includes('interrupt-skill-fixture'), 'picked skill follows correction');
      assert(!starts[2].prompt.includes('interrupt-skill-fixture'), 'picked skill is scoped to its prompt');
      assert(!starts[1].prompt.includes('earlier steer') && !starts[1].prompt.includes('FOLLOW after correction'));
      assert(starts[2].prompt.includes('earlier steer') && starts[2].prompt.includes('FOLLOW after correction'));
      assert(events.findIndex((r) => r.event === 'interrupted') < events.findIndex((r) => r === starts[1]), 'shutdown before resume');
      assert(!events.some((r) => r.event === 'steer'), 'cancelled worker cannot consume the correction');

      // A second pair of immediate sends must both survive cancellation.
      send('HOLD repeat'); await wait('primary_text', (m) => String(m.text).includes('READY HOLD'));
      send('CORRECTION one', 'interrupt'); send('CORRECTION two', 'interrupt');
      await wait('primary_text', (m) => String(m.text).includes('READY CORRECTION'));
      for (let i = 0; i < 100 && records().slice(offset).filter((r) => r.event === 'completed').length < 3; i++)
        await new Promise((r) => setTimeout(r, 25));
      const repeated = records().slice(offset).filter((r) => r.event === 'start' && r.prompt.includes('CORRECTION one'));
      assert.equal(repeated.length, 1); assert(repeated[0].prompt.includes('CORRECTION two'));

      send('HOLD stop'); await wait('primary_text', (m) => String(m.text).includes('READY HOLD'));
      const beforeStop = records().length;
      send('CORRECTION cancelled', 'interrupt');
      await wait('queue_update', (m) => m.steering?.some((q: any) => q.clientMessageId === 'CORRECTION cancelled'));
      c.send({ type: 'cancel', workflowId });
      await wait('turn_cancelled');
      await new Promise((r) => setTimeout(r, 600));
      assert(!records().slice(beforeStop).some((r) => r.event === 'start'), 'STOP cancels the pending redirect');
      // STOP also wins while an interrupt is still expanding project refs.
      send('HOLD preflight'); await wait('primary_text', (m) => String(m.text).includes('READY HOLD'));
      const beforePreflightStop = records().length;
      send('CORRECTION preflight @file:context.txt', 'interrupt');
      c.send({ type: 'cancel', workflowId });
      await wait('turn_cancelled');
      await new Promise((r) => setTimeout(r, 600));
      assert(!records().slice(beforePreflightStop).some((r) => r.event === 'start'), 'STOP cancels an interrupt in async preflight');
      const persisted = readFileSync(join(project, '.arco', 'workflows', workflowId, 'events.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(persisted.filter((m) => m.type === 'user_message_echo' && m.clientMessageId === 'CORRECTION urgent @file:context.txt').length, 1);
      assert(persisted.some((m) => m.type === 'queue_update' && m.steering.some((q: any) => q.interrupt)));
      c.send({ type: 'remove_workflow', workflowId });
      console.log(`PASS ${provider}/${transport}: active interruption, shutdown before resume, queue priority/preservation, attachments, repeated corrections, STOP.`);
    }
  } finally {
    if (c) await c.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await stopped; clearTimeout(timer);
    }
    closeSync(log); console.log('Isolated artifacts:', dir);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
