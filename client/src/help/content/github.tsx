import { C } from './shared';
import type { HelpEntry } from './shared';

export const githubHelp: Record<string, HelpEntry> = {
  // -------------------------------------------------------- GITHUB BROWSER
  'github.tab.code': {
    title: 'Code tab',
    body: <p>Browse the repository's file tree at the current ref. Click a file to view its contents.</p>,
  },
  'github.tab.pulls': {
    title: 'Pull requests',
    body: <p>Open PRs for this repo. Click any to inspect title, body, and diff.</p>,
  },
  'github.tab.issues': {
    title: 'Issues',
    body: <p>Open issues for this repo.</p>,
  },
  'github.tab.runs': {
    title: 'Actions runs',
    body: (
      <p>
        Recent GitHub Actions workflow runs — status, jobs, logs. Useful for
        checking CI status without tabbing to GitHub.
      </p>
    ),
  },
  'github.tab.branches': {
    title: 'Branches',
    body: <p>List of branches. Click any to switch the Code view's ref to that branch.</p>,
  },
  'github.tab.commits': {
    title: 'Commits',
    body: <p>Commit history for the current ref. Click a commit to inspect its diff.</p>,
  },
  'github.pr-create': {
    title: 'New pull request',
    body: (
      <p>
        Open a PR without leaving Arco. Fill in title, base (the branch you
        merge <em>into</em>), head (the branch the changes are <em>on</em>), and
        an optional body, then <C>CREATE PR</C>. The fields are sent as JSON to
        GitHub's REST API — never interpolated into a shell command — so a title
        starting with <C>-</C> is safe. On success you land on the new PR.
      </p>
    ),
  },
  'github.pr-files-diff': {
    title: 'PR file diffs',
    body: (
      <p>
        Each changed file rendered as a real unified diff (toggle UNIFIED /
        SPLIT). Binary or oversized files GitHub can't diff inline show a notice
        row with a link to view on GitHub.
      </p>
    ),
  },
  'github.commit-detail': {
    title: 'Commit detail',
    body: (
      <p>
        Click a commit to see its message, author, and the diff of every file it
        touched — same renderer as the PR file view.
      </p>
    ),
  },
  'github.clone': {
    title: 'Clone repository',
    body: (
      <p>
        Opens a dropdown of ready-to-copy clone commands for this repo —{' '}
        <C>HTTPS</C>, <C>SSH</C>, and a <C>gh repo clone</C> line — each with a
        COPY button. Read-only; Arco does not clone for you.
      </p>
    ),
  },
};
