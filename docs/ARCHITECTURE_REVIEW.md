# Architecture review

The Architecture review is a skill shipped with Arco. It finds places where a project's code is harder to change than it needs to be, explains each one, and leaves the decision to the operator. It is operator-only: it is not in the agent's skill list, and only the operator can start it.

## Running it

In the composer, open **SKILLS**. Under **BUILT-IN**, **RUN** sends one message ("Run the Architecture review on this project.") with the skill attached, the same way **APPLY ONCE** attaches a skill. In a cluster tab the message goes to the member in view. **EDITABLE COPY** saves the skill text as an ordinary operator-only skill named "Architecture review (copy)", in the project's skills or, for a tab without a folder, the global skills.

## Facts gathered by Arco

When the turn starts, Arco measures the project without a model and adds the result to the skill text (`server/src/architectureReview.ts`):

- the 15 largest source files by line count;
- in a Git project, the 15 source files changed in the most commits in the last 180 days;
- the number of source files without a matching test file, and the 20 largest of them (`report.ts` is matched by `report.test.ts`, `report.spec.ts`, `test_report.py` or `report_test.go`);
- the 15 files with the most exported names;
- the attached plan's `decisions` reference doc, if there is one.

Files come from `git ls-files` (tracked and untracked, not ignored) or, outside Git, from a walk of the folder. Dependency, build and state folders (`node_modules`, `dist`, `.arco` and similar) are left out. Bounds: 20,000 files, 2 MB per file, 256 MB read in total. The skill text also names the conversation's artifacts folder.

## The report

The agent explores the code, applies the deletion test (would removing a module concentrate complexity or only move it), and writes two files to the artifacts folder:

- `architecture-review-YYYY-MM-DD.md`, the report: per candidate the files, the problem, the proposed change, what it improves in locality, leverage and testing, and a strength (Strong, Worth exploring, Speculative), then a recommendation and a question to the operator;
- `architecture-review-YYYY-MM-DD.json`, the same candidates as data: `{ version: 1, candidates: [{ id, title, files, problem, proposal, benefits: { locality, leverage, tests }, strength }], recommendation }`.

An optional HTML page must be self-contained, with no external resources. The review changes no code and no plan. The operator picks a candidate to discuss; the agent asks one question at a time and offers its recommended answer.

## ADD TO PLAN and RECORD DECISION

In OUTPUTS, the report has **CANDIDATES**, which lists the candidates from the `.json` file. Both actions write to the plan attached to the conversation's tab, or to its cluster's plan, and ask first.

- **ADD TO PLAN** writes a reference doc `arch-<title>` with the candidate and adds `- [ ] <title> [Architecture](ref:arch-<title>)` as the last item under `### Architecture review` in the plan (the heading is added at the end when missing). A board task follows from the plan item the usual way.
- **RECORD DECISION** asks for the reason and appends a "Not pursued" entry with the date, files and reason to the plan's `decisions` reference doc. The next review's facts include that doc, and the skill tells the agent not to suggest those candidates again unless it names the decision and what changed.

Without an attached plan both actions are refused with a message.

## Review checklist

Code reviews (the REVIEW action) and the cluster director contract include a short advisory checklist on the shape of a change: a second implementation of logic that already exists, a wrapper that only passes calls through, tests that miss the module's interface, and one behavior change that needs edits in many places. Findings follow the existing blocking rules.

## HTTP

`POST /api/architecture-review/candidates`, `/add-to-plan` and `/record-decision` take `path` (a registered project), `workflowId` and `report` (the artifact path of the `.md` report); the last two also take `candidateId` and `confirm: true`, and `/record-decision` takes `reason`. `POST /api/skills/copy-builtin?cwd=` with `{ scope, slug }` makes the editable copy. See [HTTP API](HTTP_API.md).
