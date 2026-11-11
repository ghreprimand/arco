import { useCloseHeaderPopover } from './headerPopoverState';
import { useEffect, useRef, useState } from 'react';
import { useVoiceStore } from '../voice/store';
import { useComputerStore } from '../stores/computerStore';
import { useAppStore } from '../stores/appStore';
import { useStartupStore } from '../stores/startupStore';
import { headerActionStyle } from './headerActionStyle';
import { useKeepInWindow } from '../layout/keepInWindow';

const item: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'transparent', border: '1px solid transparent', borderRadius: 3, color: 'var(--color-accent-primary-dim)', cursor: 'pointer', fontSize: 10, letterSpacing: '1px', padding: '5px 8px', textAlign: 'left' };

/** One top-bar voice control: microphone on/off plus a small menu for the voice conversation and memory. */
export function VoiceMenu() {
  const enabled = useVoiceStore((s) => s.enabled);
  const mode = useVoiceStore((s) => s.mode);
  const detailsOpen = useVoiceStore((s) => s.open);
  const computerOpen = useComputerStore((s) => s.open);
  const [open, setOpen] = useState(false);
  useCloseHeaderPopover(setOpen);
  const [ready, setReady] = useState<boolean | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const placeRef = useKeepInWindow();
  useEffect(() => {
    let alive = true;
    void fetch('/api/voice/setup').then((r) => r.ok ? r.json() : null).then((d) => { if (alive && d && typeof d.ready === 'boolean') setReady(d.ready); }).catch(() => {});
    return () => { alive = false; };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  const setup = () => { useStartupStore.getState().setSettingsSection('voice-setup'); useAppStore.getState().setShowSettings(true); };
  const toggleMic = () => {
    if (ready === false && !enabled) { setup(); return; }
    useVoiceStore.setState((s) => ({ toggleSeq: s.toggleSeq + 1 }));
  };
  const close = (fn: () => void) => () => { fn(); setOpen(false); };
  return <div ref={root} data-help="voice.hands-free" style={{ position: 'relative', display: 'inline-flex' }}>
    <button type="button" className="display-font" data-testid="voice-mic" aria-pressed={enabled} aria-label={enabled ? 'Turn the microphone off' : 'Turn the microphone on'}
      title={enabled ? 'Hands-free is listening. Click to turn the microphone off.' : ready === false ? 'Voice is not installed. Click to set it up; no microphone access until enabled.' : 'Microphone is off. Click to enable hands-free voice.'}
      onClick={toggleMic}
      style={{ ...headerActionStyle, borderTopRightRadius: 0, borderBottomRightRadius: 0, color: enabled ? 'var(--color-accent-secondary)' : headerActionStyle.color, borderColor: enabled ? 'var(--color-accent-secondary)' : 'var(--color-border-hairline)' }}>
      {enabled ? `\u25CF ${mode === 'conversation' ? 'COMPUTER CHAT' : 'VOICE'}` : 'VOICE'}
    </button>
    <button type="button" className="display-font" data-testid="voice-menu" aria-haspopup="menu" aria-expanded={open} aria-label="Voice menu" title="Voice conversation, memory and controls"
      onClick={() => setOpen((v) => !v)}
      style={{ ...headerActionStyle, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: 0, padding: '3px 5px', fontSize: 8, background: open ? 'var(--color-accent-primary-a10)' : 'transparent' }}>{open ? '\u25B2' : '\u25BC'}</button>
    {open && <div ref={placeRef} role="menu" onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, minWidth: 220, padding: 6, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-hairline)', borderRadius: 4, boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)', zIndex: 20, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <button type="button" role="menuitem" className="display-font" data-help="header.computer" style={item} aria-expanded={computerOpen} title="Your voice conversation, tool calls, agent selection, saved memory and usage" onClick={close(() => useComputerStore.getState().setOpen(!computerOpen))}>
        <span style={{ flex: 1 }}>VOICE CONVERSATION AND MEMORY</span>
      </button>
      <button type="button" role="menuitem" className="display-font" data-help="voice.panel" style={item} aria-expanded={detailsOpen} title="Microphone level, sensitivity, spoken replies and output voice" onClick={close(() => useVoiceStore.setState((s) => ({ open: !s.open })))}>
        <span style={{ flex: 1 }}>{detailsOpen ? 'HIDE VOICE CONTROLS' : 'VOICE CONTROLS'}</span>
      </button>
      {ready === false && <button type="button" role="menuitem" className="display-font" data-help="settings.voice-setup" style={{ ...item, color: 'var(--color-warning)' }} title="Voice speech models are not installed yet. Open Settings to install them." onClick={close(setup)}>
        <span style={{ flex: 1 }}>SET UP VOICE</span>
      </button>}
    </div>}
  </div>;
}
