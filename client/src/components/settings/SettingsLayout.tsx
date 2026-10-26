import { createContext, isValidElement, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Panel } from '../primitives/Panel';
import { useAppStore } from '../../stores/appStore';
import { useStartupStore } from '../../stores/startupStore';
import { settingsHelp } from '../../help/content/settings';
import { SETTINGS_PAGES, SETTINGS_SECTIONS, settingsHash, settingsMatches, settingsSection, type SettingsPage } from './navigation';
import './settings.css';

// The Settings dialog (P3.4): category list, search across every section, a
// scope label and contextual help per section, #settings/<page>/<section>
// deep links. Sections stay mounted while hidden, so drafts and open editors
// survive switching categories.

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join(' ');
  return isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
}
const helpText = (key: string) => `${settingsHelp[key]?.title ?? ''} ${text(settingsHelp[key]?.body)}`;
const Visibility = createContext<ReadonlySet<string>>(new Set());

// Opens Settings when the address changes to #settings/... .
export function useSettingsDeepLinks(): void {
  useEffect(() => {
    const open = () => {
      const target = settingsHash(window.location.hash);
      if (!target) return;
      useStartupStore.getState().setSettingsSection(target.section?.id ?? `page:${target.page}`);
      useAppStore.getState().setShowSettings(true);
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, []);
}

export function SettingsSection({ id, children }: { id: string; children: ReactNode }) {
  const visible = useContext(Visibility).has(id);
  const section = settingsSection(id);
  if (!section) return null;
  return (
    <section id={`settings-${section.id}`} data-settings-section={section.id} hidden={!visible} className="settings-section">
      <div className="settings-section-meta">
        <span className="settings-scope" data-settings-scope>{section.scope}</span>
        <details className="settings-section-help">
          <summary>About this setting<span className="settings-visually-hidden">: {section.label}</span></summary>
          {section.help.map((key) => settingsHelp[key] && <div key={key}>{settingsHelp[key].body}</div>)}
        </details>
      </div>
      {children}
    </section>
  );
}

function resolveRequest(request: string | null): { page: SettingsPage; focus?: string } | undefined {
  if (!request) return undefined;
  if (request.startsWith('page:')) {
    const page = SETTINGS_PAGES.find((p) => `page:${p.id}` === request);
    return page ? { page: page.id } : undefined;
  }
  const section = settingsSection(request);
  return section ? { page: section.page, focus: request.replace(/^settings\./, '') } : undefined;
}

// `unavailable` names sections whose control is not shown in the current
// configuration (a Classic theme has no Phosphor controls, for example).
export function SettingsLayout({ onClose, children, unavailable = {} }: { onClose: () => void; children: ReactNode; unavailable?: Record<string, boolean> }) {
  const requested = useStartupStore((s) => s.settingsSection);
  const clearRequest = useStartupStore((s) => s.setSettingsSection);
  const initial = resolveRequest(requested);
  const [page, setPage] = useState<SettingsPage>(initial?.page ?? 'appearance');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [focus, setFocus] = useState<string | null>(initial?.focus ?? null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const dialog = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const searching = query.trim().length > 0;
  const matched = SETTINGS_SECTIONS.filter((s) => !unavailable[s.id] && (searching ? settingsMatches(s, query, helpText) : s.page === page));
  const visible = new Set(matched.map((s) => s.id));

  useEffect(() => {
    if (!initial?.focus) search.current?.focus();
    const back = opener.current;
    return () => { if (back?.isConnected) back.focus(); };
  }, []);

  // A request while open (Connections, the outage banner, a deep link).
  useLayoutEffect(() => {
    if (!requested) return;
    const target = resolveRequest(requested);
    if (target) { setPage(target.page); setQuery(''); setFocus(target.focus ?? null); setNotice(''); }
    else setNotice('That setting is not available here. Search for it or choose a category.');
    if (!target?.focus) clearRequest(null);
  }, [requested, clearRequest]);

  // Focus the requested control once its section is visible: a matching
  // data-help element, a connection-advanced-<id> block, else the section.
  useLayoutEffect(() => {
    if (!focus || !dialog.current) return;
    const section = settingsSection(focus);
    const root = dialog.current;
    const el = root.querySelector<HTMLElement>(`[data-help=${JSON.stringify(`settings.${focus}`)}]`)
      ?? root.querySelector<HTMLElement>(`#connection-advanced-${CSS.escape(focus)}`)
      ?? (section ? root.querySelector<HTMLElement>(`[data-settings-section="${section.id}"]`) : null);
    if (!el || el.closest('[hidden]')) {
      setNotice('This control is not available for the current configuration.');
      content.current?.focus();
    } else {
      el.scrollIntoView({ block: 'start' });
      (el.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? el).focus({ preventScroll: true });
    }
    setFocus(null);
    clearRequest(null);
  }, [focus, page, clearRequest]);

  const close = () => {
    if (window.location.hash.startsWith('#settings')) window.history.replaceState(null, '', window.location.pathname + window.location.search);
    onClose();
  };
  const choose = (next: SettingsPage) => {
    setPage(next); setQuery(''); setNotice('');
    content.current?.scrollTo({ top: 0 });
    window.history.replaceState(null, '', `#settings/${next}`);
  };
  const current = SETTINGS_PAGES.find((p) => p.id === page)!;

  return (
    <div className="settings-backdrop" onClick={close}>
      <Panel ref={dialog} className="settings-dialog" role="dialog" aria-label="Settings" aria-modal="true" onClick={(e: React.MouseEvent) => e.stopPropagation()}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key !== 'Escape' || e.defaultPrevented || (e.target as HTMLElement).closest('[role="dialog"]') !== dialog.current) return;
          if (e.target === search.current) { e.preventDefault(); e.stopPropagation(); if (query) setQuery(''); else close(); return; }
          if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
          e.preventDefault(); e.stopPropagation(); close();
        }}>
        <header className="settings-header">
          <h2 className="display-font glow-text-bright">SETTINGS</h2>
          <button type="button" className="display-font" onClick={close} aria-label="Close settings">CLOSE ✕</button>
        </header>
        <label className="settings-search" data-help="settings.navigation">Find a setting
          <input ref={search} type="search" maxLength={160} value={query} onChange={(e) => { setQuery(e.target.value); setNotice(''); }} placeholder="Search controls and help" />
        </label>
        <div className="settings-layout">
          <nav aria-label="Settings categories">
            {SETTINGS_PAGES.map((p) => (
              <button type="button" key={p.id} className="display-font" aria-current={!searching && page === p.id ? 'page' : undefined} onClick={() => choose(p.id)}>{p.label}</button>
            ))}
          </nav>
          <div className="settings-content" ref={content} tabIndex={-1}>
            <h3>{searching ? 'Search results' : current.label}</h3>
            <p className="settings-description">{searching ? 'Matches across every category.' : current.description}</p>
            <details className="settings-scope-guide" data-help="settings.scope">
              <summary>Which settings apply where?</summary>
              <p>Global settings apply across this Arco server. Project settings apply to one project folder. Workflow settings live in each workflow's CONFIG tab and override the global defaults for that workflow only; changing a default for new workflows does not change existing ones.</p>
            </details>
            {notice && <p role="status" className="settings-notice">{notice}</p>}
            {searching && <p role="status">{matched.length ? `${matched.length} matching ${matched.length === 1 ? 'section' : 'sections'}` : 'No settings match. Try a provider, a control name or a help term.'}</p>}
            <Visibility.Provider value={visible}>{children}</Visibility.Provider>
            <p className="settings-description">Provider, model, effort and permission choices for one workflow are in the workflow creator and that workflow's CONFIG tab.</p>
          </div>
        </div>
      </Panel>
    </div>
  );
}
