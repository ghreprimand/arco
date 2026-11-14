import { LocalRuntimeRows, enabledLocalRows } from './LocalRuntimeStatus';
import { compareLlamacppBuild } from '@arco/shared';
import type { Capabilities, CliUpdateOutcome } from '@arco/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { FreeVramButton } from './FreeVramButton';
import { useStartupStore } from '../stores/startupStore';
import { ProviderReleasesModal, type ReleaseRuntime } from './ProviderReleasesModal';
import { createPortal } from 'react-dom';
import { closeHeaderPopovers } from './headerPopoverState';
import { setProviderPanelOpen } from './providerPanelState';

// Provider/version chips folded behind a dedicated VERSIONS trigger. The
// strip used to live inline in SystemHeader's right cluster (one button per
// CLI + Ollama + llama.cpp) and dominated the header's horizontal budget. It's
// status, not an urgent action, so it belongs behind progressive disclosure:
// the trigger carries a one-glance health dot (any outdated → warning) and the
// full per-provider chip grid opens on click. Self-contained — pulls its own
// store slices + owns the update-check + Ollama-releases-modal state that used
// to sit in SystemHeader.

type CliProvider = 'claude' | 'codex';
type VersionedProvider = CliProvider | 'ollama' | 'llamacpp' | 'cursor' | 'strata' | 'deepseek';

// Lightweight semver compare — the four upstream sources we read all emit
// dotted-numeric versions (npm registry + GitHub release tags after stripping
// the leading `v`). Anything past the third segment is parsed as a number when
// possible and otherwise zeroed; good enough to decide "is this string strictly
// older than that string" for the outdated-indicator. Returns -1 / 0 / 1.
function compareSemver(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((s) => parseInt(s, 10) || 0);
  const pb = b.split(/[.+-]/).map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

const LOCAL_RUNTIMES = ['ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek'] as const;
const USAGE_PAGES: Array<{ provider: 'claude' | 'codex' | 'cursor'; label: string; url: string }> = [
  { provider: 'claude', label: 'CLAUDE USAGE', url: 'https://claude.ai/new#settings/usage' },
  { provider: 'codex', label: 'CODEX USAGE', url: 'https://chatgpt.com/settings/usage?tab=overview' },
  { provider: 'cursor', label: 'CURSOR USAGE', url: 'https://cursor.com/dashboard?tab=usage' },
];

export function ProvidersPopover({ open: controlledOpen, onOpenChange }: { open?: boolean; onOpenChange?: (open: boolean) => void } = {}) {
  const localSnapshot = useAppStore(s => s.localRuntimeStatus);
  const authStatus = useAppStore((s) => s.authStatus);
  const capabilities = useAppStore((s) => s.capabilities);
  const settings = useAppStore((s) => s.settings);
  const ollamaLive = useAppStore((s) => s.ollamaLive);
  const llamacppLive = useAppStore((s) => s.llamacppLive);

  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (value: boolean | ((v: boolean) => boolean)) => {
    const next = typeof value === 'function' ? value(open) : value;
    if (onOpenChange) onOpenChange(next); else setOwnOpen(next);
  };
  const [releasesRuntime, setReleasesRuntime] = useState<ReleaseRuntime | null>(null);
  const [checking, setChecking] = useState<CliProvider | null>(null);
  const [checkResult, setCheckResult] = useState<Record<CliProvider, string | null>>({ claude: null,  codex: null });
  const [checkOutcome, setCheckOutcome] = useState<Partial<Record<CliProvider, CliUpdateOutcome>>>({});
  // The row's result slot is a narrow right-aligned chip, so the displayed
  // string is truncated hard. Keep the untruncated text for the tooltip —
  // an update failure ("Missing optional dependency @openai/codex-linux-x64…")
  // is only actionable if the operator can read the whole thing.
  const [checkDetail, setCheckDetail] = useState<Record<CliProvider, string | null>>({ claude: null,  codex: null });
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelToken = useRef(Symbol());
  const wasOpen = useRef(false);
  useEffect(() => {
    setProviderPanelOpen(open, panelToken.current);
    if (!open && wasOpen.current) buttonRef.current?.focus();
    wasOpen.current = open;
    return () => { if (open) setProviderPanelOpen(false, panelToken.current); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const button = buttonRef.current;
    if (!panel || !button) return;
    const anchor = button.closest('header') ?? button;
    const position = () => {
      const scale = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      const margin = 8 * scale;
      const a = anchor.getBoundingClientRect();
      const b = button.getBoundingClientRect();
      const below = a.bottom + 6 * scale;
      const top = anchor.tagName === 'HEADER' ? below
        : Math.max(margin, Math.min(below, window.innerHeight - Math.min(panel.scrollHeight * scale, window.innerHeight - 2 * margin) - margin));
      panel.style.maxWidth = `${Math.max(0, window.innerWidth - 2 * margin) / scale}px`;
      panel.style.maxHeight = `${Math.max(0, window.innerHeight - top - margin) / scale}px`;
      panel.style.top = `${top / scale}px`;
      const width = panel.getBoundingClientRect().width;
      panel.style.left = `${Math.max(margin, Math.min(b.right - width, window.innerWidth - width - margin)) / scale}px`;
    };
    position();
    panel.querySelector<HTMLButtonElement>('button')?.focus();
    const observer = new ResizeObserver(position);
    observer.observe(anchor); observer.observe(panel);
    window.addEventListener('resize', position);
    window.addEventListener('arco:ui-scale', position);
    window.addEventListener('scroll', position, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('arco:ui-scale', position); window.removeEventListener('scroll', position, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('/api/capabilities')
      .then((response) => response.ok ? response.json() : undefined)
      .then((next) => { if (!cancelled && next) useAppStore.getState().setCapabilities(next); })
      .catch(() => { /* keep the last successful snapshot */ });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      // Entering help must leave version-chip targets mounted.
      if (e.target instanceof Element && e.target.closest('.help-system-ui')) return;
      if (!rootRef.current?.contains(e.target as Node) && !panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('click', onDoc);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDoc); document.removeEventListener('click', onDoc); };
  }, [open]);

  const checkForUpdates = async (provider: CliProvider) => {
    setChecking(provider);
    setCheckOutcome((prev) => ({ ...prev, [provider]: undefined }));
    setCheckResult((prev) => ({ ...prev, [provider]: null }));
    setCheckDetail((prev) => ({ ...prev, [provider]: null }));
    try {
      const res = await fetch(`/api/check-updates?provider=${provider}`, { method: 'POST' });
      const data = await res.json() as { outcome?: CliUpdateOutcome; currentVersion?: string; message?: string; capabilities?: Capabilities; error?: string; notice?: string };
      const version = data.currentVersion ?? (provider === 'codex' ? capabilities?.codexVersion : capabilities?.cliVersion) ?? 'unknown';
      let msg: string;
      const detail = data.error ?? data.message ?? data.notice ?? 'The version did not change. Arco could not check whether it is up to date.';
      // A notice means the server did something the version string alone doesn't
      // explain — e.g. upstream tagged a new `latest` whose build for this
      // platform isn't published yet, so it installed the newest one that runs.
      // Mark the row so the operator knows to hover, and keep it pinned.
      if (data.error || data.outcome === 'failed') msg = 'FAILED';
      else if (data.notice) msg = `v${version} (!)`;
      else if (data.outcome === 'updated') msg = `→ v${version}`;
      else if (data.outcome === 'current') msg = `v${version} (latest)`;
      else msg = `v${version} (!)`;
      setCheckOutcome((prev) => ({ ...prev, [provider]: msg === 'FAILED' ? 'failed' : msg.endsWith('(!)') ? 'deferred' : data.outcome }));
      if (data.capabilities) useAppStore.getState().setCapabilities(data.capabilities);
      setCheckResult((prev) => ({ ...prev, [provider]: msg }));
      setCheckDetail((prev) => ({ ...prev, [provider]: msg === 'FAILED' || msg.endsWith('(!)') ? detail : null }));
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'unknown';
      setCheckResult((prev) => ({ ...prev, [provider]: 'FAILED' }));
      setCheckOutcome((prev) => ({ ...prev, [provider]: 'failed' }));
      setCheckDetail((prev) => ({ ...prev, [provider]: detail }));
    } finally {
      setChecking(null);
      // A failure stays put until the operator dismisses it by re-checking;
      // auto-clearing the one line that explains what went wrong is how the
      // codex breakage stayed invisible.
      setTimeout(() => setCheckResult((prev) => (
        prev[provider] === 'FAILED' || prev[provider]?.endsWith('(!)') ? prev : { ...prev, [provider]: null }
      )), 6000);
    }
  };


  // Build the per-provider rows once so both the trigger's health dot and the
  // popover grid read from the same filtered list (disabled / un-installed
  // providers drop out of both).
  const rows = ([
    { provider: 'claude' as const, label: 'CLAUDE', version: capabilities?.cliVersion ?? 'unknown' },
    { provider: 'codex' as const, label: 'CODEX', version: capabilities?.codexVersion ?? 'unknown' },
    // Ollama is not a CLI we self-update, but the operator still wants the
    // version visible when the daemon is reachable. Installed version comes
    // from the live /api/version poll (mirrored on OllamaLiveStatus); click
    // goes to the in-app release notes rather than running an installer.
    { provider: 'deepseek' as VersionedProvider, label: 'XOLOTL', version: capabilities?.xolotlRevision ?? 'unknown' },
    { provider: 'strata' as VersionedProvider, label: 'STRATA', version: capabilities?.strataVersion ?? 'unknown' },
    { provider: 'ollama' as VersionedProvider, label: 'OLLAMA', version: ollamaLive?.version ?? 'unknown' },
    // llama.cpp: same shape as Ollama — local binary version, click goes to
    // GitHub releases since the upstream is operator-built (no self-update path).
    { provider: 'llamacpp' as VersionedProvider, label: 'LLAMA', version: llamacppLive?.version ?? 'unknown' },
    // Cursor: date-versioned `cursor-agent` (self-updating, curl-installed — no
    // npm registry latest to compare against), so display-only; click opens the
    // upstream changelog.
    { provider: 'cursor' as VersionedProvider, label: 'CURSOR', version: capabilities?.cursorVersion ?? 'unknown' },
  ] as const)
    .filter(({ provider, version }) => {
      // Hide providers the operator disabled in settings (null = fail-open during
      // initial load) and CLIs that aren't installed.
      if (settings?.enabledProviders?.[provider] === false) return false;
      // 'unknown' means not installed — hide. 'broken' means installed but the
      // version probe threw, and that row MUST stay visible: when a failed
      // `npm install -g` left codex unable to run, collapsing it
      // into 'unknown' made the provider silently vanish, which reads as
      // "never installed" and leaves nothing to click or diagnose.
      if (version === 'unknown') return false;
      return true;
    })
    .map((r) => {
      const broken = r.version === 'broken';
      // Cursor has no upstream latest to compare (curl-installed, self-updating),
      // so it's never flagged outdated — narrow it out before indexing. A broken
      // CLI has no parseable version either, so skip the compare rather than let
      // compareSemver read 'broken' as 0.0.0 and call it outdated.
      const latest = r.provider === 'cursor' || broken ? undefined : r.provider === 'deepseek' ? capabilities?.latestVersions?.xolotl : capabilities?.latestVersions?.[r.provider];
      const outdated = r.provider === 'codex' && capabilities?.codexUpdate
        ? capabilities.codexUpdate.updateAvailable
        : !!latest && (r.provider === 'deepseek' ? r.version !== latest : r.provider === 'llamacpp' ? (compareLlamacppBuild(r.version, latest) ?? 0) < 0 : compareSemver(r.version, latest) < 0);
      return { ...r, latest, outdated, broken };
    });

  const localRuntime = LOCAL_RUNTIMES.some((p) => settings?.enabledProviders?.[p] !== false && authStatus?.[p]?.loggedIn);
  const usagePages = USAGE_PAGES.filter(({ provider }) => settings?.enabledProviders?.[provider] !== false && authStatus?.[provider]?.loggedIn);

  const anyOutdated = rows.some((r) => r.outdated);
  const anyBroken = rows.some((r) => r.broken);
  // A CLI that won't run outranks one that's merely a version behind.
  const dotColor = anyBroken ? 'var(--color-danger)' : anyOutdated ? 'var(--color-warning)' : 'var(--color-accent-primary-dim)';

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Provider versions"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => { if (!open) closeHeaderPopovers(); setOpen(!open); }}
        data-help="header.providers"
        className="display-font"
        title={anyBroken ? 'Provider CLI versions: a CLI is installed but not running' : anyOutdated ? 'Provider CLI versions: an update is available' : 'Provider CLI versions'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          background: open ? 'var(--color-accent-primary-a10)' : 'transparent',
          border: `1px solid ${anyBroken ? 'var(--color-danger)' : anyOutdated ? 'var(--color-warning)' : 'var(--color-border-hairline)'}`,
          borderRadius: '3px',
          color: 'var(--color-accent-primary-dim)',
          cursor: 'pointer',
          fontSize: '10px',
          letterSpacing: '1px',
          padding: '3px 8px',
        }}
      >
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
        VERSIONS
        <span style={{ fontSize: '8px', opacity: 0.7 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Provider versions"
          data-help="header.cli-versions"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } }}
          style={{
            position: 'fixed',
            overflowY: 'auto',
            boxSizing: 'border-box',
            fontFamily: 'var(--font-display)',
            fontSize: '11px',
            minWidth: '220px',
            padding: '8px',
            // Elevated (not panel) so floating menus share one frosted opacity
            // level with the reader modals — the slider moves them together.
            background: 'var(--color-bg-elevated)',
            color: 'var(--color-fg)',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '4px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
            zIndex: 9700,
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
          }}
        >
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)', padding: '2px 2px 6px' }}>
            PROVIDERS
          </div>
          {rows.map(({ provider, label, version, latest, outdated, broken }) => {
            const isOllama = provider === 'ollama';
            const isStrata = provider === 'strata';
            const isDeepSeek = provider === 'deepseek';
            const isLlamacpp = provider === 'llamacpp';
            const isCursor = provider === 'cursor';
            const isCli = !isOllama && !isLlamacpp && !isCursor && !isStrata && !isDeepSeek;
            const busy = isCli && checking === (provider as CliProvider);
            const result = isCli ? checkResult[provider as CliProvider] : null;
            const detail = isCli ? checkDetail[provider as CliProvider] : null;
            const outcome = isCli ? checkOutcome[provider as CliProvider] : undefined;
            const versionColor = (broken || outcome === 'failed') ? 'var(--color-danger)' : outdated || outcome === 'manual' || outcome === 'deferred' ? 'var(--color-warning)' : 'var(--color-accent-primary-dim)';
            // For llama.cpp the lifecycle manager owns the spawned server, so we
            // know exactly which model is in VRAM — surface it on the row.
            const llamacppLoadedAlias = isLlamacpp ? (llamacppLive?.loadedModel ?? null) : null;
            const baseTitle = broken
              ? `${label} is installed but is not responding to --version: click for update options and the error`
              : isDeepSeek
                ? `Xolotl checkout ${version}${outdated ? ' · upstream revision differs' : ''}. Click for source changes inside Arco. This does not update or rebuild the engine.`
              : isStrata
                ? `Strata engine v${version}${outdated ? ` → engine v${latest} available` : ''}. App/Terminal releases have separate versions. Click for release notes inside Arco.`
              : isOllama
              ? outdated
                ? `Ollama daemon outdated: v${version} → v${latest} (click for release notes)`
                : `Ollama daemon v${version} (latest: click for release notes)`
              : isLlamacpp
                ? llamacppLoadedAlias
                  ? `llama.cpp ${version} · model "${llamacppLoadedAlias}" loaded (click to view upstream releases)`
                  : `llama.cpp ${version} · no model loaded (click to view upstream releases)`
                : isCursor
                  ? `cursor-agent ${version} (self-updating: click for changelog)`
                : outdated
                  ? `${label} CLI outdated: v${version} → v${latest} (click to install)`
                  : `${label} CLI v${version} (click to check for updates)`;
            const onClick = isDeepSeek
              ? () => setReleasesRuntime('xolotl')
              : isStrata
              ? () => setReleasesRuntime('strata')
              : isOllama
              ? () => setReleasesRuntime('ollama')
              : isLlamacpp
                ? () => window.open('https://github.com/ggml-org/llama.cpp/releases', '_blank', 'noopener')
                : isCursor
                  ? () => window.open('https://cursor.com/changelog', '_blank', 'noopener')
                  : () => checkForUpdates(provider as CliProvider);
            const versionDisplay = busy ? '…'
              : result ? result
              : isDeepSeek ? version.slice(0, 12)
              : broken ? 'NOT RUNNING'
              : (isLlamacpp && llamacppLoadedAlias) ? `v${version} · ${llamacppLoadedAlias}`
              : `v${version}`;
            return (
              <span key={provider} data-help={isDeepSeek ? 'header.xolotl-version' : isStrata ? 'header.strata-version' : 'header.cli-versions'} style={{ display: 'flex' }}>
              <button
                onClick={onClick}
                disabled={busy}
                className="display-font"
                title={detail ?? baseTitle}
                style={{
                  display: 'flex',
                  width: '100%',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  background: 'transparent',
                  border: `1px solid ${outdated ? 'var(--color-warning)' : 'var(--color-border-hairline)'}`,
                  borderRadius: '3px',
                  color: 'var(--color-accent-primary-dim)',
                  cursor: busy ? 'wait' : 'pointer',
                  fontSize: '9px',
                  letterSpacing: '1px',
                  padding: '4px 8px',
                  lineHeight: 1.3,
                }}
              >
                <span style={{ fontSize: '9px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)', whiteSpace: 'nowrap' }}>{label}</span>
                <span style={{ fontSize: '10px', color: versionColor }}>{versionDisplay}</span>
              </button>
              </span>
            );
          })}
          {rows.length === 0 && <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', padding: '0 2px 4px' }}>No provider CLI versions to show.</div>}
          {usagePages.length > 0 && <div data-testid="providers-usage-pages" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', paddingTop: '4px' }}>
            {usagePages.map(({ provider, label, url }) => <a key={provider} href={url} target="_blank" rel="noopener noreferrer" className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-accent-primary-dim)' }}>{label}</a>)}
          </div>}
          {localRuntime && <div data-testid="providers-free-vram" style={{ paddingTop: '4px' }}><FreeVramButton /></div>}
          {enabledLocalRows(settings, localSnapshot, capabilities).length > 0 && <section aria-label="Local runtime status"><div className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', marginBottom: '6px' }}>LOCAL STATUS</div><LocalRuntimeRows rows={enabledLocalRows(settings, localSnapshot, capabilities)} /></section>}
          <div style={{ paddingTop: '4px' }}><button type="button" className="display-font" data-help="auth.connections" onClick={() => { setOpen(false); useStartupStore.getState().openConnections(); }} style={{ background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-accent-primary-dim)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px', padding: '3px 8px' }}>CONNECTIONS</button></div>
        </div>, document.body
      )}

      {releasesRuntime && capabilities && (
        <ProviderReleasesModal
          runtime={releasesRuntime}
          onClose={() => setReleasesRuntime(null)}
          installedVersion={releasesRuntime === 'ollama' ? ollamaLive?.version : releasesRuntime === 'strata' ? capabilities?.strataVersion : capabilities?.xolotlRevision}
        />
      )}
    </div>
  );
}
