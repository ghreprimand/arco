"""Actual App/manual/contextual help against Vite :5179; all APIs/WS isolated.
No provider execution, production settings writes or workflow operations.
"""
import asyncio
import os
import re
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright

URL = os.environ.get('ARCHON_HELP_PREVIEW_URL', 'http://127.0.0.1:5179/')
CHROME = os.environ.get('ARCHON_TEST_CHROME', os.path.expanduser('~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'))
ART = Path('/tmp/archon-help-docs-review')

async def main():
    ART.mkdir(exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000})
        errors, writes, messages = [], [], []
        async def api(route):
            path = urlparse(route.request.url).path
            if route.request.method != 'GET':
                writes.append(path)
            data = {'files': [], 'entries': [], 'workflows': [], 'projects': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'tasks': [], 'sessions': [], 'messages': [], 'chats': []}
            if path == '/api/settings': data = {'themeId': 'arch', 'enabledProviders': {'claude': True}}
            elif path == '/api/auth-status': data = {n: {'loggedIn': n == 'claude', 'installed': True, 'cliInstalled': True} for n in ['claude', 'codex', 'zai', 'cursor', 'gemini', 'ollama', 'llamacpp', 'lmstudio', 'antigravity', 'github']}
            elif path == '/api/capabilities': data = {'efforts': ['low', 'medium', 'high'], 'models': ['claude-opus-4-6'], 'cliVersion': 'fixture'}
            elif path.endswith('/catalog'): data = {'models': []}
            elif path == '/api/list-dirs': data = {'dirs': [], 'path': '/demo', 'parent': '/'}
            elif path == '/api/usage': data = {'available': False}
            await route.fulfill(json=data)
        await context.route('**/api/**', api)
        await context.route('**/healthz', lambda r: r.fulfill(json={'status': 'live'}))
        await context.route('https://**/*', lambda r: r.abort())
        await context.route_web_socket('**/*', lambda ws: ws.on_message(lambda msg: messages.append(msg)))
        page = await context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(URL)
        await page.wait_for_timeout(700)
        await page.evaluate('''async () => {
          const {useAppStore:s}=await import('/src/stores/appStore.ts'); window.testStore=s;
          s.getState().createJob('help-chat',{kind:'chat',name:'Help fixture',primaryProvider:'claude',primaryModel:'claude-opus-4-6',workingDirectory:'',skipPermissions:false});
          s.setState(st=>({connected:true,connectionState:'connected',showCreator:false,activeJobId:'help-chat',jobs:{...st.jobs,'help-chat':{...st.jobs['help-chat'],snapshotReceived:true,busy:false}}}));
          s.getState().setHelpMode(true);
        }''')
        await page.locator('[data-help="chat.input"]').click()
        await page.get_by_role('button', name='READ MORE IN MANUAL →').click()
        await page.locator('#manual-chat-mode').wait_for()
        search = page.get_by_placeholder('Search…', exact=True)
        for query, section in [('incognito', 'incognito-chat'), ('session/load', 'providers-overview'), ('922K', 'provider-codex'), ('Phosphor', 'settings-themes'), ('Research', 'research-action'), ('platform binary', 'provider-updates')]:
            await search.fill(query)
            target = page.locator('#manual-' + section)
            title = await target.locator('h3').inner_text()
            await page.get_by_role('navigation', name='Manual contents').get_by_role('button', name=re.compile('^' + re.escape(title) + '$', re.I)).click()
            await page.wait_for_function("id=>{const e=document.getElementById('manual-'+id),a=e.getBoundingClientRect(),b=e.closest('.manual-content').getBoundingClientRect();return a.top>=b.top-4&&a.top<=b.top+32}", arg=section, timeout=4000)
        await search.fill('Incognito')
        await page.screenshot(path=str(ART/'manual-incognito.png'))
        await page.keyboard.press('Escape')
        await page.evaluate('testStore.getState().showJobCreator()')
        await page.locator('[data-help="creator.chat-mode"]').click()
        await page.evaluate('testStore.getState().setHelpMode(true)')
        await page.locator('[data-help="creator.incognito"]').click()
        assert await page.evaluate("testStore.getState().activeHelpPopover.key") == 'creator.incognito'
        assert not await page.locator('[data-help="creator.incognito"] input').is_checked()
        await page.screenshot(path=str(ART/'incognito-contextual.png'))
        await page.get_by_role('button', name='READ MORE IN MANUAL →').click()
        await page.locator('#manual-incognito-chat').wait_for()
        await page.get_by_placeholder('Search…', exact=True).fill('Incognito')
        for width, height in [(768, 700), (390, 700)]:
            await page.set_viewport_size({'width': width, 'height': height})
            await page.get_by_role('navigation', name='Manual contents').get_by_role('button', name='Incognito Chat — privacy and limits', exact=True).click()
            await page.wait_for_function("()=>{const a=document.getElementById('manual-incognito-chat').getBoundingClientRect(),b=document.querySelector('.manual-content').getBoundingClientRect();return a.top>=b.top-4&&a.top<=b.top+32}", timeout=4000)
            assert await page.locator('.manual-content').evaluate('e=>e.clientWidth>=250 && e.scrollWidth<=e.clientWidth+2')
            await page.screenshot(path=str(ART/f'manual-{width}.png'))
        await page.set_viewport_size({'width': 1440, 'height': 1000})
        await page.evaluate("document.documentElement.style.zoom='2'")
        await page.get_by_role('navigation', name='Manual contents').get_by_role('button', name='Incognito Chat — privacy and limits', exact=True).click()
        await page.wait_for_function("()=>{const a=document.getElementById('manual-incognito-chat').getBoundingClientRect(),b=document.querySelector('.manual-content').getBoundingClientRect();return a.top>=b.top-4&&a.top<=b.top+32}", timeout=4000)
        assert await page.get_by_role('dialog', name='ARCO · USER MANUAL').evaluate('e=>{const r=e.getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight+2}')
        await page.screenshot(path=str(ART/'manual-zoom200.png'))
        assert not errors, errors
        assert not writes, writes
        assert not messages, messages
        print('PASS: manual search, table text, Research TOC, Chat help and non-consequential Incognito help; zero API writes/WS sends/page errors.')
        print('Narrow/200% screenshots retained for inspection; not a whole-app accessibility audit.')
        await browser.close()

asyncio.run(main())
