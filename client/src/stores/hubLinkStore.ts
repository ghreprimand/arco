import { create } from 'zustand';

// Isolated store for the management-hub link status shown in the header
// (transparency indicator + local kill switch). Kept separate from the central
// appStore so this small, optional surface doesn't touch the load-bearing store.
//
// Fed by the `hub_link_status` server message (handleServerMessage). When
// `hubUrl` is undefined the instance has no hub configured and the header
// renders nothing.

interface HubLinkState {
  connected: boolean;
  hubUrl?: string;
  /** How many of this instance's workflows are opted in to remote ("N monitored"). */
  monitoredCount: number;
  /** ts the link last opened — for the chip's "linked since …" tooltip. */
  connectedSince?: number;
  /** True once we've received at least one status message (so we don't flash). */
  known: boolean;
  setStatus: (s: { connected: boolean; hubUrl?: string; monitoredCount?: number; connectedSince?: number }) => void;
}

export const useHubLinkStore = create<HubLinkState>((set) => ({
  connected: false,
  hubUrl: undefined,
  monitoredCount: 0,
  connectedSince: undefined,
  known: false,
  setStatus: ({ connected, hubUrl, monitoredCount, connectedSince }) =>
    set({ connected, hubUrl, monitoredCount: monitoredCount ?? 0, connectedSince, known: true }),
}));
