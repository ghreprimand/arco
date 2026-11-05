"""Outputs: name click previews or opens in the default app, OPEN, refused types, missing files. Opener is a stub route; nothing launches."""
import asyncio
import os
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
URL = 'http://127.0.0.1:' + os.environ.get('ARCO_CLIENT_PORT', '5201') + '/'
A = '11111111-2222-4333-8444-555555555555'
CWD = '/projects/harbor'

def output(id, name, category, **extra):
    return {'id': id * 32, 'name': name, 'title': name, 'path': CWD + '/' + name, 'originPath': CWD + '/' + name, 'category': category, 'workflowId': A, 'cwd': CWD, 'producer': 'Producer A', 'createdAt': 1793210000000, 'updatedAt': 1793210000000, 'size': 12, 'source': 'artifact', **extra}

async def main():
    state = {'outputs': [output('b', 'report.md', 'documents'), output('c', 'brief.pdf', 'documents'), output('d', 'setup.exe', 'other'), output('e', 'lost.pdf', 'documents', missing=True)], 'opens': [], 'desktop': True, 'text': 'Synthetic report'}
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        context = await browser.new_context(viewport={'width': 1280, 'height': 720})
        async def api(route):
            req = route.request; path = urlparse(req.url).path; query = parse_qs(urlparse(req.url).query)
            data = {'files': [], 'projects': [], 'workflows': [], 'clusters': [], 'skills': [], 'sessions': [], 'tasks': [], 'items': []}
            if path == '/api/settings': data = {'themeId': 'phosphor:arco:electric', 'uiScale': 1.1, 'onboardingComplete': True, 'enabledProviders': {'claude': True}, 'projectRoots': []}
            elif path == '/api/auth-status': data = {name: {'loggedIn': name == 'claude'} for name in ['claude','codex','ollama','cursor','strata','deepseek','llamacpp','lmstudio','github']}
            elif path == '/api/installation-history': data = {'used': True}
            elif path == '/api/projects': data = {'projects': [], 'roots': [], 'organization': True}
            elif path == '/api/outputs': data = {'outputs': state['outputs'], 'desktopOpen': state['desktop'], 'refusedExtensions': ['exe', 'bat', 'sh']}
            elif path == '/api/outputs/content': data = {'type': 'text', 'content': state['text'], 'size': len(state['text'])}
            elif path == '/api/outputs/open':
                body = req.post_data_json; state['opens'].append(body['id'])
                await route.fulfill(json={'ok': True}); return
            elif path == '/api/update-check': data = {'current':'0.1.0','latest':None,'enabled':False,'updateAvailable':False}
            elif path == '/api/app/version': data = {'version':'0.1.0'}
            await route.fulfill(json=data)
        await context.route('**/api/**', api)
        await context.route('https://**/*', lambda route: route.abort())
        await context.route('**/healthz', lambda route: route.fulfill(json={'status':'live'}))
        await context.route_web_socket('**/*', lambda ws: ws.on_message(lambda msg: None))
        page = await context.new_page(); errors = []
        page.on('pageerror', lambda err: errors.append(str(err)))
        await page.goto(URL); await page.locator('#home-title').wait_for()
        await page.evaluate('''async ({a,cwd}) => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {OutputsPanel} = await import('/src/components/RightPanel/OutputsPanel.tsx');
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          s.getState().createJob(a,{name:'Producer A',workingDirectory:cwd,primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',skipPermissions:false},undefined,undefined,true);
          s.setState({connected:true,connectionState:'online'}); s.getState().setActiveJob(a); document.getElementById('root').style.display='none';
          const host = document.createElement('div'); host.style.cssText='position:fixed;left:8px;top:8px;width:420px;height:90vh;background:var(--color-bg-panel)'; document.body.appendChild(host);
          createRoot(host).render(React.createElement(OutputsPanel,{cwd,workflowId:a}));
        }''', {'a': A, 'cwd': CWD})
        panel = page.get_by_role('region', name='Workspace Outputs', exact=True)
        item = lambda name: panel.get_by_role('listitem').filter(has=page.get_by_text(name, exact=True))
        # Previewable name opens the viewer, not the opener.
        await item('report.md').get_by_test_id('output-name').click()
        await expect(page.get_by_text('Synthetic report', exact=True)).to_be_visible()
        assert state['opens'] == []
        await page.keyboard.press('Escape')
        # PDF has no Preview button; its name and OPEN reach the opener.
        await expect(item('brief.pdf').get_by_role('button', name='Preview', exact=True)).to_have_count(0)
        await item('brief.pdf').get_by_test_id('output-name').click()
        await expect(panel.get_by_role('status').filter(has_text='Opened brief.pdf')).to_be_visible()
        await item('brief.pdf').get_by_test_id('output-open').click()
        assert state['opens'] == ['c' * 32, 'c' * 32], state['opens']
        # Refused type: no OPEN, name click explains, nothing is sent.
        await expect(item('setup.exe').get_by_test_id('output-open')).to_have_count(0)
        await item('setup.exe').get_by_test_id('output-name').click()
        await expect(panel.get_by_role('alert')).to_contain_text('Use Download instead')
        assert state['opens'] == ['c' * 32, 'c' * 32]
        await expect(item('setup.exe').get_by_role('button', name='Download', exact=True)).to_be_visible()
        # Missing file: OPEN disabled and the name is not a link.
        await expect(item('lost.pdf').get_by_test_id('output-open')).to_be_disabled()
        await expect(item('lost.pdf').get_by_test_id('output-name')).to_have_count(0)
        # No desktop: OPEN hidden, Download stays.
        state['desktop'] = False
        await panel.get_by_role('button', name='Refresh', exact=True).click()
        await expect(panel.get_by_test_id('output-open')).to_have_count(0)
        await expect(item('brief.pdf').get_by_role('button', name='Download', exact=True)).to_be_visible()
        assert not errors, errors
        await context.close(); await browser.close()
        print('PASS: name click previews or opens by default app, OPEN, refused types explained, missing file disabled, OPEN hidden without a desktop')

asyncio.run(main())
