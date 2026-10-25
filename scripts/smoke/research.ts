// Smoke for the Deep Research primitive — WORKBENCH_EXPANSION_PLAN.md §B2.
//
// A live research turn spends REAL Anthropic + web quota and needs a running
// server (see web-search-tool-loop.ts for that style). For a fast, hermetic,
// CI-safe check we exercise the server-side primitive directly with a STUBBED
// WorkerManager: a fake spawn emits a canned cited report as `worker_text`,
// counts a web-tool invocation, and resolves. This asserts the load-bearing
// plumbing — round-cap → webSearchMaxUses, framing dispatch, artifact write
// with frontmatter, sourceCount extraction, and the research_started /
// research_progress / research_complete broadcasts — without a model round-trip.
//
//   npm run smoke:research
//
// Exits 0 on all-pass, 1 on any failure.

import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, assert, assertEq, summary, type AnyMessage } from './lib.js';
import { runResearch, type ResearchContext } from '../../server/src/primitives/runResearch.js';
import { artifactsDir } from '../../server/src/workers/limits.js';

// Minimal stub of the bits of WorkerManager.spawn that runResearch touches.
// Records the spec + opts it was called with so we can assert the round-cap
// plumbing, then drives the onEvent callback like a real Native research turn:
// a web_search tool_use (counts a round) followed by the cited report text.
interface CapturedSpawn {
  spec: AnyMessage;
  opts: AnyMessage;
}

function makeStubManager(report: string, captured: CapturedSpawn[]) {
  return {
    spawn(spec: AnyMessage, onEvent: (m: AnyMessage) => void, opts: AnyMessage) {
      captured.push({ spec, opts });
      // Simulate one web_search round, then stream the report text.
      onEvent({ type: 'worker_tool_use', workerId: spec.id as string, tool: 'web_search', input: '{}', status: 'started' });
      onEvent({ type: 'worker_text', workerId: spec.id as string, text: report });
      return Promise.resolve({ id: spec.id, text: '', costUsd: 0, durationMs: 42 });
    },
    // runResearch never calls kill in the happy path; present for shape parity.
    kill() { return false; },
  };
}

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-smoke-research-'));
  const workflowId = 'smoke-research-wf';
  console.log(`research smoke — cwd ${cwd}`);
  console.log('');

  const CITED_REPORT = [
    '## Summary',
    'SSE is simpler for one-way streaming; websockets win for bidirectional.',
    '',
    '## Findings',
    'SSE auto-reconnects ([source](https://example.com/sse-guide)).',
    'Websockets need a heartbeat ([ws docs](https://example.org/ws-heartbeat)).',
    'Proxy support differs ([source](https://example.com/sse-guide)).', // dup URL → counted once
    '',
    '## Sources',
    '- https://example.com/sse-guide',
    '- https://example.org/ws-heartbeat',
  ].join('\n');

  const broadcasts: AnyMessage[] = [];
  const captured: CapturedSpawn[] = [];
  const ctx: ResearchContext = {
    workflowId,
    cwd,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    manager: makeStubManager(CITED_REPORT, captured) as any,
    broadcast: (m) => { broadcasts.push(m as AnyMessage); },
  };

  let artifactName = '';

  await step('dispatch 1-round research run', async () => {
    const handle = runResearch(ctx, {
      researcher: { provider: 'claude', model: 'opus' as never, effort: 'high' as never },
      topic: 'SSE vs websockets for a chat backend',
      maxRounds: 1,
    });
    artifactName = handle.artifactName;
    const result = await handle.settled;
    assert(!result.error, `settled without error (got: ${result.error})`);
    assertEq(result.roundsUsed, 1, 'one web-tool round counted');
    assertEq(result.sourceCount, 2, 'two unique cited URLs extracted');
  });

  await step('round cap threaded to webSearchMaxUses', async () => {
    assertEq(captured.length, 1, 'exactly one spawn');
    assertEq(captured[0].opts.webSearchMaxUses, 1, 'maxRounds=1 → webSearchMaxUses=1');
    assertEq(captured[0].opts.sandbox, 'read-only', 'read-only sandbox');
    assertEq(captured[0].opts.outputStyle, 'normal', 'outputStyle forced to normal');
    // Claude local tool allowlist excludes web tools (native server tool).
    const tools = captured[0].spec.tools as string[];
    assert(Array.isArray(tools) && tools.includes('Read') && !tools.includes('WebSearch'),
      'claude local tools = Read/Grep/Glob/LSP, no WebSearch');
  });

  await step('research_started broadcast fired', async () => {
    const started = broadcasts.find((m) => m.type === 'research_started');
    assert(started, 'research_started present');
    assertEq(started!.isFollowUp, false, 'not a follow-up');
    assert(String(started!.artifactName).startsWith('research-'), 'artifact name shape');
  });

  await step('research_progress broadcast fired', async () => {
    const prog = broadcasts.find((m) => m.type === 'research_progress');
    assert(prog, 'research_progress present (web_search counted)');
    assertEq(prog!.round, 1, 'progress round 1');
  });

  await step('research_complete broadcast fired', async () => {
    const done = broadcasts.find((m) => m.type === 'research_complete');
    assert(done, 'research_complete present');
    assert(!done!.error, 'no error on complete');
    assertEq(done!.sourceCount, 2, 'complete reports 2 sources');
    assertEq(done!.roundsUsed, 1, 'complete reports 1 round');
  });

  await step('research-<ts>.md artifact written with frontmatter', async () => {
    const dir = artifactsDir(cwd, workflowId);
    const files = readdirSync(dir);
    assert(files.includes(artifactName), `artifact ${artifactName} on disk (saw ${files.join(', ')})`);
    assert(/^research-.+\.md$/.test(artifactName), 'research-<ts>.md name shape');
    const body = readFileSync(join(dir, artifactName), 'utf8');
    assert(body.startsWith('---\n'), 'YAML frontmatter present');
    assert(body.includes('sourceCount: 2'), 'frontmatter records sourceCount');
    assert(body.includes('maxRounds: 1'), 'frontmatter records maxRounds');
    assert(body.includes('## Findings'), 'report body persisted');
  });

  await step('dig-deeper follow-up appends addendum to same artifact', async () => {
    const ADDENDUM = [
      '## Addendum — proxy behavior',
      'Corporate proxies often buffer SSE ([source](https://example.net/proxy-buffering)).',
    ].join('\n');
    const captured2: CapturedSpawn[] = [];
    const broadcasts2: AnyMessage[] = [];
    const ctx2: ResearchContext = {
      workflowId,
      cwd,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      manager: makeStubManager(ADDENDUM, captured2) as any,
      broadcast: (m) => { broadcasts2.push(m as AnyMessage); },
    };
    const dir = artifactsDir(cwd, workflowId);
    const before = readFileSync(join(dir, artifactName), 'utf8');
    const handle = runResearch(ctx2, {
      researcher: { provider: 'claude', model: 'opus' as never, effort: 'high' as never },
      topic: '',
      maxRounds: 2,
      seedArtifactName: artifactName,
      followUp: 'what about proxies?',
      priorBody: before,
    });
    const result = await handle.settled;
    assert(!result.error, `follow-up settled without error (got ${result.error})`);
    assertEq(handle.artifactName, artifactName, 'follow-up reuses the seed artifact name');
    const started = broadcasts2.find((m) => m.type === 'research_started');
    assertEq(started!.isFollowUp, true, 'follow-up flagged isFollowUp');
    const after = readFileSync(join(dir, artifactName), 'utf8');
    assert(after.length > before.length, 'artifact grew (appended, not rewritten)');
    assert(after.startsWith(before), 'original report preserved verbatim');
    assert(after.includes('## Addendum'), 'addendum section appended');
    const done = broadcasts2.find((m) => m.type === 'research_complete');
    assertEq(done!.isFollowUp, true, 'complete flagged isFollowUp');
  });

  rmSync(cwd, { recursive: true, force: true });
  summary('research');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
