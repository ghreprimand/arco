"""Home start-page fixtures and visual acceptance. No server or provider access."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright, expect
from home_controls import open_saved_project_form

URL = 'http://127.0.0.1:' + os.environ.get('ARCO_CLIENT_PORT', '5196') + '/'
ART = Path(os.environ.get('ARCO_HOME_VISUAL_ARTIFACTS', '/tmp/arco-home-start-page'))
IDS = ['claude', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'github']


def project(name, folder, index, **extra):
    return {'id': f'00000000-0000-4000-8000-{index:012}', 'name': name, 'path': folder, 'source': 'registered', 'exists': True, **extra}


async def check(browser, scale, scenario):
    populated = scenario == 'populated'
    discovery = scenario in ['discovery', 'multiple']
    context = await browser.new_context(viewport={'width': 1280, 'height': 720}, device_scale_factor=2 if scale == 1.0 else 1)
    await context.add_init_script(f"localStorage.setItem('arco_ui_scale', '{scale}');")
    state = {'projects': [project('Harbor', '/projects/harbor', 1, pinned=True), project('Field notes', '/work/field-notes', 2), project('Moved project', '/work/old-location', 3, exists=False), project('Archived toolkit', '/work/toolkit', 4, archived=True)] if populated else [], 'messages': []}
    state['projects'] += [{'name': 'discovered', 'path': '/projects/discovered/sample', 'source': 'scanned', 'exists': True}] if populated else []
    roots = [{'name': 'Work', 'path': '/projects', 'exists': True}, {'name': 'Personal', 'path': '/work', 'exists': True}, {'name': 'Offline drive', 'path': '/offline', 'exists': False}] if populated or discovery else []
    if populated or discovery:
        names = ['api-service','design-studio','render-tools','research-notes','utilities','web-client'] + [f'workspace-{i:03}' for i in range(6,151)]
        state['projects'] = [p for p in state['projects'] if p['source'] != 'scanned'] + [{'name':name, 'path':'/projects/'+name, 'source':'scanned', 'exists':True} for name in names]
        for p in state['projects']:
            p['rootPath'] = '/projects' if p['path'].startswith('/projects/') else '/work'
    if scenario == 'discovery': roots = roots[:1]
    if scenario == 'multiple': state['projects'] += [{'name':'api-service', 'path':'/work/api-service', 'source':'scanned', 'exists':True, 'rootPath':'/work'}, {'name':'personal-1', 'path':'/work/personal-1', 'source':'scanned', 'exists':True, 'rootPath':'/work'}]
    errors, writes = [], []

    async def api(route):
        request = route.request
        path = urlparse(request.url).path
        if request.method != 'GET':
            writes.append(path)
        data = {'files': [], 'workflows': [], 'projects': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'sessions': [], 'chats': [], 'tasks': []}
        if path == '/api/settings':
            data = {'themeId': 'phosphor:arco:electric', 'fontPackId': 'victor-mono', 'textBrightness': 30, 'uiScale': scale, 'projectRoots': roots, 'onboardingComplete': True, 'enabledProviders': {'claude': True, 'codex': False}}
        elif path == '/api/auth-status':
            data = {provider: {'loggedIn': provider in ['claude', 'codex'] if populated else False} for provider in IDS}
        elif path == '/api/installation-history':
            data = {'used': True}
        elif path == '/api/projects':
            if request.method == 'POST':
                folder = request.post_data_json['path']
                state['projects'].append(project(folder.split('/')[-1], folder, 20))
            data = {'roots': roots, 'projects': state['projects'], 'organization': True, 'scanFolder': '/projects/discovered' if populated else None, 'homeFolder': '/projects'}
        elif path == '/api/list-dirs':
            folder = parse_qs(urlparse(request.url).query).get('path', ['/projects'])[0] or '/projects'
            data = {'parent': folder, 'dirs': [{'name':p['name'], 'path':p['path']} for p in state['projects'] if p['exists'] and p['path'].rsplit('/',1)[0] == folder]}
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
    await expect(page.get_by_role('main',name='ARCO',exact=True)).to_be_visible()
    await page.locator('#home-title').focus()
    await expect(page.locator('#home-title')).to_be_focused()
    assert await page.locator('#home-title').evaluate("el => { const root=document.documentElement, family=root.getAttribute('data-theme-family'), before=root.getAttribute('data-phosphor-effects'); root.setAttribute('data-theme-family','phosphor'); root.setAttribute('data-phosphor-effects','off'); const off=getComputedStyle(el).textShadow; const crisp=root.getAttribute('data-crisp'); root.setAttribute('data-phosphor-effects','on'); root.setAttribute('data-crisp','1'); const sharp=getComputedStyle(el).textShadow; if (crisp === null) root.removeAttribute('data-crisp'); else root.setAttribute('data-crisp',crisp); if (family === null) root.removeAttribute('data-theme-family'); else root.setAttribute('data-theme-family',family); if (before === null) root.removeAttribute('data-phosphor-effects'); else root.setAttribute('data-phosphor-effects',before); return off === 'none' && sharp === 'none'; }")
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
        await expect(page.get_by_role('heading', name='Project locations', exact=True)).to_be_visible()
        await expect(page.get_by_role('heading',name='No saved projects yet',exact=True)).to_have_count(0)
        await expect(page.get_by_text('No provider connected', exact=False)).to_be_visible()
    if scenario == 'multiple':
        await expect(page.get_by_role('button',name='Open api-service / projects')).to_be_visible()
        await expect(page.get_by_role('button',name='Open api-service / work')).to_be_visible()
        await expect(page.get_by_text('/work/api-service',exact=True)).to_be_visible()
    if discovery:
        group = page.locator('section[aria-labelledby="home-group-root-0"]')
        await expect(group.get_by_role('heading')).to_contain_text('151 folders')
        assert await group.locator('.home-folder-list button').count() == 6
        first_label = 'Open api-service / projects' if scenario == 'multiple' else 'Open api-service'
        await expect(group.get_by_role('button',name=first_label,exact=True)).to_be_visible()
        await group.get_by_role('button',name='Show all 151 folders',exact=True).click()
        assert await group.locator('.home-folder-list button').count() == 151
        assert await group.locator('.home-location-folders.expanded').evaluate('el=>el.scrollHeight>el.clientHeight && el.clientHeight>0')
        await group.get_by_role('button',name='Show fewer',exact=True).click()
        assert await group.locator('.home-folder-list button').count() == 6
        await page.get_by_label('Search folders (press /)',exact=True).fill('workspace-150')
        await expect(group.get_by_role('button',name='Open workspace-150',exact=True)).to_be_visible()
        await page.get_by_label('Search folders (press /)',exact=True).fill('Work')
        await expect(group.get_by_role('heading')).to_contain_text('151 folders')
        await page.get_by_label('Search folders (press /)',exact=True).fill('')
        await group.get_by_role('button',name=first_label,exact=True).click()
        await expect(page.get_by_placeholder('Pick a project below, or type a folder path',exact=True)).to_have_value('/projects/api-service')
        await page.evaluate("async()=>{const{useAppStore:s}=await import('/src/stores/appStore.ts');s.getState().showHomeView();}")
        await page.locator('#home-title').wait_for()
        await group.get_by_role('button',name='Browse Work',exact=True).click()
        dialog=page.get_by_role('dialog',name='Open another folder',exact=True)
        await expect(dialog.get_by_label('Browse folder path',exact=True)).to_have_value('/projects')
        for width,height in [(1280,720),(1920,1080),(1920,1200),(2560,1440),(3840,2160)]:
            await page.set_viewport_size({'width':width,'height':height})
            await expect(dialog.get_by_role('button',name='Close folder browser')).to_be_in_viewport()
            await expect(dialog.get_by_role('button',name='Use this folder')).to_be_in_viewport()
            assert await dialog.evaluate('(el) => {const r=el.getBoundingClientRect(); return r.top>=0 && r.left>=0 && r.bottom<=innerHeight+1 && r.right<=innerWidth+1}')
            await page.screenshot(animations='disabled',scale='css',path=str(ART / f'folder-{width}x{height}-{round(scale*100)}.png'))
        await dialog.get_by_role('button',name='Maximize dialog').click()
        await expect(dialog.get_by_role('button',name='Restore dialog size')).to_be_visible()
        await dialog.get_by_role('button',name='Restore dialog size').click()
        resize=dialog.get_by_role('button',name='Resize dialog')
        before=await dialog.bounding_box()
        await resize.focus(); await page.keyboard.press('ArrowRight')
        after=await dialog.bounding_box()
        assert after['width'] > before['width'], (before,after)
        await page.keyboard.press('Home')
        before=await dialog.bounding_box(); handle=await resize.bounding_box()
        await page.mouse.move(handle['x']+handle['width']/2,handle['y']+handle['height']/2)
        await page.mouse.down(); await page.mouse.move(handle['x']+handle['width']/2+30,handle['y']+handle['height']/2+20,steps=4); await page.mouse.up()
        after=await dialog.bounding_box()
        assert after['width'] > before['width'], (before,after)
        await resize.focus(); await page.keyboard.press('Home')
        await dialog.get_by_role('button',name='Maximize dialog').click()
        await page.set_viewport_size({'width':1280,'height':720})
        await expect(dialog.get_by_role('button',name='Close folder browser')).to_be_in_viewport()
        await dialog.get_by_role('button',name='Restore dialog size').click()
        await expect(dialog.get_by_role('button',name='Use this folder')).to_be_in_viewport()
        await page.keyboard.press('Escape')
        await expect(dialog).to_have_count(0)
        # Exercise the standalone media picker, which renders outside the Home dialog.
        await page.set_viewport_size({'width':800,'height':600})
        await page.evaluate("""async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const { DirectoryBrowser } = await import('/src/components/media/DirectoryPicker.tsx');
          const host = document.createElement('div'); host.id = 'standalone-picker-test'; document.body.appendChild(host);
          window.__pickerRoot = createRoot(host);
          window.__pickerRoot.render(React.createElement(DirectoryBrowser, {title:'Fixture picker', onDone:()=>{}}));
        }""")
        picker = page.locator('.glow-border').filter(has=page.get_by_text('FIXTURE PICKER',exact=True))
        await expect(picker).to_be_visible()
        assert await picker.get_by_role('button',name='Maximize dialog').count() == 1
        await picker.get_by_role('button',name='Maximize dialog').click()
        await expect(picker.get_by_role('button',name='Restore dialog size')).to_be_in_viewport()
        await picker.get_by_role('button',name='Restore dialog size').click()
        await expect(picker.get_by_role('button',name='Maximize dialog')).to_be_in_viewport()
        await expect(picker.get_by_role('button',name='SAVE HERE ↵')).to_be_in_viewport()
        resize = picker.get_by_role('button',name='Resize dialog')
        before = await picker.bounding_box()
        await resize.focus(); await page.keyboard.press('ArrowLeft')
        after = await picker.bounding_box()
        assert after['width'] < before['width'], (before, after)
        await page.keyboard.press('Home')
        await page.evaluate("window.__pickerRoot.unmount(); document.getElementById('standalone-picker-test').remove()")
        await page.set_viewport_size({'width':1024,'height':576})
        await page.evaluate("async()=>{const{useAppStore:s}=await import('/src/stores/appStore.ts');s.getState().setShowRecall(true)}")
        recall=page.get_by_role('dialog',name='Recall')
        await expect(recall).to_be_visible()
        await page.wait_for_timeout(300)
        await page.evaluate("""async()=>{const{useRecallStore:s}=await import('/src/stores/recallStore.ts');s.setState({hits:[{wfid:'fixture',title:'Synthetic conversation',project:'Work',provider:'codex',cwd:'/projects',lastActiveAt:1,summaryRef:'summary',snippet:'',matchedIn:'title',tags:[],pinned:false,links:[]}],summaryBodies:{fixture:'Synthetic summary '.repeat(50)}})}""")
        await recall.get_by_role('button',name='OPEN SUMMARY').click()
        await recall.get_by_role('button',name='DISTILL TO KB').click()
        await expect(recall.locator('[data-help="recall.summary-viewer"]')).to_be_visible()
        await expect(recall.locator('[data-help="recall.distill-kb"]')).to_be_visible()
        assert await recall.get_by_role('region',name='Recall results').evaluate('el => el.getBoundingClientRect().height >= 50')
        await recall.get_by_role('button',name='SAVE TO KB').scroll_into_view_if_needed()
        await expect(recall.get_by_role('button',name='SAVE TO KB')).to_be_in_viewport()
        assert await recall.get_by_role('button',name='SAVE TO KB').evaluate("el => {const r=el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))}")
        await recall.get_by_role('button',name='Maximize dialog').click()
        await expect(recall.get_by_role('button',name='Restore dialog size')).to_be_visible()
        await recall.get_by_role('button',name='Restore dialog size').click()
        await page.screenshot(animations='disabled',path=str(ART / f'recall-{round(scale*100)}.png'))
        await recall.get_by_role('button',name='Resize dialog').focus()
        await page.keyboard.press('Escape')
        await expect(recall).to_have_count(0)
        await page.set_viewport_size({'width':1280,'height':720})
        assert not [path for path in writes if path != '/api/session'], writes
    assert await page.locator('#home-add').count() == 0
    await expect(page.get_by_role('button', name='Arco v0.1.0', exact=True)).to_be_visible()
    assert await page.locator('.home-page').evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
    await page.wait_for_timeout(1500)
    await page.locator('.home-page').evaluate('(el) => el.scrollTop = 0')
    await page.screenshot(animations='disabled', path=str(ART / f'{scenario}-{round(scale * 100)}.png'))
    if scenario in ['empty', 'discovery', 'populated']:
        for width,height in [(900,600),(1920,1080),(1920,1200),(3840,2160)]:
            await page.set_viewport_size({'width':width,'height':height})
            assert await page.locator('.home-page').evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
            title = page.locator('#home-title')
            await expect(title).to_be_visible()
            assert await title.evaluate('el => {const r=el.getBoundingClientRect(), p=el.closest(".home-content").getBoundingClientRect(); return Math.abs((r.left+r.right-p.left-p.right)/2)<2 && r.left>=0 && r.right<=innerWidth+1}')
            await expect(page.get_by_role('button',name='Start a chat',exact=True)).to_be_visible()
            if width == 3840:
                assert await page.locator('.home-content').evaluate('el => el.offsetWidth >= 1800 && el.offsetWidth <= 2200')
            await page.screenshot(animations='disabled',scale='css',path=str(ART / f'home-{scenario}-{width}x{height}-{round(scale*100)}.png'))
        await page.set_viewport_size({'width':1280,'height':720})
    if discovery:
        await page.locator('section[aria-labelledby="home-group-root-0"]').scroll_into_view_if_needed()
        await page.screenshot(animations='disabled', path=str(ART / f'discovery-roots-{round(scale * 100)}.png'))
    if populated:
        await page.locator('.home-project-card').first.evaluate("el => el.scrollIntoView({block:'start'})")
        await page.wait_for_timeout(500)
        await page.screenshot(animations='disabled', path=str(ART / f'populated-projects-{round(scale * 100)}.png'))
        await page.locator('section[aria-labelledby="home-group-root-1"] .home-project-card').first.evaluate("el => el.scrollIntoView({block:'start'})")
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
    await open_saved_project_form(page)
    dialog = page.get_by_role('dialog', name='Open another folder', exact=True)
    await expect(dialog).to_be_visible()
    await page.locator('#home-add').focus()
    await expect(page.locator('#home-add')).to_be_focused()
    assert await dialog.evaluate('(el) => el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().bottom <= innerHeight + 1')
    await page.locator('#home-add').fill('/work/shared/notes')
    await dialog.get_by_role('button', name='Bookmark folder', exact=True).click()
    await expect(dialog.locator('#home-add-status')).to_have_text('Bookmarked /work/shared/notes.')
    await page.keyboard.press('Escape')
    await expect(dialog).to_have_count(0)
    await expect(page.get_by_role('button', name='Open another folder', exact=True)).to_be_focused()
    assert [path for path in writes if path != '/api/session'] == ['/api/projects'], writes
    assert not any(message.get('type') in ('create_workflow', 'send_prompt', 'create_cluster') for message in state['messages'])
    if populated and scale == 1.1:
        for retired in ['antigravity', 'gemini']:
            await page.evaluate("""async provider => {
              const {useAppStore:s} = await import('/src/stores/appStore.ts');
              s.setState({settings:{...s.getState().settings, workflowDefaults:{primaryProvider:provider,primaryModel:'historical-model'}}});
              s.getState().openCreatorWith({mode:'chat',provider});
            }""", retired)
            await expect(page.get_by_role('alert').filter(has_text='support has been removed')).to_be_visible()
            picker=page.locator('[data-help="creator.provider"] select')
            await expect(picker).to_have_value(retired)
            await expect(page.get_by_role('button',name='START CHAT',exact=True)).to_be_disabled()
            await picker.select_option('claude')
            await expect(page.get_by_role('button',name='START CHAT',exact=True)).to_be_enabled()
            assert await page.evaluate("""async () => {const {useAppStore:s}=await import('/src/stores/appStore.ts'); return s.getState().settings.workflowDefaults.primaryProvider;}""")==retired
            await page.evaluate("""async () => {const {useAppStore:s}=await import('/src/stores/appStore.ts');s.getState().showHomeView();}""")
        # Replay preserves historical provider identity even when the provider
        # no longer has a current picker entry or provider-specific adapter.
        for provider, label in [('gemini', 'GEMINI'), ('antigravity', 'ANTIGRAVITY'), ('fixture-retired', 'FIXTURE-RETIRED'), ('codex', 'CODEX · OPENAI'), ('llamacpp', 'LLAMA.CPP · LOCAL'), ('ollama', 'OLLAMA · LOCAL')]:
            await page.evaluate("""async provider => {
              const {useAppStore:s}=await import('/src/stores/appStore.ts');
              const {handleServerMessage:replay}=await import('/src/ws/handleServerMessage.ts');
              s.getState().createJob('history-worker-fixture', {name:'Historical worker fixture',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',workingDirectory:'/projects/harbor',skipPermissions:false},undefined,undefined,true);
              const deps={wsRef:{current:null},scheduleReconnect:()=>{}};
              replay({type:'worker_spawned',workflowId:'history-worker-fixture',workerId:'saved-worker',provider,model:'historical-model',effort:'low',task:'Read the saved report'},deps);
              replay({type:'worker_text',workflowId:'history-worker-fixture',workerId:'saved-worker',text:'Preserved worker output'},deps);
              s.getState().setDetailWorker({jobId:'history-worker-fixture',workerId:'saved-worker'});
            }""", provider)
            await expect(page.get_by_text(label, exact=True)).to_be_visible()
            if provider != 'ollama':
                await expect(page.get_by_text('OLLAMA · LOCAL', exact=True)).to_have_count(0)
            await expect(page.get_by_text('Preserved worker output', exact=True)).to_be_visible()
            assert await page.evaluate("""async () => {const {useAppStore:s}=await import('/src/stores/appStore.ts');return s.getState().jobs['history-worker-fixture'].workers['saved-worker'].provider;}""") == provider
            await page.keyboard.press('Escape')
            await expect(page.get_by_text('Preserved worker output', exact=True)).to_have_count(0)
        assert not any(message.get('type') in ('create_workflow','send_prompt','create_cluster') for message in state['messages'])
    assert not errors, errors
    await context.close()
    print(f'PASS: {scenario} Home at {round(scale * 100)}%, 1280x720; bounded cards/dialog, status, explicit folder registration, keyboard focus, no implicit work')


async def main():
    ART.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        for scenario in ['empty', 'discovery', 'populated']:
            await check(browser, 1.0, scenario)
        scenarios = ['discovery'] if os.environ.get('ARCO_HOME_DISCOVERY_ONLY') == '1' else ['empty', 'discovery', 'multiple', 'populated']
        for scale in [1.1, 1.5]:
            for scenario in scenarios:
                await check(browser, scale, scenario)
        await browser.close()


asyncio.run(main())
