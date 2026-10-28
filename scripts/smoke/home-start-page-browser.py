"""Home start-page fixtures and visual acceptance. No server or provider access."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright, expect

URL = 'http://127.0.0.1:' + os.environ.get('ARCO_CLIENT_PORT', '5196') + '/'
ART = Path(os.environ.get('ARCO_HOME_VISUAL_ARTIFACTS', '/tmp/arco-home-start-page'))
IDS = ['claude', 'codex', 'gemini', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'antigravity', 'github']


def project(name, folder, index, **extra):
    return {'id': f'00000000-0000-4000-8000-{index:012}', 'name': name, 'path': folder, 'source': 'registered', 'exists': True, **extra}


async def check(browser, scale, populated):
    context = await browser.new_context(viewport={'width': 1280, 'height': 720})
    await context.add_init_script(f"localStorage.setItem('arco_ui_scale', '{scale}');")
    state = {'projects': [project('Harbor', '/projects/harbor', 1, pinned=True), project('Field notes', '/work/field-notes', 2), project('Moved project', '/work/old-location', 3, exists=False), project('Archived toolkit', '/work/toolkit', 4, archived=True)] if populated else [], 'messages': []}
    state['projects'] += [{'name': 'discovered', 'path': '/projects/discovered/sample', 'source': 'scanned', 'exists': True}] if populated else []
    errors, writes = [], []

    async def api(route):
        request = route.request
        path = urlparse(request.url).path
        if request.method != 'GET':
            writes.append(path)
        data = {'files': [], 'workflows': [], 'projects': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'sessions': [], 'chats': [], 'tasks': []}
        if path == '/api/settings':
            data = {'themeId': 'phosphor:arco:electric', 'fontPackId': 'victor-mono', 'textBrightness': 30, 'uiScale': scale, 'onboardingComplete': True, 'enabledProviders': {'claude': True, 'codex': False}}
        elif path == '/api/auth-status':
            data = {provider: {'loggedIn': provider in ['claude', 'codex'] if populated else False} for provider in IDS}
        elif path == '/api/installation-history':
            data = {'used': True}
        elif path == '/api/projects':
            if request.method == 'POST':
                folder = request.post_data_json['path']
                state['projects'].append(project(folder.split('/')[-1], folder, 20))
            data = {'projects': state['projects'], 'organization': True, 'scanFolder': '/projects/discovered' if populated else None, 'homeFolder': '/projects'}
        elif path == '/api/list-dirs':
            folder = parse_qs(urlparse(request.url).query).get('path', ['/projects'])[0] or '/projects'
            data = {'parent': folder, 'dirs': [{'name': 'harbor', 'path': '/projects/harbor'}] if folder == '/projects' else []}
        elif path == '/api/sessions':
            folder = parse_qs(urlparse(request.url).query).get('path', [''])[0]
            data = {'sessions': [{'sessionId': 'saved-fixture-session', 'name': 'Plan the next small release', 'provider': 'claude', 'cwd': folder, 'startedAt': 1793210400000}] if folder == '/projects/harbor' else []}
        elif path == '/api/app/version':
            data = {'version': '0.1.0'}
        elif path == '/api/update-check':
            data = {'current': '0.1.0', 'latest': None, 'url': None, 'publishedAt': None, 'checkedAt': None, 'enabled': False, 'updateAvailable': False}
        elif path.endswith('/catalog'):
            data = {'models': []}
        elif path == '/api/capabilities':
            data = {'efforts': ['low', 'medium', 'high'], 'models': ['sonnet'], 'cliVersion': 'fixture'}
        await route.fulfill(json=data)

    await context.route('**/api/**', api)
    await context.route('**/healthz', lambda route: route.fulfill(json={'status': 'live'}))
    await context.route('https://**/*', lambda route: route.abort())
    await context.route_web_socket('**/*', lambda ws: ws.on_message(lambda message: state['messages'].append(json.loads(message))))
    page = await context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    await page.goto(URL)
    await page.locator('#home-title').wait_for()
    await page.evaluate("async () => { const { useAppStore: s } = await import('/src/stores/appStore.ts'); s.setState({connected:true,connectionState:'online'}); }")
    if populated:
        await page.evaluate('''async () => {
          const { useAppStore: s } = await import('/src/stores/appStore.ts');
          s.getState().createJob('open-fixture', {name:'Review parser changes',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',workingDirectory:'/projects/harbor/src',skipPermissions:false},undefined,undefined,true);
          s.getState().createJob('private-fixture', {kind:'chat',incognito:true,name:'Private fixture conversation',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',workingDirectory:'',skipPermissions:false},undefined,undefined,true);
          s.getState().showHomeView();
        }''')
        await expect(page.get_by_role('heading', name='Open work (1)', exact=False)).to_be_visible()
        await expect(page.locator('.home-work-details small')).to_contain_text('Harbor')
        await expect(page.get_by_role('button', name='Resume Plan the next small release', exact=True)).to_be_visible()
        await expect(page.get_by_text('1 provider ready', exact=False)).to_be_visible()
        await expect(page.get_by_text('Private fixture conversation', exact=True)).to_have_count(0)
        assert not await page.get_by_role('listitem', name='Project discovered', exact=True).count()
    else:
        await expect(page.get_by_role('heading', name='No projects yet', exact=True)).to_be_visible()
        await expect(page.get_by_text('No provider connected', exact=False)).to_be_visible()
    assert await page.locator('#home-add').count() == 0
    await expect(page.get_by_role('button', name='Arco v0.1.0', exact=True)).to_be_visible()
    assert await page.locator('.home-page').evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
    await page.wait_for_timeout(1500)
    await page.locator('.home-page').evaluate('(el) => el.scrollTop = 0')
    await page.screenshot(animations='disabled', path=str(ART / f'{"populated" if populated else "empty"}-{round(scale * 100)}.png'))
    if populated:
        await page.locator('.home-project-card').first.evaluate("el => el.scrollIntoView({block:'start'})")
        await page.wait_for_timeout(500)
        await page.screenshot(animations='disabled', path=str(ART / f'populated-projects-{round(scale * 100)}.png'))
        await page.locator('section[aria-labelledby="home-group-registered"] .home-project-card').first.evaluate("el => el.scrollIntoView({block:'start'})")
        await page.screenshot(animations='disabled', path=str(ART / f'recent-projects-{round(scale * 100)}.png'))
    # A cached update is visible only while release notices remain enabled.
    await page.evaluate("""async () => {
      const {useAppUpdateStore:u} = await import('/src/stores/appUpdateStore.ts');
      u.setState({status:{current:'0.1.0',latest:'v0.2.0',enabled:true,updateAvailable:true,url:null,publishedAt:null,checkedAt:null}});
    }""")
    await expect(page.get_by_role('button', name='Arco v0.1.0 / Update available', exact=True)).to_be_visible()
    await page.evaluate("""async () => { const {useAppStore:s} = await import('/src/stores/appStore.ts'); s.setState({settings:{...s.getState().settings,updateCheck:false}}); }""")
    await expect(page.get_by_role('button', name='Arco v0.1.0', exact=True)).to_be_visible()
    # Add is explicit, keyboard reachable, and works for arbitrary paths.
    await page.get_by_role('button', name='Add project', exact=True).click()
    dialog = page.get_by_role('dialog', name='Add project', exact=True)
    await expect(dialog).to_be_visible()
    await expect(page.locator('#home-add')).to_be_focused()
    assert await dialog.evaluate('(el) => el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().bottom <= innerHeight + 1')
    await page.locator('#home-add').fill('/work/shared/notes')
    await dialog.get_by_role('button', name='Add', exact=True).click()
    await expect(dialog.locator('#home-add-status')).to_have_text('Added /work/shared/notes.')
    await page.keyboard.press('Escape')
    await expect(dialog).to_have_count(0)
    await expect(page.get_by_role('button', name='Add project', exact=True)).to_be_focused()
    assert [path for path in writes if path != '/api/session'] == ['/api/projects'], writes
    assert not any(message.get('type') in ('create_workflow', 'send_prompt', 'create_cluster') for message in state['messages'])
    assert not errors, errors
    await context.close()
    print(f'PASS: {"populated" if populated else "empty"} Home at {round(scale * 100)}%, 1280x720; bounded cards/dialog, status, explicit folder registration, keyboard focus, no implicit work')


async def main():
    ART.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        for scale in [1.1, 1.5]:
            for populated in [False, True]:
                await check(browser, scale, populated)
        await browser.close()


asyncio.run(main())
