// Mobile view (docs/CLIENT.md "Mobile view"): a sheet that rises from the
// bottom over a dimmed screen, at most 88% of the area high, with a title row
// and CLOSE. PANELS, the members list and the waiting questions use it over
// the conversation. A page uses it with `local` for its own choices (a row's
// actions, the header's page actions): the sheet is then drawn over that page,
// the page stays open, and the phone's Back closes the sheet first.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePhoneOverlay } from './phoneOverlay';
import { usePhoneStore } from '../stores/phoneStore';

// Where a page's own sheets are drawn: an element over the page that does not
// scroll with it (SlideOut with `full`, PhonePage).
export const PHONE_SHEET_HOST = 'data-phone-sheet-host';

const closeButton = {
  minHeight: '44px', minWidth: '44px', padding: '0 12px', fontSize: '12px', letterSpacing: '0.5px', cursor: 'pointer',
  background: 'transparent', color: 'var(--color-fg)', border: '1px solid var(--color-border-hairline)', borderRadius: '4px',
  whiteSpace: 'nowrap' as const, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
};

interface PhoneBottomSheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
  local?: boolean;
}

export function PhoneBottomSheet({ title, onClose, children, testId, local = false }: PhoneBottomSheetProps) {
  // The sheet is the one reachable surface besides the phone header: what it
  // covers cannot take focus, and closing returns focus to what opened it.
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [host, setHost] = useState<Element | null>(null);
  useLayoutEffect(() => { if (local) setHost(document.querySelector(`[${PHONE_SHEET_HOST}]`)); }, [local]);
  const drawn = !local || !!host;
  usePhoneOverlay(sheetRef, drawn);
  useEffect(() => {
    if (!local) return;
    const close = () => closeRef.current();
    usePhoneStore.getState().setLocalDialog(close);
    return () => { if (usePhoneStore.getState().localDialog === close) usePhoneStore.getState().setLocalDialog(null); };
  }, [local]);
  useEffect(() => {
    // Capture phase for a page's own sheet, so Escape closes it and not the page.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); if (local) e.stopPropagation(); closeRef.current(); } };
    window.addEventListener('keydown', onKey, local);
    return () => window.removeEventListener('keydown', onKey, local);
  }, [local]);
  if (!drawn) return null;
  const sheet = (
    <div ref={sheetRef} style={{ position: 'absolute', inset: 0, zIndex: 50, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div onClick={onClose} aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} />
      <div role="dialog" aria-label={title} data-testid={testId ?? 'phone-sheet'} style={{
        position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, maxHeight: '88%',
        background: 'var(--color-bg-dialog, var(--color-bg-panel))', borderTop: '2px solid var(--color-accent-primary)',
        paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)', paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderBottom: '1px solid var(--color-border-hairline)' }}>
          <h2 className="display-font" style={{ flex: 1, minWidth: 0, fontSize: '14px', letterSpacing: '1px', color: 'var(--color-fg)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</h2>
          <button type="button" data-testid="phone-sheet-back" onClick={onClose} className="display-font" style={closeButton}>CLOSE</button>
        </div>
        <div style={{ flex: '0 1 auto', minHeight: 0, overflowY: 'auto' }}>{children}</div>
      </div>
    </div>
  );
  return local && host ? createPortal(sheet, host) : sheet;
}
