import { useCloseHeaderPopover } from './headerPopoverState';
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import type { ProviderName } from '@arco/shared';
import { useKeepInWindow } from '../layout/keepInWindow';

const PROVIDER_ORDER: ProviderName[] = ['claude',  'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek'];
const PROVIDER_LABEL: Record<ProviderName, string> = {
  claude: 'CLAUDE',

  codex: 'CODEX',
  cursor: 'CURSOR',
  ollama: 'OLLAMA',
  llamacpp: 'LLAMA',
  lmstudio: 'LMSTUDIO',
  strata: 'STRATA',
  deepseek: 'XOLOTL',

};

function formatResetsAt(resetsAt: number | undefined): string {
  if (!resetsAt) return 'no known reset';
  const deltaMs = resetsAt - Date.now();
  if (deltaMs <= 0) return 'any moment';
  const mins = Math.round(deltaMs / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hours < 24) return remMin > 0 ? `in ${hours}h ${remMin}m` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

export function WorkflowStatusChip() {
  const quotaState = useAppStore((s) => s.quotaState);
  const [open, setOpen] = useState(false);
  useCloseHeaderPopover(setOpen);
  const [now, setNow] = useState(Date.now);
  const [pending, setPending] = useState<Partial<Record<ProviderName, string>>>({});
  const [results, setResults] = useState<Partial<Record<ProviderName, string>>>({});
  // A row cleared by Recheck usage stays a few seconds so its result can be read.
  const [lingering, setLingering] = useState<ProviderName[]>([]);
  const lingerTimers = useRef(new Map<ProviderName, ReturnType<typeof setTimeout>>());
  useEffect(() => () => { for (const timer of lingerTimers.current.values()) clearTimeout(timer); }, []);
  // Two seconds of grace tolerate a slightly fast browser clock. Monotonic
  // ticks prevent a backward wall-clock adjustment from showing an expired row.
  useEffect(() => {
    setNow(previous => Math.max(previous, Date.now()));
    if (!quotaState || !Object.values(quotaState).some(value => value?.throttled && value.resetsAt !== undefined)) return;
    const timer = setInterval(() => setNow(previous => Math.max(previous, Date.now())), 1000);
    return () => clearInterval(timer);
  }, [quotaState]);
  const rootRef = useRef<HTMLDivElement>(null);
  const placeRef = useKeepInWindow();
  // Whether keyboard focus was last inside the chip or its panel. Focus is
  // only moved when it was there and fell to the page body because the
  // focused control was removed; never while the user is elsewhere.
  const focusWasInside = useRef(false);
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => { focusWasInside.current = !!rootRef.current?.contains(e.target as Node); };
    const onPointer = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) focusWasInside.current = false; };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('mousedown', onPointer, true);
    return () => { document.removeEventListener('focusin', onFocusIn); document.removeEventListener('mousedown', onPointer, true); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const throttled = quotaState ? PROVIDER_ORDER.filter((p) => quotaState[p]?.throttled && (quotaState[p]?.resetsAt === undefined || quotaState[p]!.resetsAt! + 2000 > now)) : [];
  // A pending recheck keeps its row: the server broadcasts the clear before
  // it answers, and the result must still be shown in place.
  const rows = PROVIDER_ORDER.filter(p => throttled.includes(p) || lingering.includes(p) || pending[p] === 'recheck');
  useEffect(() => {
    const active = document.activeElement;
    const fellFromInside = (!active || active === document.body) && focusWasInside.current;
    if (rows.length === 0) {
      if (fellFromInside) document.querySelector<HTMLButtonElement>('[data-testid="header-layout"]')?.focus();
      setOpen(false);
    } else if (fellFromInside) rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [rows.join(',')]);
  async function actOnProvider(provider: ProviderName, action: 'clear' | 'recheck') {
    setPending(previous => ({ ...previous, [provider]: action }));
    setResults(previous => ({ ...previous, [provider]: '' }));
    try {
      const response = await fetch('/api/provider-throttle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, action }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Request failed. Try again.');
      // The server broadcasts changes to every browser. Do not overwrite a
      // newer quota_status event with an older HTTP response snapshot.
      setResults(previous => ({ ...previous, [provider]: action === 'recheck' ? data.usage.message : 'Remembered limit cleared.' }));
      if (action === 'recheck' && data.usage?.cleared === true) {
        setLingering(previous => previous.includes(provider) ? previous : [...previous, provider]);
        clearTimeout(lingerTimers.current.get(provider));
        lingerTimers.current.set(provider, setTimeout(() => {
          lingerTimers.current.delete(provider);
          setLingering(previous => previous.filter(p => p !== provider));
        }, 4000));
      }
    } catch (error) { setResults(previous => ({ ...previous, [provider]: error instanceof Error ? error.message : 'Request failed. Try again.' })); }
    finally { setPending(previous => ({ ...previous, [provider]: undefined })); }
  }
  const controlStyle = { minHeight: '44px', padding: '6px 10px', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', background: 'var(--color-bg-panel)', color: 'var(--color-fg-primary)', cursor: 'pointer', font: 'inherit' };
  if (rows.length === 0) return null;

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-help="header.workflow-status"
        className="display-font"
        title="Provider throttling (click for details)"
        aria-expanded={open}
        aria-haspopup="dialog"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          background: open ? 'var(--color-accent-primary-a10)' : 'transparent',
          border: '1px solid var(--color-warning)',
          borderRadius: '3px',
          cursor: 'pointer',
          fontSize: '10px',
          letterSpacing: '1px',
          padding: '3px 8px',
        }}
      >
        <span style={{ color: 'var(--color-warning)', whiteSpace: 'nowrap' }}>⚠ PROVIDER THROTTLING ({throttled.length})</span>
      </button>

      {open && (
        <div
          ref={placeRef}
          role="dialog"
          aria-label="Provider throttling"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            width: '360px',
            minWidth: 0,
            maxWidth: 'calc(100vw - 24px)',
            boxSizing: 'border-box',
            overflowWrap: 'anywhere',
            padding: '10px 12px',
            background: 'var(--color-bg-panel)',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '4px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
            fontFamily: 'var(--font-content)',
            fontSize: '11px',
            zIndex: 20,
          }}
        >
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)', marginBottom: '8px' }}>
            PROVIDER THROTTLING
          </div>
          {rows.map((p) => { const done = !throttled.includes(p); return (
            <div key={p} style={{ padding: '8px 0', borderBottom: '1px solid var(--color-border-hairline)' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '4px 12px', color: 'var(--color-warning)' }}>
                <strong>{PROVIDER_LABEL[p]}</strong>
                <span>{done ? 'notice cleared' : `throttled · resets ${formatResetsAt(quotaState?.[p]?.resetsAt)}`}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '6px' }}>
                {(p === 'codex' || p === 'claude') && <button type="button" style={controlStyle} disabled={!!pending[p]} aria-disabled={done || undefined} aria-label={`Recheck ${PROVIDER_LABEL[p]} usage`} onClick={() => { if (!done) void actOnProvider(p, 'recheck'); }}>{pending[p] === 'recheck' ? 'Checking usage...' : 'Recheck usage'}</button>}
                <button type="button" style={controlStyle} disabled={!!pending[p]} aria-disabled={done || undefined} aria-label={`Clear ${PROVIDER_LABEL[p]} throttle`} onClick={() => { if (!done) void actOnProvider(p, 'clear'); }}>{pending[p] === 'clear' ? 'Clearing...' : 'Clear'}</button>
              </div>
              <div role="status" aria-live="polite" style={{ marginTop: results[p] ? '6px' : 0, lineHeight: 1.5 }}>{results[p]}</div>
            </div>
          ); })}
          <p style={{ margin: '8px 0 0', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
            Clear forgets the remembered limit and restores future eligibility. It does not re-arm a stopped goal run. If the provider is still limiting requests, the next turn will show it again.
          </p>
          <p style={{ margin: '6px 0 0', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
            Recheck usage reads the default Codex account or available Claude allowance without a model turn. When usage shows headroom it clears the notice; it cannot verify the account or model that was limited, so the next turn shows the limit again if it is still in force.
          </p>
        </div>
      )}
    </div>
  );
}
