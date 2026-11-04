import { buildClusterNudge } from '@arco/shared';
export { buildClusterNudge } from '@arco/shared';
export const NUDGE_PROMPT = buildClusterNudge();
export const ACTIVE_NUDGE_PROMPT = buildClusterNudge(undefined, true);
