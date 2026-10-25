// Cross-provider context + strict no-history protocol proof, no inference.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { connect, step, summary, type SmokeClient } from './lib.js';

async function main() {
  const root = mkdtempSync(join(tmpdir(),'arco-computer-modes-'));
  const home = join(root,'home'); mkdirSync(join(home,'.arco'),{recursive:true});
  writeFileSync(join(home,'.arco','settings.json'), JSON.stringify({ollama:{baseUrl:'http://127.0.0.1:11434'},strata:{baseUrl:'http://127.0.0.1:8081/v1'}}));
  const requests = join(root,'requests.jsonl'); writeFileSync(requests,'');
  const reserve = createServer(); reserve.listen(0,'127.0.0.1'); await once(reserve,'listening');
  const port = (reserve.address() as {port:number}).port; await new Promise<void>((r)=>reserve.close(()=>r()));
  const logPath = join(root,'server.log'), log = openSync(logPath,'w');
  const server = spawn(process.execPath,['--conditions','development','--import','tsx','--import',resolve('scripts/smoke/fixtures/computer-local-preload.mjs'),'server/src/index.ts'],{
    env:{...process.env,HOME:home,ARCO_PORT:String(port),ARCO_WS_AUTH:'off',ARCO_SERVE_CLIENT:'0',ARCO_COMPUTER_FIXTURE_HOME:home,ARCO_COMPUTER_FIXTURE_REQUESTS:requests},stdio:['ignore',log,log],
  });
  let c: SmokeClient | undefined;
  const rows = () => readFileSync(requests,'utf8').trim().split('\n').filter(Boolean).map((s)=>JSON.parse(s));
  const create = async (provider:string,incognito=false) => {
    c!.send({type:'create_workflow',config:{kind:'chat',name:'Computer',voiceOperator:true,primaryProvider:provider,primaryModel:provider==='ollama'?'qwen-fixture':'strata-fixture',primaryEffort:'low',workingDirectory:'',skipPermissions:false,chatWebAccess:false,incognito}});
    return await c!.waitFor((m)=>m.type==='workflow_created',10000);
  };
  const ask = async (id:string,text:string) => {
    c!.send({type:'user_message',workflowId:id,content:text});
    let tools=0;
    for (;;) {
      const m = await c!.waitFor((m)=>m.workflowId===id && ['voice_tool_call','primary_turn_ended','primary_error','error'].includes(m.type),15000);
      if(m.type==='voice_tool_call') {
        assert.equal(m.tool,'arco_computer'); tools++;
        c!.send({type:'voice_tool_result',workflowId:id,requestId:m.requestId,ok:true,result:'Current Computer fixture.'});
      } else if(m.type==='primary_turn_ended') return tools;
      else throw Error(JSON.stringify(m));
    }
  };
  const fresh = async (id:string) => {
    const reset = await c!.waitFor((m)=>m.type==='computer_context_updated' && m.workflowId===id && m.fresh===true,15000);
    await c!.waitFor((m)=>m.type==='primary_turn_ended' && m.workflowId===id,15000);
    return reset;
  };
  try {
    for(let i=0;i<100;i++) {try { if((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) break; } catch{} await new Promise((r)=>setTimeout(r,100));}
    c=await connect(`ws://127.0.0.1:${port}/ws`);
    await step('manual clear works before any token metrics or provider session exists',async()=>{
      const made=await create('ollama'), id=String(made.workflowId);
      const before=rows().length;
      c!.send({type:'computer_context_control',workflowId:id,action:'fresh'});
      const reset=await fresh(id);
      assert.equal((reset.state as any).resets,1);
      assert.equal(rows().length,before);
      c!.send({type:'remove_workflow',workflowId:id});
    });
    for (const provider of ['ollama','strata']) {
      await step(`${provider}: only Computer tools, 75% auto clear, no history replay after clear`,async()=>{
        const made=await create(provider), id=String(made.workflowId);
        assert.equal(await ask(id,'sixty saved-context-marker'),1);
        assert(!c!.peekMessages().some((m)=>m.type==='computer_context_updated' && m.workflowId===id && m.fresh));
        assert.equal(await ask(id,'eighty slow current thing'),1); await fresh(id);
        const before=rows().length; await ask(id,'brand new thought');
        const after=JSON.stringify(rows().slice(before));
        assert(!after.includes('saved-context-marker')); assert(!after.includes('eighty slow'));
        const defs=rows().at(-1).tools.map((t:any)=>t.function.name);
        assert(defs.includes('arco_computer')); assert(defs.every((n:string)=>n.startsWith('arco_')));
      });
    }
    await step('Incognito Ollama: tool results + manual reset work and neither logs nor stores contain the transcript',async()=>{
      const made=await create('ollama',true), id=String(made.workflowId);
      const secret='PRIVATE_COMPUTER_SENTINEL_73819';
      assert.equal(await ask(id,secret),1);
      c!.send({type:'computer_context_control',workflowId:id,action:'fresh'});
      const reset=await fresh(id); assert.equal(reset.discardTranscript,true);
      const before=rows().length; await ask(id,'after private clear');
      assert(!JSON.stringify(rows().slice(before)).includes(secret));
      assert(!existsSync(join(home,'.arco','chats',id)));
      assert(!existsSync(join(String((made.config as any).workingDirectory),'.arco','workflows',id)));
      assert(!readFileSync(logPath,'utf8').includes(secret));
      assert(!readFileSync(logPath,'utf8').includes(id));
      const scan=(dir:string):string=>readdirSync(dir,{withFileTypes:true}).map((e)=>e.isDirectory()?scan(join(dir,e.name)):readFileSync(join(dir,e.name),'utf8')).join('');
      assert(!scan(join(home,'.arco')).includes(secret));
      c!.send({type:'remove_workflow',workflowId:id});
    });
    await step('Strata refuses strict Incognito instead of silently saving it',async()=>{
      c!.send({type:'create_workflow',config:{kind:'chat',name:'Computer',voiceOperator:true,primaryProvider:'strata',primaryModel:'strata-fixture',primaryEffort:'low',workingDirectory:'',skipPermissions:false,incognito:true}});
      const error=await c!.waitFor((m)=>m.type==='error' && String(m.message).includes('Incognito'),10000); assert(error);
    });
  } finally {
    await c?.close(); const stopped=once(server,'exit'); server.kill('SIGTERM'); await stopped; closeSync(log); console.log('Isolated artifacts:',root);
  }
  summary('computer-modes');
}
main().catch((e)=>{console.error(e);process.exitCode=1;});
