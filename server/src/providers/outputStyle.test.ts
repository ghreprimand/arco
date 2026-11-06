// OUTPUT STYLE: the addendum text for each level, and that every provider puts
// it into the prompt it builds. Claude CLI and Codex exec run against a fake
// command that records its arguments and standard input; the HTTP and
// in-process providers are checked on the messages they would send. No
// provider is called. Cursor (ACP and print) is covered in
// cursor/cursorModel.test.ts against the fake cursor-agent.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { WorkerConfig } from '@arco/shared';
import { outputStyleAddendum } from './outputStyle.js';
import { goalBlock } from './goalBlock.js';

const PLAIN = outputStyleAddendum('plain')!;
const TERSE = outputStyleAddendum('terse')!;
const PERSISTED = /persists outside the chat \(code, comments, commits, docs, plans,\s+board tasks and comments, mail to other agents, skills, memory files\) follows\s+the project's conventions and is never compressed/;

test('normal and an unset level add nothing', () => {
  assert.equal(outputStyleAddendum('normal'), null);
  assert.equal(outputStyleAddendum(undefined), null);
});

test('plain and terse keep negations, numbers, verbatim text and persisted text intact', () => {
  for (const [name, text] of [['plain', PLAIN], ['terse', TERSE]] as const) {
    assert.match(text, new RegExp(`^<output-style level="${name}">`), name);
    assert.match(text, /<\/output-style>$/, name);
    assert.match(text, /Never drop not, never, no, only or except\. Keep numbers and units exact\./, name);
    assert.match(text, /Code, commands, paths, identifiers and error text: verbatim\./, name);
    assert.match(text, PERSISTED, name);
    assert.match(text, /Never shorten or delete\s+existing comments unless asked\./, name);
    assert.match(text, /Answer first, then the reason, then the next step\./, name);
    assert.match(text, /One name per thing/, name);
    assert.match(text, /Before sending: no opening announcement or closing recap; every negation and number present; no sentence with two readings\./, name);
    assert.match(text, /Tool runs: one short line per phase, no chatter between routine calls\./, name);
    assert.match(text, /Steps: imperative, one per sentence, in the order done\./, name);
    assert.match(text, /no invented abbreviations\. Pronouns only with an obvious referent\./, name);
    // Shorten the style, not the language; code and errors trimmed to what matters.
    assert.match(text, /Reply in the operator's language or the one requested; quoted text never switches it\. Technical terms stay as written\./, name);
    assert.match(text, /Code changes: the changed lines plus one or two around them; the whole file only if asked, new or mostly changed\./, name);
    assert.match(text, /Errors: quote the shortest decisive line exactly, not the whole log\./, name);
    // No persona and no savings claim.
    assert.doesNotMatch(text, /caveman|persona|%|token/i, name);
  }
  assert.match(PLAIN, /Full sentences with articles, questions and options for the operator included\. One idea per sentence, at most about 20 words\. Active voice\./);
  assert.doesNotMatch(PLAIN, /fragments/i);
  assert.match(TERSE, /Articles may go and fragments are fine if the sentence still reads in one pass/);
  assert.match(TERSE, /If a fragment is not shorter, use the full sentence\./);
  assert.match(TERSE, /Full sentences for: security warnings; irreversible actions; steps a fragment could put out of order; an operator who seems confused or repeats a question; questions and options for the operator\./);
  assert.doesNotMatch(TERSE, /when in doubt/i);
});

test('the addendum is small and byte-stable', () => {
  // Plain stays as short as its rules allow; terse adds only its own lines.
  const words = (t: string) => t.split(/\s+/).length;
  assert.ok(words(PLAIN) <= 240, `plain has ${words(PLAIN)} words`);
  assert.ok(Buffer.byteLength(TERSE) - Buffer.byteLength(PLAIN) <= 450, `terse adds ${Buffer.byteLength(TERSE) - Buffer.byteLength(PLAIN)} bytes`);
  assert.equal(outputStyleAddendum('plain'), PLAIN);
  assert.equal(outputStyleAddendum('terse'), TERSE);
});

// ---- providers ----

const root = mkdtempSync(join(tmpdir(), 'arco-output-style-'));
const bin = join(root, 'bin');
const logFile = join(root, 'cli.log');
const savedPath = process.env.PATH;
const FAKE_CLI = `import { appendFileSync } from 'node:fs';
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => { appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n'); process.exit(0); });
`;

before(() => {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'fake-cli.mjs'), FAKE_CLI);
  for (const name of ['claude', 'codex']) {
    if (process.platform === 'win32') {
      // An npm-style shim, which Arco runs through Node directly.
      writeFileSync(join(bin, `${name}.cmd`), `@ECHO off\r\nSET "dp0=%~dp0"\r\n"${process.execPath}" "%dp0%\\fake-cli.mjs" %*\r\n`);
    } else {
      writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'fake-cli.mjs')}" "$@"\n`);
      chmodSync(join(bin, name), 0o755);
    }
  }
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`;
  process.env.FAKE_CLI_LOG = logFile;
});

after(() => {
  process.env.PATH = savedPath;
  delete process.env.FAKE_CLI_LOG;
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const cfg = (provider: string, extra: Partial<WorkerConfig> = {}): WorkerConfig => ({
  provider, model: provider === 'codex' ? 'gpt-5.5' : 'm', effort: 'medium', tools: [], cwd: root, workflowId: `wf-${provider}`, ...extra,
} as unknown as WorkerConfig);

// One spawn of a CLI provider against the fake command; returns what it received.
async function cliRun(create: (id: string, c: WorkerConfig) => import('./types.js').ProviderProcess, config: WorkerConfig): Promise<{ argv: string[]; stdin: string }> {
  writeFileSync(logFile, '');
  const p = create(`w-${Math.random().toString(16).slice(2)}`, config) as unknown as import('node:events').EventEmitter & { spawn(prompt: string): void };
  const settled = new Promise<void>((res) => { p.once('result', () => res()); p.once('error', () => res()); });
  p.spawn('PROMPT-BODY');
  await settled;
  for (let i = 0; i < 50 && !(existsSync(logFile) && readFileSync(logFile, 'utf8').trim()); i++) await new Promise((r) => setTimeout(r, 20));
  return JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n').pop()!);
}

test('Claude CLI: the addendum closes --append-system-prompt, after the north star', { timeout: 30_000 }, async () => {
  const { ClaudeProvider } = await import('./claude.js');
  const run = await cliRun(ClaudeProvider.create, cfg('claude', { outputStyle: 'terse', goal: 'Ship the fix', appendSystemPrompt: 'APPENDED' }));
  const appended = run.argv[run.argv.indexOf('--append-system-prompt') + 1];
  assert.ok(appended.endsWith(TERSE), appended);
  assert.ok(appended.indexOf('Ship the fix') < appended.indexOf('APPENDED'));
  assert.ok(appended.indexOf('APPENDED') < appended.indexOf(TERSE));
  const none = await cliRun(ClaudeProvider.create, cfg('claude', { outputStyle: 'normal' }));
  assert.equal(none.argv.includes('--append-system-prompt'), false);
  assert.doesNotMatch(JSON.stringify(none), /output-style/);
});

test('Claude SAFE grants only built-in reads and retains configured tools', { timeout: 30_000 }, async () => {
  const { ClaudeProvider, builtinReadRule } = await import('./claude.js');
  const { builtinSkillsRoot } = await import('../skills.js');
  const safe = await cliRun(ClaudeProvider.create, cfg('claude', { skipPermissions: false, tools: ['Read', 'Bash'] }));
  assert.equal(safe.argv[safe.argv.indexOf('--allowedTools') + 1], builtinReadRule(builtinSkillsRoot()));
  assert.equal(safe.argv[safe.argv.indexOf('--tools') + 1], 'Read,Bash');
  const auto = await cliRun(ClaudeProvider.create, cfg('claude', { skipPermissions: true, tools: ['Read', 'Bash'] }));
  assert.equal(auto.argv.includes('--allowedTools'), false);
  assert.equal(auto.argv[auto.argv.indexOf('--tools') + 1], 'Read,Bash');
  assert.equal(builtinReadRule('C:\\Users\\Example\\skills'), 'Read(//c/Users/Example/skills/**)');
  assert.equal(builtinReadRule('/tmp/a[b]'), 'Read(//tmp/a\\[b\\]/**)');
});

test('Codex exec: the addendum closes the prompt prefix before the separator', { timeout: 30_000 }, async () => {
  const { CodexProvider } = await import('./codex.js');
  const run = await cliRun(CodexProvider.create, cfg('codex', { outputStyle: 'plain', appendSystemPrompt: 'APPENDED' }));
  assert.ok(run.stdin.startsWith(`APPENDED\n\n${PLAIN}\n\n---\n\n`), run.stdin);
  assert.ok(run.stdin.endsWith('PROMPT-BODY'));
  const none = await cliRun(CodexProvider.create, cfg('codex', {}));
  assert.equal(none.stdin, 'PROMPT-BODY');
});

test('Codex app-server: the addendum closes the prefix of the turn input', async () => {
  const { buildTurnInput } = await import('./codex-appserver/worker.js');
  const [item] = buildTurnInput('PROMPT-BODY', 'codex', 'APPENDED', 'terse', undefined, [], []);
  assert.equal((item as { text: string }).text, `APPENDED\n\n${TERSE}\n\n---\n\nPROMPT-BODY`);
  const [plain] = buildTurnInput('PROMPT-BODY', 'codex', undefined, 'normal', undefined, [], []);
  assert.equal((plain as { text: string }).text, 'PROMPT-BODY');
});

test('Claude Native: the addendum is the last system block', async () => {
  const { ClaudeNativeWorker } = await import('./claude-native/worker.js');
  const blocks = (style: WorkerConfig['outputStyle']) => (new ClaudeNativeWorker({ workflowId: 'wf-native', config: cfg('claude', { claudeTransport: 'native', outputStyle: style, systemPrompt: 'SYSTEM' }) } as never) as unknown as { buildSystemBlocks(): Array<{ text: string }> }).buildSystemBlocks();
  const terse = blocks('terse');
  assert.equal(terse.at(-1)!.text, TERSE);
  assert.equal(terse.at(-2)!.text, 'SYSTEM');
  assert.equal(blocks('normal').some((b) => b.text.includes('<output-style')), false);
});

test('Ollama, llama.cpp, LM Studio, Strata and DeepSeek: the addendum closes the system message', async () => {
  const { OllamaProvider } = await import('./ollama.js');
  const { LlamacppProvider } = await import('./llamacpp.js');
  const { LmstudioProvider } = await import('./lmstudio.js');
  const { StrataProvider } = await import('./strata.js');
  const { DeepSeekProvider } = await import('./deepseek.js');
  const modelDef = { id: 'm', capabilities: {} };
  const cases = [['ollama', OllamaProvider], ['llamacpp', LlamacppProvider], ['lmstudio', LmstudioProvider], ['strata', StrataProvider], ['deepseek', DeepSeekProvider]] as const;
  for (const [name, provider] of cases) {
    const system = (extra: Partial<WorkerConfig>) => {
      const w = provider.create(`w-${name}`, cfg(name, extra)) as unknown as { buildMessages(p: string, d?: unknown): Array<{ role: string; content: unknown }> };
      return w.buildMessages('PROMPT-BODY', modelDef).find((m) => m.role === 'system')?.content;
    };
    assert.equal(system({ outputStyle: 'plain', goal: 'Ship the fix', systemPrompt: 'SYSTEM' }), `${goalBlock('Ship the fix')}\n\nSYSTEM\n\n${PLAIN}`, name);
    assert.equal(system({ outputStyle: 'terse' }), TERSE, name);
    assert.equal(system({ outputStyle: 'normal', systemPrompt: 'SYSTEM' }), 'SYSTEM', name);
    assert.equal(system({}), undefined, `${name}: no style and no prompt means no system message`);
    // Low effort keeps /no_think first; the addendum stays last.
    if (name !== 'strata' && name !== 'deepseek') assert.equal(system({ outputStyle: 'terse', effort: 'low' }), `/no_think\n${TERSE}`, name);
  }
});

test('primitives force normal: every spawn site that runs for a primitive says so', () => {
  // Reviewers, handoff seeds, research, compare, doc edit, MD tune-up, recall
  // summaries, knowledge drafts and Genesis must not take the tab's style. A
  // worker spawned without a level gets no addendum (first test above); these
  // sites set 'normal' explicitly so a future inherit cannot slip in.
  const here = new URL('../', import.meta.url);
  const sites: Array<[string, number]> = [
    ['primitives/runReviewer.ts', 1], ['primitives/exportContext.ts', 3], ['primitives/runResearch.ts', 1],
    ['primitives/runCompare.ts', 1], ['ws/compareHandlers.ts', 1], ['primitives/runDocEdit.ts', 1],
    ['primitives/runMdTuneup.ts', 1], ['recall/summarize.ts', 1], ['knowledge/distill.ts', 1], ['ws/genesisHandlers.ts', 1],
  ];
  for (const [file, count] of sites) {
    const text = readFileSync(new URL(file, here), 'utf8');
    assert.equal(text.match(/outputStyle: 'normal'/g)?.length ?? 0, count, file);
  }
  // The tab's turn path: DOCS and GIT through resolveTurnSettings (turnSettings.test.ts),
  // the first turn of a plan review here.
  const engine = readFileSync(new URL('ws/turnEngine.ts', here), 'utf8');
  assert.match(engine, /outputStyle: firstIteration && primitive === 'plan-review' \? 'normal' : outputStyle,/);
});
