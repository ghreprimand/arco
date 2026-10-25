import { create } from 'zustand';
import type {
  CatalogQuery, CatalogResponse, CatalogRow, HardwareProfile, HardwareSimPreset,
  CookbookTaskProfile, ProviderName, ModelName, EffortLevel,
  CookbookDownloadSource, CookbookDownloadPhase,
} from '@arco/shared';

// Workbench Expansion G4 — module-level senders for the download lifecycle.
// Registered by useWebSocket alongside the recommend sender so the
// globally-mounted CookbookModal / CatalogTable / RecommendDialog can dispatch
// a download (or cancel) without prop-threading a WS callback. Null when closed.
export interface CookbookDownloadArgs {
  workflowId: string;
  source: CookbookDownloadSource;
  repo?: string;
  quant?: string;
  alias?: string;
  ctxSize?: number;
  capabilities?: { tools?: boolean; vision?: boolean; thinking?: boolean };
  name?: string;
  confirm?: boolean;
}
type DownloadSender = (args: CookbookDownloadArgs) => void;
type CancelDownloadSender = (workflowId: string, downloadId: string) => void;
let downloadSender: DownloadSender | null = null;
let cancelDownloadSender: CancelDownloadSender | null = null;
export function registerCookbookDownloadSender(fn: DownloadSender | null) { downloadSender = fn; }
export function registerCookbookCancelDownloadSender(fn: CancelDownloadSender | null) { cancelDownloadSender = fn; }
export function sendCookbookDownload(args: CookbookDownloadArgs): boolean {
  if (!downloadSender) return false;
  downloadSender(args);
  return true;
}
export function sendCookbookCancelDownload(workflowId: string, downloadId: string): boolean {
  if (!cancelDownloadSender) return false;
  cancelDownloadSender(workflowId, downloadId);
  return true;
}

// Workbench Expansion G3 — module-level sender for the Cookbook recommendation
// dispatch. Registered by useWebSocket (mirrors docEditStore's registerDocEditSender)
// so the globally-mounted CookbookModal can fire a recommend request without
// threading a WS callback through the header. Null when the socket is closed.
export interface CookbookRecommendArgs {
  workflowId: string;
  researcher: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string };
  taskProfile: CookbookTaskProfile;
  maxRounds: number;
  query?: string;
  sim?: HardwareSimPreset;
}
type RecommendSender = (args: CookbookRecommendArgs) => void;
let recommendSender: RecommendSender | null = null;
export function registerCookbookRecommendSender(fn: RecommendSender | null) { recommendSender = fn; }
export function sendCookbookRecommend(args: CookbookRecommendArgs): boolean {
  if (!recommendSender) return false;
  recommendSender(args);
  return true;
}

// Workbench Expansion G2 — Cookbook client store.
//
// Kept OUT of appStore (mirrors recallStore / terminalStore): the catalog is a
// global, on-demand projection fetched over HTTP from the read-only
// /api/cookbook endpoints — not per-tab session state, not persisted. The modal
// open flag also lives here so any toolbar button can open it without threading
// props (the header uses a local useState for OllamaReleasesModal, but the
// Cookbook modal is reachable from more than one place, so it gets a store flag).
//
// READ-ONLY (G2): every method here is a GET (or the explicit RESCAN POST). No
// download / pull / write path exists in this store — that lands in G4.

// G4 — the active-download projection (the modal shows ONE at a time). Built
// from cookbook_download_progress broadcasts. `key` is the row key the operator
// clicked DOWNLOAD on, so the table can render the progress bar inline.
export interface CookbookDownloadState {
  downloadId?: string;
  key: string;
  source: CookbookDownloadSource;
  phase: CookbookDownloadPhase | 'requested';
  receivedBytes?: number;
  totalBytes?: number;
  freeBytes?: number;
  message?: string;
  alias?: string;
}

interface CookbookState {
  // Modal open flag — the trigger button(s) flip this.
  open: boolean;
  setOpen: (open: boolean) => void;

  // G4 — the active download (or null when none is running). The DOWNLOAD click
  // seeds a 'requested' record keyed by the row; progress broadcasts update it.
  download: CookbookDownloadState | null;
  startDownload: (key: string, source: CookbookDownloadSource) => void;
  onDownloadProgress: (p: {
    downloadId: string; source: CookbookDownloadSource; phase: CookbookDownloadPhase;
    receivedBytes?: number; totalBytes?: number; freeBytes?: number; message?: string; alias?: string;
  }) => void;
  clearDownload: () => void;

  // Detected/simulated hardware shown in the header strip.
  hardware: HardwareProfile | null;
  rescanning: boolean;

  // Catalog rows + the trending-that-fits feed.
  rows: CatalogRow[];
  trending: CatalogRow[];
  sources: { hf: boolean; ollama: boolean };
  note?: string;
  loading: boolean;
  error: string | null;

  // Run a catalog search. The view debounces the text field before calling.
  search: (query: CatalogQuery) => Promise<void>;
  // Re-probe the detected hardware (RESCAN button). Clears nothing in the
  // catalog rows — the operator re-searches if they want the new profile applied.
  rescanHardware: () => Promise<void>;
  // Fetch the detected profile (on first open, when no sim preset is active).
  fetchHardware: () => Promise<void>;
}

function qs(query: CatalogQuery): string {
  const p = new URLSearchParams();
  if (query.text && query.text.trim()) p.set('q', query.text.trim());
  if (query.quant) p.set('quant', query.quant);
  if (query.task) p.set('task', query.task);
  if (query.sim) p.set('sim', query.sim);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const useCookbookStore = create<CookbookState>((set, get) => ({
  open: false,
  setOpen: (open) => set({ open }),

  download: null,
  startDownload: (key, source) => set({ download: { key, source, phase: 'requested' } }),
  onDownloadProgress: (p) => set((s) => {
    // Adopt the first downloadId we see for the active row (the request didn't
    // carry one; the server mints it). Ignore stray progress for a stale id.
    const cur = s.download;
    if (!cur) return {};
    if (cur.downloadId && cur.downloadId !== p.downloadId) return {};
    return {
      download: {
        ...cur,
        downloadId: p.downloadId,
        source: p.source,
        phase: p.phase,
        receivedBytes: p.receivedBytes ?? cur.receivedBytes,
        totalBytes: p.totalBytes ?? cur.totalBytes,
        freeBytes: p.freeBytes ?? cur.freeBytes,
        message: p.message ?? cur.message,
        alias: p.alias ?? cur.alias,
      },
    };
  }),
  clearDownload: () => set({ download: null }),

  hardware: null,
  rescanning: false,

  rows: [],
  trending: [],
  sources: { hf: true, ollama: true },
  note: undefined,
  loading: false,
  error: null,

  search: async (query) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`/api/cookbook/catalog${qs(query)}`);
      const body = (await res.json()) as CatalogResponse;
      set({
        rows: body.rows ?? [],
        trending: body.trending ?? [],
        hardware: body.hardware ?? get().hardware,
        sources: body.sources ?? { hf: false, ollama: false },
        note: body.note,
        loading: false,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },

  rescanHardware: async () => {
    set({ rescanning: true });
    try {
      const res = await fetch('/api/cookbook/hardware/rescan', { method: 'POST' });
      const hw = (await res.json()) as HardwareProfile;
      set({ hardware: hw, rescanning: false });
    } catch {
      set({ rescanning: false });
    }
  },

  fetchHardware: async () => {
    try {
      const res = await fetch('/api/cookbook/hardware');
      const hw = (await res.json()) as HardwareProfile;
      set({ hardware: hw });
    } catch {
      /* leave hardware null; the header shows "detecting…" */
    }
  },
}));

// Re-export the sim presets shape for the view's selector.
export type { HardwareSimPreset };
