import type { ComputerMailRule, ComputerWatch } from '@archon/shared';
import { useAppStore } from '../stores/appStore';
import { useComputerActivity } from '../voice/activity';
import { useComputerMailRules, mailRuleRequest } from '../voice/mailRules';
import { useComputerWatches, watchRequest } from '../voice/watches';
import { ComputerAutomationSection } from './ComputerAutomationSection';

const button:React.CSSProperties={background:'transparent',color:'var(--color-accent-primary)',border:'1px solid var(--color-border-hairline)',padding:'4px 8px',fontSize:11,cursor:'pointer'};
const card:React.CSSProperties={marginTop:6,padding:'6px 8px',border:'1px solid var(--color-border-hairline)',overflowWrap:'anywhere'};

export function ComputerWatchesPanel({ownerId}:{ownerId:string}) {
  const {watches,error}=useComputerWatches(),connected=useAppStore((s)=>s.connected);
  const visible=watches.filter((w)=>!w.private||w.ownerId===ownerId).slice().reverse();
  const active=visible.filter((w)=>w.status==='watching'),history=visible.filter((w)=>w.status!=='watching');
  const row=(w:ComputerWatch)=><div key={w.id} style={card}>
    <details>
      <summary style={{cursor:'pointer'}}><strong>{w.label}</strong> · {w.status==='watching'?'Watching':w.status}</summary>
      <div>Created {new Date(w.createdAt).toLocaleString()}{w.endedAt?` · Ended ${new Date(w.endedAt).toLocaleString()}`:''}. {w.private?'No history.':''}</div>
      <div>{w.targets.map((t)=>`${t.name}: ${t.status}`).join(', ')}</div>
    </details>
    {w.status==='watching'&&<>
      <div style={{margin:'5px 0'}}>{w.targets.filter((t)=>t.status==='working').map((t)=>t.name).join(', ')} — waiting for current work to finish.</div>
      <button style={button} aria-label={`Cancel watch ${w.label}`} disabled={!connected} onClick={()=>{void watchRequest(ownerId,{action:'cancel',watch_id:w.id}).catch((e)=>useComputerWatches.setState({error:String(e)}));}}>CANCEL WATCH</button>
    </>}
  </div>;
  return <ComputerAutomationSection title="COMPLETION WATCHES" helpKey="computer.watches" activeCount={active.length} historyCount={history.length} error={error}
    empty="No active watches. Ask Computer to let you know when a worker finishes." history={history.map(row)}>
    {active.map(row)}
  </ComputerAutomationSection>;
}

export function ComputerMailRulesPanel({ownerId}:{ownerId:string}) {
  const {rules,error}=useComputerMailRules(),connected=useAppStore((s)=>s.connected);
  const masterPaused=useComputerActivity((s)=>s.ownerId===ownerId&&s.snapshot?.policy.enabled===false);
  const visible=rules.filter((r)=>!r.private||r.ownerId===ownerId).slice().reverse();
  const armed=visible.filter((r)=>r.status==='watching'),history=visible.filter((r)=>r.status!=='watching');
  if(!visible.length&&!error)return null;
  const change=(rule_id:string,action:string)=>{void mailRuleRequest(ownerId,{action,rule_id}).catch((e)=>useComputerMailRules.setState({error:String(e)}));};
  const row=(r:ComputerMailRule)=><div key={r.id} style={card}>
    <details>
      <summary style={{cursor:'pointer'}}><strong>{r.label}</strong> · {r.status==='watching'?(r.paused||masterPaused?'Paused':'Active'):r.status}</summary>
      <div>Created {new Date(r.createdAt).toLocaleString()}. Expires {new Date(r.expiresAt).toLocaleString()}. {r.private?'No history.':''}</div>
      <div>{r.reason}</div>
      <div>{r.workers.map((w)=>`${w.name}: ${w.nudges}/${r.maxNudgesPerWorker} nudges`).join(', ')} · Final: {r.finalName} · {r.cooldownMs/1000}s cooldown</div>
    </details>
    {r.status==='watching'&&<>
      <div style={{margin:'5px 0'}}>{masterPaused?'Paused by the event automations switch.':r.paused?'Paused; resume to continue.':r.reason}</div>
      <button style={button} aria-label={`${r.paused?'Resume':'Pause'} mailbox rule ${r.label}`} disabled={!connected} onClick={()=>change(r.id,r.paused?'resume':'pause')}>{r.paused?'RESUME':'PAUSE'}</button>{' '}
      <button style={button} aria-label={`Cancel mailbox rule ${r.label}`} disabled={!connected} onClick={()=>change(r.id,'cancel')}>CANCEL RULE</button>
    </>}
  </div>;
  return <ComputerAutomationSection title="LEGACY MAILBOX RULES" helpKey="computer.mail-rules"
    activeCount={armed.filter((r)=>!r.paused&&!masterPaused).length} pausedCount={armed.filter((r)=>r.paused||masterPaused).length} historyCount={history.length}
    error={error} empty="No active legacy rules. New directives use conditional scripts." history={history.map(row)}>
    {armed.map(row)}
  </ComputerAutomationSection>;
}
