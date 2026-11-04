"""Settings > Notifications: per-event switches, ntfy address, generate, test and saved-token handling."""
import asyncio
import json
import re
import subprocess
import tempfile
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
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/styles/matrix.css"><link rel="stylesheet" href="/src/themes/phosphor/phosphor.css"></head><body><div id="fixture"></div><div id="bell" style="position:fixed;right:20px;top:10px;z-index:100"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''

VIEW = {'desktop': {'finished': False, 'failed': False, 'waiting': False}, 'phone': {'finished': False, 'failed': False, 'waiting': False}, 'phoneText': False, 'clusterFinished': 'director', 'ntfy': {'server': 'https://ntfy.sh', 'topic': '', 'tokenSet': False}, 'ntfyFromEnvironment': False}

async def main():
    async with async_playwright() as p:
        browser = await p.firefox.launch() if os.environ.get('ARCO_TEST_FIREFOX') == '1' else await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1200, 'height': 1000})
        await page.add_init_script('''
          window.notificationLog = [];
          class MockNotification {
            static permission = 'default';
            static async requestPermission() { this.permission = 'granted'; return this.permission; }
            constructor(title, options) { window.notificationLog.push({title, options}); }
            close() {}
          }
          window.Notification = MockNotification;
        ''')
        blocked, errors, puts, tests = [], [], [], []
        state = json.loads(json.dumps(VIEW))
        test_result = {'ok': True}
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'https' and url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(status=200, content_type='text/css', body='')
                return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                method = route.request.method
                if url.path == '/api/notification-channels' and method == 'GET':
                    await route.fulfill(json=state)
                    return
                if url.path == '/api/notification-channels' and method == 'PUT':
                    body = json.loads(route.request.post_data or '{}')
                    puts.append(body)
                    state.update({'desktop': body['desktop'], 'phone': body['phone'], 'phoneText': body['phoneText'], 'clusterFinished': body['clusterFinished']})
                    state['ntfy'] = {'server': body['ntfy']['server'], 'topic': body['ntfy']['topic'], 'tokenSet': state['ntfy']['tokenSet'] if 'token' not in body['ntfy'] else body['ntfy']['token'] is not None}
                    await route.fulfill(json=state)
                    return
                if url.path == '/api/notification-channels/test' and method == 'POST':
                    tests.append(json.loads(route.request.post_data or '{}'))
                    await route.fulfill(json=test_result)
                    return
                if method == 'GET':
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
          const {NotificationChannelsSettings} = await import('/src/components/NotificationChannelsSettings.tsx');
          createRoot(document.getElementById('fixture')).render(React.createElement(NotificationChannelsSettings));
        }''')
        await expect(page.get_by_text('Browser permission: not asked.')).to_be_visible()
        await page.get_by_role('button', name='TEST DESKTOP').click()
        await expect(page.get_by_text('Browser permission is needed', exact=False)).to_be_visible()
        await page.get_by_role('button', name='REQUEST PERMISSION').click()
        await expect(page.get_by_text('Browser permission: granted.')).to_be_visible()
        await page.get_by_role('button', name='TEST DESKTOP').click()
        assert await page.evaluate('window.notificationLog.length') == 1
        await expect(page.get_by_text('Test sent.', exact=False)).to_be_visible()
        await page.evaluate("""async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {NotificationCenter} = await import('/src/components/NotificationCenter.tsx');
          const {useNotificationStore} = await import('/src/stores/notificationStore.ts');
          createRoot(document.getElementById('bell')).render(React.createElement(NotificationCenter, {onSetMutes: m => useNotificationStore.getState().setMutedFromServer(m)}));
        }""")
        await page.get_by_role('button', name='BELL', exact=False).click()
        await expect(page.get_by_text('SHOW IN BELL', exact=True)).to_be_visible()
        await expect(page.get_by_label('Turn finished', exact=True)).to_be_checked()
        await expect(page.get_by_label('Failed or waiting on you', exact=True)).to_be_checked()
        await page.get_by_label('Failed or waiting on you', exact=True).click()
        await expect(page.get_by_label('Failed or waiting on you', exact=True)).not_to_be_checked()
        await page.get_by_label('Failed or waiting on you', exact=True).click()
        await expect(page.get_by_label('Failed or waiting on you', exact=True)).to_be_checked()
        for kind in ('A turn finished', 'A turn failed', 'Waiting for you'):
            await expect(page.get_by_label(kind + ': this computer')).not_to_be_checked()
            await expect(page.get_by_label(kind + ': phone')).not_to_be_checked()
        await expect(page.get_by_label('Include message text', exact=False)).not_to_be_checked()

        await page.get_by_label('A turn finished: phone').click()
        await expect(page.get_by_label('A turn finished: phone')).to_be_checked()
        assert puts[-1]['phone'] == {'finished': True, 'failed': False, 'waiting': False}, puts[-1]
        await page.get_by_label('Waiting for you: this computer').click()
        await expect(page.get_by_label('Waiting for you: this computer')).to_be_checked()
        assert puts[-1]['desktop']['waiting'] is True and puts[-1]['phone']['finished'] is True, puts[-1]

        status = page.get_by_role('status')
        await page.get_by_role('button', name='TEST', exact=True).click()
        await expect(status).to_contain_text('topic uses')
        assert not tests, 'no test is sent without a topic'
        await page.get_by_role('button', name='GENERATE').click()
        topic = await page.get_by_label('ntfy topic').input_value()
        assert re.fullmatch(r'arco-[0-9a-f]{24}', topic), topic
        await page.get_by_label('ntfy server').fill('not a server')
        await page.get_by_role('button', name='SAVE ADDRESS').click()
        await expect(status).to_contain_text('server address')
        await page.get_by_label('ntfy server').fill('https://ntfy.example.org')
        await page.get_by_label('ntfy access token').fill('tk_secret')
        await page.get_by_role('button', name='SAVE ADDRESS').click()
        await expect(status).to_have_text('Saved.')
        assert puts[-1]['ntfy'] == {'server': 'https://ntfy.example.org', 'topic': topic, 'token': 'tk_secret'}, puts[-1]
        await expect(page.get_by_role('button', name='REMOVE TOKEN')).to_be_visible()
        assert 'tk_secret' not in await page.locator('#fixture').inner_text()
        await page.get_by_role('button', name='TEST', exact=True).click()
        await expect(status).to_contain_text('Sent.')
        assert tests and tests[-1]['ntfy']['topic'] == topic, tests
        test_result.update({'ok': False, 'error': 'boom'})
        await page.get_by_role('button', name='TEST', exact=True).click()
        await expect(status).to_have_text('The test failed: boom')
        await page.get_by_role('button', name='REMOVE TOKEN').click()
        await expect(status).to_contain_text('removed')
        assert puts[-1]['ntfy']['token'] is None, puts[-1]
        await expect(page.get_by_role('button', name='REMOVE TOKEN')).to_have_count(0)
        await page.get_by_label('Include message text', exact=False).click()
        await expect(page.get_by_label('Include message text', exact=False)).to_be_checked()
        assert puts[-1]['phoneText'] is True
        await page.get_by_label('Cluster finished source').select_option('all')
        await expect(page.get_by_label('Cluster finished source')).to_have_value('all')
        assert puts[-1]['clusterFinished'] == 'all'
        # The client receives the same attention message emitted for a long turn.
        with tempfile.TemporaryDirectory(prefix='arco-attention-home-') as home:
            env = {**os.environ, 'HOME': home, 'ARCO_HOME': home}
            event = json.loads(subprocess.check_output(['node', '--import', 'tsx', 'scripts/smoke/attention-event-fixture.ts'], cwd=ROOT, text=True, env=env))
        await page.evaluate("""async (event) => {
          const {useNotificationChannelsStore} = await import('/src/stores/notificationChannelsStore.ts');
          const {useNotificationStore} = await import('/src/stores/notificationStore.ts');
          const {handleServerMessage} = await import('/src/ws/handleServerMessage.ts');
          useNotificationChannelsStore.setState({view: {...useNotificationChannelsStore.getState().view, desktop: {finished: true, failed: false, waiting: false}}});
          Object.defineProperty(document, 'hasFocus', {value: () => false, configurable: true});
          handleServerMessage(event, {wsRef: {current: null}, scheduleReconnect: () => {}});
          window.attentionNotices = useNotificationStore.getState().notices;
        }""", event)
        assert await page.evaluate("window.notificationLog.some(n => n.title === 'Other finished')")
        assert await page.evaluate("window.attentionNotices.some(n => n.title === 'Other finished')")
        await page.evaluate("""async () => {
          const {useAppStore} = await import('/src/stores/appStore.ts');
          const {useNotificationStore} = await import('/src/stores/notificationStore.ts');
          const {handleServerMessage} = await import('/src/ws/handleServerMessage.ts');
          useAppStore.setState({showHome: false, showCreator: false, activeJobId: 'other', activeClusterId: null});
          handleServerMessage({type:'attention_event', id:'same-tab', kind:'waiting', workflowId:'other', workflowName:'Other', desktopEligible:false}, {wsRef:{current:null}, scheduleReconnect:()=>{}});
          window.sameTabNotice = useNotificationStore.getState().notices.some(n => n.id === 'same-tab');
        }""")
        assert not await page.evaluate('window.sameTabNotice')
        await page.evaluate("""async () => {
          const {useNotificationStore} = await import('/src/stores/notificationStore.ts');
          const {handleServerMessage} = await import('/src/ws/handleServerMessage.ts');
          useNotificationStore.getState().setMutedFromServer(['attention']);
          handleServerMessage({type:'attention_event', id:'disabled', kind:'failed', workflowId:'elsewhere', workflowName:'Elsewhere', desktopEligible:false}, {wsRef:{current:null}, scheduleReconnect:()=>{}});
          window.disabledNotice = useNotificationStore.getState().notices.some(n => n.id === 'disabled');
        }""")
        assert not await page.evaluate('window.disabledNotice')


        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: permission and desktop test, server attention event, BELL visibility, phone settings and test')

asyncio.run(main())
