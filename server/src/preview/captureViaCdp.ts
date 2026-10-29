
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { WebSocket } from 'ws';
import type {
  PreviewConsoleEntry,
  PreviewNetworkEntry,
  PreviewLayoutNotes,
  PreviewViewport,
} from '@arco/shared';

// G2 — device-class presets. `desktop` is the G1 default (no mobile emulation);
// `tablet`/`mobile` set a narrower logical viewport and flip on mobile device-
// metrics so responsive layouts collapse like they would on the real device.
// Sizes are conventional CSS-px logical viewports (Chrome DevTools device list),
// not physical pixels — `deviceScaleFactor` carries the DPR separately.
export const VIEWPORT_PRESETS: Record<
  PreviewViewport,
  { width: number; height: number; mobile: boolean; deviceScaleFactor: number }
> = {
  desktop: { width: 1280, height: 800, mobile: false, deviceScaleFactor: 1 },
  tablet: { width: 834, height: 1112, mobile: true, deviceScaleFactor: 2 },
  mobile: { width: 390, height: 844, mobile: true, deviceScaleFactor: 3 },
};

// G2 — in-page layout/accessibility probe. Runs once via Runtime.evaluate after
// the page settles; returns a plain object (returnByValue). Self-contained IIFE,
// fully defensive (wrapped in try/catch returning {}), and read-only — it counts
// DOM signals and measures overflow, never mutates. Kept deliberately shallow:
// these are smells worth a look, not a WCAG audit.
const LAYOUT_PROBE = `(() => { try {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const named = (el) =>
    !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title'));
  const inputs = q('input, select, textarea').filter((el) => el.type !== 'hidden');
  const inputsMissingLabel = inputs.filter((el) => {
    if (named(el)) return false;
    if (el.id) { try { if (document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return false; } catch (_) {} }
    if (el.closest('label')) return false;
    return true;
  }).length;
  const controls = q('button, a[href], [role="button"]');
  const controlsMissingName = controls.filter((el) => {
    if ((el.textContent || '').trim()) return false;
    if (named(el)) return false;
    if (el.querySelector('img[alt]:not([alt=""])')) return false;
    return true;
  }).length;
  const de = document.documentElement;
  return {
    lang: de.getAttribute('lang') || '',
    hasTitle: !!(document.title || '').trim(),
    viewportMetaPresent: !!document.querySelector('meta[name="viewport"]'),
    h1Count: q('h1').length,
    horizontalOverflowPx: Math.max(0, de.scrollWidth - de.clientWidth),
    imagesMissingAlt: q('img:not([alt])').length,
    inputsMissingLabel: inputsMissingLabel,
    controlsMissingName: controlsMissingName,
  };
} catch (_) { return {}; } })()`;

// ---- browser discovery -----------------------------------------------------

// PATH-resolvable command names (Linux + generic). Ordered most-preferred first.
const LINUX_CANDIDATES = [
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
  'chrome',
  'brave-browser',
  'brave',
  'microsoft-edge',
];

// Absolute macOS app-bundle executables.
const MACOS_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

// Resolve a usable Chrome/Chromium executable, or null if none is installed.
// Honors `ARCO_CHROME_BINARY` / `CHROME_PATH` overrides first so the operator
// can point at a non-standard install (and so the smoke can pin a known binary).
export function findBrowserBinary(): string | null {
  const override = process.env.ARCO_CHROME_BINARY || process.env.CHROME_PATH;
  if (override && existsSync(override)) return override;

  const pathDirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const name of LINUX_CANDIDATES) {
    for (const dir of pathDirs) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  for (const abs of MACOS_CANDIDATES) {
    if (existsSync(abs)) return abs;
  }
  return null;
}

// ---- minimal raw CDP client over `ws` --------------------------------------

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

// One page-level CDP session. We connect directly to a page target's
// `webSocketDebuggerUrl` (no flatten/sessionId needed) and issue domain
// commands against it.
class CdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Array<(params: any) => void>>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => this.onMessage(data.toString()));
  }

  static connect(wsUrl: string, timeoutMs = 8000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('CDP connect timeout'));
      }, timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') {
      const hs = this.listeners.get(msg.method);
      if (hs) for (const h of hs) h(msg.params || {});
    }
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  on(method: string, handler: (params: any) => void): void {
    const hs = this.listeners.get(method) || [];
    hs.push(handler);
    this.listeners.set(method, hs);
  }

  close(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('CDP client closed'));
    }
    this.pending.clear();
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
  }
}

// ---- headless launch + DevTools endpoint discovery -------------------------

interface LaunchedBrowser {
  child: ChildProcess;
  cdpPort: number;
  userDataDir: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Spawn headless Chrome and resolve the chosen CDP port. `--remote-debugging-
// port=0` lets the OS pick a free port; Chrome writes it (plus the browser ws
// path) to `<user-data-dir>/DevToolsActivePort`, which we poll.
async function launchHeadless(binary: string, viewport: { width: number; height: number }): Promise<LaunchedBrowser> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'arco-preview-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--mute-audio',
    `--window-size=${viewport.width},${viewport.height}`,
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ];
  const child = spawn(binary, args, { stdio: 'ignore' });

  const portFile = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 12000;
  let cdpPort = 0;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`browser exited early (code ${child.exitCode})`);
    }
    try {
      const txt = await readFile(portFile, 'utf8');
      const firstLine = txt.split('\n')[0]?.trim();
      const p = Number(firstLine);
      if (Number.isFinite(p) && p > 0) {
        cdpPort = p;
        break;
      }
    } catch {
      /* not written yet */
    }
    await delay(150);
  }
  if (!cdpPort) {
    child.kill('SIGKILL');
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw new Error('browser did not expose a DevTools port');
  }
  return { child, cdpPort, userDataDir };
}

// Find the default page target's debugger WS url via the HTTP `/json` endpoint.
async function findPageTarget(cdpPort: number): Promise<string> {
  const deadline = Date.now() + 6000;
  let lastErr = 'no page target';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const targets = (await res.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
        lastErr = 'targets listed but no page';
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await delay(150);
  }
  throw new Error(`could not resolve page target: ${lastErr}`);
}

// ---- the capture ------------------------------------------------------------

export interface CaptureResult {
  ok: boolean;
  error?: string;
  url?: string;
  title?: string;
  console: PreviewConsoleEntry[];
  network: PreviewNetworkEntry[];
  // base64 JPEG, present on success.
  screenshotBase64?: string;
  browserBinary?: string;
  // G2 — layout/accessibility notes from the rendered page. Best-effort: absent
  // if the in-page probe failed (it never blocks the capture).
  layout?: PreviewLayoutNotes;
}

export interface CaptureOptions {
  // dev-server port the preview is bound to (we hit it directly on loopback).
  port: number;
  // G2 — device-class preset; resolved to dimensions + mobile emulation via
  // VIEWPORT_PRESETS. Defaults to 'desktop'.
  viewport?: PreviewViewport;
  // total wall-clock budget; the browser is force-killed past this.
  navigateTimeoutMs?: number;
}

const MAX_ENTRIES = 50;

// Drive a system headless browser to the preview and collect evidence. Always
// resolves (never rejects) — failures land in `{ ok:false, error }` so the
// caller can broadcast a clean result.
export async function capturePreview(opts: CaptureOptions): Promise<CaptureResult> {
  const viewportName: PreviewViewport = opts.viewport ?? 'desktop';
  const preset = VIEWPORT_PRESETS[viewportName] ?? VIEWPORT_PRESETS.desktop;
  const viewport = { width: preset.width, height: preset.height };
  const navTimeout = opts.navigateTimeoutMs ?? 20000;
  const url = `http://127.0.0.1:${opts.port}/`;

  const binary = findBrowserBinary();
  if (!binary) {
    return {
      ok: false,
      error:
        'No Chrome/Chromium found. Install one, or set ARCO_CHROME_BINARY to its path, to enable preview capture.',
      console: [],
      network: [],
    };
  }

  let browser: LaunchedBrowser | null = null;
  let client: CdpClient | null = null;
  const consoleEntries: PreviewConsoleEntry[] = [];
  const network: PreviewNetworkEntry[] = [];
  const requestMeta = new Map<string, { url: string; method?: string }>();

  try {
    browser = await launchHeadless(binary, viewport);
    const wsUrl = await findPageTarget(browser.cdpPort);
    client = await CdpClient.connect(wsUrl);

    client.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error' && p.type !== 'warning') return;
      if (consoleEntries.length >= MAX_ENTRIES) return;
      const text = (p.args || [])
        .map((a: any) => (a.value !== undefined ? String(a.value) : a.description || a.type || ''))
        .join(' ')
        .trim();
      const frame = (p.stackTrace?.callFrames || [])[0];
      consoleEntries.push({
        level: p.type === 'error' ? 'error' : 'warning',
        text: text || '(empty console message)',
        ...(frame?.url ? { source: `${frame.url}:${frame.lineNumber ?? 0}` } : {}),
      });
    });
    client.on('Runtime.exceptionThrown', (p) => {
      if (consoleEntries.length >= MAX_ENTRIES) return;
      const d = p.exceptionDetails || {};
      const text = d.exception?.description || d.text || 'Uncaught exception';
      consoleEntries.push({
        level: 'error',
        text: String(text),
        ...(d.url ? { source: `${d.url}:${d.lineNumber ?? 0}` } : {}),
      });
    });
    client.on('Log.entryAdded', (p) => {
      const e = p.entry || {};
      if (e.level !== 'error' && e.level !== 'warning') return;
      if (consoleEntries.length >= MAX_ENTRIES) return;
      consoleEntries.push({
        level: e.level,
        text: String(e.text || ''),
        ...(e.url ? { source: `${e.url}:${e.lineNumber ?? 0}` } : {}),
      });
    });
    client.on('Network.requestWillBeSent', (p) => {
      if (p.requestId && p.request?.url) {
        requestMeta.set(p.requestId, { url: p.request.url, method: p.request.method });
      }
    });
    client.on('Network.responseReceived', (p) => {
      const status = p.response?.status;
      if (typeof status === 'number' && status >= 400 && network.length < MAX_ENTRIES) {
        network.push({
          url: p.response.url || requestMeta.get(p.requestId)?.url || '(unknown)',
          status,
          method: requestMeta.get(p.requestId)?.method,
        });
      }
    });
    client.on('Network.loadingFailed', (p) => {
      if (p.canceled) return;
      const meta = requestMeta.get(p.requestId);
      if (network.length < MAX_ENTRIES) {
        network.push({
          url: meta?.url || '(unknown)',
          errorText: String(p.errorText || 'request failed'),
          method: meta?.method,
        });
      }
    });

    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Log.enable');
    await client.send('Network.enable');

    // G2 — pin the rendering viewport via device-metrics override. `--window-
    // size` (set at launch) only sizes the OS window; the override is what makes
    // the page lay out at exactly preset.width × preset.height and (for tablet/
    // mobile) treats it as a touch device at the right DPR, so responsive
    // breakpoints fire. Best-effort — a refusal must not abort the capture.
    try {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: preset.width,
        height: preset.height,
        deviceScaleFactor: preset.deviceScaleFactor,
        mobile: preset.mobile,
      }, 4000);
      if (preset.mobile) {
        await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, 4000).catch(() => {});
      }
    } catch {
      /* emulation is best-effort; fall back to the launch window size */
    }

    // Navigate and wait for load (or the budget). A connection-refused preview
    // still resolves — we capture whatever the error page shows.
    const loaded = new Promise<void>((resolve) => {
      client!.on('Page.loadEventFired', () => resolve());
    });
    let navError: string | undefined;
    try {
      const navRes = await client.send('Page.navigate', { url }, navTimeout);
      if (navRes?.errorText) navError = String(navRes.errorText);
    } catch (err) {
      navError = err instanceof Error ? err.message : String(err);
    }
    await Promise.race([loaded, delay(navTimeout)]);
    // brief settle so late console/network events land
    await delay(800);

    let title: string | undefined;
    let finalUrl: string | undefined;
    try {
      const t = await client.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, 4000);
      if (typeof t?.result?.value === 'string') title = t.result.value;
      const u = await client.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, 4000);
      if (typeof u?.result?.value === 'string') finalUrl = u.result.value;
    } catch {
      /* evaluate is best-effort */
    }

    // G2 — basic layout + accessibility probe. One self-contained expression so
    // it's a single round-trip; returnByValue serializes the plain object back.
    // Purely observational (querySelector counts, scrollWidth) — never mutates
    // the page. Best-effort: any failure leaves `layout` undefined.
    let layout: PreviewLayoutNotes | undefined;
    try {
      const probe = await client.send('Runtime.evaluate', { expression: LAYOUT_PROBE, returnByValue: true }, 5000);
      const v = probe?.result?.value;
      if (v && typeof v === 'object') {
        layout = {
          viewport: viewportName,
          width: preset.width,
          height: preset.height,
          lang: typeof v.lang === 'string' ? v.lang : '',
          hasTitle: !!v.hasTitle,
          viewportMetaPresent: !!v.viewportMetaPresent,
          h1Count: Number(v.h1Count) || 0,
          horizontalOverflowPx: Math.max(0, Number(v.horizontalOverflowPx) || 0),
          imagesMissingAlt: Number(v.imagesMissingAlt) || 0,
          inputsMissingLabel: Number(v.inputsMissingLabel) || 0,
          controlsMissingName: Number(v.controlsMissingName) || 0,
        };
      }
    } catch {
      /* layout probe is best-effort */
    }

    let screenshotBase64: string | undefined;
    try {
      const shot = await client.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, 10000);
      if (typeof shot?.data === 'string') screenshotBase64 = shot.data;
    } catch {
      /* screenshot is best-effort */
    }

    if (navError && consoleEntries.length < MAX_ENTRIES) {
      consoleEntries.unshift({ level: 'error', text: `Navigation reported: ${navError}` });
    }

    return {
      ok: true,
      url: finalUrl || url,
      title,
      console: consoleEntries,
      network,
      screenshotBase64,
      browserBinary: binary,
      layout,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      console: consoleEntries,
      network,
      browserBinary: binary,
    };
  } finally {
    try {
      client?.close();
    } catch {
      /* noop */
    }
    if (browser) {
      try {
        browser.child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      await rm(browser.userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
