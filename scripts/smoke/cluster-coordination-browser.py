"""Real creator and existing-cluster controls with synthetic APIs and no provider calls."""
import asyncio
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect

PORT = os.environ.get('ARCO_CLIENT_PORT', '5206')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
ART = Path('/tmp/arco-coordination-browser')
ART.mkdir(parents=True, exist_ok=True)
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/styles/matrix.css"></head><body><div id="fixture"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width':1500,'height':950})
        errors, blocked = [], []
        async def isolate(route):
            u = urlparse(route.request.url)
            if u.netloc in ('fonts.googleapis.com','fonts.gstatic.com'):
                await route.fulfill(content_type='text/css',body=''); return
            if u.scheme == 'http' and u.netloc == '127.0.0.1:'+PORT and route.request.method == 'GET':
                if u.path == '/fixture': await route.fulfill(content_type='text/html',body=HTML); return
                if u.path.startswith('/api/'):
                    data = {'items':[], 'projects':[], 'roots':[], 'sessions':[], 'presets':[], 'templates':[], 'skills':[], 'models':[], 'clusters':[], 'trusted':False}
                    await route.fulfill(json=data); return
                local = u.path.startswith('/@fs/') and Path(unquote(u.path[4:])).resolve().is_relative_to(ROOT)
                if local or u.path.startswith(('/@react-refresh','/@vite/','/@id/','/node_modules/.vite/deps/','/src/','/phosphor-demo/')):
                    await route.continue_(); return
            blocked.append(u.path); await route.abort()
        await page.route('**/*',isolate)
        await page.route_web_socket('**/*',lambda ws:None)
        page.on('pageerror',lambda e:errors.append(str(e)))
        await page.goto(ORIGIN+'/fixture')
        await page.wait_for_function('window.fixtureReady')
        await page.evaluate('''async()=>{
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {WorkflowCreator}=await import('/src/components/WorkflowCreator/index.tsx');
          const {ClusterTab}=await import('/src/components/ClusterTab.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts');
          const {resolveClusterMessageGuard}=await import('/@fs/'''+str(ROOT)+'''/shared/src/index.ts');
          window.s=s;window.created=[];window.edits=[];window.sent=[];
          s.setState({connected:true,creatorPrefill:{mode:'cluster',workDir:'/projects/fixture'},settings:{...s.getState().settings,enabledProviders:{claude:true},workflowDefaults:{primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'medium'},projectRoots:[]},authStatus:{claude:{loggedIn:true,native:{credentialPresent:true}}}});
          for(const id of ['worker-a','worker-b'])s.getState().createJob(id,{name:id,workingDirectory:'/projects/fixture',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'medium'});
          const root=createRoot(document.getElementById('fixture'));
          let gen=0;
          window.showCreator=()=>root.render(React.createElement(WorkflowCreator,{key:++gen,onCreate:()=>{},onCreateCluster:p=>created.push(p)}));
          window.showCluster=(legacy=false)=>{
            const cluster={clusterId:'fixture-cluster',cwd:'/projects/fixture',createdAt:'',taskBoardMode:'cluster',taskBoardAttached:true,progressTracking:'board',efficiencyLevel:'lean',efficiencyAddendum:'Saved NOTE',...(legacy?{}:{messageGuard:{mode:'warn',threshold:15}}),members:[{workflowId:'worker-a',displayName:'Alpha',status:'idle',role:'Implementer'},{workflowId:'worker-b',displayName:'Beta',status:'busy',role:'Director'}],mailboxDepth:{'worker-a':1,'worker-b':1}};
            s.setState({clusters:{...s.getState().clusters,[cluster.clusterId]:cluster}});
            root.render(React.createElement('div',{style:{display:'flex',height:900}},React.createElement(ClusterTab,{key:++gen,clusterId:cluster.clusterId,onSendToMember:(...x)=>{sent.push(x);return true},onCancelMember:()=>{},onCancelQueuedForMember:()=>{},onUpload:async()=>null,onSetEfficiency:(id,level,addendum,messageGuard)=>{
              edits.push({id,level,addendum,messageGuard});const c=s.getState().clusters[id];s.setState({clusters:{...s.getState().clusters,[id]:{...c,efficiencyLevel:level,efficiencyAddendum:addendum===undefined?c.efficiencyAddendum:addendum,messageGuard:messageGuard??resolveClusterMessageGuard(c)}}});
            },onSetProgress:(id,mode)=>{const c=s.getState().clusters[id];s.setState({clusters:{...s.getState().clusters,[id]:{...c,progressTracking:mode}}})}})));
          };
          showCreator();
        }''')
        await expect(page.get_by_label('Message guard',exact=True)).to_have_value('warn')
        await expect(page.get_by_label('Message threshold',exact=True)).to_have_value('15')
        await expect(page.get_by_label('Cluster task board',exact=True)).to_have_value('cluster')
        await expect(page.get_by_label('Keep current',exact=True)).to_have_value('both')
        await expect(page.get_by_role('button',name='BALANCED',exact=True)).to_have_attribute('aria-pressed','true')
        await page.locator('[data-help=\"cluster.efficiency\"]').first.screenshot(path=str(ART/'creator-controls.png'))
        await page.get_by_role('button',name='CREATE CLUSTER',exact=True).click()
        await page.wait_for_function('created.length===1')
        assert await page.evaluate('({style:created[0].efficiencyLevel,guard:created[0].messageGuard,board:created[0].taskBoardMode,progress:created[0].progressTracking})') == {'style':'balanced','guard':{'mode':'warn','threshold':15},'board':'cluster','progress':'both'}
        await page.get_by_role('button',name='THOROUGH',exact=True).click()
        await page.get_by_label('Message guard',exact=True).select_option('hard')
        await page.get_by_label('Message threshold',exact=True).fill('27')
        await page.get_by_label('Message threshold',exact=True).press('Enter')
        await page.get_by_label('Cluster task board',exact=True).select_option('project')
        await page.get_by_label('Keep current',exact=True).select_option('plan')
        await page.get_by_label('Cluster NOTE',exact=True).fill('Creator NOTE')
        await page.get_by_role('button',name='CREATE CLUSTER',exact=True).click()
        assert await page.evaluate('({style:created[1].efficiencyLevel,guard:created[1].messageGuard,board:created[1].taskBoardMode,progress:created[1].progressTracking,note:created[1].efficiencyAddendum})') == {'style':'thorough','guard':{'mode':'hard','threshold':27},'board':'project','progress':'plan','note':'Creator NOTE'}
        await page.evaluate('showCluster()')
        await expect(page.get_by_label('Message guard',exact=True)).to_have_value('warn')
        await page.get_by_role('button',name='THOROUGH',exact=True).click()
        await expect(page.get_by_label('Message threshold',exact=True)).to_have_value('15')
        await page.get_by_label('Message guard',exact=True).select_option('hard')
        before=await page.evaluate('edits.length')
        await page.get_by_label('Message threshold',exact=True).fill('21')
        assert await page.evaluate('edits.length')==before
        await page.get_by_label('Message threshold',exact=True).press('Enter')
        assert await page.evaluate('edits.length')==before+1
        await page.get_by_label('Message threshold',exact=True).fill('0')
        await page.get_by_label('Message threshold',exact=True).press('Tab')
        await expect(page.get_by_label('Message threshold',exact=True)).to_have_value('21')
        assert await page.evaluate('edits.length')==before+1
        await page.get_by_label('Message guard',exact=True).select_option('none')
        await expect(page.get_by_label('Message threshold',exact=True)).to_have_count(0)
        await page.get_by_role('button',name='BALANCED',exact=True).click()
        assert await page.evaluate('s.getState().clusters["fixture-cluster"].messageGuard')=={'mode':'none','threshold':21}
        assert await page.evaluate('s.getState().clusters["fixture-cluster"].efficiencyAddendum')=='Saved NOTE'
        assert await page.evaluate('s.getState().clusters["fixture-cluster"].progressTracking')=='board'
        await page.get_by_role('button',name='NOTE•',exact=True).click()
        note=page.get_by_placeholder("Optional note added to this cluster's coordination instructions")
        await note.fill('Updated NOTE')
        await note.press('Enter')
        assert await page.evaluate('s.getState().clusters["fixture-cluster"].efficiencyAddendum')=='Updated NOTE'
        assert await page.evaluate('s.getState().clusters["fixture-cluster"].messageGuard')=={'mode':'none','threshold':21}
        await page.evaluate('showCluster(true)')
        await expect(page.get_by_label('Message guard',exact=True)).to_have_value('hard')
        await expect(page.get_by_label('Message threshold',exact=True)).to_have_value('4')
        await page.get_by_role('button',name='BALANCED',exact=True).click()
        await expect(page.get_by_label('Message threshold',exact=True)).to_have_value('4')
        await page.get_by_label('Message guard',exact=True).locator('xpath=../..').screenshot(path=str(ART/'legacy-controls.png'))
        for name,active in [('Alpha',False),('Beta',True)]:
            await page.locator('button[data-help="cluster.broadcast.nudge"]').click()
            dialog=page.get_by_role('dialog')
            await expect(dialog.locator('input[type=checkbox]:checked')).to_have_count(0)
            await dialog.get_by_text(name,exact=True).click()
            await dialog.get_by_role('button',name='SEND NUDGE (1)').click()
            prompt=await page.evaluate('sent.at(-1)[1]')
            assert 'required' in prompt and 'review' in prompt
            assert ('without interrupting current work' in prompt)==active
            assert ('Delegate' in prompt)==active
            assert await page.evaluate('sent.at(-1)[3]')=='steer'
        assert not blocked,blocked
        assert not errors,errors
        await browser.close()
        print('PASS real creator defaults/overrides, legacy guard pinning, independent controls, NOTE/progress preservation and explicit idle/busy nudges')

asyncio.run(main())
