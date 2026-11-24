import { useEffect, useMemo, useRef, useState } from 'react';
import { MANUAL_SECTIONS } from '../../help/manualSections';
import { HELP_CONTENT } from '../../help/helpContent';
import { GROUPS } from './manualTypes';
import { stringifyNode } from './components';
import './manual.css';

const row = { minHeight: 52, width: '100%', padding: '8px 12px', textAlign: 'left' as const, color: 'var(--color-fg)', background: 'transparent', border: 0, borderBottom: '1px solid var(--color-border-hairline)', borderRadius: 0, cursor: 'pointer' };
function containsText(body: Parameters<typeof stringifyNode>[0], query: string): boolean {
  try { return stringifyNode(body).toLowerCase().includes(query); } catch { return false; }
}

export function MobileManualContent({ activeId, onSelect }: { activeId: string | null; onSelect: (id: string | null) => void }) {
  const [query, setQuery] = useState('');
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => { content.current?.closest<HTMLElement>('[data-phone-scroll]')?.scrollTo({ top: 0 }); }, [activeId]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? MANUAL_SECTIONS.filter((section) => section.title.toLowerCase().includes(q) || containsText(section.body, q)) : MANUAL_SECTIONS;
  }, [query]);
  const topics = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return Object.entries(HELP_CONTENT).filter(([, entry]) => entry.title.toLowerCase().includes(q) || containsText(entry.body, q));
  }, [query]);
  const index = MANUAL_SECTIONS.findIndex((section) => section.id === activeId);
  const section = MANUAL_SECTIONS[index];
  const help = activeId?.startsWith('help:') ? HELP_CONTENT[activeId.slice(5)] : undefined;
  if (section || help) return <div ref={content} className="manual-content" style={{ padding: '12px', lineHeight: 1.6, color: 'var(--color-fg)' }}>
    <section>
      <h2 className="display-font" style={{ color: 'var(--color-accent-primary)', fontSize: 15 }}>{section?.title ?? help?.title}</h2>
      {section?.body ?? help?.body}
    </section>
    {section && <nav aria-label="Manual chapters" style={{ display: 'flex', gap: 8, borderTop: '1px solid var(--color-border-hairline)' }}>
      <button type="button" style={row} disabled={index <= 0} onClick={() => onSelect(MANUAL_SECTIONS[index - 1].id)}>PREVIOUS</button>
      <button type="button" style={{ ...row, textAlign: 'right' }} disabled={index >= MANUAL_SECTIONS.length - 1} onClick={() => onSelect(MANUAL_SECTIONS[index + 1].id)}>NEXT</button>
    </nav>}
  </div>;
  return <div style={{ color: 'var(--color-fg)' }}>
    <input type="search" aria-label="Search manual and help" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search manual and help" style={{ width: '100%', boxSizing: 'border-box', minHeight: 44, padding: '8px 12px', color: 'var(--color-fg)', background: 'var(--color-bg-input)', border: '1px solid var(--color-border-hairline)' }} />
    {GROUPS.map((group) => {
      const sections = filtered.filter((item) => item.group === group);
      if (!sections.length) return null;
      return <section key={group}><h2 className="display-font" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--color-fg-muted)' }}>{group}</h2>
        {sections.map((item) => <button key={item.id} type="button" style={row} onClick={() => onSelect(item.id)}>{item.title}</button>)}
      </section>;
    })}
    {topics.length > 0 && <section><h2 className="display-font" style={{ padding: '8px 12px', fontSize: 12 }}>HELP TOPICS</h2>
      {topics.map(([key, entry]) => <button key={key} type="button" style={row} onClick={() => onSelect(entry.manualSection ?? `help:${key}`)}>{entry.title}</button>)}
    </section>}
    {!filtered.length && !topics.length && <p style={{ padding: 12 }}>No matching sections or help topics.</p>}
  </div>;
}
