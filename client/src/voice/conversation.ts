import { defaultComputerSelection, computerProviderConnected, NO_COMPUTER_AGENT } from '../utils/computerAvailability';
import { activityRequest } from './activity';
import { voiceText, type WorkflowConfig, type ModelName } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useVoiceStore } from './store';
import { useComputerStore, type ComputerSelection } from '../stores/computerStore';
import { registerComputerSwitch, syncComputerDefault, computerCatalogs } from './computerControl';
import { COMPUTER_WORKING } from './computerRequest';

type Selection = { clusterId: string | null; workflowId: string | null };
// docs/VOICE.md - voice replaces the mouse and keyboard. When Computer
// has done what was asked it answers with a bare "Done." (the prompt asks for
// exactly that) and nothing is spoken; the operator reads the result in
// Arco. Anything else (a question back, an answer, an error) is spoken.
export const COMPUTER_SILENT = /^\s*(?:done|ok|okay)[.!]?\s*$/i;
// docs/VOICE.md - the Computer chat is the voice operator: a projectless
// Chat with the arco-voice MCP child. A pre-plan "Computer" chat without
// the flag is not reused (it has no tools); a new one is created beside it.
const matches = (config: WorkflowConfig, selection = useComputerStore.getState().selection) => config.kind === 'chat'
  && config.voiceOperator === true && config.primaryProvider === selection.provider
  && config.primaryModel === selection.model && config.primaryEffort === selection.effort
  && !!config.incognito === (selection.history === 'none');

// Reload restores saved jobs before any utterance opens the voice conversation.
// Bind without creating a chat, enabling the mic or adopting an incognito context.
export function restoreSavedComputer(): void {
  syncComputerDefault();
  const state = useComputerStore.getState();
  if (state.activeId || state.pending || state.selection.history !== 'saved') return;
  const job = Object.values(useAppStore.getState().jobs).find((j) => matches(j.config));
  if (job) useComputerStore.setState({ activeId: job.id });
}

// The saved thread is shown in the header's Computer panel. It never takes
// the workbench selection: tools act on whatever the operator is looking at.
export class ComputerConversation {
  private id: string | null = null;
  private previous: Selection | null = null;
  private stopReply: (() => void) | null = null;
  private opening = false;
  private generation = 0;

  constructor(private senders: {
    createWorkflow?: (config: WorkflowConfig) => void;
    sendMessage: (id: string, text: string) => boolean;
  }, private reply: (text: string, mode?: 'arco' | 'conversation') => void) {
    const unsubscribe = useAppStore.subscribe(() => { if (useComputerStore.getState().pending) void this.applyPending(); });
    registerComputerSwitch((selection) => {
      useComputerStore.setState({ pending: selection, error: null });
      void this.applyPending();
    }, unsubscribe);
  }

  private switching = false;
  private async applyPending(): Promise<void> {
    const state = useComputerStore.getState();
    const current = (state.activeId ? useAppStore.getState().jobs[state.activeId] : undefined)
      ?? Object.values(useAppStore.getState().jobs).find((j) => matches(j.config));
    if (current && !state.activeId) useComputerStore.setState({ activeId: current.id });
    if (!state.pending || this.switching || this.opening || current?.computerTurnActive || current?.busy || current?.messages.some((m) => m.isStreaming)
      || current?.queue?.steering.length || current?.queue?.followUp.length) return;
    this.switching = true;
    const selection = state.pending;
    const oldId = this.id ?? current?.id;
    try {
      // A parked provider must not keep spending on background agent updates.
      // Conditions remain armed; the new agent opts into its own update feed.
      if (oldId && current && !matches(current.config,selection)) await activityRequest(oldId,{action:'configure',agent_updates:'off'});
      await this.chat(new AbortController().signal, selection);
      // An Incognito context is never parked for later retrieval.
      if (oldId && oldId !== this.id && useAppStore.getState().jobs[oldId]?.config.incognito) {
        useAppStore.getState().wsSendRaw?.({ type: 'remove_workflow', workflowId: oldId });
        useAppStore.getState().removeJob(oldId);
      }
      if (selection.history === 'none') useVoiceStore.setState({ lastHeard: '', commandText: null });
    } catch (e) { useComputerStore.setState({ pending: null, error: e instanceof Error ? e.message : 'Computer switch failed.' }); }
    finally { this.switching = false; }
  }

  // The chat id the voice tool bridge should answer for (null until opened).
  get chatId(): string | null { return this.id; }

  // Send one utterance to Computer. `context` is the compact [Arco context]
  // line the executor builds (selection + roster) so the model rarely needs
  // arco_targets. Replies come back through `watchReply` → `reply`.
  async talk(text: string, signal: AbortSignal, context = ''): Promise<string> {
    signal.throwIfAborted();
    syncComputerDefault();
    const app = useAppStore.getState();
    if (app.authStatus && !defaultComputerSelection(app.authStatus, app.settings?.enabledProviders ?? {}, computerCatalogs())) return NO_COMPUTER_AGENT;
    if (app.authStatus && !computerProviderConnected(useComputerStore.getState().selection.provider, app.authStatus, app.settings?.enabledProviders)) return 'This Computer agent is not connected. Choose a connected agent or open Connections.';
    if (this.switching || useComputerStore.getState().pending) return 'Computer is changing agents. Please wait before the next request.';
    if (this.opening) return 'Computer is opening. Please wait before the next request.';
    const generation = ++this.generation;
    const before = useAppStore.getState();
    if (!before.connected) return 'Disconnected. No Computer message was sent.';
    const restore = { clusterId: before.activeClusterId, workflowId: before.activeClusterId
      ? before.clusterFocusedMember[before.activeClusterId] ?? null : before.activeJobId };
    this.opening = true;
    let id: string;
    try { id = await this.chat(signal); } finally { this.opening = false; }
    signal.throwIfAborted();
    if (generation !== this.generation) return 'Computer opening cancelled. No request was sent.';
    const s = useAppStore.getState();
    const job = s.jobs[id];
    if (!job || !matches(job.config)) return 'The Computer chat changed or closed. No message was sent.';
    // Compatibility with clients that selected newly-created Computer chats.
    if (s.activeJobId === id && (restore.workflowId || restore.clusterId)) {
      if (restore.clusterId && s.clusters[restore.clusterId]) {
        s.setActiveCluster(restore.clusterId);
        if (restore.workflowId) s.setClusterFocusedMember(restore.clusterId, restore.workflowId);
      } else if (restore.workflowId && s.jobs[restore.workflowId]) s.setActiveJob(restore.workflowId);
    }
    useVoiceStore.setState({ dictatingId: null });
    if (!text) return 'Computer is ready.';
    if (job.busy || job.messages.some((m) => m.isStreaming)) return 'Computer is still working on the last request. Please wait.';
    if (s.attachments[id]?.length) return 'Computer has staged attachments. Review them in its composer before sending.';
    this.watchReply(id, signal);
    if (!this.senders.sendMessage(id, voiceText(context ? `${context}\n\n${text}` : text))) { this.stopReply?.(); return 'Disconnected. No Computer message was sent.'; }
    return '';
  }

  back(): string {
    ++this.generation;
    this.stopReply?.();
    useVoiceStore.setState({ mode: 'arco', dictatingId: null });
    const s = useAppStore.getState();
    const previous = this.previous;
    this.previous = null;
    if (previous?.clusterId && s.clusters[previous.clusterId]) {
      s.setActiveCluster(previous.clusterId);
      if (previous.workflowId && s.clusters[previous.clusterId].members.some((m) => m.workflowId === previous.workflowId)) {
        s.setClusterFocusedMember(previous.clusterId, previous.workflowId);
      }
    } else if (previous?.workflowId && s.jobs[previous.workflowId]) s.setActiveJob(previous.workflowId);
    else if (previous) return 'Arco control. The previous tab has closed; select another workflow.';
    return 'Arco control.';
  }

  private async chat(signal: AbortSignal, selection = useComputerStore.getState().selection): Promise<string> {
    const s = useAppStore.getState();
    if (this.id && s.jobs[this.id] && matches(s.jobs[this.id].config, selection)) { useComputerStore.getState().select(selection, this.id); return this.id; }
    const existing = Object.values(s.jobs).filter((job) => matches(job.config, selection));
    if (existing.length) { this.id = existing[0].id; useComputerStore.getState().select(selection, this.id); return this.id; }
    if (!this.senders.createWorkflow) throw new Error('Computer conversation is unavailable in this window.');
    const known = new Set(Object.keys(s.jobs));
    return new Promise<string>((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (id?: string, error?: string) => {
        clearTimeout(timer); unsubscribe(); signal.removeEventListener('abort', abort);
        if (id) { this.id = id; useComputerStore.getState().select(selection, id); resolve(id); } else reject(new Error(error));
      };
      const abort = () => finish(undefined, 'Computer opening cancelled. No question was sent.');
      const timer = setTimeout(() => finish(undefined, 'Computer did not open. No question was sent. Check Arco for an error.'), 10_000);
      unsubscribe = useAppStore.subscribe((next) => {
        if (!next.connected) { finish(undefined, 'Disconnected while opening Computer.'); return; }
        const created = Object.values(next.jobs).filter((job) => !known.has(job.id) && matches(job.config, selection));
        if (created.length > 1) finish(undefined, 'Multiple Computer chats opened. No question was sent.');
        else if (created.length === 1) finish(created[0].id);
      });
      signal.addEventListener('abort', abort, { once: true });
      try {
        this.senders.createWorkflow!({ kind: 'chat', name: 'Computer', primaryProvider: selection.provider,
          primaryModel: selection.model as ModelName, primaryEffort: selection.effort, codexTransport: 'appserver', claudeTransport: 'native', incognito: selection.history === 'none',
          chatWebAccess: false, voiceOperator: true, skipPermissions: false, workingDirectory: '' });
      } catch { finish(undefined, 'Could not open Computer. No question was sent.'); }
    });
  }

  private watchReply(id: string, signal: AbortSignal): void {
    this.stopReply?.();
    const job = useAppStore.getState().jobs[id];
    const old = new Set([...job.messages, ...job.sessionChat].map((m) => m.id));
    let unsubscribe = () => {};
    const stop = () => { clearTimeout(timer); unsubscribe(); signal.removeEventListener('abort', stop); if (this.stopReply === stop) this.stopReply = null; };
    const timer = setTimeout(stop, 360_000);
    this.stopReply = stop;
    signal.addEventListener('abort', stop, { once: true });
    unsubscribe = useAppStore.subscribe((s) => {
      const next = s.jobs[id];
      if (!s.connected || !next || !matches(next.config)) { stop(); return; }
      if (next.busy || next.computerTurnActive || next.queue?.steering.length || next.queue?.followUp.length) return;
      const response = [...next.messages, ...next.sessionChat].filter((m) => !old.has(m.id)
        && (m.role === 'assistant' || (m.role === 'system' && m.content.startsWith('[ERROR] ')))
        && !m.isStreaming && !m.toolUse && m.content.trim()).sort((a, b) => b.timestamp - a.timestamp)[0];
      if (!response) return;
      stop();
      if (!signal.aborted && useVoiceStore.getState().enabled) {
        if (COMPUTER_SILENT.test(response.content)) { useVoiceStore.setState({ status: 'Done.' }); return; }
        // Playback can be deferred by capture or muted. The request has still
        // finished, so its working status must not depend on speech delivery.
        if (useVoiceStore.getState().status === COMPUTER_WORKING) {
          useVoiceStore.setState({ status: 'Computer replied. Open COMPUTER to read its response.' });
        }
        // Computer replies are spoken in the ordinary control mode; there is
        // no separate conversation mode any more (docs/VOICE.md).
        this.reply(voiceText(response.content.replace(/^\[ERROR\] (?:\[COMPUTER TIMEOUT\] )?/, '').replace(/```[\s\S]*?```/g, ' Code block omitted. '), 4500), 'arco');
      }
    });
  }
}
