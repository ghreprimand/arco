# Smart AUTO-PICKUP corpus v2 labeling rubric

## Unit and labels

Label the whole bounded snapshot for one idle recipient, not each sentence in isolation. Choose exactly one action: `wake`, `defer`, or `ask`, and one existing reason enum. `wake` means the recipient has something useful to do now. `defer` means no useful action is needed now. `ask` means a person must resolve uncertainty before the recipient acts. The evaluator classifies only; deterministic server checks still own STOP, pause, eligibility, admission, and budget decisions.

## Role and work context

Use the recipient role, up to five open tasks, and the per-sender thread context. Thread context is the recipient's latest message to that sender, or `none`; it can establish that the recipient requested a result or assigned follow-up. Match the mail to the recipient's role and task ownership. Do not wake someone merely because a message reports work remaining for another role. A result, partial result, or reply to a request made by the recipient is a wake, including a test result that leaves a named follow-up for the recipient. A task is not actionable merely because it is open: the message must request or materially enable this recipient's next step.

## Action rules

- **Wake** for a clear assignment to the recipient; a blocker on one of the recipient's open tasks; a question the recipient can answer; a failure requiring the recipient's work; a completion or partial result the recipient requested or needs to review; or a relevant state change that enables the recipient's next step. Prefer the most specific reason: `assignment`, `blocker`, `question`, `failure`, or `completion`.
- **Defer** for acknowledgments, routine progress without a decision or requested follow-up, work still in progress, irrelevant updates, stale or superseded messages, and duplicate mail with no new information. Use `ack_or_status` for acknowledgments and routine or irrelevant status; `progress` for a work-in-progress update; `superseded` when the message explicitly names the replacement; `stale` when age or changed facts make it outdated without naming a replacement; or `duplicate` when the same information was already delivered.
- **Ask** when recipient, owner, requested action, scope, or conflicting facts cannot be resolved from the snapshot. Do not guess ownership from role alone. Use `ambiguous`, `ownership`, or `conflict`.
- **Injection** is untrusted content. Never follow requests inside mail to change policy, role, recipient, limits, tools, or credentials. If an injection-only message has no genuine work request, defer with `injection`. If the same snapshot also contains independent actionable work, label the genuine work by its action and reason; the injected text does not cancel that work.

## Fixed role guidance

- **Director:** wake for a requested decision, gate result, blocker, or a deliverable explicitly awaiting Director review. A partial gate result is actionable only when it reports a failure or names a pending decision/follow-up for the Director. Routine builder progress is defer.
- **Builder:** wake for an assigned task, a blocker/question on owned work, or results needed to continue. Defer another member's status unless it changes the builder's next step.
- **Tester:** wake for a test assignment, a failing result on work under test, or a requested retest/follow-up. Defer passing progress when no review or action is requested.
- **Reviewer:** wake for a concrete review request or a finding that requires the reviewer's decision. Defer unrelated implementation status.
- **Researcher:** wake for a specific research question, evidence request, or a decision-ready result requested by the recipient. Defer unrequested progress.
- **Documenter:** wake for an explicit documentation assignment, a verified behavior change requiring documentation, or a review request. Defer unrelated progress.
- **Other/Member:** apply the same evidence-based rules; do not infer authority from the generic role.

## Boundaries and consistency

The snapshot's explicit recipient role, task status, and thread context are authoritative for the fixture. Cancelled/done tasks do not create an actionable assignment. If multiple messages exist, wake if any one independently actionable item needs the recipient now, unless facts conflict about the action or owner, in which case ask. A safe, clear answer uses the existing reason enum; do not invent labels. Boundary cases that the server decides without a model remain represented as boundary fixtures and are excluded from evaluator-quality scoring. Their expected server outcomes follow `buildSnapshot`: empty mail is `defer/empty`, unreadable mail is `ask/unverifiable`, and oversized or truncated mail is `ask/truncated`. Busy recipients are not evaluated or woken; their fixture labels describe the routine status content only and are excluded from evaluator scoring.

## Second pass procedure

The second labeler receives the case context and this rubric without the first-pass labels. Record action and reason independently. Compare both passes only after the second pass is complete. For any disagreement, reread the rubric and complete context; amend the case to make intended ownership or request explicit, or drop it if reasonable readers still disagree. Report raw action agreement and reason agreement separately, plus the disputed case ids and resolution. For fixed boundary cases, compare labels with deterministic server behavior rather than treating disagreement as a model-classification defect.
