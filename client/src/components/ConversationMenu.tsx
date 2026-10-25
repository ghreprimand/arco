import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderName, SessionIndexEntry, SessionInfo } from '@arco/shared';
import { entryKey, useSessionIndexStore } from '../stores/sessionIndexStore';

interface Props {
  cwd: string;
  currentSessionId: string;
  disabled: boolean;
  onNew: () => void;
  onResume: (sessionId: string) => void;
  onCompact: () => void;
  onExport?: () => void;
}

type View = 'root' | 'resume-picker';

// §H3 — a merged picker row: a discovered SessionInfo enriched with its
// session-index entry (operator title / subtitle / pin / archive).
interface PickerRow {
  key: string;
  sessionId: string;
  title: string;
  titleSource?: SessionIndexEntry['titleSource'];
  subtitle?: string;
  pinned: boolean;
  archived: boolean;
  lastActive: number;
  providerTag: string;
  provider: ProviderName;
}

// Compact "3h ago" / "2d ago" relative time; falls back to a locale date for
// anything older than ~30 days.
function relativeTime(ts: number): string {
  if (!ts) return 'unknown time';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

// A tiny dim hint distinguishing operator-renamed / AI-titled rows (the whole
// point of §H3 — telling near-identical sessions apart).
function sourceHint(src?: SessionIndexEntry['titleSource']): string {
  if (src === 'operator') return 'edited';
  if (src === 'model') return 'ai';
  return '';
}

export function ConversationMenu({ cwd, currentSessionId, disabled, onNew, onResume, onCompact, onExport }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('root');
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const entries = useSessionIndexStore((s) => s.entries);
  const fetchIndex = useSessionIndexStore((s) => s.fetchIndex);
  const renameEntry = useSessionIndexStore((s) => s.rename);
  const setPinned = useSessionIndexStore((s) => s.setPinned);
  const setArchived = useSessionIndexStore((s) => s.setArchived);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setView('root');
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const openResumePicker = async () => {
    setView('resume-picker');
    // Refresh the index every open (cheap; picks up pins/renames + new turns).
    void fetchIndex(cwd);
    if (!sessions) {
      try {
        const res = await fetch(`/api/sessions?path=${encodeURIComponent(cwd)}`);
        const data = await res.json() as { sessions: SessionInfo[] };
        setSessions(data.sessions);
      } catch {
        setSessions([]);
      }
    }
  };

  const closeMenu = () => { setOpen(false); setView('root'); setRenamingKey(null); };

  const confirmAndRun = (label: string, run: () => void) => {
    if (window.confirm(label)) {
      run();
      closeMenu();
    }
  };

  // Merge SessionInfo + index entry → sort (pinned first, then last-active) →
  // filter (archived hidden unless toggled; query matches title/subtitle/tag).
  const rows = useMemo<PickerRow[]>(() => {
    if (!sessions) return [];
    const q = query.trim().toLowerCase();
    const merged: PickerRow[] = sessions.map((s) => {
      const entry = entries[entryKey(s.provider, s.sessionId)];
      return {
        key: entryKey(s.provider, s.sessionId),
        sessionId: s.sessionId,
        title: entry?.title || s.name || '(unnamed)',
        titleSource: entry?.titleSource,
        subtitle: entry?.subtitle,
        pinned: entry?.pinned === true,
        archived: entry?.archived === true,
        lastActive: entry?.lastActiveAt || s.startedAt,
        providerTag: s.providerAccountShortLabel || s.provider,
        provider: s.provider,
      };
    });
    const filtered = merged.filter((r) => {
      if (r.archived && !showArchived) return false;
      if (!q) return true;
      const hay = `${r.title} ${r.subtitle ?? ''} ${r.providerTag}`.toLowerCase();
      return hay.includes(q);
    });
    return filtered.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.lastActive - a.lastActive;
    });
  }, [sessions, entries, query, showArchived]);

  const archivedCount = useMemo(
    () => (sessions ?? []).filter((s) => entries[entryKey(s.provider, s.sessionId)]?.archived).length,
    [sessions, entries],
  );

  const commitRename = (row: PickerRow) => {
    const v = renameValue.trim();
    setRenamingKey(null);
    if (v && v !== row.title) void renameEntry(cwd, row.provider, row.sessionId, v);
  };

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        data-help="chat.conversation-menu"
        className="display-font"
        title={disabled ? 'Busy — cancel first' : 'Conversation options'}
        style={{
          background: 'transparent',
          border: '1px solid var(--color-border-hairline)',
          borderRadius: '3px',
          color: disabled ? 'var(--color-fg-muted)' : 'var(--color-accent-primary-dim)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: '10px',
          letterSpacing: '1px',
          padding: '4px 8px',
          whiteSpace: 'nowrap',
        }}
      >
        CTX ▾
      </button>
      {open && (
        <div
          className="glow-border"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            minWidth: view === 'resume-picker' ? '380px' : '260px',
            background: 'var(--color-bg-panel)',
            border: '1px solid var(--color-border-bright)',
            borderRadius: '4px',
            zIndex: 100,
            overflow: 'hidden',
          }}
        >
          {view === 'root' && (
            <>
              <MenuItem onClick={() => confirmAndRun('Start a fresh conversation? Current session will be archived.', onNew)}>
                <span>NEW CONVERSATION</span>
                <span style={subStyle}>new session ID</span>
              </MenuItem>
              <MenuItem onClick={openResumePicker}>
                <span>RESUME SESSION…</span>
                <span style={subStyle}>pick from cwd</span>
              </MenuItem>
              <MenuItem
                onClick={() => confirmAndRun(
                  'Compact context? The primary agent will summarize this conversation and start a fresh session seeded with the summary.',
                  onCompact,
                )}
              >
                <span>COMPACT CONTEXT</span>
                <span style={subStyle}>summarize + reset</span>
              </MenuItem>
              {onExport && (
                <MenuItem onClick={() => { onExport(); closeMenu(); }}>
                  <span>EXPORT TRANSCRIPT</span>
                  <span style={subStyle}>download .md</span>
                </MenuItem>
              )}
              <div
                style={{
                  padding: '6px 12px',
                  fontSize: '9px',
                  color: 'var(--color-fg-muted)',
                  borderTop: '1px solid var(--color-border-hairline)',
                  letterSpacing: '1px',
                  fontFamily: 'var(--font-display)',
                }}
              >
                CURRENT: {currentSessionId.slice(0, 8)}
              </div>
            </>
          )}

          {view === 'resume-picker' && (
            <>
              <div
                style={{
                  padding: '8px 12px',
                  borderBottom: '1px solid var(--color-border-hairline)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-accent-primary-dim)' }}>
                  SESSIONS IN CWD
                </span>
                <button
                  onClick={() => setView('root')}
                  className="display-font"
                  style={{ background: 'none', border: 'none', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px' }}
                >
                  ← BACK
                </button>
              </div>

              {/* Search + show-archived toggle */}
              <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border-hairline)', display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter sessions…"
                  data-help="chat.resume-filter"
                  style={{
                    flex: 1,
                    background: 'var(--color-bg-base)',
                    border: '1px solid var(--color-border-hairline)',
                    borderRadius: '3px',
                    color: 'var(--color-fg-default)',
                    fontFamily: 'var(--font-body)',
                    fontSize: '11px',
                    padding: '4px 6px',
                  }}
                />
                {archivedCount > 0 && (
                  <button
                    onClick={() => setShowArchived((v) => !v)}
                    className="display-font"
                    title={showArchived ? 'Hide archived sessions' : `Show ${archivedCount} archived`}
                    style={{
                      background: 'none',
                      border: '1px solid var(--color-border-hairline)',
                      borderRadius: '3px',
                      color: showArchived ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                      cursor: 'pointer',
                      fontSize: '9px',
                      letterSpacing: '0.5px',
                      padding: '3px 6px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {showArchived ? 'HIDE ARCH' : `ARCH ${archivedCount}`}
                  </button>
                )}
              </div>

              {sessions === null && (
                <div style={{ padding: '12px', fontSize: '11px', color: 'var(--color-fg-muted)', fontStyle: 'italic' }}>
                  Loading…
                </div>
              )}
              {sessions && rows.length === 0 && (
                <div style={{ padding: '12px', fontSize: '11px', color: 'var(--color-fg-muted)', fontStyle: 'italic' }}>
                  {sessions.length === 0 ? 'No sessions found for this directory.' : 'No sessions match the filter.'}
                </div>
              )}
              {sessions && rows.length > 0 && (
                <div style={{ maxHeight: '320px', overflowY: 'auto' }}>
                  {rows.map((r) => {
                    const isCurrent = r.sessionId === currentSessionId;
                    const renaming = renamingKey === r.key;
                    const hint = sourceHint(r.titleSource);
                    return (
                      <div
                        key={r.key}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '6px',
                          padding: '6px 8px 6px 12px',
                          borderBottom: '1px solid var(--color-accent-primary-a05)',
                          background: isCurrent ? 'var(--color-accent-primary-a06)' : 'transparent',
                          opacity: r.archived ? 0.55 : 1,
                        }}
                        onMouseEnter={(e) => { if (!isCurrent) (e.currentTarget as HTMLDivElement).style.background = 'var(--color-accent-primary-a10)'; }}
                        onMouseLeave={(e) => { if (!isCurrent) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                      >
                        {/* Pin toggle */}
                        <button
                          onClick={() => void setPinned(cwd, r.provider, r.sessionId, !r.pinned)}
                          title={r.pinned ? 'Unpin' : 'Pin to top'}
                          style={iconBtn(r.pinned ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)')}
                        >
                          {r.pinned ? '★' : '☆'}
                        </button>

                        {/* Main info — click to resume (or rename input) */}
                        {renaming ? (
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename(r);
                              else if (e.key === 'Escape') setRenamingKey(null);
                            }}
                            onBlur={() => commitRename(r)}
                            style={{
                              flex: 1,
                              background: 'var(--color-bg-base)',
                              border: '1px solid var(--color-accent-primary-dim)',
                              borderRadius: '3px',
                              color: 'var(--color-fg-default)',
                              fontFamily: 'var(--font-body)',
                              fontSize: '11px',
                              padding: '3px 5px',
                            }}
                          />
                        ) : (
                          <button
                            onClick={() => { if (!isCurrent) { onResume(r.sessionId); closeMenu(); } }}
                            disabled={isCurrent}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              background: 'transparent',
                              border: 'none',
                              color: isCurrent ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)',
                              cursor: isCurrent ? 'default' : 'pointer',
                              fontFamily: 'var(--font-body)',
                              fontSize: '11px',
                              textAlign: 'left',
                              padding: 0,
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                              {isCurrent && <span style={{ fontSize: '9px', color: 'var(--color-accent-primary)' }}>(current)</span>}
                            </div>
                            {r.subtitle && (
                              <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {r.subtitle}
                              </div>
                            )}
                            <div style={{ fontSize: '9px', color: 'var(--color-fg-muted)', marginTop: '2px', display: 'flex', gap: '6px', letterSpacing: '0.3px' }}>
                              <span style={{ color: 'var(--color-accent-secondary-dim)' }}>{r.providerTag}</span>
                              <span>· {relativeTime(r.lastActive)}</span>
                              {hint && <span>· {hint}</span>}
                            </div>
                          </button>
                        )}

                        {/* Rename + archive */}
                        {!renaming && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                            <button
                              onClick={() => { setRenamingKey(r.key); setRenameValue(r.title); }}
                              title="Rename"
                              style={iconBtn('var(--color-fg-muted)')}
                            >
                              ✎
                            </button>
                            <button
                              onClick={() => void setArchived(cwd, r.provider, r.sessionId, !r.archived)}
                              title={r.archived ? 'Unarchive' : 'Archive (hide)'}
                              style={iconBtn(r.archived ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)')}
                            >
                              {r.archived ? '⊕' : '⊘'}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function iconBtn(color: string): React.CSSProperties {
  return {
    background: 'none',
    border: 'none',
    color,
    cursor: 'pointer',
    fontSize: '12px',
    lineHeight: 1,
    padding: '1px 3px',
  };
}

interface MenuItemProps {
  onClick: () => void;
  children: React.ReactNode;
}

function MenuItem({ onClick, children }: MenuItemProps) {
  return (
    <button
      onClick={onClick}
      className="display-font"
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        width: '100%',
        padding: '8px 12px',
        background: 'transparent',
        border: 'none',
        borderBottom: '1px solid var(--color-border-hairline)',
        color: 'var(--color-accent-primary-dim)',
        cursor: 'pointer',
        fontSize: '11px',
        letterSpacing: '1px',
        textAlign: 'left',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-accent-primary-a08)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

const subStyle: React.CSSProperties = {
  fontSize: '9px',
  color: 'var(--color-fg-muted)',
  letterSpacing: '0.5px',
};
