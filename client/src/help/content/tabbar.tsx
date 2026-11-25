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
  'tabbar.scroll': {
    title: 'Scroll tabs',
    body: <p>Use the mouse wheel over the tab row to scroll sideways. Swipe horizontally on a touch screen or trackpad, or press the Previous tabs and Next tabs edge buttons. An edge button means more tabs are hidden in that direction. Opening a tab brings it into view. Tab focus also keeps its control visible.</p>,
    manualSection: 'tab-bar',
  },
  'tabbar.status': {
    title: 'Tab status',
    body: (
      <p>
        A colored dot on each tab (hover for the word) and the word itself on
        each Continue card on Home. <strong>Needs you</strong> (warning dot):
        a worker waits for an answer or an idle member has mail. The dot pulses
        while work is still running. <strong>Working</strong>: a turn is running.{' '}
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
        Opens the creator: SINGLE WORKFLOW, CHAT, CLUSTER, GENESIS or RESEARCH. Project
        agents need a cwd; Chat does not. Choose provider, model and supported effort.
        Keyboard shortcut: <C>Ctrl/Cmd+K</C> when focus is outside an input or textarea.
      </p>
    ),
    manualSection: 'creating-workflow',
  },
  'tabbar.cluster-close': {
    title: 'Tear down a cluster', manualSection: 'cluster-tab',
    body: <p>The <C>×</C> on a cluster tab opens TEAR DOWN CLUSTER. <C>KEEP MEMBERS WORKING</C> deletes the cluster and leaves each member as an ordinary tab; peer tools drop on its next turn. <C>CLOSE CLUSTER + N MEMBERS</C> also closes every member tab and cancels running turns. Either way the cluster is deleted and cannot be reopened from CLOSED CLUSTERS; saved conversations stay on disk and reopen from PAST CHATS or RESUME. <C>CANCEL</C> keeps everything. A research project has its own close.</p>,
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
    body: <p>Right-clicking a tab opens cluster actions for it. Claude, Codex, Gemini, Ollama and llama.cpp tabs can join a cluster. An open Cursor tab cannot (its session started without the cluster peer tools); create Cursor members with CREATE WITH FRESH from a compatible tab or + ADD FRESH in the cluster panel. The server enforces this refusal too. CREATE WITH EXISTING makes a cluster from this tab and the open tabs ticked in the same folder. ADD TO EXISTING adds this tab to a cluster already working in that folder. CREATE WITH FRESH starts a cluster from this tab plus new workers, with the provider, model, account and effort shown in the picker, including Cursor and Gemini when enabled and connected. Working compatible tabs can join. The dialog identifies them, and a conversation notice explains that cluster tools arrive after the current turn. A steer into that turn warns the agent not to work around missing tools. Claude CLI and Codex exec apply queued input next turn; LM Studio tabs cannot join clusters. The action button names what will happen; CANCEL closes the menu without changes.</p>,
    manualSection: 'cluster-tab',
  },
};
