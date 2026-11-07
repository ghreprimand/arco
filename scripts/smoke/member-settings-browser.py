"""ADD FRESH and REPLACE take the full member settings: what each dialog starts from and what it sends."""
import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path
from host_isolation import chrome_executable

PORT = os.environ.get('ARCO_CLIENT_PORT', '5203')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/styles/matrix.css"><link rel="stylesheet" href="/src/themes/phosphor/phosphor.css"></head><body><div id="fixture"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''
DIRECTOR = "Director role. Delegate via peer_send, never Task; don't write code; verify claims; plan = rules + tasks; you land."

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page(viewport={'width': 1500, 'height': 1000})
        # Standard layout: the controls are checked, not the layout.
        await page.add_init_script("localStorage.setItem('arco.layoutMode', 'standard')")
        blocked, errors = [], []
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'https' and url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(status=200, content_type='text/css', body='')
                return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and route.request.method == 'GET':
                if url.path == '/api/outputs':
                    await route.fulfill(json={'outputs': []})
                    return
                if url.path == '/api/public-project/choice':
                    await route.fulfill(json={'choice': None})
                    return
                if url.path == '/api/public-project/remote':
                    await route.fulfill(json={'state': 'none'})
                    return
                if url.path == '/api/public-project/state':
                    await route.fulfill(json={'isGit': False, 'hasState': False, 'tracked': 0, 'trackedSample': [], 'ignored': True, 'ignoreFile': 'default'})
                    return
                if url.path == '/api/project-trust':
                    await route.fulfill(json={'trusted': False})
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
        await page.evaluate('''async (director) => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ClusterTab} = await import('/src/components/ClusterTab.tsx');
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          const {handleServerMessage:receive} = await import('/src/ws/handleServerMessage.ts');
          window.fresh=[]; window.raw=[];
          s.getState().setWsSendRaw((m) => { raw.push(m); return true; });
          // The first member is the ADD FRESH template; the second is replaced.
          s.getState().createJob('lead',{name:'Lead',workingDirectory:'/projects/fixture',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',skipPermissions:false,outputStyle:'lite',efficiencyToolFilter:'conservative'});
          s.getState().createJob('helper',{name:'Helper',workingDirectory:'/projects/fixture',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',skipPermissions:false,fastMode:true,outputStyle:'terse',autoCompaction:{enabled:true,thresholdPercent:70}});
          const members=[{workflowId:'lead',displayName:'Lead',status:'idle',role:director},{workflowId:'helper',displayName:'Helper',status:'idle',role:'Tester',tier:'light',focus:'browser tests'}];
          receive({type:'cluster_state',clusterId:'c1',state:{clusterId:'c1',cwd:'/projects/fixture',createdAt:'',taskBoardMode:'none',taskBoardAttached:false,mailboxDepth:{},members,autoCompaction:{enabled:false,thresholdPercent:80}}},{wsRef:{current:null},scheduleReconnect:()=>{}});
          createRoot(document.getElementById('fixture')).render(React.createElement('div',{style:{display:'flex',width:'100%',height:'950px'}},React.createElement(ClusterTab,{clusterId:'c1',onSendToMember:()=>true,onCancelMember:()=>{},onCancelQueuedForMember:()=>{},onUpload:async()=>null,onAddFreshWorkers:(...args)=>fresh.push(args)})));
        }''', DIRECTOR)
        await page.get_by_role('button', name='MEMBERS', exact=True).first.click()

        # ADD FRESH: tuning starts from the first member, work size, focus and
        # auto-compaction start empty, and the request carries every value.
        await page.locator('[data-help="cluster.add-fresh"]').click()
        settings = page.get_by_test_id('add-fresh-settings')
        await expect(settings).to_be_visible()
        await expect(page.get_by_test_id('add-fresh-compaction')).to_have_value('cluster')
        await expect(page.get_by_test_id('add-fresh-compaction').locator('option[value="cluster"]')).to_have_text('CLUSTER DEFAULT (OFF)')
        await expect(page.get_by_test_id('add-fresh-focus')).to_have_value('')
        await page.get_by_role('button', name='SPAWN', exact=True).click()
        sent = await page.evaluate('fresh.at(-1)[2]')
        # The template tab was saved as 'lite' (before 0.1.5): it reads as PLAIN.
        expected = {'tier': None, 'focus': '', 'outputStyle': 'plain', 'efficiencyToolFilter': 'conservative', 'fastMode': False, 'autoCompaction': None}
        assert {k: sent.get(k, 'missing') for k in expected} == expected, sent
        await page.locator('[data-help="cluster.add-fresh"]').click()
        await page.get_by_test_id('add-fresh-tier-heavy').click()
        await page.get_by_test_id('add-fresh-focus').fill('  database  ')
        await page.get_by_test_id('add-fresh-fast-on').click()
        await page.get_by_test_id('add-fresh-filter-off').click()
        await page.get_by_test_id('add-fresh-style-terse').click()
        await page.get_by_test_id('add-fresh-compaction').select_option('on')
        await page.get_by_role('button', name='SPAWN', exact=True).click()
        sent = await page.evaluate('fresh.at(-1)[2]')
        expected = {'tier': 'heavy', 'focus': 'database', 'outputStyle': 'terse', 'efficiencyToolFilter': 'off', 'fastMode': True, 'autoCompaction': {'enabled': True, 'thresholdPercent': 80}}
        assert {k: sent.get(k, 'missing') for k in expected} == expected, sent
        # Codex hides fast mode and the tool filter and sends them off.
        await page.locator('[data-help="cluster.add-fresh"]').click()
        await page.get_by_test_id('add-fresh-fast-on').click()
        await page.locator('button[data-help="cluster.fresh.provider"]', has_text='CODEX').click()
        await expect(page.get_by_test_id('add-fresh-fast-on')).to_have_count(0)
        await expect(page.get_by_test_id('add-fresh-style-normal')).to_be_visible()
        await page.get_by_role('button', name='SPAWN', exact=True).click()
        sent = await page.evaluate('fresh.at(-1)[2]')
        assert sent['provider'] == 'codex' and sent['fastMode'] is False and sent['efficiencyToolFilter'] == 'off', sent

        # REPLACE: starts from the member it replaces, everything changeable.
        helper_row = page.locator('[data-help="cluster.member-replace"]').nth(1)
        await helper_row.click()
        await expect(page.get_by_test_id('replace-name')).to_have_value('Helper')
        await expect(page.get_by_test_id('replace-focus')).to_have_value('browser tests')
        await expect(page.get_by_test_id('replace-compaction')).to_have_value('on')
        await expect(page.get_by_test_id('replace-role-director')).to_be_disabled()
        confirm = page.locator('[data-help="cluster.replace.confirm"]')
        # Unchanged: the request still carries every value as shown.
        await confirm.click()
        sent = await page.evaluate('raw.at(-1)')
        assert sent['type'] == 'cluster_member_replace' and sent['workflowId'] == 'helper', sent
        expected = {'role': 'Tester', 'tier': 'light', 'focus': 'browser tests', 'outputStyle': 'terse', 'efficiencyToolFilter': 'off', 'fastMode': True, 'autoCompaction': {'enabled': True, 'thresholdPercent': 70}}
        assert {k: sent.get(k, 'missing') for k in expected} == expected, sent
        assert 'name' not in sent and 'provider' not in sent and 'model' not in sent, sent
        # Changed: new name, a preset role, unset work size, cleared focus, other tuning.
        await helper_row.click()
        await page.get_by_test_id('replace-name').fill('Checker')
        await page.get_by_test_id('replace-role-builder').click()
        await page.get_by_test_id('replace-tier-unset').click()
        await page.get_by_test_id('replace-focus').fill('')
        await page.get_by_test_id('replace-fast-off').click()
        await page.get_by_test_id('replace-filter-aggressive').click()
        await page.get_by_test_id('replace-style-normal').click()
        await page.get_by_test_id('replace-compaction').select_option('cluster')
        await confirm.click()
        sent = await page.evaluate('raw.at(-1)')
        expected = {'name': 'Checker', 'tier': None, 'focus': '', 'outputStyle': 'normal', 'efficiencyToolFilter': 'aggressive', 'fastMode': False, 'autoCompaction': None}
        assert {k: sent.get(k, 'missing') for k in expected} == expected, sent
        assert sent['role'].startswith('Implementer role'), sent
        # A custom DIRECTOR role while another member directs keeps REPLACE unavailable.
        await helper_row.click()
        await page.get_by_test_id('replace-role-custom').fill('Director of tests')
        await expect(confirm).to_be_disabled()
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: ADD FRESH and REPLACE start from the right member and send every member setting')

asyncio.run(main())
