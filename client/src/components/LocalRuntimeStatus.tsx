import { LOCAL_STATUS_LABELS, enabledLocalStatusProviders, localModelExpiry, type Capabilities, aggregateLocalRuntimeState, localRuntimeStateText, type ArcoSettings, type LocalRuntimeSnapshot, type LocalRuntimeStatus } from '@arco/shared';
import { useEffect, useId, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { useProviderHover } from './providerPanelState';
import { useKeepInWindow } from '../layout/keepInWindow';

export function enabledLocalRows(settings: ArcoSettings | null, snapshot: LocalRuntimeSnapshot | null, versions: Pick<Capabilities, 'strataVersion' | 'xolotlRevision'> | null = null): LocalRuntimeStatus[] {
  return (snapshot ? snapshot.rows.filter(row => settings?.enabledProviders[row.provider] !== false).map(row => row.provider) : enabledLocalStatusProviders(settings, versions)).map(provider =>
    snapshot?.rows.find(r => r.provider === provider) ?? { provider, state: 'unknown', models: [] });
}
export function LocalRuntimeRows({ rows }: { rows: LocalRuntimeStatus[] }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px', lineHeight: 1.5 }}>
    {rows.map(row => <div key={row.provider} data-local-runtime={row.provider} style={{ display: 'flex', gap: '12px', justifyContent: 'space-between', overflowWrap: 'anywhere' }}>
      <span style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>{LOCAL_STATUS_LABELS[row.provider]}</span><span style={{ minWidth: 0 }}>{localRuntimeStateText(row)}
        {row.state === 'loaded' && row.models.map(model => row.modelExpiries?.[model] ? <div key={model}>{model}: unloads {localModelExpiry(row.modelExpiries[model])}</div> : null)}
        {row.state === 'down' && row.detail && <div>{row.detail}</div>}
      </span>
    </div>)}
  </div>;
}
export function LocalRuntimeIndicator() {
  const settings = useAppStore(s => s.settings);
  const snapshot = useAppStore(s => s.localRuntimeStatus);
  const versions = useAppStore(s => s.capabilities);
  const rows = enabledLocalRows(settings, snapshot, versions);
  const state = aggregateLocalRuntimeState(rows);
  const [open, setOpen] = useProviderHover();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pointerWasOpen = useRef(false);
  const id = useId();
  const placeRef = useKeepInWindow();
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  if (!rows.length) return null;
  const color = state === 'down' ? 'var(--color-danger)' : state === 'loaded' ? 'var(--color-accent-secondary)' : state === 'unknown' ? 'var(--color-fg-muted)' : 'var(--color-accent-primary-dim)';
  return <div ref={root} style={{ position: 'relative', display: 'flex', alignItems: 'center' }} onPointerEnter={event => { if (event.pointerType !== 'touch') setOpen(true); }} onPointerLeave={event => { if (event.pointerType !== 'touch' && !root.current?.contains(document.activeElement)) setOpen(false); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
    <button ref={button} type="button" className="display-font provider-status-link" aria-label="Local runtime status" aria-expanded={open} aria-describedby={open ? id : undefined} data-local-state={state}
      onPointerDown={() => { pointerWasOpen.current = open; }} onClick={event => setOpen(event.detail === 0 ? !open : !pointerWasOpen.current)}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); button.current?.focus(); } }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', border: 0, padding: 0, background: 'transparent', color, fontSize: '10px', letterSpacing: '.5px', cursor: 'pointer' }}>
      <span aria-hidden style={{ width: '5px', height: '5px', borderRadius: '50%', border: `1px solid ${color}`, background: state === 'loaded' || state === 'down' ? color : 'transparent', opacity: state === 'unknown' ? .5 : 1 }} />LOCAL
    </button>
    {open && <div ref={placeRef} id={id} role="tooltip" aria-label="Local runtime details" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 'max-content', padding: '10px 14px', background: 'var(--color-bg-panel)', border: '1px solid var(--color-border-hairline)', borderRadius: '4px', boxShadow: '0 8px 24px rgba(0,0,0,.45)', fontFamily: 'var(--font-content)', zIndex: 35 }}>
      <LocalRuntimeRows rows={rows} />
    </div>}
  </div>;
}
