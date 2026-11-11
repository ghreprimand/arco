"""Top bar regroup: VERSIONS opens the Providers panel, KNOWLEDGE / TOOLS / VOICE / HELP menus, no overflow. Fixture only."""
import asyncio
import json
import os
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from host_isolation import chrome_executable

URL = f"http://127.0.0.1:{os.environ.get('ARCO_CLIENT_PORT', '5203')}/"
SHOTS = os.environ.get('ARCO_SHOT_DIR')

def fixture(local):
    return {'settings': {'themeId': 'arch', 'enabledProviders': {'claude': True, 'codex': True, 'cursor': True, 'ollama': local}, 'onboardingComplete': True, 'updateCheck': False},
            'auth': {n: {'loggedIn': n in (['claude', 'codex', 'cursor'] + (['ollama'] if local else [])), 'installed': True, 'cliInstalled': True} for n in ['claude', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'github']}}

async def run(p, width, local, voice_ready, shots):
    fx = fixture(local)
    browser = await p.chromium.launch(executable_path=chrome_executable() or None)
    context = await browser.new_context(viewport={'width': width, 'height': 700})
    errors = []
    async def api(route):
        path = urlparse(route.request.url).path
        data = {'files': [], 'entries': [], 'workflows': [], 'projects': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'tasks': [], 'sessions': [], 'messages': [], 'chats': []}
        if path == '/api/settings': data = fx['settings']
        elif path == '/api/auth-status': data = fx['auth']
        elif path == '/api/capabilities': data = {'efforts': ['low'], 'models': ['m'], 'cliVersion': '2.1.0', 'codexVersion': '0.9.0', 'strataVersion':'1.2.3', 'xolotlRevision':'a'*40, 'cursorVersion':'2026.11.10-fixture', 'latestVersions': {'claude': '2.1.0', 'codex': '0.9.0'}}
        elif path == '/api/ollama-live': data = {'up':True,'version':'1.2.3','loadedModels':[],'fetchedAt':0}
        elif path == '/api/llamacpp-live': data = {'up':True,'version':'0.1.2-dev (build 10549, commit b2e5e9b28)','loadedModel':None}
        elif path == '/api/voice/setup': data = {'ready': voice_ready, 'install': {'running': False}}
        elif path == '/api/update-check': data = {'current': '0.1.5-rc.9', 'latest': None, 'url': None, 'publishedAt': None, 'checkedAt': None, 'enabled': False, 'updateAvailable': False}
        elif path == '/api/usage': data = {'available': False}
        elif path.endswith('/catalog'): data = {'models': []}
        await route.fulfill(json=data)
    await context.route('**/api/**', api)
    await context.route('**/healthz', lambda r: r.fulfill(json={'status': 'live'}))
    await context.route('https://**/*', lambda r: r.abort())
    def socket(ws):
        ws.on_message(lambda raw: ws.send(json.dumps({'type': 'pong'})) if json.loads(raw).get('type') == 'ping' else None)
        ws.send(json.dumps({'type': 'connected', 'sessionId': 'topbar-fixture'}))
    await context.route_web_socket('**/ws', socket)
    page = await context.new_page()
    page.on('pageerror', lambda e: errors.append(e.stack))
    await page.goto(URL)
    await page.evaluate("async()=>{window.testStore=(await import('/src/stores/appStore.ts')).useAppStore}")
    await page.wait_for_function("() => !!window.testStore.getState().settings")
    await page.evaluate("() => window.testStore.setState({ connected: true, connectionState: 'online', capabilities: { cliVersion: '2.1.0', codexVersion: '0.9.0', latestVersions: { claude: '2.1.0', codex: '0.9.0' } }, authStatus: " + json.dumps(fx['auth']) + " })")
    header = page.locator('header').first
    await expect(header.get_by_test_id('header-version-box')).to_have_text('v0.1.5-rc.9')
    await expect(header.get_by_role('button',name='Provider versions',exact=True)).to_be_visible()
    tag = f"{width}-{'local' if local else 'nolocal'}"
    async def shot(name):
        if shots:
            await page.screenshot(path=os.path.join(shots, f'topbar-{tag}-{name}.png'), clip={'x': 0, 'y': 0, 'width': width, 'height': 330})
    if width == 1440 and local and voice_ready:
        await page.evaluate("""async () => {
          const {useNotificationStore}=await import('/src/stores/notificationStore.ts');
          useNotificationStore.setState({notices:[{id:'fixture',ts:Date.now(),category:'agent',title:'Fixture notice'}],lastSeenTs:0});
        }""")
        for scale in [1, 1.5, 2]:
            await page.evaluate('s => {document.documentElement.style.zoom=String(s);document.documentElement.style.setProperty("--ui-scale",String(s));window.dispatchEvent(new Event("resize"))}',scale)
            for mode in ['auto', 'standard', 'compact', 'narrow']:
                await page.evaluate("async mode => (await import('/src/layout/layoutRange.ts')).setLayoutMode(mode)", mode)
                for hide_voice in [False, True]:
                    await page.locator('[data-help="voice.hands-free"]').evaluate('(el, hidden) => el.style.display=hidden ? "none" : "inline-flex"', hide_voice)
                    for sweep_width in range(2000, 699, -20):
                        await page.set_viewport_size({'width':sweep_width,'height':700})
                        await page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
                        failure=await header.evaluate("""el => {
                          const bar=el.getBoundingClientRect();
                          const controls=[...el.querySelectorAll('button, a[data-testid=provider-dot], [role="button"], h1, [data-testid="connection-light"]')].filter(n=>n.getBoundingClientRect().width>0);
                          const name=n=>n.dataset.help || n.dataset.testid || n.textContent;
                          for(let i=0;i<controls.length;i++) {
                            const a=controls[i].getBoundingClientRect();
                            if(a.left<bar.left-.5 || a.right>bar.right+.5 || a.top<bar.top-.5 || a.bottom>bar.bottom+.5) return ['clipped',name(controls[i]),a.toJSON()];
                            for(let j=i+1;j<controls.length;j++) {
                              const b=controls[j].getBoundingClientRect();
                              if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5) return ['overlap',name(controls[i]),name(controls[j]),a.toJSON(),b.toJSON()];
                            }
                          }
                          return null;
                        }""")
                        if failure and shots:
                            await page.screenshot(path=os.path.join(shots,'topbar-overlap.png'))
                        if shots and scale == 1 and mode == 'auto' and not hide_voice and sweep_width == 900:
                            await page.screenshot(path=os.path.join(shots,'topbar-after.png'))
                        assert not failure, (scale,mode,hide_voice,sweep_width,failure)
        await page.evaluate('() => {document.documentElement.style.zoom="1";document.documentElement.style.setProperty("--ui-scale","1");window.dispatchEvent(new Event("resize"))}')
        await page.evaluate("async () => (await import('/src/layout/layoutRange.ts')).setLayoutMode('auto')")
        await page.locator('[data-help="voice.hands-free"]').evaluate('el => el.style.display="inline-flex"')
        await page.set_viewport_size({'width':width,'height':700})
    versions=header.get_by_role('button',name='Provider versions',exact=True)
    await expect(versions).to_be_visible()
    if width == 1440 and local and voice_ready:
        await page.evaluate("async()=>{(await import('/src/stores/hubLinkStore.ts')).useHubLinkStore.setState({known:true,hubUrl:'https://hub.example.invalid',connected:false})}")
        for mode in ['auto','standard','compact','narrow']:
            await page.evaluate("async m=>(await import('/src/layout/layoutRange.ts')).setLayoutMode(m)",mode)
            for scale in [1,1.1]:
                await page.evaluate('s=>{document.documentElement.style.zoom=String(s);document.documentElement.style.setProperty("--ui-scale",String(s));window.dispatchEvent(new Event("resize"))}',scale)
                for panel_width in [700,900,1100,1600,2000]:
                    await page.set_viewport_size({'width':panel_width,'height':700})
                    for focus in [False,True]:
                        await page.evaluate('f=>window.testStore.setState({focusMode:f})',focus)
                        await page.evaluate('on=>window.testStore.setState({quotaState:on?{claude:{throttled:true,resetsAt:Date.now()+60000}}:null})',panel_width==900)
                        if not focus:
                            await header.get_by_test_id('provider-dot').first.hover()
                        await versions.click()
                        if not focus:
                            await header.get_by_test_id('provider-dot').first.hover()
                        panel=page.locator('[data-help="header.cli-versions"][role="dialog"]')
                        await expect(panel).to_be_visible()
                        await expect(header.get_by_role('tooltip')).to_have_count(0)
                        rect=await panel.bounding_box();bar=await header.bounding_box()
                        assert rect['x']>=-1 and rect['x']+rect['width']<=panel_width+1 and rect['y']>=bar['y']+bar['height']-1 and rect['y']+rect['height']<=701,(mode,scale,panel_width,focus,rect,bar)
                        await page.keyboard.press('Escape');await expect(panel).to_have_count(0);await expect(versions).to_be_focused()
    await page.evaluate('()=>{document.documentElement.style.zoom="1";document.documentElement.style.setProperty("--ui-scale","1");window.testStore.setState({focusMode:false})}')
    await page.evaluate("async ()=>(await import('/src/layout/layoutRange.ts')).setLayoutMode('auto')")
    await page.set_viewport_size({'width':width,'height':700})
    if width == 1440 and local and voice_ready:
        theme_ids=await page.evaluate("async()=>Object.keys((await import('/src/themes/registry.ts')).THEME_REGISTRY)")
        await page.set_viewport_size({'width':700,'height':700})
        for theme in theme_ids:
            await page.evaluate("async id=>{const {getTheme}=await import('/src/themes/registry.ts');(await import('/src/themes/apply.ts')).applyTheme(getTheme(id));}",theme)
            await versions.click()
            panel=page.get_by_role('dialog',name='Provider versions',exact=True)
            await expect(panel).to_be_visible()
            rect=await panel.bounding_box();assert rect['x']>=-1 and rect['x']+rect['width']<=701 and rect['y']+rect['height']<=701,(theme,rect)
            await page.keyboard.press('Escape')
        await page.evaluate("async()=>{const {getTheme}=await import('/src/themes/registry.ts');(await import('/src/themes/apply.ts')).applyTheme(getTheme('arch'));(await import('/src/stores/hubLinkStore.ts')).useHubLinkStore.setState({known:false,hubUrl:null});window.testStore.setState({quotaState:null});}")
        saved_settings=await page.evaluate('window.testStore.getState().settings')
        await page.evaluate('()=>window.testStore.setState({settings:{enabledProviders:{claude:false,codex:false,cursor:false,ollama:false,llamacpp:false,lmstudio:false,strata:false,deepseek:false}},capabilities:{}})')
        await versions.click()
        await expect(page.get_by_role('dialog',name='Provider versions',exact=True).get_by_text('No provider CLI versions to show.',exact=True)).to_be_visible()
        await page.keyboard.press('Escape')
        await page.evaluate('settings=>window.testStore.setState({settings})',saved_settings)
        await page.set_viewport_size({'width':width,'height':700})
    # Removed controls are gone; the new ones are present.
    for gone in ['COMPUTER', 'MANUAL', 'ARTIFACTS', 'PLANS', 'CONNECTIONS', 'FREE VRAM', 'PROVIDERS']:
        await expect(header.get_by_role('button', name=gone, exact=True)).to_have_count(0)
    for present in ['KNOWLEDGE', 'TOOLS', 'HELP']:
        await expect(header.get_by_role('button', name=present)).to_have_count(1)
    await expect(header.get_by_test_id('voice-mic')).to_be_visible()
    await expect(header.get_by_test_id('connection-light')).to_be_visible()
    await expect(header.get_by_text('ONLINE', exact=True)).to_have_count(0)
    # No horizontal overflow of the header row.
    assert await header.evaluate('el => el.scrollWidth <= el.clientWidth + 1'), 'header overflows'
    await shot('closed')
    # Providers panel opens from a dot; FREE VRAM only with a local runtime.
    await versions.click()
    panel = page.locator('[data-help="header.cli-versions"][role="dialog"]')
    await expect(panel).to_be_visible()
    await expect(panel.get_by_test_id('providers-free-vram')).to_have_count(1 if local else 0)
    await expect(panel.get_by_role('button', name='CONNECTIONS')).to_be_visible()
    await shot('providers')
    await versions.click()
    await expect(panel).to_have_count(0)
    async def menu(label, items, name):
        await header.get_by_role('button', name=label).click()
        for item in items: await expect(page.get_by_role('menuitem', name=item)).to_be_visible()
        await shot(name)
        await page.keyboard.press('Escape')
        await page.mouse.click(5, 600)
        await expect(page.get_by_role('menu')).to_have_count(0)
    await menu('KNOWLEDGE', ['RECALL', 'PLANS', 'ARTIFACTS'], 'knowledge')
    await menu('TOOLS', ['TERMINAL', 'GITHUB', 'MEDIA'], 'tools')
    await menu('HELP', ['POINT AT THINGS', 'USER MANUAL', 'KEYBOARD SHORTCUTS'], 'help')
    await header.get_by_test_id('voice-menu').click()
    items = ['VOICE CONVERSATION AND MEMORY', 'VOICE CONTROLS'] + ([] if voice_ready else ['SET UP VOICE'])
    for item in items: await expect(page.get_by_role('menuitem', name=item)).to_be_visible()
    if voice_ready: await expect(page.get_by_role('menuitem', name='SET UP VOICE')).to_have_count(0)
    await shot('voice')
    await page.keyboard.press('Escape')
    # HELP > POINT AT THINGS enters help mode; the old ? button is not in the bar.
    await header.get_by_role('button', name='HELP').click()
    await page.get_by_role('menuitem', name='POINT AT THINGS').click()
    assert await page.evaluate('() => window.testStore.getState().helpMode') is True
    await page.keyboard.press('Escape')
    await expect(header.get_by_test_id('help-toggle')).to_have_count(0)
    # Order: dots, KNOWLEDGE, TOOLS, VOICE ... BELL, FOCUS, HELP, SETTINGS, version, power.
    order = await header.evaluate("""el => { const q = s => { const n = el.querySelector(s); return n ? n.getBoundingClientRect() : null; };
      return ['[data-providers-cluster]', '[data-help="header.knowledge"]', '[data-help="header.tools"]', '[data-testid="voice-mic"]', '[data-help="header.notifications"]', '[data-help="header.focus"]', '[data-help="header.help"]', '[data-help="header.settings"]', '[data-testid="header-version-box"]', '[data-help="header.power"]'].map(s => { const r = q(s); return r ? [Math.round(r.top / 40), r.left] : null; }); }""")
    assert all(order), order
    flat = [o for o in order if o[0] == order[0][0]]
    if len(flat) == len(order):
        lefts = [o[1] for o in order]
        assert lefts == sorted(lefts), order
    assert not errors, errors
    await context.close(); await browser.close()

async def main():
    async with async_playwright() as p:
        for width in (1440, 900):
            await run(p, width, True, True, SHOTS)
            await run(p, width, False, False, SHOTS)
    print('PASS: VERSIONS panel, hover suppression and layout matrix (FREE VRAM only with a local runtime), KNOWLEDGE/TOOLS/VOICE/HELP menus, removed controls gone, no header overflow at 1440 and 900')

asyncio.run(main())
