import type { UtilityJobResult } from '@arco/shared';

export function describeUtilityFailure(result: UtilityJobResult): string {
  if (result.status === 'not_set') return 'No utility agent is chosen yet.';
  if (result.status === 'timeout' || result.reason === 'timeout') return 'The utility agent did not answer in time.';
  if (result.status === 'cancelled') return 'Cancelled.';
  if (result.reason === 'not_signed_in') return 'Sign in to the utility agent provider and try again.';
  if (result.reason === 'empty_answer') return 'The utility agent returned an empty reply.';
  const local = /^model_not_loaded_(lmstudio|llamacpp|strata|deepseek)$/.exec(result.reason ?? '');
  if (local) return `The model is not loaded in ${{ lmstudio: 'LM Studio', llamacpp: 'llama.cpp', strata: 'Strata', deepseek: 'DeepSeek' }[local[1] as 'lmstudio' | 'llamacpp' | 'strata' | 'deepseek']}; load it or choose another.`;
  if (result.reason === 'unreadable_answer') return 'The utility agent returned an unreadable reply.';
  if (result.reason === 'non_text_answer') return 'The utility agent returned unsupported non-text content.';
  if (result.reason === 'output_too_long') return 'The utility agent reply was too long or was cut off.';
  const status = /^(?:provider_http_|http_)([1-5][0-9]{2})$/.exec(result.reason ?? '');
  if (status) return `The utility agent provider returned an error (HTTP ${status[1]}).`;
  if (result.reason === 'unavailable') return 'This provider is unavailable for a utility request.';
  return 'The utility agent provider could not complete the request.';
}

export function utilityAttribution(result: UtilityJobResult): string | null {
  if (!result.agent) return null;
  return `${result.status === 'ok' && result.text?.trim() ? 'Answered by' : 'Tried'} ${result.agent.provider.toUpperCase()} / ${result.agent.model}.`;
}
