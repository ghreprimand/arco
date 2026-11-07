"""Fixture-only summarize-on-tab-close: checked closes request one Recall summary, unchecked closes none."""
import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from fs_url import fs_path
from host_isolation import chrome_executable
PORT = os.environ.get('ARCO_CLIENT_PORT', '5227')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"></head><body><div id="fixture"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page(viewport={'width': 1100, 'height': 700})
        errors, blocked = [], []
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                if url.path == '/fixture': await route.fulfill(content_type='text/html', body=HTML); return
                local = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if route.request.method == 'GET' and (local or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/'))): await route.continue_(); return
            blocked.append(url.path); await route.abort()
        await page.route('**/*', isolate); await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await page.goto(ORIGIN + '/fixture'); await page.wait_for_function('window.fixtureReady === true')
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {TabBar}=await import('/src/components/TabBar.tsx');
          const {NotificationToasts}=await import('/src/components/NotificationToasts.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts'); window.s=s;
          const {useRecallStore:r}=await import('/src/stores/recallStore.ts'); window.r=r;
          const cfg=(name,extra={})=>({name,primaryProvider:'codex',primaryModel:'gpt-6-luna',primaryEffort:'low',...extra});
          const job=(id,name,messages,extra)=>({id,currentSessionId:id,config:cfg(name,extra),messages,workers:{},reviews:[],research:[],handoffs:[]});
          const user=[{id:'m1',role:'user',content:'hi',isStreaming:false,timestamp:1}];
          s.setState({settings:{enabledProviders:{codex:true}},jobs:{
            a:job('a','Alpha',user), b:job('b','Beta',user), c:job('c','Gamma',user,{incognito:true}), d:job('d','Delta',[]), e:job('e','Epsilon',user),
          }});
          window.removed=[]; window.requested=[];
          window.sendOk=true;
          const bar=React.createElement(TabBar,{
            onRemoveWorkflow:(id)=>window.removed.push(id),
            requestRecallSummary:(wfid,summarizer)=>{window.requested.push({wfid,summarizer}); return window.sendOk;},
            onCreateCluster:()=>{},onDeleteCluster:()=>{},onAddClusterMember:()=>{},onCreateClusterWithFreshWorkers:()=>{},
          });
          createRoot(document.getElementById('fixture')).render(React.createElement(React.Fragment,null,bar,React.createElement(NotificationToasts)));
        }''')
        close = lambda name: page.get_by_label('Close ' + name).click()
        # Unchecked: closing starts nothing.
        assert await page.evaluate('r.getState().summarizeOnClose') is False
        await close('Alpha'); await expect(page.get_by_label('Close Alpha')).to_have_count(0)
        assert await page.evaluate('window.removed') == ['a'] and await page.evaluate('window.requested') == []
        # Checked: a saved session starts exactly one summary, with the tab's own summarizer.
        await page.evaluate('r.getState().setSummarizeOnClose(true)')
        await close('Beta')
        assert await page.evaluate('window.removed') == ['a', 'b']
        requested = await page.evaluate('window.requested')
        assert len(requested) == 1 and requested[0]['wfid'] == 'b', requested
        assert {k: v for k, v in requested[0]['summarizer'].items() if v is not None} == {'provider': 'codex', 'model': 'gpt-6-luna', 'effort': 'low'}, requested
        await expect(page.get_by_text('Summarizing Beta in Recall')).to_be_visible()
        await expect(page.get_by_test_id('toast-open-recall')).to_be_visible()
        await page.get_by_test_id('toast-open-recall').click()
        assert await page.evaluate('s.getState().showRecall') is True
        # Incognito and session-less tabs do nothing, but still close.
        await close('Gamma'); await close('Delta')
        assert await page.evaluate('window.removed') == ['a', 'b', 'c', 'd']
        assert len(await page.evaluate('window.requested')) == 1
        # A failed send shows a toast and the tab still closes.
        await page.evaluate('window.sendOk=false')
        await close('Epsilon')
        assert await page.evaluate('window.removed') == ['a', 'b', 'c', 'd', 'e']
        await expect(page.get_by_text('Could not summarize Epsilon')).to_be_visible()
        assert not errors, errors
        assert set(blocked) <= {'/api/update-manager', '/api/update-check'}, blocked
        await browser.close()
        print('PASS: unchecked close requests nothing; checked close requests one summary with a toast and link; Incognito and empty tabs do nothing; a failed send only toasts')

asyncio.run(main())
