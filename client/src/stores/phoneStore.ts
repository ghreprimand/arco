import { create } from 'zustand';
import { useEffect, useRef } from 'react';
import { useTerminalStore } from './terminalStore';

// Mobile view (docs/CLIENT.md "Mobile view"): which screen is shown (the
// directory of tabs or one conversation), which full-screen sheet is open over
// it, and the panel the operator asked for. Only one overlay covers the
// conversation at a time: a sheet, a side panel or the terminal window.
// Opening one closes the others; closing the terminal window keeps its
// session running. View state only; never persisted.
export type PhoneSheet = 'needs' | 'members' | 'panels' | 'questions';
export type PhoneScreen = 'directory' | 'conversation';
export type PhoneOverlay = 'sheet' | 'panel' | 'terminal';

export interface PhonePanelItem { id: string; label: string }

interface PhoneState {
  screen: PhoneScreen;
  sheet: PhoneSheet | null;
  questionWorkflowId: string | null;
  localDialog: (() => void) | null;
  setLocalDialog: (close: (() => void) | null) => void;
  // The label of the full-width side panel now open, if any (set by SlideOut).
  openPanel: string | null;
  // Who the bottom return button in a panel goes back to.
  returnLabel: string;
  // The panels the shown tab offers (its side-panel strip), set by that view.
  panels: PhonePanelItem[];
  // A request for the shown view to open one of its panels; seq repeats it.
  panelRequest: { id: string; seq: number } | null;
  // Bumped when another overlay takes the screen: views close their panels.
  panelCloseSeq: number;
  // The System dialog (services, diagnostics), opened from PANELS.
  systemOpen: boolean;
  setSystemOpen: (open: boolean) => void;
  // Settings shows one category (or search results) instead of its category list.
  settingsPage: boolean;
  setSettingsPage: (open: boolean) => void;
  // The directory's open clusters and scroll position, kept while a
  // conversation is shown so a return finds the list as it was left.
  directoryOpen: Record<string, boolean> | null;
  directoryScroll: number;
  setDirectoryView: (open: Record<string, boolean>, scroll: number) => void;
  setScreen: (screen: PhoneScreen) => void;
  openSheet: (sheet: PhoneSheet | null, questionWorkflowId?: string) => void;
  setOpenPanel: (label: string | null) => void;
  setReturnLabel: (label: string) => void;
  // Close the open side panel, whichever view drew it.
  closePanels: () => void;
  setPanels: (panels: PhonePanelItem[]) => void;
  requestPanel: (id: string) => void;
  // `kind` takes the screen: the other overlays close.
  claim: (kind: PhoneOverlay) => void;
}

export const usePhoneStore = create<PhoneState>((set, get) => ({
  screen: 'directory',
  sheet: null,
  questionWorkflowId: null,
  localDialog: null,
  setLocalDialog: (localDialog) => set({ localDialog }),
  openPanel: null,
  returnLabel: '',
  panels: [],
  panelRequest: null,
  panelCloseSeq: 0,
  systemOpen: false,
  setSystemOpen: (systemOpen) => set({ systemOpen }),
  settingsPage: false,
  setSettingsPage: (settingsPage) => set({ settingsPage }),
  directoryOpen: null,
  directoryScroll: 0,
  setDirectoryView: (directoryOpen, directoryScroll) => set({ directoryOpen, directoryScroll }),
  setScreen: (screen) => set({ screen }),
  setOpenPanel: (openPanel) => set({ openPanel }),
  setReturnLabel: (returnLabel) => set({ returnLabel }),
  closePanels: () => set((s) => ({ panelCloseSeq: s.panelCloseSeq + 1, openPanel: null })),
  openSheet: (sheet, questionWorkflowId) => {
    if (sheet) get().claim('sheet');
    set({ sheet, questionWorkflowId: sheet === 'questions' ? questionWorkflowId ?? null : null });
  },
  setPanels: (panels) => set({ panels }),
  requestPanel: (id) => {
    get().claim('panel');
    set((s) => ({ panelRequest: { id, seq: (s.panelRequest?.seq ?? 0) + 1 } }));
  },
  claim: (kind) => {
    if (kind !== 'sheet' && get().sheet) set({ sheet: null });
    if (kind !== 'panel') set((s) => ({ panelCloseSeq: s.panelCloseSeq + 1 }));
    if (kind !== 'terminal') {
      const terminals = useTerminalStore.getState();
      for (const w of terminals.windows) terminals.closeWindow(w.windowId);
    }
  },
}));

/** For a view with phone panels: open the panel the operator asks for after the
 * view mounted, and close its panels when another overlay takes the screen. An
 * older request never reopens a panel on another tab. */
export function usePhonePanelRequests(active: boolean, ids: readonly string[], open: (id: string) => void, close: () => void): void {
  const request = usePhoneStore((s) => s.panelRequest);
  const closeSeq = usePhoneStore((s) => s.panelCloseSeq);
  const seen = useRef(request?.seq ?? 0);
  const seenClose = useRef(closeSeq);
  const openRef = useRef(open);
  openRef.current = open;
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (closeSeq === seenClose.current) return;
    seenClose.current = closeSeq;
    if (active) closeRef.current();
  }, [closeSeq, active]);
  useEffect(() => {
    if (!request || request.seq === seen.current) return;
    seen.current = request.seq;
    if (active && ids.includes(request.id)) openRef.current(request.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.seq]);
}

/** What the mobile view shows, from the top layer down; used by Back. */
// `dialog` is a full-screen workbench dialog opened from PANELS (manual,
// Recall, System); `settingsPage` is a Settings category opened from its list.
export interface MobileLayers { localDialog?: boolean; sheet: boolean; dialog: boolean; settingsPage?: boolean; settings: boolean; terminal: boolean; panel: boolean; conversation: boolean }
export type MobileBackStep = 'localDialog' | 'sheet' | 'dialog' | 'settingsPage' | 'settings' | 'terminal' | 'panel' | 'conversation' | null;

/** The layer Back (the phone's Back button or gesture) closes: the top one. */
export function mobileBackStep(layers: MobileLayers): MobileBackStep {
  if (layers.localDialog) return 'localDialog';
  if (layers.sheet) return 'sheet';
  if (layers.dialog) return 'dialog';
  if (layers.settings && layers.settingsPage) return 'settingsPage';
  if (layers.settings) return 'settings';
  if (layers.terminal) return 'terminal';
  if (layers.panel) return 'panel';
  if (layers.conversation) return 'conversation';
  return null;
}

/** How many layers are open, so each one opened adds one browser history entry. */
export function mobileDepth(layers: MobileLayers): number {
  return Number(!!layers.localDialog) + Number(layers.sheet) + Number(layers.dialog) + Number(!!(layers.settings && layers.settingsPage)) + Number(layers.settings) + Number(layers.terminal) + Number(layers.panel) + Number(layers.conversation);
}
