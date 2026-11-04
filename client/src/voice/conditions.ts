import { create } from 'zustand';
import { voiceText, type ComputerConditionRule } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useComputerStore } from '../stores/computerStore';
export const useComputerConditions=create<{rules:ComputerConditionRule[];error:string|null;observationTurns:number}>(()=>({rules:[],error:null,observationTurns:0}));
export async function conditionRequest(ownerId:string,args?:Record<string,unknown>){
  if(!useAppStore.getState().connected)throw Error('Disconnected. Scripts were not changed.');
  const epoch=useComputerStore.getState().contextEpoch;
  const res=await fetch(`/api/voice/conditions?owner=${encodeURIComponent(ownerId)}`,{...(args?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)}:{}),signal:AbortSignal.timeout(10000)});
  const body=await res.json();if(!res.ok)throw Error(body.error??'Script request failed.');
  if(useComputerStore.getState().activeId===ownerId&&useComputerStore.getState().contextEpoch===epoch&&Array.isArray(body.rules))useComputerConditions.setState({rules:body.rules,error:body.warning??null,observationTurns:body.observationTurnsThisHour??0});
  return body;
}
export async function conditionToolRequest(ownerId:string,args:Record<string,string>){
  const body:Record<string,unknown>={...args};
  if(args.definition)body.definition=JSON.parse(args.definition);
  if(args.cluster_ids)body.cluster_ids=JSON.parse(args.cluster_ids);
  if(args.expected_revision!==undefined)body.expected_revision=Number(args.expected_revision);
  const result=await conditionRequest(ownerId,body);
  if(result.workers)return JSON.stringify({workers:result.workers.map(({name,clusterId,...facts}:Record<string,unknown>)=>facts)});
  if(!result.rules)return JSON.stringify(result);
  return JSON.stringify({rule:result.rule?{id:result.rule.id,status:result.rule.status,definition:result.rule.definition,revision:result.rule.revision,actions:result.rule.actions,workerTurns:result.rule.workerTurns,expiresAt:result.rule.expiresAt,reason:result.rule.reason}:undefined,
    rules:result.rule?undefined:[...result.rules.filter((r:ComputerConditionRule)=>r.status==='watching'),...result.rules.filter((r:ComputerConditionRule)=>r.status!=='watching').slice(-5)].map((r:ComputerConditionRule)=>({id:r.id,label:voiceText(r.definition.label,80),status:r.status,paused:r.paused,reason:voiceText(r.reason,160),actions:r.actions})),warning:result.warning,note:'COMPUTER shows full scripts, identities, limits and action history.'});
}
