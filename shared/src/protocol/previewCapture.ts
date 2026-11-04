
// Which facets the operator asked for. The capture session always runs the same
// CDP flow once the browser is up (collecting all three is cheap); `captures`
// only scopes which sections the report renders and which buttons framed the
// request (CAPTURE SCREENSHOT / CHECK CONSOLE / CHECK NETWORK).
export type PreviewCaptureKind = 'screenshot' | 'console' | 'network';

// G2 — render the page at a device-class viewport. `desktop` keeps the wide
// default (1280×800, no mobile emulation); `tablet` / `mobile` set a narrower
// logical viewport AND turn on Chrome's mobile device-metrics emulation (touch
// + a mobile DPR) so responsive layouts collapse the way they would on a real
// device. The preset → dimensions mapping lives server-side (captureViaCdp.ts)
// so the wire stays a stable enum.
export type PreviewViewport = 'desktop' | 'tablet' | 'mobile';

// client → server: capture the running preview for this workflow.
export interface PreviewCaptureRequestMessage {
  type: 'preview_capture_request';
  workflowId: string;
  captures: PreviewCaptureKind[];
  // G2 — viewport preset for the capture. Absent ⇒ 'desktop' (back-compat with
  // G1 requests, which never carried it).
  viewport?: PreviewViewport;
}

// server → client: capture started (UI spinner). `captureId` correlates the
// eventual `preview_capture_ready`.
export interface PreviewCaptureStartedMessage {
  type: 'preview_capture_started';
  workflowId: string;
  captureId: string;
  captures: PreviewCaptureKind[];
  // G2 — echoes the requested viewport so the UI can label the in-flight
  // capture ("capturing mobile…"). Absent ⇒ 'desktop'.
  viewport?: PreviewViewport;
}

// A single console error / warning collected during the capture.
export interface PreviewConsoleEntry {
  level: 'error' | 'warning';
  text: string;
  // Where it came from, when CDP reports it (url:line). Best-effort.
  source?: string;
}

// A network request that failed outright or returned a 4xx/5xx status.
export interface PreviewNetworkEntry {
  url: string;
  // HTTP status for error responses; absent for hard failures (DNS, refused…).
  status?: number;
  // Failure text for hard failures (`Network.loadingFailed`).
  errorText?: string;
  method?: string;
}

// G2 — basic layout + accessibility notes, collected by a single in-page script
// (`Runtime.evaluate`) once the page has settled. Deterministic, cheap, and
// purely observational — Arco never mutates the page. These are *signals*, not
// a conformance audit: a non-zero count means "worth a look", and the report
// renders each as a short human line. `viewport`/`width`/`height` record the
// device class the page was actually rendered at.
export interface PreviewLayoutNotes {
  viewport: PreviewViewport;
  width: number;
  height: number;
  // `<html lang>` value, or empty string when unset (a flagged signal).
  lang: string;
  hasTitle: boolean;
  // `<meta name="viewport">` present — relevant for the mobile/tablet presets.
  viewportMetaPresent: boolean;
  h1Count: number;
  // Horizontal overflow in CSS px (documentElement.scrollWidth − clientWidth),
  // 0 when the page fits. The single most useful responsive-layout smell.
  horizontalOverflowPx: number;
  imagesMissingAlt: number;
  inputsMissingLabel: number;
  controlsMissingName: number;
}

// Deterministic numeric summary shown inline in the Preview tab; the full detail
// lives in the markdown report artifact.
export interface PreviewCaptureSummary {
  url?: string;
  title?: string;
  consoleErrors: number;
  failedRequests: number;
  screenshot: boolean;
  // G2 — the viewport the capture ran at + a single rolled-up count of layout/
  // accessibility signals worth a look (so the strip can show "· 2 layout").
  viewport?: PreviewViewport;
  layoutFlags?: number;
}

// server → client: capture finished (or failed). On success `reportName` is the
// markdown artifact and `imageName` the raw screenshot, both under the workflow's
// artifacts dir and fetchable via the artifact endpoints. On failure `ok:false`
// and `error` names the cause (no preview bound, no browser found, navigation
// timeout, …) — every reason lands here, nothing is silent.
export interface PreviewCaptureReadyMessage {
  type: 'preview_capture_ready';
  workflowId: string;
  captureId: string;
  ok: boolean;
  error?: string;
  reportName?: string;
  imageName?: string;
  summary?: PreviewCaptureSummary;
  completedAt: number;
}
