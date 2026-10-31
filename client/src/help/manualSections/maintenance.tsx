import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Note } from '../../components/UserManual/components';

export const maintenance: Section[] = [
  {
    id: 'archive-explorer', group: 'The workspace', title: 'Archive — artifacts, recents, plans and file tree',
    body: <>
      <p><strong>⌸ ARCHIVE</strong> opens a separate read-only window, not a workflow
        or an agent. <strong>ARTIFACTS</strong> starts with project cards and recent
        artifacts across projects; open a project to drill into its documents.
        <strong> RECENTS</strong> separates attributed agent writes from the broader
        recently-modified scan. <strong>PLANS</strong> is the plans library — every
        plan across projects, reviewable and editable without attaching it to a
        workflow (the one lens that writes, through the ordinary plan routes).
        <strong> TREE</strong> browses the raw file hierarchy.</p>
      <p>Use ALL/DOCS/IMAGES to filter recents, refresh to update listings, and
        <strong> A− / A+</strong> for the Archive window's own saved zoom. A changed
        file is not necessarily an agent write, and an empty scan is not proof that
        a project has no files. Listings can fail softly.</p>
      <p>The window opens as a same-browser popup, with a server-opened window and
        plain-tab fallback. It does not launch agents or connect to workflow chat.
        Archive is a file browser, not a backup, Git history or Past Chats.</p>
    </>,
  },
  {
    id: 'provider-updates', group: 'Providers', title: 'Provider updates — installed, broken and deferred',
    body: <>
      <p>Open <strong>PROVIDERS</strong> for CLI version chips. A missing CLI and
        an installed executable that fails its version probe are different states:
        the latter is shown as <strong>broken</strong>, with diagnostic detail.</p>
      <p>For npm CLIs that publish their own platform binary package, Arco checks
        that a matching platform version exists before installing. During an upstream
        publish gap it may select an older installable version or retain the working
        one. A <Code>v… (!)</Code> notice explains this on hover; it does not mean
        the newest advertised version was installed. A post-install probe checks
        that the executable actually runs.</p>
      <p>Strata's installed engine version comes from its reachable service or
        prepared BUILD.json while stopped. Arco compares engine component
        versions at boot and every four hours; the app/Terminal 0.2 version
        is separate. Click opens release notes inside Arco, like Ollama. Updating Strata is manual and separate
        from rebuilding Arco. Preserve profiles, packs and service limits,
        then recheck real tools/vision and memory after an engine update.</p>
      <p>XOLOTL tracks its installed source checkout. Click opens recent source
        history inside Arco; equal upstream/installed revisions show UP TO DATE.
        Different revisions show available changes. Source tracking does not prove
        the binary build matches. GitHub is an explicit external link.</p>
      <Note kind="warn">Updating a provider CLI changes that provider's installation,
        not Arco's application build. Existing long-lived children may still hold
        the old executable or credentials. Avoid updates during active work and read
        the result before retrying a failed turn.</Note>
    </>,
  },
  {
    id: 'arco-updates',
    group: 'The workspace',
    title: 'Arco releases — check for a newer build',
    body: <>
      <p>
        Settings &gt; Advanced &gt; CLI and runtime versions includes an{' '}
        <strong>Arco</strong> row with the running version, the latest known
        numbered release, <strong>CHECK NOW</strong>, and{' '}
        <strong>Check for new releases</strong>. Automatic checks start shortly
        after boot and repeat every six hours unless the preference is off or{' '}
        <Code>ARCO_UPDATE_CHECK=0</Code> is set in the server environment. Nothing is
        downloaded or installed automatically; follow{' '}
        <Code>docs/OPERATIONS.md#updating-arco</Code> to update.
      </p>
      <p>
        When a newer release is found, a toast offers{' '}
        <strong>OPEN RELEASE</strong> (release notes in the browser) and{' '}
        <strong>DISMISS</strong> (remembers that version across reloads). Those
        toast actions are separate from the Settings row.
      </p>
    </>,
  },
  {
    id: 'provider-recovery', group: 'Troubleshooting', title: 'Compaction, sign-in and quiet thinking',
    body: <>
      <p><strong>Codex compaction:</strong> a large thread can take several minutes.
        Arco waits for the compact turn's completion, not just its summary event.
        Keep the tab open and wait for the result before sending. The 10-minute
        ceiling reports failure and recycles the worker; it never reports a timeout
        as success. A later turn resumes the durable thread.</p>
      <p><strong>Cursor asks you to sign in despite LIVE auth:</strong> the auth
        probe and the long-lived ACP child can disagree after a login change.
        Arco recognizes the stale-child sign-in failure, shows a re-login card,
        and retires the child. Complete login and resend; no failed prompt is
        silently replayed for you.</p>
      <p><strong>Claude Native is quiet:</strong> THINKING VISIBILITY controls what
        the provider streams, not whether thinking is retained. Fable/Mythos 5.1
        and Opus 5.5 keep thinking and an append-only request prefix. <Code>updates</Code> is a
        request for short progress notes, not a guarantee: the September 1 Fable 5.1
        acceptance run emitted none. Check Activity and worker status before treating
        silence alone as a failure. On Opus 5.5 prefer <Code>summarized</Code>:
        <Code>omitted</Code> also hides its short between-tool notes.</p>
      <p><strong>Old Native thinking/server-tool binding errors:</strong> recovery
        guards now protect the latest assistant message and its referenced server-tool
        calls. For a previously wedged Agent tab, restart between turns or use Fold/
        Compact where available to rebuild retained context. Preserve the error text
        for diagnostics if the problem returns; do not delete transcript files.</p>
    </>,
  },
];
