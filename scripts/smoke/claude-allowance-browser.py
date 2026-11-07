"""Verify usage limits attribution, minimal dropdown and late-result fencing with inert browser fixtures."""
import asyncio
import json
import os
import time
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults
from host_isolation import chrome_executable

install_navigation_defaults()

PORT = os.environ.get('ARCO_CLIENT_PORT', '5203')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
def vite_path(path):
    return '/@fs/' + path.resolve().as_posix().lstrip('/')
VITE_ENV = vite_path(ROOT / 'node_modules/vite/dist/client/env.mjs')
SHARED = vite_path(ROOT / 'shared') + '/'
HTML = '''<!doctype html><html><body><div id="fixture" style="display:flex;justify-content:flex-end;padding:20px"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;
window.__vite_plugin_react_preamble_installed__=true;window.fixtureReady=true;</script></body></html>'''

def snapshot(mode):
    native = {'source': 'claude-native', 'storeId': 'claude.native', 'revision': 'native-alpha'}
    cli = {'source': 'claude-cli', 'storeId': 'claude-cli-default', 'revision': 'cli-beta'}
    source = 'claude-native' if mode == 'native' else 'claude-cli'
    stamp = int(time.time() * 1000)
    body = {'session': {'utilization': 20 if mode == 'native' else 55, 'resetsAt': None}, 'weekly': None, 'subscriptionType': None,
            'source': source, 'binding': native if mode == 'native' else cli, 'credentialContext': {'native': native, 'cli': cli},
            'identity': {'state': 'unknown'}, 'available': True, 'freshness': 'fresh', 'stale': False,
            'fetchedAt': stamp, 'checkedAt': stamp, 'fallback': mode != 'native'}
    if mode == 'stale':
        body.update(available=False, stale=True, freshness='stale', error='fixture usage request failed')
    return body

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page(viewport={'width': 1200, 'height': 850})
        blocked, errors, requests = [], [], []
        mode = 'cli'
        started, release = asyncio.Event(), asyncio.Event()
        manual_started, manual_release = asyncio.Event(), asyncio.Event()

        async def isolate(route):
            nonlocal mode
            url = urlparse(route.request.url)
            path = unquote(url.path)
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                if path == '/fixture':
                    await route.fulfill(status=200, content_type='text/html', body=HTML)
                    return
                if path == '/api/usage' and route.request.method == 'GET':
                    selected = mode
                    requests.append(url.query)
                    body = snapshot('native' if selected == 'delayed' else 'cli' if selected == 'manual_hold' else selected)
                    if selected == 'manual_hold':
                        manual_started.set()
                        await manual_release.wait()
                    if selected == 'delayed':
                        started.set()
                        await release.wait()
                    await route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
                    return
                if path == VITE_ENV or path.startswith(SHARED) or path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/')):
                    await route.continue_()
                    return
            blocked.append(route.request.url)
            await route.abort()

        # Routes and WebSocket denial precede navigation and all source imports.
        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true')
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {UsageBar}=await import('/src/components/UsageBar.tsx');
          const {HeaderAuthChip}=await import('/src/components/HeaderAuthChip.tsx');
          const {useAppStore}=await import('/src/stores/appStore.ts');
          const {refreshClaudeAllowance}=await import('/src/utils/claudeAllowance.ts');
          const native={source:'claude-native',storeId:'claude.native',revision:'native-alpha'};
          const cli={source:'claude-cli',storeId:'claude-cli-default',revision:'cli-beta'};
          const claude={loggedIn:true,native:{state:'present',execution:'unverified',credentialsPresent:true,checkedAt:Date.now(),binding:native},cli:{loggedIn:true,checkedAt:Date.now(),binding:cli}};
          const auth=Object.fromEntries(['claude','codex','cursor','ollama','github','llamacpp','lmstudio','strata','deepseek'].map(id=>[id,id==='claude'?claude:{loggedIn:false}]));
          useAppStore.setState({jobs:{},activeJobId:null,authStatus:auth,usage:null,settings:{claude:{transport:'native'},enabledProviders:{claude:true,codex:false,cursor:false,ollama:false}}});
          useAppStore.getState().createJob('fixture',{name:'Saved work',workingDirectory:'/projects/fixture',primaryProvider:'claude',primaryModel:'fixture',primaryEffort:'low',claudeTransport:'native',skipPermissions:false});
          window.store=useAppStore;window.savedAuth=JSON.stringify(auth);window.savedJob=JSON.stringify(useAppStore.getState().jobs.fixture);
          window.readAllowance=async()=>{const value=await refreshClaudeAllowance();if(value)useAppStore.getState().setUsage(value);};
          function Surface(){const value=useAppStore(s=>s.usage);return React.createElement(React.Fragment,null,React.createElement(HeaderAuthChip),React.createElement(UsageBar,{usage:value}));}
          createRoot(document.getElementById('fixture')).render(React.createElement(Surface));
        }''')
        dot = page.get_by_role('link', name='Claude usage page', exact=True)
        await dot.hover()
        tooltip = page.get_by_role('tooltip')
        mode = 'manual_hold'
        await page.get_by_role('button', name='Refresh Claude usage limits', exact=True).click()
        await asyncio.wait_for(manual_started.wait(), timeout=5)
        checking = page.get_by_role('button', name='Refresh Claude usage limits', exact=True)
        await expect(checking).to_be_focused()
        await expect(checking).to_have_attribute('aria-disabled', 'true')
        await page.mouse.move(0, 0)
        await expect(tooltip).to_be_visible()
        await checking.press('Enter')
        assert len(requests) == 1, requests
        manual_release.set()
        await expect(tooltip).to_contain_text('55%')
        await expect(page.get_by_role('button', name='Refresh Claude usage limits', exact=True)).to_be_focused()
        mode = 'cli'
        await expect(tooltip).not_to_contain_text('Allowance')
        await expect(tooltip).not_to_contain_text('Native:')
        await expect(tooltip).not_to_contain_text('CHECK')
        assert await page.evaluate('store.getState().usage.session.utilization') == 55
        # Minimal dropdown: title, bars with percent, one refresh icon; fits at 100% and at a narrow width.
        await expect(tooltip).to_contain_text('Claude')
        await expect(tooltip).to_contain_text('Session')
        await expect(tooltip).to_contain_text('55%')
        assert await tooltip.get_by_role('button').count() == 1
        for width in (1280, 360):
            await page.set_viewport_size({'width': width, 'height': 700})
            await dot.hover()
            box = await tooltip.bounding_box()
            assert box and box['x'] >= 0 and box['x'] + box['width'] <= width + 1, (width, box)
        await page.set_viewport_size({'width': 1280, 'height': 700})
        await dot.hover()

        mode = 'stale'
        refresh = page.get_by_role('button', name='Refresh Claude usage limits', exact=True)
        before = len(requests)
        await refresh.click()
        for _ in range(50):
            if len(requests) > before: break
            await asyncio.sleep(0.1)
        assert len(requests) > before, requests
        await expect(refresh).not_to_have_attribute('aria-disabled', 'true')
        await expect(tooltip).to_contain_text('55%')
        await expect(tooltip).not_to_contain_text('older')

        mode = 'delayed'
        await page.evaluate('() => { window.pendingAllowance=readAllowance(); }')
        await asyncio.wait_for(started.wait(), timeout=5)
        mode = 'cli'
        await page.get_by_role('button', name='Refresh Claude usage limits', exact=True).click()
        await expect(tooltip).to_contain_text('55%')
        release.set()
        await page.evaluate('window.pendingAllowance')
        assert await page.evaluate('store.getState().usage.source') == 'claude-cli'
        assert await page.evaluate('store.getState().usage.session.utilization') == 55

        await page.evaluate('''() => {
          const auth=structuredClone(store.getState().authStatus);
          auth.claude.native.binding.revision='native-new';auth.claude.native.checkedAt=Date.now()+1;
          store.getState().setAuthStatus(auth);
        }''')
        assert await page.evaluate('store.getState().usage') is None
        assert await page.evaluate('JSON.stringify(store.getState().jobs.fixture)===savedJob')
        assert await page.locator('button[title*="credentials need attention"]').count() == 0
        await page.mouse.move(0, 0)
        await page.evaluate('document.activeElement.blur()')
        await expect(tooltip).to_have_count(0)
        await dot.focus()
        await expect(tooltip).to_be_visible()
        await page.keyboard.press('Tab')
        await expect(page.get_by_role('button', name='Refresh Claude usage limits', exact=True)).to_be_focused()
        await page.keyboard.press('Tab')
        await expect(tooltip).to_have_count(0)
        await dot.hover()
        await expect(tooltip).to_be_visible()
        await page.mouse.move(0, 0)
        await expect(tooltip).to_have_count(0)
        assert requests == ['force=1', 'force=1', '', 'force=1'], requests
        assert not blocked, blocked
        assert not errors, errors
        print('PASS allowance source/unknown account/fallback, stale snapshot, explicit refresh, late response, reauth invalidation and preserved work', flush=True)
        await browser.close()

asyncio.run(main())
