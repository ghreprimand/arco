"""Worker notification links focus open tabs and handle closed tabs."""
import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from fs_url import fs_path

PORT = os.environ.get('ARCO_CLIENT_PORT', '5203')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><body><div id="fixture"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1200, 'height': 900})
        errors, blocked = [], []
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                if url.path == '/fixture':
                    await route.fulfill(content_type='text/html', body=HTML); return
                local = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if route.request.method == 'GET' and (local or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/'))):
                    await route.continue_(); return
            blocked.append(url.path); await route.abort()
        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true')
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {NotificationToasts}=await import('/src/components/NotificationToasts.tsx');
          const {NotificationCenter}=await import('/src/components/NotificationCenter.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts'); window.s=s;
          const {useNotificationStore:n}=await import('/src/stores/notificationStore.ts'); window.n=n;
          const {handleServerMessage}=await import('/src/ws/handleServerMessage.ts');
          window.error=(id,message)=>handleServerMessage({type:'error',workflowId:id,message},{wsRef:{current:null},scheduleReconnect:()=>{}});
          const job=id=>({id,config:{name:id,primaryProvider:'codex'},messages:[],workers:{},reviews:[],research:[],handoffs:[]});
          s.setState({jobs:{one:job('one'),member:job('member'),lead:job('lead')},clusters:{c1:{clusterId:'c1',members:[{workflowId:'lead',role:'director'},{workflowId:'member',role:'builder'}]}},activeJobId:'one',activeClusterId:null,clusterFocusedMember:{},showHome:false,showCreator:false});
          createRoot(document.getElementById('fixture')).render(React.createElement(React.Fragment,null,React.createElement(NotificationToasts),React.createElement(NotificationCenter,{onSetMutes:()=>{}})));
        }''')
        await page.evaluate("window.error('member','Member error')")
        await expect(page.get_by_test_id('toast-go-to-director')).to_have_count(0)
        await page.get_by_role('button', name='Member error').click()
        await page.wait_for_function("s.getState().activeClusterId === 'c1' && s.getState().clusterFocusedMember.c1 === 'member'")
        await page.evaluate("window.error('one','Single error')")
        await page.get_by_role('button', name='Single error').click()
        assert await page.evaluate("s.getState().activeJobId === 'one' && s.getState().activeClusterId === null")
        await page.evaluate("n.getState().pushNotice({id:'bell-1',category:'attention',severity:'info',title:'Member notice',ts:Date.now(),workflowId:'member'})")
        await page.get_by_role('button', name='BELL', exact=False).click()
        await page.get_by_role('button', name='Member notice').click()
        await page.wait_for_function("s.getState().activeClusterId === 'c1' && s.getState().clusterFocusedMember.c1 === 'member'")
        await expect(page.get_by_text('SHOW IN BELL')).to_have_count(0)
        await page.evaluate("s.setState({clusters:{},jobs:{one:s.getState().jobs.one},activeJobId:'one',activeClusterId:null}); window.error('gone','Closed error')")
        await page.get_by_role('button', name='Closed error').click()
        await expect(page.get_by_text('That tab is no longer open.')).to_be_visible()
        assert await page.evaluate("s.getState().activeJobId === 'one' && s.getState().activeClusterId === null")
        await page.evaluate("n.getState().pushNotice({id:'bell-closed',category:'attention',severity:'info',title:'Closed notice',ts:Date.now(),workflowId:'gone'})")
        await page.get_by_role('button', name='BELL', exact=False).click()
        await page.get_by_role('button', name='Closed notice').click()
        await expect(page.get_by_text('That tab is no longer open.')).to_have_count(2)
        await expect(page.get_by_text('SHOW IN BELL')).to_have_count(0)
        assert await page.evaluate("s.getState().activeJobId === 'one' && s.getState().activeClusterId === null")
        assert not errors, errors
        assert set(blocked) <= {'/api/update-manager', '/api/update-check'}, blocked
        await browser.close()
        print('PASS: error and BELL notices open worker tabs; closed tab reports its absence')

asyncio.run(main())
