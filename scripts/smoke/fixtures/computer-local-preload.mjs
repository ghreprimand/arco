// Isolated source-server fixture: no daemon/GPU/cloud calls.
import os from 'node:os';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
os.homedir = () => process.env.ARCO_COMPUTER_FIXTURE_HOME;
syncBuiltinESMExports();
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(String(url)).pathname;
  const body = init.body ? JSON.parse(String(init.body)) : {};
  if (path === '/api/version') return Response.json({version:'0.20.0'});
  if (path === '/api/tags') return Response.json({models:[{name:'qwen-fixture',model:'qwen-fixture'}]});
  if (path === '/api/show') return Response.json({capabilities:['completion','tools'], parameters:'num_ctx 100000', model_info:{'fixture.context_length':100000}});
  if (path === '/api/ps') return Response.json({models:[]});
  if (path === '/v1/models') return Response.json({data:[{id:'strata-fixture',meta:{n_ctx:100000}}]});
  if (path === '/api/chat' || path === '/v1/chat/completions') {
    appendFileSync(process.env.ARCO_COMPUTER_FIXTURE_REQUESTS, JSON.stringify(body) + '\n');
    const text = body.messages?.findLast((m) => m.role === 'user')?.content ?? '';
    if (text.includes('slow')) await new Promise((r) => setTimeout(r,150));
    const tokens = text.includes('eighty') ? 80000 : text.includes('sixty') ? 60000 : 1000;
    const tools = body.tools?.length && body.messages.findLastIndex((m) => m.role === 'tool') < body.messages.findLastIndex((m) => m.role === 'user');
    if (path === '/api/chat') {
      const message = tools ? {role:'assistant',content:'',tool_calls:[{function:{name:'arco_computer',arguments:{action:'status'}}}]} : {role:'assistant',content:'Done.'};
      return new Response(JSON.stringify({model:'qwen-fixture',message,done:true,prompt_eval_count:tokens,eval_count:2,total_duration:1e9,eval_duration:1e8})+'\n', {headers:{'Content-Type':'application/x-ndjson'}});
    }
    const delta = tools ? {tool_calls:[{index:0,id:'fixture-call',type:'function',function:{name:'arco_computer',arguments:'{"action":"status"}'}}]} : {content:'Done.'};
    return new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:tools?'tool_calls':'stop'}],usage:{prompt_tokens:tokens,completion_tokens:2,total_tokens:tokens+2}})+'\n\ndata: [DONE]\n\n', {headers:{'Content-Type':'text/event-stream'}});
  }
  return new Response('{}',{status:503});
};
