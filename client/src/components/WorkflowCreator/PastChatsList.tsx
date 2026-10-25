import { useEffect, useState } from 'react';
import type { SavedChatSummary, WorkflowConfig } from '@archon/shared';

interface Props {
  onReopen: (config: WorkflowConfig) => void;
}

function relativeTime(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function PastChatsList({ onReopen }: Props) {
  const [chats, setChats] = useState<SavedChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/chats');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { chats?: SavedChatSummary[] };
      setChats(Array.isArray(body.chats) ? body.chats.filter((chat) => !chat.config.voiceOperator) : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  return (
    // The creator scrolls as a whole; shrinking this clipped flex item hides its rows.
    <div data-help="creator.past-chats" style={{ flexShrink: 0, border: '1px solid var(--color-border-hairline)', borderRadius: '6px', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 12px', background: 'var(--color-bg-elevated, transparent)' }}>
        <div className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '1.5px' }}>PAST CHATS</div>
        <button type="button" onClick={() => void load()} disabled={loading} className="display-font" style={{ border: 0, background: 'transparent', color: 'var(--color-accent-secondary)', cursor: loading ? 'default' : 'pointer', fontSize: '9px', letterSpacing: '1px' }}>
          {loading ? 'LOADING…' : 'REFRESH'}
        </button>
      </div>
      {error ? (
        <div style={{ padding: '12px', color: 'var(--color-danger)', fontSize: '11px' }}>Could not load saved chats: {error}</div>
      ) : !loading && chats.length === 0 ? (
        <div style={{ padding: '14px 12px', color: 'var(--color-fg-muted)', fontSize: '11px' }}>No saved chats yet.</div>
      ) : (
        <div style={{ maxHeight: '250px', overflowY: 'auto' }}>
          {chats.map((chat) => (
            <button
              type="button"
              key={chat.workflowId}
              onClick={() => onReopen(chat.config)}
              style={{ width: '100%', display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 14px', padding: '11px 12px', textAlign: 'left', border: 0, borderTop: '1px solid var(--color-border-hairline)', background: 'transparent', color: 'var(--color-fg-primary)', cursor: 'pointer' }}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px' }}>{chat.name}</span>
              <span className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '9px' }}>{relativeTime(chat.lastActiveAt)}</span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-fg-muted)', fontSize: '10px' }}>
                {chat.lastUserPreview || 'No messages yet'}
              </span>
              <span className="display-font" style={{ color: 'var(--color-accent-secondary)', fontSize: '9px' }}>
                {chat.primaryProvider.toUpperCase()} · {chat.primaryModel}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
