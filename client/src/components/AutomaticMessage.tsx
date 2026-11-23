import { useState } from 'react';
import type { AutomaticMessageKind } from '@arco/shared';

/** The marker is metadata from the server, never inferred from message text. */
export function AutomaticMessage({ kind, content }: { kind: AutomaticMessageKind; content: string }) {
  const [expanded, setExpanded] = useState(false);
  const firstLine = content.split('\n', 1)[0];
  const researchLabel = /^\(research\) Round \d+ released;/.test(firstLine) ? firstLine.split(';', 1)[0] : firstLine;
  return (
    <div style={{ color: 'var(--color-fg-muted)', fontSize: '12px', lineHeight: 1.5, minWidth: 0 }}>
      <button type="button" data-help="chat.automatic-message" aria-expanded={expanded}
        aria-label={`${expanded ? 'Fold' : 'Expand'} ${kind} message`}
        onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }}
        style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: '2px 5px' }}>
        {expanded ? '-' : '+'}
      </button>
      <span>{kind === 'research' ? researchLabel : kind === 'subagent' ? firstLine : `(${kind}) Peer mail waiting`}</span>
      {expanded && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '4px 8px' }}>{content}</div>}
    </div>
  );
}
