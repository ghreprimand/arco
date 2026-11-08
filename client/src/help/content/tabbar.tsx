import { C } from './shared';
import type { HelpEntry } from './shared';

export const tabbarHelp: Record<string, HelpEntry> = {
  // -------------------------------------------------------------- TAB BAR
  'tabbar.tab': {
    title: 'Workflow tab',
    body: (
      <p>
        Click to focus an Agent or Chat tab. A colored status dot appears while work
        is active or needs attention; hover over the tab for its status (see Tab status).
        Click <C>×</C> to close: Arco asks to confirm first, noting when a
        turn is in progress (it will be cancelled) or the tab is an unsaved
        incognito chat. The persisted <C>events.jsonl</C> on disk stays for
        saved workflows. Reopen saved Chats through PAST CHATS, project
        sessions through RESUME. Incognito has no saved history to recover.
      </p>
    ),
    manualSection: 'tab-bar',
  },
  'tabbar.status': {
    title: 'Tab status',
    body: (
      <p>
        A colored dot on each tab (hover for the word) and the word itself on
        each Continue card on Home. <strong>Needs you</strong> (warning dot):
        a worker waits for an answer. <strong>Working</strong>: a turn is running.{' '}
        <strong>New reply</strong>: a turn ended while you were on another tab
        or Home; opening the tab clears it. <strong>Idle</strong> (no dot): nothing is
        running or waiting. A cluster tab combines its members, and Needs you
        wins over Working, which wins over New reply. New reply is kept only
        while this page is open and is not saved.
      </p>
    ),
    manualSection: 'tab-bar',
  },
  'tabbar.waiting-question': {
    title: 'Waiting question',
    body: <p>A worker in this tab is waiting for an answer to a structured question. The tooltip names the worker.</p>,
    manualSection: 'tab-bar',
  },
  'tabbar.new': {
    title: 'New workflow',
    body: (
      <p>
        Opens the creator: SINGLE WORKFLOW, CHAT, CLUSTER or GENESIS. Project
        agents need a cwd; Chat does not. Choose provider, model and supported effort.
        Keyboard shortcut: <C>Ctrl/Cmd+K</C> when focus is outside an input or textarea.
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
  'tabbar.home': {
    title: 'Home',
    body: <p>Opens Home: open work, project locations, bookmarked folders and saved sessions. It stays available when no tab is open and does not close or stop any running work.</p>,
    manualSection: 'home',
  },
  'tabbar.context-menu': {
    title: 'Cluster actions',
    body: <p>Right-clicking a tab opens cluster actions for it. Claude, Codex, Ollama and llama.cpp tabs can join a cluster. An open Cursor tab cannot (its session started without the cluster peer tools); add Cursor members with + ADD FRESH in the cluster panel. The server enforces this refusal too. CREATE WITH EXISTING makes a cluster from this tab and the open tabs ticked in the same folder. ADD TO EXISTING adds this tab to a cluster already working in that folder. CREATE WITH FRESH starts a cluster from this tab plus new workers, with the provider, model, account and effort shown in the picker, including from an Ollama or llama.cpp anchor. The action button names what will happen; CANCEL closes the menu without changes.</p>,
    manualSection: 'cluster-tab',
  },
};
