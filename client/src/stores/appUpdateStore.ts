import { create } from 'zustand';
import type { AppUpdateAvailableMessage, UpdateCheckStatus } from '@arco/shared';

export function isUpdateStatus(value: unknown): value is UpdateCheckStatus {
  if (!value || typeof value !== 'object') return false;
  const s = value as UpdateCheckStatus;
  return typeof s.current === 'string' && typeof s.enabled === 'boolean' && typeof s.updateAvailable === 'boolean'
    && [s.latest, s.url, s.publishedAt, s.checkedAt].every((v) => v === null || typeof v === 'string');
}

export const useAppUpdateStore = create<{
  status: UpdateCheckStatus | null;
  notice: AppUpdateAvailableMessage | null;
  receive: (notice: AppUpdateAvailableMessage) => void;
  refresh: (force?: boolean) => Promise<void>;
  clear: () => void;
}>((set, get) => ({
  status: null,
  notice: null,
  receive: (notice) => {
    if (typeof notice.latest !== 'string' || typeof notice.url !== 'string' || !/^v\d+\.\d+\.\d+/.test(notice.latest) || !notice.url.startsWith('https://github.com/ghreprimand/arco/releases/tag/')) return;
    if (get().notice?.latest !== notice.latest) set({ notice });
  },
  refresh: async (force = false) => {
    const response = await fetch('/api/update-check', { method: force ? 'POST' : 'GET' });
    if (!response.ok) throw new Error('Release check unavailable');
    const status: unknown = await response.json();
    if (!isUpdateStatus(status)) throw new Error('Release check unavailable');
    set({ status });
    if (status.enabled && status.updateAvailable && status.latest && status.url && status.publishedAt) {
      get().receive({ type: 'app_update_available', current: status.current, latest: status.latest, url: status.url, publishedAt: status.publishedAt });
    } else set({ notice: null });
  },
  clear: () => set({ notice: null }),
}));
