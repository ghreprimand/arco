// How plan reference docs reach a working agent. The plan is a lean checklist;
// the detail a task needs lives in refs at .archon/plans/<planId>.refs/<slug>.md,
// linked from the checklist as `[label](ref:slug)`. A ref only helps if the
// agent working the task actually opens it, so every surface that hands an
// agent plan work goes through here:
//
//   - per-turn plan prefix (turnEngine.buildPlanPrefix) and the cluster plan
//     fold — `refsDoctrine` names the refs and says when to read them;
//   - cluster_task_show — `resolveLinkedRefs` lists the refs a board task links,
//     with paths, so a claimed task arrives with its spec pointers;
//   - plan-scoped Review — `renderLinkedRefsForReview` inlines the refs the
//     in-scope items link, since a reviewer judging "built per ref:x" without
//     ref:x is guessing.
//
// Read-only: nothing here writes a ref or changes what a plan says.

import { listPlanRefs, readPlanRef, isValidRefSlug } from './planStore.js';

// `[label](ref:slug)`, `[[ref:slug]]`, or a bare `ref:slug` token. Bare form
// counts because agents and operators type it in prose ("see ref:api-shape").
// The lookbehind keeps it out of words and URL paths; it matches the client's
// REF_LINK_RE (client/src/components/plans/planRefs.ts) so what the operator
// sees as a ref chip is what the agent is told to read.
const REF_TOKEN_RE = /(?<![\w/:-])ref:([a-z0-9][a-z0-9-]{0,63})/g;

export function extractRefSlugs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(REF_TOKEN_RE)) {
    if (isValidRefSlug(m[1])) out.add(m[1]);
  }
  return [...out];
}

export function refsDirFor(planId: string): string {
  return `.archon/plans/${planId}.refs/`;
}

// One line, no newline — rides inside PLAN_PREFIX_RE's single-line bracket, so
// it must never contain `]` followed by a newline or a literal newline.
export function refsDoctrine(planId: string, slugs: string[], max = 12): string {
  if (slugs.length === 0) {
    return `Long-form detail (specs, research, designs) belongs in reference docs at ${refsDirFor(planId)}<slug>.md, linked from a task as [label](ref:slug) — not in the checklist.`;
  }
  const shown = slugs.slice(0, max).join(', ');
  const more = slugs.length > max ? `, +${slugs.length - max} more` : '';
  return (
    `Reference docs are part of this plan (${refsDirFor(planId)}<slug>.md): ${shown}${more}. ` +
    `A checklist line is the summary; the ref it links is the spec. Before starting a task that links ref:<slug> ` +
    `or names one of these docs, read that ref (plan_ref_read, or open the file) and follow it; if the work ` +
    `contradicts a ref, say so rather than silently diverging.`
  );
}

export interface LinkedRef {
  planId: string;
  slug: string;
  title?: string;
  path: string;
  bytes?: number;
  exists: boolean;
}

// Refs a piece of plan/board text links, resolved against each candidate plan.
// A slug found in no candidate plan still comes back (exists:false) so the
// agent learns the link is dangling instead of hunting for it.
export async function resolveLinkedRefs(cwd: string, planIds: string[], texts: string[]): Promise<LinkedRef[]> {
  const slugs = extractRefSlugs(texts.join('\n'));
  if (slugs.length === 0 || !cwd) return [];
  const uniquePlans = [...new Set(planIds.filter(Boolean))];
  const lists = await Promise.all(uniquePlans.map(async (id) => [id, await listPlanRefs(cwd, id).catch(() => [])] as const));
  return slugs.map((slug) => {
    for (const [planId, refs] of lists) {
      const hit = refs.find((r) => r.slug === slug);
      if (hit) return { planId, slug, title: hit.title, path: `${refsDirFor(planId)}${slug}.md`, bytes: hit.bytes, exists: true };
    }
    const planId = uniquePlans[0] ?? '';
    return { planId, slug, path: planId ? `${refsDirFor(planId)}${slug}.md` : `ref:${slug}`, exists: false };
  });
}

const REVIEW_REF_MAX_BYTES = 16 * 1024;
const REVIEW_REFS_TOTAL_BYTES = 48 * 1024;

// Markdown section appended to plan-scoped review content. Empty string when
// the in-scope items link nothing.
export async function renderLinkedRefsForReview(cwd: string, planId: string, scopedText: string): Promise<string> {
  const linked = await resolveLinkedRefs(cwd, [planId], [scopedText]);
  if (linked.length === 0) return '';
  const parts: string[] = [
    '### Reference docs linked from the items above',
    '',
    'These are the specs the plan items point at. Judge the items against them; a ref that is missing or was not followed is itself a finding.',
  ];
  let budget = REVIEW_REFS_TOTAL_BYTES;
  for (const r of linked) {
    parts.push('', `#### ref:${r.slug}${r.title && r.title !== r.slug ? ` — ${r.title}` : ''} (${r.path})`, '');
    if (!r.exists) { parts.push('_(linked but not written — this ref does not exist)_'); continue; }
    if (budget <= 0) { parts.push('_(not inlined — review budget spent; read the file)_'); continue; }
    const full = await readPlanRef(cwd, r.planId, r.slug).catch(() => null);
    if (!full) { parts.push('_(unreadable)_'); continue; }
    const cap = Math.min(REVIEW_REF_MAX_BYTES, budget);
    const buf = Buffer.from(full.body, 'utf8');
    const body = buf.length > cap ? `${buf.subarray(0, cap).toString('utf8')}\n\n_(truncated at ${cap} of ${buf.length} bytes — read the file for the rest)_` : full.body;
    budget -= Math.min(buf.length, cap);
    parts.push(body.trimEnd());
  }
  return parts.join('\n');
}

// ── Board task → originating plan item ──
//
// A board task is usually one plan checkbox, promoted from the PLAN tab (title
// = the item's own line) or written by a member. Either way the refs that
// matter often sit on the item's nested sub-bullets or on its phase's preamble
// ("> Designs: ref:x"), not on the title. Rather than tell every member to
// copy links into the tasks they create (prompt weight + an instruction they
// can skip), cluster_task_show finds the item the task came from and resolves
// that block's refs too. Deterministic text match; no match = title refs only.

interface PlanShape {
  phases: Array<{ preamble: string; tasks: Array<{ raw: string; parentLine: string }> }>;
}

// Ref links are dropped outright, labels included: plan lines end in
// "([spec](ref:x), [rules](ref:y))" and those label words would otherwise
// defeat a containment match against a board title that omits them.
function normalizeItemText(s: string): string {
  return s
    .replace(/^\s*-\s*\[[ xX]\]\s*/, '')
    // The leading item id is matched separately (itemId); left in, it would
    // block containment when only one side carries it.
    .replace(/^[A-Za-z]{1,3}\d+(?:\.\d+)*(?=[\s:.)-])/, ' ')
    .replace(/\[[^\]\n]+\]\(ref:[a-z0-9-]+\)/g, ' ')
    .replace(/\[\[ref:[a-z0-9-]+\]\]/g, ' ')
    .replace(/(?<![\w/:-])ref:[a-z0-9-]+/g, ' ')
    .replace(/\(\s*[,\s]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Minimum normalized length for a containment match — below this a short
// title ("tests") would latch onto whichever item mentions the word first.
const CONTAIN_MIN = 16;
// A leading item id ("P6.9", "T1", "B3", "P1.1") is how plans and the boards
// built from them name items, and it survives rewording ("P1.3 Conformance
// baseline" vs the plan's "P1.3 Record the conformance baseline"). Letter
// prefix required so a plain "1." list can't collide.
const ITEM_ID_RE = /^\s*(?:-\s*\[[ xX]\]\s*)?([A-Za-z]{1,3}\d+(?:\.\d+)*)(?=[\s:.)-])/;
const ID_SCORE = Number.MAX_SAFE_INTEGER - 1;
function itemId(s: string): string | null {
  return s.match(ITEM_ID_RE)?.[1]?.toUpperCase() ?? null;
}
const NESTED_CHECKBOX_RE = /^\s+-\s*\[[ xX]\]\s+\S/;

// The plan text a task should inherit refs from: the matched item's full block
// plus its phase preamble. Exact match wins, then a shared leading item id,
// then the longest containment either way (a member's title is often the item trimmed or
// extended). Null when nothing matches.
export function planItemContextFor(plan: PlanShape, taskTitle: string): string | null {
  const want = normalizeItemText(taskTitle);
  if (!want) return null;
  const wantId = itemId(taskTitle);
  let best: { text: string; score: number } | null = null;
  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      // Nested checkboxes (staged items: "- [ ] P2 …" with "  - [ ] T1 …"
      // beneath) are board tasks too; a match on one inherits the whole
      // parent block, which is where the stage's spec link usually sits.
      const nested = task.raw.split('\n').filter((l) => NESTED_CHECKBOX_RE.test(l));
      for (const line of [task.parentLine, ...nested]) {
        const have = normalizeItemText(line);
        if (!have) continue;
        let score = 0;
        if (have === want) score = Number.MAX_SAFE_INTEGER;
        else if (wantId && itemId(line) === wantId) score = ID_SCORE;
        else if (Math.min(have.length, want.length) >= CONTAIN_MIN && (have.includes(want) || want.includes(have))) {
          score = Math.min(have.length, want.length);
        }
        if (score > (best?.score ?? 0)) best = { text: `${phase.preamble}\n${task.raw}`, score };
      }
    }
  }
  return best?.text ?? null;
}
