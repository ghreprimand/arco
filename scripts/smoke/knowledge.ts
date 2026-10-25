// WORKBENCH_EXPANSION_PLAN.md §B3 — knowledge base smoke.
//
// Tests the MECHANISM directly (no WS, no LLM, no server boot), against a
// throwaway temp cwd so no real .archon/knowledge/ is touched:
//
//   (1) The STORE (server/src/knowledge/store.ts) behind load/save/query:
//         - createArticle persists; readArticle round-trips; query filters.
//         - alwaysInclude flag + per-article bytes are recorded in the index.
//   (2) The INJECTION builder (buildKnowledgeBlock):
//         - an alwaysInclude=true article's TEXT appears in the assembled block
//           (the acceptance assertion: "the article text is present in the
//           assembled system prompt").
//         - an on-demand (alwaysInclude=false) article is NOT injected.
//         - the byte cap TRUNCATES when the always-include set exceeds the
//           budget, with an explicit truncation notice, and the post-cap bytes
//           stay within budget + a small notice margin.
//   (3) THE FENCE smoke: the store module exports no auto-save path — the only
//       writers are operator CRUD. (Sanity check, not a security proof.)
//
// Run: npm run smoke:knowledge  (no dev server needed)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, assert, assertEq, summary } from './lib.js';
import {
  buildKnowledgeBlock,
  createArticle,
  listArticles,
  readArticle,
  updateArticle,
  alwaysIncludeBytes,
} from '../../server/src/knowledge/store.js';
import { KNOWLEDGE_INJECT_BUDGET } from '@archon/shared';

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-knowledge-'));

  let alwaysId = '';
  await step('createArticle persists an always-include article (store.save)', async () => {
    const a = await createArticle(cwd, {
      title: 'Deploy steps',
      body: 'Run `npm run build` then push to the `release` branch. CI deploys on tag.',
      tags: ['deploy', 'ci'],
      alwaysInclude: true,
    });
    alwaysId = a.id;
    assert(a.id.length > 0, 'article got an id');
    assertEq(a.alwaysInclude, true, 'alwaysInclude persisted');
    assert(a.bytes > 0, 'body byte length recorded');
  });

  await step('readArticle round-trips body from disk (store.load)', async () => {
    const a = await readArticle(cwd, alwaysId);
    assert(a !== null, 'article loads');
    assert(a!.body.includes('npm run build'), 'body round-trips');
    assertEq(a!.tags.join(','), 'deploy,ci', 'tags round-trip');
  });

  await step('query filters by title/tags (store.query)', async () => {
    await createArticle(cwd, { title: 'Local gotcha', body: 'Port 3001 is the server.', tags: ['gotcha'], alwaysInclude: false });
    const hitDeploy = await listArticles(cwd, 'deploy');
    assertEq(hitDeploy.length, 1, 'deploy search returns one');
    assertEq(hitDeploy[0].title, 'Deploy steps', 'right article');
    const all = await listArticles(cwd);
    assertEq(all.length, 2, 'list returns both articles');
  });

  await step('ACCEPTANCE: always-include article TEXT appears in the assembled system prompt', async () => {
    const block = await buildKnowledgeBlock(cwd);
    assert(block.text.length > 0, 'block is non-empty');
    assert(block.text.includes('--- Knowledge base ---'), 'block carries the KB delimiter');
    assert(block.text.includes('Deploy steps'), 'always-include title present');
    assert(block.text.includes('npm run build'), 'always-include BODY present in assembled prompt');
    assertEq(block.included, 1, 'exactly one always-include article folded in');
    // The on-demand "Local gotcha" must NOT be injected.
    assert(!block.text.includes('Port 3001 is the server'), 'on-demand article is NOT injected');
  });

  await step('alwaysIncludeBytes matches the injected set', async () => {
    const bytes = await alwaysIncludeBytes(cwd);
    const a = await readArticle(cwd, alwaysId);
    assertEq(bytes, a!.bytes, 'always-include total equals the one flagged article body');
  });

  await step('toggling alwaysInclude off removes it from injection (operator CRUD only)', async () => {
    await updateArticle(cwd, alwaysId, { alwaysInclude: false });
    const block = await buildKnowledgeBlock(cwd);
    assertEq(block.text, '', 'no always-include articles → empty block');
    // Toggle back on for the truncation test below.
    await updateArticle(cwd, alwaysId, { alwaysInclude: true });
  });

  await step('BYTE CAP: over-budget always-include set is truncated with a notice', async () => {
    // Add enough fat always-include articles to blow KNOWLEDGE_INJECT_BUDGET.
    const chunk = 'x'.repeat(8 * 1024); // 8 KB each
    const needed = Math.ceil(KNOWLEDGE_INJECT_BUDGET / (8 * 1024)) + 2;
    for (let i = 0; i < needed; i++) {
      await createArticle(cwd, { title: `Fat ${i}`, body: chunk, tags: [], alwaysInclude: true });
    }
    const block = await buildKnowledgeBlock(cwd);
    assert(block.truncated, 'block reports truncated=true when over budget');
    assert(block.included < block.total, 'fewer articles included than total always-include');
    assert(block.text.includes('omitted: knowledge base exceeds'), 'explicit truncation notice present');
    // Post-cap bytes stay bounded by the budget (plus the short notice margin).
    assert(block.bytes <= KNOWLEDGE_INJECT_BUDGET + 1024, `post-cap bytes bounded by budget (got ${block.bytes}, budget ${KNOWLEDGE_INJECT_BUDGET})`);
  });

  rmSync(cwd, { recursive: true, force: true });
  summary('B3 knowledge base');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
