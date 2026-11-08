import { C } from './shared';
import type { HelpEntry } from './shared';

// Workbench Expansion I3: contextual help for the direct local git ops in the
// Changes (Source Control) view. Each key matches a data-help attribute on the
// corresponding control in GitOpsBar / WorkingChangesPanel.
export const gitOpsHelp: Record<string, HelpEntry> = {
  'gitops.stage-file': {
    title: 'Stage file',
    body: <><p>Adds this file to the index (<C>git add -- &lt;path&gt;</C>). Staged changes are what the next commit will include.</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.unstage-file': {
    title: 'Unstage file',
    body: <><p>Removes this file from the index (<C>git reset HEAD -- &lt;path&gt;</C>), leaving the working-tree change intact.</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.stage-all': {
    title: 'Stage all',
    body: <><p>Stages every change including deletions (<C>git add -A</C>).</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.unstage-all': {
    title: 'Unstage all',
    body: <><p>Clears the index (<C>git reset HEAD</C>); working-tree changes are untouched.</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.commit-message': {
    title: 'Commit message',
    body: <><p>Enter a commit message in the single-line field. Arco passes it to Git without adding a trailer.</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.commit': {
    title: 'Commit',
    body: <><p>Commits the staged changes (<C>git commit -m</C>). Enable <em>Amend</em> to rewrite the last commit instead.</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.commit-amend': {
    title: 'Amend',
    body: <><p>When on, the commit rewrites the previous commit (<C>--amend</C>) rather than creating a new one.</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.fetch': {
    title: 'Fetch',
    body: <><p>Updates remote-tracking refs (<C>git fetch</C>). Does not change your working tree.</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.pull': {
    title: 'Pull',
    body: <><p>Fetches and integrates the upstream branch (<C>git pull</C>). May change your working tree.</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.push': {
    title: 'Push',
    body: <><p>Pushes your commits (<C>git push</C>). Pushing to a protected branch (main/master/release/*/prod/production) prompts for confirmation first.</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.push-force': {
    title: 'Force push',
    body: <><p>Force-pushes with <C>--force-with-lease</C> (never a bare <C>--force</C>): refuses to clobber a remote that advanced since your last fetch. Always asks for confirmation.</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.stash-save': {
    title: 'Stash',
    body: <><p>Saves tracked working-tree changes to the stash with <C>git stash push</C>. Untracked files remain in the working tree.</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.stash-pop': {
    title: 'Pop stash',
    body: <><p>Re-applies the most recent stash and removes it from the stash list when successful (<C>git stash pop</C>).</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.stash-list': {
    title: 'Stash list',
    body: <><p>Lists saved stashes (<C>git stash list</C>).</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.branch-name': {
    title: 'Branch / tag name',
    body: <><p>The name for a new branch or tag. Validated against git's ref grammar; metacharacters and leading dashes are rejected.</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.branch-create': {
    title: 'Create branch',
    body: <><p>Creates a branch (<C>git branch</C>) or, with checkout on, creates and switches to it (<C>git switch -c</C>).</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.branch-delete': {
    title: 'Delete branch',
    body: <><p>Deletes the named branch (<C>git branch -d</C>; force uses <C>-D</C>). Destructive: recoverable via the reflog.</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.tag-create': {
    title: 'Create tag',
    body: <><p>Creates a tag (<C>git tag</C>; with a message, an annotated tag).</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
  'gitops.tag-delete': {
    title: 'Delete tag',
    body: <><p>Deletes the named tag (<C>git tag -d</C>).</p><p>Search and Git views use the workflow folder or a selected worktree registered with its repository. Unrelated or unavailable selections show an error; requests never silently switch to the main tree. Project document actions require a folder known to Arco.</p></>,
  },
};
