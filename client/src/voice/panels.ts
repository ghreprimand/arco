import { create } from 'zustand';

export const useVoicePanelRequest = create<{ request: { id: string; panel: string; seq: number; throughSeq?: number } | null }>(() => ({ request: null }));
export function requestVoicePanel(id: string, panel: string, throughSeq?: number): void {
  useVoicePanelRequest.setState((s) => ({ request: { id, panel, throughSeq, seq: (s.request?.seq ?? 0) + 1 } }));
}
