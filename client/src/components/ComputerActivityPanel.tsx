import { useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { useComputerActivity, activityRequest } from '../voice/activity';
const button:React.CSSProperties={background:'transparent',color:'var(--color-accent-primary)',border:'1px solid var(--color-border-hairline)',padding:'4px 8px',fontSize:11,cursor:'pointer'};
export function ComputerActivityPanel({ownerId}:{ownerId:string}) {
  const state=useComputerActivity((s)=>s.ownerId===ownerId?s.snapshot:null), error=useComputerActivity((s)=>s.error);
  const connected=useAppStore((s)=>s.connected);
  const [saving,setSaving]=useState(false);
  const change=async(args:Record<string,unknown>)=>{setSaving(true);try{await activityRequest(ownerId,args);}catch(e){useComputerActivity.setState({error:String(e)});}finally{setSaving(false);}};
  return <section data-help="computer.activity" style={{padding:'8px 18px',fontSize:12,borderBottom:'1px solid var(--color-border-hairline)'}}>
    <strong>ACTIVITY & CONDITIONS</strong>
    {error && <p role="alert">{error}</p>}
    {!connected ? <p role="status">Disconnected. Activity controls will return when Arco reconnects.</p>
      : !state && !error ? <p role="status">Loading activity settings…</p> : null}
    {connected && (!state || error) && <button style={button} disabled={saving}
      onClick={()=>{void change({action:'status'});}}>RETRY ACTIVITY</button>}
    <div style={{display:'flex',alignItems:'center',gap:12,flexWrap:'wrap',marginTop:5}}>
      <label><input type="checkbox" aria-label="Enable Computer event automations" checked={state?.policy.enabled??true} disabled={!connected||saving||!state}
        onChange={(e)=>{void change({action:'configure',enabled:e.target.checked});}}/> Enable event automations</label>
      <label>Send activity to this Computer agent <select aria-label="Computer agent activity updates" value={state?.policy.agentUpdates??'off'} disabled={!connected||saving||!state}
        onChange={(e)=>{void change({action:'configure',agent_updates:e.target.value});}}>
        <option value="off">OFF</option><option value="matches">Matched conditions only</option><option value="workers">Worker completions + matched conditions</option>
      </select></label>
      {!!state?.pending && <button style={button} disabled={!connected||saving} onClick={()=>{void change({action:'cancel-queued'});}}>CLEAR QUEUED UPDATES ({state.pending})</button>}
    </div>
    {state&&!state.policy.enabled&&<div role="status" style={{marginTop:4}}>Automations paused. Completion watches still resolve.</div>}
    {state?.nextUpdateAt&&<div role="status" style={{marginTop:4}}>Agent updates waiting for the hourly limit to reset at {new Date(state.nextUpdateAt).toLocaleTimeString()}.</div>}
    <details style={{marginTop:5}}><summary>Recent activity ({state?.ledger.length??0}) · Agent inbox ({state?.pending??0} queued)</summary>
      <p style={{color:'var(--color-fg-muted)',margin:'6px 0'}}>Events arrive live. Agent updates wait while Computer is busy; {state?.updatesThisHour??0}/{state?.updatesPerHour??12} read-only model turns this hour, 10 events/batch and 50 queued events. Normal provider usage applies. The master switch pauses scripts, mailbox actions and agent updates; completion watches still resolve. Settings belong to this Computer context.</p>
      <div style={{maxHeight:160,overflow:'auto',marginTop:4}}>
        {state?.deliveries.slice().reverse().map((d)=><div key={d.id}>Agent {d.status}: {d.event.name||d.event.workflowId||d.event.kind} · {d.reason??d.event.kind}</div>)}
        {state?.ledger.slice().reverse().map((e)=><div key={e.id}>{new Date(e.at).toLocaleTimeString()} · {e.kind.replaceAll('_',' ')} · {e.name||e.workflowId||e.clusterId}{e.detail?` · ${e.detail}`:''}</div>)}
      </div>
    </details>
  </section>;
}
