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
          Six core operator actions plus several structured-prompt composer
          surfaces. No hidden autonomous routing — state-changing work is
          explicit, operator-armed, or routed through bounded tools.
        </p>
        <Table
          headers={['Action', 'What it does']}
          rows={[
            [<strong key="n">New project</strong>, 'Opens a tab. Pick cwd, provider, model, effort, tool allowlist. Start chatting.'],
            [<strong key="r">Resume</strong>, <>Lists existing native CLI sessions for this cwd. Pick one to continue inside Arco.</>],
            [<strong key="rv">Review</strong>, <>Spawns an ephemeral reviewer (any provider/model) over a turn slice or plan content (whole / per-section / picker). Output is a read-only artifact in the right pane.</>],
            [<strong key="h">Handoff</strong>, <>Rotates the current tab's session. Current agent writes a handoff document; new session starts with that document as its seed.</>],
            [<strong key="s">Spawn</strong>, <>Forks the conversation to a new tab. Configurable model/effort for the new tab. Original tab continues in parallel.</>],
            [<strong key="l">Live config swap</strong>, <>Edit MODEL and EFFORT (and Codex sandbox, Claude tools) in CONFIG. Takes effect on the next turn. Provider swaps require a Handoff.</>],
            [<strong key="rsm">Review safe-mode</strong>, <>Native-only CONFIG toggle (default off). Pauses the turn on a sensitive tool call so you can edit / approve / reject it inline before it runs.</>],
            [<strong key="d">DOCS</strong>, <>Composer button: structured prompt to update repo markdown docs from recent git activity. Excludes <Code>.arco/plans/</Code>. RUN AS picker can dispatch in-tab or to a new tab.</>],
            [<strong key="g">GIT</strong>, <>Composer button: live git status, branch picker, action picker (commit / +push / +PR), protected-branch warnings, per-repo prefs. Branch switch dispatched server-side before the prompt.</>],
            [<strong key="rs">RESEARCH</strong>, <>Composer button: bounded cited web-research turn with a hard round cap; writes a markdown report to the RESEARCH tab.</>],
            [<strong key="cmp">COMPARE</strong>, <>Composer button: race one prompt across 2–6 read-only legs side-by-side, blind by default; you pick the winner.</>],
            [<strong key="sk">+SKILL</strong>, <>Arco-managed skills offer <strong>APPLY ONCE</strong> for the next turn or <strong>PIN TO TAB</strong> to apply every turn until removed. Pinned skills survive compaction, Handoff, reload, and restart.</>],
            [<strong key="tm">TUNE MD</strong>, <>Composer button: a read-only worker proposes a compacted agent-instruction file (<Code>CLAUDE.md</Code> / <Code>AGENTS.md</Code> / <Code>GEMINI.md</Code>) as a diff; the original is backed up before any write, and you Accept / Reject each file.</>],
            [<strong key="ra">RUN AS</strong>, <>Shared picker inside DOCS, GIT, RESEARCH, and COMPARE dialogs. Pick the same provider/model/effort as your tab to dispatch in-tab; pick something different to spawn a new tab and run the work there.</>],
          ]}
        />
      </>
    ),
  },
  {
    id: 'review-action',
    group: 'The six operator actions',
    title: 'Review — cross-family second opinion',
    body: (
      <>
        <p>
          Click the <Code>✎ REVIEW</Code> button in the composer action bar to open the Review dialog.
        </p>
        <p>Choose:</p>
        <ul>
          <li>
            <strong>Reviewer provider/model/effort</strong> — typically a different
            family from the primary. Codex reviewing Claude. Antigravity reviewing
            either. The whole point is the second opinion.
          </li>
          <li>
            <strong>Context scope</strong> — <Code>last-turn</Code> (default){' '}
            / <Code>last-N</Code> / <Code>current-session</Code> (everything since the
            last handoff seed) / <Code>full</Code> / <Code>git-diff-only</Code>.
          </li>
          <li>
            <strong>Include git diff</strong> — appends <Code>git diff HEAD</Code> if
            the slice doesn't already include diffs.
          </li>
        </ul>
        <p>The reviewer runs ephemerally with restrictive permissions:</p>
        <ul>
          <li>
            <strong>Claude</strong> reviewer — tools restricted to Read / Grep / Glob /
            LSP only.
          </li>
          <li>
            <strong>Codex</strong> reviewer — sandbox forced to <Code>read-only</Code>.
          </li>
          <li>
            <strong>Ollama / llama.cpp / LM Studio</strong> reviewer — read-only allowlist (Read /
            Grep / Glob / WebSearch / WebFetch). AUTO mode forced so tools execute.
            These local providers also receive a <strong>local-reviewer addendum</strong> in
            the framing that explicitly tells the model to use those tools to verify
            diff claims against the live tree (frontier reviewers do this by default;
            smaller local models tend to opine on the diff text and miss orphan files
            / seed drift / broken wiring). The verdict rule: PASS only if tools were
            used and nothing came back wrong.
          </li>
          <li>
            <strong>Antigravity</strong> reviewer — fresh RPC cascade seeded with
            the review prompt; no CDP artifact watcher is involved.
          </li>
        </ul>
        <p>
          Output is parsed for a <Code>Verdict: PASS | MINOR | BLOCKING</Code> tail
          and persisted to <Code>artifacts/review-&lt;ts&gt;.md</Code> with YAML
          frontmatter. The verdict surfaces in the REVIEW tab; click any artifact to
          read the full body.
        </p>
        <Note kind="tip">
          The <Code>↳ SEND TO AGENT</Code> button on each review artifact pre-fills
          your composer with the review body. Edit before sending — usually you want
          to scope the agent's response to specific concerns, not the whole review.
        </Note>
        <p>
          <strong>Plan-scoped review</strong> is a separate dispatch path for plan
          content (instead of workflow transcript). When a plan is attached, the Plan
          tab pairs <Code>REVIEW</Code> with <Code>VERIFY</Code> at both whole-plan
          and per-section granularity: <Code>REVIEW PLAN</Code> /{' '}
          <Code>VERIFY WORK</Code> at the top, <Code>▷ REVIEW PHASE PLAN</Code> /{' '}
          <Code>▷ VERIFY PHASE WORK</Code> under each <Code>### Phase</Code> heading,
          plus <Code>CUSTOM REVIEW</Code> (tree-with-checkboxes for operator-picked
          items across plan sections). REVIEW defaults to <strong>CRITIQUE</strong> mode
          (evaluate the plan itself — gaps, ordering, missing considerations; all
          items shown with check state preserved); VERIFY defaults to{' '}
          <strong>VERIFY</strong> mode with <Code>INCLUDE GIT DIFF</Code> pre-ticked
          (cross-check claimed-completed work against the actual code + diff —
          only <Code>[x]</Code> items shown; reviewer told not to take checkboxes
          at face value). The dialog's MODE row + git-diff toggle stay editable in
          both cases; the buttons just preset the common intent. For custom item
          selection the operator's pick is authoritative; mode affects framing only.
        </p>
        <p>
          The HISTORY tab also dispatches reviews (and spawns and labels) — see the{' '}
          <Code>HISTORY tab</Code> section below for the timeline-anchored flow.
          Reviews land in chat as <Code>[REVIEW] Running…</Code> and{' '}
          <Code>[REVIEW &lt;verdict&gt;] &lt;artifact&gt;</Code> system rows so the
          dispatch isn't silent; clicking a review row in HISTORY opens the
          artifact in the file viewer.
        </p>
        <p>
          <strong>Cancel:</strong> the X next to a running review kills the reviewer
          worker mid-stream.
        </p>
      </>
    ),
  },
  {
    id: 'handoff-action',
    group: 'The six operator actions',
    title: 'Handoff — rotate within the same tab',
    body: (
      <>
        <p>
          Use Handoff when the conversation gets long, when you want to switch
          providers mid-task, or when the concurrent-writer guard fires and you need
          a fresh session.
        </p>
        <p>Two modes:</p>
        <ul>
          <li>
            <strong>Original-worker</strong> (default for Claude/Codex) — the primary
            self-reflects via <Code>--resume</Code> and writes the handoff doc itself.
            Highest fidelity.
          </li>
          <li>
            <strong>Fresh summarizer</strong> — an ephemeral worker reads the rendered
            transcript and writes the doc. Used when the primary can't be resumed
            (Ollama, llama.cpp, LM Studio, Antigravity).
          </li>
        </ul>
        <p>
          The handoff is written to <Code>handoffs/handoff-&lt;ts&gt;.md</Code> and{' '}
          <em>seeded</em> as the first user turn of the next session. You see it in
          chat as a one-line <Code>HANDOFF SEED · click to expand</Code> pill, not a
          giant user bubble.
        </p>
        <p>
          You can also change provider during Handoff — pick a different primary in
          the dialog and the new session starts on that provider with the same
          handoff seed. Local providers such as Ollama and llama.cpp appear when
          they are enabled and have installed models; non-resumable providers use
          the fresh-summarizer handoff path before the rotated session starts.
        </p>
        <Note>
          The old session is archived in <Code>meta.history[]</Code> and remains
          resumable from the workflow creator's RESUME picker if you ever need to go
          back.
        </Note>
      </>
    ),
  },
  {
    id: 'spawn-action',
    group: 'The six operator actions',
    title: 'Spawn from here — fork to a new tab',
    body: (
      <>
        <p>
          Spawn lets you split the workflow at a decision point: keep the main thread
          running while sending a separate agent down a side path.
        </p>
        <p>The dialog:</p>
        <ul>
          <li>Pick a <strong>new provider/model/effort</strong> for the spawned tab.</li>
          <li>Optionally tack on a <strong>new direction</strong> (free-form text appended after the handoff doc).</li>
          <li>Choose whether to <strong>include the attached plan</strong> in the new tab.</li>
        </ul>
        <p>
          The current primary self-reflects with full session context, writes a
          handoff doc, and a <em>new tab</em> opens with that doc + the new direction
          as its seed. The original tab continues in parallel, untouched.
        </p>
        <p>
          The spawn seed collapses to a one-line pill in the new tab, same as Handoff.
        </p>
        <Note kind="tip">
          Spawn is the right tool when you want a "what if?" branch (try a refactor
          on a different provider) without losing your place in the main work.
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
          The CONFIG tab on the right pane has live editors for everything that can
          change without rotating the session:
        </p>
        <ul>
          <li><strong>Model</strong> — same provider, different model. Takes effect next turn. (Cursor applies it in-session via <Code>session/set_model</Code> with no respawn and posts a "model swapped" notice.)</li>
          <li><strong>Effort</strong> — same model, different reasoning budget. Takes effect next turn.</li>
          <li><strong>Sandbox</strong> (Codex) — read-only / workspace-write / danger-full-access.</li>
          <li><strong>Tool allowlist</strong> (Claude) — restrict the agent's toolset.</li>
          <li><strong>Auto-handoff thresholds</strong> (Claude) — warning + ceiling.</li>
          <li><strong>Auto-fold</strong> (Claude Native) — deterministic in-place transcript trim once the context crosses a token threshold. Off by default.</li>
          <li><strong>Review safe-mode</strong> (Claude Native) — arm the edit-before-approve gate on sensitive tool calls. Default off. See the dedicated section below.</li>
          <li><strong>Output style</strong> — <Code>normal</Code> / <Code>lite</Code> / <Code>terse</Code> system-prompt addendum to cut output tokens (Native + Codex app-server).</li>
          <li><strong>RSS guard</strong> opt-out — for workflows that legitimately need huge memory.</li>
        </ul>
        <p>
          A red dot on the CONFIG tab means the underlying CLI's capability surface
          changed since you last viewed it (e.g. Claude added a new effort level).
          Open the tab and click <Code>ACK</Code> to clear the dot.
        </p>
        <Note kind="warn">
          <strong>Provider swaps are not live.</strong> They require a Handoff because
          the new provider needs a fresh session. The Handoff dialog has a "switch
          provider" option for this exact case.
        </Note>
      </>
    ),
  },
  {
    id: 'review-safe-mode-gate',
    group: 'The six operator actions',
    title: 'Review safe-mode — edit-before-approve gate',
    body: (
      <>
        <p>
          Review safe-mode is a per-tab, <strong>Claude Native-only</strong> approval
          gate. Flip it on in the CONFIG tab under <Code>REVIEW SAFE-MODE</Code>{' '}
          (default <Code>off</Code>; the section only shows on the Native transport).
          While on, the worker pauses the turn whenever the model proposes a{' '}
          <strong>sensitive tool call</strong> — <Code>Bash</Code>,{' '}
          <Code>KillShell</Code>, a write outside the project directory, or a
          destructive git op (<Code>git push</Code> / <Code>reset --hard</Code> /{' '}
          <Code>clean</Code>) — and surfaces an inline{' '}
          <Code>[GATE: REVIEW SAFE-MODE]</Code> card in chat.
        </p>
        <p>
          The card shows the reason and the proposed call in an editable textarea:
          edit the command (or args JSON) and click <Code>APPROVE</Code> to run your
          edited version, or <Code>REJECT</Code> to skip the call and let the turn
          continue. An <em>unedited</em> approve can also tick "approve all identical{' '}
          commands this session" to register a <strong>standing approval</strong> that
          skips the gate for an exact-signature match. Standing approvals are listed
          in CONFIG under <Code>STANDING APPROVALS</Code> with a <Code>REVOKE</Code>{' '}
          button.
        </p>
        <Note kind="info">
          Gates and standing approvals are sidecar-persisted and rehydrate across a
          server restart. This surface is operator-armed and reversible — nothing
          runs without your click, and it is off by default.
        </Note>
      </>
    ),
  },

  {
    id: 'composer-docs',
    group: 'The six operator actions',
    title: 'DOCS — structured documentation update',
    body: (
      <>
        <p>
          The <Code>✎ DOCS</Code> button next to the composer opens a dialog that
          sends the agent a structured prompt to update repo markdown docs (README,
          DEVLOG, CLAUDE.md, <Code>docs/**/*.md</Code>) based on recent git activity.
          Agent walks <Code>git log --oneline -20</Code>, <Code>git status</Code>,
          and <Code>git diff main...HEAD</Code> if on a branch, identifies which docs
          reference changed code, and updates only those docs in place.
        </p>
        <Note kind="warn">
          The prompt explicitly says <strong>do not modify any file under{' '}
          <Code>.arco/plans/</Code></strong>. Plan files have load-bearing
          checkbox / H3 phase structure that the Plan tab parses for per-section review
          and the spawn-from-task surface. Agents (especially Qwen) have rewritten
          plans as prose and broken those features. Don't loosen this — it's why the
          button exists.
        </Note>
        <p>
          Optional <strong>operator note</strong> appended verbatim, e.g. "focus on
          the auth changes — leave README alone".
        </p>
        <p>
          The dialog embeds a <strong>RUN AS picker</strong> (see next section). If
          the picker matches your tab's primary, the prompt dispatches in-tab as a
          regular turn. If it differs, a new tab spawns with the picked config and
          runs the work there.
        </p>
      </>
    ),
  },
  {
    id: 'composer-git',
    group: 'The six operator actions',
    title: 'GIT — branch + commit + push + PR',
    body: (
      <>
        <p>
          The <Code>⎇ GIT</Code> button opens a richer dialog backed by live git
          status. On open, Arco fetches <Code>GET /api/git/status?path=&lt;cwd&gt;</Code>{' '}
          and shows: current branch, upstream tracking, ahead/behind counts, dirty
          and staged file counts, branch list (current first then alphabetical),
          remotes, and whether a GitHub remote is detected.
        </p>
        <p><strong>Branch picker.</strong> Dropdown of all local branches plus an
          inline <Code>+ NEW BRANCH</Code> form (with a base picker). If you change
          branches, the switch is dispatched server-side via{' '}
          <Code>POST /api/git/checkout</Code> <em>before</em> the agent prompt — the
          agent finds itself already on the target branch. The server refuses
          checkout on dirty trees; commit or stash first.
        </p>
        <p><strong>Action picker.</strong></p>
        <ul>
          <li><Code>commit</Code> — stage + commit only.</li>
          <li><Code>commit + push</Code> — also push to upstream.</li>
          <li><Code>commit + push + PR</Code> — also open a GitHub PR via{' '}
            <Code>gh pr create</Code>. Auto-disabled with no GitHub remote.
          </li>
        </ul>
        <p><strong>Smart default:</strong> PR if you're on a non-protected branch
          with a GitHub remote; otherwise commit-push. Save your choice for this repo
          via the <Code>SAVE AS DEFAULT FOR THIS REPO</Code> checkbox (persists to
          localStorage).
        </p>
        <Note kind="warn">
          Branches matching <Code>main / master / release/* / prod / production</Code>{' '}
          are flagged as <strong>protected</strong>. The smart default avoids
          push+PR; the prompt itself instructs the agent to pause and confirm intent
          before pushing.
        </Note>
        <p>
          Optional <strong>commit subject hint</strong> (a hint, not a directive —
          agent still reads the diff and writes the actual message) and{' '}
          <strong>scope notes</strong> (free-form, appended). The structured prompt
          bakes in branch context, action steps (status → stage → logical commits →
          push if chosen → PR if chosen), pause-and-ask rules, and expected
          deliverables (commit hashes, push result, PR URL).
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
    title: 'RESEARCH — bounded cited web research',
    body: (
      <>
        <p>
          The <Code>⌕ RESEARCH</Code> button opens the Deep Research dialog: a topic
          brief, a hard <strong>round cap</strong> (clamped <Code>1–10</Code>, default{' '}
          <Code>4</Code>), and the shared RUN AS picker. It runs a single bounded
          turn in which the agent plans web-search queries, searches, reads results,
          and synthesizes a <strong>cited markdown report</strong> persisted to{' '}
          <Code>artifacts/research-&lt;ts&gt;.md</Code> with YAML frontmatter. The
          report opens in the RESEARCH tab.
        </p>
        <p>
          It is agent-agnostic (works on Claude, Codex, Ollama, llama.cpp, LM Studio). Local
          read-only tools (Read / Grep / Glob / LSP) are allowed; the provider's
          <em> native</em> web search supplies the fetches.
        </p>
        <p><strong>The round cap is the hard, deterministic stop.</strong> There is
          no hidden routing authority and no "is it done?" judge — the model's own
          "sufficient" signal is advisory. How the cap is enforced differs by
          provider:
        </p>
        <ul>
          <li>
            <strong>Claude Native</strong> — the cap is threaded into the
            <Code> web_search</Code> / <Code>web_fetch</Code> server-tool{' '}
            <Code>max_uses</Code> budget, so it is a <em>mechanical</em> ceiling.
          </li>
          <li>
            <strong>Codex</strong> — its <Code>web_search: 'live'</Code> override
            exposes no per-turn <Code>max_uses</Code> knob, so the hard stop is the
            single bounded turn plus the prompt-stated cap. This provider asymmetry
            is intentional and documented (no silent caps).
          </li>
        </ul>
        <Note kind="info">
          <strong>Dig deeper.</strong> Open a finished report and use the{' '}
          <Code>⌕ DIG DEEPER</Code> composer in the RESEARCH tab to ask a follow-up
          against the gathered sources. It runs a small bounded mini-round seeded
          with the report and <em>appends a dated addendum</em> to the same artifact
          rather than starting over.
        </Note>
        <p>
          As with DOCS / GIT, the RUN AS picker dispatches in-tab or spawns a fresh
          tab that issues its own research run. Output style is forced to{' '}
          <Code>normal</Code> — reports are read carefully.
        </p>
      </>
    ),
  },
  {
    id: 'composer-compare',
    group: 'The six operator actions',
    title: 'COMPARE — blind multi-provider answer race',
    body: (
      <>
        <p>
          The <Code>⚖ COMPARE</Code> button opens the Compare dialog: one prompt, and
          2–6 <strong>legs</strong> each picked via the shared RUN AS picker
          (provider / model / effort). Click <Code>RACE</Code> and the same prompt
          fans out to every leg <em>at once</em>; each answer streams into its own
          pane side-by-side. Answers the everyday "Opus or GPT for this?" question
          empirically.
        </p>
        <p>
          Each leg is a fresh, <strong>read-only, no-tools</strong> run with{' '}
          <em>no shared session</em> — the legs never see each other, never edit, and
          never touch disk. That is the whole point: the race is a cheap,
          side-effect-free answer comparison, not a tool-using agent run.
        </p>
        <Note kind="info">
          <strong>Blind mode</strong> (on by default) hides which leg is which until
          you vote, so the choice isn't anchored on the brand name. Once the race
          finishes, click <Code>PICK THIS WINNER</Code> on a pane — the labels reveal
          and the vote is recorded. You can then optionally have one leg{' '}
          <strong>synthesize</strong> a single best answer from all of them. Nothing
          auto-picks a winner; there is no "LLM judges the winner" step — the vote is
          always yours.
        </Note>
      </>
    ),
  },
  {
    id: 'composer-tune-md',
    group: 'The six operator actions',
    title: 'TUNE MD — compact an agent-instruction file',
    body: (
      <>
        <p>
          The <Code>✦ TUNE MD</Code> button targets the per-turn token tax of a
          long-lived instruction file. <Code>CLAUDE.md</Code> /{' '}
          <Code>AGENTS.md</Code> / <Code>GEMINI.md</Code> (and{' '}
          <Code>CLAUDE.local.md</Code>, root + nested) accrete dated session logs,
          resolved TODOs, and restated rules — and since that file is re-read on{' '}
          <em>every</em> turn of <em>every</em> worker, the bloat is a fixed cost.
          The dialog scans the cwd for instruction files and shows a checklist
          (the file matching the tab's primary provider is pre-checked).
        </p>
        <p>
          For each picked file a single <strong>bounded, read-only</strong> worker
          turn <em>proposes</em> a tightened version (no <Code>Write</Code> tool).
          The proposal returns as an A3 diff (original vs proposed, with the
          byte-delta and the agent's notes); you <Code>ACCEPT</Code> or{' '}
          <Code>REJECT</Code> each one, then advance to the next file in the queue.
          On accept the server backs up the original to{' '}
          <Code>.arco/md-backups/&lt;name&gt;.&lt;ts&gt;.bak</Code> and only then
          writes the proposed content through the cwd-guarded path.
        </p>
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
          Lists the research runs for this workflow (newest first). Each row expands
          to the full cited report, fetched from{' '}
          <Code>GET /api/workflows/artifact</Code> — the same endpoint the REVIEW tab
          uses. In-flight runs show a live <Code>searching (n/cap)</Code> note and a
          CANCEL button (kills the worker).
        </p>
        <p>
          The expanded viewer carries the <strong>DIG DEEPER</strong> composer:
          a follow-up question re-runs a bounded mini-round seeded with the report +
          its sources and appends a dated addendum to the same artifact. See{' '}
          <em>RESEARCH — bounded cited web research</em> for the dispatch side.
        </p>
      </>
    ),
  },
  {
    id: 'run-as-picker',
    group: 'The six operator actions',
    title: 'RUN AS — escalate one-off prompts to a different model',
    body: (
      <>
        <p>
          The GIT, DOCS, RESEARCH, and COMPARE dialogs embed a shared{' '}
          <Code>RunAsPicker</Code> that lets you override the current tab's primary
          provider/model/effort for the one-off prompt:
        </p>
        <ul>
          <li>
            <strong>If unchanged from your tab's primary</strong> — the prompt
            dispatches in-tab as a regular operator turn. Hint reads "Will dispatch
            to the tab's current primary as a regular turn."
          </li>
          <li>
            <strong>If you pick a different provider / model / effort</strong> — a
            new tab opens with that config, the prompt becomes its seed turn, and
            the work runs there. Your current chat is left alone. Hint reads "Will
            spawn a new tab with this config so the work runs there."
          </li>
        </ul>
        <p>
          The new tab inherits the parent's cwd, theme, name (suffixed with{' '}
          <Code>(git)</Code>, <Code>(docs)</Code>, or <Code>(research)</Code>),
          and other config; only the
          primary fields and session IDs are overridden. Session IDs are explicitly
          cleared so the new tab is fresh, not a resume.
        </p>
        <p>
          The reset arrow next to the <Code>RUN AS</Code> label snaps back to the
          tab's current primary at any time.
        </p>
        <Note kind="tip">
          The pattern that motivated this: tab's primary is a local Qwen doing the
          actual coding (cheap, on your GPU, fine for routine work), but you want a
          frontier model to do the docs sweep or the git push because those affect
          shared artifacts and you want the stronger writer. RUN AS dispatches the
          one-off escalation without leaving the local workflow context.
        </Note>
      </>
    ),
  },
  // -------------------------------------------------------------- PROVIDERS
];
