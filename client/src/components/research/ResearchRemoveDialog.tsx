import { useEffect, useState } from 'react';
import { DialogShell } from '../DialogShell';
import { touchButton } from './ResearchCloseDialog';

// docs/RESEARCH.md - REMOVE on a researcher card. Earlier reports stay, a
// round in progress is released without it and its private workspace is
// deleted; files it saved but never sent can be moved to the project first.
export function ResearchRemoveDialog({ clusterId, letter, onCancel, onRemove }: {
  clusterId: string;
  letter: string;
  onCancel: () => void;
  onRemove: (moveUnsent: boolean) => void;
}) {
  const [unsent, setUnsent] = useState<number | null>(null);
  const [move, setMove] = useState(true);
  useEffect(() => {
    let live = true;
    fetch(`/api/research/${clusterId}/researchers/${letter}/unsent`)
      .then(async (res) => res.ok ? ((await res.json()) as { unsent: unknown[] }).unsent.length : 0)
      .then((n) => { if (live) setUnsent(n); })
      .catch(() => { if (live) setUnsent(0); });
    return () => { live = false; };
  }, [clusterId, letter]);
  return (
    <DialogShell title={`Remove Researcher ${letter}`} size="confirm" dataHelp="research.remove-researcher" onClose={onCancel}
      actions={<>
        <button type="button" className="display-font" style={touchButton} onClick={onCancel}>CANCEL</button>
        <button type="button" className="display-font" style={{ ...touchButton, color: 'var(--color-warning)' }} disabled={unsent === null} onClick={() => onRemove(move && !!unsent)}>REMOVE</button>
      </>}>
      <p style={{ marginTop: 0 }}>Remove Researcher {letter}? Its earlier reports stay. A round in progress is released without it. Its private workspace is deleted; files it sent stay.</p>
      {!!unsent && <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}>
        <input type="checkbox" style={{ width: 22, height: 22 }} checked={move} onChange={(e) => setMove(e.target.checked)} />
        Move the {unsent} file{unsent === 1 ? '' : 's'} it saved but never sent to the project folder
      </label>}
    </DialogShell>
  );
}
