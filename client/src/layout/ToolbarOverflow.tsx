// Composer tools on one line (window-size layout, client/src/layout/layoutRange.ts).
// The tools stay where they are in the DOM; the ones that do not fit are
// hidden from the end (data-overflowed) and listed under MORE, which clicks
// the hidden button. Tools named in `keep` never move. In the Standard layout
// nothing is hidden and the row wraps as before.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useKeepInWindow } from './keepInWindow';

interface Hidden { help: string; label: string }

function toolLabel(el: HTMLElement): string {
  const button = el.matches('button') ? el : el.querySelector('button');
  return (button?.textContent ?? el.textContent ?? '').replace(/\s+/g, ' ').trim() || (el.getAttribute('data-help') ?? '');
}

export function useToolbarOverflow(ref: RefObject<HTMLElement | null>, enabled: boolean, keep: ReadonlySet<string>): Hidden[] {
  const [hidden, setHidden] = useState<Hidden[]>([]);
  const keepRef = useRef(keep);
  keepRef.current = keep;
  const recompute = useRef<() => void>(() => {});
  recompute.current = () => {
    const row = ref.current;
    if (!row) return;
    const kids = [...row.children] as HTMLElement[];
    for (const k of kids) k.removeAttribute('data-overflowed');
    const more = row.querySelector<HTMLElement>(':scope > [data-overflow-more]');
    const tools = kids.filter((k) => k.hasAttribute('data-help') && !k.hasAttribute('data-overflow-more'));
    const done: Hidden[] = [];
    if (enabled && row.scrollWidth > row.clientWidth + 1) {
      const optional = tools.filter((k) => !keepRef.current.has(k.getAttribute('data-help') ?? ''));
      for (let i = optional.length - 1; i >= 0 && row.scrollWidth > row.clientWidth + 1; i--) {
        optional[i].setAttribute('data-overflowed', 'true');
        done.unshift({ help: optional[i].getAttribute('data-help') ?? '', label: toolLabel(optional[i]) });
      }
    }
    if (more && !done.length) more.setAttribute('data-overflowed', 'true');
    setHidden((prev) => prev.length === done.length && prev.every((p, i) => p.help === done[i].help && p.label === done[i].label) ? prev : done);
  };
  useLayoutEffect(() => { recompute.current(); });
  useEffect(() => {
    const row = ref.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => recompute.current());
    ro.observe(row);
    const mo = new MutationObserver(() => recompute.current());
    mo.observe(row, { childList: true, characterData: true, subtree: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [ref, enabled]);
  return hidden;
}

export function ToolbarMore({ row, hidden }: { row: RefObject<HTMLElement | null>; hidden: Hidden[] }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const placeRef = useKeepInWindow();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);
  useEffect(() => { if (!hidden.length) setOpen(false); }, [hidden.length]);
  const run = (help: string) => {
    setOpen(false);
    const el = [...(row.current?.children ?? [])].find((k) => k.getAttribute('data-help') === help) as HTMLElement | undefined;
    const button = el?.matches('button') ? el : el?.querySelector<HTMLElement>('button');
    button?.click();
  };
  return (
    <span ref={boxRef} data-overflow-more="true" data-help="layout.composer-more" style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <button
        type="button"
        data-testid="composer-more"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Tools that do not fit on this line"
        className="display-font"
        style={{ padding: '3px 8px', background: open ? 'var(--color-accent-secondary-a12)' : 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-accent-secondary-dim)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px', whiteSpace: 'nowrap' }}
      >
        MORE ▾
      </button>
      {open && (
        <div ref={placeRef} role="menu" data-testid="composer-more-menu" style={{ position: 'absolute', bottom: '100%', right: 0, marginBottom: '4px', zIndex: 60, minWidth: '170px', display: 'flex', flexDirection: 'column', gap: '2px', padding: '4px', background: 'var(--color-bg-dialog, var(--color-bg-panel))', border: '1px solid var(--color-border-hairline)', boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }}>
          {hidden.map((h) => (
            <button key={h.help} type="button" role="menuitem" data-overflow-item={h.help} onClick={() => run(h.help)} className="display-font" style={{ textAlign: 'left', padding: '4px 8px', fontSize: '10px', letterSpacing: '1px', background: 'transparent', border: 'none', color: 'var(--color-fg)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              {h.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
