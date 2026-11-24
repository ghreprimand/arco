// docs/CLIENT.md "Mobile view" - the MEMBERS page on a phone: one row per
// member with its name, role and state. A tap opens the member's sheet over
// the page: open its conversation, its model, effort and web access (CONFIG),
// and the workbench's own member controls (rename, role, focus, work size,
// REPLACE, DETACH with its confirmation).

import { useState, type ReactNode } from 'react';
import { presetForText } from '@arco/shared';
import type { ClusterStatePayload } from '@arco/shared';
import { PhoneBottomSheet } from '../../layout/PhoneBottomSheet';

type Member = ClusterStatePayload['members'][number];

const sheetRow = {
  display: 'flex', alignItems: 'center', width: '100%', minHeight: '52px', padding: '0 14px', textAlign: 'left' as const,
  background: 'transparent', border: 0, borderBottom: '1px solid var(--color-border-hairline)', borderRadius: 0,
  color: 'var(--color-fg)', fontSize: '14px', letterSpacing: '1px', cursor: 'pointer',
};

export function PhoneMemberList({ cluster, nameOf, onOpenConversation, onOpenConfig, renderManage }: {
  cluster: ClusterStatePayload;
  nameOf: (workflowId: string) => string;
  onOpenConversation?: (workflowId: string) => void;
  onOpenConfig: (workflowId: string) => void;
  renderManage: (member: Member) => ReactNode;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const member = cluster.members.find((m) => m.workflowId === open);
  if (cluster.members.length === 0) return <div style={{ padding: '8px 2px', fontSize: '15px', color: 'var(--color-fg-muted)' }}>No members yet. Use + to add one.</div>;
  return (
    <div data-testid="phone-members" data-help="cluster.phone-members" style={{ display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--color-border-hairline)', margin: '0 -12px' }}>
      {cluster.members.map((m) => {
        const role = m.role ? presetForText(m.role)?.label ?? m.role : '';
        const busy = m.status === 'busy';
        return (
          <button key={m.workflowId} type="button" data-testid="phone-member-row" onClick={() => setOpen(m.workflowId)} aria-haspopup="dialog"
            style={{ ...sheetRow, minHeight: '60px', gap: '10px', letterSpacing: 0, fontFamily: 'var(--font-body)' }}>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span className="display-font" style={{ fontSize: '14px', letterSpacing: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.displayName}</span>
              {role && <span style={{ fontSize: '13px', color: 'var(--color-fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{role}</span>}
            </span>
            <span className="display-font" style={{ fontSize: '12px', letterSpacing: '1px', color: busy ? 'var(--color-warning)' : 'var(--color-accent-primary)' }}>{busy ? 'WORKING' : 'IDLE'}</span>
            <span aria-hidden="true" style={{ color: 'var(--color-accent-primary)' }}>{'\u203A'}</span>
          </button>
        );
      })}
      {member && (
        <PhoneBottomSheet local title={nameOf(member.workflowId)} onClose={() => setOpen(null)} testId="phone-member-sheet">
          {onOpenConversation && <button type="button" className="display-font" data-testid="phone-member-open" style={sheetRow} onClick={() => { setOpen(null); onOpenConversation(member.workflowId); }}>OPEN CONVERSATION</button>}
          <button type="button" className="display-font" data-testid="phone-member-config" style={sheetRow} onClick={() => { setOpen(null); onOpenConfig(member.workflowId); }}>MODEL, EFFORT AND WEB ACCESS</button>
          <div style={{ padding: '10px' }}>{renderManage(member)}</div>
        </PhoneBottomSheet>
      )}
    </div>
  );
}
