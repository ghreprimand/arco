import { useEffect, useRef } from 'react';
import { create } from 'zustand';

export const useVoicePanelRequest = create<{ request: { id: string; panel: string; seq: number; throughSeq?: number } | null }>(() => ({ request: null }));
export function requestVoicePanel(id: string, panel: string, throughSeq?: number): void {
  useVoicePanelRequest.setState((s) => ({ request: { id, panel, throughSeq, seq: (s.request?.seq ?? 0) + 1 } }));
}

// A panel request must also reveal its container when the narrow drawer or
// focus mode has unmounted it. The mounted panel still chooses the tab/range.
export function useVoicePanelOpener(id: string, enabled: boolean, open: () => void): void {
  const request = useVoicePanelRequest(s => s.request);
  const callback = useRef(open); callback.current = open;
  useEffect(() => {
    if (enabled && request?.id === id) callback.current();
  }, [id, enabled, request]);
}
