import { activityToolRequest } from './activity';
import { conditionToolRequest } from './conditions';
import { mailRuleRequest } from './mailRules';
import { readVoiceUsage } from './usage';
import { watchRequest } from './watches';
import { controlComputer } from './computerControl';
import { presetForText, VOICE_MAX_TARGETS, VOICE_MAX_TEXT, type VoiceCommand, type VoiceContext, type VoiceTarget, type VoiceToolCallMessage, type WorkflowConfig } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { requestChatFollow } from '../stores/chatFollowStore';
import type { JobState } from '../stores/appStore.types';
import { readDraft, useDraftStore } from '../stores/draftStore';
import { normaliseVoiceName, resolveVoiceTarget, VOICE_PANELS } from './commands';
import { useVoiceStore } from './store';
import { requestVoicePanel } from './panels';
import { NUDGE_PROMPT, ACTIVE_NUDGE_PROMPT } from '../utils/clusterNudge';
import { ComputerConversation } from './conversation';
import { requestVoiceDialog, VOICE_DIALOGS, type VoiceDialog } from './dialogs';
import { actOnScreen, readScreen, readText } from './screen';
import { HELP_CONTENT } from '../help/content';

export interface VoiceSenders {
  sendMessage: (id: string, content: string, attachments?: string[], kind?: 'steer' | 'follow-up') => boolean;
  cancel: (id: string) => void;
  createWorkflow?: (config: WorkflowConfig) => void;
}

export class VoiceExecutor {
  private aliases = new Map<string, string[]>();
  private history: Array<{ clusterId: string | null; workflowId: string | null }> = [];
  private stopStatusReply: (() => void) | null = null;
  readonly conversation: ComputerConversation;
  constructor(private senders: VoiceSenders, private reply: (text: string, mode?: 'arco' | 'conversation') => void = () => {}) {
    this.conversation = new ComputerConversation(senders, reply);
  }

  context(): VoiceContext {
    const s = useAppStore.getState();
    const currentId = s.activeClusterId ? s.clusterFocusedMember[s.activeClusterId] ?? null : s.activeJobId;
    const targets: VoiceTarget[] = [];
    const memberIds = new Set<string>();
    const clusters = Object.values(s.clusters).sort((a, b) => Number(b.clusterId === s.activeClusterId) - Number(a.clusterId === s.activeClusterId));
    for (const cluster of clusters) {
      targets.push({ id: cluster.clusterId, name: cluster.name || cluster.cwd.split(/[\\/]/).pop() || cluster.clusterId.slice(0, 8), kind: 'cluster', aliases: this.aliases.get(cluster.clusterId) });
      const roleCounts = new Map<string, number>();
      for (const [i, m] of cluster.members.entries()) {
        const roleLabel = m.role ? presetForText(m.role)?.label : undefined;
        const ordinal = roleLabel ? (roleCounts.get(roleLabel) ?? 0) + 1 : 0;
        if (roleLabel) roleCounts.set(roleLabel, ordinal);
        memberIds.add(m.workflowId);
        targets.push({ id: m.workflowId, name: m.displayName, kind: 'member', clusterId: cluster.clusterId,
          role: m.role, aliases: [...(this.aliases.get(m.workflowId) ?? []), `member ${i + 1}`, ...(roleLabel ? [roleLabel, `${roleLabel} ${ordinal}`] : [])].slice(0, 4) });
      }
    }
    for (const job of Object.values(s.jobs)) if (!memberIds.has(job.id) && job.config.kind !== 'cluster' && !job.config.voiceOperator) {
      targets.push({ id: job.id, name: job.config.name || job.id.slice(0, 8), kind: job.config.kind === 'chat' ? 'chat' : 'workflow', aliases: this.aliases.get(job.id) });
    }
    return { currentId, clusterId: s.activeClusterId, targets };
  }

  // One compact line prepended to every Computer utterance (docs/VOICE.md)
  // so the model knows the selection and the open names without a tool call.
  contextLine(): string {
    // 2026-10-17 incident: this line was capped at 480 chars and member role
    // prose ("Director role. Delegate via peer_send, never Task; …") ate the
    // budget, so ATLANTIS-MAINT was never listed and Luna selected the nearest
    // name it could see. Names are the point: every open target is listed,
    // grouped by cluster, with roles reduced to one word.
    const context = this.context();
    const jobs = useAppStore.getState().jobs;
    const visible = context.targets.filter((t) => !jobs[t.id]?.config.incognito && !(jobs[t.id]?.config.kind === 'chat' && jobs[t.id]?.config.voiceOperator));
    const selected = visible.find((t) => t.id === context.currentId);
    const cluster = visible.find((t) => t.id === context.clusterId);
    const role = (t: VoiceTarget) => t.role ? (presetForText(t.role)?.label ?? t.role.split(/[.;:\n]/)[0].replace(/\s+role$/i, '').trim().slice(0, 24)) : '';
    const member = (t: VoiceTarget) => `${t.name}${role(t) ? ` (${role(t)})` : ''}`;
    const groups: string[] = [];
    for (const c of visible.filter((t) => t.kind === 'cluster')) {
      const members = visible.filter((t) => t.kind === 'member' && t.clusterId === c.id).map(member);
      groups.push(`cluster ${c.name}: ${members.join(', ') || 'no members'}`);
    }
    const loose = visible.filter((t) => t.kind === 'workflow' || t.kind === 'chat' || (t.kind === 'member' && !visible.some((c) => c.kind === 'cluster' && c.id === t.clusterId)));
    if (loose.length) groups.push(`workflows: ${loose.map((t) => t.kind === 'chat' ? `${t.name} (chat)` : t.name).join(', ')}`);
    let roster = groups.join('; ');
    if (roster.length > 2400) roster = `${roster.slice(0, 2400)}… (more open; call arco_targets for the full list)`;
    const current = selected ? (selected.kind === 'member' ? `${member(selected)} in cluster ${cluster?.name ?? '?'}` : `${selected.name} [${selected.kind}]`) : 'nothing';
    return `[Arco context] selected: ${current}. Open: ${roster || 'nothing else'}.`;
  }

  interpreterContext(): VoiceContext {
    const context = this.context();
    const jobs = useAppStore.getState().jobs;
    return { ...context, targets: context.targets.filter((t) => !jobs[t.id]?.config.incognito)
      .sort((a, b) => Number(b.id === context.currentId) - Number(a.id === context.currentId))
      .slice(0, VOICE_MAX_TARGETS).map((t) => ({ ...t, name: t.name.slice(0, 120), role: t.role?.slice(0, 120) })) };
  }

  canInterpret(text = ''): boolean {
    const context = this.context();
    const jobs = useAppStore.getState().jobs;
    if (context.currentId && jobs[context.currentId]?.config.incognito) return false;
    const words = ` ${normaliseVoiceName(text)} `;
    return !context.targets.some((t) => jobs[t.id]?.config.incognito
      && [t.id, t.name, ...(t.aliases ?? [])].some((name) => name && words.includes(` ${normaliseVoiceName(name)} `)));
  }

  private select(target: VoiceTarget): void {
    const s = useAppStore.getState();
    this.history.push({ clusterId: s.activeClusterId, workflowId: this.context().currentId });
    if (this.history.length > 20) this.history.shift();
    if (target.kind === 'cluster') s.setActiveCluster(target.id);
    else if (target.clusterId) { s.setActiveCluster(target.clusterId); s.setClusterFocusedMember(target.clusterId, target.id); }
    else s.setActiveJob(target.id);
    const id = target.kind === 'cluster'
      ? s.clusterFocusedMember[target.id] ?? s.clusters[target.id]?.members[0]?.workflowId
      : target.id;
    if (id) requestChatFollow(id);
  }

  private sendMessage(...args: Parameters<VoiceSenders['sendMessage']>): boolean {
    const sent = this.senders.sendMessage(...args);
    if (sent && this.context().currentId === args[0]) requestChatFollow(args[0]);
    return sent;
  }

  private busy(job: JobState): boolean {
    return !!(job.busy || job.messages.some((m) => m.isStreaming)
      || Object.values(job.workers).some((w) => w.status === 'running' || w.status === 'spawning'));
  }

  private target(command: VoiceCommand, membersOnly = false): VoiceTarget | string {
    const context = this.context();
    if (command.value === 'cluster' && ['navigate', 'member'].includes(command.action)) context.targets = context.targets.filter((t) => t.kind === 'cluster');
    const targets = resolveVoiceTarget(command.target, context, membersOnly);
    if (targets.length === 1) return targets[0];
    if (!targets.length) return `No open target is named ${command.target}.`;
    // Computer relays this as its question; the operator answers by name.
    return `Which one: ${targets.slice(0, 6).map((t) => t.name).join(', ')}?`;
  }

  // A cluster cannot be typed into. Luna sometimes addresses one anyway
  // ("ask ORBIT what's going on", smoke 2026-10-17); the operator's own rule
  // is that a question to a cluster goes to its Director, so a cluster with
  // exactly one Director resolves to that member and anything else is an
  // error naming the members for Luna to choose from.
  private clusterVoice(t: VoiceTarget | string): VoiceTarget | string {
    if (typeof t === 'string' || t.kind !== 'cluster') return t;
    const members = this.context().targets.filter((m) => m.clusterId === t.id);
    const directors = members.filter((m) => (m.role ? presetForText(m.role)?.label : undefined) === 'Director' || /\bdirector\b/i.test(m.role ?? '') || /\bdirector\b/i.test(m.name));
    if (directors.length === 1) return directors[0];
    return `${t.name} is a cluster${directors.length ? ' with several Directors' : ' with no Director'}; name one of its members: ${members.map((m) => m.name).join(', ')}.`;
  }

  dictate(text: string): string {
    const id = useVoiceStore.getState().dictatingId;
    if (!id || !useAppStore.getState().jobs[id]) throw new Error('The dictation recipient is no longer available. Draft kept.');
    const previous = readDraft(id);
    const next = previous + (previous && !/\s$/.test(previous) ? ' ' : '') + text;
    if (next.length > VOICE_MAX_TEXT) throw new Error('Voice draft limit reached. Finish or send the existing draft first.');
    useDraftStore.getState().setDraft(id, next);
    return `Dictating to ${this.context().targets.find((t) => t.id === id)?.name ?? 'selected workflow'}. Say “Computer, finish message”, then “End capture” when ready.`;
  }

  private draftTarget(): VoiceTarget | string {
    const id = useVoiceStore.getState().draftId;
    if (id) {
      const t = this.context().targets.find((t) => t.id === id && t.kind !== 'cluster');
      return t ?? 'The draft recipient was removed. The message was not sent.';
    }
    return this.target({ action: 'send', target: '', value: '' }, true);
  }

  async execute(command: VoiceCommand): Promise<string> {
    if (!useVoiceStore.getState().enabled) return 'Hands-free mode is off.';
    const s = useAppStore.getState();
    const voice = useVoiceStore.getState();
    this.stopStatusReply?.();
    if (command.action !== 'choose') useVoiceStore.setState({ choices: [], pendingCommand: null });
    switch (command.action) {
      case 'help':
        if (command.value) return command.value.slice(0, 200);
        s.setShowManual(true);
        return 'Voice help is open. You can switch tabs, dictate a message, or ask for a project update.';
      case 'project-status': {
        const t = command.target ? this.target(command) : this.target({ ...command, target: s.activeClusterId || '' });
        if (typeof t === 'string') return t;
        let recipient = t;
        if (t.kind === 'cluster') {
          const directors = this.context().targets.filter((m) => m.clusterId === t.id
            && (presetForText(m.role ?? '')?.key === 'director' || /^director$/i.test(m.name.trim())));
          if (directors.length !== 1) return `Which member of ${t.name} should I ask? Select one, then ask for a project update.`;
          recipient = directors[0];
        }
        const job = s.jobs[recipient.id];
        if (!s.connected || !job) return 'That worker is unavailable. No status request was sent.';
        if (job.config.kind === 'chat') return 'Select a project workflow or cluster for a project update.';
        if (job.compacting) return 'That workflow is compacting. Please ask again when it is ready.';
        if (readDraft(recipient.id).trim() || s.attachments[recipient.id]?.length) return 'That worker has an unsent draft or attachments. Review them before requesting an update.';
        this.select(recipient);
        const busy = job.busy || job.messages.some((m) => m.isStreaming)
          || Object.values(job.workers).some((w) => w.status === 'running' || w.status === 'spawning');
        if (!busy) this.watchStatusReply(recipient.id);
        const prompt = 'Give me a concise project status update in at most three short sentences: progress, blockers, and next step. Do not start new work.';
        if (!this.sendMessage(recipient.id, prompt, undefined, 'follow-up')) {
          this.stopStatusReply?.(); return 'Disconnected. No status request was sent.';
        }
        return busy ? `${t.name} selected. Status request queued after the current turn.` : `${t.name} selected. Asking ${recipient.name} for an update.`;
      }
      case 'literal':
        return voice.dictatingId ? this.dictate(command.value) : 'Start dictation first, then say Computer, literal, followed by the exact text.';
      case 'choose': {
        const index = Number(normaliseVoiceName(command.value)) - 1;
        const choice = voice.choices[index];
        if (!Number.isInteger(index) || !choice || !voice.pendingCommand) return 'There is no matching pending choice.';
        useVoiceStore.setState({ choices: [], pendingCommand: null });
        return this.execute({ ...voice.pendingCommand, target: choice.id });
      }
      case 'navigate': case 'member': {
        const t = this.target(command);
        if (typeof t === 'string') return t;
        this.select(t); return `${t.name} selected.`;
      }
      case 'back': {
        const previous = this.history.pop();
        if (!previous) return 'There is no previous voice selection.';
        if (previous.clusterId && s.clusters[previous.clusterId]) {
          s.setActiveCluster(previous.clusterId);
          if (previous.workflowId) s.setClusterFocusedMember(previous.clusterId, previous.workflowId);
        } else if (previous.workflowId && s.jobs[previous.workflowId]) s.setActiveJob(previous.workflowId);
        else return 'The previous selection is no longer open.';
        const id = this.context().currentId;
        if (id) requestChatFollow(id);
        return 'Previous selection restored.';
      }
      case 'panel': {
        let panel = normaliseVoiceName(command.value);
        if (!VOICE_PANELS.includes(panel)) return 'That panel is not available. Say Computer, help.';
        const context = this.context();
        const id = context.clusterId || context.currentId;
        if (!id) return 'Select a workflow or cluster first.';
        if (context.clusterId) {
          panel = ({ review: 'reviews', tasks: 'board' } as Record<string, string>)[panel] ?? panel;
          if (!['members', 'files', 'activity', 'reviews', 'handoffs', 'plan', 'board', 'mailbox', 'history', 'preview', 'config', 'github'].includes(panel)) return 'That panel is not available in a cluster.';
        } else {
          panel = ({ reviews: 'review', board: 'ledger' } as Record<string, string>)[panel] ?? panel;
          if (['members', 'mailbox'].includes(panel) || s.jobs[id]?.config.kind === 'chat') return 'That panel is not available in this conversation.';
        }
        requestVoicePanel(id, panel); return `${panel} panel opened.`;
      }
      case 'dictate': {
        const t = this.target(command, true);
        if (typeof t === 'string') return t;
        if (!s.jobs[t.id]) return 'That workflow is still loading. Please try again.';
        useVoiceStore.setState({ dictatingId: t.id, draftId: t.id });
        this.select(t);
        if (command.value) this.dictate(command.value);
        return `Dictating to ${t.name}. Say Computer, finish message, then End capture when ready.`;
      }
      case 'finish':
        useVoiceStore.setState({ dictatingId: null });
        return 'Draft ready. Say Computer, read draft, send now, or send as a follow-up, then End capture.';
      case 'scratch': case 'clear-draft': case 'new-paragraph': case 'replace': {
        const t = this.draftTarget(); if (typeof t === 'string') return t;
        const old = readDraft(t.id);
        let next = old;
        if (command.action === 'clear-draft') next = '';
        else if (command.action === 'new-paragraph') next = old.trimEnd() + '\n\n';
        else if (command.action === 'scratch') next = old.trimEnd().replace(/(?:^|[.!?]\s+)[^.!?]*[.!?]?$/, '').trimEnd();
        else {
          const [from, ...rest] = command.value.split('\n'); const to = rest.join('\n');
          if (!from || !old.includes(from)) return 'That text is not in the draft.';
          if (old.indexOf(from) !== old.lastIndexOf(from)) return 'That text occurs more than once. Use a longer phrase.';
          next = old.replace(from, to);
        }
        if (next.length > VOICE_MAX_TEXT) return 'That change exceeds the voice draft limit.';
        useDraftStore.getState().setDraft(t.id, next); return `Draft updated for ${t.name}.`;
      }
      case 'send': case 'steer': case 'follow-up': {
        if (!s.connected) return 'Disconnected. Your draft has been kept.';
        const t = this.draftTarget(); if (typeof t === 'string') return t;
        if (command.target && resolveVoiceTarget(command.target, this.context(), true).every((target) => target.id !== t.id)) return 'The named recipient differs from the draft recipient. Start a new message to change recipients.';
        if (s.jobs[t.id]?.compacting) return 'This workflow is compacting. Your draft has been kept.';
        const content = readDraft(t.id).trim();
        if (!content) return 'There is no draft to send.';
        const attachments = s.attachments[t.id]?.map((a) => a.path);
        if (!this.sendMessage(t.id, content, attachments?.length ? attachments : undefined, command.action === 'follow-up' ? 'follow-up' : 'steer')) return 'Disconnected. Your draft has been kept.';
        useDraftStore.getState().clearDraft(t.id);
        if (attachments?.length) s.clearAttachments(t.id);
        useVoiceStore.setState({ dictatingId: null, draftId: null });
        return `${command.action === 'follow-up' ? 'Follow-up sent' : 'Message sent'} to ${t.name}.`;
      }
      case 'nudge': {
        if (!s.connected) return 'Disconnected. No nudge was sent.';
        const t = this.target(command, true); if (typeof t === 'string') return t;
        if (!t.clusterId) return 'Mailbox nudges are available for cluster members.';
        const job = s.jobs[t.id]; if (!job) return 'That member is still loading. Please try again.';
        const member = s.clusters[t.clusterId]?.members.find((m) => m.workflowId === t.id);
        const active = member?.status === 'busy' || job.busy || job.messages.some((m) => m.isStreaming)
          || Object.values(job.workers).some((w) => w.status === 'running' || w.status === 'spawning');
        return this.sendMessage(t.id, active ? ACTIVE_NUDGE_PROMPT : NUDGE_PROMPT, undefined, 'steer') ? `Nudged ${t.name}.` : 'Disconnected. No nudge was sent.';
      }
      case 'cancel-turn': {
        if (!s.connected) return 'Disconnected. Cannot cancel the worker.';
        const t = this.target(command, true); if (typeof t === 'string') return t;
        const job = s.jobs[t.id]; if (!job) return 'That worker is unavailable.';
        const queued = (job.queue?.steering.length ?? 0) + (job.queue?.followUp.length ?? 0);
        if (queued) return `This worker has ${queued} queued messages. Use its cancel control to review them before cancelling.`;
        this.senders.cancel(t.id); return `Cancel requested for ${t.name}.`;
      }
      case 'read-draft': {
        const t = this.draftTarget(); if (typeof t === 'string') return t;
        return readDraft(t.id) ? `Draft to ${t.name}. ${readDraft(t.id)}` : 'The draft is empty.';
      }
      case 'read': {
        const t = this.target(command, true); if (typeof t === 'string') return t;
        const job = s.jobs[t.id];
        if (job?.config.incognito) return `${t.name} is Incognito; voice cannot read it.`;
        const messages = [...(job?.messages ?? []), ...(job?.sessionChat ?? [])].sort((a, b) => a.timestamp - b.timestamp);
        const last = [...messages].reverse().find((m) => m.role === 'assistant' && !m.toolUse && m.content.trim());
        return last ? `${t.name}. ${last.content.replace(/```[\s\S]*?```/g, ' Code block omitted. ').slice(0, 4500)}` : 'No assistant response is available.';
      }
      case 'status': {
        // A named target (Computer's arco_status) reports that one thing;
        // the bare command keeps the old selection-wide behaviour.
        if (command.target) {
          const t = this.target(command); if (typeof t === 'string') return t;
          const cluster = t.kind === 'cluster' ? s.clusters[t.id] : null;
          if (cluster) return cluster.members.map((m) => `${m.displayName}: ${m.status}, ${cluster.mailboxDepth[m.workflowId] ?? 0} pending mail`).join('. ');
          return s.jobs[t.id] ? `${t.name} is ${this.busy(s.jobs[t.id]) ? 'active' : 'idle'}.` : `${t.name} is still loading.`;
        }
        const cluster = s.activeClusterId ? s.clusters[s.activeClusterId] : null;
        if (cluster) return cluster.members.map((m) => `${m.displayName}: ${m.status}, ${cluster.mailboxDepth[m.workflowId] ?? 0} pending mail`).join('. ');
        const id = this.context().currentId;
        return id && s.jobs[id] ? `${s.jobs[id].config.name || 'Current workflow'} is ${s.jobs[id].busy ? 'active' : 'idle'}.` : 'No workflow selected.';
      }
      case 'recent': {
        // docs/VOICE.md - Computer's view of a project. Plain prose,
        // newest state first, so a low-effort model can answer "what's going
        // on" without sending the worker a message. Members only: a cluster
        // is summarized by its focused member or must be named.
        const t = this.target(command, true); if (typeof t === 'string') return t;
        const job = s.jobs[t.id];
        if (!job) return `${t.name} is still loading.`;
        if (job.config.incognito) return `${t.name} is Incognito; voice cannot read it.`;
        const now = Date.now();
        const ago = (ts?: number) => { const m = ts ? Math.max(1, Math.round((now - ts) / 60000)) : 0; return m ? `${m} minute${m === 1 ? '' : 's'} ago` : 'just now'; };
        const busy = this.busy(job);
        const lines: string[] = [];
        lines.push(`${t.name}${t.role ? ` (${t.role})` : ''}, ${job.config.kind === 'chat' ? 'chat' : 'agent workflow'} on ${job.config.primaryProvider} ${job.resolvedPrimaryModel || job.config.primaryModel}.`);
        lines.push(busy ? `State: working, turn started ${ago(job.turnStartedAt)}, last activity ${ago(job.lastPrimaryEventAt)}.` : `State: idle${job.lastTurnEndedAt ? `, last turn ended ${ago(job.lastTurnEndedAt)}` : ''}.`);
        const tool = [...job.activity].reverse().find((e) => e.kind === 'tool_use');
        if (tool && busy) lines.push(`Current or latest tool: ${tool.tool}${tool.status ? ` (${tool.status})` : ''}.`);
        const running = Object.values(job.workers).filter((w) => w.status === 'running' || w.status === 'spawning').length;
        if (running) lines.push(`${running} sub-worker${running === 1 ? '' : 's'} running.`);
        const queued = (job.queue?.steering.length ?? 0) + (job.queue?.followUp.length ?? 0);
        if (queued) lines.push(`${queued} operator message${queued === 1 ? '' : 's'} queued.`);
        if (job.plan) lines.push(`Plan: ${job.plan.title}.`);
        if (job.compacting) lines.push('The workflow is compacting its context right now.');
        const mail = t.clusterId ? s.clusters[t.clusterId]?.mailboxDepth[t.id] ?? 0 : 0;
        if (mail) lines.push(`${mail} unread peer message${mail === 1 ? '' : 's'} in its mailbox.`);
        const count = Math.min(12, Math.max(1, parseInt(command.value, 10) || 6));
        const roles: Record<string, string> = { user: 'Operator', assistant: t.name, 'peer-sent': `${t.name} to a peer`, 'peer-received': 'Peer' };
        const recent = [...job.messages, ...job.sessionChat].sort((a, b) => a.timestamp - b.timestamp)
          .filter((m) => roles[m.role] && !m.toolUse && m.content.trim()).slice(-count);
        if (!recent.length) lines.push('No messages yet.');
        else {
          lines.push(`Last ${recent.length} message${recent.length === 1 ? '' : 's'}, oldest first:`);
          for (const m of recent) {
            const text = m.content.replace(/```[\s\S]*?```/g, ' (code omitted) ').replace(/\s+/g, ' ').trim();
            lines.push(`${roles[m.role]}${m.isStreaming ? ' (still writing)' : ''}: ${text.length > 700 ? `${text.slice(0, 700)}…` : text}`);
          }
        }
        return lines.join('\n').slice(0, 6000);
      }
      case 'alias': {
        const id = this.context().currentId || s.activeClusterId;
        if (!id || !command.value.trim()) return 'Select a workflow first, then say Computer, call this, followed by an alias.';
        const alias = command.value.trim().slice(0, 80);
        this.aliases.set(id, [alias]); return `Voice alias ${alias} assigned for this hands-free session.`;
      }
      case 'dialog': {
        // Opens the picker and stops; the operator fills it in. Never a
        // substitute for the action (see dialogs.ts).
        const name = normaliseVoiceName(command.value).replace(/\b(?:dialog|dialogue|box|picker|window|modal|pane|panel)\b/g, ' ').replace(/\s+/g, ' ').trim();
        if (!(VOICE_DIALOGS as readonly string[]).includes(name)) return `There is no ${command.value || 'such'} dialog. Dialogs: ${VOICE_DIALOGS.join(', ')}.`;
        const context = this.context();
        const forCluster = name === 'nudge' || name === 'broadcast';
        if (forCluster && !context.clusterId) return `The ${name} dialog is only available while a cluster is selected.`;
        if (!forCluster && !context.currentId) return 'Select a workflow first.';
        if (!forCluster && context.currentId && s.jobs[context.currentId]?.config.kind === 'chat') return `The ${name} dialog is not available in a chat.`;
        return requestVoiceDialog(name as VoiceDialog, context.currentId, context.clusterId)
          ? `${name} dialog opened. The operator will use it; do nothing further for it.`
          : `The ${name} dialog is not available for the current selection.`;
      }
      case 'global': {
        const name = normaliseVoiceName(command.value);
        if (name === 'settings') s.setShowSettings(true);
        else if (name === 'manual') s.setShowManual(true);
        else if (name === 'recall') s.setShowRecall(true);
        else if (['new', 'new tab', 'new workflow'].includes(name)) s.showJobCreator();
        else if (['focus', 'focus mode'].includes(name)) s.setFocusMode(!s.focusMode);
        else return 'That global control is unavailable.';
        return `${name} opened.`;
      }
      case 'scroll': {
        const node = document.querySelector<HTMLElement>('[data-help="chat.panel"]');
        if (!node) return 'No conversation pane is open.';
        if (command.value === 'top') node.scrollTo({ top: 0, behavior: 'smooth' });
        else if (command.value === 'bottom') node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
        else node.scrollBy({ top: node.clientHeight * (command.value === 'up' ? -0.7 : 0.7), behavior: 'smooth' });
        return '';
      }
      default: return 'That command is unavailable.';
    }
  }

  // docs/VOICE.md - the Computer chat's tools map onto the same bounded
  // actions as direct voice commands. The model composes message text; the
  // executor still resolves targets, refuses ambiguity and guards state.
  async runTool(call: VoiceToolCallMessage): Promise<string> {
    const s = useAppStore.getState();
    const a = call.args;
    switch (call.tool) {
      case 'arco_condition': return conditionToolRequest(call.workflowId,a);
      case 'arco_compact': {
        if(!s.connected||!s.wsSendRaw)throw Error('Disconnected. Compaction was not requested.');
        const t=this.target({action:'status',target:a.target??'',value:''},true);
        if(typeof t==='string')throw Error(t);
        const job=s.jobs[t.id];if(!job||job.config.incognito||job.config.voiceOperator)throw Error('Choose a normal worker.');
        if(this.busy(job)||job.compacting)throw Error('Worker is busy or compacting; wait for idle.');
        const p=job.config.primaryProvider;

        if(p==='codex'&&(job.config.codexTransport??s.settings?.codex?.transport??'exec')!=='appserver')throw Error('Codex compaction needs app-server transport.');
        if(p==='claude'&&(job.config.claudeTransport??s.settings?.claude?.transport??'cli')!=='native')throw Error('Claude compaction needs Native transport.');
        if(p==='ollama')s.wsSendRaw({type:'compact_workflow',workflowId:t.id});
        else await new Promise<void>((resolve,reject)=>{
          const timer=setTimeout(()=>{unsubscribe();reject(Error('Compaction start was not acknowledged. Check the worker; no retry was made.'));},5000);
          const unsubscribe=useAppStore.subscribe((next)=>{const current=next.jobs[t.id];if(current?.busy||current?.compacting){clearTimeout(timer);unsubscribe();resolve();}});
          s.wsSendRaw!({type:'compact_workflow',workflowId:t.id});
        });
        return `Compaction requested for ${t.name}; wait for its completion state. Ollama performs it at the start of the next turn.`;
      }
      case 'arco_usage': return readVoiceUsage(a.provider);
      case 'arco_activity': return activityToolRequest(call.workflowId,a);
      case 'arco_mail_rule': return mailRuleRequest(call.workflowId, a);
      case 'arco_watch': return watchRequest(call.workflowId, a);
      case 'arco_computer': return controlComputer(a);
      case 'arco_targets': {
        const context = this.interpreterContext();
        return JSON.stringify({ selected: context.currentId, cluster: context.clusterId, targets: context.targets.map((t) => ({
          id: t.id, name: t.name, kind: t.kind, cluster: t.clusterId, role: t.role, aliases: t.aliases,
          busy: t.kind === 'cluster' ? undefined : !!(s.jobs[t.id]?.busy || s.jobs[t.id]?.messages.some((m) => m.isStreaming)),
          mail: t.clusterId ? s.clusters[t.clusterId]?.mailboxDepth[t.id] ?? 0 : undefined })) });
      }
      case 'arco_select': return this.execute({ action: 'navigate', target: a.target ?? '', value: '' });
      case 'arco_open_panel': return this.execute({ action: 'panel', target: '', value: a.panel ?? '' });
      case 'arco_send_message': {
        const text = (a.text ?? '').trim();
        if (!text) throw new Error('Empty message.');
        if (!s.connected) throw new Error('Disconnected. Nothing was sent.');
        const t = this.clusterVoice(this.target({ action: 'send', target: a.target ?? 'this', value: '' }));
        if (typeof t === 'string') throw new Error(t);
        const job = s.jobs[t.id];
        if (!job) throw new Error('That workflow is still loading.');
        if (job.config.incognito) throw new Error('That tab is Incognito; voice cannot message it.');
        if (job.compacting) throw new Error('That workflow is compacting. Try again shortly.');
        const mode = a.mode === 'follow-up' ? 'follow-up' : 'steer';
        if (!this.sendMessage(t.id, text, undefined, mode)) throw new Error('Disconnected. Nothing was sent.');
        return `${mode === 'follow-up' ? 'Follow-up queued' : 'Message sent'} to ${t.name}.`;
      }
      case 'arco_nudge': return this.execute({ action: 'nudge', target: a.target ?? '', value: '' });
      case 'arco_cancel_turn': return this.execute({ action: 'cancel-turn', target: a.target ?? '', value: '' });
      case 'arco_read_latest': return this.execute({ action: 'read', target: a.target ?? 'this', value: '' });
      case 'arco_read_recent': return this.execute({ action: 'recent', target: a.target ?? 'this', value: a.messages ?? '' });
      case 'arco_status': return this.execute({ action: 'status', target: a.target ?? '', value: '' });
      case 'arco_open': return this.execute({ action: 'global', target: '', value: a.name ?? '' });
      case 'arco_open_dialog': return this.execute({ action: 'dialog', target: '', value: a.name ?? '' });
      case 'arco_screen': {
        if (typeof document === 'undefined') throw new Error('No screen in this window.');
        return readScreen(document, { helpTitle: (key) => HELP_CONTENT[key]?.title, filter: a.filter || undefined }).text;
      }
      case 'arco_read_text': {
        if (typeof document === 'undefined') throw new Error('No screen in this window.');
        return readText(document, { filter: a.filter || undefined });
      }
      case 'arco_act': {
        if (typeof document === 'undefined') throw new Error('No screen in this window.');
        const action = a.action as import('./screen').ActRequest['action'];
        if (!['click', 'type', 'toggle', 'select', 'press', 'options', 'focus', 'hover', 'double_click', 'context_menu', 'scroll'].includes(action)) throw new Error('Unknown screen action. Inspect the arco_act tool schema.');
        return actOnScreen(document, { control: a.control ?? '', action, text: a.text, confirm: a.confirm === 'true' }, { helpTitle: (key) => HELP_CONTENT[key]?.title });
      }
      // 2026-10-17: a tab left on a pre-rebuild bundle answered "Unknown
      // tool." for arco_screen and Computer asked the operator to close the
      // dialog by hand. Say what is actually wrong.
      default: throw new Error(`This window is running an older Arco build that has no ${call.tool} tool. Tell the operator the page needs a reload (there is a RELOAD banner at the top of the window); do not ask them to do the task by hand.`);
    }
  }

  private watchStatusReply(id: string): void {
    const job = useAppStore.getState().jobs[id];
    const old = new Set([...job.messages, ...job.sessionChat].map((m) => m.id));
    let offApp = () => {}, offVoice = () => {};
    const stop = () => {
      clearTimeout(timer); offApp(); offVoice();
      if (this.stopStatusReply === stop) this.stopStatusReply = null;
    };
    const timer = setTimeout(stop, 120_000); timer.unref?.();
    this.stopStatusReply = stop;
    offVoice = useVoiceStore.subscribe((state) => { if (!state.enabled || state.mode !== 'arco') stop(); });
    offApp = useAppStore.subscribe((state) => {
      const next = state.jobs[id];
      if (!state.connected || !next || this.context().currentId !== id) { stop(); return; }
      if (next.busy || next.messages.some((m) => m.isStreaming)) return;
      const response = [...next.messages, ...next.sessionChat].filter((m) => !old.has(m.id)
        && m.role === 'assistant' && !m.toolUse && !m.isStreaming && m.content.trim()).sort((a, b) => b.timestamp - a.timestamp)[0];
      if (!response) return;
      stop();
      if (useVoiceStore.getState().enabled && useVoiceStore.getState().mode === 'arco') this.reply(response.content.slice(0, 1800), 'arco');
    });
  }
}
