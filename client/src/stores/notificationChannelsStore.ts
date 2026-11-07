import { create } from 'zustand';

function isView(v: unknown): v is NotificationChannelsView {
  const o = v as Partial<NotificationChannelsView> | null;
  return !!o && typeof o === 'object' && !!o.desktop && !!o.phone && !!o.ntfy && typeof o.ntfy.server === 'string';
}
import type { NotificationChannels, NotificationChannelsView } from '@arco/shared';

type ChannelSave = Omit<NotificationChannels, 'ntfy'> & { ntfy: { server: string; topic: string; token?: string | null } };
let saveTail: Promise<unknown> = Promise.resolve();

interface State {
  view: NotificationChannelsView | null;
  error: string;
  load: () => Promise<void>;
  // token: a string sets it, null clears it, absent keeps it.
  save: (next: ChannelSave | ((current: NotificationChannelsView) => ChannelSave)) => Promise<boolean>;
}

export const useNotificationChannelsStore = create<State>((set, get) => ({
  view: null,
  error: '',
  load: async () => {
    try {
      const r = await fetch('/api/notification-channels', { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      const body: unknown = await r.json();
      if (!isView(body)) throw new Error('unexpected');
      set({ view: body, error: '' });
    } catch { set({ error: 'Notification settings could not be loaded.' }); }
  },
  save: (next) => {
    const operation = saveTail.then(async () => {
      try {
        const current = get().view;
        if (!current) throw new Error('settings unavailable');
        const patch = typeof next === 'function' ? next(current) : next;
        const r = await fetch('/api/notification-channels', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
        if (!r.ok) throw new Error(String(r.status));
        const body: unknown = await r.json();
        if (!isView(body)) throw new Error('unexpected');
        set({ view: body, error: '' });
        return true;
      } catch { set({ error: 'Notification settings could not be saved.' }); return false; }
    });
    saveTail = operation.catch(() => {});
    return operation;
  },
}));
