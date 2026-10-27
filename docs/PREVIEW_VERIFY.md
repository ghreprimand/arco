# Preview verification

Arco's Live Preview (`docs/PROVIDERS.md` / `PreviewTab`) renders a workflow's
dev server in an iframe. **Preview verification** turns that preview into
*inspectable evidence*: an operator-triggered capture that screenshots the page
and collects its console errors + failed/error network requests, writing both to
artifacts on disk. It is the deliberate opposite of an autonomous browser-agent,
nothing navigates on its own; the operator clicks a button, gets a report.

Capture starts only after an explicit user action. Each capture is bounded and
its results are visible in `events.jsonl`; generated artifacts are ordinary
files that can be reviewed or removed.

## Why a system browser (no bundled Chromium)

A dev server speaks HTTP, not CDP, so "capture the preview" means *a browser must
render the URL*. Arco does **not** bundle a browser. Browser automation packages often download
Chromium during installation. Instead, Arco drives an installed system browser
over a raw CDP WebSocket using the already-present `ws` dependency, mirroring the
Antigravity manager's launch-with-`--remote-debugging-port` + `/json` probe
pattern (`server/src/providers/antigravityManager.ts`).

**Browser discovery** (`findBrowserBinary`, `server/src/preview/captureViaCdp.ts`):

1. `ARCO_CHROME_BINARY` or `CHROME_PATH` env override (also how the smoke pins a
   known binary).
2. PATH names, most-preferred first: `google-chrome-stable`, `google-chrome`,
   `chromium`, `chromium-browser`, `chrome`, `brave-browser`, `brave`,
   `microsoft-edge`.
3. macOS `.app` bundle executables (Chrome / Chromium / Brave / Edge).

If none is found, capture **degrades gracefully**: it returns `{ ok:false, error }`
naming the missing browser, it never throws, and the operator sees a clear "install
a browser or set `ARCO_CHROME_BINARY`" message rather than a crash.

## The capture (`server/src/preview/captureViaCdp.ts`)

`capturePreview({ port, viewport?, navigateTimeoutMs? })`, `viewport` is a
**preset name** (`'desktop' | 'tablet' | 'mobile'`, default `desktop`), resolved
to dimensions + mobile emulation by `VIEWPORT_PRESETS`:

1. Resolve a system browser (above), bail to `{ ok:false }` if none.
2. Launch headless: `--headless=new --remote-debugging-port=0` + a throwaway
   `--user-data-dir` under the OS temp dir; read the OS-chosen port from
   `<user-data-dir>/DevToolsActivePort`. `--window-size` is set to the preset.
3. Find the default page target via HTTP `/json`; connect a minimal raw-CDP client
   (`CdpClient`) to its `webSocketDebuggerUrl`.
4. Enable `Page` / `Runtime` / `Log` / `Network`; subscribe to
   `Runtime.consoleAPICalled` + `Runtime.exceptionThrown` + `Log.entryAdded`
   (console errors/warnings) and `Network.responseReceived` (>=400) +
   `Network.loadingFailed` (hard failures). Each list is capped at 50 entries.
5. **G2**, `Emulation.setDeviceMetricsOverride` pins the rendering viewport to
   the preset (the launch `--window-size` only sizes the OS window). For
   `tablet`/`mobile` the override sets `mobile:true` + the preset DPR and
   `Emulation.setTouchEmulationEnabled` turns on touch, so responsive breakpoints
   fire as on the real device. Best-effort, a refusal never aborts the capture.
6. `Page.navigate` to `http://127.0.0.1:<port>/` (loopback, **direct**, not through
   Arco's preview proxy), wait for `Page.loadEventFired` or the budget, settle
   briefly. A connection-refused preview still resolves, the navigation failure is
   surfaced as a console entry (nothing is silent).
7. `Runtime.evaluate` for `document.title` + `location.href`; **G2** a second
   `Runtime.evaluate` runs the read-only `LAYOUT_PROBE` (see below);
   `Page.captureScreenshot` (JPEG q60).
8. **Always** kill the browser + remove the temp profile in `finally`.

The function always resolves; failures land in `{ ok:false, error }`.

### Viewport presets

`VIEWPORT_PRESETS` (`captureViaCdp.ts`), conventional logical-CSS-px viewports,
DPR carried separately:

| preset | width × height | mobile emulation | DPR |
|---|---|---|---|
| `desktop` | 1280 × 800 | no | 1 |
| `tablet` | 834 × 1112 | yes (touch) | 2 |
| `mobile` | 390 × 844 | yes (touch) | 3 |

### Layout & accessibility notes

`LAYOUT_PROBE` is a single self-contained, fully-defensive, **read-only** IIFE run
via `Runtime.evaluate` after the page settles (returns a plain object via
`returnByValue`; it counts DOM signals and measures overflow, never mutates).
`PreviewLayoutNotes` records: the rendered `viewport`/`width`/`height`,
`horizontalOverflowPx` (`documentElement.scrollWidth - clientWidth`, the single
most useful responsive smell), `imagesMissingAlt`, `inputsMissingLabel` (no
`<label for>`, wrapping label, `aria-label/labelledby`, or `title`),
`controlsMissingName` (buttons/links with no text and no accessible name), `lang`
(`<html lang>`, empty = flagged), `hasTitle`, `viewportMetaPresent`, `h1Count`.
These are **signals worth a look**, not a WCAG audit; the report renders each as a
short line (flagged with `⚠` when non-zero) and `layoutFlagCount` rolls them into
the inline "· N layout" count.

## Artifacts + broadcasts (`server/src/ws/previewCaptureHandlers.ts`)

`preview_capture_request` (client->server, with `captures: ('screenshot' |
'console' | 'network')[]`) ->

- broadcast `preview_capture_started` (UI spinner);
- resolve the bound `wf.preview.port` (no port / no cwd -> `ok:false` with a clear
  reason);
- run the capture;
- write `preview-capture-<ts>.md` (the report) + `preview-capture-<ts>.jpg` (the
  screenshot) under `<cwd>/.arco/workflows/<wfid>/artifacts/`;
- broadcast `preview_capture_ready` with `{ ok, reportName, imageName, summary,
  error? }`.

`captures` only scopes which of the screenshot/console/network sections the report
renders (so `CHECK CONSOLE` produces a console-only report), the underlying CDP
session always collects all three (it's cheap once the browser is up). The **G2
layout/accessibility section is always rendered** when notes were collected: it's
tied to the render as a whole (the viewport preset), not to one facet button, and
it's the part the ATTACH TO REVIEW reviewer leans on most. `preview_capture_started`
and the `summary` echo the `viewport`; the summary also carries `layoutFlags`.

**The report is text-only.** It references the screenshot by *filename*, it does
**not** embed a base64 data URI. Embedding would bloat the report and, when G2
attaches it to a Review, would ship a huge, unreadable-to-the-reviewer image and
cost a fortune in tokens. The UI renders the actual screenshot via the raw-bytes
route instead.

### Raw-artifact route

`GET /api/workflows/artifact-raw?path=<cwd>&workflowId=<id>&name=<file>`
(`server/src/http/workflowDataRoutes.ts`) streams raw artifact bytes with a
type-by-extension `Content-Type` (jpeg/png/webp/gif), 16 MiB cap, same path-safety
guards as the JSON `/api/workflows/artifact` reader. It is matched *before* the
JSON route (whose prefix also matches the longer path). The JSON reader still
serves the markdown report for the `VIEW REPORT` modal.

## Client surface (`client/src/components/PreviewTab.tsx`)

Shown only when a port is bound:

- **`VERIFY` row**, `CAPTURE SCREENSHOT` / `CHECK CONSOLE` / `CHECK NETWORK`
  buttons (each sends the scoped `captures` **+ the selected viewport**), a G2
  **viewport segmented control** (`DESKTOP` / `TABLET` / `MOBILE`, persisted to
  localStorage, distinct from the iframe aspect ratio, which only scales the live
  view), a `CAPTURING...` spinner, and an inline `<viewport> · N console · M net · K
  layout` count from the last capture's summary.
- **Result strip**, the latest capture's title, a screenshot thumbnail (click ->
  full image via the raw route), `VIEW REPORT` (opens the markdown report in a
  read-only modal, matching the Review/Research artifact-viewing convention), and
  the G2 **get-it-to-an-LLM** actions:
  - **`SEND TO AGENT`**, seeds *this tab's* composer with an `@file:` ref to the
    report (server-expanded into the turn context at send time, so the primary
    agent reads the actual capture) + a framing line, appended to any existing
    draft. Pure client (`setDraft`); the operator edits + sends.
  - **`ATTACH TO REVIEW`**, fires a Review over the report artifact (see below).

Store: `JobState.previewCapturing` + `previewCaptures: PreviewCaptureRecord[]`
(ephemeral, not replayed; capture again after a reconnect). Handlers in
`handleServerMessage.ts`; sender `previewCapture(workflowId, captures?, viewport?)`
in `useWebSocket.ts`, threaded `App -> WorkflowView -> RightPanel -> PreviewTab` as
`onPreviewCapture`; `onReviewCapture` rides the same chain for ATTACH TO REVIEW.

## Attach to Review

`ATTACH TO REVIEW` calls `requestReview(workflowId, reviewer, { kind:
'preview-capture', reportName })` with the tab's **primary** provider/model/effort
as the reviewer (no dialog, one click). It's a real Review primitive: a fresh
read-only reviewer worker, a verdict in the REVIEW tab, an artifact on disk.

`{ kind: 'preview-capture'; reportName }` is a `ReviewContextRef` like the plan /
since-event kinds. `handleReviewRequest` dispatches it before the transcript/plan
branches to `buildPreviewCaptureReviewContent` (`reviewContent.ts`), which
**path-confines** the read to the workflow's artifacts dir (`path.basename` +
`.md` suffix check, a crafted name can't escape), prepends framing that tells the
reviewer it's judging a running UI from captured evidence (and that it can't see
the screenshot, so it must reason from the structured notes), and returns the
report body as the review content. The preview-capture scope is **only** reachable
from this button, the normal Review dialog still offers the transcript / plan /
diff scopes.

## Smoke

`npm run smoke:preview-verify` (`scripts/smoke/preview-verify.ts`), pure (no
Arco server/WS). Asserts:

- `findBrowserBinary` is total (string | null, never throws);
- **degradation**: no browser -> `ok:false` naming Chrome/Chromium;
- **live** (when a system browser is present): a capture against a tiny local
  server surfaces the page title, a `console.error`, a 404 network entry, and a
  screenshot;
- a dead port still resolves `ok` and surfaces the navigation failure.

Stays green on a browser-less box (the live asserts report `SKIP`); with a system
browser (the operator's box has `brave`) the full set of live checks runs (including the
G2 desktop/mobile layout-note asserts).
