import { C } from './shared';
import type { HelpEntry } from './shared';

export const tabbarHelp: Record<string, HelpEntry> = {
  // -------------------------------------------------------------- TAB BAR
  'tabbar.tab': {
    title: 'Workflow tab',
    body: (
      <p>
        Click to focus an Agent or Chat tab. A pulse dot appears next to the
        tab name while it is busy (a turn is running); an idle tab shows no dot.
        Click <C>×</C> to close — Arco asks to confirm first, noting when a
        turn is in progress (it will be cancelled) or the tab is an unsaved
        incognito chat. The persisted <C>events.jsonl</C> on disk stays for
        saved workflows. Reopen saved Chats through PAST CHATS, project
        sessions through RESUME. Incognito has no saved history to recover.
      </p>
    ),
    manualSection: 'tab-bar',
  },
  'tabbar.new': {
    title: 'New workflow',
    body: (
      <p>
        Opens the creator: SINGLE WORKFLOW, CHAT, CLUSTER or GENESIS. Project
        agents need a cwd; Chat does not. Choose provider, model and supported effort.
        Keyboard shortcut: <C>Ctrl/Cmd+K</C>.
      </p>
    ),
    manualSection: 'creating-workflow',
  },
  'tabbar.cluster': {
    title: 'Cluster tab',
    body: (
      <p>
        Parent tab for N member workflows sharing one cwd. Click to focus the
        cluster grid; click a member card in the cluster's left pane to focus it.
      </p>
    ),
    manualSection: 'cluster-tab',
  },
};
