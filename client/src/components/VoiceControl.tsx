import { useComputerActivity, activityRequest } from '../voice/activity';
import { useComputerConditions, conditionRequest } from '../voice/conditions';
import { useComputerMailRules, mailRuleRequest } from '../voice/mailRules';
import { useComputerStore } from '../stores/computerStore';
import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { useVoiceStore } from '../voice/store';
import { useNotificationStore } from '../stores/notificationStore';
import { useComputerWatches, watchRequest } from '../voice/watches';
import { VoiceRuntime } from '../voice/runtime';
import { restoreSavedComputer } from '../voice/conversation';
import { VoiceExecutor, type VoiceSenders } from '../voice/executor';
import { registerVoiceToolHandler, revokeComputerTextTools } from '../voice/toolBridge';
import { computerRequestActive, computerVoiceStatus } from '../voice/computerRequest';
import { headerActionStyle } from './headerActionStyle';
import { VoiceOutputPicker } from './VoiceOutputPicker';
import { VOICE_OUTPUT_SAMPLE } from '@arco/shared';

const button: React.CSSProperties = { background: 'transparent', color: 'var(--color-accent-primary)', border: '1px solid var(--color-border-hairline)', padding: '5px 9px', cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-display)' };
export function VoiceButton() {
  const enabled = useVoiceStore((s) => s.enabled);
  const mode = useVoiceStore((s) => s.mode);
  return <span data-help="voice.hands-free" style={{ display: 'inline-flex' }}><button style={headerActionStyle} className="display-font" aria-label="Hands-free voice controls" aria-pressed={enabled}
    title={enabled ? 'Hands-free is listening. Open controls to disable.' : 'Hands-free is off. Open controls; no microphone access until enabled.'}
    onClick={() => useVoiceStore.setState((s) => ({ open: !s.open }))}>
    {enabled ? `● ${mode === 'conversation' ? 'COMPUTER CHAT' : 'ARCO VOICE'}` : 'VOICE OFF'}
  </button></span>;
}

export function VoiceControl({ sendMessage, cancel, createWorkflow }: VoiceSenders) {
  const state = useVoiceStore();
  const computerId=useComputerStore((s)=>s.activeId);
  const computerJob=useAppStore((s)=>computerId ? s.jobs[computerId] : undefined);
  const computerBusy=computerRequestActive(computerJob);
  const status=computerVoiceStatus(state.status, computerJob);
  const contextEpoch=useComputerStore((s)=>s.contextEpoch);
  const connected=useAppStore((s)=>s.connected);
  const noHistory = useComputerStore((s) => s.selection.history === 'none');
  const senders = useRef({ sendMessage, cancel, createWorkflow }); senders.current = { sendMessage, cancel, createWorkflow };
  const runtime = useRef<VoiceRuntime | null>(null);
  const voiceExecutor = useRef<VoiceExecutor | null>(null);
  if (!runtime.current) {
    const executor = new VoiceExecutor({ sendMessage: (...args) => senders.current.sendMessage(...args), cancel: (...args) => senders.current.cancel(...args), createWorkflow: (config) => senders.current.createWorkflow?.(config) }, (text, mode) => runtime.current?.reply(text, mode));
    voiceExecutor.current = executor;
    runtime.current = new VoiceRuntime({ context: () => executor.interpreterContext(), execute: (c) => executor.execute(c), dictate: (t) => executor.dictate(t), canInterpret: (text) => executor.canInterpret(text),
      converse: async (text, signal, context) => {
        const message = await executor.conversation.talk(text, signal, context);
        // The bridge answers tool calls only for the chat this window opened.
        registerVoiceToolHandler(executor.conversation.chatId, (call) => executor.runTool(call));
        return message;
      }, contextLine: () => executor.contextLine(), returnToControl: () => executor.conversation.back() });
  }
  useEffect(() => {
    const bind = () => {
      restoreSavedComputer();
      const id = useComputerStore.getState().activeId;
      registerVoiceToolHandler(id, (call) => voiceExecutor.current!.runTool(call));
    };
    // Saved jobs may arrive after mount/reconnect. Activity must not depend on
    // speaking first or clicking USE AGENT to initialize the active owner.
    const stopJobs = useAppStore.subscribe((next, previous) => {
      if (next.jobs !== previous.jobs && !useComputerStore.getState().activeId) bind();
    });
    const stopComputer = useComputerStore.subscribe((next, previous) => {
      if (next.contextEpoch !== previous.contextEpoch) {
        runtime.current?.clearPendingCapture();
        useComputerActivity.setState({snapshot:null,error:null});
        useComputerConditions.setState((s)=>({rules:s.rules.filter((r)=>!r.private)}));
        useComputerMailRules.setState((s) => ({ rules: s.rules.filter((r) => !r.private) }));
        useComputerWatches.setState((s) => ({ watches: s.watches.filter((w) => !w.private) }));
      }
      bind();
    });
    bind();
    return () => { stopJobs(); stopComputer(); };
  }, []);
  useEffect(() => {
    const stop = () => { runtime.current?.stop(); registerVoiceToolHandler(null, null); };
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        if (useVoiceStore.getState().enabled) stop(); else void runtime.current?.start();
      }
    };
    window.addEventListener('pagehide', stop); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pagehide', stop); window.removeEventListener('keydown', key); stop(); };
  }, []);
  useEffect(() => subscribeConnection(() => {
    runtime.current?.stop();
    useVoiceStore.setState({ error: 'Arco disconnected. Microphone off; draft kept.' });
  }), []);
  useEffect(() => {
    if(!computerId || !connected)return;
    const id=computerId;
    let alive=true,initialized=false,refreshing=false,again=false;
    const seen=new Set<string>();
    const canSpeak=()=>useVoiceStore.getState().enabled && useVoiceStore.getState().spokenFeedback && !useNotificationStore.getState().muted.includes('computer-watch');
    const refresh=async()=>{
      if(refreshing){again=true;return;}refreshing=true;
      try { do {
        again=false;
        const results=await Promise.allSettled([activityRequest(id),watchRequest(id),mailRuleRequest(id),conditionRequest(id)]);
        if(!alive)return;
        if(results[0].status==='rejected')useComputerActivity.setState({error:String(results[0].reason)});
        if(results[1].status==='rejected')useComputerWatches.setState({error:String(results[1].reason)});
        if(results[2].status==='rejected')useComputerMailRules.setState({error:String(results[2].reason)});
        if(results[3].status==='rejected')useComputerConditions.setState({error:String(results[3].reason)});
        for(const r of useComputerConditions.getState().rules)for(const n of r.announcements){
          if(seen.has(n.id))continue;
          if(initialized && canSpeak()){
            const delivery=await conditionRequest(id,{action:'claim-announcement',rule_id:r.id,announcement_id:n.id});
            if(alive&&delivery.announce)runtime.current?.announce(n.text);
          }seen.add(n.id);
        }
        for(const w of useComputerWatches.getState().watches){
          if(w.status==='watching'||seen.has(w.id))continue;
          if(initialized && ['finished','failed','interrupted'].includes(w.status) && canSpeak()){
            const delivery=JSON.parse(await watchRequest(id,{action:'claim-announcement',watch_id:w.id}));
            if(alive && delivery.announce)runtime.current?.announce(w.status==='finished'?`${w.label} finished the watched work.`:`${w.label}: the watched work ${w.status==='failed'?'ended with an error':'was interrupted'}.`);
          }seen.add(w.id);
        }
        for(const r of useComputerMailRules.getState().rules){
          if(r.status==='watching'||seen.has(r.id))continue;
          if(initialized && r.status!=='cancelled' && canSpeak()){
            const delivery=JSON.parse(await mailRuleRequest(id,{action:'claim-announcement',rule_id:r.id}));
            if(alive && delivery.announce)runtime.current?.announce(`${r.label}: ${r.reason}`);
          }seen.add(r.id);
        }
        initialized=true;
      }while(again && alive); }catch(e){if(alive)useComputerActivity.setState({error:String(e)});}
      finally{refreshing=false;}
    };
    const unsubscribe=useComputerActivity.subscribe((next,prev)=>{if(next.revision!==prev.revision)void refresh();});
    void refresh();return()=>{alive=false;unsubscribe();};
  },[computerId,connected,contextEpoch]);
  if (!state.open && !state.enabled && !state.error) return null;
  return <aside aria-label="Hands-free controls" style={{ flexShrink: 0, minWidth: 0, background: 'var(--color-bg-panel)', color: 'var(--color-fg)', borderBottom: '1px solid var(--color-accent-primary)', fontSize: 11 }}>
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '4px 12px', minWidth: 0 }}>
      <strong style={{ flexShrink: 0 }}>{state.mode === 'conversation' ? 'COMPUTER CHAT' : 'ARCO CONTROL'} {noHistory ? '· NO HISTORY ' : ''}· {state.phase.toUpperCase()}</strong>
      {state.enabled && <meter aria-label="Microphone input level" min={0} max={0.1} value={state.inputLevel} style={{ width: 45, flexShrink: 0 }} />}
      <div role="status" aria-live="polite" title={state.commandText ?? status} style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {state.commandText !== null && <strong>{state.commandText ? 'CAPTURING DIRECTIVE · NOTHING EXECUTED' : 'CAPTURE ARMED · WAITING FOR DIRECTIVE'}</strong>}
        {state.commandText !== null ? ` · ${state.commandText || 'Speak when ready; pause, then say “over”.'}` : status}
      </div>
      {computerBusy && computerId && <button style={button} disabled={!connected} onClick={() => {
        revokeComputerTextTools(computerId); cancel(computerId);
      }}>STOP REQUEST</button>}
      {state.status === 'Computer is working on it…' && !computerBusy && <button style={button}
        onClick={() => useComputerStore.getState().setOpen(true)}>OPEN COMPUTER</button>}
      {state.commandText !== null && <>
        <button style={button} onClick={() => runtime.current?.endCapture('End capture')}>END CAPTURE</button>
        <button style={button} onClick={() => runtime.current?.endCapture('Cancel capture')}>CANCEL CAPTURE</button>
      </>}
      <button style={button} onClick={() => state.enabled ? runtime.current?.stop() : void runtime.current?.start()}>
        {state.enabled ? 'DISABLE · MIC OFF' : 'ENABLE HANDS-FREE'}
      </button>
      {state.enabled && <button style={button} onClick={() => runtime.current?.quiet()}>QUIET</button>}
      <button style={button} aria-label={state.open ? 'Close voice details' : 'Open voice details'} aria-expanded={state.open}
        onClick={() => useVoiceStore.setState({ open: !state.open })}>{state.open ? 'LESS' : 'DETAILS'}</button>
    </div>
    {state.error && <div role="alert" style={{ color: 'var(--color-danger)', padding: '3px 12px' }}>{state.error}</div>}
    {state.choices.length > 0 && <div style={{ display: 'flex', gap: 8, padding: '4px 12px', flexWrap: 'wrap' }}>
    </div>}
    {state.open && <div style={{ padding: '4px 12px 12px', maxHeight: 'calc(35vh / var(--ui-scale, 1))', overflow: 'auto', lineHeight: 1.5 }}>
      {state.enabled && state.lastHeard && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>Last heard: {state.lastHeard}</div>}
      {state.enabled && <p style={{ color: 'var(--color-fg-muted)' }}>{state.recognizer || 'Local CPU'} · Last segment: {state.endpointMs ?? '—'} ms silence + {state.recognitionMs ?? '—'} ms recognition · Interpretation: {state.interpretationMs === 0 ? 'direct · no model call' : `${state.interpretationMs ?? '—'} ms`} · First speech audio: {state.speechMs ?? '—'} ms</p>}
      {state.enabled && <p style={{ color: 'var(--color-fg-muted)' }}>Input peak {permille(state.inputLevel)} · room floor {permille(state.noiseFloor)} · speech onset {permille(state.speechOnset)} (‰ of full scale). A word whose peak stays under the onset is not heard.</p>}
      {state.commandText !== null && <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{state.commandText || 'Take your time. Up to two minutes between phrases.'}</p>}
      <label data-help="voice.sensitivity">Speech sensitivity <select aria-label="Speech sensitivity" value={state.speechThreshold}
        onChange={(e) => state.setSpeechThreshold(Number(e.target.value))}>
        <option value={.001}>Very high · quiet room</option><option value={.002}>High</option>
        <option value={.0035}>Normal</option><option value={.006}>Low</option><option value={.01}>Very low · noisy room</option>
      </select></label>
      <p>Higher sensitivity catches quieter words and more room noise. Pause before saying “over”; check Last heard if it misses. This changes Arco’s speech gate, not the system microphone volume.</p>
      <p>When off, nothing listens. Close/reload disarms voice. Ctrl/⌘ + Shift + Space toggles it.</p>
      <VoiceOutputPicker previewLive={() => runtime.current?.speak(VOICE_OUTPUT_SAMPLE, true)} />
      <p style={{ color: 'var(--color-fg-muted)' }}>Capture acknowledgement: soft double pulse · 230 ms.</p>
      <label style={{ display: 'block', margin: '8px 0' }}><input type="checkbox" checked={state.spokenFeedback} onChange={(e) => { useVoiceStore.setState({ spokenFeedback: e.target.checked }); if (!e.target.checked) runtime.current?.quiet(); }} /> Spoken feedback</label>
      <label style={{ display: 'block', margin: '8px 0' }}><input type="checkbox" checked={state.lunaEnabled} onChange={(e) => useVoiceStore.setState({ lunaEnabled: e.target.checked })} /> Send everything else to Computer (selected agent) which acts with Arco tools or answers</label>
      <p style={{ color: 'var(--color-fg-muted)' }}>Local speech recognition · Microsoft online speech output, with Kokoro offline fallback. Spoken reply text goes to Microsoft. Choose Computer’s agent and saved/no-history mode in the COMPUTER panel.</p>
      <p style={{ color: 'var(--color-fg-muted)' }}>COMPUTER in the top bar opens your voice conversation, tool calls, agent selection and usage. It keeps your current project selected.</p>
      <p>Start each command with “Computer”. Wait for the acknowledgement, then pause and continue as needed. To submit, pause and say “over” on its own (“execute”, “engage” and “make it so” also work); to discard the whole unsent directive, say “Cancel capture”, even after words you have already dictated. “Cancel” or “belay that” also work on their own; inside a sentence they are ordinary text. No “over” is needed after “Cancel capture”. “End capture” still submits at the end.</p>
      <p>Once capture starts, “computer” is part of your text. Saying it again keeps the existing capture and everything already said.</p>
      <p>Give Computer a task or ask it a question in your own words. It acts silently or answers by voice. For exact text, say “dictate” before the words, or announce “I want to dictate a message to the builder”, wait for “Go ahead”, then speak.</p>
      <p>“Computer, open Atlas. Over.”<br />“Computer, what’s going on with this project? Over.”<br />“Computer, send a message to the builder, dictate: please check the import first. Over.”<br />“Computer, stop listening” and “Computer, quiet” work immediately.</p>
      <p style={{ color: 'var(--color-fg-muted)' }}>This window: {state.calls} Computer requests · {state.usage.inputTokens.toLocaleString()} input / {state.usage.outputTokens.toLocaleString()} output tokens reported ({state.usage.cachedInputTokens.toLocaleString()} cached input).</p>
    </div>}
  </aside>;
}

const permille = (v: number | null): string => (v === null ? '—' : (v * 1000).toFixed(1));

function subscribeConnection(disconnected: () => void): () => void {

  return useAppStore.subscribe((next, prev) => { if (prev.connected && !next.connected && useVoiceStore.getState().enabled) disconnected(); });
}
