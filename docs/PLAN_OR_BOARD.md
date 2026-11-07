# Plan or board?

A plan describes the goal, the work to do, and the rules the team should
follow. A cluster shares its attached plan with its members. Use PLAN to
review or attach it; a model-generated draft is not attached until approved.
Review drafting turns have no project tools. Ordinary Claude CLI hooks are
disabled for the draft; administrator-managed hooks can still run under
provider policy.

A board tracks individual tasks, who owns them, and what needs attention now.
Members can update tasks, while the operator accepts completed work. A plan
and a board can be used together: the plan holds the shared direction and the
board tracks the work in progress.

Moving a plan detaches its source workflows only after the move succeeds. A refused move, including choosing the same project again or an existing destination plan, keeps those attachments.

The composer's PLAN button explains in its hover text that a plan keeps the next
steps in one place.
A cluster without a plan offers DRAFT A PLAN, ATTACH EXISTING, and NOT NOW;
NOT NOW is remembered for that cluster in the browser. In the compact hint, DRAFT A PLAN first opens the public-project choice.

For a project that is public, or will be, tick **This project is public (or
will be)** beside the draft choices and plan editors. The choice is saved per project and can be changed there. The draft then asks for a "Privacy and public safety" section. Agent-created plans use the saved choice; a missing section is flagged for review. Genesis includes the section in its new plan when selected. For a plan that already exists, **INSERT GUARDRAILS**
adds the same section as an unsaved edit. A quiet notice offers **RESTORE IGNORE
FILE**, **STOP TRACKING** and **DISMISS** when Git tracks or does not ignore the
project's `.arco` folder. Files of a skill shared with SHARE WITH REPOSITORY do
not count, STOP TRACKING leaves them tracked, and RESTORE IGNORE FILE keeps the
share lines. See the manual section "Working on a public project".

For setup, see [Create a first cluster](GETTING_STARTED.md#create-a-first-cluster).
For board controls, see [Task ledger](TASK_LEDGER.md).
