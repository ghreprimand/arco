"""Causal transcript ordering with synthetic streaming and session replies; no server or provider calls."""
import asyncio
import json
import os
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect

URL = 'http://127.0.0.1:' + os.environ.get('ARCO_CLIENT_PORT', '5203') + '/'
WORKFLOW = 'conversation-fixture'

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        context = await browser.new_context(viewport={'width':1920,'height':1080})
        errors, frames, writes = [], [], []
        async def api(route):
            request = route.request
            path = urlparse(request.url).path
            if request.method != 'GET':
                writes.append(path)
                assert path == '/api/session', path
            data = {'files':[],'entries':[],'workflows':[],'projects':[],'clusters':[],'skills':[],'plans':[],'items':[],'tasks':[],'sessions':[],'messages':[]}
            if path == '/api/settings':
                data = {'themeId':'phosphor:arco:electric','uiScale':1.1,'onboardingComplete':True,'enabledProviders':{'claude':True}}
            elif path == '/api/auth-status':
                data = {key:{'loggedIn':key=='claude','installed':True,'cliInstalled':True} for key in ['claude','codex','cursor','ollama','llamacpp','lmstudio','strata','deepseek','github']}
            elif path == '/api/capabilities':
                data = {'efforts':['low','medium','high'],'models':['sonnet'],'cliVersion':'fixture'}
            elif path.endswith('/catalog'): data = {'models':[]}
            elif path == '/api/installation-history': data = {'used':True}
            elif path == '/api/projects': data = {'roots':[],'projects':[],'organization':True}
            elif path == '/api/update-check': data = {'current':'0.1.0','enabled':False,'updateAvailable':False}
            elif path == '/api/git/bakeoffs/diff': data = {'patch':'diff --git a/result.txt b/result.txt\n--- a/result.txt\n+++ b/result.txt\n@@ -1 +1 @@\n-before\n+preserved candidate result\n'}
            await route.fulfill(json=data)
        await context.route('**/api/**', api)
        await context.route('**/healthz', lambda route: route.fulfill(json={'status':'live'}))
        await context.route('https://**/*', lambda route: route.abort())
        await context.route_web_socket('**/*', lambda ws: ws.on_message(lambda message: frames.append(json.loads(message))))
        page = await context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(URL)
        await page.locator('#home-title').wait_for()

        async def connect(reset=False):
            await page.evaluate("""async ({id,reset}) => {
              const {useAppStore:s}=await import('/src/stores/appStore.ts'); window.testStore=s;
              const {handleServerMessage:receive}=await import('/src/ws/handleServerMessage.ts');
              window.receiveFixture=(type,seq,fields={})=>receive({type,seq,workflowId:id,phase:'passthrough',...fields},{wsRef:{current:null},scheduleReconnect:()=>{}});
              s.setState({connected:true,connectionState:'online'});
              if(reset&&s.getState().jobs[id])s.getState().removeJob(id);
              if(!s.getState().jobs[id])s.getState().createJob(id,{name:'Conversation fixture',workingDirectory:'/projects/fixture',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',skipPermissions:false});
              s.getState().setActiveJob(id);
              s.setState(st=>({jobs:{...st.jobs,[id]:{...st.jobs[id],snapshotReceived:true}}}));
            }""",{'id':WORKFLOW,'reset':reset})

        async def emit(type,seq,**fields):
            await page.evaluate('({type,seq,fields})=>receiveFixture(type,seq,fields)',{'type':type,'seq':seq,'fields':fields})

        async def assert_order(labels):
            for label in labels:
                loc=page.locator('[data-help="chat.panel"]').get_by_text(label,exact=True)
                await expect(loc).to_have_count(1)
                await expect(loc).to_be_visible()
            # Read every position in one frame. Auto-follow can move the
            # viewport between individual asynchronous bounding_box calls.
            await page.wait_for_function("""labels=>{const pane=document.querySelector('[data-help="chat.panel"]');if(!pane)return false;const boxes=labels.map(label=>[...pane.querySelectorAll('*')].find(el=>el.textContent===label)?.getBoundingClientRect());return boxes.every((b,i)=>b&&b.width>0&&b.height>0&&(!i||b.y>=boxes[i-1].y));}""",arg=labels)
            await expect(page.get_by_text('THIS VIEW HIT A RENDER ERROR',exact=True)).to_have_count(0)
            assert not errors,errors

        async def replay():
            await emit('primary_turn_started',1,startedAt=1000)
            await emit('primary_text',2,text='Before segment')
            await emit('peer_message_received',3,msgId='peer-one',fromName='Worker',content='Peer one advice',ts=500,**{'from':'worker'})
            await emit('peer_message_received',4,msgId='peer-two',fromName='Worker',content='Peer two advice',ts=400,**{'from':'worker'})
            await emit('primary_text',5,text='After segment')
            await emit('primary_complete',6,costUsd=0)
            await emit('primary_turn_ended',7,endedAt=2000)

        labels=['Before segment','Peer one advice','Peer two advice','After segment']
        await connect(True)
        await replay()
        await assert_order(labels)
        for content,uuid,ts in [('Before segmentAfter segment','session-combined',1500)]:
            await emit('session_entry',8,entry={'kind':'message','role':'assistant','content':content,'uuid':uuid,'timestamp':ts})
        await assert_order(labels)
        saved=await page.evaluate('(id)=>testStore.getState().jobs[id].messages.map(m=>[m.id,m.role,m.content])',WORKFLOW)
        # The same ChatPanel is mounted in a focused cluster member pane.
        await page.evaluate("""id=>{const s=testStore;s.getState().setClusterState('conversation-cluster',{clusterId:'conversation-cluster',cwd:'/projects/fixture',createdAt:'',taskBoardMode:'none',taskBoardAttached:false,mailboxDepth:{},members:[{workflowId:id,displayName:'Builder',status:'idle'}]});s.getState().setActiveCluster('conversation-cluster');}""",WORKFLOW)
        await assert_order(labels)
        await page.evaluate("window.dispatchEvent(new Event('pagehide'))")
        await page.reload()
        await connect()
        await assert_order(labels)
        assert await page.evaluate('(id)=>testStore.getState().jobs[id].messages.map(m=>[m.id,m.role,m.content])',WORKFLOW)==saved
        # A full cold replay regenerates stable segment identities and order.
        await connect(True);await replay();await assert_order(labels)
        assert await page.evaluate('(id)=>testStore.getState().jobs[id].messages.map(m=>[m.id,m.role,m.content]).filter(m=>m[1]!=="system")',WORKFLOW)==[m for m in saved if m[1]!='system']
        await emit('peer_message_received',3,msgId='peer-one',fromName='Worker',content='Peer one advice',ts=500,**{'from':'worker'})
        await emit('primary_text',5,text='After segment')
        await assert_order(labels)
        await page.set_viewport_size({'width':1100,'height':720})
        await assert_order(labels)
        assert all(path=='/api/session' for path in writes),writes
        assert not any(f.get('type') in ['create_workflow','user_message','cluster_broadcast','peer_send'] for f in frames),frames
        print('PASS: live peer boundaries, reversed sender clocks, session overlay, cluster pane, persisted reload, cold replay, duplicate replay and constrained viewport; original text and stable segment ids preserved')
        await browser.close()

asyncio.run(main())
