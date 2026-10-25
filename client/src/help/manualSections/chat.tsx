import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Kbd, Note } from '../../components/UserManual/components';

export const chat: Section[] = [
  {
    id: 'chat-mode', group: 'Workflows & sessions', title: 'Chat — conversation without a project',
    body: <>
      <p>Open <strong>+ NEW → CHAT</strong>, choose a name, provider and model, then
        launch. Chat is a projectless conversation, separate from an Agent workflow.
        It has the transcript and a lightweight composer, without the project tree,
        right-hand workbench, skills, or Review/Handoff/Spawn actions.
        Use an Agent tab for file access, commands or project work.</p>
      <p>Chat supports <strong>Claude, Codex, Z.ai, Cursor, Ollama, llama.cpp,
        LM Studio, Strata and DeepSeek</strong>. Gemini and Antigravity are Agent-only. The creator also
        respects enabled providers, authentication and available models.</p>
      <p>The header carries the live controls: <strong>model</strong> and
        <strong> effort</strong> swap for the next message (same provider — the history
        carries over), and <strong>WEB</strong> arms web search and fetch. Web is the only
        tool a Chat tab ever gets: still no files, no shell, no project. It is on by
        default for a saved Chat, off for Incognito, and available on Claude, Codex, Ollama, Strata and DeepSeek —
        the other Chat providers have no web tool to arm.</p>
      <p><Kbd>Enter</Kbd> sends; <Kbd>Shift+Enter</Kbd> inserts a newline, and
        <Kbd> Ctrl+K</Kbd> deletes from the cursor to the end of the line, as in the Agent
        composer. The box grows with the message before it starts scrolling. Attach images
        or files with <strong>＋</strong>, by pasting them in, or by dropping them anywhere
        on the window; Incognito has no attach button because
        uploads are written to <Code>~/.arco/uploads</Code>. Hovering a message offers
        <strong> COPY</strong>, <strong>EDIT</strong> on your own messages (it goes back to
        the composer) and <strong>RETRY</strong> on the last answer, which re-sends the
        message that produced it as a new turn. While a response is running, the send
        button becomes <strong>Stop response</strong>. Chat does not expose the Agent
        CONFIG pane.</p>
      <Note>Chat is not Claude Native's <Code>chat</Code> tool posture. That posture
        still belongs to a project Agent and retains a limited tool set. A Chat tab
        has no attached project and is configured for conversation-only operation.</Note>
    </>,
  },
  {
    id: 'past-chats', group: 'Workflows & sessions', title: 'Past Chats — reopen saved conversations',
    body: <>
      <p>In <strong>+ NEW → CHAT</strong>, <strong>PAST CHATS</strong> lists saved
        conversations newest-active first, with name, last activity, last-message
        preview, provider and model. Click a row to reopen the original conversation;
        <strong> REFRESH</strong> reloads the list. This is separate from the
        project-based native-session RESUME picker.</p>
      <p>Closing a saved Chat tab removes it from the workbench, not from disk.
        Saved chats use <Code>~/.arco/chats/&lt;wfid&gt;</Code> as a persistence
        directory; the normal nested <Code>.arco/workflows/&lt;wfid&gt;</Code>
        event/meta files live beneath it. This is storage, not a project workspace.</p>
      <p>Incognito conversations never appear here. A load error is not an empty
        history: reconnect to Arco and refresh before concluding a saved chat is missing.</p>
    </>,
  },
  {
    id: 'incognito-chat', group: 'Workflows & sessions', title: 'Incognito Chat — privacy and limits',
    body: <>
      <p>Enable <strong>INCOGNITO CHAT</strong> in the Chat creator <em>before</em>
        launching. The header reads <strong>INCOGNITO · NOT SAVED</strong>. Arco
        keeps the conversation in memory only: no transcript, metadata, operational
        log, notification, worker-registry entry or browser-persisted chat/draft.</p>
      <p>Supported: <strong>Claude, Codex, Z.ai, Ollama and LM Studio</strong>.
        Cursor is excluded because its CLI cannot disable session persistence;
        llama.cpp is excluded because its shared daemon writes a persistent log.
        Strata and DeepSeek are excluded because its service logs and image cache persist.
        Gemini and Antigravity are unavailable in all Chat tabs.</p>
      <p>Codex uses ephemeral exec; Z.ai uses Native; Claude CLI disables session
        persistence. These overrides are privacy constraints, not changes to your
        saved transport defaults. Remote provider retention is governed by that
        provider; Incognito is not a promise of provider-side deletion or anonymity.</p>
      <p>Attachments are unavailable — an upload is written to
        <Code>~/.arco/uploads</Code> and logged there by name. Web access is off unless
        you arm it: a search query leaves the machine. Model, effort and the WEB toggle are
        the only settings an Incognito chat accepts, and none of them is written to disk;
        every other config surface is refused server-side.</p>
      <Note kind="warn">Closing or refreshing the page, or restarting Arco,
        loses the chat. There is no Past Chats recovery. The server's 10-second
        observer-disconnect grace only accommodates a brief connection interruption;
        it is not a saved session or a recovery guarantee.</Note>
    </>,
  },
];
