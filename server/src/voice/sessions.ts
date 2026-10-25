import { randomUUID } from 'node:crypto';
import { DEFAULT_VOICE_OUTPUT, isVoiceOutputId, VOICE_MAX_TARGETS, VOICE_MAX_TEXT, type VoiceContext, type VoiceInterpretResult } from '@archon/shared';
import { interpretWithLuna } from './luna.js';
import { LocalRecognizer } from './localRecognizer.js';

export const VOICE_EDGE_VOICE = process.env.ARCHON_VOICE_EDGE_VOICE || DEFAULT_VOICE_OUTPUT;

export function resolveOutputVoice(value: unknown): string {
  if (value == null) return VOICE_EDGE_VOICE;
  if (!isVoiceOutputId(value)) throw new Error('Choose a listed output voice.');
  return value;
}

const LEASE_MS = 45_000;
export interface VoiceSession {
  id: string;
  controller: AbortController;
  recognizer: LocalRecognizer;
  speaker: LocalRecognizer;
  // VOICE_AGENT_PLAN.md — Edge neural voice; null once it has failed this session.
  edgeSpeaker: LocalRecognizer | null;
  edgeVoice: string;
  waker: LocalRecognizer;
  waking: boolean;
  wakeUtterance: number;
  expires: number;
  interpreting: boolean;
  transcribing: boolean;
  calls: number[];
}
const sessions = new Map<string, VoiceSession>();

export function endVoiceSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  session.controller.abort(); session.recognizer.stop(); session.speaker.stop(); session.edgeSpeaker?.stop(); session.waker.stop();
}
export function getVoiceSession(id: string): VoiceSession {
  const session = sessions.get(id);
  if (!session || session.expires <= Date.now()) {
    endVoiceSession(id); throw new Error('Voice session expired. Enable hands-free mode again.');
  }
  return session;
}
export function startVoiceSession(outputVoice?: unknown): VoiceSession {
  const edgeVoice = resolveOutputVoice(outputVoice);
  for (const [id, s] of sessions) if (s.expires <= Date.now()) endVoiceSession(id);
  if (sessions.size >= 2) throw new Error('Hands-free mode is already open in two windows.');
  const session: VoiceSession = { id: randomUUID(), controller: new AbortController(), recognizer: new LocalRecognizer(), speaker: new LocalRecognizer(true), edgeSpeaker: new LocalRecognizer(true, edgeVoice),
    edgeVoice,
    waker: new LocalRecognizer(false, 'emma', true), waking: false, wakeUtterance: -1,
    expires: Date.now() + LEASE_MS, interpreting: false, transcribing: false, calls: [] };
  sessions.set(session.id, session);
  return session;
}
export function selectSessionOutputVoice(session: VoiceSession, value: unknown): void {
  const voice = resolveOutputVoice(value);
  if (session.edgeVoice === voice) return;
  session.edgeSpeaker?.stop();
  session.edgeVoice = voice;
  session.edgeSpeaker = new LocalRecognizer(true, voice);
}
export function renewVoiceSession(id: string): void { getVoiceSession(id).expires = Date.now() + LEASE_MS; }
const sweep = setInterval(() => {
  for (const [id, s] of sessions) if (s.expires <= Date.now()) endVoiceSession(id);
}, 5000);
sweep.unref();
process.once('exit', () => { for (const id of sessions.keys()) endVoiceSession(id); });

export function parseVoiceContext(value: unknown): VoiceContext {
  if (!value || typeof value !== 'object') throw new Error('Invalid voice context.');
  const c = value as VoiceContext;
  if (!Array.isArray(c.targets) || c.targets.length > VOICE_MAX_TARGETS) throw new Error('Too many voice targets. Narrow the selection.');
  const short = (v: unknown): v is string => typeof v === 'string' && v.length <= 160;
  if (![c.currentId, c.clusterId].every((v) => v === null || short(v))) throw new Error('Invalid current voice target.');
  const targets = c.targets.map((t) => {
    if (!t || !short(t.id) || !short(t.name) || !['workflow', 'chat', 'cluster', 'member'].includes(t.kind)) throw new Error('Invalid voice target.');
    if (t.clusterId !== undefined && !short(t.clusterId)) throw new Error('Invalid cluster.');
    if (t.role !== undefined && !short(t.role)) throw new Error('Invalid role.');
    if (t.aliases !== undefined && (!Array.isArray(t.aliases) || t.aliases.length > 4 || !t.aliases.every(short))) throw new Error('Invalid aliases.');
    return { id: t.id, name: t.name, kind: t.kind, clusterId: t.clusterId, role: t.role, aliases: t.aliases };
  });
  const context = { targets, currentId: c.currentId, clusterId: c.clusterId };
  if (JSON.stringify(context).length > 12_000) throw new Error('Voice roster is too large. Narrow the selection.');
  return context;
}

export async function interpretVoice(session: VoiceSession, text: unknown, context: VoiceContext, signal: AbortSignal,
  interpret = interpretWithLuna): Promise<VoiceInterpretResult> {
  if (typeof text !== 'string' || !text.trim() || text.length > VOICE_MAX_TEXT) throw new Error('Invalid voice command text.');
  if (session.interpreting) throw new Error('A voice command is already being interpreted.');
  session.calls = session.calls.filter((t) => Date.now() - t < 60_000);
  if (session.calls.length >= 12) throw new Error('Luna command limit reached. Use direct commands or wait a minute.');
  session.interpreting = true; session.calls.push(Date.now());
  try { return await interpret(text, context, signal); }
  finally { session.interpreting = false; }
}
