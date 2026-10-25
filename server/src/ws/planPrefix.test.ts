// Regression tests for the 2026-07-28 plan-attach incident. Two failures came
// out of one root cause — the model was never told how attach works:
//   - a worker wrote markdown into its artifacts dir and reported "Plan
//     attached to the Arco workflow" (nothing was attached),
//   - another reverse-engineered `POST /api/plans` with curl + jq over several
//     turns, and produced a plan with no checkboxes, which `parsePlan` reads as
//     zero reviewable tasks.
//
// `planAuthoringNote` fixes both by stating the endpoint and the body contract.
// It rides the same prefix slot as the attached-plan one-liner, so it MUST stay
// strippable — Claude's session JSONL records prompts verbatim, and an
// unstripped prefix re-renders as a duplicate user bubble in chat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripPlanPrefix } from './turnEngine.js';

const USER = 'go ahead and create the plan and attach it to this arco workflow';

// Shape-identical to planAuthoringNote's output, including the literal `- [ ]`
// that the greedy `[^\n]*\]` has to survive.
const NOTE =
  "[No project plan is attached to this Arco workflow. If asked to create/attach one, do NOT just write a " +
  "markdown file — a loose file is invisible to Arco. Prefer the `plan_create` tool (MCP server `arco`) if you " +
  "have it — one call, title + body, creates and attaches. Otherwise write the body to a scratch file, then POST it (this " +
  "two-step avoids hand-escaping markdown into JSON): jq -n --rawfile body /tmp/plan.md --arg t 'Plan title' " +
  "'{title:$t,body:$body,workflowId:\"abc\",attach:true}' | curl -sS --fail-with-body -X POST " +
  "'http://127.0.0.1:3001/api/plans?path=%2Fhome%2Foperator%2FProjects%2Fsample' -H 'Content-Type: application/json' " +
  "-d @- — a success response echoes the created plan's id. To attach one that already exists: " +
  "POST /api/plans/attach?path=<cwd>&planId=<id>&workflowId=abc. The body's structure is parsed, not decorative: " +
  "one `### Phase name` heading per phase, and every task a top-level `- [ ] task` checkbox line (indent subtasks " +
  "under it). A plan without checkboxes parses to zero reviewable items. Don't create a plan unless asked.]\n\n";

test('authoring note is stripped from the chat-visible prompt', () => {
  assert.equal(stripPlanPrefix(NOTE + USER), USER);
});

test('the literal "- [ ]" inside the note does not end the match early', () => {
  // A non-greedy pattern would stop at the example checkbox and leave the tail
  // of the note in chat. Assert no fragment survives.
  const out = stripPlanPrefix(NOTE + USER);
  assert.ok(!out.includes('checkbox line'), 'note tail leaked into the message');
  assert.ok(!out.includes('parses to zero'), 'note tail leaked into the message');
});

test('attached-plan one-liner still strips', () => {
  const prefix = '[Active project plan: "Ship v2" — file: .arco/plans/abc.md. Tick off items.]\n\n';
  assert.equal(stripPlanPrefix(prefix + USER), USER);
});

test('legacy <plan> body form still strips', () => {
  const prefix = '[Active project plan: "Ship v2" — newly attached.]\n<plan>\nbody\n</plan>\n\n';
  assert.equal(stripPlanPrefix(prefix + USER), USER);
});

test('operator text that merely mentions brackets is untouched', () => {
  const typed = 'I need [ ] a plan — [Active project plan] is just something I typed';
  assert.equal(stripPlanPrefix(typed), typed);
});

test('a prefix-shaped line mid-message is untouched (anchored at start)', () => {
  const typed = `${USER}\n[No project plan is attached to this Arco workflow. blah]\n\n`;
  assert.equal(stripPlanPrefix(typed), typed);
});

test('prefixes carrying the refs hint and a [label](ref:slug) example still strip', () => {
  const attached = '[Active project plan: "Ship v2" — file: .arco/plans/abc.md. Reference docs (.arco/plans/abc.refs/<slug>.md, linked from the plan as ref:<slug>): api-spec, ui-notes — read one when a task links it. Tick off items.]\n\n';
  assert.equal(stripPlanPrefix(attached + USER), USER);
  const note = NOTE.replace(" Don't create a plan unless asked.]", " Keep it lean — put detail in reference docs linked from a task as `[label](ref:slug)`. Don't create a plan unless asked.]");
  assert.equal(stripPlanPrefix(note + USER), USER);
});
