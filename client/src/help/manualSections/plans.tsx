import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Pre, Note } from '../../components/UserManual/components';

export const plans: Section[] = [
  {
    id: 'plans-overview',
    group: 'Plans & artifacts',
    title: 'Plans — per-cwd checklists',
    body: (
      <>
        <p>
          A <strong>plan</strong> is an itemized markdown checklist of things to
          complete that pins to a workflow (or cluster) so the agent stays
          oriented. Long-form detail belongs in the plan's{' '}
          <strong>reference docs</strong>, not the checklist (see below). Plans live at <Code>&lt;cwd&gt;/.arco/plans/&lt;id&gt;.md</Code>;
          one cwd can host many, and the same plan can be attached to multiple
          workflows simultaneously.
        </p>
        <p>A one-line header naming the plan is prepended to every primary turn invisibly so the agent stays oriented — the full body is <em>not</em> injected (that was earlier behavior; it now reads the file on demand to save per-turn bandwidth). The stable-form header the agent sees:</p>
        <Pre>{`[Active project plan: "<title>" — file: .arco/plans/<id>.md. <living-doc note>]

<your message>`}</Pre>
        <p>The header names the plan title + file path and tells the agent to keep the checklist current (tick <Code>- [ ]</Code> → <Code>- [x]</Code>) without adding new sections on its own. On first attach it instead says "newly attached — read the brief…"; after an operator edit it says "edited since last turn — re-read…". An fs watcher catches agent-driven <Code>.md</Code> edits and refreshes the panel live.</p>
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
          When a plan is attached, the Plan tab dispatches reviewers with the{' '}
          <em>plan body itself</em> as the subject (instead of workflow transcript).
          REVIEW and VERIFY are paired buttons at both whole-plan and per-section
          granularity — REVIEW critiques the plan structure, VERIFY audits the
          claimed-done work against the actual changes.
        </p>
        <ul>
          <li>
            <Code>REVIEW PLAN</Code> (top of tab) — whole plan, defaults to{' '}
            <strong>CRITIQUE</strong> mode (audit the plan itself).
          </li>
          <li>
            <Code>VERIFY WORK</Code> (next to REVIEW PLAN) — whole plan, defaults to{' '}
            <strong>VERIFY</strong> mode with <Code>INCLUDE GIT DIFF</Code>{' '}
            pre-ticked (audit the claimed-done items against the changes).
          </li>
          <li>
            <Code>▷ REVIEW PHASE PLAN</Code> pill (under each <Code>### Phase</Code>{' '}
            heading) — that one section, CRITIQUE default.
          </li>
          <li>
            <Code>▷ VERIFY PHASE WORK</Code> pill (next pill under the heading) —
            that one section, VERIFY default with git diff pre-ticked.
          </li>
          <li>
            <Code>CUSTOM REVIEW</Code> — tree-with-checkboxes modal where you can
            pick items across plan sections (per-section tri-state, SELECT ALL / ALL CHECKED /
            CLEAR shortcuts).
          </li>
        </ul>
        <p>
          In every case the dialog's MODE row stays editable so you can flip between
          VERIFY and CRITIQUE before running. Same for INCLUDE GIT DIFF — VERIFY
          buttons just preset it on. SCOPE is locked to the plan reference (e.g.{' '}
          <Code>PLAN PHASE: 3. Categories + auto-assignment</Code>).
        </p>
        <ul>
          <li>
            <strong>VERIFY</strong> — reviewer cross-checks claimed-completed work
            against the actual code. Items shown filtered to <Code>[x]</Code> only
            (for whole/phase scopes). Reviewer is told to use tools to verify, not
            take checkboxes at face value. Plan sections with no checked items but a
            completion-claim preamble (e.g. "Completed: we did X, Y, Z")
            still render — the prose is the claim.
          </li>
          <li>
            <strong>CRITIQUE</strong> — reviewer evaluates the plan itself (gaps,
            ordering, missing considerations). All items shown with check state
            preserved. Always proceeds even on plans without sections.
          </li>
        </ul>
        <p>
          For <Code>CUSTOM REVIEW</Code> the operator's selection is authoritative —
          mode affects framing only and items render regardless of check state. If
          you edit the plan between picking and submitting, unresolvable items
          trigger a reject naming the missing items so you can re-pick.
        </p>
        <Note kind="tip">
          The plan parser tolerates checkbox-stripped plans: bare numbered bullets
          like <Code>- **1.2** Task name</Code> are recognized as tasks too. So even
          if an agent rewrites a plan as prose with numbered items (it happens), the
          review surfaces still work.
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
          The <Code>PLAN</Code> button in the composer opens a modal with two paths:
        </p>
        <ul>
          <li>
            <strong>Draft → I'll review</strong> — the agent's next reply is its draft
            of the plan. A banner offers <Code>SAVE &amp; ATTACH</Code> on that reply
            so you can read first and commit only if happy.
          </li>
          <li>
            <strong>Draft &amp; auto-save</strong> — saves the agent's reply as the
            plan automatically. Faster but less inspection-friendly.
          </li>
        </ul>
        <p>Both paths inject a synthesize-from-conversation prompt asking the agent for:</p>
        <Pre>{`# Title
- **Goal**
- **Current state**
- **Open questions / blockers**
- **Next steps** — as a markdown checklist (- [ ] item)`}</Pre>
        <p>
          The PLAN tab in the right panel lists every plan in this cwd ("active in{' '}
          &lt;workflow&gt; + 1 other · 3 past"). Active plans are inline; completed
          plans hide behind a <Code>▶ N completed</Code> toggle. Click a plan to
          attach it to the current workflow.
        </p>
        <p>
          <strong>Asking the agent directly.</strong> You can also just say
          "create a plan and attach it to this workflow." Every turn where no
          plan is attached carries a short note telling the agent how. On
          Codex, CLI Claude, and Cursor cluster members there's a real tool —{' '}
          <Code>plan_create</Code> (MCP server <Code>arco</Code>) takes a
          title and body, creates the plan, and attaches it in one call; it
          also <em>rejects</em> a body with no sections or checkboxes and says
          why, so a malformed plan is caught as it's written. Elsewhere the
          note hands over the equivalent{' '}
          <Code>POST /api/plans</Code> with <Code>attach: true</Code> (the same
          path the PLAN tab click takes), plus the body shape Arco actually
          parses. Before that note existed, agents would write a markdown file
          somewhere and report "plan attached" — the file was invisible, because
          a plan only exists once it's in <Code>.arco/plans/index.json</Code>.
          Claude Native tabs never had this problem: their <Code>EnterPlanMode</Code>{' '}
          tool attaches for real. The PLAN button remains the most reliable
          route on any provider; prose now works too.
        </p>
        <p>
          <strong>Structure is load-bearing.</strong> A plan body isn't free-form
          markdown. Plan sections come from <Code>### Heading</Code> lines, and a task
          counts only if it's a <em>top-level</em> <Code>- [ ] task</Code>{' '}
          checkbox (indent subtasks beneath it). A plan written without
          checkboxes reads fine to a human but parses to <em>zero</em> tasks —
          per-section Review and the review item picker will have nothing to
          offer. If a generated plan looks right but Review comes up empty, this
          is why.
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
          <Code>- [ ] item</Code> lines render as clickable hollow boxes in the
          panel. Click flips <Code>[x]</Code> with strikethrough + dim, and PATCHes
          the file on disk.
        </p>
        <p>This works in both directions:</p>
        <ul>
          <li>The agent flips a box → the panel updates live.</li>
          <li>You flip a box in the panel → the agent sees it on the next turn (the header flags the plan was edited, prompting the agent to re-read the file).</li>
        </ul>
        <p>
          In a <strong>cluster Plan tab</strong> with a task board attached, each
          unchecked <Code>- [ ]</Code> item also shows a <Code>→ TASK</Code> pill.
          Click it to promote that item's text into a durable board task (a{' '}
          <Code>task_ledger_create</Code> anchored to the cluster's first member,
          landing on the board the operator sees). The pill copies the text — it
          doesn't move the plan item, which stays in place. It only appears when a
          board is attached (hidden when <Code>taskBoardMode</Code> is{' '}
          <Code>'none'</Code>) and never on already-checked items.
        </p>
        <p>From the detail view (or per-row in the list):</p>
        <ul>
          <li><strong>Mark complete</strong> — archives the plan and auto-detaches it from any attached workflows.</li>
          <li><strong>Delete</strong> — permanent, with a confirm. Removes the file from disk.</li>
        </ul>
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
          A plan should read as a list of things to do. Specs, research, design
          notes, API contracts — the detail a task depends on — go in{' '}
          <strong>reference docs</strong> attached to that plan, stored at{' '}
          <Code>&lt;cwd&gt;/.arco/plans/&lt;id&gt;.refs/&lt;slug&gt;.md</Code>.
          A task links one as <Code>[label](ref:slug)</Code>,{' '}
          <Code>[[ref:slug]]</Code>, or a bare <Code>ref:slug</Code> in prose; the
          PLAN tab renders the link as a chip that opens the doc. A link to a ref nobody wrote yet shows dashed and dim —
          click it to create the doc.
        </p>
        <p>
          A <Code>REFS</Code> chip strip above the plan body and the{' '}
          <Code>REFERENCE DOCS</Code> section under it (workflow PLAN tab, cluster
          PLAN sub-tab, and the ALL PLANS library) list them — click any to read
          it in a viewer;
          <Code>+ REF</Code> adds one, and the viewer has EDIT and delete. A doc's
          first <Code># H1</Code> is its title. Max 256 KB per doc, 64 per plan.
        </p>
        <p>
          Agents create refs with the <Code>plan_ref_write</Code> /{' '}
          <Code>plan_ref_list</Code> / <Code>plan_ref_read</Code> tools (MCP server{' '}
          <Code>arco</Code>), or by writing the file directly. An agent asked to
          write a plan is told a plan is two parts — the checklist and its refs —
          and to link each ref from the tasks that depend on it;{' '}
          <Code>plan_create</Code> returns a warning when a body runs long or a
          task carries paragraphs of prose.
        </p>
        <p>
          How refs reach the agent doing the work: the per-turn plan header (and,
          for cluster members, a trailing line in the folded plan) names the
          plan's refs and tells the agent to read the ref a task links before
          starting it, treating the ref as the spec.{' '}
          <Code>cluster_plan_read</Code> returns the ref list. On the cluster
          board, <Code>cluster_task_show</Code> resolves every <Code>ref:</Code>{' '}
          the task's title, notes, or comments link into{' '}
          <Code>referenceDocs</Code> (paths, titles, missing flags), plus the refs
          on the plan item the task came from — its sub-bullets and its section's
          intro — matched by the task title. Dispatched
          tasks are told to read them first, and the task drawer shows them as
          chips. A plan-scoped <strong>Review</strong> inlines the refs the
          in-scope items link (16 KB each, 48 KB total), so the reviewer judges
          the work against the spec.
        </p>
        <Note>
          Moving a plan to another project carries its refs; deleting a plan
          deletes them.
        </Note>
      </>
    ),
  },
  {
    id: 'plans-library',
    group: 'Plans & artifacts',
    title: 'ALL PLANS — the plans library',
    body: (
      <>
        <p>
          The <strong>PLANS</strong> lens in the ARCHIVE window lists every plan
          in every project Arco knows about, so you can review one without
          attaching it to a workflow. Open it from the header{' '}
          <Code>☰ PLANS</Code> button or the <Code>⌸ ALL PLANS</Code> button on
          an empty PLAN tab.
        </p>
        <p>
          Filter by ACTIVE / COMPLETED / ALL and search by title or project. The
          row dot shows <Code>●</Code> attached (a workflow or cluster uses it),{' '}
          <Code>○</Code> not attached, <Code>✓</Code> completed; <Code>⧉N</Code>{' '}
          is the ref count. Selecting a plan shows its body (checkboxes are
          clickable), reference docs, and attachment history, with EDIT, DONE /
          REOPEN, and delete. Edits go through the same routes as the PLAN tab,
          so any attached tab refreshes as usual.
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
          Two artifact types are produced by Arco's primitives:
        </p>
        <ul>
          <li>
            <strong>Review artifact</strong> —{' '}
            <Code>artifacts/review-&lt;ts&gt;.md</Code>. YAML frontmatter (verdict,
            reviewer, primary, contextRef) + body. Surfaced in the REVIEW tab.
          </li>
          <li>
            <strong>Handoff artifact</strong> —{' '}
            <Code>handoffs/handoff-&lt;ts&gt;.md</Code>. Plain markdown body. The
            seed for the next session in the rotated tab.
          </li>
        </ul>
        <p>
          <strong>Inline artifacts</strong> are a third flavor: fenced{' '}
          <Code>```arco-artifact</Code> blocks the agent emits during chat. They
          render as inline-expand pills and persist as{' '}
          <Code>PrimaryArtifactMessage</Code> events in <Code>events.jsonl</Code>.
          Use them for focused outputs (a generated config, a snippet to commit) the
          agent wants to call out.
        </p>
      </>
    ),
  },

  // -------------------------------------------------------------- CONFIGURATION
];
