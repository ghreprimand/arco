import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PreviewCaptureKind, PreviewViewport } from '@arco/shared';
import type { JobState } from '../stores/appStore';
import { readDraft } from '../stores/draftStore';
import { useAppStore } from '../stores/appStore';

interface ListeningEntry {
  port: number;
  pid: number;
  command: string;
}

// Logical viewport the iframe always renders at. Width is fixed at 1920 —
// most desktop-class apps lay out assuming roughly Full HD. Height derives
// from the operator's chosen aspect ratio. The visual size is then CSS-scaled
// to fit the largest box-of-that-ratio that fits the pane — width-constrained
// when the pane is wider than tall, height-constrained when taller, never
// clipped in either axis.
const LOGICAL_W = 1920;
type AspectRatio = '4:3' | '16:10' | '16:9';
const ASPECT_RATIOS: AspectRatio[] = ['4:3', '16:10', '16:9'];
const ASPECT_HEIGHT: Record<AspectRatio, number> = {
  '4:3': 1440,   // 1920 * 3/4
  '16:10': 1200, // 1920 * 10/16
  '16:9': 1080,  // 1920 * 9/16
};
const ASPECT_STORAGE_KEY = 'arco.preview.aspect';

// G2 — capture viewport presets. Distinct from the iframe aspect ratio above:
// aspect only scales the live iframe, whereas the viewport is the device class
// the headless capture actually renders at (and emulates touch/DPR for tablet/
// mobile). Persisted so the operator's last choice sticks per browser.
const CAPTURE_VIEWPORTS: PreviewViewport[] = ['desktop', 'tablet', 'mobile'];
const VIEWPORT_LABEL: Record<PreviewViewport, string> = { desktop: 'DESKTOP', tablet: 'TABLET', mobile: 'MOBILE' };
const VIEWPORT_STORAGE_KEY = 'arco.preview.captureViewport';

// Live preview of the workflow's dev server. Operator types a port; iframe
// loads /api/preview/<workflowId>/, which the server proxies to
// 127.0.0.1:<port>. Survives reconnects via meta.json (server replays a
// preview_set on hydrate). HMR works because the server upgrade handler
// forwards WS to the same backend; no per-project base-url config required —
// the Referer-based fallback in previewProxy.ts catches absolute paths.
interface Props {
  job: JobState;
  onSetPort?: (port: number, framework?: string) => void;
  onClear?: () => void;
  // G1 — capture the running preview (screenshot + console + network). Scoped by
  // facet so CHECK CONSOLE / CHECK NETWORK render a focused report. G2 adds the
  // viewport preset (desktop / tablet / mobile).
  onCapture?: (captures?: PreviewCaptureKind[], viewport?: PreviewViewport) => void;
  // G2 — attach the latest capture report to a Review (fires a reviewer over the
  // report artifact, reusing this tab's primary config).
  onReviewCapture?: (reportName: string) => void;
}

export function PreviewTab({ job, onSetPort, onClear, onCapture, onReviewCapture }: Props) {
  const preview = job.preview;
  const [draft, setDraft] = useState<string>(preview ? String(preview.port) : '');
  const [iframeKey, setIframeKey] = useState(0);
  const [aspect, setAspect] = useState<AspectRatio>(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(ASPECT_STORAGE_KEY) : null;
    return stored && (ASPECT_RATIOS as string[]).includes(stored) ? (stored as AspectRatio) : '4:3';
  });
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const fitWrapRef = useRef<HTMLDivElement | null>(null);
  const [boxStyle, setBoxStyle] = useState<{ width: number; height: number; scale: number } | null>(null);
  const logicalH = ASPECT_HEIGHT[aspect];

  // Dead-bind picker state. When a history pill click hits a port that no
  // longer responds, we open this modal showing every other listener on the
  // box (Linux-only via /proc; macOS sees an empty list with the same
  // explanatory copy). Picking one fires the same onSetPort path as a manual
  // BIND. deadPort holds the port the operator tried to revisit so the
  // copy can name it explicitly.
  const [deadPort, setDeadPort] = useState<number | null>(null);
  const [pickerEntries, setPickerEntries] = useState<ListeningEntry[] | null>(null);
  const [probing, setProbing] = useState(false);

  // G1 — preview verification. The report artifact opened in the viewer modal.
  const [openReport, setOpenReport] = useState<string | null>(null);
  // G2 — capture viewport preset (desktop / tablet / mobile), persisted.
  const [captureViewport, setCaptureViewport] = useState<PreviewViewport>(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(VIEWPORT_STORAGE_KEY) : null;
    return stored && (CAPTURE_VIEWPORTS as string[]).includes(stored) ? (stored as PreviewViewport) : 'desktop';
  });
  const setComposerDraft = useAppStore((s) => s.setDraft);
  const cwd = job.config?.workingDirectory ?? '';
  const latestCapture = job.previewCaptures?.[0];
  const rawArtifactUrl = (name: string) =>
    `/api/workflows/artifact-raw?${new URLSearchParams({ path: cwd, workflowId: job.id, name }).toString()}`;

  const pickCaptureViewport = (next: PreviewViewport) => {
    setCaptureViewport(next);
    try { localStorage.setItem(VIEWPORT_STORAGE_KEY, next); } catch { /* private mode */ }
  };

  // G2 — "send to agent": seed the composer with an `@file:` ref to the report
  // (the server expands it into the turn's context at send time, so the primary
  // agent reads the actual capture) plus a short framing line. Appended to any
  // existing draft rather than clobbering it; the operator edits + sends.
  const sendCaptureToComposer = (reportName: string) => {
    const ref = `@file:.arco/workflows/${job.id}/artifacts/${reportName}`;
    const seed = `${ref}\n\nThis is a preview verification capture of the running app. Review it and fix anything broken (console errors, failed requests, layout/accessibility issues).`;
    const current = readDraft(job.id);
    setComposerDraft(job.id, current.trim() ? `${current.trimEnd()}\n\n${seed}` : seed);
  };

  const src = preview?.port ? `/api/preview/${job.id}/` : null;

  // Compute the largest box of the active aspect ratio that fits in the
  // available pane, then derive the scale needed to fit a LOGICAL_W × logicalH
  // iframe into it. Re-runs on every pane size change AND on aspect change.
  // `src` is in the deps so the effect re-fires when the wrapper div mounts
  // for the first time (src null → non-null on first BIND): without that
  // dep, fitWrapRef.current is null on the initial run and the effect
  // early-returns, leaving boxStyle stuck null until something else
  // remounts the component (a tab switch was the workaround that revealed
  // the bug).
  useLayoutEffect(() => {
    const node = fitWrapRef.current;
    if (!node) return;
    const recompute = () => {
      const rect = node.getBoundingClientRect();
      const availW = rect.width;
      const availH = rect.height;
      if (availW <= 0 || availH <= 0) return;
      // Largest box-of-this-ratio that fits: limited by whichever axis runs out.
      const widthFromHeight = availH * (LOGICAL_W / logicalH);
      const boxW = Math.min(availW, widthFromHeight);
      const boxH = boxW * (logicalH / LOGICAL_W);
      setBoxStyle({ width: boxW, height: boxH, scale: boxW / LOGICAL_W });
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(node);
    return () => ro.disconnect();
  }, [logicalH, src]);

  const cycleAspect = (next: AspectRatio) => {
    setAspect(next);
    try { localStorage.setItem(ASPECT_STORAGE_KEY, next); } catch { /* private mode */ }
  };

  // Sync the input when the server-confirmed port changes (initial hydrate,
  // a different observer set the port, etc.). Skip if the operator is mid-edit
  // typing a different value — `document.activeElement` check.
  useEffect(() => {
    if (document.activeElement !== iframeRef.current && document.activeElement?.tagName !== 'INPUT') {
      setDraft(preview ? String(preview.port) : '');
    }
  }, [preview?.port]);

  // The iframe URL doesn't encode the upstream port (the server proxies by
  // workflowId), so a rebind from one port to another would otherwise leave
  // the iframe pointed at the OLD content. Folding the port into the React
  // key forces a remount whenever the binding changes — same effect as a
  // refresh, scoped to that one transition.
  const iframeReactKey = `${preview?.port ?? 'none'}-${iframeKey}`;

  const submit = () => {
    const n = parseInt(draft.trim(), 10);
    if (!Number.isFinite(n) || n < 1 || n > 65535) return;
    onSetPort?.(n);
  };

  const refresh = () => {
    // Force iframe remount. Cheaper than fiddling with src and survives any
    // backend that doesn't honor cache-control headers.
    setIframeKey((k) => k + 1);
  };

  // Click on a history pill: probe the port first. If alive, behave like a
  // normal bind; if dead, open the picker modal so the operator can choose
  // a currently-listening service to bind to instead.
  const tryRebind = async (port: number, framework?: string) => {
    if (probing) return;
    setProbing(true);
    try {
      const r = await fetch(`/api/preview/probe?port=${port}`);
      if (r.ok) {
        const data = (await r.json()) as { alive?: boolean };
        if (data.alive) {
          onSetPort?.(port, framework);
          return;
        }
      }
      // Dead — fetch listing for the modal. Empty list on non-Linux is fine;
      // the modal still surfaces the "no longer running" message.
      const listing = await fetch('/api/preview/listening')
        .then((res) => (res.ok ? res.json() : { entries: [] }))
        .catch(() => ({ entries: [] as ListeningEntry[] }));
      setDeadPort(port);
      setPickerEntries(listing.entries ?? []);
    } finally {
      setProbing(false);
    }
  };

  // §C2 — RE-PROBE the currently-bound port (distinct from the history-pill
  // flow, which probes a port the operator clicked to switch TO). If the bound
  // dev server is still listening, reload the iframe; if it's gone, open the
  // dead-service picker so the operator can rebind to a live service. This is
  // the targeted recovery for a bound-but-unreachable preview.
  const reprobeBound = async () => {
    const port = preview?.port;
    if (port === undefined || probing) return;
    setProbing(true);
    try {
      const r = await fetch(`/api/preview/probe?port=${port}`);
      if (r.ok) {
        const data = (await r.json()) as { alive?: boolean };
        if (data.alive) {
          refresh();
          return;
        }
      }
      const listing = await fetch('/api/preview/listening')
        .then((res) => (res.ok ? res.json() : { entries: [] }))
        .catch(() => ({ entries: [] as ListeningEntry[] }));
      setDeadPort(port);
      setPickerEntries(listing.entries ?? []);
    } finally {
      setProbing(false);
    }
  };

  const closePicker = () => {
    setDeadPort(null);
    setPickerEntries(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '8px 10px',
          borderBottom: '1px solid var(--color-border-hairline)',
          flexShrink: 0,
          fontFamily: 'var(--font-display)',
          fontSize: '10px',
          letterSpacing: '1px',
          color: 'var(--color-fg-muted)',
        }}
      >
        <span>PORT</span>
        <input
          type="text"
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="5173"
          data-help="preview.port"
          style={{
            width: '64px',
            padding: '3px 6px',
            background: 'var(--color-bg-input, var(--color-bg-elevated))',
            color: 'var(--color-fg-default)',
            border: '1px solid var(--color-border-hairline)',
            fontSize: '11px',
            fontFamily: 'var(--font-code)',
            outline: 'none',
          }}
        />
        <button
          onClick={submit}
          disabled={!draft || draft === String(preview?.port ?? '')}
          style={tabBtnStyle(true)}
          data-help="preview.bind"
        >
          BIND
        </button>
        <button onClick={refresh} disabled={!src} style={tabBtnStyle(false)} title="Reload iframe" data-help="preview.reload">
          RELOAD
        </button>
        {preview && (
          <button
            onClick={reprobeBound}
            disabled={probing}
            style={tabBtnStyle(false)}
            title="Re-check whether the bound port is still listening; opens the picker if it's gone"
            data-help="preview.reprobe"
          >
            RE-PROBE
          </button>
        )}
        {src && (
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...tabBtnStyle(false), textDecoration: 'none', display: 'inline-block' }}
            title="Open preview in a new tab"
            data-help="preview.open"
          >
            OPEN
          </a>
        )}
        {preview && (
          <button onClick={onClear} style={tabBtnStyle(false)} title="Unbind preview port" data-help="preview.unbind">
            UNBIND
          </button>
        )}
        <span
          data-help="preview.aspect"
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            border: '1px solid var(--color-border-hairline)',
          }}
          title="Iframe aspect ratio"
        >
          {ASPECT_RATIOS.map((r) => (
            <button
              key={r}
              onClick={() => cycleAspect(r)}
              style={{
                ...tabBtnStyle(aspect === r),
                border: 'none',
                borderLeft: r === '4:3' ? 'none' : '1px solid var(--color-border-hairline)',
              }}
            >
              {r}
            </button>
          ))}
        </span>
        <span style={{ opacity: 0.7, marginLeft: '8px' }}>
          {preview ? `:${preview.port}` : 'unbound'}
        </span>
      </div>

      {/* VERIFY PREVIEW (G1) — operator-triggered CDP capture of the bound dev
          server. Each button scopes the report; the server runs the same capture
          session. Shown only when a port is bound. */}
      {preview && (
        <div
          data-help="preview.verify"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 10px',
            borderBottom: '1px solid var(--color-border-hairline)',
            flexShrink: 0,
            fontFamily: 'var(--font-display)',
            fontSize: '10px',
            letterSpacing: '1px',
            color: 'var(--color-fg-muted)',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ opacity: 0.7 }}>VERIFY</span>
          <button onClick={() => onCapture?.(['screenshot'], captureViewport)} disabled={job.previewCapturing} style={tabBtnStyle(false)} title="Capture a screenshot of the running preview">
            CAPTURE SCREENSHOT
          </button>
          <button onClick={() => onCapture?.(['console'], captureViewport)} disabled={job.previewCapturing} style={tabBtnStyle(false)} title="Collect console errors + warnings from the running preview">
            CHECK CONSOLE
          </button>
          <button onClick={() => onCapture?.(['network'], captureViewport)} disabled={job.previewCapturing} style={tabBtnStyle(false)} title="Collect failed + error-status network requests from the running preview">
            CHECK NETWORK
          </button>
          {/* G2 — capture viewport preset. Renders the page at desktop/tablet/
              mobile (tablet/mobile emulate touch + DPR so responsive breakpoints
              fire). Always collected: layout/accessibility notes. */}
          <span
            data-help="preview.viewport"
            style={{ display: 'inline-flex', border: '1px solid var(--color-border-hairline)' }}
            title="Device-class viewport the capture renders at"
          >
            {CAPTURE_VIEWPORTS.map((v) => (
              <button
                key={v}
                onClick={() => pickCaptureViewport(v)}
                disabled={job.previewCapturing}
                style={{
                  ...tabBtnStyle(captureViewport === v),
                  border: 'none',
                  borderLeft: v === 'desktop' ? 'none' : '1px solid var(--color-border-hairline)',
                }}
              >
                {VIEWPORT_LABEL[v]}
              </button>
            ))}
          </span>
          {job.previewCapturing ? (
            <span style={{ opacity: 0.7 }}>CAPTURING…</span>
          ) : latestCapture ? (
            latestCapture.ok ? (
              <span style={{ opacity: 0.85 }}>
                {latestCapture.summary?.viewport ? `${latestCapture.summary.viewport} · ` : ''}
                {(latestCapture.summary?.consoleErrors ?? 0)} console · {(latestCapture.summary?.failedRequests ?? 0)} net
                {latestCapture.summary?.layoutFlags ? ` · ${latestCapture.summary.layoutFlags} layout` : ''}
              </span>
            ) : (
              <span style={{ color: 'var(--color-error, #e66)' }} title={latestCapture.error}>capture failed</span>
            )
          ) : null}
        </div>
      )}

      {/* Latest capture result strip — title + counts + thumbnail + report link.
          Persisted artifacts; the iframe above is the live view, this is the
          captured evidence. */}
      {preview && latestCapture && !job.previewCapturing && (
        <div
          data-help="preview.captures"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '6px 10px',
            borderBottom: '1px solid var(--color-border-hairline)',
            flexShrink: 0,
            fontFamily: 'var(--font-code)',
            fontSize: '11px',
            color: 'var(--color-fg-muted)',
          }}
        >
          {latestCapture.ok ? (
            <>
              {latestCapture.imageName && cwd && (
                <a href={rawArtifactUrl(latestCapture.imageName)} target="_blank" rel="noopener noreferrer" title="Open full screenshot">
                  <img
                    src={rawArtifactUrl(latestCapture.imageName)}
                    alt="preview screenshot"
                    style={{ height: '40px', border: '1px solid var(--color-border-hairline)', display: 'block' }}
                  />
                </a>
              )}
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {latestCapture.summary?.title || latestCapture.summary?.url || 'captured'}
              </span>
              {latestCapture.reportName && cwd && (
                <button onClick={() => setOpenReport(latestCapture.reportName!)} style={tabBtnStyle(false)}>
                  VIEW REPORT
                </button>
              )}
              {/* G2 — get the captured evidence to an LLM. SEND TO AGENT seeds
                  the in-tab composer with an @file ref + framing (operator edits
                  + sends); ATTACH TO REVIEW fires a reviewer over the report. */}
              {latestCapture.reportName && (
                <button
                  onClick={() => sendCaptureToComposer(latestCapture.reportName!)}
                  style={tabBtnStyle(false)}
                  title="Seed the composer with this report for the current agent"
                  data-help="preview.captureActions"
                >
                  SEND TO AGENT
                </button>
              )}
              {latestCapture.reportName && onReviewCapture && (
                <button
                  onClick={() => onReviewCapture(latestCapture.reportName!)}
                  style={tabBtnStyle(false)}
                  title="Run a Review over this capture report"
                  data-help="preview.captureActions"
                >
                  ATTACH TO REVIEW
                </button>
              )}
            </>
          ) : (
            <span style={{ color: 'var(--color-error, #e66)' }}>{latestCapture.error || 'capture failed'}</span>
          )}
        </div>
      )}

      {openReport && cwd && (
        <ReportModal cwd={cwd} workflowId={job.id} name={openReport} onClose={() => setOpenReport(null)} />
      )}

      {/* History pills — surfaced only when there's at least one prior bind for
          this workflow. Click rebinds via the same path as typing a port and
          hitting BIND. Currently-bound entry is rendered in the pressed-in
          style so it reads as "you're here" rather than as a target. */}
      {job.previewHistory && job.previewHistory.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 10px',
            borderBottom: '1px solid var(--color-border-hairline)',
            flexShrink: 0,
            fontFamily: 'var(--font-display)',
            fontSize: '10px',
            letterSpacing: '1px',
            color: 'var(--color-fg-muted)',
          }}
        >
          <span style={{ opacity: 0.7 }}>RECENT</span>
          {job.previewHistory.map((entry) => {
            const active = preview?.port === entry.port;
            return (
              <button
                key={entry.port}
                onClick={() => tryRebind(entry.port, entry.framework)}
                disabled={probing}
                style={tabBtnStyle(active)}
                title={entry.framework ? `:${entry.port} (${entry.framework})` : `:${entry.port}`}
              >
                :{entry.port}
              </button>
            );
          })}
        </div>
      )}

      {src ? (
        // Fit-to-pane 4:3 viewport. The iframe is given a fixed logical
        // viewport (LOGICAL_W × logicalH) so the inner app lays out as on a
        // normal monitor; we then CSS-scale that down to the largest box of
        // the operator-selected aspect ratio the pane can hold. No clipping
        // in either axis — we use whichever of width or height runs out
        // first as the constraint.
        <div
          ref={fitWrapRef}
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            overflow: 'hidden',
          }}
        >
          {boxStyle && (
            <div
              style={{
                width: boxStyle.width,
                height: boxStyle.height,
                position: 'relative',
                overflow: 'hidden',
                flexShrink: 0,
              }}
            >
              <iframe
                key={iframeReactKey}
                ref={iframeRef}
                src={src}
                title="Workflow dev-server preview"
                sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: LOGICAL_W,
                  height: logicalH,
                  border: 'none',
                  transformOrigin: 'top left',
                  transform: `scale(${boxStyle.scale})`,
                  background: 'var(--color-bg-default, #fff)',
                }}
              />
            </div>
          )}
        </div>
      ) : (
        <div
          className="display-font"
          style={{
            padding: '24px 18px',
            color: 'var(--color-fg-muted)',
            fontSize: '11px',
            letterSpacing: '0.5px',
            lineHeight: 1.6,
          }}
        >
          No port bound. Type the dev-server port (e.g. 5173 for Vite, 3000 for Next) and hit BIND.
          The iframe loads through Arco's proxy so HMR keeps working over the same WebSocket origin.
        </div>
      )}

      {deadPort !== null && (
        <DeadServiceModal
          deadPort={deadPort}
          entries={pickerEntries ?? []}
          onPick={(entry) => {
            closePicker();
            // Pass no framework — entry.command is the process name (node,
            // bun, python3 etc.), not a framework label. The bind UI doesn't
            // surface framework strongly anyway and a misleading label is
            // worse than no label.
            onSetPort?.(entry.port);
          }}
          onClose={closePicker}
        />
      )}
    </div>
  );
}

interface DeadServiceModalProps {
  deadPort: number;
  entries: ListeningEntry[];
  onPick: (entry: ListeningEntry) => void;
  onClose: () => void;
}

// Modal shown when a history-pill click hits a port that's no longer
// listening. Lists the currently-listening services on the box (Linux
// only; empty array on macOS — message still informs the operator). Click
// to bind. The picker is best-effort: we can't guarantee the right service
// since multiple workflows can spawn dev servers, but this is faster than
// having the operator hunt for the port themselves.
function DeadServiceModal({ deadPort, entries, onPick, onClose }: DeadServiceModalProps) {
  // Esc to close — registered with capture so a stacked modal (Manual,
  // DocViewer) doesn't swallow it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        zIndex: 1100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glow-border"
        style={{
          background: 'var(--color-bg-panel, var(--color-bg-elevated))',
          border: '1px solid var(--color-border-bright)',
          padding: '20px 22px',
          minWidth: '380px',
          maxWidth: '520px',
          maxHeight: 'calc(70vh / var(--ui-scale, 1))',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'var(--font-display)',
          fontSize: '11px',
          letterSpacing: '0.5px',
          color: 'var(--color-fg-muted)',
        }}
      >
        <div style={{ color: 'var(--color-accent-primary)', fontSize: '12px', marginBottom: '8px' }}>
          PREVIEW :{deadPort} NOT RESPONDING
        </div>
        <div style={{ marginBottom: '14px', lineHeight: 1.6 }}>
          The dev server previously bound to port {deadPort} is no longer listening.
          {entries.length > 0
            ? ' Pick a currently-listening service below to bind, or close and BIND a port manually.'
            : ' Close and BIND a different port manually.'}
        </div>
        {entries.length > 0 && (
          <div style={{ overflowY: 'auto', minHeight: 0, marginBottom: '12px' }}>
            {entries.map((entry) => (
              <button
                key={entry.port}
                onClick={() => onPick(entry)}
                style={{
                  display: 'flex',
                  width: '100%',
                  padding: '6px 8px',
                  background: 'transparent',
                  border: '1px solid var(--color-border-hairline)',
                  color: 'var(--color-fg-default)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-code)',
                  fontSize: '11px',
                  textAlign: 'left',
                  marginBottom: '4px',
                }}
                title={`pid ${entry.pid}`}
              >
                <span style={{ minWidth: '60px', color: 'var(--color-accent-primary)' }}>:{entry.port}</span>
                <span style={{ flex: 1, opacity: 0.85 }}>{entry.command || '(unknown)'}</span>
                <span style={{ opacity: 0.5, marginLeft: '8px' }}>pid {entry.pid}</span>
              </button>
            ))}
          </div>
        )}
        <button
          onClick={onClose}
          style={{
            alignSelf: 'flex-end',
            padding: '4px 12px',
            background: 'transparent',
            border: '1px solid var(--color-border-hairline)',
            color: 'var(--color-fg-muted)',
            cursor: 'pointer',
            fontFamily: 'var(--font-display)',
            fontSize: '10px',
            letterSpacing: '1px',
          }}
        >
          CLOSE
        </button>
      </div>
    </div>
  );
}

// G1 — read-only viewer for a preview-capture markdown report. Fetches the
// artifact (JSON-wrapped text) and renders it as a <pre>, matching the Review/
// Research artifact-viewing convention. Esc / backdrop-click closes.
function ReportModal({ cwd, workflowId, name, onClose }: { cwd: string; workflowId: string; name: string; onClose: () => void }) {
  const [body, setBody] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams({ path: cwd, workflowId, name });
    fetch(`/api/workflows/artifact?${q.toString()}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ contents: string }>) : Promise.reject(r.statusText)))
      .then((d) => { if (!cancelled) setBody(d.contents); })
      .catch((err) => { if (!cancelled) setLoadError(String(err)); });
    return () => { cancelled = true; };
  }, [cwd, workflowId, name]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glow-border"
        style={{
          background: 'var(--color-bg-panel, var(--color-bg-elevated))',
          border: '1px solid var(--color-border-bright)',
          padding: '18px 20px',
          minWidth: '420px',
          maxWidth: '760px',
          maxHeight: 'calc(80vh / var(--ui-scale, 1))',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'var(--font-display)',
          color: 'var(--color-fg-muted)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px' }}>
          <span style={{ color: 'var(--color-accent-primary)', fontSize: '12px', letterSpacing: '1px', flex: 1 }}>{name}</span>
          <button onClick={onClose} style={tabBtnStyle(false)}>CLOSE</button>
        </div>
        {loadError ? (
          <div style={{ color: 'var(--color-error, #e66)', fontSize: '11px' }}>Failed to load report: {loadError}</div>
        ) : body === null ? (
          <div style={{ fontSize: '11px', opacity: 0.7 }}>Loading…</div>
        ) : (
          <pre style={{ overflow: 'auto', minHeight: 0, margin: 0, fontFamily: 'var(--font-code)', fontSize: '11px', lineHeight: 1.5, color: 'var(--color-fg-default)', whiteSpace: 'pre-wrap' }}>
            {body}
          </pre>
        )}
      </div>
    </div>
  );
}

function tabBtnStyle(primary: boolean): React.CSSProperties {
  return {
    padding: '3px 8px',
    background: primary ? 'var(--color-accent-primary-a08)' : 'transparent',
    border: '1px solid var(--color-border-hairline)',
    color: primary ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
    cursor: 'pointer',
    fontSize: '10px',
    letterSpacing: '1px',
    fontFamily: 'var(--font-display)',
  };
}
