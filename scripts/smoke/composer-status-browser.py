"""Composer coverage against isolated Vite APIs/WS; no provider calls.
Run ARCO_CLIENT_PORT=5194 npm run dev:client, then python3 this file.
"""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()

URL = os.environ.get('ARCO_INTERRUPT_PREVIEW_URL', 'http://127.0.0.1:5254/')
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
        await page.evaluate("""() => { const s=window.testStore; const j=s.getState().jobs['interrupt-ui']; s.setState({jobs:{...s.getState().jobs, 'interrupt-ui':{...j, config:{...j.config,goal:'Finish the synthetic project'}, compactedResume:{foldedTurns:4}, toolCallsSinceHandoff:65, queue:{steering:[{content:'Review this synthetic change',clientMessageId:'fixture'}],followUp:[]}}}}); }""")
        for width, height in [(1280,800),(900,800),(480,800)]:
            await page.set_viewport_size({'width':width,'height':height})
            for scale in [100,150]:
                await page.evaluate('(scale) => { document.documentElement.style.zoom = scale / 100; }', scale)
                line = page.get_by_test_id('composer-status-line')
                await expect(line).to_be_visible()
                await expect(line.get_by_role('button', name='PENDING · 1')).to_be_visible()
                await expect(page.get_by_text('TOOL CALLS SINCE HANDOFF')).to_have_count(0)
                assert await line.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
        await page.get_by_role('button', name='PENDING · 1').click()
        await expect(page.get_by_text('Review this synthetic change')).to_be_visible()
        await expect(page.get_by_text('QUEUED', exact=False).last).to_be_visible()
        await page.get_by_role('button', name='CANCEL', exact=True).last.click()
        assert any(m.get('type') == 'cancel_queued_message' for m in messages), messages
        await page.keyboard.press('Escape')
        await page.evaluate("""() => { const s=window.testStore; const j=s.getState().jobs['interrupt-ui']; s.setState({jobs:{...s.getState().jobs, 'interrupt-ui':{...j, config:{...j.config,primaryProvider:'claude',ultracode:true}}}}); }""")
        await page.get_by_role('button', name='ULTRACODE', exact=False).click()
        await expect(page.get_by_text('TRANSPORT', exact=True).last).to_be_visible()
        gauge = page.locator('[data-help="worker.header.ctx"] [title]').first
        assert 'FRESH SUMMARIZER' in (await gauge.get_attribute('title'))
        assert not errors, errors
        await browser.close()
        print('PASS: status chips wrap, open pending messages and cancel at six viewport scales')

asyncio.run(main())
