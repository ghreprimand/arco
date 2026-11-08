import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import { checkHttpAuth, mintToken, SESSION_COOKIE } from './wsAuth.js';

const root = mkdtempSync(join(tmpdir(),'arco-plan-methods-'));
installIsolatedTestHome(root);
delete process.env.ARCO_WS_AUTH;
const paths: Record<string,string[]> = {
  '/api/plans':['GET','POST'], '/api/plans/attach':['POST'],
  '/api/plans/refs':['GET','PUT'], '/api/plans/refs/body':['GET'],
};
for (const [path, allowed] of Object.entries(paths)) for (const method of ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','CONNECT','TRACE']) {
  test(`plan admission: ${method} ${path}`, () => {
    for (const suffix of ['', '?path=fixture&planId=fixture']) {
      const req = {method,url:path+suffix,headers:{}} as IncomingMessage;
      assert.equal(checkHttpAuth(req).ok,allowed.includes(method));
      req.headers.cookie=`${SESSION_COOKIE}=${mintToken()}`;
      assert.equal(checkHttpAuth(req).ok,true);
      req.headers.cookie=`${SESSION_COOKIE}=invalid`;
      assert.equal(checkHttpAuth(req).ok,allowed.includes(method));
    }
  });
}
test('nearby plan paths never inherit an exemption', () => {
  for (const path of ['/api/plans/','/api/plans/body','/api/plans/move','/api/plans/attach/extra','/api/plans/refs/body/extra']) {
    for (const method of ['GET','POST','PUT','PATCH','DELETE']) assert.equal(checkHttpAuth({method,url:path,headers:{}} as IncomingMessage).ok,false,`${method} ${path}`);
  }
});

test('real plan routes retain agent authoring and refuse operator changes before body reads', async t => {
  const {handleHttpRequest} = await import('./router.js');
  const plans = await import('../planStore.js');
  const {workflowCwds} = await import('../server/state.js');
  const cwd = join(root,'project'); await fs.mkdir(cwd);
  const id=randomUUID();workflowCwds.set(id,cwd);
  const attachments: string[]=[]; const detached: string[]=[];
  const deps = {handlePlanAttach:async (_id:string, planId:string)=>{attachments.push(planId);},detachAllForPlan:async (_cwd:string,planId:string)=>{detached.push(planId);}} as any;
  async function send(method:string,path:string,params:Record<string,string>,body?:unknown,cookie?:string,denyRead=false) {
    const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]) as IncomingMessage;
    Object.assign(req,{method,url:`${path}?${new URLSearchParams({path:cwd,...params})}`,headers:{host:'127.0.0.1:3001',...(cookie?{cookie}:{})},socket:{remoteAddress:'127.0.0.1',remotePort:1}});
    let reads=0;
    if(denyRead) Object.defineProperty(req,Symbol.asyncIterator,{value:()=>{reads++;throw Error('refused request body was read');}});
    let status=0,text='';
    const res:any={headersSent:false,setHeader(){},getHeader(){},writeHead(code:number){status=code;res.headersSent=true;},end(value=''){text+=value;},on(){return res;},once(){return res;}};
    await handleHttpRequest(req,res as ServerResponse,deps);
    return {status,json:JSON.parse(text||'{}'),reads};
  }
  try {
    const created=await send('POST','/api/plans',{}, {title:'Synthetic plan',body:'### Phase\n- [ ] Task',attach:true,workflowId:id});
    assert.equal(created.status,200);const planId=created.json.plan.id;
    assert.deepEqual(attachments,[planId]);
    const listed = (await send('GET','/api/plans',{})).json.plans[0];
    assert.equal(listed.id, planId);
    assert.equal(listed.taskCount, 1);
    await plans.updatePlan(cwd, planId, { body: '- [x] One\n  - [ ] Two' });
    assert.equal((await send('GET','/api/plans',{})).json.plans[0].taskCount, 2);
    assert.equal((await send('POST','/api/plans/attach',{planId,workflowId:id})).status,200);
    assert.equal((await send('PUT','/api/plans/refs',{planId,slug:'fixture'},{body:'# Fixture\nBody'})).status,200);
    assert.equal((await send('GET','/api/plans/refs',{planId})).json.refs.length,1);
    assert.equal((await send('GET','/api/plans/refs/body',{planId,slug:'fixture'})).json.ref.body,'# Fixture\nBody');
    const {registerPlanTools} = await import('../mcp/planMcpTools.js');
    const handlers = new Map<string,(args:any)=>Promise<any>>();
    registerPlanTools({registerTool:(name:string,_def:any,handler:any)=>handlers.set(name,handler)} as any,{workflowId:id,cwd,arcoPort:3001});
    t.mock.method(globalThis,'fetch',async (target:any,init?:RequestInit)=>{
      const url=new URL(String(target));
      assert.equal(url.origin,'http://127.0.0.1:3001');
      const reply=await send(init?.method??'GET',url.pathname,Object.fromEntries(url.searchParams),init?.body?JSON.parse(String(init.body)):undefined);
      return Response.json(reply.json,{status:reply.status});
    });
    const call=async(name:string,args:any)=>{
      const result=await handlers.get(name)!(args);
      assert.notEqual(result.isError,true,name);
      const text=result.content[0].text;
      try{return JSON.parse(text);}catch{return text;}
    };
    const extra=await call('plan_create',{title:'Tool-created plan',body:'### Phase 1\n- [ ] Task'});
    assert.ok(extra.planId);
    assert.equal((await call('plan_list',{})).plans.length,2);
    assert.equal((await call('plan_attach',{planId})).attached,true);
    await call('plan_ref_write',{planId,slug:'fixture',body:'# Fixture\nBody'});
    assert.equal((await call('plan_ref_list',{planId})).refs.length,1);
    assert.match(await call('plan_ref_read',{planId,slug:'fixture'}),/Body/);
    const before=await plans.readPlan(cwd,planId);
    for (const path of Object.keys(paths)) for (const method of ['PATCH','DELETE']) {
      const result=await send(method,path,{planId,slug:'fixture',workflowId:id},{body:'Replacement',completedAt:1},undefined,true);
      assert.equal(result.status,401,`${method} ${path}`);assert.equal(result.reads,0);
      assert.deepEqual(await plans.readPlan(cwd,planId),before);
      assert.equal((await plans.listPlanRefs(cwd,planId)).length,1);
      assert.deepEqual(detached,[]);
    }
    const cookie=`${SESSION_COOKIE}=${mintToken()}`;
    assert.equal((await send('PATCH','/api/plans',{planId},{completedAt:1},cookie)).status,200);
    assert.deepEqual(detached,[planId]);
    assert.equal((await send('DELETE','/api/plans/refs',{planId,slug:'fixture'},undefined,cookie)).status,200);
    assert.equal((await send('DELETE','/api/plans',{planId},undefined,cookie)).status,200);
  } finally {workflowCwds.delete(id);await fs.rm(cwd,{recursive:true,force:true});}
});
after(async()=>{await fs.rm(root,{recursive:true,force:true});});
