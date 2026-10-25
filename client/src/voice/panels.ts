import { create } from 'zustand';

export const useVoicePanelRequest = create<{ request: { id: string; panel: string; seq: number } | null }>(() => ({ request: null }));
export function requestVoicePanel(id: string, panel: string): void {
  useVoicePanelRequest.setState((s) => ({ request: { id, panel, seq: (s.request?.seq ?? 0) + 1 } }));
}
