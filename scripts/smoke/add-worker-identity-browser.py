"""ADD FRESH name and role: request payload and the resulting member card."""
import asyncio
import os
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path, fs_url
from host_isolation import chrome_executable

PORT = os.environ.get('ARCO_CLIENT_PORT', '5203')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/styles/matrix.css"><link rel="stylesheet" href="/src/themes/phosphor/phosphor.css"></head><body><div id="fixture"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page(viewport={'width': 1500, 'height': 900})
        # This suite checks controls in the Standard layout; layout-ranges-browser.py covers the other layouts.
        await page.add_init_script("localStorage.setItem('arco.layoutMode', 'standard')")
        blocked, errors = [], []
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'https' and url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(status=200, content_type='text/css', body='')
                return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and route.request.method == 'GET':
                if url.path == '/api/cluster-snapshots':
                    # MEMBERS resolves saved folders through the server, even for an empty list.
                    assert parse_qs(url.query) == {'cwd': ['/projects/fixture']}, url.query
                    await route.fulfill(json={'snapshots': []})
                    return
                if url.path == '/api/outputs':
                    await route.fulfill(json={'outputs':[]})
                    return
                if url.path == '/api/public-project/choice':
                    await route.fulfill(json={'choice': None})
                    return
                if url.path == '/api/public-project/remote':
                    await route.fulfill(json={'state':'none'})
                    return
                if url.path == '/api/public-project/state':
                    await route.fulfill(json={'isGit':False,'hasState':False,'tracked':0,'trackedSample':[],'ignored':True,'ignoreFile':'default'})
                    return
                if url.path == '/api/project-trust':
                    await route.fulfill(json={'trusted':False})
                    return
                if url.path == '/fixture':
                    await route.fulfill(status=200, content_type='text/html', body=HTML)
                    return
                is_local_fs = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if is_local_fs or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/', '/phosphor-demo/', '/themes/victor-mono/')):
                    await route.continue_()
                    return
            blocked.append(url.path)
            await route.abort()
        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true', timeout=10000)
        await page.evaluate('''async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ClusterTab} = await import('/src/components/ClusterTab.tsx');
          const {applyTheme} = await import('/src/themes/apply.ts');
          const {getTheme} = await import('/src/themes/registry.ts');
          window.setFixtureTheme = id => applyTheme(getTheme(id));
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          const {handleServerMessage:receive} = await import('/src/ws/handleServerMessage.ts');
          window.sent=[]; window.fresh=[]; window.s=s;
          const member=(id,name,status)=>({workflowId:id,displayName:name,status});
          window.members=[member('worker-a','Alpha','idle'),member('worker-b','Beta','busy')];
          for (const id of ['worker-a','worker-b','worker-c']) s.getState().createJob(id,{name:id,workingDirectory:'/projects/fixture',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',skipPermissions:false});
          window.snapshot=(id,depth,members=window.members,enabled=false)=>receive({type:'cluster_state',clusterId:id,state:{clusterId:id,cwd:'/projects/fixture',createdAt:'',taskBoardMode:'none',taskBoardAttached:false,mailboxDepth:depth,members,idleNudgerEnabled:enabled}},{wsRef:{current:null},scheduleReconnect:()=>{}});
          const root=createRoot(document.getElementById('fixture'));
          window.show=id=>root.render(React.createElement('div',{style:{display:'flex',width:'100%',height:'850px'}},React.createElement(ClusterTab,{clusterId:id,onSendToMember:(...args)=>{sent.push(args);return true},onCancelMember:()=>{},onCancelQueuedForMember:()=>{},onUpload:async()=>null,onAddFreshWorkers:(...args)=>fresh.push(args)})));
          snapshot('cluster-a',{}); show('cluster-a');
        }''')
        cards=page.locator('[data-help="cluster.member-card"]')
        await expect(cards).to_have_count(2)
        await page.get_by_role('button', name='MEMBERS', exact=True).first.click()
        await page.locator('[data-help="cluster.add-fresh"]').click()
        name=page.get_by_test_id('add-fresh-name')
        custom=page.get_by_test_id('add-fresh-role-custom')
        await expect(name).to_be_visible()
        await expect(page.get_by_test_id('add-fresh-role-director')).to_be_enabled()
        await name.fill('  Scout  ')
        await page.get_by_test_id('add-fresh-role-builder').click()
        spawn=page.get_by_role('button', name='SPAWN', exact=True)
        await spawn.click()
        calls=await page.evaluate('fresh.map(c=>[c[0],c[1],c[2]])')
        assert len(calls)==1 and calls[0][0]=='cluster-a' and calls[0][1]==1, calls
        assert calls[0][2]['name']=='Scout', calls
        assert calls[0][2]['role'].startswith('Implementer role'), calls
        # The server answers with the new member; the card shows name and role.
        await page.evaluate("snapshot('cluster-a', {}, [...members, {workflowId:'worker-c',displayName:'Scout',status:'idle',role:'Implementer role. Finish assigned work and routine compatible choices; send one blocker or final evidence via peer_send.'}])")
        await expect(cards).to_have_count(3)
        scout=cards.filter(has_text='Scout')
        await expect(scout).to_have_count(1)
        await expect(scout.get_by_text('BUILDER', exact=True)).to_be_visible()
        # Repeated named batches send the same base for server-side numbering.
        for _ in range(2):
            await page.locator('[data-help="cluster.add-fresh"]').click()
            await name.fill('Scout')
            await page.locator('input[data-help="cluster.fresh.count"]').fill('2')
            await spawn.click()
            last=await page.evaluate('fresh.at(-1).slice(1)')
            assert last[0]==2 and last[1].get('name')=='Scout' and 'role' not in last[1], last
        # Custom role, several workers, no name: no name is sent.
        await page.locator('[data-help="cluster.add-fresh"]').click()
        await custom.fill('Migration reviewer')
        await page.locator('input[data-help="cluster.fresh.count"]').fill('2')
        await spawn.click()
        last=await page.evaluate('fresh.at(-1).slice(1)')
        assert last[0]==2 and last[1].get('role')=='Migration reviewer' and 'name' not in last[1], last
        # An existing director disables the DIRECTOR preset.
        await page.evaluate("snapshot('cluster-a', {}, [{...members[0], role:'Director role. Delegate via peer_send, never Task; don\\'t write code; verify claims; plan = rules + tasks; you land.'}, members[1]])")
        await page.locator('[data-help="cluster.add-fresh"]').click()
        await expect(page.get_by_test_id('add-fresh-role-director')).to_be_disabled()
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: ADD FRESH sends name and role; member card shows both; director preset gated')

asyncio.run(main())
