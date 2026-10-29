"""Actual App/manual/contextual help against Vite :5179; all APIs/WS isolated.
No provider execution, production settings writes or workflow operations.
"""
import asyncio
import os
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.async_api import async_playwright

URL = os.environ.get('ARCO_HELP_PREVIEW_URL', f"http://127.0.0.1:{os.environ.get('ARCO_CLIENT_PORT', '5179')}/")
CHROME = os.environ.get('ARCO_TEST_CHROME', os.path.expanduser('~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'))
ART = Path('/tmp/arco-help-docs-review')

async def main():
    ART.mkdir(exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000})
        initial_scale = os.environ.get('ARCO_TEST_UI_SCALE', '1.1')
        await context.add_init_script(f"localStorage.setItem('arco_ui_scale', '{initial_scale}')")
        errors, writes, messages, quota_queries = [], [], [], []
        async def api(route):
            path = urlparse(route.request.url).path
            # POST /api/session mints the WebSocket session cookie (client/src/utils/wsSession.ts);
            # it changes no state, so it is not a write.
            if route.request.method != 'GET' and path != '/api/session':
                writes.append(path)
            data = {'files': [], 'entries': [], 'workflows': [], 'projects': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'tasks': [], 'sessions': [], 'messages': [], 'chats': []}
            if path == '/api/settings': data = {'themeId': 'arch', 'enabledProviders': {'claude': True}, 'uiScale': float(initial_scale)}
            elif path == '/api/auth-status': data = {n: {'loggedIn': n == 'claude', 'installed': True, 'cliInstalled': True} for n in ['claude', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'github']}
            elif path == '/api/capabilities': data = {'efforts': ['low', 'medium', 'high'], 'models': ['claude-opus-4-6'], 'cliVersion': 'fixture'}
            elif path.endswith('/catalog'): data = {'models': []}
            elif path == '/api/list-dirs': data = {'dirs': [], 'path': '/demo', 'parent': '/'}
            elif path == '/api/usage': data = {'available': False}
            elif path == '/api/codex-usage':
                query = parse_qs(urlparse(route.request.url).query); quota_queries.append(query)
                source = query.get('source', ['appserver'])[0]
                account = query.get('account', ['default'])[0]
                data = {'available': True, 'fetchedAt': 1800000000000, 'source': source, 'accountLabel': account, 'stale': account == 'work', 'error': 'fixture stale' if account == 'work' else None, 'rows': [{'label': 'codex primary', 'value': '25% used'}, {'label': 'other secondary', 'value': '50% used'}], 'analyticsUrl': 'https://chatgpt.com/settings/usage'}
                if source == 'camoufox': data = {'available': False, 'fetchedAt': 1800000000000, 'source': 'unavailable', 'error': 'Camoufox fixture missing', 'analyticsUrl': 'https://chatgpt.com/settings/usage'}
            await route.fulfill(json=data)
        await context.route('**/api/**', api)
        await context.route('**/healthz', lambda r: r.fulfill(json={'status': 'live'}))
        await context.route('https://**/*', lambda r: r.abort())
        # The client's keepalive ping is not an operation; anything else sent over the socket is.
        await context.route_web_socket('**/*', lambda ws: ws.on_message(lambda msg: None if msg == '{"type":"ping"}' else messages.append(msg)))
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
        if initial_scale == '1.5':
            await page.evaluate("testStore.getState().setHelpMode(false); testStore.getState().showJobCreator()")
            await page.locator('[data-help="creator.chat-mode"]').wait_for()
            await page.screenshot(path=str(ART/'scale-creator.png'))
            await page.evaluate("testStore.setState({showCreator:false})")
            await page.locator('[data-help="tabbar.tab"]').first.wait_for()
            await page.screenshot(path=str(ART/'scale-workflow.png'))
            await page.locator('[data-help="tabbar.tab"]').first.click(button='right')
            await page.get_by_text('CLUSTER ACTIONS',exact=True).wait_for()
            await page.screenshot(path=str(ART/'scale-context.png'))
            await page.keyboard.press('Escape')
            await page.evaluate("testStore.getState().setHelpMode(true)")
        await page.wait_for_function('() => testStore.getState().authStatus && testStore.getState().settings')
        # Each enabled signed-in provider gets its dot; disabling it removes its
        # trigger and the entire group disappears when none remain enabled.
        await page.evaluate("""() => {
          const names=['claude','codex','cursor','ollama'];
          testStore.setState(st=>({authStatus:{...st.authStatus,...Object.fromEntries(names.map(n=>[n,{loggedIn:true}]))},settings:{...st.settings,enabledProviders:Object.fromEntries(names.map(n=>[n,true]))}}));
        }""")
        bar = page.locator('[data-help="header.live-status"]')
        await bar.wait_for()
        await page.evaluate("testStore.setState(st=>({settings:{...st.settings,providerAccounts:{codex:[{id:'work',label:'Work'}]}}}))")
        await page.evaluate('testStore.getState().setHelpMode(false)')
        await page.get_by_label('X usage page').hover()
        popup = page.get_by_role('tooltip').filter(has_text='Source')
        await popup.get_by_label('Account').hover()
        await popup.get_by_label('Account').select_option('work')
        await popup.get_by_text('fixture stale').wait_for()
        assert await popup.get_by_text('other secondary').count() == 1
        assert not any(q.get('source') == ['camoufox'] for q in quota_queries)
        await popup.get_by_label('Source').select_option('camoufox')
        await page.wait_for_function("() => document.querySelector('[role=tooltip]')?.textContent.includes('Browser profile is separate')")
        await popup.get_by_text('Camoufox fixture missing').wait_for()
        assert any(q.get('source') == ['camoufox'] for q in quota_queries)
        await page.evaluate('testStore.getState().setHelpMode(true)')
        for name, letter in [('claude','C'),('codex','X'),('cursor','R'),('ollama','O')]:
            await page.wait_for_function("letter => [...document.querySelector('[data-help=\"header.live-status\"]').querySelectorAll('.display-font')].some(e => e.textContent.trim() === letter)", arg=letter)
            await page.evaluate("name => testStore.setState(st=>({settings:{...st.settings,enabledProviders:{...st.settings.enabledProviders,[name]:false}}}))", name)
            if name != 'ollama':
                await page.wait_for_function("letter => ![...document.querySelector('[data-help=\"header.live-status\"]').querySelectorAll('.display-font')].some(e => e.textContent.trim() === letter)", arg=letter)
        await bar.wait_for(state='detached')
        await page.evaluate("() => testStore.setState(st=>({settings:{...st.settings,enabledProviders:{claude:true}}}))")
        await page.locator('[data-help="chat.input"]').click()
        await page.get_by_role('button', name='READ MORE IN MANUAL →').click()
        await page.locator('#manual-chat-mode').wait_for()
        search = page.get_by_placeholder('Search…', exact=True)
        for query, section in [('incognito', 'incognito-chat'), ('session/load', 'providers-overview'), ('828K', 'provider-codex'), ('Phosphor', 'settings-themes'), ('Research', 'research-action'), ('platform binary', 'provider-updates')]:
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
            assert await page.locator('.manual-content').evaluate('e=>e.getBoundingClientRect().width>=250 && e.scrollWidth<=e.clientWidth+2')
            await page.screenshot(path=str(ART/f'manual-{width}.png'))
        await page.set_viewport_size({'width': 1440, 'height': 1000})
        await page.evaluate("document.documentElement.style.zoom='2';document.documentElement.style.setProperty('--ui-scale','2')")
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
