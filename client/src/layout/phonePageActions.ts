// docs/CLIENT.md "Mobile view" - a page body's `...` actions, `+` and the line
// under the page name, for the mobile header. A panel that hides a page while
// another one shows (ALL PANELS, the settings page) marks it not visible, so a
// hidden page never puts its actions in the header.

import { createContext, useContext, useMemo, useRef } from 'react';
import { usePhonePageChrome, type PhonePageAction } from '../stores/phoneStore';
import { usePhoneLayout } from './layoutRange';

export const PhonePageVisible = createContext(true);

/** True when the mobile view shows this page body. */
export function usePhonePageActive(): boolean {
  const phone = usePhoneLayout();
  const visible = useContext(PhonePageVisible);
  return phone && visible;
}

export interface PhonePageItem extends PhonePageAction { show?: boolean }

/** Publish the page's chrome while `active`. Handlers may change every render;
 * the header only updates when the shown labels, states or subtitle change. */
export function usePhonePageActions(active: boolean, items: PhonePageItem[], extra: { subtitle?: string; primary?: { label: string; onSelect: () => void } | null; back?: (() => boolean) | null } = {}): void {
  const handlers = useRef(new Map<string, () => void>());
  const shown = items.filter((item) => item.show !== false);
  for (const item of shown) handlers.current.set(item.id, item.onSelect);
  const primaryRef = useRef(extra.primary?.onSelect);
  primaryRef.current = extra.primary?.onSelect;
  const backRef = useRef(extra.back);
  backRef.current = extra.back;
  const key = JSON.stringify([shown.map((i) => [i.id, i.label, !!i.danger, !!i.disabled]), extra.subtitle ?? '', extra.primary?.label ?? '', !!extra.back]);
  const chrome = useMemo(() => ({
    subtitle: extra.subtitle,
    actions: shown.map(({ id, label, danger, disabled }) => ({ id, label, danger, disabled, onSelect: () => handlers.current.get(id)?.() })),
    primary: extra.primary ? { label: extra.primary.label, onSelect: () => primaryRef.current?.() } : null,
    back: extra.back ? () => backRef.current?.() ?? false : null,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [key]);
  usePhonePageChrome(active, chrome);
}
