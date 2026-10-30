"""Verify allowance attribution and late-result fencing with inert browser fixtures."""
import asyncio
import json
import os
import time
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect

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
        body.update(available=False, stale=True, freshness='stale', error='fixture allowance request failed')
    return body

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1200, 'height': 850})
        blocked, errors, requests = [], [], []
        mode = 'cli'
        started, release = asyncio.Event(), asyncio.Event()

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
                    body = snapshot('native' if selected == 'delayed' else selected)
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
        dot = page.get_by_role('link', name='C usage page', exact=True)
        await dot.hover()
        tooltip = page.get_by_role('tooltip')
        await page.get_by_role('button', name='CHECK ALLOWANCE NOW', exact=True).click()
        await expect(tooltip).to_contain_text('Allowance source: CLI OAuth credentials')
        await expect(tooltip).to_contain_text('Allowance account: unknown')
        await expect(tooltip).to_contain_text('does not establish Native account identity')
        assert await page.evaluate('store.getState().usage.session.utilization') == 55

        mode = 'stale'
        await page.get_by_role('button', name='CHECK ALLOWANCE NOW', exact=True).click()
        await expect(tooltip).to_contain_text('Showing an older allowance snapshot')
        await expect(tooltip).to_contain_text('Allowance meter: unavailable')
        await expect(tooltip).to_contain_text('55%')

        mode = 'delayed'
        await page.evaluate('() => { window.pendingAllowance=readAllowance(); }')
        await asyncio.wait_for(started.wait(), timeout=5)
        mode = 'cli'
        await page.get_by_role('button', name='CHECK ALLOWANCE NOW', exact=True).click()
        await expect(tooltip).to_contain_text('Allowance source: CLI OAuth credentials')
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
        assert requests == ['force=1', 'force=1', '', 'force=1'], requests
        assert not blocked, blocked
        assert not errors, errors
        print('PASS allowance source/unknown account/fallback, stale snapshot, explicit refresh, late response, reauth invalidation and preserved work', flush=True)
        await browser.close()

asyncio.run(main())
