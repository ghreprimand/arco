// Volatile observations only. This leaf never imports providers or persistence.
import type { ServerMessage } from '@arco/shared';
import { publishActivity } from './activityBus.js';
export interface ObservedWorker {
  text:string; version:number; contextRevision:number; input:boolean|null; digest?:string; truncated?:boolean;
  tokens:number|null; window:number|null; percent:number|null; compacting:boolean; compactionClaim:boolean; compactions:number; compactionVersion?:number;
  finished:number; failed:number; interrupted:number; mail:number;
}
const facts=new Map<string,ObservedWorker>();
export function observedWorker(id:string) {
  let f=facts.get(id);
  if(!f){f={text:'',version:0,contextRevision:0,input:null,tokens:null,window:null,percent:null,compacting:false,compactionClaim:false,compactions:0,finished:0,failed:0,interrupted:0,mail:0};facts.set(id,f);}
  return f;
}
export function observeConditionMessage(id:string,clusterId:string|undefined,m:ServerMessage) {
  if(!clusterId)return;
  const f=observedWorker(id);let changed=false;
  if(m.type==='user_message_echo'){f.text='';f.version++;f.input=null;f.digest=undefined;f.truncated=false;changed=true;}
  else if(m.type==='primary_text'){f.text+=m.text;if(f.text.length>32000){f.text=f.text.slice(-32000);f.truncated=true;}f.version++;}
  else if(m.type==='context_usage'){f.tokens=m.estimatedTokens;f.window=m.windowSize;f.percent=m.windowSize?m.estimatedTokens/m.windowSize*100:null;changed=true;}
  else if(m.type==='codex_token_snapshot'&&m.modelContextWindow){f.tokens=m.tokens.input;f.window=m.modelContextWindow;f.percent=m.tokens.input/m.modelContextWindow*100;changed=true;}
  else if(m.type==='primary_complete'&&m.lastPromptTokens!==undefined){f.tokens=m.lastPromptTokens;f.window=m.modelContextWindow??f.window;f.percent=f.window?m.lastPromptTokens/f.window*100:null;changed=true;}
  else if(m.type==='native_compacting'){f.compacting=true;changed=true;}
  else if(m.type==='native_compacted'){f.compacting=f.compactionClaim;changed=true;}
  else if(m.type==='operator_question'||m.type==='gate_required'||m.type==='gate_resolved'||m.type==='system_notice'){changed=true;}
  if(changed){f.contextRevision++;publishActivity({kind:'worker_state_changed',workflowId:id,clusterId});}
}
export function forgetObservedWorker(id:string){facts.delete(id);}
