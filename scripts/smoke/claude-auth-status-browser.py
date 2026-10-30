"""Render real Claude status surfaces with synthetic auth and blocked host traffic."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect

PORT = os.environ.get('ARCO_CLIENT_PORT', '5203')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
VITE_ENV = '/@fs' + str((ROOT / 'node_modules/vite/dist/client/env.mjs').resolve())
HTML = '''<!doctype html><html><body><div id="fixture"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1200, 'height': 800})
        blocked, requests, errors = [], [], []

        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                if url.path == '/fixture':
                    await route.fulfill(status=200, content_type='text/html', body=HTML)
                    return
                if url.path == '/api/auth-login' and url.query == 'provider=claude' and route.request.method == 'POST':
                    requests.append('cli-login')
                    await route.fulfill(status=200, content_type='application/json', body=json.dumps({'started': False, 'command': 'claude auth login --claudeai'}))
                    return
                if url.path == '/api/auth-status':
                    requests.append('status')
                    await route.fulfill(status=200, content_type='application/json', body=await page.evaluate('JSON.stringify(window.authFixture)'))
                    return
                if url.path.startswith('/@fs' + str(ROOT / 'shared') + '/') or url.path == VITE_ENV or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/')):
                    await route.continue_()
                    return
            blocked.append(route.request.url)
            await route.abort()

        # Install routes before loading any application module. No request or
        # WebSocket can reach an operator server, account or provider.
        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true')
        try:
            await page.evaluate('''async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {HeaderAuthChip} = await import('/src/components/HeaderAuthChip.tsx');
          const {UsageBar} = await import('/src/components/UsageBar.tsx');
          const {useAppStore} = await import('/src/stores/appStore.ts');
          const {useStartupStore} = await import('/src/stores/startupStore.ts');
          const root = createRoot(document.getElementById('fixture'));
          window.authStore = useAppStore; window.startupStore = useStartupStore;
          window.setFixture = (native, cli, transport='native', enabled=true, stale=false, forceCli=false) => {
            const present = ['present','refresh-needed','needs-attention'].includes(native);
            const status = {loggedIn:cli || present,
              native:{state:native,credentialsPresent:present,execution:'unverified',checkedAt:Date.now(),binding:{source:'claude-native',storeId:'claude.native'}},
              cli:{loggedIn:cli,checkedAt:Date.now(),binding:{source:'claude-cli',storeId:'claude-cli-default'}}};
            if(stale){status.native.probeFailed=true;status.native.stale=true;status.cli.probeFailed=true;status.cli.stale=true;}
            const auth = Object.fromEntries(['claude','codex','cursor','ollama','github','llamacpp','lmstudio','strata','deepseek'].map(id=>[id,id==='claude'?status:{loggedIn:false}]));
            window.authFixture = auth;
            useAppStore.setState({jobs:{},activeJobId:null,showSettings:false,authStatus:auth,settings:{claude:{transport},enabledProviders:{claude:enabled,codex:false,cursor:false,ollama:false}}});
            useAppStore.getState().createJob('fixture',{name:'Saved fixture',workingDirectory:'/projects/fixture',primaryProvider:'claude',primaryModel:'fixture',primaryEffort:'low',skipPermissions:false,claudeTransport:transport,ultracode:forceCli});
            window.savedConfig = JSON.stringify(useAppStore.getState().jobs.fixture.config);
            root.render(React.createElement(React.Fragment,{key:[native,cli,transport,enabled,stale].join(':')},
              React.createElement(HeaderAuthChip),React.createElement(UsageBar,{usage:{session:{utilization:25,resetsAt:null},weekly:null,subscriptionType:null,fetchedAt:Date.now(),error:'fixture meter unavailable'}})));
          };
          window.setFixture('present',false);
        }''')
        except Exception:
            print('Blocked fixture requests:', blocked, 'errors:', errors, flush=True)
            await browser.close()
            raise
        await expect(page.get_by_role('button', name='[AUTH: CLAUDE NATIVE]', exact=True)).to_have_count(0)
        dot = page.get_by_role('link', name='C usage page', exact=True)
        await expect(dot).to_be_visible()
        await dot.hover()
        await expect(page.get_by_role('tooltip')).to_contain_text('Native: Credentials present; execution unverified')
        await expect(page.get_by_role('tooltip')).to_contain_text('CLI: Signed out')
        await expect(page.get_by_role('tooltip')).to_contain_text('Allowance meter: unavailable')
        assert not requests

        for state in ('missing', 'needs-attention'):
            await page.evaluate('(state)=>setFixture(state,true)', state)
            await page.get_by_role('button', name='[AUTH: CLAUDE NATIVE]', exact=True).click()
            await page.get_by_role('button', name='OPEN NATIVE SIGN-IN SETTINGS', exact=True).click()
            assert await page.evaluate('authStore.getState().showSettings')
            assert await page.evaluate('startupStore.getState().settingsSection') == 'authentication'
            assert not requests

        await page.evaluate("setFixture('present',false,'cli')")
        await page.get_by_role('button', name='[AUTH: CLAUDE CLI]', exact=True).click()
        await page.get_by_role('button', name='SIGN IN TO CLAUDE CLI', exact=True).click()
        await expect(page.get_by_text('claude auth login --claudeai', exact=True)).to_be_visible()
        assert requests == ['cli-login']
        assert await page.evaluate('JSON.stringify(authStore.getState().jobs.fixture.config)===savedConfig')

        await page.evaluate("setFixture('present',false,'native',true,false,true)")
        await expect(page.get_by_role('button', name='[AUTH: CLAUDE CLI]', exact=True)).to_be_visible()
        assert await page.evaluate('JSON.stringify(authStore.getState().jobs.fixture.config)===savedConfig')

        for state, cli in [('present', True), ('unknown', False)]:
            await page.evaluate('([state,cli])=>setFixture(state,cli,"native",true,state==="unknown")', [state, cli])
            await expect(page.locator('button[title*="credentials need attention"]')).to_have_count(0)
        await page.evaluate("setFixture('needs-attention',true,'native',false)")
        await expect(page.locator('#fixture button')).to_have_count(0)
        await expect(page.locator('#fixture a')).to_have_count(0)
        assert await page.evaluate('JSON.stringify(authStore.getState().jobs.fixture.config)===savedConfig')
        assert not errors, errors
        assert not blocked, blocked
        print('PASS Claude Native/CLI status, matching recovery, stale/disabled gating, separate meter and saved transport', flush=True)
        await browser.close()

asyncio.run(main())
