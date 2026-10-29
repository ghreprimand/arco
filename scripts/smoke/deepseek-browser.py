"""Real provider controls/version rows against Vite, all APIs/WS intercepted.
Run with ARCO_CLIENT_PORT=5197 ARCO_PORT=6197 npm run dev:client.
"""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect

async def main():
    artifact = Path('/tmp/arco-deepseek-browser')
    artifact.mkdir(exist_ok=True)
    profiles = [dict(id=i, model=f'deepseek-v4.1-flash-1017-{i}', label=f'DeepSeek {i.title()} · Xolotl · 262K',
                     serviceState='inactive', loaded=False, capabilities={'vision': True}) for i in ['exact', 'light']]
    snapshot = dict(managed=True, runtime='Xolotl', baseUrl='http://127.0.0.1:8150/v1', profiles=profiles, live=None)
    writes, errors, github_calls = [], [], []
    upstream = {'sha': '1111111111111111111111111111111111111111'}
    installed = {'strata': '0.1.44.1'}
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME', os.path.expanduser('~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')))
        context = await browser.new_context(viewport={'width': 1200, 'height': 850})
        async def api(route):
            path = urlparse(route.request.url).path
            data = dict(files=[], entries=[], workflows=[], clusters=[], skills=[], projects=[], plans=[], items=[], tasks=[], sessions=[], messages=[], chats=[])
            if path == '/api/deepseek':
                if route.request.method == 'POST':
                    body = route.request.post_data_json
                    writes.append(body)
                    for profile in profiles:
                        profile['loaded'] = body['action'] == 'load' and profile['id'] == body.get('profile')
                        profile['serviceState'] = 'active' if profile['loaded'] else 'inactive'
                    snapshot['live'] = next((dict(model=x['model'], loaded=True) for x in profiles if x['loaded']), None)
                data = snapshot
            elif path == '/api/settings':
                data = dict(themeId='arch', enabledProviders=dict(strata=True, deepseek=True))
            elif path == '/api/auth-status':
                data = {n: dict(loggedIn=False) for n in ['claude', 'codex', 'gemini',  'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'github']}
            elif path == '/api/capabilities':
                data = dict(efforts=['low','medium','high'], models=[], cliVersion='unknown', strataVersion=installed['strata'],
                            xolotlRevision='1111111111111111111111111111111111111111', latestVersions=dict(strata='0.1.45.0', xolotl='2222222222222222222222222222222222222222'))
            elif path.endswith('/catalog'):
                data = dict(models=[])
            await route.fulfill(json=data)
        async def github(route):
            path = urlparse(route.request.url).path
            github_calls.append(path)
            if path.endswith('/Indras-Mirror/Xolotl/releases'):
                data = []
            elif path.endswith('/Indras-Mirror/Xolotl/commits'):
                data = [dict(sha=upstream['sha'], html_url='https://github.com/Indras-Mirror/Xolotl/commit/'+upstream['sha'], commit=dict(message='Fixture source change', committer=dict(date='2026-10-19T00:00:00Z')))]
            elif '/compare/' in path:
                assert path.split('/compare/')[1].split('...')[0] != path.split('...')[1], path
                data = dict(status='ahead', ahead_by=1, commits=[dict(sha=upstream['sha'], html_url='https://github.com/Indras-Mirror/Xolotl/commit/'+upstream['sha'], commit=dict(message='New upstream change', committer=dict(date='2026-10-19T00:00:00Z')))])
            elif path.endswith('/Niko1221/Strata/releases'):
                data = [dict(tag_name='v0.2.0-beta',name='Strata 0.2',html_url='https://github.com/Niko1221/Strata/releases/tag/v0.2.0-beta',published_at='2026-10-19',body='Engine package version 0.1.45.3.\n\nNew app, Terminal and engine.'),dict(tag_name='v0.1.44.1',name='Engine',html_url='https://github.com/Niko1221/Strata/releases',published_at='2026-10-15',body='Older engine release.')]
            else:
                data = [dict(tag_name='v0.40.6',name='Ollama',html_url='https://github.com/ollama/ollama/releases',published_at='2026-10-16',body='Ollama fixture notes.')]
            await route.fulfill(json=data)
        await context.route('https://api.github.com/**', github)
        await context.route('**/api/**', api)
        await context.route_web_socket('**/*', lambda ws: ws.on_message(lambda _: None))
        page = await context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(os.environ.get('ARCO_DEEPSEEK_PREVIEW_URL', 'http://127.0.0.1:5197/'))
        await page.wait_for_timeout(500)
        await page.evaluate('''async () => {
          const loaded = path => performance.getEntriesByType('resource').map(e=>e.name).findLast(url=>new URL(url).pathname===path)??path;
          const ReactModule = await import(loaded('/node_modules/.vite/deps/react.js')); const React=ReactModule.default??ReactModule;
          const Dom = await import(loaded('/node_modules/.vite/deps/react-dom_client.js')); const createRoot=Dom.createRoot??Dom.default.createRoot;
          const {useAppStore:s} = await import(loaded('/src/stores/appStore.ts'));
          const {ProvidersPopover} = await import('/src/components/ProvidersPopover.tsx');
          const {DeepSeekControls} = await import('/src/components/DeepSeekControls.tsx');
          const caps = await (await fetch('/api/capabilities')).json();
          s.setState({capabilities:caps,settings:{enabledProviders:{strata:true,deepseek:true,ollama:true}},ollamaLive:{version:'0.40.6'}});
          document.getElementById('root').style.display='none';
          const root=document.createElement('div');root.id='deepseek-fixture';root.style.cssText='padding:30px;max-width:1000px;margin:auto;';document.body.append(root);
          createRoot(root).render(React.createElement('div',null,React.createElement(ProvidersPopover),React.createElement(DeepSeekControls)));
        }''')
        panel = page.locator('#deepseek-fixture')
        await panel.get_by_role('button', name='PROVIDERS', exact=False).click()
        await expect(panel.get_by_role('button', name='STRATA v0.1.44.1')).to_be_visible()
        await expect(panel.get_by_role('button', name='XOLOTL 111111111111')).to_be_visible()
        await panel.get_by_role('button', name='XOLOTL 111111111111').click()
        modal = page.get_by_role('dialog', name='XOLOTL changes', exact=True)
        await expect(modal).to_be_visible()
        await expect(modal.get_by_text('UP TO DATE', exact=False)).to_be_visible()
        assert not any('/compare/' in p for p in github_calls), github_calls
        await page.screenshot(path=str(artifact / 'xolotl-up-to-date.png'))
        await modal.get_by_role('button', name='CLOSE', exact=True).click()
        upstream['sha'] = '2222222222222222222222222222222222222222'
        await panel.get_by_role('button', name='XOLOTL 111111111111').click()
        await expect(modal.get_by_text('1 upstream commits', exact=False)).to_be_visible()
        await expect(modal.get_by_text('New upstream change', exact=True)).to_be_visible()
        await modal.get_by_role('button', name='CLOSE', exact=True).click()
        await panel.get_by_role('button', name='STRATA v0.1.44.1').click()
        strata = page.get_by_role('dialog', name='STRATA releases', exact=True)
        await expect(strata.get_by_text('engine v0.1.45.3 · release v0.2.0-beta', exact=True)).to_be_visible()
        await expect(strata.get_by_text('[INSTALLED]', exact=True)).to_be_visible()
        await page.screenshot(path=str(artifact / 'strata-releases.png'))
        await strata.get_by_role('button', name='CLOSE', exact=True).click()
        await panel.get_by_role('button', name='OLLAMA v0.40.6').click()
        ollama = page.get_by_role('dialog', name='OLLAMA releases', exact=True)
        await expect(ollama.get_by_text('Ollama fixture notes.', exact=True)).to_be_visible()
        await ollama.get_by_role('button', name='CLOSE', exact=True).click()
        assert len(context.pages) == 1, 'Version rows must not open browser pages'
        await expect(panel.get_by_text('Text + images', exact=False)).to_be_visible()
        await expect(panel.get_by_text('Preserves expert routing', exact=False)).to_be_visible()
        await expect(panel.get_by_text('Biases 0.25 / 0.15', exact=False)).to_be_visible()
        await expect(panel.get_by_role('button', name='UNLOAD · STOP SERVICE')).to_be_disabled()
        await panel.get_by_role('button', name='LOAD EXACT', exact=True).click()
        await expect(panel.get_by_role('button', name='LOAD EXACT', exact=True)).to_be_disabled()
        await expect(panel.get_by_role('button', name='LOAD LIGHT', exact=True)).to_be_enabled()
        await panel.get_by_role('button', name='LOAD LIGHT', exact=True).click()
        await expect(panel.get_by_role('button', name='LOAD LIGHT', exact=True)).to_be_disabled()
        await panel.get_by_role('button', name='UNLOAD · STOP SERVICE').click()
        await expect(panel.get_by_role('button', name='UNLOAD · STOP SERVICE')).to_be_disabled()
        assert writes == [dict(action='load', profile='exact'), dict(action='load', profile='light'), dict(action='unload')], writes
        await panel.get_by_role('button', name='PROVIDERS', exact=False).click()
        await expect(panel.get_by_role('button', name='STRATA v0.1.44.1')).to_be_visible()
        await panel.get_by_role('button', name='PROVIDERS', exact=False).click()
        installed['strata'] = '0.1.45.3'
        await panel.get_by_role('button', name='PROVIDERS', exact=False).click()
        await expect(panel.get_by_role('button', name='STRATA v0.1.45.3')).to_be_visible()
        await page.screenshot(path=str(artifact / 'controls-and-versions.png'))
        assert not errors, errors
        print('PASS: runtime-only label; in-app Ollama/Strata/Xolotl history; matching SHA avoids comparison, distinct SHA shows changes; engine/app versions stay distinct; prepared vision labels and explicit profile controls; no browser popups or GPU access.')
        await browser.close()

asyncio.run(main())
