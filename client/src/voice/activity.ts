import { create } from 'zustand';
import type { ComputerActivitySnapshot } from '@arco/shared';
import { useComputerStore } from '../stores/computerStore';
import { useAppStore } from '../stores/appStore';
export const useComputerActivity = create<{snapshot:ComputerActivitySnapshot|null;error:string|null;revision:number;ownerId:string|null}>(()=>({snapshot:null,error:null,revision:0,ownerId:null}));
export function receiveComputerActivityChanged(ownerId:string) {
  if(useComputerStore.getState().activeId===ownerId)useComputerActivity.setState((s)=>({revision:s.revision+1,ownerId}));
}
export async function activityRequest(ownerId:string,args?:Record<string,unknown>) {
  if(!useAppStore.getState().connected)throw Error('Disconnected. Activity settings were not changed.');
  const epoch=useComputerStore.getState().contextEpoch;
  const response=await fetch(`/api/voice/activity?owner=${encodeURIComponent(ownerId)}`,{
    ...(args?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)}:{}),signal:AbortSignal.timeout(10000),
  });
  const result=await response.json();if(!response.ok)throw Error(result.error??'Computer activity request failed.');
  if(useComputerStore.getState().activeId===ownerId && useComputerStore.getState().contextEpoch===epoch)useComputerActivity.setState({snapshot:result,error:result.warning??null,ownerId});
  return result as ComputerActivitySnapshot;
}
export async function activityToolRequest(ownerId:string,args:Record<string,string>) {
  const result=await activityRequest(ownerId,{...args,...(args.enabled!==undefined?{enabled:args.enabled==='true'}:{})});
  return JSON.stringify({policy:result.policy,pending:result.pending,updatesPerHour:result.updatesPerHour,updatesThisHour:result.updatesThisHour,nextUpdateAt:result.nextUpdateAt,warning:result.warning,
    ledger:result.ledger.slice(-8),deliveries:result.deliveries.slice(-5).map((d)=>({id:d.id,status:d.status,kind:d.event.kind,name:d.event.name,reason:d.reason})),note:'Full recent ledger and delivery state are in COMPUTER.'});
}
