import type { UtilityJobResult } from '@arco/shared';

export function describeUtilityFailure(result: UtilityJobResult): string {
  if (result.status === 'not_set') return 'No utility agent is chosen yet.';
  if (result.status === 'timeout' || result.reason === 'timeout') return 'The utility agent did not answer in time.';
  if (result.status === 'cancelled') return 'Cancelled.';
  if (result.reason === 'not_signed_in') return 'Sign in to the utility agent provider and try again.';
  if (result.reason === 'empty_answer') return 'The utility agent returned an empty reply.';
  if (result.reason === 'unreadable_answer' || result.reason === 'non_text_answer' || result.reason === 'output_too_long') return 'The utility agent returned an unreadable reply.';
  const status = /^(?:provider_http_|http_)([1-5][0-9]{2})$/.exec(result.reason ?? '');
  if (status) return `The utility agent provider returned an error (HTTP ${status[1]}).`;
  if (result.reason === 'unavailable') return 'This provider is unavailable for a utility request.';
  return 'The utility agent provider could not complete the request.';
}

export function utilityAttribution(result: UtilityJobResult): string | null {
  if (!result.agent) return null;
  return `${result.status === 'ok' && result.text?.trim() ? 'Answered by' : 'Tried'} ${result.agent.provider.toUpperCase()} / ${result.agent.model}.`;
}
