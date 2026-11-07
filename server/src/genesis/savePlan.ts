import { promises as fs } from 'node:fs';
import path from 'node:path';
import { insertGuardrails, type GenesisSeed } from '@arco/shared';
import { createPlan, writePlanRef, REF_BODY_MAX } from '../planStore.js';
import { buildSeedDocs } from './scaffold.js';

// Keep every generated document in the plan before attempting exclusive project
// writes. Existing files (including symlinks and directories) are never opened.
export async function saveGenesisPlan(cwd: string, seed: GenesisSeed, publicProject: boolean) {
  const root = await fs.realpath(cwd);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('The project folder is not a directory.');
  const docs = buildSeedDocs(seed).filter((doc) => doc.path === 'SPEC.md' || doc.path === 'TODO.md');
  const refs = [
    { slug: 'concept', body: `# Concept\n\n${seed.concept}\n\n## Spark\n\n${seed.spark}\n` },
    { slug: 'case', body: `# Case\n\n${seed.theCase}\n` },
    { slug: 'build-direction', body: `# Build direction\n\n${seed.buildDirection}\n\n## Stack\n\n${seed.stack ?? ''}\n\n## Scope\n\n${seed.scope ?? ''}\n` },
    { slug: 'first-steps', body: docs.find((doc) => doc.path === 'TODO.md')!.content },
    { slug: 'spec', body: docs.find((doc) => doc.path === 'SPEC.md')!.content },
  ];
  if (refs.some((ref) => Buffer.byteLength(ref.body, 'utf8') > REF_BODY_MAX)) {
    throw new Error('The Genesis seed is too large for a plan reference document. Shorten it before saving.');
  }
  const body = [
    `# ${seed.title.trim()} - plan`, '',
    '### First steps', '',
    '- [ ] Confirm the concept and case. [Concept](ref:concept) [Case](ref:case)',
    '- [ ] Confirm the stack and scope boundaries. [Build direction](ref:build-direction) [Spec](ref:spec)',
    '- [ ] Build the smallest end-to-end slice. [First steps](ref:first-steps)', '',
  ].join('\n');
  const plan = await createPlan(root, { title: `${seed.title.trim()} - plan`, body: publicProject ? insertGuardrails(body) : body });
  for (const ref of refs) {
    const result = await writePlanRef(root, plan.id, ref.slug, ref.body);
    if (!result.ok) throw new Error(`Plan reference could not be saved: ${result.error}`);
  }
  const written: string[] = [];
  for (const doc of docs) {
    try {
      await fs.writeFile(path.join(root, doc.path), doc.content, { encoding: 'utf8', flag: 'wx' });
      written.push(doc.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  return { planId: plan.id, written };
}
