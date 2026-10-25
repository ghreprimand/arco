import { ComputerActivityPanel } from './ComputerActivityPanel';
import { ComputerScriptsPanel } from './ComputerScriptsPanel';
import { ComputerWatchesPanel, ComputerMailRulesPanel } from './ComputerMonitoringPanels';
import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { useComputerStore } from '../stores/computerStore';
import { useVoiceStore } from '../voice/store';
import { ComputerAgentPicker } from './ComputerAgentPicker';
import { ChatPanel } from './ChatPanel';
import { Panel } from './primitives/Panel';
import { ComputerComposer } from './ComputerComposer';
import { computerRequestActive } from '../voice/computerRequest';
import { revokeComputerTextTools } from '../voice/toolBridge';
import { computerResetPercent, type ComputerContextControlMessage } from '@arco/shared';

const button: React.CSSProperties = {
  background: 'transparent', color: 'var(--color-accent-primary)',
  border: '1px solid var(--color-border-hairline)', padding: '5px 9px', cursor: 'pointer', fontSize: 11,
};

export function ComputerPanel({ onLoadEarlier, onCancel, onSend }: {
  onLoadEarlier: (id: string) => void;
  onCancel: (id: string) => void;
  onSend: (id: string, text: string) => boolean;
}) {
  const jobs = useAppStore((s) => s.jobs);
  const enabled = useVoiceStore((s) => s.enabled);
  const close = useComputerStore((s) => s.setOpen);
  const histories = Object.values(jobs).filter((j) => j.config.voiceOperator === true);
  const activeId = useComputerStore((s) => s.activeId);
  const selection = useComputerStore((s) => s.selection);
  const job = histories.find((j) => j.id === activeId) ?? histories.find((j) => j.config.primaryProvider === selection.provider && j.config.primaryModel === selection.model && j.config.primaryEffort === selection.effort && !!j.config.incognito === (selection.history === 'none'));
  const busy = computerRequestActive(job);
  const stop = () => { if (job) { revokeComputerTextTools(job.id); onCancel(job.id); } };
  const connected = useAppStore((s) => s.connected);
  const context = job?.config.computerContext;
  const threshold = context?.resetAtPercent === undefined ? computerResetPercent(job?.config.primaryProvider ?? selection.provider) : context.resetAtPercent;
  const used = job?.contextUsage?.estimatedTokens ?? job?.lastTurnTokens?.input;
  const windowSize = job?.contextUsage?.windowSize ?? job?.modelContextWindow;
  const percent = used !== undefined && windowSize ? used / windowSize * 100 : undefined;
  const lastCompact = job?.messages.findLast((m) => m.role === 'system'
    && m.content === '[codex] Thread context was compacted internally.');
  const control = (update: Omit<ComputerContextControlMessage, 'type' | 'workflowId'>) => {
    if (job) useAppStore.getState().wsSendRaw?.({ type: 'computer_context_control', workflowId: job.id, ...update });
  };
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !panelRef.current?.contains(document.activeElement)) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(false); }
      if (event.key === 'Tab') {
        const controls = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], select:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        )).filter((el) => el.getClientRects().length > 0);
        const next = event.shiftKey ? controls.at(-1) : controls[0];
        const end = event.shiftKey ? controls[0] : controls.at(-1);
        if (document.activeElement === end && next) { event.preventDefault(); next.focus(); }
      }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus(); };
  }, [close]);

  return <div role="dialog" aria-modal="true" aria-labelledby="computer-title"
    onClick={() => close(false)}
    style={{ position: 'fixed', inset: 0, zIndex: 9200, padding: '20px', background: 'rgba(0, 0, 0, 0.78)', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
    <Panel ref={panelRef} onClick={(event) => event.stopPropagation()}
      style={{ width: '100%', maxWidth: 1100, height: '100%', maxHeight: 900, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--color-bg-panel)', border: '1px solid var(--color-border-hairline)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '14px 18px', borderBottom: '1px solid var(--color-border-hairline)' }}>
        <div style={{ flex: 1 }}>
          <h2 id="computer-title" className="display-font" style={{ margin: 0, fontSize: 16, letterSpacing: 2 }}>COMPUTER</h2>
          <p style={{ margin: '5px 0 0', color: 'var(--color-fg-muted)', fontSize: 12 }}>Your voice and text conversation</p>
        </div>
        <span style={{ color: 'var(--color-fg-muted)', fontSize: 11 }}>{busy ? 'WORKING' : enabled ? 'HANDS-FREE ON' : 'MIC OFF'}</span>
        {busy && <button style={button} disabled={!connected} onClick={stop}>STOP REQUEST</button>}
        <button ref={closeRef} style={button} aria-label="Close Computer" onClick={() => close(false)}>CLOSE ✕</button>
      </div>
      <div role="region" aria-label="Computer settings and automations" style={{minHeight:0,maxHeight:'45%',overflowY:'auto',flexShrink:1}}>
        <ComputerAgentPicker key={`${selection.provider}:${selection.model}:${selection.effort}:${selection.history}`} />
        {job && <ComputerActivityPanel key={job.id} ownerId={job.id} />}
        {job && <ComputerScriptsPanel key={`scripts:${job.id}`} ownerId={job.id} />}
        {job && <ComputerWatchesPanel key={`watches:${job.id}`} ownerId={job.id} />}
        {job && <ComputerMailRulesPanel key={`mail-rules:${job.id}`} ownerId={job.id} />}
        {job && <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '8px 18px', color: 'var(--color-fg-muted)', fontSize: 11 }}>
            <span>{job.config.primaryProvider} · {job.config.primaryModel} · {job.config.primaryEffort.toUpperCase()}</span>
            <span>{job.totalTokens.input.toLocaleString()} input / {job.totalTokens.output.toLocaleString()} output tokens</span>
          </div>
          <div data-help="computer.context" style={{ padding: '10px 18px', borderBottom: '1px solid var(--color-border-hairline)', fontSize: 12, lineHeight: 1.7 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong>CONTEXT {percent === undefined ? '—' : `${percent.toFixed(1)}%`}</strong>
              {used !== undefined && windowSize && <span>{used.toLocaleString()} / {windowSize.toLocaleString()} tokens</span>}
              <meter aria-label="Computer context fullness" min={0} max={100} value={Math.min(percent ?? 0, 100)} style={{ width: 120 }} />
              <label>Auto fresh at <select aria-label="Computer fresh-context threshold" value={threshold ?? 'off'} disabled={!connected}
                onChange={(event) => control({ action: 'configure', resetAtPercent: event.target.value === 'off' ? null : Number(event.target.value) })}>
                <option value="off">OFF</option>{[25, 50, 75].map((value) => <option key={value} value={value}>{value}%</option>)}
              </select></label>
              <label><input type="checkbox" aria-label="Keep Computer context" checked={context?.keepContext ?? false} disabled={!connected}
                onChange={(event) => control({ action: 'configure', keepContext: event.target.checked })} /> KEEP CONTEXT</label>
              <button style={button} disabled={!connected || context?.pendingFresh}
                onClick={() => control({ action: 'fresh' })}>{busy ? 'CLEAR AFTER TURN' : 'CLEAR CONTEXT'}</button>
            </div>
            <div role="status" style={{ color: 'var(--color-fg-muted)' }}>
              {context?.pendingFresh ? 'Fresh context requested; waiting for the current turn and queued requests to finish.'
                : context?.keepContext ? 'Keeping this context for follow-ups. Automatic fresh starts are paused.'
                : percent !== undefined && threshold !== null && percent >= threshold && busy ? 'Threshold reached; waiting for the current turn and queued requests to finish.'
                : threshold === null ? 'Automatic fresh starts are off.' : `Fresh context at ${threshold}%, after the turn and all queued requests finish.`}
              {' '}{job.config.incognito ? 'Clearing also discards the memory-only transcript.' : 'Previous conversations stay in this transcript.'} Clears carry no summary or earlier messages.
            </div>
            <div style={{ color: 'var(--color-fg-muted)' }}>
              {context?.lastResetAt ? `Last fresh start: ${new Date(context.lastResetAt).toLocaleTimeString()} (${context.lastResetReason}).` : 'No fresh starts yet.'}
              {' '}{lastCompact ? `Last Codex compaction: ${new Date(lastCompact.timestamp).toLocaleTimeString()}.` : 'No Codex compaction in loaded history.'}
            </div>
          </div>
        </>}
      </div>
      {job ? <div style={{ display: 'flex', flex: 1, minHeight: 120 }}>
        <ChatPanel key={job.id} job={job} presentation="chat" onLoadEarlier={() => onLoadEarlier(job.id)} />
      </div> : <div style={{ flex: 1, display: 'grid', placeContent: 'center', padding: 24, textAlign: 'center', color: 'var(--color-fg-muted)', lineHeight: 1.7 }}>
        <p>Your conversations with Computer will appear here.</p>
        <p>Choose an agent above and press USE AGENT to start typing, or enable hands-free and say “Computer”.</p>
      </div>}
      {job && <ComputerComposer key={job.id} job={job} onSend={onSend} />}
      <div style={{ padding: '12px 18px', borderTop: '1px solid var(--color-border-hairline)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, color: 'var(--color-fg-muted)', fontSize: 12 }}>Computer remembers requests within the current context.</span>
        <button style={button} onClick={() => { close(false); useVoiceStore.setState({ open: true }); }}>VOICE CONTROLS</button>
      </div>
    </Panel>
  </div>;
}
