import assert from 'node:assert/strict';
import test from 'node:test';
import { CursorAcpWorker } from './providers/cursor/worker.js';
import { PrimaryBackgroundTracker, backgroundShellInput } from './primaryBackgroundTracker.js';

test('background discovery attributes shell jobs without claiming provider or MCP processes', async () => {
  const rows = [
    { pid: 2, ppid: 987654321, argv: ['/fixture/vendor/bin/codex-native'] },
    { pid: 3, ppid: 2, argv: ['node', '/fixture/server/dist/mcp/arcoMcpServer.js', 'fixture'] },
    { pid: 4, ppid: 2, argv: ['node', '/fixture/custom-mcp.js'] },
    { pid: 5, ppid: 4, argv: ['sleep', '900'] },
    { pid: 6, ppid: 2, argv: ['bash', '-lc', 'sleep 900'] },
    { pid: 7, ppid: 6, argv: ['sleep', '900'] },
  ];
  const tracker = new PrimaryBackgroundTracker({
    workflowId: 'fixture', broadcast: () => {},
    snapshotProcesses: async () => rows,
    probe: async () => ({ alive: true, cpuTicks: 1, rssBytes: 1024 }),
  } as any);
  try {
    tracker.noteBgHint('shell-1', 'sleep 900');
    tracker.attachParent(987654321, [{ command: 'node', args: ['/fixture/custom-mcp.js'] }]);
    await (tracker as any).tick();
    assert.deepEqual(tracker.snapshotJobs().map(j => [j.pid, j.command, j.toolUseId]), [[6, 'sleep 900', 'shell-1']]);
    tracker.detachParent();
    await (tracker as any).tick();
    assert.equal(tracker.snapshotJobs().length, 1);
  } finally { tracker.dispose(); }
});

for (const [shell, option] of [['/bin/bash', '-lc'], ['C:\\Windows\\System32\\cmd.exe', '/c'], ['C:\\Tools\\pwsh.exe', '-Command']]) {
  test(`shell ancestry tracks agent work and excludes configured helpers: ${shell}`, async () => {
    let rows = [
      { pid: 10, ppid: 987654321, argv: ['node', '/fixture/server/dist/mcp/clusterMcpServer.js'] },
      { pid: 11, ppid: 10, argv: [shell, option, 'npm run dev'] },
      { pid: 12, ppid: 987654321, argv: ['node', '/fixture/server/dist/mcp/voiceMcpServer.js'] },
      { pid: 20, ppid: 987654321, argv: ['custom-server.exe', '--stdio'] },
      { pid: 21, ppid: 20, argv: [shell, option, 'npm run dev'] },
      { pid: 30, ppid: 987654321, argv: [shell, option, 'npm run dev', ...(shell === '/bin/bash' ? ['fixture-shell'] : [])] },
      { pid: 31, ppid: 30, argv: ['node', '/fixture/dev-server.js'] },
    ];
    let shellAlive = true;
    const tracker = new PrimaryBackgroundTracker({
      workflowId: 'fixture', broadcast: () => {}, snapshotProcesses: async () => rows,
      probe: async pid => ({ alive: pid !== 30 || shellAlive, cpuTicks: 1, rssBytes: 1024 }),
    });
    try {
      tracker.noteBgHint('dev', 'npm run dev');
      tracker.attachParent(987654321, [{ command: 'custom-server.exe', args: ['--stdio'] }]);
      await (tracker as any).tick();
      assert.deepEqual(tracker.snapshotJobs().map(j => j.pid), [30]);
      assert.equal(tracker.snapshotJobs()[0].rssBytes, 2048);
      shellAlive = false;
      rows = rows.filter(row => row.pid !== 30).map(row => row.pid === 31 ? { ...row, ppid: 1 } : row);
      tracker.detachParent();
      await (tracker as any).tick();
      assert.deepEqual(tracker.snapshotJobs().map(j => [j.pid, j.alive]), [[31, true]]);
      assert.equal(tracker.rootPidForToolUse('dev'), 31);
    } finally { tracker.dispose(); }
  });
}

test('each concurrent command keeps its own tool hint, including a Codex quoted wrapper', async () => {
  const tracker = new PrimaryBackgroundTracker({
    workflowId: 'fixture', broadcast: () => {},
    snapshotProcesses: async () => [
      { pid: 2, ppid: 987654321, argv: ['C:\\vendor\\codex-native.exe'] },
      { pid: 3, ppid: 2, argv: ['/bin/bash', '-lc', 'npm run dev'] },
      { pid: 4, ppid: 2, argv: ['sleep', '900'] },
      { pid: 5, ppid: 2, argv: ['node', '/fixture/provider-helper.js'] },
    ],
    probe: async () => ({ alive: true, cpuTicks: 1, rssBytes: 0 }),
  });
  try {
    tracker.noteBgHint('dev', "/bin/bash -lc 'npm run dev'");
    tracker.noteBgHint('sleep', 'sleep 900');
    tracker.attachParent(987654321);
    await (tracker as any).tick();
    assert.deepEqual(tracker.snapshotJobs().map(j => [j.pid, j.toolUseId]), [[3, 'dev'], [4, 'sleep']]);
    tracker.noteBgHint('never', 'npm run build');
    await (tracker as any).tick();
    assert.equal(tracker.snapshotJobs().length, 2);
  } finally { tracker.dispose(); }
});

test('shell hints accept Claude objects, Codex exec strings and app-server objects', () => {
  for (const input of [JSON.stringify({ command: 'sleep 900', run_in_background: true }), 'sleep 900', JSON.stringify('sleep 900'), JSON.stringify({ command: 'sleep 900', cwd: '/fixture' })]) {
    assert.equal(backgroundShellInput(input).command, 'sleep 900');
  }
  assert.deepEqual(backgroundShellInput('{"path":"/fixture"}'), {});
});

test('Cursor ACP carries execute kind through a human-readable title', () => {
  const worker: any = new CursorAcpWorker('fixture', { provider: 'cursor', model: 'auto', cwd: '/fixture', effort: 'high', tools: [] } as any, undefined);
  worker.turnActive = true;
  const events: any[] = [];
  worker.on('tool_use', (event: unknown) => events.push(event));
  for (const sessionUpdate of ['tool_call', 'tool_call_update']) {
    worker.onNotification({ method: 'session/update', params: { update: {
      sessionUpdate, kind: 'execute', title: 'Start development server', toolCallId: 'shell-1',
      rawInput: { command: 'npm run dev' }, status: 'in_progress',
    } } });
  }
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.itemType, 'command_execution');
    assert.equal(event.name, 'Start development server');
    assert.equal(backgroundShellInput(event.input).command, 'npm run dev');
  }
});

test('a shell that execs an npm launcher still identifies the agent dev server', async () => {
  const tracker = new PrimaryBackgroundTracker({
    workflowId: 'fixture', broadcast: () => {},
    snapshotProcesses: async () => [
      { pid: 10, ppid: 987654321, argv: ['node', '/fixture/npm/bin/npm-cli.js', 'run', 'dev'] },
      { pid: 11, ppid: 10, argv: ['node', '/fixture/dev-server.js'] },
      { pid: 20, ppid: 987654321, argv: ['node', '/fixture/custom-mcp.js'] },
    ],
    probe: async () => ({ alive: true, cpuTicks: 1, rssBytes: 1024 }),
  });
  try {
    tracker.noteBgHint('dev', "/bin/bash -lc 'npm run dev'");
    tracker.attachParent(987654321);
    await (tracker as any).tick();
    assert.deepEqual(tracker.snapshotJobs().map(j => [j.pid, j.command]), [[10, "/bin/bash -lc 'npm run dev'"]]);
    assert.equal(tracker.snapshotJobs()[0].rssBytes, 2048);
  } finally { tracker.dispose(); }
});
