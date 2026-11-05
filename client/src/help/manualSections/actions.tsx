import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Note, Table } from '../../components/UserManual/components';

export const actions: Section[] = [
  {
    id: 'six-actions-overview',
    group: 'The six operator actions',
    title: 'Overview',
    body: (
      <>
        <p>
          These controls move work forward when the operator chooses them.
          Six core actions sit alongside several structured-prompt composer tools.
        </p>
        <p>
          State-changing work is explicit, operator-armed, or routed through
          bounded tools. There is no hidden autonomous routing.
        </p>
        <Table
          headers={['Action', 'What it does']}
          rows={[
            [<strong key="n">New project</strong>, 'Opens a tab. Pick cwd, provider, model, effort, tool allowlist. Start chatting.'],
            [<strong key="r">Resume</strong>, <>Lists existing native CLI sessions for this cwd. Pick one to continue inside Arco.</>],
            [<strong key="rv">Review</strong>, <>Spawns an ephemeral reviewer (any provider/model) over a turn slice or plan content (whole / per-section / picker). Output is a read-only artifact in the right pane.</>],
            [<strong key="h">Handoff</strong>, <>Rotates the current tab&apos;s session and seeds the new session with a handoff.</>],
            [<strong key="s">Spawn</strong>, <>Forks the conversation to a new tab. Configurable model/effort for the new tab. Original tab continues in parallel.</>],
            [<strong key="l">Live config swap</strong>, <>Edit MODEL and EFFORT (and Codex sandbox, Claude tools) in CONFIG. Takes effect on the next turn. Provider swaps require a Handoff.</>],
            [<strong key="rsm">Review safe-mode</strong>, <>Native-only CONFIG toggle (default off). Pauses the turn on a sensitive tool call so it can be edited / approved / rejected inline before it runs.</>],
            [<strong key="d">DOCS</strong>, <>Composer button: structured prompt to update repo markdown docs from recent git activity. Excludes <Code>.arco/plans/</Code>. RUN AS picker can dispatch in-tab or to a new tab.</>],
            [<strong key="g">GIT</strong>, <>Composer button: live git status, branch picker, action picker (commit / +push / +PR), protected-branch warnings, per-repo prefs. Branch switch dispatched server-side before the prompt.</>],
            [<strong key="rs">RESEARCH</strong>, <>Composer button: bounded cited web-research turn with a hard round cap; writes a markdown report to the RESEARCH tab.</>],
            [<strong key="cmp">SECOND OPINION</strong>, <>Composer button (and an action on selected chat messages): 2-6 models each draft the reply the operator could send to the worker; blind by default, the operator picks one and USE THIS REPLY puts it in the composer. Nothing is sent automatically.</>],
            [<strong key="sk">SKILLS</strong>, <>Choose Arco skills with <strong>APPLY ONCE</strong> or <strong>PIN TO TAB</strong>, create a skill, or insert a supported agent skill. Pins survive compaction, Handoff, reload, and restart.</>],
            [<strong key="tm">TUNE MD</strong>, <>Composer button: a read-only worker proposes a compacted agent-instruction file (<Code>CLAUDE.md</Code> / <Code>CLAUDE.local.md</Code> / <Code>AGENTS.md</Code>) as a diff; the original is backed up before any write, and the operator accepts or rejects each file.</>],
            [<strong key="ra">RUN AS</strong>, <>Shared picker inside DOCS, GIT, RESEARCH, and SECOND OPINION dialogs. Pick the same provider/model/effort as the tab to dispatch in-tab; pick something different to spawn a new tab and run the work there.</>],
          ]}
        />
      </>
    ),
  },
  {
    id: 'review-action',
    group: 'The six operator actions',
    title: 'Review - cross-family second opinion',
    body: (
      <>
        <p>
          Review spawns an ephemeral second-opinion worker over a turn slice or
          plan content and writes a read-only artifact. Click the{' '}
          <Code>✎ REVIEW</Code> button in the composer action bar to open the
          Review dialog.
        </p>
        <h4 className="manual-sub">Review options</h4>
        <p>Choose:</p>
        <ul>
          <li>
            <strong>Reviewer provider/model/effort</strong> - typically a
            different family from the primary, such as Codex reviewing Claude.
            The whole point is the second opinion.
          </li>
          <li>
            <strong>Context scope</strong> - <Code>last-turn</Code> (default) /{' '}
            <Code>last-N</Code> / <Code>current-session</Code> (everything since
            the last handoff seed) / <Code>full</Code> /{' '}
            <Code>git-diff-only</Code>.
          </li>
          <li>
            <strong>Include git diff</strong> - appends{' '}
            <Code>git diff HEAD</Code> if the slice does not already include
            diffs.
          </li>
        </ul>
        <p>The reviewer runs ephemerally with restrictive permissions:</p>
        <ul>
          <li>
            <strong>Claude</strong> reviewer - tools restricted to Read / Grep /
            Glob / LSP only.
          </li>
          <li>
            <strong>Codex</strong> reviewer - sandbox forced to{' '}
            <Code>read-only</Code>.
          </li>
          <li>
            <strong>Ollama / llama.cpp / LM Studio</strong> reviewer - read-only
            allowlist (Read / Grep / Glob / WebSearch / WebFetch). AUTO mode
            forced so tools execute. These local providers also receive a{' '}
            <strong>local-reviewer addendum</strong> in the framing that
            explicitly tells the model to use those tools to verify diff claims
            against the live tree (frontier reviewers do this by default;
            smaller local models tend to opine on the diff text and miss orphan
            files / seed drift / broken wiring). The verdict rule: PASS only if
            tools were used and nothing came back wrong.
          </li>
        </ul>
        <p>
          Output is parsed for a{' '}
          <Code>Verdict: PASS | MINOR | BLOCKING</Code> tail and persisted to{' '}
          <Code>artifacts/review-&lt;ts&gt;.md</Code> with YAML frontmatter.
          The verdict surfaces in the REVIEW tab; click any artifact to read
          the full body.
        </p>
        <Note kind="tip">
          The <Code>↳ SEND TO AGENT</Code> button on each review artifact
          pre-fills the composer with the review body. Edit before sending:
          usually the agent&apos;s response should be scoped to specific
          concerns, not the whole review.
        </Note>
        <h4 className="manual-sub">Review a plan or completed work</h4>
        <p>
          Plan-scoped review checks plan content rather than the workflow transcript.
          When a plan is attached, the Plan tab offers review and verification at
          whole-plan or per-section granularity:
        </p>
        <ul>
          <li><Code>REVIEW PLAN</Code> and <Code>VERIFY WORK</Code> cover the whole plan.</li>
          <li><Code>▷ REVIEW PHASE PLAN</Code> and <Code>▷ VERIFY PHASE WORK</Code> cover one phase.</li>
          <li><Code>CUSTOM REVIEW</Code> opens a checkbox tree for items across sections.</li>
        </ul>
        <p>
          REVIEW defaults to{' '}
          <strong>CRITIQUE</strong> mode (evaluate the plan itself - gaps,
          ordering, missing considerations; all items shown with check state
          preserved); VERIFY defaults to <strong>VERIFY</strong> mode with{' '}
          <Code>INCLUDE GIT DIFF</Code> pre-ticked (cross-check
          claimed-completed work against the actual code + diff - only{' '}
          <Code>[x]</Code> items shown; reviewer told not to take checkboxes at
          face value).
        </p>
        <p>
          The dialog&apos;s MODE row + git-diff toggle stay
          editable in both cases; the buttons just preset the common intent. For
          custom item selection the operator&apos;s pick is authoritative; mode
          affects framing only.
        </p>
        <p>
          The HISTORY tab also dispatches reviews (and spawns and labels) - see
          the <Code>HISTORY tab</Code> section below for the timeline-anchored
          flow. Reviews land in chat as <Code>[REVIEW] Running review…</Code> and{' '}
          <Code>[REVIEW &lt;verdict&gt;] &lt;artifact&gt;</Code> system rows so
          the dispatch is not silent; clicking a review row in HISTORY opens the
          artifact in the file viewer.
        </p>
        <p>
          <strong>Cancel:</strong> the X next to a running review kills the
          reviewer worker mid-stream.
        </p>
      </>
    ),
  },
  {
    id: 'handoff-action',
    group: 'The six operator actions',
    title: 'Handoff - rotate within the same tab',
    body: (
      <>
        <p>
          Use Handoff when the conversation gets long, when switching providers
          mid-task, or when the concurrent-writer guard fires and a fresh
          session is needed.
        </p>
        <h4 className="manual-sub">Handoff choices</h4>
        <p>Choose a handoff mode:</p>
        <ul>
          <li><strong>Quick</strong> (default) - Arco builds a deterministic seed from recent conversation, the action digest and Git state. It uses at most 20% of the new model&apos;s context, estimated conservatively; when its window is unknown, Arco assumes 4,096 tokens. No model writes the handoff first.</li>
          <li>
            <strong>Original-worker</strong> - the primary reflects on its session without tools. Arco saves its reply as the handoff. Claude CLI hooks are disabled for the reflection where permitted; administrator-managed hooks can still run.
          </li>
          <li>
            <strong>Fresh summarizer</strong> - an ephemeral worker reads the
            rendered transcript and writes the doc. Used when the primary cannot
            be resumed (Ollama, llama.cpp, LM Studio).
          </li>
        </ul>
        <p>
          The handoff is written to <Code>handoffs/handoff-&lt;ts&gt;.md</Code>{' '}
          and <em>seeded</em> as the first user turn of the next session. It
          appears in chat as a one-line{' '}
          <Code>HANDOFF SEED · click to expand</Code> pill, not a giant user
          bubble.
        </p>
        <p>
          Provider can also change during Handoff - pick a different primary in
          the dialog and the new session starts on that provider with the same
          handoff seed. Local providers such as Ollama and llama.cpp appear when
          they are enabled and have installed models.
        </p>
        <p>
          Written handoffs default to medium writer effort unless another effort is selected. Automatic handoff uses Quick unless a written mode is configured.
        </p>
        <Note>
          The old session is archived and remains
          resumable from the workflow creator&apos;s RESUME picker if going back
          is ever needed.
        </Note>
      </>
    ),
  },
  {
    id: 'spawn-action',
    group: 'The six operator actions',
    title: 'Spawn from here - fork to a new tab',
    body: (
      <>
        <p>
          Spawn splits the workflow at a decision point: keep the main thread
          running while sending a separate agent down a side path.
        </p>
        <h4 className="manual-sub">Spawn options</h4>
        <p>The dialog:</p>
        <ul>
          <li>
            Pick a <strong>new provider/model/effort</strong> for the spawned
            tab.
          </li>
          <li>
            Optionally tack on a <strong>new direction</strong> (free-form text
            appended after the handoff doc).
          </li>
          <li>
            Choose whether to <strong>include the attached plan</strong> in the
            new tab.
          </li>
        </ul>
        <p>
          The current primary self-reflects with session context, Arco saves
          its reply as a handoff, and a <em>new tab</em> opens with that doc + the new
          direction as its seed. The original tab continues in parallel,
          untouched.{' '}The spawn seed collapses to a one-line pill in the new tab, same as
          Handoff.
        </p>
        <Note kind="tip">
          Spawn is the right tool for a &quot;what if?&quot; branch (try a
          refactor on a different provider) without losing place in the main
          work.
        </Note>
      </>
    ),
  },
  {
    id: 'live-config-swap',
    group: 'The six operator actions',
    title: 'Live model/effort swap',
    body: (
      <>
        <p>
          The CONFIG tab changes supported worker settings without starting a
          new session. Available controls include:
        </p>
        <ul>
          <li>
            <strong>Model</strong> - same provider, different model. Takes
            effect next turn. (Cursor applies it in-session via{' '}
            <Code>session/set_model</Code> with no respawn and posts a &quot;model
            swapped&quot; notice.)
          </li>
          <li>
            <strong>Effort</strong> - same model, different reasoning budget.
            Takes effect next turn.
          </li>
          <li>
            <strong>Sandbox</strong> (Codex) - read-only / workspace-write /
            danger-full-access.
          </li>
          <li>
            <strong>Tool allowlist</strong> (Claude) - restrict the agent&apos;s
            toolset.
          </li>
          <li>
            <strong>Auto-handoff</strong> - hand off after N compactions
            (default 5). Off by default.
          </li>
          <li>
            <strong>Auto-fold</strong> (Claude Native) - deterministic in-place
            transcript trim once the context crosses a token threshold. Off by
            default.
          </li>
          <li>
            <strong>Review safe-mode</strong> (Claude Native) - arm the
            edit-before-approve gate on sensitive tool calls. Default off. See
            the dedicated section below.
          </li>
          <li>
            <strong>Output style</strong> - <Code>normal</Code> /{' '}
            <Code>lite</Code> / <Code>terse</Code> system-prompt addendum to cut
            output tokens (Native + Codex app-server).
          </li>
          <li>
            <strong>RSS guard</strong> opt-out - for workflows that
            legitimately need huge memory.
          </li>
        </ul>
        <p>
          A red dot on the CONFIG tab means the underlying CLI&apos;s capability
          surface changed since it was last viewed (e.g. Claude added a new
          effort level). Open the tab and click <Code>ACK</Code> to clear the
          dot.
        </p>
        <Note kind="warn">
          <strong>Provider swaps are not live.</strong> They require a Handoff
          because the new provider needs a fresh session. The Handoff dialog has
          a &quot;switch provider&quot; option for this exact case.
        </Note>
      </>
    ),
  },
  {
    id: 'review-safe-mode-gate',
    group: 'The six operator actions',
    title: 'Review safe-mode - edit-before-approve gate',
    body: (
      <>
        <p>
          Review safe-mode is a per-tab, <strong>Claude Native-only</strong>{' '}
          approval gate. Flip it on in the CONFIG tab under{' '}
          <Code>REVIEW SAFE-MODE</Code> (default <Code>off</Code>; the section
          only shows on the Native transport).
        </p>
        <p>
          While on, the worker pauses the
          turn whenever the model proposes a <strong>sensitive tool call</strong>{' '}
          - <Code>Bash</Code>, <Code>KillShell</Code>, a write outside the
          project directory, or a destructive git op (<Code>git push</Code> /{' '}
          <Code>reset --hard</Code> / <Code>clean</Code>) - and surfaces an
          inline <Code>[GATE: REVIEW SAFE-MODE]</Code> card in chat.
        </p>
        <p>
          The card shows the reason and the proposed call in an editable
          textarea: edit the command (or args JSON) and click{' '}
          <Code>APPROVE</Code> to run the edited version, or{' '}
          <Code>REJECT</Code> to skip the call and let the turn continue.
        </p>
        <p>
          An{' '}
          <em>unedited</em> approve can also tick &quot;approve all identical
          commands this session&quot; to register a{' '}
          <strong>standing approval</strong> that skips the gate for an
          exact-signature match. Standing approvals are listed in CONFIG under{' '}
          <Code>STANDING APPROVALS</Code> with a <Code>REVOKE</Code> button.
        </p>
        <Note kind="info">
          Gates and standing approvals are sidecar-persisted and rehydrate
          across a server restart. This surface is operator-armed and
          reversible - nothing runs without an operator click, and it is off by
          default.
        </Note>
      </>
    ),
  },

  {
    id: 'composer-docs',
    group: 'The six operator actions',
    title: 'DOCS - structured documentation update',
    body: (
      <>
        <p>
          DOCS sends a structured prompt to update repo markdown from recent git
          activity. The <Code>✎ DOCS</Code> button next to the composer opens a
          dialog that sends the agent a structured prompt to update repo
          markdown docs (README, DEVLOG, CLAUDE.md, <Code>docs/**/*.md</Code>)
          based on recent git activity.
        </p>
        <p>
          The agent walks{' '}
          <Code>git log --oneline -20</Code>, <Code>git status</Code>, and{' '}
          <Code>git diff main...HEAD</Code> if on a branch, identifies which
          docs reference changed code, and updates only those docs in place.
        </p>
        <Note kind="warn">
          The prompt explicitly says{' '}
          <strong>
            do not modify any file under <Code>.arco/plans/</Code>
          </strong>
          . Plan files have load-bearing checkbox / H3 phase structure that the
          Plan tab parses for per-section review and the spawn-from-task
          surface. Agents (especially Qwen) have rewritten plans as prose and
          broken those features. Do not loosen this - it is why the button
          exists.
        </Note>
        <p>
          Optional <strong>operator note</strong> appended verbatim, e.g.
          &quot;focus on the auth changes - leave README alone&quot;.
        </p>
        <p>
          The dialog embeds a <strong>RUN AS picker</strong> (see next
          section). If the picker matches the tab&apos;s primary, the prompt
          dispatches in-tab as a regular turn. If it differs, a new tab spawns
          with the picked config and runs the work there.
        </p>
      </>
    ),
  },
  {
    id: 'composer-git',
    group: 'The six operator actions',
    title: 'GIT - branch + commit + push + PR',
    body: (
      <>
        <p>
          <Code>⎇ GIT</Code> opens a live status dialog for branch, commit,
          push and pull request work. It shows the current branch, upstream,
          ahead and behind counts, dirty and staged file counts, local branches,
          remotes and whether a GitHub remote is detected; the current branch
          comes first, then the rest alphabetically.
        </p>
        <h4 className="manual-sub">Branch picker</h4>
        <p>
          Dropdown of all local branches plus an
          inline <Code>+ NEW BRANCH</Code> form (with a base picker). If the
          branch changes, the switch happens <em>before</em> the agent prompt:
          the agent finds itself already on the target branch. The server
          refuses checkout on dirty trees; commit or stash first.
        </p>
        <h4 className="manual-sub">Action picker</h4>
        <ul>
          <li>
            <Code>commit</Code> - stage + commit only.
          </li>
          <li>
            <Code>commit + push</Code> - also push to upstream.
          </li>
          <li>
            <Code>commit + push + PR</Code> - also open a GitHub PR via{' '}
            <Code>gh pr create</Code>. Auto-disabled with no GitHub remote.
          </li>
        </ul>
        <p>
          <strong>Smart default:</strong> PR if on a non-protected branch with a
          GitHub remote; otherwise commit-push. Save the choice for this repo
          via the <Code>SAVE AS DEFAULT FOR THIS REPO</Code> checkbox (persists
          to localStorage).
        </p>
        <Note kind="warn">
          Branches matching{' '}
          <Code>main / master / release/* / prod / production</Code> are flagged
          as <strong>protected</strong>. The smart default avoids push+PR; the
          prompt itself instructs the agent to pause and confirm intent before
          pushing.
        </Note>
        <p>
          Optional <strong>commit subject hint</strong> (a hint, not a
          directive - the agent still reads the diff and writes the actual
          message) and <strong>scope notes</strong> (free-form, appended). The
          structured prompt bakes in branch context, action steps (status →
          stage → logical commits → push if chosen → PR if chosen),
          pause-and-ask rules, and expected deliverables (commit hashes, push
          result, PR URL).
        </p>
        <h4 className="manual-sub">Other work</h4>
        <p>
          <Code>SHOW OTHER WORK</Code> lists the
          repository&apos;s other worktrees and local branches (read when you
          open it): branch, the tab working there, commits ahead of and behind
          the default branch, uncommitted files, and the open pull request when
          the GitHub CLI is available (otherwise pull requests are simply left
          out).
        </p>
        <p>
          <Code>VIEW CHANGES</Code> opens the FILES tab&apos;s CHANGES view
          on that worktree. It is read-only: no merge, delete or switch actions.
        </p>
        <p>
          Closing the dialog without sending, including through VIEW CHANGES,
          keeps what was set. Opening GIT again in the same tab restores the
          run-as choice, whether other work was shown, the scroll position,
          the branch, the action and the commit subject and scope notes, until
          a request is sent or the tab is closed.
        </p>
        <p>
          As with DOCS, the dialog embeds the <strong>RUN AS picker</strong> for
          in-tab vs new-tab routing.
        </p>
      </>
    ),
  },
  {
    id: 'composer-research',
    group: 'The six operator actions',
    title: 'RESEARCH - bounded cited web research',
    body: (
      <>
        <p>
          RESEARCH runs one bounded cited web-research turn and writes a
          markdown report. The <Code>⌕ RESEARCH</Code> button opens the Deep
          Research dialog: a topic brief, a hard <strong>round cap</strong>{' '}
          (clamped <Code>1-10</Code>, default <Code>4</Code>), and the shared
          RUN AS picker.
        </p>
        <p>
          It runs a single bounded turn in which the agent plans
          web-search queries, searches, reads results, and synthesizes a{' '}
          <strong>cited markdown report</strong> persisted to{' '}
          <Code>artifacts/research-&lt;ts&gt;.md</Code> with YAML frontmatter.
          The report opens in the RESEARCH tab.
        </p>
        <p>
          It is agent-agnostic (works on Claude, Codex, Ollama, llama.cpp, LM
          Studio). Local read-only tools (Read / Grep / Glob / LSP) are allowed;
          the provider&apos;s <em>native</em> web search supplies the fetches.
        </p>
        <p>
          <strong>The round cap is the hard, deterministic stop.</strong> There
          is no hidden routing authority and no &quot;is it done?&quot; judge:
          the model&apos;s own &quot;sufficient&quot; signal is advisory. How
          the cap is enforced differs by provider:
        </p>
        <ul>
          <li>
            <strong>Claude Native</strong> - the cap is threaded into the{' '}
            <Code>web_search</Code> / <Code>web_fetch</Code> server-tool{' '}
            <Code>max_uses</Code> budget, so it is a <em>mechanical</em>{' '}
            ceiling.
          </li>
          <li>
            <strong>Codex</strong> - its <Code>web_search: &apos;live&apos;</Code>{' '}
            override exposes no per-turn <Code>max_uses</Code> knob, so the hard
            stop is the single bounded turn plus the prompt-stated cap. This
            provider asymmetry is intentional and documented (no silent caps).
          </li>
        </ul>
        <Note kind="info">
          <strong>Dig deeper.</strong> Open a finished report and use the{' '}
          <Code>⌕ DIG DEEPER</Code> composer in the RESEARCH tab to ask a
          follow-up against the gathered sources. It runs a small bounded
          mini-round seeded with the report and <em>appends a dated addendum</em>{' '}
          to the same artifact rather than starting over.
        </Note>
        <p>
          As with DOCS / GIT, the RUN AS picker dispatches in-tab or spawns a
          fresh tab that issues its own research run. Output style is forced to{' '}
          <Code>normal</Code> - reports are read carefully.
        </p>
      </>
    ),
  },
  {
    id: 'composer-compare',
    group: 'The six operator actions',
    title: 'SECOND OPINION - several models draft your reply',
    body: (
      <>
        <p>
          SECOND OPINION helps you answer a worker. The <Code>SECOND OPINION</Code>{' '}
          button opens a dialog where you type a question, or you tick one or
          more chat messages and press <Code>SECOND OPINION</Code> in the bar
          above the composer to ask about them.
        </p>
        <p>
          Pick 2-6 <strong>models</strong>{' '}
          with the shared RUN AS picker and press <Code>ASK THE MODELS</Code>:
          each one drafts, independently and at the same time, the reply you
          could send. The drafts stream into side-by-side panes.
        </p>
        <p>
          Each model is a fresh, <strong>read-only</strong> run with{' '}
          <em>no shared session</em>: it never sees another draft and never
          edits anything. It gets the selected messages and your question.
        </p>
        <p>
          Two switches add the tab&apos;s last three turns and read-only access to
          project files (no web and no other tools). Recent turns start on when
          no messages are selected; file access starts off. The dialog shows
          what each model will see and the approximate size. Off means no tools.
        </p>
        <Note kind="info">
          <strong>Blind mode</strong> (on by default) hides which model wrote
          which draft until you pick. <Code>PICK THIS DRAFT</Code> records your
          choice, reveals the labels and adds to a small tally of your picks per
          model, kept in this browser and shown in the dialog (RESET clears it).
          One model can then <strong>synthesize</strong> a single best draft from
          all of them. <Code>USE THIS REPLY</Code> on the picked or synthesized
          draft puts it in this tab&apos;s composer to edit; your earlier composer
          text can be brought back with UNDO. Nothing is sent automatically and
          no model judges the winner.
        </Note>
      </>
    ),
  },
  {
    id: 'composer-tune-md',
    group: 'The six operator actions',
    title: 'TUNE MD - compact an agent-instruction file',
    body: (
      <>
        <p>
          TUNE MD proposes a compacted agent-instruction file as a reviewable
          diff. The <Code>✦ TUNE MD</Code> button targets the per-turn token cost
          of a long-lived instruction file.
        </p>
        <h4 className="manual-sub">Preview and apply</h4>
        <p>
          <Code>CLAUDE.md</Code> /{' '}
          <Code>AGENTS.md</Code> (and <Code>CLAUDE.local.md</Code>, root +
          nested) accrete dated session logs, resolved TODOs, and restated
          rules - and since that file is re-read on <em>every</em> turn of{' '}
          <em>every</em> worker, the bloat is a fixed cost.
        </p>
        <p>
          The dialog scans the
          cwd for instruction files and shows a checklist (the file matching the
          tab&apos;s primary provider is pre-checked). Each row shows line count,
          an approximate token count (bytes divided by four), and deterministic
          hints for dated or session-log headings, repeated lines, and files
          over 200 lines or about 2,000 tokens.
        </p>
        <p>
          VIEW expands the current text
          without a model call. Text preview and analysis are limited to 2 MiB.
        </p>
        <p>
          Instruction-file links to a listed file appear as other names on its
          card and in VIEW. Links outside the project or to unlisted files are
          shown as skipped. Tune-up writes the selected file, never through a link.
        </p>
        <ol>
          <li>
            For each picked file a single <strong>bounded, read-only</strong>{' '}
            worker turn <em>proposes</em> a tightened version (no{' '}
            <Code>Write</Code> tool).
          </li>
          <li>
            The proposal returns as an A3 diff (original vs proposed, with the
            byte-delta and the agent&apos;s notes).
          </li>
          <li>
            <Code>ACCEPT</Code> or <Code>REJECT</Code> each one, then advance to
            the next file in the queue.
          </li>
          <li>
            On accept the server backs up the original to{' '}
            <Code>.arco/md-backups/&lt;name&gt;.&lt;ts&gt;.bak</Code> and only
            then writes the proposed content through the cwd-guarded path.
          </li>
          <li>After acceptance, <Code>UNDO</Code> restores the original. If the file changed since acceptance, confirm before replacement; Arco backs up the current text first. Undo is available in the open review while the server remains running.</li>
        </ol>
        <Note kind="info">
          This is the opposite of the rejected <em>auto-edit instructions from
          session traces</em> pattern: operator-initiated, sourced from the file
          itself (not traces), proposal-only, reviewed as a diff, and backed up /
          reversible.
        </Note>
      </>
    ),
  },
  {
    id: 'research-action',
    group: 'The six operator actions',
    title: 'RESEARCH tab',
    body: (
      <>
        <p>
          The RESEARCH tab lists research runs for this workflow and supports
          dig-deeper follow-ups. Runs appear newest first.
        </p>
        <h4 className="manual-sub">Research reports</h4>
        <p>
          Each row expands to the full cited report. In-flight runs show a live{' '}
          <Code>searching (n/cap)</Code> note and a CANCEL button (kills the
          worker).
        </p>
        <p>
          The expanded viewer carries the <strong>DIG DEEPER</strong> composer:
          a follow-up question re-runs a bounded mini-round seeded with the
          report + its sources and appends a dated addendum to the same
          artifact. See <em>RESEARCH - bounded cited web research</em> for the
          dispatch side.
        </p>
      </>
    ),
  },
  {
    id: 'run-as-picker',
    group: 'The six operator actions',
    title: 'RUN AS - escalate one-off prompts to a different model',
    body: (
      <>
        <p>
          RUN AS overrides the tab&apos;s primary for one structured prompt
          without leaving the workflow context. The GIT, DOCS, RESEARCH, and
          SECOND OPINION dialogs embed a shared <Code>RunAsPicker</Code> that lets the
          current tab&apos;s primary provider/model/effort be overridden for the
          one-off prompt:
        </p>
        <ul>
          <li>
            <strong>If unchanged from the tab&apos;s primary</strong> - the
            prompt dispatches in-tab as a regular operator turn. Hint reads
            &quot;Will dispatch to the tab&apos;s current primary as a regular
            turn.&quot;
          </li>
          <li>
            <strong>
              If a different provider / model / effort is picked
            </strong>{' '}
            - a new tab opens with that config, the prompt becomes its seed
            turn, and the work runs there. The current chat is left alone. Hint
            reads &quot;Will spawn a new tab with this config so the work runs
            there.&quot;
          </li>
        </ul>
        <p>
          The new tab inherits the parent&apos;s cwd, theme, name (suffixed with{' '}
          <Code>(git)</Code>, <Code>(docs)</Code>, or <Code>(research)</Code>),
          and other config; only the primary fields and session IDs are
          overridden. Session IDs are explicitly cleared so the new tab is
          fresh, not a resume.{' '}The reset arrow next to the <Code>RUN AS</Code> label snaps back to
          the tab&apos;s current primary at any time.
        </p>
        <Note kind="tip">
          The pattern that motivated this: the tab&apos;s primary is a local
          Qwen doing the actual coding (cheap, on the local GPU, fine for
          routine work), but a frontier model is wanted for the docs sweep or
          the git push because those affect shared artifacts and a stronger
          writer is preferred. RUN AS dispatches the one-off escalation without
          leaving the local workflow context.
        </Note>
      </>
    ),
  },
  // -------------------------------------------------------------- PROVIDERS
];
