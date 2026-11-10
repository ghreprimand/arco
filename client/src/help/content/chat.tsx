import { C } from './shared';
import type { HelpEntry } from './shared';

export const chatHelp: Record<string, HelpEntry> = {
  'creator.chat-mode': {
    title: 'Chat: no project', manualSection: 'chat-mode',
    body: <p>A conversation without project tools or the Agent workbench. Supports
      Claude, Codex, Cursor, Ollama, llama.cpp, LM Studio, Strata and DeepSeek. Choose a model
      here; use an Agent tab for project files, commands and project actions. Saved Chat supports image/file attachments.</p>,
  },
  'creator.incognito': {
    title: 'Incognito Chat', manualSection: 'incognito-chat',
    body: <p>Memory-only in Arco: no saved transcript, metadata, operational logs,
      notifications or browser-persisted chat. Closing, refreshing or restarting
      loses it. Cursor, llama.cpp, Strata and DeepSeek cannot meet this boundary and are excluded.
      Provider-side retention remains provider-controlled.</p>,
  },
  'creator.past-chats': {
    title: 'Past Chats', manualSection: 'past-chats',
    body: <p>Saved conversations, newest-active first. Click a row to reopen its
      original history and model configuration; <C>REFRESH</C> reloads the list.
      Closing a saved tab does not delete its history. Incognito chats never appear.</p>,
  },
  'chat.mode-status': {
    title: 'Chat status', manualSection: 'chat-mode',
    body: <p>The provider, model, effort, web access and saved/incognito state for this
      projectless conversation. Model and effort swap live and apply to the next message;
      the provider stays pinned. This is distinct from an Agent's limited <C>chat</C> tool posture.</p>,
  },
  'chat.model': {
    title: 'Chat model', manualSection: 'chat-mode',
    body: <p>Swap the model for the next message without leaving the conversation. Same
      provider only: the history carries over. Reasoning effort clamps to what the new
      model honours. Strata's prepared profiles load on the next message,
      one profile at a time, after any current Strata turn and tools finish.</p>,
  },
  'chat.effort': {
    title: 'Chat effort', manualSection: 'chat-mode',
    body: <p>Reasoning depth for the next message. Only the levels the active model
      actually honours are listed. Strata offers NONE / LOW / MEDIUM / HIGH; NONE disables reasoning and HIGH maps to Qwen xhigh.</p>,
  },
  'chat.web': {
    title: 'Chat web access', manualSection: 'chat-mode',
    body: <p>Arms web search and fetch for this chat, including Native <C>read_url</C> for public file links.
      No local file tools, no shell, no project. On by default for a saved Chat, off for Incognito
      (a search query leaves the machine). Available on Claude, Codex, Ollama, Strata and DeepSeek; other Chat providers have
      no web tool to arm. Takes effect on the next message. Local fast fetch reads up
      to 128 KiB before HTML extraction, cancels the remaining download and reports truncation.</p>,
  },
  'chat.attach': {
    title: 'Attach to chat', manualSection: 'chat-mode',
    body: <p>Attach images or files to the next message; you can also paste them straight
      into the composer or drop them anywhere on the window. Arco fits images and extracts text from PDFs, office documents and notebooks, including chats without file tools. Text-only models receive an image note; other binaries receive a file note. Uploads are saved on disk (the <C>uploads</C> folder in the Arco home for a package install, in the checkout for a source run), so Incognito chats
      have no attach button. SEND stays blocked until every overlapping upload batch finishes.</p>,
  },
  'chat.input': {
    title: 'Chat composer', manualSection: 'chat-mode',
    body: <p><C>Enter</C> sends, <C>Shift+Enter</C> adds a newline, <C>Ctrl+K</C> kills
      to end of line; the box grows with your
      message and then scrolls. Accepts text plus attachments (not in Incognito); skills and
      project actions stay Agent-only. Send is disabled while a response is running; use
      Stop response to cancel it. SEND also waits for all pending attachment uploads.</p>,
  },
  'chat.send': {
    title: 'Send message', manualSection: 'chat-mode',
    body: <p>Send a message to the selected Chat provider. Requires text or an attachment.
      Incognito responses remain memory-only in Arco. All attachment uploads must finish first.</p>,
  },
  'chat.stop': {
    title: 'Stop response', manualSection: 'chat-mode',
    body: <p>Cancel the current response. This does not erase messages already shown
      or delete a saved conversation.</p>,
  },
};
