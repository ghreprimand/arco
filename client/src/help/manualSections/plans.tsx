import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Pre, Note, Sub } from '../../components/UserManual/components';
export const plans: Section[] = [
  {
    id: 'plans-overview',
    group: 'Plans & artifacts',
    title: 'Plans - per-cwd checklists',
    body: (
      <>
        <p>
          A plan is a checklist that keeps a workflow or cluster oriented on what
          remains to do. Use one when work spans several turns or several workers.
          Long-form detail belongs in the plan's <strong>reference docs</strong>,
          not the checklist (see Plan reference docs).
        </p>
        <Sub>What a plan is</Sub>
        <p>
          A <strong>plan</strong> is an itemized markdown checklist pinned to a
          workflow or cluster. Plans live at{' '}
          <Code>&lt;cwd&gt;/.arco/plans/&lt;id&gt;.md</Code>. One folder can host
          many plans, and the same plan can be attached to several workflows at
          once.
        </p>
        <Sub>What the agent sees</Sub>
        <p>
          A one-line header naming the plan is added invisibly to every primary
          turn so the agent stays oriented. The full body is not injected; the
          agent reads the file on demand, which saves per-turn bandwidth. The
          header looks like this:
        </p>
        <Pre>{`[Active project plan: "<title>" - file: .arco/plans/<id>.md. <living-doc note>]
<your message>`}</Pre>
        <p>
          The header names the plan title and file path and tells the agent to keep
          the checklist current (tick <Code>- [ ]</Code> to <Code>- [x]</Code>)
          without adding new sections on its own. On first attach it says "newly
          attached - read the brief...", and after an operator edit it says "edited
          since last turn - re-read...". Edits the agent makes to the file refresh
          the panel live.
        </p>
      </>
    ),
  },
  {
    id: 'plan-review',
    group: 'Plans & artifacts',
    title: 'Plan-scoped review (REVIEW vs VERIFY, whole plan / section / custom)',
    body: (
      <>
        <p>
          Plan-scoped review audits the plan itself instead of the workflow
          transcript. When a plan is attached, the Plan tab sends reviewers the plan
          body as the subject.
        </p>
        <Sub>REVIEW and VERIFY</Sub>
        <p>
          REVIEW and VERIFY are paired buttons at both whole-plan and per-section
          level.
        </p>
        <ul>
          <li>
            <strong>CRITIQUE</strong> (REVIEW) - the reviewer evaluates the plan
            itself for gaps, ordering and missing considerations. All items show
            with check state preserved, and it always proceeds, even on plans
            without sections.
          </li>
          <li>
            <strong>VERIFY</strong> - the reviewer cross-checks claimed-completed
            work against the actual code, using tools instead of taking checkboxes
            at face value. Whole-plan and phase scopes show only <Code>[x]</Code>{' '}
            items. A section with no checked items but a completion-claim preamble
            (for example "Completed: we did X, Y, Z") still renders, because the
            prose is the claim.
          </li>
        </ul>
        <Sub>The buttons</Sub>
        <ul>
          <li><Code>REVIEW PLAN</Code> (top of tab) - the whole plan, defaulting to CRITIQUE.</li>
          <li><Code>VERIFY WORK</Code> (next to REVIEW PLAN) - the whole plan, defaulting to VERIFY with <Code>INCLUDE GIT DIFF</Code> pre-ticked, so claimed-done items are audited against the changes.</li>
          <li><Code>▷ REVIEW PHASE PLAN</Code> (pill under each <Code>### Phase</Code> heading) - that one section, CRITIQUE by default.</li>
          <li><Code>▷ VERIFY PHASE WORK</Code> (next pill under the heading) - that one section, VERIFY by default with git diff pre-ticked.</li>
          <li><Code>CUSTOM REVIEW</Code> - a tree of checkboxes where items can be picked across plan sections (per-section tri-state, with SELECT ALL / ALL CHECKED / CLEAR shortcuts).</li>
        </ul>
        <p>
          In every case the dialog's MODE row stays editable, so VERIFY and CRITIQUE
          can be flipped before running. INCLUDE GIT DIFF works the same way: the
          VERIFY buttons only preset it. SCOPE is locked to the plan reference, for
          example <Code>PLAN PHASE: 3. Categories + auto-assignment</Code>.
        </p>
        <p>
          For <Code>CUSTOM REVIEW</Code> your selection is authoritative. Mode
          affects framing only, and items render regardless of check state. If the
          plan is edited between picking and submitting, the request is rejected
          with the missing items named so they can be re-picked.
        </p>
        <Note kind="tip">
          The plan parser tolerates plans whose checkboxes were stripped: bare
          numbered bullets such as <Code>- **1.2** Task name</Code> are recognized as
          tasks too. So even if an agent rewrites a plan as prose with numbered
          items, the review surfaces still work.
        </Note>
      </>
    ),
  },
  {
    id: 'plan-creation',
    group: 'Plans & artifacts',
    title: 'Drafting & attaching a plan',
    body: (
      <>
        <p>
          Draft and attach a plan from the composer, the PLAN tab, or by asking the
          agent. The composer's PLAN button explains in its hover text that a plan
          keeps the next steps in one place; no hint line is shown in the composer.
        </p>
  <p>Plan title and body fields wait while CREATE &amp; ATTACH or SAVE is pending. Switching to another plan does not apply an earlier save result to the new view.</p>
        <Sub>From the composer</Sub>
        <p>
          The <Code>PLAN</Code> button in the composer opens a modal with two paths:
        </p>
        <ul>
          <li>
            <strong>DRAFT → I'LL REVIEW.</strong> The agent's next reply is its
            draft of the plan. A banner offers <Code>SAVE &amp; ATTACH</Code>{' '}
            (<Code>ATTACH TO CLUSTER</Code> in a cluster), <Code>REFINE</Code>{' '}
            and <Code>DISCARD</Code> on that reply, so you can read it first, ask
            for changes and commit only if happy. The drafting
            turn has no project tools. Ordinary Claude CLI hooks are disabled,
            although administrator-managed hooks can still run.
          </li>
          <li>
            <strong>DRAFT &amp; AUTO-SAVE.</strong> Saves the agent's reply as the
            plan automatically. It is faster but less inspection-friendly. For a
            cluster member it works like DRAFT → I'LL REVIEW, so nothing attaches
            to the cluster without a click.
          </li>
        </ul>
        <p>Both paths ask the agent to synthesize the conversation into this shape:</p>
        <Pre>{`# Title
- **Goal**
- **Current state**
- **Open questions / blockers**
- **Next steps** - as a markdown checklist (- [ ] item)`}</Pre>
        <Sub>From the PLAN tab</Sub>
        <p>
          The PLAN tab lists plans in this folder. Each row shows its age and
          task count, with <Code>PREVIEW</Code> and <Code>ATTACH</Code> buttons.
          Completed plans are under <Code>Show finished</Code>. The same chooser
          is used for cluster plans and the cluster creator.
        </p>
        <p>
          <Code>DRAFT IN GENESIS</Code> opens Genesis for this folder. Saving or
          closing it returns to the original PLAN tab. A saved plan is offered
          for attachment; it is not attached until <Code>ATTACH</Code> is clicked.
        </p>
        <Sub>Asking the agent directly</Sub>
        <p>
          Saying "create a plan and attach it to this workflow" also works. Every
          turn with no plan attached carries a short note telling the agent how.
        </p>
        <ul>
          <li>On Codex and CLI Claude tabs, and on Cursor cluster members, a real tool does it: <Code>plan_create</Code> takes a title and body, creates the plan and attaches it in one call. It rejects a body with no sections or checkboxes and says why, so a malformed plan is caught as it is written.</li>
          <li>Elsewhere, the note gives the equivalent API call and the body shape Arco actually parses.</li>
          <li>Claude Native tabs use their <Code>EnterPlanMode</Code> tool, which attaches for real.</li>
        </ul>
        <p>
          A plan only exists once it is registered in the project's plan index, so a
          markdown file written somewhere else is invisible to Arco. The PLAN button
          remains the most reliable route on any provider.
        </p>
        <Sub>Structure is load-bearing</Sub>
        <p>
          A plan body is not free-form markdown. Plan sections come from{' '}
          <Code>### Heading</Code> lines, and a task counts only if it is a{' '}
          <em>top-level</em> <Code>- [ ] task</Code> checkbox (indent subtasks
          beneath it).
        </p>
        <p>
          A plan written without checkboxes reads fine to a human but parses to{' '}
          <em>zero</em> tasks, so per-section Review and the review item picker have
          nothing to offer. If a generated plan looks right but Review comes up
          empty, this is why.
        </p>
      </>
    ),
  },
  {
    id: 'public-project',
    group: 'Plans & artifacts',
    title: 'Working on a public project',
    body: (
      <>
        <p>
          A project that is public, or will be, needs rules about what never reaches the
          repository. Arco helps in four places. Nothing changes until you click, and
          every notice can be dismissed.
        </p>
        <Sub>The public-project box</Sub>
        <p>
          <Code>This project is public (or will be)</Code> sits beside the plan-draft
          choices and plan editors: in the cluster creator, next to DRAFT A PLAN, in
          the PLAN dialog and editor, the draft review banner, Genesis, and
          ARTIFACTS &gt; PLANS. When ticked, the draft asks for a "Privacy and public
          safety" section fitted to the project. Unticked, the request is unchanged.
        </p>
        <p>
          The choice is saved per project and can be changed at these controls.
          Agent-created plans use it; a public plan missing the section offers
          INSERT GUARDRAILS for review. Genesis includes the section in its new plan
          when selected.
        </p>
        <p>
          Arco suggests the box from the folder's Git remote. If the remote is on
          GitHub, GitLab, Bitbucket or Codeberg, a hint names the host. For GitHub
          only, Arco asks once a day whether the repository is public. The request
          is anonymous and carries only the owner and repository names. A confirmed public repository
          pre-ticks the box and says why. Your own choice always wins.
        </p>
        <Sub>Add the rules to an existing plan</Sub>
        <p>
          <Code>INSERT GUARDRAILS</Code> in the plan view puts the same section before
          the first phase as an unsaved edit. Read it, change it, then save. The
          button is disabled with "Already in this plan" when the section exists.
          It never saves by itself.
        </p>
        <Sub>Keeping Arco's own state out of Git</Sub>
        <p>
          Arco keeps its state for a project in a <Code>.arco</Code> folder that
          it asks Git to ignore. When Git tracks files in it, or the ignore file is
          missing or edited so the folder is no longer ignored, a quiet notice appears
          once per project. Files of a skill shared with SHARE WITH REPOSITORY
          do not count.
        </p>
        <ul>
          <li><Code>RESTORE IGNORE FILE</Code> writes the default ignore file and keeps the lines of skills shared with SHARE WITH REPOSITORY. An edited file is first kept as a backup beside it.</li>
          <li><Code>STOP TRACKING</Code> removes the folder from Git's index, except shared skills, and keeps the files on disk. A commit is still needed. Anything already pushed stays in the remote's history, so rotate any secret that was in it.</li>
          <li><Code>DISMISS</Code> hides the notice for that project.</li>
        </ul>
        <p>
          The two buttons change only projects in the PROJECTS list. They refuse,
          with a message, when <Code>.arco</Code> or <Code>.arco/.gitignore</Code>{' '}
          is a link, so nothing outside the project's own state folder changes.
        </p>
      </>
    ),
  },
  {
    id: 'plan-checklists',
    group: 'Plans & artifacts',
    title: 'Clickable checklists',
    body: (
      <>
        <p>
          Checklist items in the panel are clickable, and the panel and the file on
          disk stay in sync both ways. A <Code>- [ ] item</Code> line renders as a
          hollow box. Clicking it flips it to <Code>[x]</Code>, strikes the text
          through and dims it, and updates the file.
        </p>
  <p>Checkbox saves compare the displayed plan with the current saved body. If another edit arrived first, it is preserved and a conflict asks for a fresh review before retrying.</p>
        <ul>
          <li>When the agent flips a box, the panel updates live.</li>
          <li>When you flip a box in the panel, the agent sees it on the next turn. The header flags that the plan was edited, prompting the agent to re-read the file.</li>
        </ul>
        <Sub>Promoting an item to a board task</Sub>
        <p>
          In a <strong>cluster Plan tab</strong> with a task board attached, each
          unchecked <Code>- [ ]</Code> item also shows a <Code>→ TASK</Code> pill.
          Click it to copy that item's text into a durable board task on the board
          you see. The plan item stays in place.
        </p>
        <p>
          The pill appears only when a board is attached (it is hidden when the
          board mode is none) and never on already-checked items.
        </p>
        <Sub>Completing and deleting</Sub>
        <p>From the detail view (or per row in the list):</p>
        <ul>
          <li><strong>Mark complete</strong> - archives the plan and detaches it from any attached workflows.</li>
          <li><strong>Delete</strong> - permanent, with a confirm. It removes the file from disk.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'architecture-review',
    group: 'Plans & artifacts',
    title: 'Architecture review',
    body: (
      <>
        <p>
          The Architecture review is a built-in skill that finds places where the
          code is harder to change than it needs to be. Run it from the composer:{' '}
          <Code>SKILLS</Code>, then <Code>RUN</Code> under BUILT-IN. It is
          operator-only: the agent is never told it exists and cannot start it.
        </p>
  <p>ADD TO PLAN preserves intervening edits and reserves a new reference name. Concurrent RECORD DECISION actions append without replacing each other. Members match task text against the current plan when ticking it.</p>
        <p>
          Before the agent starts, Arco measures the project without a model: the
          largest source files, the files changed most often in the last 180 days
          (Git projects), source files that no test covers by name or by
          import, files with the most exported names, and the decisions already
          recorded. The agent
          reads these facts, explores the code and changes nothing.
        </p>
        <p>
          The agent writes <Code>architecture-review-DATE.md</Code> and a matching{' '}
          <Code>.json</Code> file to the conversation's artifacts. Each candidate
          names its files, the problem, the proposed change, what it would improve
          and a strength: Strong, Worth exploring or Speculative. The report ends
          with a recommendation and a question; discuss the candidate you pick in
          the chat.
        </p>
        <p>
          In OUTPUTS, <Code>CANDIDATES</Code> on the report lists them.{' '}
          <Code>ADD TO PLAN</Code> adds one to the attached plan as an unticked
          item with its own reference doc. <Code>RECORD DECISION</Code> stores why
          a candidate is not pursued in the plan's <Code>decisions</Code> doc,
          which later reviews read. Both need a plan attached to the tab or its
          cluster, and both ask first.
        </p>
        <p>
          <Code>EDITABLE COPY</Code> saves the skill's text as your own
          operator-only skill to adapt. Code reviews and the director also check
          the shape of a change: a second copy of existing logic, a wrapper that
          only passes calls through, tests that miss the module's interface, or
          one change spread over many files. Those findings are advisory.
        </p>
      </>
    ),
  },
  {
    id: 'plan-refs',
    group: 'Plans & artifacts',
    title: 'Plan reference docs',
    body: (
      <>
        <p>
          Reference docs hold the long-form detail a checklist should not: specs,
          research, design notes and API contracts that a task depends on. They are
          attached to a plan and stored at{' '}
          <Code>&lt;cwd&gt;/.arco/plans/&lt;id&gt;.refs/&lt;slug&gt;.md</Code>.
        </p>
  <p>Reference lists follow the selected plan. Opening a link fetches its saved body before offering creation. Creating a reference refuses an existing document. Fields and Cancel wait while a save is pending.</p>
        <Sub>Linking and managing refs</Sub>
        <p>
          A task links a ref as <Code>[label](ref:slug)</Code>,{' '}
          <Code>[[ref:slug]]</Code> or a bare <Code>ref:slug</Code> in prose. The
          PLAN tab renders the link as a chip that opens the doc. A link to a ref
          nobody has written yet shows dashed and dim; click it to create the doc.
        </p>
        <p>
          A <Code>REFS</Code> chip strip above the plan body and the{' '}
          <Code>REFERENCE DOCS</Code> section under it list the docs. They appear in
          the workflow PLAN tab, the cluster PLAN sub-tab and the ALL PLANS library.
          Click any doc to read it in a viewer. <Code>+ REF</Code> adds one, and the
          viewer has EDIT and delete.
        </p>
        <p>
          A doc's first <Code># H1</Code> is its title. The limits are 256 KB per
          doc and 64 docs per plan.
        </p>
        <Sub>How agents use refs</Sub>
        <p>
          Agents create refs with the <Code>plan_ref_write</Code>,{' '}
          <Code>plan_ref_list</Code> and <Code>plan_ref_read</Code> tools, or by
          writing the file directly. An agent asked to write a plan is told that a
          plan has two parts, the checklist and its refs, and to link each ref from
          the tasks that depend on it. <Code>plan_create</Code> returns a warning
          when a body runs long or a task carries paragraphs of prose.
        </p>
        <p>
          The per-turn plan header names the plan's refs and tells the agent to read
          the ref a task links before starting it, treating the ref as the spec. For
          cluster members, a trailing line in the folded plan does the same.{' '}
          <Code>cluster_plan_read</Code> returns the ref list.
        </p>
        <p>
          On the cluster board, <Code>cluster_task_show</Code> resolves every{' '}
          <Code>ref:</Code> link in the task's title, notes or comments into
          reference docs (paths, titles, missing flags). It also adds the refs on the
          plan item the task came from, meaning its sub-bullets and its section's
          intro, matched by the task title. Dispatched tasks are told to read them
          first, and the task drawer shows them as chips.
        </p>
        <p>
          A plan-scoped <strong>Review</strong> inlines the refs that the in-scope
          items link (16 KB each, 48 KB total), so the reviewer judges the work
          against the spec.
        </p>
        <Note>
          Moving a plan to another project carries its refs; deleting a plan deletes
          them.
        </Note>
      </>
    ),
  },
  {
    id: 'storage-view',
    group: 'Plans & artifacts',
    title: 'STORAGE - where disk space goes',
    body: (
      <>
        <p>
          The <strong>STORAGE</strong> lens in the ARTIFACTS window lists every project
          Arco knows about and Arco's own folder, largest first. Each row shows its
          headings, such as conversation logs, artifacts, worktrees and caches, and its
          biggest item. Sizes are read-only; <strong>MEASURE AGAIN</strong> refreshes them.
        </p>
  <p>ARCHIVE checks activity and file contents again before removal. A reopened conversation, queued event, metadata write or changed captured file cancels removal and leaves the live conversation intact.</p>
        <p>
          Open a project to list its conversations and archives. Every action asks for
          a confirmation first, and kept items always stay:
        </p>
        <ul>
          <li><strong>KEEP</strong> protects the whole conversation from archive and deletion. <strong>UNKEEP</strong> removes every KEEP mark of the conversation again; no file is changed.</li>
          <li><strong>ARCHIVE</strong> packs a closed conversation into one compressed file; <strong>RESTORE</strong> brings it back without overwriting anything.</li>
          <li><strong>DELETE</strong> removes a closed conversation or an archive for good.</li>
          <li><strong>EMPTY SCRATCH</strong> deletes the scratch folder where agents put large temporary files.</li>
          <li><strong>COMPRESS OLD LOGS</strong> seals the logs of a project's closed conversations; nothing is deleted.</li>
        </ul>
        <p>
          Worktrees, caches and Arco's own folder are shown for information only.
          Plans are never touched. STORAGE SETTINGS holds the disk budget notice
          (100 GiB by default) and auto-archive, which is off by default and never deletes.
        </p>
      </>
    ),
  },
  {
    id: 'plans-library',
    group: 'Plans & artifacts',
    title: 'ALL PLANS - the plans library',
    body: (
      <>
        <p>
          The plans library lists every plan across projects. It is the <strong>PLANS</strong> lens
          in the ARTIFACTS window, which lists every plan in every project Arco
          knows about. Open it from <Code>PLANS</Code> in the header KNOWLEDGE menu or the{' '}
          <Code>ALL PLANS</Code> button in a PLAN tab.
        </p>
        <p>
          When opened from a tab or
          cluster, <Code>ATTACH TO</Code> attaches a plan from that same project.
          Plans from another project cannot be attached to that target.
        </p>
  <p>Moving a plan detaches its source workflows only after success. Choosing the same project or an existing destination plan leaves those attachments unchanged.</p>
        <p>
          Filter by ACTIVE, COMPLETED or ALL, and search by title or project. The dot
          on each row shows its state:
        </p>
        <ul>
          <li><Code>●</Code> attached (a workflow or cluster uses it)</li>
          <li><Code>○</Code> not attached</li>
          <li><Code>✓</Code> completed</li>
          <li><Code>⧉N</Code> is the ref count</li>
        </ul>
        <p>
          Projects collapse to a single line, with the current project open. The
          browser remembers each choice; search opens matching groups. Counts show
          plans, those in use, and those probably finished for the current filter.
        </p>
        <p>
          Probably finished holds unattached plans with every box checked or no
          edits for 30 days. MARK DONE moves a plan to COMPLETED. Repeated titles
          appear once; expand them to see each version and its date. In use names
          the tabs or clusters using a plan. A group with an attached version stays in
          the normal list; its unattached versions offer MARK DONE. Nothing is
          marked done automatically.
        </p>
        <p>
          Selecting a plan shows its body (checkboxes are clickable), reference docs
          and attachment history, with EDIT, DONE / REOPEN and delete. Edits behave
          as they do in the PLAN tab, so any attached tab refreshes as usual.
        </p>
      </>
    ),
  },
  {
    id: 'artifacts',
    group: 'Plans & artifacts',
    title: 'Review & handoff artifacts',
    body: (
      <>
        <p>
          Review and handoff write durable markdown artifacts beside the workflow, so
          their results outlive the session.
        </p>
        <ul>
          <li>
            <strong>Review artifact</strong> - <Code>artifacts/review-&lt;ts&gt;.md</Code>.
            YAML frontmatter (verdict, reviewer, primary, contextRef) plus the body.
            It appears in the REVIEW tab.
          </li>
          <li>
            <strong>Handoff artifact</strong> - <Code>handoffs/handoff-&lt;ts&gt;.md</Code>.
            A plain markdown body that seeds the next session in the rotated tab.
          </li>
        </ul>
        <Sub>Inline artifacts</Sub>
        <p>
          Inline artifacts are a third kind: fenced <Code>```arco-artifact</Code>{' '}
          blocks that the agent emits during chat. They render as pills you can
          expand in place and are saved with the conversation. Agents use them for
          focused outputs, such as a generated config or a snippet to commit, that
          they want to call out.
        </p>
      </>
    ),
  },
];
