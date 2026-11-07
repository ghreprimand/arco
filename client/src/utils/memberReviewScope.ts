import type { ReviewContextRef } from '@arco/shared';

export function memberReviewScopeSupported(ref: ReviewContextRef): boolean {
  return ref.kind === 'last-turn' || ref.kind === 'last-n';
}
export const MEMBER_REVIEW_SCOPE_REASON = 'This scope needs SUB-WORKER to resolve the selected plan or saved transcript accurately.';
