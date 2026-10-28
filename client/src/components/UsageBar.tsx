import { useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { formatTokens } from './RightPanel/format';
import { CursorIncludedGauge } from './CursorIncludedGauge';
import type { CodexUsageInfo, CursorUsageInfo, OllamaLiveStatus, UsageInfo} from '@arco/shared';

interface Props {
  usage: UsageInfo | null;
}

// I1-followup — live-provider status as a compact inline dot cluster, not a
// dedicated second header row. Each authed/enabled provider is a single colored
// dot + one-letter tag (green ● = live, hollow ○ = ready/idle, red ● = down);
// the rich per-provider detail (Claude session/weekly bars, Codex usage scrape,
// Ollama loaded-model list) still opens on hover, unchanged — only the trigger
// shrank. Lives in the header's row-1 status cluster now, freeing the vertical
// row the boxed LABEL|LIVE pills used to occupy.
export function UsageBar({ usage }: Props) {
  const authStatus = useAppStore((s) => s.authStatus);
  const codexUsage = useAppStore((s) => s.codexUsage);
  const cursorUsage = useAppStore((s) => s.cursorUsage);
  const ollamaLive = useAppStore((s) => s.ollamaLive);
  const enabledProviders = useAppStore((s) => s.settings?.enabledProviders);
  const isProviderEnabled = (provider: keyof NonNullable<typeof enabledProviders>) => enabledProviders?.[provider] !== false;
  const claudeAuthed = authStatus?.claude.loggedIn ?? false;
  const geminiAuthed = authStatus?.gemini.loggedIn ?? false;
  const codexAuthed = authStatus?.codex.loggedIn ?? false;
  const cursorAuthed = authStatus?.cursor?.loggedIn ?? false;
  // Ollama dot appears whenever the provider is enabled — even if the daemon is
  // down — so the operator sees a clear red DOWN dot rather than it vanishing.
  const ollamaShown = isProviderEnabled('ollama');
  const ollamaDaemonUp = authStatus?.ollama.loggedIn ?? false;

  return (
    <div data-help="header.live-status" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      {isProviderEnabled('claude') && claudeAuthed && <ClaudeStatus usage={usage} />}
      {isProviderEnabled('gemini') && geminiAuthed && (
        <GeminiStatus tooltip="Gemini — LIVE. The CLI exposes no usage/quota endpoint for personal accounts, so live status only." />
      )}
      {isProviderEnabled('codex') && codexAuthed && <CodexStatus usage={codexUsage} />}
      {isProviderEnabled('cursor') && cursorAuthed && <CursorStatus usage={cursorUsage} />}
      {ollamaShown && <OllamaStatus daemonUp={ollamaDaemonUp} live={ollamaLive} />}
    </div>
  );
}

// The compact dot trigger shared by every provider. `live` = filled accent dot,
// `ready` = hollow ring (daemon up but idle), `down` = filled danger dot.
type DotState = 'live' | 'ready' | 'down';

function StatusDot({ letter, state, title, href }: { letter: string; state: DotState; title?: string; href?: string }) {
  const color = state === 'down'
    ? 'var(--color-danger)'
    : state === 'ready'
      ? 'var(--color-accent-primary-dim)'
      : 'var(--color-accent-secondary)';
  const content = (
    <span
      className="display-font"
      title={title}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px', letterSpacing: '0.5px', color, cursor: href ? 'pointer' : 'default' }}
    >
      <span
        style={{
          width: '7px',
          height: '7px',
          borderRadius: '50%',
          background: state === 'ready' ? 'transparent' : color,
          border: `1.5px solid ${color}`,
          flexShrink: 0,
        }}
      />
      {letter}
    </span>
  );
  if (!href) return content;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${letter} usage page`}
      style={{ textDecoration: 'none', display: 'inline-flex' }}
      onClick={(e) => e.stopPropagation()}
    >
      {content}
    </a>
  );
}

function GeminiStatus({ tooltip }: { tooltip: string }) {
  return <StatusDot letter="G" state="live" title={tooltip} />;
}

const CODEX_ANALYTICS_URL = 'https://chatgpt.com/settings/usage?tab=overview';
const CLAUDE_USAGE_URL = 'https://claude.ai/new#settings/usage';
const CURSOR_USAGE_URL = 'https://cursor.com/dashboard?tab=usage';

// Cursor dot — LIVE when logged in. The ACP stream carries no per-turn token
// counts, so the hover card shows the POLLED month-to-date snapshot (same
// `cursorUsage` the Usage-tab card reads), not a live-per-turn meter. Click →
// dashboard. Mirrors CodexStatus.
function CursorStatus({ usage }: { usage: CursorUsageInfo | null }) {
  const [open, setOpen] = useState(false);
  const cents = usage?.chargedCents ?? 0;
  const pct = usage?.available && typeof usage.totalTokens === 'number'
    ? `${formatTokens(usage.totalTokens)} MTD`
    : null;
  return (
    <div
      style={{ position: 'relative', display: 'flex', alignItems: 'center' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <StatusDot
        letter="R"
        state="live"
        title={pct ? `Cursor — LIVE · ${pct} (hover for usage, click for dashboard)` : 'Cursor — LIVE (ACP · ~153 models, hover for usage)'}
        href={CURSOR_USAGE_URL}
      />
      {open && (
        <div
          role="tooltip"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: '340px',
            padding: '10px 14px',
            background: 'var(--color-bg-panel)',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '4px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
            fontFamily: 'var(--font-content)',
            zIndex: 30,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px', lineHeight: 1.45 }}>
            <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1.4px', color: 'var(--color-fg-muted)', display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <span>CURSOR · MONTH TO DATE</span>
              <span style={{ color: 'var(--color-fg-muted)', opacity: 0.7 }}>polled · not live</span>
            </div>
            {usage?.included && <CursorIncludedGauge inc={usage.included} compact />}
            {usage?.available ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontVariantNumeric: 'tabular-nums' }}>
                <div style={{ color: 'var(--color-fg-default)' }}>
                  {formatTokens(usage.totalTokens ?? 0)} tokens · {usage.eventCount ?? 0} event{usage.eventCount === 1 ? '' : 's'}
                </div>
                <div style={{ color: 'var(--color-fg-muted)', fontSize: '10px' }}>
                  {formatTokens(usage.inputTokens ?? 0)} in · {formatTokens(usage.outputTokens ?? 0)} out · {formatTokens(usage.cacheReadTokens ?? 0)} cache-read
                </div>
                <div style={{ fontSize: '10px', color: usage.hardCapped ? 'var(--color-accent-secondary)' : 'var(--color-fg-muted)' }}>
                  {usage.hardCapped
                    ? `included in plan · no overage${cents > 0 ? ` · $${(cents / 100).toFixed(2)} charged` : ''}`
                    : cents > 0
                      ? `$${(cents / 100).toFixed(2)} charged (usage-based overage)`
                      : 'usage-based overage · nothing charged yet'}
                </div>
              </div>
            ) : (
              <span style={{ color: 'var(--color-fg-muted)' }}>
                {usage?.needsLogin
                  ? <>Not signed in to Cursor. Run <code style={{ fontFamily: 'var(--font-mono)' }}>cursor-agent login</code>.</>
                  : (usage?.error ?? 'Cursor usage has not loaded yet.')}
              </span>
            )}
            <a
              href={CURSOR_USAGE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="display-font"
              onClick={(e) => e.stopPropagation()}
              style={{ marginTop: '2px', fontSize: '9px', letterSpacing: '1px', color: 'var(--color-accent-secondary)', textDecoration: 'none' }}
            >
              OPEN CURSOR DASHBOARD ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function CodexStatus({ usage }: { usage: CodexUsageInfo | null }) {
  const [open, setOpen] = useState(false);
  const [loginState, setLoginState] = useState<'idle' | 'starting' | 'started' | 'error'>('idle');
  const [retryState, setRetryState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const startLogin = async () => {
    setLoginState('starting');
    try {
      const res = await fetch('/api/codex-usage-login', { method: 'POST' });
      const data = (await res.json()) as { started?: boolean };
      setLoginState(data.started ? 'started' : 'error');
      if (data.started) {
        window.setTimeout(() => setLoginState('idle'), 5000);
      }
    } catch {
      setLoginState('error');
    }
  };
  const refreshUsage = async () => {
    setRetryState('loading');
    try {
      await fetch('/api/codex-usage?force=1');
      setRetryState('done');
      window.setTimeout(() => setRetryState('idle'), 2000);
    } catch {
      setRetryState('error');
      window.setTimeout(() => setRetryState('idle'), 3000);
    }
  };
  return (
    <div
      style={{ position: 'relative', display: 'flex', alignItems: 'center' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <StatusDot letter="X" state="live" title="Codex — LIVE (hover for usage, click for analytics)" href={CODEX_ANALYTICS_URL} />
      {open && (
        <div
          role="tooltip"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: '340px',
            padding: '10px 14px',
            background: 'var(--color-bg-panel)',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '4px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
            fontFamily: 'var(--font-content)',
            zIndex: 30,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '11px', lineHeight: 1.45 }}>
            {usage?.available && usage.rows?.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {usage.rows.slice(0, 2).map((row) => <CodexUsageRow key={row.label} row={row} />)}
              </div>
            ) : (
              <>
                <span style={{ color: 'var(--color-fg-muted)' }}>
                  {usage?.error ?? 'Codex analytics scrape has not returned data yet.'}
                  {' '}ChatGPT blocks iframe embedding, so Arco reads the page with a dedicated local Camoufox profile when configured.
                </span>
              </>
            )}
            {!(usage?.available && usage.rows?.length) && (
              <>
                <button
                  type="button"
                  onClick={refreshUsage}
                  disabled={retryState === 'loading'}
                  className="display-font"
                  style={{
                    alignSelf: 'flex-start',
                    padding: '5px 9px',
                    color: retryState === 'done'
                      ? 'var(--color-accent-secondary)'
                      : retryState === 'error'
                        ? 'var(--color-warning)'
                        : 'var(--color-fg-muted)',
                    border: '1px solid var(--color-border-hairline)',
                    borderRadius: '3px',
                    background: 'transparent',
                    cursor: retryState === 'loading' ? 'default' : 'pointer',
                    fontSize: '10px',
                    letterSpacing: '1.4px',
                  }}
                >
                  {retryState === 'loading'
                    ? 'SCRAPING…'
                    : retryState === 'done'
                      ? 'SCRAPE REQUESTED'
                      : retryState === 'error'
                        ? 'SCRAPE FAILED'
                        : 'RETRY SCRAPE'}
                </button>
                <button
                  type="button"
                  onClick={startLogin}
                  disabled={loginState === 'starting'}
                  className="display-font"
                  style={{
                    alignSelf: 'flex-start',
                    padding: '5px 9px',
                    color: 'var(--color-accent-primary)',
                    border: '1px solid var(--color-accent-primary-dim)',
                    borderRadius: '3px',
                    background: 'transparent',
                    cursor: loginState === 'starting' ? 'default' : 'pointer',
                    fontSize: '10px',
                    letterSpacing: '1.4px',
                  }}
                >
                  {loginState === 'starting'
                    ? 'OPENING CAMOUFOX…'
                    : loginState === 'started'
                      ? 'LOGIN WINDOW OPEN (CLICK TO REOPEN)'
                      : 'LOGIN CAMOUFOX PROFILE'}
                </button>
                <a
                  href={CODEX_ANALYTICS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="display-font"
                  style={{
                    alignSelf: 'flex-start',
                    marginTop: '2px',
                    padding: '5px 9px',
                    color: 'var(--color-accent-secondary)',
                    border: '1px solid var(--color-accent-secondary-dim)',
                    borderRadius: '3px',
                    textDecoration: 'none',
                    fontSize: '10px',
                    letterSpacing: '1.4px',
                  }}
                >
                  OPEN CODEX ANALYTICS ↗
                </a>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CodexUsageRow({ row }: { row: { label: string; value: string } }) {
  const label = row.label.toLowerCase().startsWith('5 hour') ? 'Session' : 'Weekly';
  const parsed = parseCodexUsageValue(row.value);
  return <UsageRow label={label} util={parsed.usedPercent} resetsAt={null} resetText={parsed.resetText} />;
}

function parseCodexUsageValue(value: string): { usedPercent: number; resetText?: string } {
  const remaining = value.match(/\b(\d{1,3})%\s*remaining\b/i);
  const used = value.match(/\b(\d{1,3})%\s*used\b/i);
  const generic = value.match(/\b(\d{1,3})%\b/);
  const raw = remaining ? 100 - Number(remaining[1]) : used ? Number(used[1]) : generic ? Number(generic[1]) : 0;
  const reset = value.match(/Resets?\s+(.+)$/i)?.[1]?.trim();
  return {
    usedPercent: Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 0)),
    ...(reset ? { resetText: `resets ${reset}` } : {}),
  };
}

// Claude's dot opens session + weekly utilization bars with reset times on
// hover — same content the old boxed pill carried, now behind the compact dot.
function ClaudeStatus({ usage }: { usage: UsageInfo | null }) {
  const [open, setOpen] = useState(false);
  const showUsage = !!(usage && !usage.error && (usage.session || usage.weekly));
  const sessionPct = usage?.session ? Math.round(Math.min(Math.max(usage.session.utilization, 0), 100)) : null;
  return (
    <div
      style={{ position: 'relative', display: 'flex', alignItems: 'center' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <StatusDot
        letter="C"
        state="live"
        title={sessionPct !== null ? `Claude — LIVE · session ${sessionPct}% (hover for usage, click for usage page)` : 'Claude — LIVE (hover for usage, click for usage page)'}
        href={CLAUDE_USAGE_URL}
      />
      {open && (
        <div
          role="tooltip"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: '340px',
            padding: '10px 14px',
            background: 'var(--color-bg-panel)',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '4px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
            fontFamily: 'var(--font-content)',
            zIndex: 30,
          }}
        >
          {showUsage && usage ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {usage.session && (
                <UsageRow label="Session" util={usage.session.utilization} resetsAt={usage.session.resetsAt} />
              )}
              {usage.weekly && (
                <UsageRow label="Weekly" util={usage.weekly.utilization} resetsAt={usage.weekly.resetsAt} />
              )}
            </div>
          ) : (
            <span style={{ fontSize: '11px', color: 'var(--color-fg-muted)' }}>
              {usage?.error ?? 'Loading usage…'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Ollama is local — its dot is genuinely dynamic. Three states:
//   live  — daemon up + at least one model resident in VRAM (filled green)
//   ready — daemon up but idle, no model loaded (hollow ring)
//   down  — daemon unreachable (filled red); authStatus.ollama.loggedIn is the
//           source of truth. Hover surfaces the loaded model + unload time.
function OllamaStatus({ daemonUp, live }: { daemonUp: boolean; live: OllamaLiveStatus | null }) {
  const [open, setOpen] = useState(false);
  const loaded = daemonUp ? (live?.loadedModels ?? []) : [];
  const state: DotState = !daemonUp ? 'down' : loaded.length > 0 ? 'live' : 'ready';
  const title = state === 'down'
    ? 'Ollama — DOWN (daemon unreachable)'
    : state === 'ready'
      ? 'Ollama — READY (daemon up, idle)'
      : 'Ollama — LIVE (model in VRAM, hover for detail)';
  return (
    <div
      style={{ position: 'relative', display: 'flex', alignItems: 'center' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <StatusDot letter="O" state={state} title={title} />
      {open && (
        <div
          role="tooltip"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: '280px',
            padding: '10px 14px',
            background: 'var(--color-bg-panel)',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '4px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
            fontFamily: 'var(--font-content)',
            zIndex: 30,
          }}
        >
          {state === 'down' && (
            <span style={{ fontSize: '11px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
              Daemon not reachable. Run <code style={{ fontFamily: 'var(--font-mono)' }}>ollama serve</code> on this machine, or set <code style={{ fontFamily: 'var(--font-mono)' }}>OLLAMA_URL_BASE</code> to point elsewhere.
            </span>
          )}
          {state === 'ready' && (
            <span style={{ fontSize: '11px', color: 'var(--color-fg-muted)' }}>
              Daemon up, no model currently loaded into VRAM.
            </span>
          )}
          {state === 'live' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)' }}>
                LOADED IN VRAM
              </span>
              {loaded.map((m) => (
                <div key={m.name} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '11px' }}>
                  <span style={{ color: 'var(--color-fg-default)' }}>{m.name}</span>
                  {m.expiresAt && (
                    <span style={{ color: 'var(--color-fg-muted)', whiteSpace: 'nowrap' }}>
                      unloads {formatExpiry(m.expiresAt)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatExpiry(iso: string): string {
  const d = new Date(iso).getTime();
  const now = Date.now();
  const deltaMs = d - now;
  if (deltaMs <= 0) return 'any moment';
  const mins = Math.round(deltaMs / 60_000);
  if (mins < 1) return 'in <1m';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `in ${hours}h ${rem}m` : `in ${hours}h`;
}

interface UsageRowProps {
  label: string;
  util: number;
  resetsAt: string | null;
  resetText?: string;
}

function UsageRow({ label, util, resetsAt, resetText }: UsageRowProps) {
  const pct = Math.min(Math.max(util, 0), 100);
  const color = pct >= 80 ? 'var(--color-danger)' : pct >= 50 ? 'var(--color-warning)' : 'var(--color-accent-secondary)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11px', fontFamily: 'var(--font-content)' }}>
      <span style={{ color: 'var(--color-fg-default)', minWidth: '54px' }}>{label}</span>
      <div
        style={{
          width: '90px',
          height: '5px',
          background: 'var(--color-accent-primary-a08)',
          borderRadius: '2px',
          overflow: 'hidden',
        }}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 0.3s ease' }} />
      </div>
      <span style={{ color, minWidth: '32px', textAlign: 'right', fontWeight: 600 }}>{pct.toFixed(0)}%</span>
      {(resetsAt || resetText) && (
        <span style={{ color: 'var(--color-fg-muted)', whiteSpace: 'nowrap' }}>
          {resetText ?? `resets ${formatResetLabel(resetsAt!)}`}
        </span>
      )}
    </div>
  );
}

function formatResetLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = formatTime(d);
  if (sameDay) return time;
  const weekday = d.toLocaleDateString([], { weekday: 'short' });
  return `${weekday} ${time}`;
}

function formatTime(d: Date): string {
  const hours = d.getHours();
  const mins = d.getMinutes();
  const h12 = hours % 12 || 12;
  const ampm = hours < 12 ? 'a.m.' : 'p.m.';
  return `${h12}:${mins.toString().padStart(2, '0')} ${ampm}`;
}
