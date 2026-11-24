// Mobile view (docs/CLIENT.md "Mobile view"): one page over the conversation
// area. The mobile header names the page and its back arrow closes it; the
// page itself has no bar of its own and scrolls as one surface. A side panel
// opened by a view is the same kind of page (SlideOut with `full`); this
// component is for pages that no view hosts, such as Notices or System.

import { useEffect, useRef, type ReactNode } from 'react';
import { usePhoneOverlay } from './phoneOverlay';
import { usePhoneStore } from '../stores/phoneStore';
import { PHONE_SHEET_HOST } from './PhoneBottomSheet';

interface PhonePageProps {
  // The page name shown in the mobile header.
  title: string;
  // Called when the header's back arrow, the phone's Back, Escape or another
  // overlay closes the page. The owner stops rendering the page.
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}

export function PhonePage({ title, onClose, children, testId }: PhonePageProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // Take the screen: sheets, the terminal and any page a view drew close.
    const phone = usePhoneStore.getState();
    phone.claim('panel');
    phone.closePanels();
    const openedAt = usePhoneStore.getState().panelCloseSeq;
    usePhoneStore.setState({ openPanel: title, pageTitle: title, panelIndex: false, panelFromIndex: false });
    const stop = usePhoneStore.subscribe((s) => { if (s.panelCloseSeq !== openedAt) closeRef.current(); });
    return () => {
      stop();
      if (usePhoneStore.getState().openPanel === title) usePhoneStore.setState({ openPanel: null, pageTitle: '' });
    };
  }, [title]);
  usePhoneOverlay(pageRef, true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div ref={pageRef} style={{ position: 'absolute', inset: 0, zIndex: 40 }}>
      <div role="dialog" aria-label={title} data-testid={testId ?? 'phone-page'} data-phone-scroll="" style={{
        position: 'absolute', inset: 0, overflowY: 'auto', overscrollBehavior: 'contain',
        background: 'var(--color-bg-dialog, var(--color-bg-panel))',
        paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)', paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
        <div data-phone-panel-body="" style={{ display: 'flex', flexDirection: 'column' }}>{children}</div>
      </div>
      {/* The page's own bottom sheets are drawn here, over the page. */}
      <div {...{ [PHONE_SHEET_HOST]: '' }} />
    </div>
  );
}
