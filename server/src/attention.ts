// Attention alerts: a turn finished, failed, or is waiting on the operator.
//
// Desktop and phone alerts are opt-in; quiet in-app notices are on by default.
// The server watches workflow messages, applies the preferences, sends the
// phone message through ntfy itself (no hub and no client needed) and tells
// connected browsers with an `attention_event` so each can decide whether to
// raise a desktop notification. Inform-only: nothing here accepts commands.

import { join } from 'path';
import { readFile } from 'fs/promises';
import type { AttentionKind, NotificationChannels, NotificationChannelsView, ServerMessage } from '@arco/shared';
import { DEFAULT_NOTIFICATION_CHANNELS, isValidNtfyTopic, normalizeNtfyServer, sanitizeNotificationChannels } from '@arco/shared';
import { atomicWriteFile } from './atomicFile.js';
import { arcoHome } from './arcoHome.js';
import { environmentNtfyAllowed } from './management/hubGuard.js';
import { broadcastToClients } from './notifications.js';
import * as clusterStore from './clusterStore.js';
import { attentionTitle, isClusterDirector } from '@arco/shared';
import { noticeSourceFor } from './noticeSource.js';

// Desktop and phone finished alerts require a longer turn.
export const MIN_FINISHED_TURN_MS = 15_000;
const TEXT_MAX = 200;

let channelsPath = join(arcoHome(), 'notification-channels.json');
export function _setChannelsPathForTest(p: string): void { channelsPath = p; }
let channels: NotificationChannels = DEFAULT_NOTIFICATION_CHANNELS;
let loaded = false;
let fetchImpl: typeof fetch = fetch;
export function _setFetchForTest(f: typeof fetch): void { fetchImpl = f; }
let idCounter = 0;
const turnStarts = new Map<string, number>();
const lastText = new Map<string, string>();
const lastAlertAt = new Map<string, number>();
const seenRequests = new Set<string>();
function firstSighting(id: string): boolean {
  if (seenRequests.has(id)) return false;
  if (seenRequests.size > 500) seenRequests.clear();
  seenRequests.add(id);
  return true;
}

export async function loadChannels(): Promise<NotificationChannels> {
  try {
    const parsed = JSON.parse(await readFile(channelsPath, 'utf-8'));
    channels = sanitizeNotificationChannels(parsed, typeof parsed?.ntfy?.token === 'string' ? parsed.ntfy.token : undefined);
  } catch { channels = DEFAULT_NOTIFICATION_CHANNELS; }
  loaded = true;
  return channels;
}

export function getChannels(): NotificationChannels { return channels; }

export async function saveChannels(value: unknown): Promise<NotificationChannels> {
  if (!loaded) await loadChannels();
  channels = sanitizeNotificationChannels(value, channels.ntfy.token, channels.ntfy.server);
  await atomicWriteFile(channelsPath, JSON.stringify(channels), { mode: 0o600 });
  return channels;
}

/**
 * The phone address in use: saved settings win; ARCO_NTFY_* still works when
 * none is saved, except on a server whose Arco home is inside the temporary
 * folder (environmentNtfyAllowed in management/hubGuard.ts).
 */
export function resolvePhoneTarget(cfg: NotificationChannels = channels, env: NodeJS.ProcessEnv = process.env): { url: string; token?: string } | null {
  if (cfg.ntfy.topic && isValidNtfyTopic(cfg.ntfy.topic)) {
    const server = normalizeNtfyServer(cfg.ntfy.server);
    if (server) return { url: `${server}/${cfg.ntfy.topic}`, ...(cfg.ntfy.token ? { token: cfg.ntfy.token } : {}) };
  }
  const envUrl = (env.ARCO_NTFY_URL || '').trim();
  if (envUrl && environmentNtfyAllowed(env)) return { url: envUrl, ...((env.ARCO_NTFY_TOKEN || '').trim() ? { token: env.ARCO_NTFY_TOKEN!.trim() } : {}) };
  return null;
}

export function channelsView(cfg: NotificationChannels = channels, env: NodeJS.ProcessEnv = process.env): NotificationChannelsView {
  const { ntfy, ...rest } = cfg;
  const saved = !!(ntfy.topic && isValidNtfyTopic(ntfy.topic));
  const inherited = !saved && !!(env.ARCO_NTFY_URL || '').trim();
  const allowed = !inherited || environmentNtfyAllowed(env);
  return { ...rest, ntfy: { server: ntfy.server, topic: ntfy.topic, tokenSet: !!ntfy.token }, ntfyFromEnvironment: inherited && allowed, ntfyEnvironmentHeldBack: inherited && !allowed };
}

/** True when the phone path will send "finished" itself, so the older notice transport can skip it. */
export function phoneHandlesFinished(): boolean {
  return channels.phone.finished && resolvePhoneTarget() !== null;
}

function ascii(s: string, max = 120, keepEnd = false): string {
  const value = s.replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  if (max <= 3) return '.'.repeat(Math.max(0, max));
  if (!keepEnd) return `${value.slice(0, Math.max(0, max - 3))}...`;
  const start = Math.ceil((max - 3) / 2);
  return `${value.slice(0, start)}...${value.slice(-(max - 3 - start))}`;
}

export async function sendPhone(target: { url: string; token?: string }, title: string, body: string, kind: AttentionKind | 'test'): Promise<{ ok: boolean; error?: string }> {
  const headers: Record<string, string> = {
    Title: ascii(title, 120, true),
    Priority: kind === 'failed' || kind === 'waiting' ? 'high' : 'default',
    Tags: kind === 'failed' ? 'rotating_light' : kind === 'waiting' ? 'raising_hand' : 'white_check_mark',
  };
  if (target.token) headers.Authorization = `Bearer ${target.token}`;
  try {
    const res = await fetchImpl(target.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
    return res.ok ? { ok: true } : { ok: false, error: `The server answered ${res.status}.` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendTest(draft: unknown): Promise<{ ok: boolean; error?: string }> {
  const cfg = sanitizeNotificationChannels(draft, channels.ntfy.token, channels.ntfy.server);
  const target = resolvePhoneTarget(cfg);
  if (!target) return { ok: false, error: 'Enter a server address and a topic first.' };
  return sendPhone(target, 'Arco test', 'This is a test message from Arco. If you can read it, phone notifications work.', 'test');
}

interface WorkflowInfo { name: string; incognito: boolean }

function shouldRaise(kind: AttentionKind, workflowId: string): boolean {
  if (kind !== 'finished' || channels.clusterFinished === 'all') return true;
  const clusterId = clusterStore.getClusterIdForWorkflow(workflowId);
  if (!clusterId) return true;
  return isClusterDirector(clusterStore.getMemberRole(clusterId, workflowId));
}

export function raise(kind: AttentionKind, workflowId: string, info: WorkflowInfo, text?: string, longEnough = true, requestId?: string): void {
  if (info.incognito) return;
  const externalEligible = longEnough && shouldRaise(kind, workflowId);
  const wantDesktop = channels.desktop[kind] && externalEligible;
  const target = channels.phone[kind] && externalEligible ? resolvePhoneTarget() : null;
  // One alert per workflow and kind per few seconds, whatever produced it.
  const key = `${workflowId}:${kind}`;
  const now = Date.now();
  if (!requestId && now - (lastAlertAt.get(key) ?? 0) < 3000) return;
  lastAlertAt.set(key, now);
  const name = noticeSourceFor(workflowId, info.name);
  {
    broadcastToClients({ type: 'attention_event', id: requestId ? `question-${requestId}` : `at_${now.toString(36)}_${(idCounter++).toString(36)}`, kind, workflowId, workflowName: name, desktopEligible: wantDesktop });
  }
  if (target) {
    const body = channels.phoneText && text ? ascii(text, TEXT_MAX) : `Open Arco to see it.`;
    void sendPhone(target, attentionTitle(name, kind), body, kind).then((r) => {
      if (!r.ok) console.warn(`[ntfy] attention push failed: ${r.error}`);
    });
  }
}

/** Feed every workflow-scoped server message through here. Cheap for messages it ignores. */
export function observeAttention(workflowId: string, message: ServerMessage, info: WorkflowInfo): void {
  switch (message.type) {
    case 'primary_turn_started':
      turnStarts.set(workflowId, Date.now());
      lastText.delete(workflowId);
      break;
    case 'primary_text':
      if (channels.phoneText && channels.phone.finished) lastText.set(workflowId, ((lastText.get(workflowId) ?? '') + message.text).slice(-TEXT_MAX * 2));
      break;
    case 'primary_turn_ended': {
      const start = turnStarts.get(workflowId);
      turnStarts.delete(workflowId);
      const text = lastText.get(workflowId);
      lastText.delete(workflowId);
      if (start !== undefined) raise('finished', workflowId, info, text ? text.slice(0, TEXT_MAX) : undefined, Date.now() - start >= MIN_FINISHED_TURN_MS);
      break;
    }
    case 'operator_question':
      if (message.question.status === 'pending' && firstSighting(message.question.requestId)) raise('waiting', workflowId, info, message.question.questions.map((q) => q.question).join(' '), true, message.question.requestId);
      else if (message.question.status !== 'pending' && !info.incognito) broadcastToClients({ type: 'attention_question_closed', requestId: message.question.requestId });
      break;
    case 'gate_required':
      if (firstSighting(message.gateId)) raise('waiting', workflowId, info, message.reason);
      break;
    case 'worker_error':
      raise('failed', workflowId, info, message.error);
      break;
    case 'primary_refusal':
      raise('failed', workflowId, info, message.explanation ?? 'The provider declined the request.');
      break;
    case 'error':
      if (message.workflowId) raise('failed', message.workflowId, info, message.message);
      break;
  }
}
