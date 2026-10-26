// Startup and provider-setup UI state. Deliberately separate from appStore and
// never persisted to localStorage: the gate must be decided from the server's
// workspace and project registry, not from a stale browser copy.
import type { AuthLoginTarget } from '@arco/shared';
import { create } from 'zustand';
import { readSetupDeferred, writeSetupDeferred } from '../utils/startupGate';

interface StartupState {
  firstRunOpen: boolean;
  setFirstRunOpen: (open: boolean) => void;
  // The server's initial workspace snapshot has been applied this page load.
  workspaceSynced: boolean;
  setWorkspaceSynced: (synced: boolean) => void;
  // "Continue without a provider" for this browser tab session.
  setupDeferred: boolean;
  setSetupDeferred: (deferred: boolean) => void;
  // The provider setup screen reopened on top of the workspace.
  setupOpen: boolean;
  setSetupOpen: (open: boolean) => void;
  setupProvider: AuthLoginTarget | null;
  openConnections: (provider?: AuthLoginTarget) => void;
  // Settings section to scroll to when the panel opens (data-help suffix).
  settingsSection: string | null;
  setSettingsSection: (section: string | null) => void;
}

export const useStartupStore = create<StartupState>()((set) => ({
  firstRunOpen: false,
  setFirstRunOpen: (firstRunOpen) => set({ firstRunOpen }),
  workspaceSynced: false,
  setWorkspaceSynced: (workspaceSynced) => set({ workspaceSynced }),
  setupDeferred: readSetupDeferred(),
  setSetupDeferred: (setupDeferred) => { writeSetupDeferred(setupDeferred); set({ setupDeferred }); },
  setupOpen: false,
  setSetupOpen: (setupOpen) => set({ setupOpen }),
  setupProvider: null,
  openConnections: (provider) => set({ setupOpen: true, setupProvider: provider ?? null }),
  settingsSection: null,
  setSettingsSection: (settingsSection) => set({ settingsSection }),
}));
