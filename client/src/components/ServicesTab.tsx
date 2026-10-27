import { useEffect, useMemo, useState } from 'react';
import type { LocalService, ServicesResponse, PinnedService, ArcoSettings } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { EmptyState } from './RightPanel/FilesTab';

// -- Services tab (docs/LOCAL_SERVICES.md) --
//
// A MACHINE-WIDE (not workflow-scoped) browser of the local listening web/dev
// services discovered by L1's GET /api/services. Because it is project-agnostic
// it lives in the System modal (alongside Diagnostics / Model Health / Support
// Bundle) — NOT the per-workflow right panel, where tabs + active-tab state are
// scoped to a workflow's cwd. Compact dense rows (cloned from TasksPanel) —
// hover reveals quick actions + the cwd, click expands a row to its full meta
// (cmdline/cwd/pid/host) + the full action set.
//
// Operator-triggered + bounded. On mount + REFRESH it fetches once; a ~5s
// auto-poll re-triggers while the tab is mounted (the System modal only renders
// this body when active, so an unmount clearInterval is sufficient). The ONE
// mutation — KILL — is a two-step inline confirm hitting DELETE /api/services/
// :pid (SIGTERM, server-guarded). Pins live in global settings keyed by a
// stable (cwd, port) identity, so a pinned-but-dead service shows as an offline
// row.
//
// L3 adds three reuse-only surfaces: (1) "Open in Live Preview" — binds a
// service's port to the FOCUSED workflow's preview proxy (set_preview_port) and
// flips its right panel to PREVIEW via the arco:open-preview CustomEvent;
// (2) an operator-toggled HEALTH dot (default OFF — probing spawns network
// requests, so it must be armed) reusing GET /api/preview/probe; and (3) a
// display-only THIS WORKFLOW group floating discovered services whose cwd
// matches the focused workflow's cwd above PINNED / DISCOVERED.

const POLL_INTERVAL_MS = 5000;

// (cwd, port) is the pin identity (matches the server sanitizer).
function pinKey(cwd: string | null, port: number): string {
  return `${cwd ?? ''}|${port}`;
}

const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between',
  padding: '8px 14px', fontSize: '10px', letterSpacing: '1.5px',
  color: 'var(--color-fg-muted)', borderBottom: '1px solid var(--color-border-hairline)',
};

const subHeaderStyle: React.CSSProperties = {
  padding: '6px 14px 2px', fontSize: '9px', letterSpacing: '1.5px',
  color: 'var(--color-fg-muted)',
};

// 22px square icon-button (cloned from PlanListRow.tsx) + a danger variant.
const serviceRowBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  color: 'var(--color-accent-primary-dim)',
  cursor: 'pointer',
  fontSize: '9px',
  letterSpacing: '1px',
  padding: '2px 8px',
  fontFamily: 'var(--font-display)',
};

const serviceRowBtnDanger: React.CSSProperties = {
  ...serviceRowBtn,
  border: '1px solid var(--color-danger)',
  color: 'var(--color-danger)',
};

const serviceRowBtnDisabled: React.CSSProperties = {
  ...serviceRowBtn,
  color: 'var(--color-fg-muted)',
  borderColor: 'var(--color-border-hairline)',
  opacity: 0.5,
  cursor: 'default',
};

// Per-service health states for the operator-toggled HEALTH dot.
type HealthState = 'alive' | 'dead' | 'probing';

export function ServicesTab({
  onSetPreviewPort,
  onClose,
}: {
  // Raw 3-arg set_preview_port dispatch; absent only if a caller forgets to
  // thread it (the PREVIEW button disables itself in that case).
  onSetPreviewPort?: (workflowId: string, port: number, framework?: string) => void;
  onClose?: () => void;
} = {}) {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  // Focused workflow — its id is the preview target, its cwd drives the THIS
  // WORKFLOW group. activeJobId is null on cluster tabs / fresh boot.
  const activeJobId = useAppStore((s) => s.activeJobId);
  const focusedCwd = useAppStore((s) => (s.activeJobId ? s.jobs[s.activeJobId]?.config.workingDirectory : undefined)) ?? null;

  const [data, setData] = useState<ServicesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bump to refetch (REFRESH + the poll tick both bump it).
  const [nonce, setNonce] = useState(0);
  // Web-only filter — default ON (show only likelyWeb). Local state; persisting
  // it is optional in L2.
  const [webOnly, setWebOnly] = useState(true);
  // Which row is expanded (by pid|host|port key). One at a time.
  const [expanded, setExpanded] = useState<string | null>(null);
  // HEALTH liveness toggle — default OFF (probing spawns network requests; it
  // must be operator-armed). Local state, not persisted.
  const [health, setHealth] = useState(false);
  // port → liveness, repopulated each poll while HEALTH is on.
  const [healthByPort, setHealthByPort] = useState<Record<number, HealthState>>({});

  const pinned = useMemo<PinnedService[]>(() => settings?.pinnedServices ?? [], [settings]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/services')
      .then((r) => r.json())
      .then((body: ServicesResponse) => {
        if (cancelled) return;
        setData(body);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [nonce]);

  // Bounded auto-poll — re-trigger the fetch every ~5s. The tab body only
  // renders while active (RightPanel conditional), so this interval is created
  // on mount and cleared on unmount; no visibility tracking needed.
  useEffect(() => {
    const id = window.setInterval(() => setNonce((n) => n + 1), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  const services = data?.services ?? [];

  // Discovered set keyed by (cwd, port) for pinned↔discovered matching.
  const discoveredByPin = useMemo(() => {
    const m = new Map<string, LocalService>();
    for (const s of services) m.set(pinKey(s.cwd, s.port), s);
    return m;
  }, [services]);

  const pinnedKeys = useMemo(() => new Set(pinned.map((p) => pinKey(p.cwd, p.port))), [pinned]);

  // Apply the web-only filter to the discovered list.
  const filtered = webOnly ? services.filter((s) => s.likelyWeb) : services;

  // L3 — THIS WORKFLOW: discovered services whose cwd exactly matches the
  // focused workflow's cwd (both absolute paths). Display-only float above
  // PINNED / DISCOVERED. Omitted entirely when there's no focused workflow or
  // nothing matches. These ports are excluded from DISCOVERED below so a row
  // never double-renders; a service that's ALSO pinned still appears in PINNED
  // (the pinned-offline contract is load-bearing) — simplest correct behavior.
  const thisWorkflowRows = focusedCwd
    ? filtered.filter((s) => s.cwd === focusedCwd && !pinnedKeys.has(pinKey(s.cwd, s.port)))
    : [];

  // Pinned rows render first (after THIS WORKFLOW). A pinned entry not in the
  // current (filtered) scan = offline row. The unpinned discovered rows render
  // below, minus any already shown as a pinned row or in THIS WORKFLOW.
  const pinnedRows = pinned.map((p) => {
    const key = pinKey(p.cwd, p.port);
    const live = discoveredByPin.get(key);
    return { key, pin: p, service: live ?? null };
  });
  const unpinnedRows = filtered.filter(
    (s) => !pinnedKeys.has(pinKey(s.cwd, s.port)) && !(focusedCwd != null && s.cwd === focusedCwd),
  );

  const runningCount = services.length;

  // L3 — HEALTH probing. Only the currently-listed, non-offline ports are
  // probed: THIS WORKFLOW + DISCOVERED rows, plus PINNED rows that have a live
  // service (offline/pinned-not-running rows are skipped). Sorted + joined into
  // a stable string so the effect only re-runs when the set actually changes
  // (the row arrays get fresh identities every render).
  const listedLivePorts = useMemo(() => {
    const ports = new Set<number>();
    for (const s of thisWorkflowRows) ports.add(s.port);
    for (const s of unpinnedRows) ports.add(s.port);
    for (const row of pinnedRows) if (row.service) ports.add(row.service.port);
    return [...ports].sort((a, b) => a - b);
  }, [thisWorkflowRows, unpinnedRows, pinnedRows]);
  const listedLivePortsKey = listedLivePorts.join(',');

  // Re-probe each listed port on every poll tick (nonce) while HEALTH is on.
  // Tied to nonce so REFRESH + the ~5s poll both re-probe. AbortController so a
  // toggle-off / unmount / poll-supersede doesn't write to a dead cycle.
  useEffect(() => {
    if (!health) {
      setHealthByPort({});
      return;
    }
    const ports = listedLivePortsKey ? listedLivePortsKey.split(',').map(Number) : [];
    if (ports.length === 0) {
      setHealthByPort({});
      return;
    }
    const ctrl = new AbortController();
    setHealthByPort(Object.fromEntries(ports.map((p) => [p, 'probing' as HealthState])));
    for (const port of ports) {
      fetch(`/api/preview/probe?port=${port}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((body: { alive?: boolean }) => {
          if (ctrl.signal.aborted) return;
          setHealthByPort((prev) => ({ ...prev, [port]: body.alive ? 'alive' : 'dead' }));
        })
        .catch(() => {
          if (ctrl.signal.aborted) return;
          setHealthByPort((prev) => ({ ...prev, [port]: 'dead' }));
        });
    }
    return () => ctrl.abort();
  }, [health, nonce, listedLivePortsKey]);

  // Persist a new pinned-services array to global settings (full-array replace),
  // then mirror into the store — exactly like ConfigTab's settings patches.
  const persistPins = async (next: PinnedService[]) => {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinnedServices: next }),
      });
      if (!res.ok) return;
      const fresh = (await res.json()) as ArcoSettings;
      if (fresh) setSettings(fresh);
    } catch { /* best-effort — the next pin/unpin retries */ }
  };

  const togglePin = (cwd: string | null, port: number) => {
    const key = pinKey(cwd, port);
    if (pinnedKeys.has(key)) {
      persistPins(pinned.filter((p) => pinKey(p.cwd, p.port) !== key));
    } else {
      persistPins([...pinned, { cwd, port, pinnedAt: Date.now() }]);
    }
  };

  if (loading && !data) {
    return <EmptyState text="Scanning local listening sockets…" />;
  }
  if (error) {
    return <EmptyState text={`Couldn't enumerate local services: ${error}`} />;
  }

  const nothing = pinnedRows.length === 0 && unpinnedRows.length === 0 && thisWorkflowRows.length === 0;

  return (
    <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
      <div className="display-font" style={sectionHeaderStyle}>
        <span>SERVICES · {runningCount} running</span>
        <span style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => setWebOnly((v) => !v)}
            data-help="services.webonly"
            title={webOnly ? 'Showing web/dev services only — click to show all listeners' : 'Showing all listeners — click to show web/dev only'}
            className="display-font"
            style={{
              ...serviceRowBtn,
              color: webOnly ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              borderColor: webOnly ? 'var(--color-accent-primary-dim)' : 'var(--color-border-hairline)',
            }}
          >
            {webOnly ? 'WEB' : 'ALL'}
          </button>
          <button
            type="button"
            onClick={() => setHealth((v) => !v)}
            data-help="services.health"
            title={health ? 'Liveness probing ON — click to stop probing' : 'Show a per-service liveness dot (probes each port via the preview health check) — default off'}
            className="display-font"
            style={{
              ...serviceRowBtn,
              color: health ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              borderColor: health ? 'var(--color-accent-primary-dim)' : 'var(--color-border-hairline)',
            }}
          >
            HEALTH
          </button>
          <button
            type="button"
            onClick={() => setNonce((n) => n + 1)}
            data-help="services.refresh"
            title="Re-scan listening sockets"
            className="display-font"
            style={{ ...serviceRowBtn, color: 'var(--color-fg-muted)', fontSize: '9px' }}
          >
            ↻
          </button>
        </span>
      </div>

      {/* L1 degraded (e.g. lsof missing) — show the detail as a notice. */}
      {data?.detail && (
        <div
          className="display-font"
          style={{ padding: '8px 14px', fontSize: '10px', lineHeight: 1.5, color: 'var(--color-warning)', borderBottom: '1px solid var(--color-border-hairline)' }}
        >
          {data.detail}
        </div>
      )}

      {nothing && !data?.detail && (
        <EmptyState text="No local web services detected · start a dev server and it appears here." />
      )}

      {/* L3 — THIS WORKFLOW floats above PINNED / DISCOVERED. Sub-header carries
          the focused cwd basename (e.g. "THIS WORKFLOW · arco"). */}
      {thisWorkflowRows.length > 0 && focusedCwd && (
        <>
          <div className="display-font" style={subHeaderStyle}>
            THIS WORKFLOW · {focusedCwd.split('/').filter(Boolean).pop() ?? focusedCwd}
          </div>
          {thisWorkflowRows.map((s) => {
            const key = pinKey(s.cwd, s.port);
            return (
              <ServiceRow
                key={`tw-${key}-${s.pid ?? 'np'}`}
                rowKey={key}
                service={s}
                pin={null}
                pinned={false}
                expanded={expanded === key}
                onToggleExpand={() => setExpanded((e) => (e === key ? null : key))}
                onTogglePin={() => togglePin(s.cwd, s.port)}
                onKilled={() => setNonce((n) => n + 1)}
                activeJobId={activeJobId}
                health={health ? healthByPort[s.port] : undefined}
                onSetPreviewPort={onSetPreviewPort}
                onClose={onClose}
              />
            );
          })}
        </>
      )}

      {pinnedRows.length > 0 && (
        <>
          <div className="display-font" style={subHeaderStyle}>PINNED</div>
          {pinnedRows.map((row) => (
            <ServiceRow
              key={`pin-${row.key}`}
              rowKey={row.key}
              service={row.service}
              pin={row.pin}
              pinned
              expanded={expanded === row.key}
              onToggleExpand={() => setExpanded((e) => (e === row.key ? null : row.key))}
              onTogglePin={() => togglePin(row.pin.cwd, row.pin.port)}
              onKilled={() => setNonce((n) => n + 1)}
              activeJobId={activeJobId}
              health={health && row.service ? healthByPort[row.service.port] : undefined}
              onSetPreviewPort={onSetPreviewPort}
              onClose={onClose}
            />
          ))}
        </>
      )}

      {unpinnedRows.length > 0 && (
        <>
          {(pinnedRows.length > 0 || thisWorkflowRows.length > 0) && <div className="display-font" style={subHeaderStyle}>DISCOVERED</div>}
          {unpinnedRows.map((s) => {
            const key = pinKey(s.cwd, s.port);
            return (
              <ServiceRow
                key={`svc-${key}-${s.pid ?? 'np'}`}
                rowKey={key}
                service={s}
                pin={null}
                pinned={false}
                expanded={expanded === key}
                onToggleExpand={() => setExpanded((e) => (e === key ? null : key))}
                onTogglePin={() => togglePin(s.cwd, s.port)}
                onKilled={() => setNonce((n) => n + 1)}
                activeJobId={activeJobId}
                health={health ? healthByPort[s.port] : undefined}
                onSetPreviewPort={onSetPreviewPort}
                onClose={onClose}
              />
            );
          })}
        </>
      )}
    </div>
  );
}

// One compact service row. `service` is null for a pinned-but-offline entry.
function ServiceRow({
  rowKey,
  service,
  pin,
  pinned,
  expanded,
  onToggleExpand,
  onTogglePin,
  onKilled,
  activeJobId,
  health,
  onSetPreviewPort,
  onClose,
}: {
  rowKey: string;
  service: LocalService | null;
  pin: PinnedService | null;
  pinned: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onTogglePin: () => void;
  onKilled: () => void;
  // L3 — preview target + health. `health` is undefined when the HEALTH toggle
  // is off (no dot rendered); `activeJobId`/`onSetPreviewPort` may be absent
  // (no focused workflow / unthreaded), which disables PREVIEW.
  activeJobId?: string | null;
  health?: HealthState;
  onSetPreviewPort?: (workflowId: string, port: number, framework?: string) => void;
  onClose?: () => void;
}) {
  const offline = service === null;
  const [hover, setHover] = useState(false);
  const [copied, setCopied] = useState(false);
  // Two-step KILL confirm — first click arms, second click signals.
  const [confirmKill, setConfirmKill] = useState(false);
  const [killBusy, setKillBusy] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);

  // Derived display fields work for both live + offline rows.
  const port = service?.port ?? pin?.port ?? 0;
  const cwd = service?.cwd ?? pin?.cwd ?? null;
  const emoji = service?.frameworkEmoji ?? '◦';
  const name = service?.friendlyName ?? (cwd ? cwd.split('/').filter(Boolean).pop() ?? `port ${port}` : `Service on port ${port}`);
  const url = service?.url ?? `http://localhost:${port}/`;
  // Home-collapsed cwd for the hover line — the friendly name is derived from the
  // cwd basename, so when it's uninformative the path tells the operator what this
  // actually is. Full absolute path stays in the title attribute.
  const prettyCwd = cwd ? cwd.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~') : null;

  const copyUrl = () => {
    navigator.clipboard?.writeText(url).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); },
      () => { /* clipboard blocked — ignore */ },
    );
  };

  // L3 — bind this port to the FOCUSED workflow's preview proxy, ask that
  // workflow's right panel to flip to PREVIEW, then close the System modal so
  // the operator lands on the live view.
  const previewAvailable = !offline && !!activeJobId && !!onSetPreviewPort;
  const openPreview = () => {
    if (!previewAvailable || !activeJobId || !onSetPreviewPort) return;
    onSetPreviewPort(activeJobId, port, service?.framework ?? undefined);
    window.dispatchEvent(new CustomEvent('arco:open-preview', { detail: { workflowId: activeJobId } }));
    onClose?.();
  };
  const previewTitle = offline
    ? 'Pinned but not currently running'
    : !activeJobId
      ? 'Focus a workflow tab to preview here'
      : 'Bind this port to the focused workflow and open it in Live Preview';

  // Liveness dot colors — green/red/dim. Only rendered when HEALTH is on.
  const healthColor = health === 'alive' ? 'var(--color-accent-primary)'
    : health === 'dead' ? 'var(--color-danger)'
    : 'var(--color-fg-muted)';
  const healthTitle = health === 'alive' ? 'responding'
    : health === 'dead' ? 'not responding'
    : 'probing…';

  const doKill = async () => {
    if (!service?.pid) return;
    setKillBusy(true);
    setKillError(null);
    try {
      const res = await fetch(`/api/services/${service.pid}`, { method: 'DELETE' });
      if (res.ok) {
        // Give SIGTERM a beat to land, then refetch so the row drops.
        window.setTimeout(onKilled, 800);
      } else {
        const body = await res.json().catch(() => null);
        setKillError((body && body.error) || `kill failed (${res.status})`);
        setKillBusy(false);
        setConfirmKill(false);
      }
    } catch (e) {
      setKillError(e instanceof Error ? e.message : String(e));
      setKillBusy(false);
      setConfirmKill(false);
    }
  };

  const showActions = expanded || hover;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '8px 14px',
        borderBottom: '1px solid var(--color-border-hairline)',
        fontFamily: 'var(--font-body)',
        fontSize: '12px',
        color: offline ? 'var(--color-fg-muted)' : 'var(--color-fg)',
        opacity: offline ? 0.7 : 1,
      }}
    >
      <div
        onClick={onToggleExpand}
        style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
        title={offline ? 'Pinned but not currently running' : url}
      >
        <span style={{ fontSize: '13px', minWidth: '16px', textAlign: 'center' }}>{emoji}</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {name}
        </span>
        {offline && (
          <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
            OFFLINE
          </span>
        )}
        <span
          className="display-font"
          style={{
            fontSize: '10px', letterSpacing: '0.5px', padding: '1px 5px',
            border: '1px solid var(--color-border-hairline)',
            color: offline ? 'var(--color-fg-muted)' : 'var(--color-accent-secondary)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          :{port}
        </span>
        {/* L3 — liveness dot, only when HEALTH is armed. */}
        {health !== undefined && (
          <span
            title={healthTitle}
            style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: healthColor, flexShrink: 0,
            }}
          />
        )}
        {service && (
          <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>{service.processName}</span>
        )}
        {service?.pid != null && (
          <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontVariantNumeric: 'tabular-nums' }}>
            #{service.pid}
          </span>
        )}
      </div>

      {/* On hover (when not already expanded), surface the cwd — the "what is
          this, really" signal when the friendly name is ambiguous. Left-truncated
          so the deepest path segment stays visible; full path in the title. */}
      {hover && !expanded && (
        <div
          title={cwd ?? undefined}
          style={{
            marginTop: '4px', paddingLeft: '24px',
            fontSize: '10px', color: 'var(--color-fg-muted)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            direction: 'rtl', textAlign: 'left',
          }}
        >
          {prettyCwd ?? (offline ? 'pinned · not currently running' : 'cwd unknown')}
        </div>
      )}

      {/* Expanded detail — full meta. */}
      {expanded && (
        <div style={{ marginTop: '8px', paddingLeft: '24px', fontSize: '11px', color: 'var(--color-fg-muted)', lineHeight: 1.6 }}>
          {service?.cmdline && (
            <div
              style={{
                fontFamily: 'var(--font-code, monospace)', fontSize: '10px',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                maxHeight: '120px', overflowY: 'auto',
                padding: '4px 6px', marginBottom: '4px',
                border: '1px solid var(--color-border-hairline)',
                color: 'var(--color-fg)',
              }}
            >
              {service.cmdline}
            </div>
          )}
          <div>cwd: {cwd ?? '(unknown)'}</div>
          {service && <div>host: {service.host}</div>}
          <div>pid: {service?.pid ?? '(not running)'}</div>
          {killError && <div style={{ color: 'var(--color-danger)', marginTop: '4px' }}>kill error: {killError}</div>}
        </div>
      )}

      {/* Actions — revealed on hover or when expanded. */}
      {showActions && (
        <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
          {/* PREVIEW first — the primary in-app action. Binds this port to the
              focused workflow's preview proxy + flips it to PREVIEW. */}
          <button
            type="button"
            onClick={openPreview}
            data-help="services.preview"
            disabled={!previewAvailable}
            className="display-font"
            style={previewAvailable ? serviceRowBtn : serviceRowBtnDisabled}
            title={previewTitle}
          >
            PREVIEW
          </button>
          <button
            type="button"
            onClick={() => window.open(url, '_blank')}
            data-help="services.open"
            disabled={offline}
            className="display-font"
            style={offline ? serviceRowBtnDisabled : serviceRowBtn}
            title="Open in a new browser tab"
          >
            OPEN
          </button>
          <button
            type="button"
            onClick={copyUrl}
            data-help="services.copy"
            disabled={offline}
            className="display-font"
            style={offline ? serviceRowBtnDisabled : serviceRowBtn}
            title="Copy the URL to the clipboard"
          >
            {copied ? 'COPIED!' : 'COPY URL'}
          </button>
          <button
            type="button"
            onClick={onTogglePin}
            data-help="services.pin"
            className="display-font"
            style={{
              ...serviceRowBtn,
              color: pinned ? 'var(--color-accent-secondary)' : 'var(--color-accent-primary-dim)',
            }}
            title={pinned ? 'Remove from the pinned inventory' : 'Pin to the machine-level inventory (survives restarts)'}
          >
            {pinned ? 'UNPIN' : 'PIN'}
          </button>
          {!offline && !confirmKill && (
            <button
              type="button"
              onClick={() => setConfirmKill(true)}
              data-help="services.kill"
              className="display-font"
              style={serviceRowBtnDanger}
              title="Send SIGTERM (graceful terminate)"
            >
              KILL
            </button>
          )}
          {!offline && confirmKill && (
            <>
              <button
                type="button"
                onClick={doKill}
                data-help="services.kill"
                disabled={killBusy}
                className="display-font"
                style={serviceRowBtnDanger}
                title="Confirm — send SIGTERM"
              >
                {killBusy ? 'KILLING…' : 'CONFIRM?'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmKill(false)}
                className="display-font"
                style={serviceRowBtn}
                title="Cancel the kill"
              >
                CANCEL
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
