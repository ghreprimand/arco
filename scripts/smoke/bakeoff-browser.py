"""Bakeoff navigation and delayed synthetic replies; no server or provider calls."""
import asyncio
import json
import os
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect

URL = 'http://127.0.0.1:' + os.environ.get('ARCO_CLIENT_PORT', '5202') + '/'
WORKFLOW = 'bakeoff-source-fixture'
RECORD = {'id':'saved-comparison','sourceWorkflowId':WORKFLOW,'sourceCwd':'/projects/fixture','name':'Saved comparison','prompt':'Preserved comparison prompt','baseRef':'abcdef0123456789','baseBranch':'main','createdAt':1,'updatedAt':2,'status':'ready','attempts':[{'id':'saved-attempt','index':0,'label':'Saved attempt result','provider':'claude','model':'sonnet','effort':'low','workflowId':'saved-attempt-workflow','worktreePath':'/projects/fixture-attempt','branch':'fixture-attempt','status':'done'}]}

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

        async def connect():
            await page.evaluate('''async id => {
              const {useAppStore:s}=await import('/src/stores/appStore.ts'); window.testStore=s;
              const {handleServerMessage:receive}=await import('/src/ws/handleServerMessage.ts');
              window.replyBakeoff=records=>receive({type:'bakeoff_list_result',workflowId:id,bakeoffs:records},{wsRef:{current:null},scheduleReconnect:()=>{}});
              s.setState({connected:true,connectionState:'online'});
              if (!s.getState().jobs[id]) s.getState().createJob(id,{name:'Saved source workflow',workingDirectory:'/projects/fixture',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',skipPermissions:false});
              s.getState().setActiveJob(id);
              s.setState(st=>({jobs:{...st.jobs,[id]:{...st.jobs[id],snapshotReceived:true}}}));
            }''', WORKFLOW)

        async def choose_tab(tab):
            narrow = page.locator('select[data-help^="rightpanel.tab."]')
            if await narrow.count(): await narrow.select_option(tab)
            else:
                await page.locator('[data-help="rightpanel.group.agent"]').click()
                await page.locator(f'button[data-help="rightpanel.tab.{tab}"]').click()

        async def healthy():
            await expect(page.get_by_text('THIS VIEW HIT A RENDER ERROR',exact=True)).to_have_count(0)
            assert not errors, errors

        async def current_records():
            return await page.evaluate('(id)=>testStore.getState().bakeoffsByWorkflow[id]', WORKFLOW)

        await connect()
        source = await page.evaluate('(id)=>({config:testStore.getState().jobs[id].config,messages:testStore.getState().jobs[id].messages})', WORKFLOW)
        assert await current_records() is None
        await choose_tab('bakeoff')
        # Leave the list unanswered long enough to expose an unstable snapshot.
        await page.wait_for_timeout(250)
        await healthy()
        await expect(page.get_by_text('NO BAKE-OFFS YET',exact=True)).to_be_visible()
        assert await current_records() is None
        assert any(frame.get('type') == 'bakeoff_list' for frame in frames), frames
        await page.evaluate('replyBakeoff([])')
        await expect(page.get_by_text('NO BAKE-OFFS YET',exact=True)).to_be_visible()
        for _ in range(3):
            await choose_tab('activity'); await choose_tab('bakeoff'); await healthy()
        # A later authoritative reply makes saved records available normally.
        await page.evaluate('records=>replyBakeoff(records)', [RECORD])
        await expect(page.get_by_text('Saved comparison',exact=True)).to_be_visible()
        await expect(page.get_by_text('SAVED ATTEMPT RESULT',exact=True)).to_be_visible()
        await page.get_by_role('button',name='VIEW DIFF',exact=True).click()
        await expect(page.get_by_text('preserved candidate result',exact=True)).to_be_visible()
        for _ in range(3):
            await choose_tab('activity'); await choose_tab('bakeoff'); await healthy()
        assert await current_records() == [RECORD]
        assert await page.evaluate('(id)=>({config:testStore.getState().jobs[id].config,messages:testStore.getState().jobs[id].messages})', WORKFLOW) == source
        # Flush the existing workflow persistence before cold reload. Comparison
        # records are server-owned and must safely wait for a fresh list reply.
        await page.evaluate("window.dispatchEvent(new Event('pagehide'))")
        await page.reload()
        await connect()
        await choose_tab('bakeoff')
        await page.wait_for_timeout(250)
        await healthy()
        assert await current_records() is None
        await expect(page.get_by_text('NO BAKE-OFFS YET',exact=True)).to_be_visible()
        await page.evaluate('records=>replyBakeoff(records)', [RECORD])
        await expect(page.get_by_text('Saved comparison',exact=True)).to_be_visible()
        await page.set_viewport_size({'width':1100,'height':720})
        await expect(page.locator('select[data-help^="rightpanel.tab."]')).to_have_count(1)
        for _ in range(3):
            await choose_tab('activity'); await choose_tab('bakeoff'); await healthy()
        assert await current_records() == [RECORD]
        assert await page.evaluate('(id)=>({config:testStore.getState().jobs[id].config,messages:testStore.getState().jobs[id].messages})', WORKFLOW) == source
        assert not any(frame.get('type') in ['bakeoff_start','bakeoff_promote','bakeoff_cleanup','create_workflow','send_prompt'] for frame in frames), frames
        assert all(path == '/api/session' for path in writes), writes
        print('PASS: uncached and cached Bakeoff, delayed empty/populated replies, saved diffs and records, repeated warm navigation, cold reload and narrow navigation; no provider launches or saved-state mutations')
        await browser.close()

asyncio.run(main())
