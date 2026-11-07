import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Note, Table, Sub} from '../../components/UserManual/components';

export const maintenance: Section[] = [
  {
  id: 'archive-explorer', group: 'The workspace', title: 'Artifacts - artifacts, recents, plans, storage and file tree',
  body: <>
  <p>RECENTS shows filenames for both Windows and slash-separated paths. Files inside an Arco state folder open in the viewer; OPEN IN TREE is offered only for project files outside that folder.</p>
  <p>
  <strong>ARTIFACTS</strong> (in the KNOWLEDGE menu) is a file browser for artifacts,
  recents, plans, storage and the raw tree - not a workflow or an agent. Only PLANS
  and STORAGE change anything; each STORAGE action asks first.
  </p>
  <p>If an output changes during Move, both files stay and a conflict is reported. The entry keeps its source location. Review the destination copy before retrying.</p>
  <ul>
  <li>
  <strong>ARTIFACTS</strong> starts with project cards and recent artifacts
  across projects; open a project to drill into its documents.
  </li>
  <li>
  <strong>RECENTS</strong> separates attributed agent writes from the
  broader recently-modified scan.
  </li>
  <li>
  <strong>PLANS</strong> is the plans library - every plan across projects,
  reviewable and editable without attaching it to a workflow (it writes
  through the ordinary plan routes).
  </li>
  <li>
  <strong>STORAGE</strong> shows disk use by project and offers clean-up
  actions; see STORAGE - where disk space goes.
  </li>
  <li>
  <strong>TREE</strong> browses the raw file hierarchy.
  </li>
  </ul>
  <p>
  In OUTPUTS, Save a copy keeps the original; Move removes it only after the
  destination and output location are saved. Choose a folder in the home folder
  or an approved project or media folder. Protected state and unsafe links are
  refused. On systems with POSIX permissions, saved copies are created with access
  limited to the owner. The result stays visible until the dialog is closed.
  </p>
  <p>
  MOVE TO PROJECT in OUTPUTS offers KEEP IT PRIVATE or a copy into the project.
  Its folder browser fills the dialog; select Create folder to reveal the new
  folder fields, then enter a name and select + FOLDER. Resize the dialog or
  choose Maximize to see more.
  </p>
  <p>
  Review Git ignore status, public visibility, size and text findings first.
  Files that cannot be fully scanned are listed by name. A public repository
  copy outside Git ignore asks for a second confirmation for those files.
  Images and recordings need manual inspection. Projects opened through a
  linked parent work; links within artifacts are refused.
  </p>
  <p>
  Other binary files, such as archives and disk images, are scanned for
  readable text only and listed as not fully scanned. A file stops being
  scanned after 1,000 findings, and a copy after 2,000; the rest is listed as
  not fully scanned instead of stopping the review.
  </p>
  <p>
  Arco does not stage or commit the copy, and the original remains in Arco. A failed copy
  can leave partial files at the destination. The temporary folder must be
  outside the project and Git repositories.
  </p>
  <p>
  Large artifact warnings offer KEEP, which protects the item from cleanup,
  archive and later size warnings, or DISMISS without protection. The size check
  runs every 30 seconds while a turn works and again when it ends, so a very
  large file warns while the turn is still running.
  </p>
  <p>
  A kept artifact shows Kept in OUTPUTS with UNKEEP beside it. UNKEEP asks first
  and names what it removes: the file's own mark, a kept folder above it, or the
  mark on the whole conversation. No file is changed.
  </p>
  <p>
  Use ALL/DOCS/IMAGES to filter recents, refresh to update listings, and
  <strong> A− / A+</strong> for the Artifacts window's own saved zoom. A changed
  file is not necessarily an agent write, and an empty scan is not proof that
  a project has no files. Listings can fail softly.
  </p>
  <p>
  The window opens as a same-browser popup, with a server-opened window and
  plain-tab fallback. It does not launch agents or connect to workflow chat.
  Artifacts is a file browser, not a backup, Git history or Past Chats.
  </p>
  </>,
  },
  {
  id: 'provider-updates', group: 'Providers', title: 'Provider updates - installed, broken and deferred',
  body: <>
  <p>
  Provider version chips report installed, broken and deferred CLI or engine
  state without changing Arco's own build.
  </p>
  <p>
  Open <strong>PROVIDERS</strong> for CLI version chips. A missing CLI and
  an installed executable that fails its version probe are different states:
  the latter is shown as <strong>broken</strong>, with diagnostic detail.
  </p>
  <p>
  For npm CLIs that publish their own platform binary package, Arco checks
  that a matching platform version exists before installing. During an upstream
  publish gap it may select an older installable version or retain the working
  one.
  </p>
  <p>
  A <Code>v... (!)</Code> notice explains this on hover; it does not mean
  the newest advertised version was installed. A post-install probe checks
  that the executable actually runs.
  </p>
  <p>
  Strata's installed engine version comes from its reachable service or
  prepared BUILD.json while stopped. Arco compares engine component
  versions at boot and every four hours; the app/Terminal 0.2 version
  is separate. Click opens release notes inside Arco, like Ollama.
  </p>
  <p>
  Updating Strata is manual and separate from rebuilding Arco. Preserve
  profiles, packs and service limits, then recheck real tools/vision and
  memory after an engine update.
  </p>
  <p>
  XOLOTL tracks its installed source checkout. Click opens recent source
  history inside Arco; equal upstream/installed revisions show UP TO DATE.
  Different revisions show available changes. Source tracking does not prove
  the binary build matches. GitHub is an explicit external link.
  </p>
  <Note kind="warn">Updating a provider CLI changes that provider's installation,
  not Arco's application build. Existing long-lived children may still hold
  the old executable or credentials. Avoid updates during active work and read
  the result before retrying a failed turn.</Note>
  </>,
  },
  {
  id: 'arco-updates',
  group: 'The workspace',
  title: 'Arco releases: check for a newer build',
  body: <>
  <p>
  Arco can report a newer numbered release without downloading or installing
  it automatically.
  </p>
  <p>
  The version box in the top bar, left of the power button, always shows
  the running version. It turns into an accent box with an up arrow and the
  new version when an update is available, and stays that way after the
  notice is dismissed. Clicking it opens the update dialog, or the version
  details when Arco is up to date.
  </p>
  <Sub>Settings row and automatic checks</Sub>
  <p>
  Settings &gt; Advanced &gt; CLI and runtime versions includes an{' '}
  <strong>Arco</strong> row with:
  </p>
  <ul>
  <li>the running version</li>
  <li>the latest known numbered release</li>
  <li><strong>CHECK NOW</strong></li>
  <li>the <strong>Check for new releases</strong> preference</li>
  </ul>
  <p>
  Automatic checks start shortly after boot and repeat every six hours
  unless the preference is off or <Code>ARCO_UPDATE_CHECK=0</Code> is set in
  the server environment. Nothing is downloaded or installed automatically.
  </p>
  <Sub>Updating by install mode</Sub>
  <Table
  headers={['Install mode', 'Update action']}
  rows={[
  ['Packaged user service on Linux, macOS or Windows', <><strong>UPDATE AND RESTART</strong> after confirmation</>],
  ['Linux source user service', <><strong>UPDATE AND RESTART</strong> after confirmation</>],
  ['Other modes', 'A copyable command'],
  ]}
  />
  <p>
  For a packaged service, the action runs the packaged{' '}
  <Code>arco update</Code> path, stops running turns, and reports
  completion or rollback after reconnect. On Windows, the service stop
  targets the matching service command and home configuration; the update
  refuses to proceed if the stop cannot be verified.
  </p>
  <p>
  After a restart, Arco reloads a page automatically if its build changed or
  its session cannot recover and no unsaved work is detected. Otherwise the
  RELOAD banner stays visible. Save drafts and edits before selecting it.
  </p>
  <p>
  See <Code>docs/OPERATIONS.md#updating-arco</Code> for the procedure.
  </p>
  <p>
  When a newer release is found, a toast offers{' '}
  <strong>OPEN RELEASE</strong> (release notes in the browser) and{' '}
  <strong>DISMISS</strong> (remembers that version across reloads). The toast
  also offers the update action. The Settings row offers the same action or
  command.
  </p>
  </>,
  },
  {
  id: 'arco-uninstall',
  group: 'The workspace',
  title: 'Uninstall a package install',
  body: <>
  <p>
  To remove a packaged native install, stop in-flight work, then run{' '}
  <Code>arco service uninstall</Code> and{' '}
  <Code>npm uninstall -g arco-workbench</Code>.
  </p>
  <p>Service uninstall removes:</p>
  <ul>
  <li>
  the per-user service (systemd <Code>arco.service</Code>, launchd{' '}
  <Code>arco-workbench</Code>, or the Windows Task Scheduler task of the
  same name)
  </li>
  <li>the application shortcut</li>
  <li>the package service configuration under the Arco home</li>
  </ul>
  <p>
  <Code>arco shortcuts remove</Code> removes the shortcut separately; npm
  uninstall does not remove it.
  </p>
  <p>
  Deleting the Arco home, per-project <Code>.arco/</Code> folders, or Git
  checkpoint refs <Code>refs/arco/*</Code> is optional and permanent. Those
  steps, with shell and PowerShell commands, are in{' '}
  <Code>docs/OPERATIONS.md#uninstall</Code>. Node.js and provider CLIs with
  their own sign-ins are not removed.
  </p>
  </>,
  },
  {
  id: 'provider-recovery', group: 'Troubleshooting', title: 'Compaction, sign-in and quiet thinking',
  body: <>
  <p>Typing /compact dispatches the available COMPACT action between turns. A busy tab keeps the command draft and asks to wait. Cursor /compress still uses its native handler. Claude CLI-only command hints apply to Claude tabs.</p>
<p>
  These recoveries cover slow Codex compaction, stale Cursor auth children,
  quiet Claude Native thinking, and old Native binding errors.
  </p>
  <Sub>Codex compaction</Sub>
  <p>A large thread can take several minutes to compact. Arco waits for the
  compact turn's completion, not just its summary event. Keep the tab open
  and wait for the result before sending.</p>
  <p>The 10-minute ceiling reports failure and recycles the worker; it never
  reports a timeout as success. A later turn resumes the durable thread.</p>
  <Sub>Cursor asks to sign in despite LIVE auth</Sub>
  <p>The auth
  probe and the long-lived ACP child can disagree after a login change.
  Arco recognizes the stale-child sign-in failure, shows a re-login card,
  and retires the child. Complete login and resend; no failed prompt is
  silently replayed.</p>
  <Sub>Claude Native is quiet</Sub>
  <p>THINKING VISIBILITY controls what the provider streams, not whether
  thinking is retained. Fable/Mythos 5.1 and Opus 5.5 keep thinking and an
  append-only request prefix.</p>
  <p><Code>updates</Code> is a request for short progress notes, not a
  guarantee: a Fable 5.1 acceptance run emitted none. Check
  Activity and worker status before treating silence alone as a failure. On
  Opus 5.5 prefer <Code>summarized</Code>: <Code>omitted</Code> also hides
  its short between-tool notes.</p>
  <Sub>Old Native thinking/server-tool binding errors</Sub>
  <p>Recovery
  guards now protect the latest assistant message and its referenced server-tool
  calls. For a previously wedged Agent tab, restart between turns or use Fold/
  Compact where available to rebuild retained context. Preserve the error text
  for diagnostics if the problem returns; do not delete transcript files.</p>
  </>,
  },
];
