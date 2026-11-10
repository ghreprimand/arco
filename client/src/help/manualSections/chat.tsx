import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Kbd, Note, Sub} from '../../components/UserManual/components';
import { DocRef } from '../../components/help/DocRef';

export const chat: Section[] = [
  {
  id: 'chat-mode', group: 'Workflows & sessions', title: 'Chat - conversation without a project',
  body: <>
  <p>SEND waits for every pending attachment upload, including overlapping paste or drop batches. Completed files stay staged until the message is sent.</p>
  <p>EDIT replaces the draft text and attachments with the selected message. Editing a text-only message clears any staged attachments.</p>
  <p>
  Chat is a plain conversation with a model, with no project attached. Use an
  Agent tab instead when the work needs files, commands or project tools.
  </p>
  <p>
  Open <strong>+ NEW</strong>, choose <strong>CHAT</strong>, pick a name,
  provider and model, then launch.
  </p>
  <p>
  A Chat tab has no project tree, right-hand workbench, skills, CONFIG pane,
  or Review/Handoff/Spawn actions.
  </p>
  <p>
  Supported providers: <strong>Claude, Codex, Cursor, Ollama, llama.cpp,
  LM Studio, Strata and DeepSeek</strong>. The creator only offers providers
  that are enabled, signed in and have models available.
  </p>

  <Sub>Header controls</Sub>
  <ul>
  <li>
  <strong>model</strong> and <strong>effort</strong> change for the next
  message on the same provider. The history carries over.
  </li>
  <li>
  <strong>WEB</strong> turns on web search and fetch, including Native
  <Code>read_url</Code> for public image and document links. Chat has no local
  file or shell tools.
  </li>
  </ul>
  <p>
  WEB is on by default for a saved Chat and off for Incognito. It is available
  on Claude, Codex, Ollama, Strata and DeepSeek.
  </p>
  <p>
  Arco&apos;s direct public-URL reader limits text downloads to 128 KiB and
  image or document sources to 512 MiB before decoding. Private addresses and
  unsafe redirects are refused.
  </p>

  <Sub>Composer</Sub>
  <ul>
  <li><Kbd>Enter</Kbd> sends.</li>
  <li><Kbd>Shift+Enter</Kbd> inserts a newline.</li>
  <li><Kbd>Ctrl+K</Kbd> deletes from the cursor to the end of the line.</li>
  </ul>
  <p>
  The box grows with the message, then scrolls. Attach images or files with
  the <strong>+</strong> button, by pasting, or by dropping them anywhere on
  the window. Arco fits images and extracts text from PDFs, office documents and notebooks before sending. Text-only models receive an image note, and other binaries receive a file note. Incognito chats cannot attach files.
  </p>
  <p>
  While a response is running, the send button becomes{' '}
  <strong>Stop response</strong>.
  </p>

  <Sub>Message actions</Sub>
  <p>Hovering a message offers:</p>
  <ul>
  <li><strong>COPY</strong></li>
  <li><strong>EDIT</strong> on own messages, which returns the text to the composer</li>
  <li>
  <strong>RETRY</strong> on the last answer, which re-sends the message that
  produced it as a new turn
  </li>
  </ul>
  <Note>Chat is not the same as Claude Native's <Code>chat</Code> tool posture.
  That posture belongs to a project Agent and keeps a limited tool set.</Note>
  </>,
  },
  {
  id: 'past-chats', group: 'Workflows & sessions', title: 'Past Chats - reopen saved conversations',
  body: <>
  <p>
  <strong>PAST CHATS</strong> reopens saved Chat conversations. It lives in
  the Chat creator under <strong>+ NEW</strong>, <strong>CHAT</strong>.
  </p>
  <ul>
  <li>
  The list shows newest activity first, with name, last activity, a preview of
  the last message, provider and model.
  </li>
  <li>Click a row to reopen that conversation.</li>
  <li><strong>REFRESH</strong> reloads the list.</li>
  </ul>
  <p>
  This list is separate from the RESUME picker for project sessions.
  </p>
  <p>
  Closing a saved Chat tab removes it from the workbench, not from disk. Saved
  chats are stored under <Code>~/.arco/chats/</Code>.
  </p>
  <p>
  Incognito conversations never appear here.
  </p>
  <Note kind="tip">A load error does not mean the history is empty. Reconnect to
  Arco and refresh before deciding a saved chat is missing.</Note>
  </>,
  },
  {
  id: 'incognito-chat', group: 'Workflows & sessions', title: 'Incognito Chat - privacy and limits',
  body: <>
  <p>
  Incognito Chat keeps a conversation in memory only, and nothing about it is
  saved on this machine. It works only with providers that can turn off local
  saving.
  </p>
  <p>
  Turn on <strong>INCOGNITO CHAT</strong> in the Chat creator{' '}
  <em>before</em> launching. The header then reads <strong>INCOGNITO</strong>{' '}
  and <strong>NOT SAVED</strong>.
  </p>

  <Sub>What is not saved</Sub>
  <p>Arco writes none of the following for an Incognito chat:</p>
  <ul>
  <li>transcript or metadata</li>
  <li>operational log entries or notifications</li>
  <li>worker-registry entries</li>
  <li>chat or draft text in the browser</li>
  </ul>

  <Sub>Providers</Sub>
  <p>
  Supported: <strong>Claude, Codex, Ollama and LM Studio</strong>. These
  four also support standard Chat tabs.
  </p>
  <ul>
  <li><strong>Cursor</strong> is excluded: its CLI cannot turn off session saving.</li>
  <li><strong>llama.cpp</strong> is excluded: its shared server writes a persistent log.</li>
  <li><strong>Strata</strong> and <strong>DeepSeek</strong> are excluded: their service logs and image cache persist.</li>
  </ul>
  <p>
  Incognito controls only what Arco stores. Data sent to a remote provider is
  kept according to that provider's own policy; Incognito does not promise
  provider-side deletion or anonymity.
  </p>

  <Sub>Limits</Sub>
  <ul>
  <li>Attachments are unavailable, because uploads are written to disk.</li>
  <li>Web access is off unless WEB is turned on. A search query leaves the machine.</li>
  <li>
  Model, effort and WEB are the only settings an Incognito chat accepts, and
  none is saved. Other settings are refused.
  </li>
  </ul>
  <Note kind="warn">Closing or refreshing the page, or restarting Arco, loses the
  chat. Past Chats cannot recover it. A brief connection drop of a few seconds
  is tolerated, but that is not a saved session.</Note>
  <p>
  Provider-specific details are in <DocRef>docs/CHAT.md</DocRef>.
  </p>
  </>,
  },
];
