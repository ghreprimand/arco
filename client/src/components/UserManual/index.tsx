import { useEffect, useMemo, useRef, useState } from 'react';
import { Panel } from '../primitives/Panel';
import type { Props, Section } from './manualTypes';
import { GROUPS } from './manualTypes';
import { Code, stringifyNode } from './components';
import { MANUAL_SECTIONS } from '../../help/manualSections';
import { HELP_CONTENT } from '../../help/helpContent';
import './manual.css';

// User Manual — operator-facing reference. Structured as a single modal with
// a left-side TOC and a scrolling content area. Content is hand-curated from
// the docs/* deep-dive set, README, and CLAUDE.md but rewritten in
// operator-voice (you, click, the button). Updated when operator-visible
// behavior changes; the docs/ set remains the canonical agent-facing source.

export function UserManual({ onClose }: Props) {
  const [activeId, setActiveId] = useState<string>('welcome');
  const [query, setQuery] = useState('');
  // J4 — when a matched HELP TOPIC has no manualSection, clicking it can't
  // jump into the manual body; we render its title + body inline here instead
  // so the click is never a dead end. Cleared on any manual-section jump.
  const [activeHelpKey, setActiveHelpKey] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Close on Escape — matches the SettingsPanel convention.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The contextual-help popover's "READ MORE IN MANUAL →" button dispatches
  // arco:manual-jump after opening this modal. We listen and scroll.
  useEffect(() => {
    const onJump = (e: Event) => {
      const id = (e as CustomEvent<{ sectionId?: string }>).detail?.sectionId;
      if (!id) return;
      // Defer one frame so the section refs are mounted/measurable.
      requestAnimationFrame(() => {
        setActiveId(id);
        const el = contentRef.current?.querySelector(`#manual-${id}`) as HTMLElement | null;
        if (el && contentRef.current) {
          contentRef.current.scrollTo({ top: el.offsetTop - 12, behavior: 'auto' });
        }
      });
    };
    window.addEventListener('arco:manual-jump', onJump);
    return () => window.removeEventListener('arco:manual-jump', onJump);
  }, []);

  const sections = useMemo<Section[]>(() => MANUAL_SECTIONS, []);

  const filtered = useMemo(() => {
    if (!query.trim()) return sections;
    const q = query.trim().toLowerCase();
    return sections.filter((s) => {
      if (s.title.toLowerCase().includes(q)) return true;
      // Cheap text-content match: serialize ReactNode to string via JSON
      // doesn't traverse children, so we walk via toString of plain bits.
      try {
        const txt = stringifyNode(s.body).toLowerCase();
        return txt.includes(q);
      } catch {
        return false;
      }
    });
  }, [sections, query]);

  // J4 — unified search: also match contextual-help (HELP_CONTENT) entries by
  // title or serialized body, so one box covers both the manual and the
  // at-a-glance help registry. Only computed while a query is active.
  const helpMatches = useMemo<Array<{ key: string; title: string; manualSection?: string }>>(() => {
    if (!query.trim()) return [];
    const q = query.trim().toLowerCase();
    const out: Array<{ key: string; title: string; manualSection?: string }> = [];
    for (const [key, entry] of Object.entries(HELP_CONTENT)) {
      if (entry.title.toLowerCase().includes(q)) {
        out.push({ key, title: entry.title, manualSection: entry.manualSection });
        continue;
      }
      try {
        if (stringifyNode(entry.body).toLowerCase().includes(q)) {
          out.push({ key, title: entry.title, manualSection: entry.manualSection });
        }
      } catch {
        /* skip un-serializable bodies */
      }
    }
    return out;
  }, [query]);

  const scrollTo = (id: string) => {
    setActiveHelpKey(null);
    setActiveId(id);
    const el = contentRef.current?.querySelector(`#manual-${id}`) as HTMLElement | null;
    if (el && contentRef.current) {
      contentRef.current.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' });
    }
  };

  // J4 — clicking a HELP TOPIC result: jump into the manual if it cross-links a
  // section, otherwise render the entry inline (never a dead click).
  const openHelpTopic = (m: { key: string; manualSection?: string }) => {
    if (m.manualSection) {
      scrollTo(m.manualSection);
      return;
    }
    setActiveHelpKey(m.key);
    if (contentRef.current) contentRef.current.scrollTo({ top: 0, behavior: 'auto' });
  };

  const activeHelpEntry = activeHelpKey ? HELP_CONTENT[activeHelpKey] : undefined;

  return (
    <div
      className="help-system-ui manual-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="arco-manual-title"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.78)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9300,
        padding: '20px',
      }}
    >
      <Panel
        className="manual-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '1100px',
          height: '100%',
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-border-hairline)',
          borderRadius: '6px',
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '16px 22px',
            borderBottom: '1px solid var(--color-border-hairline)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px', flexWrap: 'wrap', minWidth: 0 }}>
            <h2
              id="arco-manual-title"
              className="display-font glow-text-bright"
              style={{ fontSize: '14px', letterSpacing: '4px', margin: 0 }}
            >
              ARCO · USER MANUAL
            </h2>
            <span
              style={{
                fontSize: '10px',
                color: 'var(--color-fg-muted)',
                fontFamily: 'var(--font-body)',
              }}
            >
              workflows, controls and recovery
            </span>
          </div>
          <button
            onClick={onClose}
            className="display-font"
            style={{
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              padding: '4px 10px',
            }}
          >
            CLOSE ✕
          </button>
        </div>

        <div className="manual-layout" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* TOC sidebar */}
          <nav
            className="manual-nav"
            aria-label="Manual contents"
            style={{
              width: '260px',
              flexShrink: 0,
              borderRight: '1px solid var(--color-border-hairline)',
              overflowY: 'auto',
              padding: '14px 10px 16px',
              background: 'var(--color-bg-sunken)',
            }}
          >
            <input
              aria-label="Search manual and help"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="display-font"
              style={{
                width: '100%',
                background: 'var(--color-bg-panel)',
                border: '1px solid var(--color-border-hairline)',
                borderRadius: '3px',
                color: 'var(--color-fg)',
                fontSize: '11px',
                letterSpacing: '1px',
                padding: '6px 8px',
                marginBottom: '10px',
                fontFamily: 'inherit',
              }}
            />
            {GROUPS.map((group) => {
              const inGroup = filtered.filter((s) => s.group === group);
              if (inGroup.length === 0) return null;
              return (
                <div key={group} style={{ marginBottom: '12px' }}>
                  <div
                    className="display-font"
                    style={{
                      fontSize: '9px',
                      letterSpacing: '2px',
                      color: 'var(--color-fg-muted)',
                      padding: '4px 8px',
                      textTransform: 'uppercase',
                    }}
                  >
                    {group}
                  </div>
                  {inGroup.map((s) => {
                    const active = activeId === s.id;
                    return (
                      <button
                        key={s.id}
                        onClick={() => scrollTo(s.id)}
                        className="display-font"
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          background: active ? 'var(--color-accent-primary-a10)' : 'transparent',
                          border: 'none',
                          borderLeft: active
                            ? '2px solid var(--color-accent-primary)'
                            : '2px solid transparent',
                          color: active
                            ? 'var(--color-accent-primary)'
                            : 'var(--color-accent-primary-dim)',
                          cursor: 'pointer',
                          fontSize: '11px',
                          letterSpacing: '1px',
                          padding: '5px 8px 5px 10px',
                          fontFamily: 'inherit',
                        }}
                      >
                        {s.title}
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {/* J4 — HELP TOPICS: matched contextual-help entries, below the
                manual-section groups. Only rendered while searching. */}
            {query.trim() && helpMatches.length > 0 && (
              <div style={{ marginBottom: '12px' }}>
                <div
                  className="display-font"
                  style={{
                    fontSize: '9px',
                    letterSpacing: '2px',
                    color: 'var(--color-fg-muted)',
                    padding: '4px 8px',
                    textTransform: 'uppercase',
                  }}
                >
                  Help topics
                </div>
                {helpMatches.map((m) => {
                  const active = activeHelpKey === m.key;
                  return (
                    <button
                      key={m.key}
                      onClick={() => openHelpTopic(m)}
                      className="display-font"
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        background: active ? 'var(--color-accent-primary-a10)' : 'transparent',
                        border: 'none',
                        borderLeft: active
                          ? '2px solid var(--color-accent-primary)'
                          : '2px solid transparent',
                        color: active
                          ? 'var(--color-accent-primary)'
                          : 'var(--color-accent-primary-dim)',
                        cursor: 'pointer',
                        fontSize: '11px',
                        letterSpacing: '1px',
                        padding: '5px 8px 5px 10px',
                        fontFamily: 'inherit',
                      }}
                    >
                      {m.title}
                    </button>
                  );
                })}
              </div>
            )}
            {filtered.length === 0 && helpMatches.length === 0 && (
              <div
                style={{
                  fontSize: '10px',
                  color: 'var(--color-fg-muted)',
                  fontFamily: 'var(--font-body)',
                  padding: '8px',
                }}
              >
                No section or help topic matches "{query}".
              </div>
            )}
          </nav>

          {/* Content */}
          <div
            className="manual-content"
            ref={contentRef}
            style={{
              flex: 1,
              position: 'relative',
              minWidth: 0,
              minHeight: 0,
              overflowY: 'auto',
              padding: '20px 32px 60px',
              fontFamily: 'var(--font-body)',
              fontSize: '13px',
              lineHeight: 1.6,
              color: 'var(--color-fg)',
            }}
          >
            {/* J4 — inline HELP TOPIC panel for a matched entry with no
                manualSection. Pinned above the manual body so the click lands
                somewhere visible. */}
            {activeHelpEntry && (
              <section
                style={{
                  marginBottom: '36px',
                  padding: '14px 16px',
                  border: '1px solid var(--color-accent-primary-dim)',
                  borderLeft: '3px solid var(--color-accent-primary)',
                  borderRadius: '4px',
                  background: 'var(--color-accent-primary-a05)',
                }}
              >
                <div
                  className="display-font"
                  style={{
                    fontSize: '9px',
                    letterSpacing: '2px',
                    color: 'var(--color-fg-muted)',
                    textTransform: 'uppercase',
                    marginBottom: '8px',
                  }}
                >
                  Help topic
                </div>
                <h3
                  className="display-font"
                  style={{
                    fontSize: '13px',
                    letterSpacing: '3px',
                    color: 'var(--color-accent-primary)',
                    margin: '0 0 10px',
                  }}
                >
                  {activeHelpEntry.title.toUpperCase()}
                </h3>
                {activeHelpEntry.body}
              </section>
            )}
            {sections.map((s) => (
              <section key={s.id} id={`manual-${s.id}`} style={{ marginBottom: '36px' }}>
                <h3
                  className="display-font"
                  style={{
                    fontSize: '13px',
                    letterSpacing: '3px',
                    color: 'var(--color-accent-primary)',
                    margin: '0 0 10px',
                    paddingBottom: '6px',
                    borderBottom: '1px solid var(--color-border-hairline)',
                  }}
                >
                  {s.title.toUpperCase()}
                </h3>
                {s.body}
              </section>
            ))}
            <div
              style={{
                marginTop: '40px',
                padding: '12px 16px',
                fontSize: '10px',
                color: 'var(--color-fg-muted)',
                fontFamily: 'var(--font-body)',
                borderTop: '1px solid var(--color-border-hairline)',
                fontStyle: 'italic',
              }}
            >
              Canonical agent-facing reference lives under <Code>docs/</Code> at the repo
              root. This manual is the operator-facing distillation; when the two
              disagree, the docs are authoritative.
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
