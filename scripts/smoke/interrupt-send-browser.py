"""Composer coverage against isolated Vite APIs/WS; no provider calls.
Run ARCO_CLIENT_PORT=5194 npm run dev:client, then python3 this file.
"""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect

URL = os.environ.get('ARCO_INTERRUPT_PREVIEW_URL', 'http://127.0.0.1:5194/')
CHROME = os.environ.get('ARCO_TEST_CHROME', os.path.expanduser('~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'))


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000})
        messages, errors = [], []

        async def api(route):
            path = urlparse(route.request.url).path
            data = {'files': [], 'entries': [], 'workflows': [], 'projects': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'tasks': [], 'sessions': [], 'messages': [], 'chats': [], 'dirs': []}
            if path == '/api/settings':
                data = {'themeId': 'arch', 'enabledProviders': {'codex': True, 'claude': True}}
            elif path == '/api/auth-status':
                data = {n: {'loggedIn': True, 'installed': True, 'cliInstalled': True} for n in ['claude', 'codex',  'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'github']}
            elif path == '/api/capabilities':
                data = {'efforts': ['low', 'medium', 'high'], 'models': ['gpt-5.5'], 'cliVersion': 'fixture', 'codexVersion': '0.164.0'}
            elif path.endswith('/catalog'):
                data = {'models': []}
            await route.fulfill(json=data)

        await context.route('**/api/**', api)
        await context.route('**/healthz', lambda r: r.fulfill(json={'status': 'live'}))
        await context.route('https://**/*', lambda r: r.abort())
        await context.route_web_socket('**/*', lambda ws: ws.on_message(lambda raw: messages.append(json.loads(raw))))
        await context.add_init_script('''
          const OriginalWebSocket = window.WebSocket;
          window.WebSocket = class extends OriginalWebSocket {
            constructor(...args) { super(...args); window.testSocket = this; }
          };
        ''')
        page = await context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(URL)
        await page.wait_for_timeout(500)
        await page.evaluate('''async () => {
          const loaded = path => performance.getEntriesByType('resource').map(e => e.name).findLast(url => new URL(url).pathname === path) ?? path;
          const {useAppStore:s} = await import(loaded('/src/stores/appStore.ts')); window.testStore=s;
          s.getState().createJob('interrupt-ui', {kind:'workflow',name:'Interrupt UI',primaryProvider:'codex',primaryModel:'gpt-5.5',primaryEffort:'high',codexTransport:'appserver',workingDirectory:'/tmp',skipPermissions:false});
          s.getState().beginPrimaryTurn('interrupt-ui', Date.now());
          s.setState({connected:true,connectionState:'online',focusMode:true});
        }''')
        draft = page.locator('textarea').first
        button = page.get_by_role('button', name='INTERRUPT & SEND', exact=True)
        normal = page.get_by_role('button', name='SEND', exact=True)
        await expect(normal).to_be_visible()
        await expect(normal).to_be_disabled()
        await draft.fill('normal button steering')
        await expect(normal).to_be_enabled()
        await expect(button).to_be_enabled()
        await normal.click()
        await expect(draft).to_have_value('')
        assert messages[-1]['kind'] == 'steer' and messages[-1]['content'] == 'normal button steering'
        assert not any(m['type'] == 'cancel' for m in messages)

        await expect(button).to_be_visible()
        await expect(button).to_be_disabled()
        await draft.fill('change direction now')
        await expect(button).to_be_enabled()
        await button.click()
        await expect(draft).to_have_value('')
        assert messages[-1]['type'] == 'user_message' and messages[-1]['kind'] == 'interrupt', messages[-1]
        assert messages[-1]['content'] == 'change direction now'
        assert not any(m['type'] == 'cancel' for m in messages)
        await draft.fill('keyboard correction')
        await draft.press('Control+Enter')
        await expect(draft).to_have_value('')
        assert messages[-1]['kind'] == 'interrupt' and messages[-1]['content'] == 'keyboard correction'
        await draft.fill('normal steering'); await draft.press('Enter')
        assert messages[-1]['kind'] == 'steer'
        await draft.fill('later task'); await draft.press('Alt+Enter')
        assert messages[-1]['kind'] == 'follow-up'
        await draft.fill('keep this draft'); await draft.press('Shift+Enter')
        await expect(draft).to_have_value('keep this draft\n')
        count = len(messages)
        await page.evaluate('''() => {
          testSocket.close();
          document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',ctrlKey:true,bubbles:true}));
        }''')
        await expect(draft).to_have_value('keep this draft\n')
        assert len(messages) == count, 'disconnected interrupt keeps the unsent draft'
        await page.evaluate("testStore.getState().endPrimaryTurn('interrupt-ui')")
        await expect(button).to_have_count(0)
        await expect(normal).to_be_visible()
        await page.evaluate("testStore.getState().beginPrimaryTurn('interrupt-ui',Date.now());testStore.getState().updateJobPrimary('interrupt-ui',{provider:'claude',claudeTransport:'native'})")
        await expect(button).to_be_visible()
        await page.evaluate("testStore.getState().updateJobPrimary('interrupt-ui',{provider:'ollama'})")
        await expect(button).to_have_count(0)
        await page.evaluate("testStore.getState().updateJobPrimary('interrupt-ui',{provider:'codex'});testStore.getState().setActiveJob('interrupt-ui')")
        await page.set_viewport_size({'width': 700, 'height': 900})
        await expect(button).to_be_visible()
        for width in [700, 400]:
            await page.set_viewport_size({'width': width, 'height': 900})
            for control in [normal, button]:
                await expect(control).to_be_visible()
                rect = await control.bounding_box()
                assert rect and rect['x'] >= 0 and rect['x'] + rect['width'] <= width, rect
        Path('/tmp/arco-interrupt-ui').mkdir(exist_ok=True)
        await page.screenshot(path='/tmp/arco-interrupt-ui/composer.png')
        assert not errors, errors
        print('PASS: visible normal SEND and INTERRUPT & SEND, normal send payload, button/draft updates, Ctrl+Enter, ordinary steer/follow-up, newline, disconnected draft retention, provider/idle visibility and narrow layout.')
        await browser.close()


asyncio.run(main())
