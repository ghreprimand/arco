import { useEffect, useRef, useState } from 'react';

/** A draft belongs to this mounted control; unmounting discards it. */
export function AutoCompactionThreshold({ label, value, onCommit }: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const pending = useRef<number | null>(null);
  useEffect(() => { pending.current = null; setDraft(null); }, [value]);
  const cancel = () => { pending.current = null; setDraft(null); };
  const commit = () => {
    const next = pending.current;
    cancel();
    if (next !== null && next !== value) onCommit(next);
  };
  return <>
    {draft ?? value}% <input type="range" aria-label={label} min={50} max={95} value={draft ?? value}
      onChange={(event) => { const next = Number(event.target.value); if (Number.isInteger(next) && next >= 50 && next <= 95) { pending.current = next; setDraft(next); } }}
      onPointerUp={commit} onPointerCancel={cancel} onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } }}
      onKeyUp={(event) => { if (event.key !== 'Escape') commit(); }} />
  </>;
}
