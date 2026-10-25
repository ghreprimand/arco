import { useEffect, useState } from 'react';
import type { JobState } from '../stores/appStore.types';
import { useAppStore } from '../stores/appStore';
import { useDraftStore } from '../stores/draftStore';
import { useComputerStore } from '../stores/computerStore';
import { computerRequestActive } from '../voice/computerRequest';
import { allowComputerTextTools } from '../voice/toolBridge';

export function ComputerComposer({ job, onSend }: {
  job: JobState;
  onSend: (id: string, text: string) => boolean;
}) {
  const draft = useDraftStore((s) => s.drafts[job.id] ?? '');
  const connected = useAppStore((s) => s.connected);
  const pending = useComputerStore((s) => s.pending);
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const busy = computerRequestActive(job);
  useEffect(() => {
    if (sentAt === null) return;
    if (busy || (job.lastTurnEndedAt ?? 0) >= sentAt) { setSentAt(null); return; }
    const timer = setTimeout(() => {
      setSentAt(null); setError('Computer has not acknowledged the request. Check the transcript before sending again.');
    }, 10_000);
    return () => clearTimeout(timer);
  }, [busy, job.lastTurnEndedAt, sentAt]);
  const submit = () => {
    if (!draft.trim() || !connected || busy || pending || sentAt !== null) return;
    const revoke = allowComputerTextTools(job.id);
    if (!onSend(job.id, draft.trim())) {
      revoke(); setError('Disconnected. Your message was kept and was not sent.'); return;
    }
    setSentAt(Date.now()); useDraftStore.getState().clearDraft(job.id); setError(null);
  };
  return <form aria-label="Message Computer" onSubmit={(event) => { event.preventDefault(); submit(); }}
    style={{ padding: '10px 18px', borderTop: '1px solid var(--color-border-hairline)', flexShrink: 0 }}>
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
      <textarea aria-label="Message to Computer" placeholder="Type a request, correction, or answer to Computer…"
        rows={2} value={draft} onChange={(event) => useDraftStore.getState().setDraft(job.id, event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
        }} style={{ flex: 1, minWidth: 0, maxHeight: 120, resize: 'vertical', background: 'var(--color-bg-panel)',
          color: 'var(--color-fg)', border: '1px solid var(--color-border-hairline)', padding: 8, font: 'inherit' }} />
      <button type="submit" disabled={!connected || busy || !!pending || sentAt !== null || !draft.trim()}
        style={{ padding: '7px 12px', color: 'var(--color-accent-primary)', background: 'transparent', border: '1px solid var(--color-border-hairline)' }}>SEND</button>
    </div>
    <div role="status" style={{ color: 'var(--color-fg-muted)', fontSize: 11, marginTop: 5 }}>
      {error ?? (!connected ? 'Disconnected. Draft kept.' : busy ? 'Computer is processing. Stop the request before sending a correction.'
        : sentAt !== null ? 'Request sent. Waiting for Computer to acknowledge it.'
        : pending ? 'Waiting for the agent change.' : 'Same conversation as voice. Enter to send · Shift+Enter for a new line. Microphone can stay off.')}
    </div>
  </form>;
}
