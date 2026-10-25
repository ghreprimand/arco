// H54 — workspace facts smoke.
//
// Headless / module-level (no live server, no API spend). Runs the REAL
// probeProjectFacts against this repo's root + a synthetic temp project, proving:
//
//   (a) the Archon repo is detected as a node project with real verify commands
//       (npm run build, npm test/run …) — the system block the worker injects;
//   (b) the block renders with those commands (what the model sees);
//   (c) a temp repo with a Cargo.toml is detected as rust;
//   (d) the handoff template's {{verifyCommand}} is filled by the detected
//       primaryVerify (the Handoff/Spawn reuse).
//
// Run: npm run smoke:workspace-facts   (no server needed)

import { step, assert, summary } from './lib.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

async function main(): Promise<void> {
  const { probeProjectFacts, renderProjectFactsBlock } = await import('../../server/src/providers/claude-native/workspaceFacts.js');
  const { renderPrompt } = await import('../../server/src/handoffPrompts.js');

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  await step('H54.a Arco repo → node project with verify commands', async () => {
    const facts = await probeProjectFacts(repoRoot);
    assert(facts.ecosystem.includes('node'), `node detected, got ${facts.ecosystem.join(',')}`);
    assert(facts.verifyCommands.length > 0, 'at least one verify command');
    assert(!!facts.primaryVerify, `primaryVerify set: ${facts.primaryVerify}`);
    // Archon's root package.json has a `build` script.
    assert(facts.verifyCommands.some((c) => c.includes('build')), 'has a build verify command');
  });

  await step('H54.b block renders the detected commands', async () => {
    const facts = await probeProjectFacts(repoRoot);
    const block = renderProjectFactsBlock(facts);
    assert(!!block, 'block rendered');
    assert(block!.includes('Workspace facts'), 'has header');
    assert(block!.includes(facts.primaryVerify!), 'block names the primary verify command');
  });

  await step('H54.c rust temp project detected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-facts-rust-'));
    try {
      writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
      const facts = await probeProjectFacts(dir);
      assert(facts.ecosystem.includes('rust'), 'rust detected');
      assert(facts.verifyCommands.includes('cargo test'), 'cargo test in verify commands');
      assert(facts.primaryVerify === 'cargo build', `primaryVerify cargo build, got ${facts.primaryVerify}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await step('H54.d handoff seed reuses the detected verifyCommand', () => {
    const filled = renderPrompt('Run `{{verifyCommand}}` to check.', {
      cwd: '/x', wfid: 'w', handoffPath: '/x/h.md', verifyCommand: 'pnpm test',
    });
    assert(filled.includes('Run `pnpm test` to check.'), 'verifyCommand substituted');
    // Fallback preserves prior behavior when no facts.
    const fallback = renderPrompt('Run `{{verifyCommand}}`.', { cwd: '/x', wfid: 'w', handoffPath: '/x/h.md' });
    assert(fallback.includes('Run `npm run dev`.'), 'falls back to npm run dev');
  });

  summary('workspace-facts');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
