"""Board release labels: filter, ready-to-release summary, card chip and drawer field, with a stubbed socket."""
import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults
from fs_url import fs_path
from host_isolation import chrome_executable

install_navigation_defaults()
ROOT = Path(__file__).resolve().parents[2]
PORT = os.environ.get('ARCO_CLIENT_PORT', '5245')
ORIGIN = 'http://127.0.0.1:' + PORT
HTML = '''<!doctype html><html><body><main id="fixture"></main><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true; window.ready = true;
</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page()
        errors, unexpected, diffs = [], [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        async def route_request(route):
            u = urlparse(route.request.url)
            if u.netloc == '127.0.0.1:' + PORT and u.path == '/fixture':
                await route.fulfill(status=200, content_type='text/html', body=HTML); return
            if u.netloc == '127.0.0.1:' + PORT and u.path == '/api/clusters/c1/peer/task-show':
                await route.fulfill(json={'task':{'id':'b','title':'Task b','status':'done','release':'0.1.4','links':[],'notes':'','priority':0,'parentIds':[],'createdAt':1,'updatedAt':1},'runs':[],'comments':[]}); return
            if u.netloc == '127.0.0.1:' + PORT and u.path == '/api/outputs':
                await route.fulfill(json={'outputs':[]}); return
            if u.netloc == '127.0.0.1:' + PORT and u.path == '/api/workflows/diff':
                diffs.append(parse_qs(u.query))
                await route.fulfill(json={'patch':'','isRepo':True,'from':'fixture','to':'fixture'}); return
            if u.netloc == '127.0.0.1:' + PORT and (u.path.startswith(('/@react-refresh','/@vite/','/@id/','/node_modules/.vite/deps/','/src/')) or (u.path.startswith('/@fs/') and fs_path(u.path).resolve().is_relative_to(ROOT))):
                await route.continue_(); return
            unexpected.append(u.path); await route.abort()
        await page.route('**/*', route_request)
        await page.route_web_socket('**/*', lambda ws: None)
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.ready === true')
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ClusterTaskBoardTab}=await import('/src/components/ClusterTaskBoardTab.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts');
          window.sent=[]; window.s=s;
          const t=(id,status,release)=>({id,title:'Task '+id,status,release,links:[],notes:'',priority:0,parentIds:[],blockedReason:'',reviewRequired:false,goalMode:false,createdAt:1,updatedAt:Date.now()});
          window.setLedger=(tasks)=>s.setState({taskLedger:{'/projects/demo':tasks}});
          s.setState({wsSendRaw:m=>sent.push(m)});
          setLedger([t('a','done','0.1.4'),t('b','review','0.1.4'),t('c','todo','0.1.5'),t('d','todo')]);
          const cluster={clusterId:'c1',cwd:'/projects/demo',createdAt:'',taskBoardMode:'shared',taskBoardAttached:true,members:[{workflowId:'w1',displayName:'Director',status:'idle',role:'Director'}]};
          window.root=createRoot(document.getElementById('fixture'));
          root.render(React.createElement(ClusterTaskBoardTab,{cluster}));
        }''')
        await page.locator('[data-help="cluster.board-automation-toggle"]').click()
        await expect(page.locator('[data-help="cluster.board-dispatch-once"]')).to_be_visible()
        await expect(page.locator('[data-help="cluster.swarm-create"]')).to_be_visible()
        await expect(page.get_by_role('button', name='DRAFT ASSIST', exact=True)).to_have_count(0)
        await expect(page.locator('[data-help="cluster.orchestration-proposals"]')).to_have_count(0)
        done_toggle = page.get_by_role('button', name='SHOW DONE', exact=False)
        if await done_toggle.get_attribute('aria-pressed') == 'false': await done_toggle.click()
        await expect(page.get_by_text('Task a', exact=True)).to_be_visible()
        select = page.get_by_label('Release filter')
        await expect(select).to_be_visible()
        await expect(page.get_by_test_id('card-release')).to_have_count(3)
        await expect(page.get_by_test_id('release-summary')).to_have_count(0)
        await select.select_option('0.1.4')
        await expect(page.get_by_text('Task c', exact=True)).to_have_count(0)
        await expect(page.get_by_text('Task d', exact=True)).to_have_count(0)
        await expect(page.get_by_test_id('release-summary')).to_have_text('0.1.4: 2 IN, 1 ACCEPTED, 1 LEFT')
        await select.select_option(label='NO RELEASE')
        await expect(page.get_by_text('Task d', exact=True)).to_be_visible()
        await expect(page.get_by_text('Task a', exact=True)).to_have_count(0)
        await select.select_option('0.1.4')
        # Accepting the last open task reads READY TO RELEASE.
        await page.evaluate("setLedger([{...s.getState().taskLedger['/projects/demo'][0]},{...s.getState().taskLedger['/projects/demo'][1],status:'done'},...s.getState().taskLedger['/projects/demo'].slice(2)])")
        await expect(page.get_by_test_id('release-summary')).to_contain_text('2 IN, 2 ACCEPTED, 0 LEFT - READY TO RELEASE')
        # B147: resetting a release-only edit restores its original value.
        await page.get_by_text('Task b', exact=True).click()
        release = page.locator('input[data-help="cluster.task-release"]')
        await release.fill('next-release')
        await page.get_by_role('button', name='RESET', exact=True).click()
        await expect(release).to_have_value('0.1.4')
        await expect(page.get_by_role('button', name='SAVE', exact=True)).to_be_disabled()
        await page.get_by_role('button', name='CLOSE', exact=True).click()
        # A board without any labels shows no release controls.
        await page.evaluate("setLedger(s.getState().taskLedger['/projects/demo'].map(({release, ...rest}) => rest))")
        await expect(page.get_by_label('Release filter')).to_have_count(0)
        await expect(page.get_by_test_id('card-release')).to_have_count(0)
        assert not errors, errors
        assert not unexpected, unexpected
        await browser.close()
        print('PASS: release filter, ready-to-release summary, card chip, unlabeled board unchanged')

asyncio.run(main())
