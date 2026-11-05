// P8.5 The built-in Architecture review skill, in Arco's own words. Shipped
// read-only; the operator runs it from the SKILLS menu or makes an editable
// copy. Facts are added at run time by architectureReview.ts.

export const ARCHITECTURE_REVIEW_SLUG = 'architecture-review';

export const ARCHITECTURE_REVIEW_SKILL = {
  slug: ARCHITECTURE_REVIEW_SLUG,
  name: 'Architecture review',
  description: 'Find places where the code is harder to change than it needs to be, explain each candidate, and let the operator pick. No code changes.',
  operatorOnly: true,
  body: `# Architecture review

Purpose: find places in this project where a change is harder than it needs to be, explain each one plainly, and let the operator decide. You do not change any code or project file in this review.

## Words used here
- Module: a unit with one purpose (a file, a class, a folder of related files).
- Interface: everything a caller has to know to use a module: its exports, their arguments and results, the order calls must happen in, the errors it raises, the settings it reads.
- Implementation: what the module does behind its interface.
- Depth: how much behavior a module provides for each thing its interface asks a caller to learn. A deep module hides a lot behind a little.
- Seam: a place where two modules meet. Tests and stand-ins attach at seams.
- Adapter: a concrete thing that satisfies an interface at a seam, such as a fake clock or an in-memory store in tests.
- Locality: things that change together live together.
- Leverage: how much capability a caller gets per thing it has to learn.
- Deletion test: imagine deleting a module and inlining it into its callers. If complexity would pile up in many places, the module earns its keep. If it would only move to one place, the module is shallow.

## Steps
1. Read the facts Arco gathered below. They are measured, not guessed: largest source files, files changed most often, source files without a matching test, files with many exports, and decisions already recorded for this project. Do not suggest anything a recorded decision has ruled out, unless you name the decision and say what changed.
2. Explore the code around the hot spots. Read the files; do not judge from names or sizes alone. Look for: logic implemented twice; wrappers that only pass calls through; one change that needs edits in many files; modules whose interface is nearly as large as their implementation; tests that can only run through the whole application because no seam exists.
3. Apply the deletion test to each suspect.
4. Keep the candidates that would make the code easier to change, and drop the ones that only move code around. Three to seven candidates is a good number; fewer is fine.

## The report
Write two files to this conversation's artifacts folder, named with today's date:
- \`architecture-review-YYYY-MM-DD.md\`: the report the operator reads.
- \`architecture-review-YYYY-MM-DD.json\`: the same candidates as data, which Arco reads to offer ADD TO PLAN and RECORD DECISION.
Optionally also \`architecture-review-YYYY-MM-DD.html\`: one self-contained page with no external links, scripts, fonts or images.

For each candidate the Markdown report gives:
- a short title;
- the files involved;
- the problem, in plain words, with one concrete example from the code;
- the proposed change, in plain words (no code);
- what it would improve in locality, leverage and testing (where tests would attach);
- a strength: Strong, Worth exploring or Speculative.

End the report with your top recommendation and one sentence on why, then ask the operator which candidate to discuss. Stop there.

The JSON file has exactly this shape:
\`\`\`json
{
  "version": 1,
  "candidates": [
    {
      "id": "c1",
      "title": "Short title",
      "files": ["path/relative/to/project.ts"],
      "problem": "Plain description.",
      "proposal": "Plain description.",
      "benefits": { "locality": "...", "leverage": "...", "tests": "..." },
      "strength": "Strong"
    }
  ],
  "recommendation": "c1"
}
\`\`\`
\`strength\` is one of "Strong", "Worth exploring", "Speculative". Paths are relative to the project folder. Use ids c1, c2, ... in report order.

## After the operator picks
Discuss the picked candidate one question at a time. With each question, give the answer you recommend and why, so the operator can simply agree. When the open points are settled, tell the operator to use ADD TO PLAN on the report in OUTPUTS to turn it into a plan item, or RECORD DECISION to record why it is not pursued. Do not edit the plan or the code yourself in this review.`,
} as const;
