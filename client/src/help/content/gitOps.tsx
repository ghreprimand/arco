import { C } from './shared';
import type { HelpEntry } from './shared';

// Workbench Expansion I3 — contextual help for the direct local git ops in the
// Changes (Source Control) view. Each key matches a data-help attribute on the
// corresponding control in GitOpsBar / WorkingChangesPanel.
export const gitOpsHelp: Record<string, HelpEntry> = {
  'gitops.stage-file': {
    title: 'Stage file',
    body: <p>Adds this file to the index (<C>git add -- &lt;path&gt;</C>). Staged changes are what the next commit will include.</p>,
  },
  'gitops.unstage-file': {
    title: 'Unstage file',
    body: <p>Removes this file from the index (<C>git reset HEAD -- &lt;path&gt;</C>), leaving the working-tree change intact.</p>,
  },
  'gitops.stage-all': {
    title: 'Stage all',
    body: <p>Stages every change including deletions (<C>git add -A</C>).</p>,
  },
  'gitops.unstage-all': {
    title: 'Unstage all',
    body: <p>Clears the index (<C>git reset HEAD</C>); working-tree changes are untouched.</p>,
  },
  'gitops.commit-message': {
    title: 'Commit message',
    body: <p>The commit subject/body. Committed verbatim — Arco never adds a trailer. Multi-line is fine.</p>,
  },
  'gitops.commit': {
    title: 'Commit',
    body: <p>Commits the staged changes (<C>git commit -m</C>). Enable <em>Amend</em> to rewrite the last commit instead.</p>,
  },
  'gitops.commit-amend': {
    title: 'Amend',
    body: <p>When on, the commit rewrites the previous commit (<C>--amend</C>) rather than creating a new one.</p>,
  },
  'gitops.fetch': {
    title: 'Fetch',
    body: <p>Updates remote-tracking refs (<C>git fetch</C>). Does not change your working tree.</p>,
  },
  'gitops.pull': {
    title: 'Pull',
    body: <p>Fetches and integrates the upstream branch (<C>git pull</C>). May change your working tree.</p>,
  },
  'gitops.push': {
    title: 'Push',
    body: <p>Pushes your commits (<C>git push</C>). Pushing to a protected branch (main/master/release/*/prod/production) prompts for confirmation first.</p>,
  },
  'gitops.push-force': {
    title: 'Force push',
    body: <p>Force-pushes with <C>--force-with-lease</C> (never a bare <C>--force</C>) — refuses to clobber a remote that advanced since your last fetch. Always asks for confirmation.</p>,
  },
  'gitops.stash-save': {
    title: 'Stash',
    body: <p>Saves your working-tree changes onto the stash and reverts to a clean tree (<C>git stash push</C>).</p>,
  },
  'gitops.stash-pop': {
    title: 'Pop stash',
    body: <p>Re-applies the most recent (or selected) stash and removes it from the stash list (<C>git stash pop</C>).</p>,
  },
  'gitops.stash-list': {
    title: 'Stash list',
    body: <p>Lists saved stashes (<C>git stash list</C>).</p>,
  },
  'gitops.branch-name': {
    title: 'Branch / tag name',
    body: <p>The name for a new branch or tag. Validated against git's ref grammar; metacharacters and leading dashes are rejected.</p>,
  },
  'gitops.branch-create': {
    title: 'Create branch',
    body: <p>Creates a branch (<C>git branch</C>) or, with checkout on, creates and switches to it (<C>git switch -c</C>).</p>,
  },
  'gitops.branch-delete': {
    title: 'Delete branch',
    body: <p>Deletes the named branch (<C>git branch -d</C>; force uses <C>-D</C>). Destructive — recoverable via the reflog.</p>,
  },
  'gitops.tag-create': {
    title: 'Create tag',
    body: <p>Creates a tag (<C>git tag</C>; with a message, an annotated tag).</p>,
  },
  'gitops.tag-delete': {
    title: 'Delete tag',
    body: <p>Deletes the named tag (<C>git tag -d</C>).</p>,
  },
};
