"""Verify origin-bound recovery with intercepted auth and no provider traffic."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import unquote, urlparse, parse_qs
from playwright.async_api import async_playwright, expect

PORT = os.environ.get('ARCO_CLIENT_PORT', '5203')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
def vite_path(path):
    return '/@fs/' + path.resolve().as_posix().lstrip('/')
HTML = '''<!doctype html><html><body><div id="notice"></div><hr><div id="settings"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;
window.__vite_plugin_react_preamble_installed__=true;window.fixtureReady=true;</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1100, 'height': 850})
        blocked, errors, requests, login_bodies = [], [], [], []
        binding = {'source': 'claude-native', 'storeId': 'claude.native', 'revision': 'rejected-fixture'}
        native = {'state': 'needs-attention', 'credentialsPresent': True, 'loggedIn': True, 'execution': 'unverified', 'checkedAt': 2000, 'binding': binding}
        flows, counter = {}, 0

        def auth():
            return {'claude': {'loggedIn': True, 'native': native, 'cli': {'loggedIn': False, 'binding': {'source': 'claude-cli', 'storeId': 'claude-cli-default'}, 'bindingCheckedAt': native['checkedAt']}}}

        async def isolate(route):
            nonlocal counter
            url = urlparse(route.request.url)
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                if url.path == '/fixture':
                    await route.fulfill(content_type='text/html', body=HTML)
                    return
                if url.path.startswith('/api/'):
                    requests.append((route.request.method, url.path))
                    data = None
                    if url.path == '/api/auth/claude-native/login':
                        body = route.request.post_data_json or {}
                        login_bodies.append(body)
                        for flow in flows.values():
                            if flow['status'] in ('pending', 'exchanging'):
                                flow['status'] = 'superseded'
                        counter += 1
                        flow = {'id': 'flow-' + str(counter), 'status': 'pending', 'bindingBefore': dict(native['binding']), 'startedAt': 2000, 'expiresAt': 602000}
                        if 'workflowId' in body:
                            flow['workflowId'] = body['workflowId']
                        flows[flow['id']] = flow
                        data = {'flow': flow, 'authorizationUrl': 'https://example.com/authorize', 'manualFallback': False}
                    elif url.path == '/api/auth/claude-native/flow':
                        flow = flows[parse_qs(url.query)['id'][0]]
                        if route.request.method == 'DELETE':
                            flow['status'] = 'cancelled'
                        data = {'flow': flow}
                    elif url.path == '/api/auth/claude-native/callback':
                        flow = flows[route.request.post_data_json['flowId']]
                        native['binding'] = {**binding, 'revision': flow['id'] + '-manual'}
                        native['state'] = 'present'
                        native['checkedAt'] += 1
                        flow.update(status='complete', binding=native['binding'])
                        data = {'ok': True, 'flow': flow}
                    elif url.path == '/api/auth/claude-native':
                        data = native
                    elif url.path == '/api/auth-status':
                        data = auth()
                    elif url.path == '/api/usage':
                        data = {'session': None, 'weekly': None, 'fetchedAt': 2000, 'available': False, 'source': 'unavailable'}
                    if data is not None:
                        await route.fulfill(content_type='application/json', body=json.dumps(data))
                        return
                path = unquote(url.path)
                if path in (vite_path(ROOT / 'node_modules/vite/dist/client/env.mjs'), vite_path(ROOT / 'node_modules/highlight.js/styles/atom-one-dark.css'), vite_path(ROOT / 'node_modules/react-diff-view/style/index.css')) or path.startswith(vite_path(ROOT / 'shared') + '/') or path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/')):
                    await route.continue_()
                    return
            blocked.append(route.request.url)
            await route.abort()

        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('requestfailed', lambda request: print('Fixture resource failed:', request.url[:200], flush=True))
        page.on('console', lambda message: print('Fixture console:', message.text[:500], flush=True) if message.type == 'error' else None)
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true')
        await page.evaluate('''async ({auth,binding}) => {
          window.open = () => null;
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ChatMessage} = await import('/src/components/ChatMessage.tsx');
          const {ClaudeNativeAuthRow} = await import('/src/components/ClaudeNativeAuthRow.tsx');
          const {useAppStore} = await import('/src/stores/appStore.ts');
          const {useDraftStore} = await import('/src/stores/draftStore.ts');
          window.store=useAppStore;window.drafts=useDraftStore;
          useAppStore.setState({jobs:{},activeJobId:null,authStatus:auth,settings:{claude:{transport:'native'}}});
          for(const [id,transport] of [['origin','native'],['other','cli']]) useAppStore.getState().createJob(id,{name:id,workingDirectory:'/projects/fixture',primaryProvider:'claude',primaryModel:'fixture',primaryEffort:'low',skipPermissions:false,claudeTransport:transport});
          useDraftStore.getState().setDraft('origin','Review the partial mutation before sending again.');
          useDraftStore.getState().setDraft('other','Keep this other tab draft.');
          useAppStore.setState({attachments:{origin:[{isImage:false,filename:'fixture.txt',path:'/projects/fixture/fixture.txt'}]}});
          window.savedAttachments=JSON.stringify(useAppStore.getState().attachments);
          window.savedDrafts=JSON.stringify(useDraftStore.getState().drafts);
          window.savedConfigs=JSON.stringify(Object.values(useAppStore.getState().jobs).map(j=>j.config));
          window.sent=[];useAppStore.setState({wsSendRaw:m=>window.sent.push(m)});
          const root=createRoot(document.getElementById('notice'));
          const message=(id,body)=>React.createElement(ChatMessage,{key:id,jobId:'origin',message:{id,role:'system',content:'[AUTH:claude] '+body,isStreaming:false,timestamp:1000,authRecovery:{transport:'native',binding}}});
          root.render(React.createElement(React.Fragment,null,message('one','First rejection'),message('two','Second notice stays separate')));
          const settings=createRoot(document.getElementById('settings'));
          window.showSettings=(key='default')=>settings.render(React.createElement(ClaudeNativeAuthRow,{key}));
        }''', {'auth': auth(), 'binding': binding})
        notice = page.locator('#notice')
        await notice.get_by_role('button', name='RE-LOGIN CLAUDE NATIVE', exact=True).first.click()
        await expect(notice.get_by_role('textbox', name='Native callback URL')).to_be_visible()
        assert login_bodies[0] == {'binding': binding, 'workflowId': 'origin'}
        assert await page.evaluate('window.store.getState().activeJobId') == 'other'
        native.update(state='present', checkedAt=3000, binding={**binding, 'revision': 'local-replacement'})
        flows['flow-1'].update(status='complete', binding=native['binding'])
        await expect(notice.get_by_role('button', name='REVIEW ORIGINAL WORKFLOW')).to_be_visible(timeout=8000)
        await expect(notice.get_by_text('Second notice stays separate', exact=True)).to_be_visible()
        await notice.get_by_role('button', name='REVIEW ORIGINAL WORKFLOW').click()
        assert await page.evaluate('window.store.getState().activeJobId') == 'origin'

        # Existing rejected credentials must not stop Settings' flow polling.
        native.update(state='needs-attention', checkedAt=4000)
        await page.evaluate('window.showSettings()')
        settings = page.locator('#settings')
        await settings.get_by_role('button', name='LOGIN', exact=True).click()
        await expect(settings.get_by_role('textbox', name='Native callback URL')).to_be_visible()
        native.update(state='present', checkedAt=5000, binding={**binding, 'revision': 'settings-local'})
        flows['flow-2'].update(status='complete', binding=native['binding'])
        await expect(settings.get_by_text('Sign-in flow: complete.', exact=False)).to_be_visible(timeout=8000)
        await expect(settings.get_by_role('textbox', name='Native callback URL')).to_have_count(0)

        # Remote/manual completion and cancellation share the same lifecycle.
        native.update(state='needs-attention', checkedAt=6000)
        await page.evaluate("window.showSettings('manual')")
        await settings.get_by_role('button', name='LOGIN', exact=True).click()
        await settings.get_by_role('textbox', name='Native callback URL').fill('http://localhost:53692/callback?code=fixture&state=fixture')
        await settings.get_by_role('button', name='SUBMIT', exact=True).click()
        await expect(settings.get_by_text('Sign-in flow: complete.', exact=False)).to_be_visible()
        assert flows['flow-3']['status'] == 'complete'
        native.update(state='needs-attention', checkedAt=7000)
        await page.evaluate("window.showSettings('cancel')")
        await settings.get_by_role('button', name='LOGIN', exact=True).click()
        await settings.get_by_role('button', name='CANCEL SIGN-IN', exact=True).click()
        await expect(settings.get_by_text('Sign-in flow: cancelled.', exact=False)).to_be_visible()
        assert flows['flow-4']['status'] == 'cancelled'
        assert await page.evaluate('JSON.stringify(window.drafts.getState().drafts)===window.savedDrafts')
        assert await page.evaluate('JSON.stringify(window.store.getState().attachments)===window.savedAttachments')
        assert await page.evaluate('JSON.stringify(Object.values(window.store.getState().jobs).map(j=>j.config))===window.savedConfigs')
        assert await page.evaluate('window.sent.length') == 0
        assert not any(path.startswith('/api/auth-login') for _, path in requests)
        assert not blocked, blocked
        assert not errors, errors
        await browser.close()
        print('PASS origin-bound ChatMessage recovery, local callback tracking with present credentials, independent notices, drafts and explicit continuation without replay')

asyncio.run(main())
