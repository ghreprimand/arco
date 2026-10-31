// Coordination strings are shared with manual nudges; message guards are independent.
import { buildClusterCoordination, buildClusterMailboxNotice, buildMessageGuardPolicy, resolveClusterMessageGuard, type ClusterEfficiencyLevel, type ClusterMessageGuard } from '@arco/shared';

// Legacy-only mapping for omitted metadata; never used to configure new clusters.
export const sendBudgetFor = (level?: ClusterEfficiencyLevel): number => resolveClusterMessageGuard({ efficiencyLevel: level }).threshold;
export function buildDoctrine(level: ClusterEfficiencyLevel = 'thorough', addendum?: string, role?: string, guard?: ClusterMessageGuard): string {
  return [buildClusterCoordination(level, addendum, role), guard ? buildMessageGuardPolicy(guard) : undefined].filter(Boolean).join('\n\n');
}
export type MailboxNoticeVariant = 'full' | 'softened' | 'minimal';
export const mailboxNoticeVariantFor = (level?: ClusterEfficiencyLevel): MailboxNoticeVariant => level === 'lean' ? 'minimal' : level === 'balanced' ? 'softened' : 'full';
export const buildPeerMailboxNotice = buildClusterMailboxNotice;
