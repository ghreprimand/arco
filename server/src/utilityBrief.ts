// BRIEF jobs: a short synopsis of a worker or a cluster, written from facts the
// client collected from visible state. The facts are bounded and cleaned here;
// the instructions are fixed text. Nothing here acts on a worker.
import {
  UTILITY_BRIEF_LABEL_MAX, UTILITY_BRIEF_MAX_FACTS, UTILITY_BRIEF_VALUE_MAX,
  type UtilityBriefScope, type UtilityJobFact,
} from '@arco/shared';

const COMMON = [
  'You write a status brief for the operator of a coding workbench.',
  'Use only the facts given. If something is not in the facts, write "not visible" for it; never guess.',
  'Do not give advice, do not propose actions, and do not address the worker.',
  'Plain text only, no markdown, no lists.',
].join(' ');

export const BRIEF_INSTRUCTIONS: Record<UtilityBriefScope, string> = {
  worker: `${COMMON} Write two or three plain sentences about this one worker: what it is doing now (name the current step and how long it has run), the state of the last operator message, and anything waiting on the operator. When the facts say the worker is thinking with no actions, say so and give the duration.`,
  cluster: `${COMMON} Write one line per member, in the form "Name: state, current step, anything pending". After the member lines write one line starting "Waiting on the operator:" naming each member that has a pending question or is blocked, or "nobody" when none is.`,
};

export function parseBriefFacts(raw: unknown): UtilityJobFact[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > UTILITY_BRIEF_MAX_FACTS) return null;
  const out: UtilityJobFact[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const { label, value } = item as Record<string, unknown>;
    if (typeof label !== 'string' || typeof value !== 'string' || !label.trim()) return null;
    out.push({
      label: label.replace(/\s+/g, ' ').trim().slice(0, UTILITY_BRIEF_LABEL_MAX),
      value: value.replace(/\s*\n\s*/g, ' / ').trim().slice(0, UTILITY_BRIEF_VALUE_MAX),
    });
  }
  return out;
}
