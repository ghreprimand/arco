// DD10 — parameterized `/prompt` command smoke.
//
// Headless / module-level (no live server, no API spend). Exercises the
// deterministic core the send handler calls: invocation parsing, bash-positional
// substitution, project/global resolution, and the DD7-trust gate on project
// scope (project template suppressed when includeProject:false).
//
// Run: npm run smoke:prompt-commands   (no server needed)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  const prompts = await import('../../server/src/prompts.js');
  const {
    parsePromptInvocation,
    substituteArgs,
    expandPromptCommand,
    projectPromptExists,
    listPromptCommands,
  } = prompts;

  const cwd = path.join(tmpdir(), `arco-prompts-smoke-${process.pid}`);
  const root = path.join(cwd, '.arco', 'prompts');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, 'deploy.md'),
    '---\ndescription: deploy helper\n---\nDeploy to $1 with mode $2. All args: $@. Literal $$HOME.\n',
  );

  try {
    await step('DD10.0 parse a /name args invocation; reject non-invocations', () => {
      const p = parsePromptInvocation('/deploy staging fast');
      assert(p, 'parsed');
      assertEq(p!.name, 'deploy', 'name');
      assertEq(p!.argsRaw, 'staging fast', 'argsRaw');
      assertEq(parsePromptInvocation('just a normal message'), null, 'plain text → null');
      assertEq(parsePromptInvocation('/UPPER bad'), null, 'invalid slug → null');
    });

    await step('DD10.1 bash-positional substitution', () => {
      assertEq(substituteArgs('to $1 mode $2', ['staging', 'fast']), 'to staging mode fast', '$1/$2');
      assertEq(substituteArgs('all: $@', ['a', 'b', 'c']), 'all: a b c', '$@');
      assertEq(substituteArgs('all: $*', ['a', 'b']), 'all: a b', '$*');
      assertEq(substituteArgs('${1}-${2}', ['x', 'y']), 'x-y', 'braced');
      assertEq(substituteArgs('unbound:[$3]', ['only']), 'unbound:[]', 'unbound → empty');
      assertEq(substituteArgs('lit $$VAR', []), 'lit $VAR', '$$ → literal $');
    });

    await step('DD10.2 expand a project template (trusted) with args', async () => {
      const r = await expandPromptCommand('deploy', 'staging fast', cwd, { includeProject: true });
      assert(r, 'expanded');
      assertEq(r!.scope, 'project', 'project scope');
      assert(r!.expanded.includes('Deploy to staging with mode fast'), 'positional args substituted');
      assert(r!.expanded.includes('All args: staging fast'), '$@ substituted');
      assert(r!.expanded.includes('Literal $HOME'), '$$ escaped');
    });

    await step('DD10.3 project template SUPPRESSED when untrusted (includeProject:false)', async () => {
      const r = await expandPromptCommand('deploy', 'staging fast', cwd, { includeProject: false });
      assertEq(r, null, 'no project expansion without trust');
      assertEq(await projectPromptExists('deploy', cwd), true, 'but the file still exists (for the trust notice)');
    });

    await step('DD10.4 unknown command yields null (normal turn)', async () => {
      assertEq(await expandPromptCommand('nope', '', cwd, { includeProject: true }), null, 'no template → null');
    });

    await step('DD10.5 catalog lists project templates; hides them when untrusted', async () => {
      const trusted = await listPromptCommands(cwd, { includeProject: true });
      assert(trusted.project.some((p) => p.name === 'deploy'), 'listed when trusted');
      const untrusted = await listPromptCommands(cwd, { includeProject: false });
      assertEq(untrusted.project.length, 0, 'project hidden when untrusted');
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }

  summary('prompt-commands');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
