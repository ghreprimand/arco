import type { VoiceCommand, VoiceContext, VoiceTarget } from '@archon/shared';

// Only an explicit first word arms command parsing. No aliases or "hey"
// preamble: incidental speech must not reach the interpreter or executor.
export function voiceCommandBody(text: string): string | null {
  const prefix = text.match(/^\s*computer(?=$|[\s,:;.!?])[\s,:;.!?]*/i);
  return prefix ? text.slice(prefix[0].length).trim() : null;
}

const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
export const normaliseVoiceName = (s: string): string => s.toLowerCase().normalize('NFKD')
  .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, (n) => String(NUMBERS.indexOf(n)))
  .replace(/([a-z])([0-9])/g, '$1 $2').replace(/[^a-z0-9]+/g, ' ').trim();
export const VOICE_PANELS = ['members', 'files', 'activity', 'review', 'reviews', 'research', 'handoffs', 'plan', 'tasks', 'board', 'mailbox', 'history', 'usage', 'preview', 'config', 'github', 'knowledge', 'ledger', 'bakeoff'];

// "stop" joined the list on 2026-10-17: the operator said "Computer… stop"
// to interrupt a reading and nothing matched. It is only ever judged on a
// whole phrase, so a directive containing the word is unaffected.
export const QUIET_PHRASES = ['quiet', 'be quiet', 'stop', 'stop talking', 'stop speaking', 'stop reading'];
export function immediateVoiceControl(body: string): 'quiet' | 'disable' | null {
  const n = normaliseVoiceName(body);
  if (QUIET_PHRASES.includes(n)) return 'quiet';
  if (['disable hands free', 'turn off hands free', 'stop listening'].includes(n)) return 'disable';
  return null;
}

// There is deliberately no deterministic command parser any more (the operator,
// 2026-10-17: "no exact matching going on with anything"). Every directive
// goes to Computer; `immediateVoiceControl` above is the only instant path.

export function resolveVoiceTarget(query: string, context: VoiceContext, membersOnly = false): VoiceTarget[] {
  const targets = context.targets.filter((t) => !membersOnly || t.kind !== 'cluster');
  const byId = targets.filter((t) => t.id === query);
  if (byId.length) return byId;
  // Spoken punctuation ("atlantis hyphen maint") is a separator, like the
  // hyphen itself after normalisation.
  const q = normaliseVoiceName(query).replace(/\b(?:hyphen|dash|underscore|dot|slash)\b/g, ' ').replace(/^(?:the|a) /, '').replace(/\b(?:worker|workflow|tab)\b/g, '').replace(/\s+/g, ' ').trim();
  // Computer phrases the selection the way the operator did ("this project",
  // "the current tab", "it"); all of these mean the selection.
  if (!q || /^(?:this|it|current|the current|this one|this 1|the current one|the current 1|this member|this chat|this project|the project|project|current project|the current project|this tab|the tab|current tab|the current tab|this cluster|the current cluster|selected|the selected one|selection|the selection)$/.test(q)) return targets.filter((t) => t.id === context.currentId);
  const scoped = targets.filter((t) => t.clusterId === context.clusterId);
  const exact = (list: VoiceTarget[]) => list.filter((t) => [t.name, ...(t.aliases ?? []), ...(t.role ? [t.role] : [])].some((name) => normaliseVoiceName(name) === q || normaliseVoiceName(name).replace(/ /g, '') === q.replace(/ /g, ''))
    || (q.length >= 4 && t.id.startsWith(q)));
  const localExact = exact(scoped);
  if (localExact.length) return localExact;
  const allExact = exact(targets);
  if (allExact.length) return allExact;
  // Qualified "reviewer in Atlas" queries are resolved locally rather
  // than trusting a model to invent a workflow id.
  const qualified = q.match(/^(.+?) (?:in|from) (.+)$/);
  if (qualified) {
    const clusters = context.targets.filter((t) => t.kind === 'cluster' && normaliseVoiceName(t.name) === qualified[2]);
    if (clusters.length === 1) return resolveVoiceTarget(qualified[1], { ...context, clusterId: clusters[0].id, targets: targets.filter((t) => t.clusterId === clusters[0].id) }, membersOnly);
  }
  const contains = (list: VoiceTarget[]) => list.filter((t) => [t.name, ...(t.aliases ?? []), t.role ?? ''].some((name) => normaliseVoiceName(name).includes(q)));
  const local = contains(scoped);
  if (local.length) return local;
  const any = contains(targets);
  if (any.length) return any;
  // 2026-10-17 — "atlantus hyphen maint" for ATLANTIS-MAINT: the recognizer
  // spells unfamiliar names phonetically. Tolerate small per-token slips, but
  // only pick a name that is clearly the best; near-ties come back as a list.
  const scored = targets.map((t) => ({ t, score: Math.max(...[t.name, ...(t.aliases ?? [])].map((name) => fuzzyNameScore(q, normaliseVoiceName(name)))) }))
    .filter((x) => x.score >= 0.75).sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  return scored.filter((x) => x.score >= scored[0].score - 0.1).map((x) => x.t);
}

export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// 1 = every spoken token matches a name token exactly; 0.8-0.9 = prefix or a
// slip of up to a quarter of the token; tokens the name lacks pull it down.
export function fuzzyNameScore(spoken: string, name: string): number {
  const qt = spoken.split(' ').filter(Boolean), nt = name.split(' ').filter(Boolean);
  if (!qt.length || !nt.length) return 0;
  const whole = 1 - editDistance(spoken.replace(/ /g, ''), name.replace(/ /g, '')) / Math.max(spoken.length, name.length);
  const perToken = qt.map((a) => Math.max(0, ...nt.map((b) => {
    if (a === b) return 1;
    if (a.length >= 3 && (b.startsWith(a) || a.startsWith(b))) return 0.9;
    return editDistance(a, b) <= Math.max(1, Math.floor(Math.max(a.length, b.length) / 4)) ? 0.8 : 0;
  })));
  const coverage = perToken.reduce((s, v) => s + v, 0) / Math.max(qt.length, nt.length);
  return Math.max(whole, coverage);
}

export const VOICE_HELP = 'Say Computer, then talk normally, and finish with over. Computer either does what you asked in Arco or answers you. Ask what a project is doing, switch tabs, open panels, send a worker a message, nudge or cancel a worker, or just ask a question. Say cancel on its own to discard what you said. Say Computer while it is talking to stop it and wait; stop, quiet and stop listening work immediately.';
