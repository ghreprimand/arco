import { useAppStore } from '../stores/appStore';
import { useComputerConditions, conditionRequest } from '../voice/conditions';
import type { ComputerConditionRule } from '@arco/shared';
import { ComputerAutomationSection } from './ComputerAutomationSection';
import { useComputerActivity } from '../voice/activity';
const button:React.CSSProperties={background:'transparent',color:'var(--color-accent-primary)',border:'1px solid var(--color-border-hairline)',padding:'4px 8px',fontSize:11,cursor:'pointer'};
export function ComputerScriptsPanel({ownerId}:{ownerId:string}){
  const {rules,error,observationTurns}=useComputerConditions();const connected=useAppStore((s)=>s.connected);
  const masterPaused=useComputerActivity((s)=>s.ownerId===ownerId&&s.snapshot?.policy.enabled===false);
  const change=(rule_id:string,action:string)=>{void conditionRequest(ownerId,{action,rule_id}).catch((e)=>useComputerConditions.setState({error:String(e)}));};
  const visible=rules.filter((r)=>!r.private||r.ownerId===ownerId).slice().reverse();
  const armed=visible.filter((r)=>r.status==='watching'),history=visible.filter((r)=>r.status!=='watching');
  const row=(r:ComputerConditionRule)=>{
    const active=r.status==='watching';
    return <div key={r.id} style={{marginTop:6,padding:'6px 8px',border:'1px solid var(--color-border-hairline)',overflowWrap:'anywhere'}}>
      <details>
        <summary style={{cursor:'pointer'}}><strong>{r.definition.label}</strong> · {active?(r.paused||masterPaused?'Paused':'Active'):r.status} · {r.actions} actions</summary>
        <div style={{marginTop:5}}>Created {new Date(r.createdAt).toLocaleString()}. {r.private?'No history.':''}</div>
        {!active&&<div>{r.reason}</div>}
        <div>Actions: {r.actions}{r.definition.max_actions===null?' (no limit)':`/${r.definition.max_actions}`}.</div>
        <div>Scope: {r.members.map((m)=>`${m.name} (${m.id.slice(0,8)})`).join(', ')}. {r.expiresAt===null?'No expiry':`Expires ${new Date(r.expiresAt).toLocaleString()}`}. Input holds {r.definition.hold_on_input?'ON':'OFF'}.</div>
        <div>Worker actions: {r.members.map((m)=>`${m.name}: ${r.workerTurns[m.id]?.count??0}${r.definition.max_worker_turns===null?' (no limit)':`/${r.definition.max_worker_turns}`}`).join(', ')}. Cooldown: {r.definition.cooldown_seconds}s.</div>
        <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(r.definition,null,2)}</pre>
        {r.announcements.map((n)=><div key={n.id}>{new Date(n.at).toLocaleTimeString()}: {n.text}</div>)}
      </details>
      {active&&<>
        <div style={{margin:'5px 0',color:r.paused||masterPaused?'var(--color-fg-muted)':'var(--color-fg)'}}>{masterPaused?'Paused by the event automations switch.':r.paused?'Paused; resume to continue.':r.reason}</div>
        <button style={button} aria-label={`${r.paused?'Resume':'Pause'} script ${r.definition.label}`} disabled={!connected} onClick={()=>change(r.id,r.paused?'resume':'pause')}>{r.paused?'RESUME':'PAUSE'}</button>{' '}
        <button style={button} aria-label={`Cancel script ${r.definition.label}`} disabled={!connected} onClick={()=>change(r.id,'cancel')}>CANCEL SCRIPT</button>
      </>}
    </div>;
  };
  return <ComputerAutomationSection title="CONDITIONAL SCRIPTS" helpKey="computer.scripts"
    activeCount={armed.filter((r)=>!r.paused&&!masterPaused).length} pausedCount={armed.filter((r)=>r.paused||masterPaused).length}
    historyCount={history.length} error={error} empty="No active scripts. Describe a condition and action to Computer to create one."
    history={history.map(row)} information={<details style={{marginTop:6,color:'var(--color-fg-muted)'}}>
      <summary style={{cursor:'pointer'}}>How scripts work</summary>
      <p>Scripts run until their finishing condition or cancellation unless you request limits. Ask Computer to set or remove time/action limits, or change the cooldown.</p>
      <p>{observationTurns}/24 Luna LOW input-observation batches this hour. Checks hold on uncertainty; questions are never answered automatically.</p>
    </details>}>
    {armed.map(row)}
  </ComputerAutomationSection>;
}
