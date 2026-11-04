import type { JobState } from '../stores/appStore.types';

export const COMPUTER_WORKING = 'Computer is working on it…';

// Include the queue/reset boundary: primary_turn_ended alone is too early.
export function computerRequestActive(job?: JobState): boolean {
  return !!job && !!(job.busy || job.computerTurnActive || job.messages.some((m) => m.isStreaming)
    || job.queue?.steering.length || job.queue?.followUp.length);
}

export function computerVoiceStatus(status: string, job?: JobState): string {
  return status === COMPUTER_WORKING && !computerRequestActive(job)
    ? 'Computer is idle. Open COMPUTER to read its response or send a follow-up.'
    : status;
}
