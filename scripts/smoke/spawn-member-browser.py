"""SPAWN FROM HERE into a cluster: member identity fields, defaults, director fence, outside-cluster spawn unchanged."""
import asyncio
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path, fs_url

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
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1300, 'height': 1100})
        blocked, errors = [], []
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'https' and url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(status=200, content_type='text/css', body='')
                return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and route.request.method == 'GET':
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
          const {SpawnDialog} = await import('/src/components/SpawnDialog.tsx');
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          const {handleServerMessage:receive} = await import('/src/ws/handleServerMessage.ts');
          const DIRECTOR = "Director role. Delegate via peer_send, never Task; don't write code; verify claims; plan = rules + tasks; you land.";
          window.s = s; window.confirmed = [];
          s.setState({connected:true, settings:{enabledProviders:{}}, authStatus:{claude:{loggedIn:true},codex:{loggedIn:true}}});
          window.snapshot = (withDirector) => receive({type:'cluster_state',clusterId:'cl-1',state:{clusterId:'cl-1',cwd:'/projects/fixture',createdAt:'',taskBoardMode:'none',taskBoardAttached:false,mailboxDepth:{},members:[
            {workflowId:'w1',displayName:'Director',status:'idle',role:withDirector?DIRECTOR:'Builder role'},
            {workflowId:'w2',displayName:'Builder #1',status:'idle',role:'Implementer role. Focus on your assigned scope. Use peer_send to report progress + blockers, not to direct peers.'}],idleNudgerEnabled:false}},{wsRef:{current:null},scheduleReconnect:()=>{}});
          const parent = {name:'Builder #1',workingDirectory:'/projects/fixture',primaryProvider:undefined,primaryModel:'sonnet',primaryEffort:'low',skipPermissions:false,claudeTransport:'native'};
          const root = createRoot(document.getElementById('fixture'));
          window.show = (cluster, direction) => root.render(React.createElement(SpawnDialog,{key:(window.k=(window.k||0)+1),parentConfig:parent, initialDirection:direction||'', clusterContext: cluster?{clusterId:'cl-1',name:'Fixture cluster'}:undefined, onConfirm:(...a)=>window.confirmed.push(a), onCancel:()=>{}}));
          snapshot(true);
        }''')
        # Outside a cluster: no identity fields, today's default name, no identity sent.
        await page.evaluate("show(false)")
        await expect(page.get_by_label('Spawn name')).to_have_value('Builder #1 (spawn)')
        await expect(page.get_by_test_id('spawn-member-identity')).to_have_count(0)
        await page.get_by_role('button', name='SPAWN', exact=True).click()
        c = await page.evaluate('confirmed')
        assert len(c) == 1 and c[0][3] is None and c[0][4] is None, c

        # In a cluster with a director: fields show, director disabled, name is not "<source> (spawn)".
        await page.evaluate("confirmed.length = 0; show(true, 'Review the migration plan\\nsecond line')")
        ident = page.get_by_test_id('spawn-member-identity')
        await expect(ident).to_be_visible()
        name = page.get_by_label('Spawn name')
        await expect(name).to_have_value('Worker #1')
        assert '(spawn)' not in await name.input_value()
        await expect(ident.get_by_role('button', name='DIRECTOR', exact=True)).to_be_disabled()
        await expect(page.get_by_label('Spawn focus')).to_have_value('Review the migration plan')
        await ident.get_by_role('button', name='TESTER', exact=True).click()
        await expect(name).to_have_value('Tester #1')
        await ident.get_by_role('button', name='HEAVY', exact=True).click()
        await ident.get_by_role('button', name='BLIND', exact=True).click()
        await page.get_by_label('Spawn focus').fill('browser suites')
        await page.get_by_role('button', name='SPAWN', exact=True).click()
        c = await page.evaluate('confirmed')
        assert len(c) == 1, c
        cfg, direction, _plan, join, identity = c[0]
        assert cfg['name'] == 'Tester #1' and join == 'cl-1', c
        assert identity['tier'] == 'heavy' and identity['accessMode'] == 'blind' and identity['focus'] == 'browser suites', identity
        assert identity['role'].startswith('Tester role'), identity

        # Custom director text is refused while a director exists; allowed when none does.
        await page.evaluate("confirmed.length = 0; show(true, '')")
        custom_role = page.get_by_label('Spawn custom role')
        await custom_role.click()
        await page.keyboard.press('ControlOrMeta+A')
        await page.keyboard.type('Director role. Own outcome')
        await expect(page.get_by_text('at most one director', exact=False)).to_be_visible()
        await page.get_by_role('button', name='SPAWN', exact=True).click()
        assert await page.evaluate('confirmed.length') == 0
        await page.evaluate("snapshot(false); confirmed.length = 0; show(true, '')")
        await expect(page.get_by_test_id('spawn-member-identity').get_by_role('button', name='DIRECTOR', exact=True)).to_be_enabled()

        # A typed name sticks; Isolated is Claude-only and forces the native transport.
        await page.get_by_label('Spawn name').fill('Scout')
        await page.get_by_test_id('spawn-member-identity').get_by_role('button', name='ISOLATED', exact=True).click()
        await page.get_by_role('button', name='SPAWN', exact=True).click()
        c = await page.evaluate('confirmed')
        assert c[0][0]['name'] == 'Scout' and c[0][0]['claudeTransport'] == 'native' and c[0][4]['accessMode'] == 'isolated', c
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: spawn into cluster shows identity fields, never copies the source role, fences a second director, defaults name and focus, keeps outside-cluster spawn unchanged')

asyncio.run(main())
