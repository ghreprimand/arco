// Workbench Expansion §D4 — project / session template store smoke.
//
// Exercises the store + the apply-shape contract directly, NO dev server and
// NO UI (mirrors endpoint-discovery.ts). To avoid clobbering the operator's
// real ~/.archon/templates.json, HOME is redirected to a throwaway tmp dir
// BEFORE the store module is imported (the store reads homedir() lazily on
// each call, so a pre-import env swap is enough).
//
// Legs:
//   1. save → list round-trips the config snapshot verbatim (provider/model/
//      effort/permissions + native knobs + optional cwd + seedPrompt + plan).
//   2. APPLY shape: reconstruct the WorkflowConfig the creator would build from
//      a saved template; assert it matches the saved config field-for-field
//      (the §D4 acceptance: "new from recipe reproduces the exact config").
//   3. validation fences: bad effort, missing model, empty name, oversize name,
//      duplicate-name (409-equivalent), over-cap seedPrompt.
//   4. delete removes; second delete is a no-op.
//
// Run: npm run smoke:templates  (no dev server needed)

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { step, assert, assertEq, summary } from './lib.js';
import type { WorkflowConfig, WorkflowTemplate } from '@archon/shared';

// Redirect HOME → tmp BEFORE importing the store so it persists under the
// sandbox, not the operator's real dotfiles.
const sandboxHome = mkdtempSync(path.join(tmpdir(), 'archon-tmpl-smoke-'));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome; // Windows parity (homedir() reads it there)

// Imported inside main() (after the HOME swap above) — tsx transpiles to CJS
// here so top-level await is unavailable.
let store: typeof import('../../server/src/templates/store.js');

// The config a creator might capture for a project-pinned "new Ledger tab".
const savedConfig = {
  primaryProvider: 'codex' as const,
  primaryModel: 'gpt-5-codex',
  primaryEffort: 'high' as const,
  skipPermissions: true,
  workingDirectory: '/home/operator/Projects/Ledger',
  providerAccountRef: 'codex-work',
  fastMode: true,
  efficiencyToolFilter: 'conservative' as const,
  outputStyle: 'lite' as const,
};

// Reconstruct the WorkflowConfig the creator's applyTemplate + handleCreate
// would build from a saved template. Keep in lockstep with index.tsx.
function applyToWorkflowConfig(t: WorkflowTemplate): Partial<WorkflowConfig> {
  const c = t.config;
  return {
    name: 'Ledger', // creator derives from cwd basename; not part of the template
    ...(c.primaryProvider && c.primaryProvider !== 'claude' ? { primaryProvider: c.primaryProvider } : {}),
    primaryModel: c.primaryModel,
    primaryEffort: c.primaryEffort,
    skipPermissions: c.skipPermissions,
    ...(c.workingDirectory ? { workingDirectory: c.workingDirectory } : {}),
    ...(c.providerAccountRef ? { providerAccountRef: c.providerAccountRef } : {}),
    ...(c.fastMode ? { fastMode: true } : {}),
    ...(c.efficiencyToolFilter && c.efficiencyToolFilter !== 'off' ? { efficiencyToolFilter: c.efficiencyToolFilter } : {}),
    ...(c.outputStyle && c.outputStyle !== 'normal' ? { outputStyle: c.outputStyle } : {}),
  };
}

async function main() {
  store = await import('../../server/src/templates/store.js');
  let saved: WorkflowTemplate | undefined;

  await step('save → list round-trips the config snapshot + seedPrompt + plan', async () => {
    saved = await store.saveTemplate({
      name: 'New Ledger tab',
      config: savedConfig,
      seedPrompt: 'Start by reading PLAN.md and the latest DEVLOG entry.',
      plan: '# Ledger\n\n- [ ] Wire OCR\n',
    });
    assert(saved.id && saved.id.length > 0, 'template got an id');
    assert(saved.createdAt && !Number.isNaN(Date.parse(saved.createdAt)), 'createdAt is ISO');

    const list = await store.listTemplates();
    const round = list.find((t) => t.id === saved!.id);
    assert(round, 'saved template appears in list');
    assertEq(round!.name, 'New Ledger tab', 'name preserved');
    assertEq(round!.config.primaryProvider, 'codex', 'provider preserved');
    assertEq(round!.config.primaryModel, 'gpt-5-codex', 'model preserved verbatim');
    assertEq(round!.config.primaryEffort, 'high', 'effort preserved');
    assertEq(round!.config.skipPermissions, true, 'skipPermissions preserved');
    assertEq(round!.config.workingDirectory, '/home/operator/Projects/Ledger', 'cwd preserved (project-pinned)');
    assertEq(round!.config.providerAccountRef, 'codex-work', 'providerAccountRef preserved');
    assertEq(round!.config.fastMode, true, 'fastMode preserved');
    assertEq(round!.config.efficiencyToolFilter, 'conservative', 'efficiencyToolFilter preserved');
    assertEq(round!.config.outputStyle, 'lite', 'outputStyle preserved');
    assert(round!.seedPrompt?.startsWith('Start by reading'), 'seedPrompt preserved (trimmed)');
    assert(round!.plan?.includes('Wire OCR'), 'plan preserved');
  });

  await step('apply: reconstructed WorkflowConfig matches the saved config field-for-field', async () => {
    assert(saved, 'template saved');
    const applied = applyToWorkflowConfig(saved!);
    assertEq(applied.primaryProvider, savedConfig.primaryProvider, 'provider matches');
    assertEq(applied.primaryModel, savedConfig.primaryModel, 'model matches');
    assertEq(applied.primaryEffort, savedConfig.primaryEffort, 'effort matches');
    assertEq(applied.skipPermissions, savedConfig.skipPermissions, 'skipPermissions matches');
    assertEq(applied.workingDirectory, savedConfig.workingDirectory, 'cwd matches');
    assertEq(applied.providerAccountRef, savedConfig.providerAccountRef, 'providerAccountRef matches');
    assertEq(applied.fastMode, savedConfig.fastMode, 'fastMode matches');
    assertEq(applied.efficiencyToolFilter, savedConfig.efficiencyToolFilter, 'efficiencyToolFilter matches');
    assertEq(applied.outputStyle, savedConfig.outputStyle, 'outputStyle matches');
  });

  await step('portable recipe: cwd omitted on save → absent on the template', async () => {
    const portable = await store.saveTemplate({
      name: 'Review-only Codex',
      config: { primaryProvider: 'codex', primaryModel: 'gpt-5-codex', primaryEffort: 'medium', skipPermissions: false },
    });
    assertEq(portable.config.workingDirectory, undefined, 'no cwd baked in (portable)');
    assertEq(portable.seedPrompt, undefined, 'no seedPrompt');
    assertEq(portable.plan, undefined, 'no plan');
  });

  await step('validation: bad effort / missing model / empty + oversize name rejected', async () => {
    await rejects(() => store.saveTemplate({ name: 'x', config: { primaryModel: 'opus', primaryEffort: 'turbo', skipPermissions: true } }), 'bad effort');
    await rejects(() => store.saveTemplate({ name: 'y', config: { primaryModel: '', primaryEffort: 'max', skipPermissions: true } }), 'empty model');
    await rejects(() => store.saveTemplate({ name: '   ', config: savedConfig }), 'empty name after trim');
    await rejects(() => store.saveTemplate({ name: 'z'.repeat(65), config: savedConfig }), 'oversize name');
    await rejects(() => store.saveTemplate({ name: 'big seed', config: { primaryModel: 'opus', primaryEffort: 'max', skipPermissions: true }, seedPrompt: 'x'.repeat(20000) }), 'oversize seedPrompt');
  });

  await step('validation: duplicate name rejected (case-insensitive)', async () => {
    let status = 0;
    try {
      await store.saveTemplate({ name: 'new ledger TAB', config: savedConfig });
    } catch (err) {
      if (err instanceof store.TemplateValidationError) status = err.status;
    }
    assertEq(status, 409, 'duplicate name → 409');
  });

  await step('delete removes; second delete is a no-op', async () => {
    assert(saved, 'template saved');
    const first = await store.deleteTemplate(saved!.id);
    assertEq(first, true, 'first delete removed it');
    const second = await store.deleteTemplate(saved!.id);
    assertEq(second, false, 'second delete is a no-op');
    const list = await store.listTemplates();
    assert(!list.some((t) => t.id === saved!.id), 'gone from list');
  });

  summary('templates');
}

async function rejects(fn: () => Promise<unknown>, label: string): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(threw, `${label} must be rejected`);
}

main();
