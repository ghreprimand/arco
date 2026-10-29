"""Named roots across Settings, Home, creator and setup. Isolated fixture server only."""
import asyncio
import importlib.util
import json
import os
import re
from pathlib import Path
from playwright.async_api import async_playwright, expect

spec = importlib.util.spec_from_file_location('root_harness', Path(__file__).with_name('connections-browser.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
ART = Path(os.environ.get('ARCO_ROOT_VISUAL_ARTIFACTS', '/tmp/arco-project-roots'))

class Server(h.IsolatedServer):
    def extra_settings(self):
        return {'defaultWorkingDirectory': '', 'projectRoots': [], 'projects': [str(self.projects / 'app')], 'onboardingComplete': True}

async def api(page, path, patch=None):
    return await page.evaluate('''async ({path, patch}) => {
      const res = await fetch(path, patch === null ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});
      const body = await res.json(); if (!res.ok) throw new Error(JSON.stringify(body)); return body;
    }''', {'path': path, 'patch': patch})

async def home(page):
    await page.get_by_role('button', name=re.compile('^Home:')).click()
    await page.locator('#home-title').wait_for()

async def main():
    ART.mkdir(parents=True, exist_ok=True)
    server = Server(f'http://127.0.0.1:{h.host_isolation.closed_port()}')
    work, personal, outside = server.root / 'work', server.root / 'personal', server.root / 'outside'
    for folder in [work / 'alpha', work / 'team' / 'tool', personal / 'notes', outside / 'one-off']:
        folder.mkdir(parents=True, exist_ok=True)
    b = None
    try:
        async with async_playwright() as p:
            b = h.Browser(p, server)
            page = await b.open()
            await home(page)
            await page.goto(server.base + '/#settings/projects/projects')
            settings = page.get_by_role('dialog', name='Settings', exact=True)
            for name, folder in [('Work', work), ('Personal', personal), ('Team', work / 'team'), ('Offline', server.root / 'offline')]:
                await page.get_by_role('button', name='Add location', exact=True).click()
                await page.get_by_label('Location name', exact=True).fill(name)
                await page.get_by_label('Location folder path', exact=True).fill(str(folder))
                await page.get_by_role('button', name='Add location', exact=True).click()
                await expect(page.get_by_role('button', name=f'Edit location {name}', exact=True)).to_be_visible()
            await page.get_by_role('button', name='Edit location Work', exact=True).click()
            await page.get_by_label('Location name', exact=True).fill('Workspaces')
            await page.get_by_role('button', name='Save location', exact=True).click()
            await expect(page.get_by_role('button', name='Edit location Workspaces', exact=True)).to_be_visible()
            assert (await api(page, '/api/projects'))['roots'][0]['path'] == str(work)
            await page.get_by_role('button', name='Edit location Workspaces', exact=True).click()
            await page.get_by_label('Location name', exact=True).fill('Work')
            await page.get_by_role('button', name='Save location', exact=True).click()
            await expect(page.get_by_role('button', name='Edit location Work', exact=True)).to_be_visible()
            await page.get_by_text('Advanced folder options',exact=True).click()
            await page.get_by_label('Browsing folder path', exact=True).fill(str(outside))
            await page.get_by_role('button', name='Save browsing location', exact=True).click()
            await page.wait_for_timeout(300)
            body = await api(page, '/api/projects')
            assert len(body['roots']) == 4
            assert next(x for x in body['projects'] if x['path'] == str(work / 'team' / 'tool'))['rootPath'] == str(work / 'team')
            assert not any(x['path'] == str(outside / 'one-off') for x in body['projects'])
            assert not next(root for root in body['roots'] if root['name'] == 'Offline')['exists']
            for scale in [1.1, 1.5]:
                # The production build applies the saved scale on the next reload too.
                await api(page, '/api/settings', {'uiScale': scale})
                await page.reload()
                await settings.wait_for()
                await expect(page.get_by_role('button', name='Close settings', exact=True)).to_be_visible()
                assert await settings.evaluate('(el) => el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= innerWidth + 1')
                await page.screenshot(path=str(ART / f'roots-settings-{round(scale*100)}.png'))
            await page.get_by_role('button', name='Close settings', exact=True).click()
            await home(page)
            await expect(page.get_by_role('heading', name=re.compile(r'^Work.*1 folder'))).to_be_visible()
            await expect(page.get_by_role('heading', name=re.compile(r'^Other projects.*1'))).to_be_visible()
            await page.get_by_label('Search folders (press /)', exact=True).fill('notes')
            personal_group = page.locator('section[aria-labelledby="home-group-root-1"]')
            await expect(personal_group.get_by_role('button', name='notes Open folder', exact=True)).to_be_visible()
            await page.get_by_label('Search folders (press /)', exact=True).fill('')
            print('PASS: named/nested/missing roots in Settings and Home; browsing default independent; cross-root search')

            # Hold discovery while typing: loading never chooses or overwrites cwd.
            release = asyncio.Event()
            async def hold(route):
                await release.wait(); await route.continue_()
            await page.route('**/api/projects', hold)
            await page.get_by_role('button', name='New session', exact=True).click()
            field = page.get_by_placeholder('Pick a project below, or type a folder path', exact=True)
            await expect(field).to_have_value('')
            await field.fill(str(outside / 'one-off'))
            release.set()
            await page.get_by_label('Project location', exact=True).select_option(str(work))
            await expect(field).to_have_value(str(outside / 'one-off'))
            await page.unroute('**/api/projects', hold)
            await page.get_by_role('button', name='Browse this location', exact=True).click()
            browser = page.locator('.first-run-browser')
            await expect(browser.get_by_label('Browse folder path', exact=True)).to_have_value(str(work))
            await browser.get_by_label('Browse folder path', exact=True).fill(str(outside))
            await browser.get_by_role('button', name='Go', exact=True).click()
            await expect(browser.get_by_role('button', name='one-off/', exact=True)).to_be_visible()
            await browser.get_by_label('New folder name', exact=True).fill('fresh-session')
            await browser.get_by_role('button', name='+ FOLDER', exact=True).click()
            await browser.get_by_role('button', name='fresh-session/', exact=True).click()
            await browser.get_by_role('button', name='Use for this session', exact=True).click()
            await expect(field).to_have_value(str(outside / 'fresh-session'))
            stored = await api(page, '/api/settings')
            assert stored['projects'] == [str(server.projects / 'app')]
            await page.get_by_role('button', name='Keep current folder', exact=True).click()
            await expect(page.get_by_role('button', name='Keep current folder', exact=True)).to_have_count(0)
            assert (await api(page, '/api/settings'))['projects'] == [str(server.projects / 'app'), str(outside / 'fresh-session')]
            await home(page)
            # Explicit caller prefill survives project loading and root filtering.
            await page.get_by_role('button', name='New session in app', exact=True).click()
            await expect(field).to_have_value(str(server.projects / 'app'))
            await page.get_by_label('Project location', exact=True).select_option(str(personal))
            await expect(field).to_have_value(str(server.projects / 'app'))
            print('PASS: no implicit cwd, typed/prefilled selections survive loading, one-off browser/create destination and explicit Keep')

            await home(page)
            await page.goto(server.base + '/#settings/projects/projects')
            before = await api(page, '/api/settings')
            await page.get_by_role('button', name='Run setup again', exact=True).click()
            await page.get_by_role('button', name='Get started', exact=True).click()
            summary = page.get_by_label('Setup folder choices', exact=True)
            await expect(summary.get_by_text('Work', exact=True)).to_be_visible()
            await page.get_by_label('Location name', exact=True).fill('Extra')
            await page.get_by_label('Location folder path', exact=True).fill(str(outside))
            await page.get_by_role('button', name='Add location', exact=True).click()
            await expect(summary.get_by_text('Extra', exact=True)).to_be_visible()
            await expect(page.get_by_role('heading', name='Add project locations', exact=True)).to_be_visible()
            await page.get_by_role('button',name='Add a single project folder',exact=True).click()
            await page.get_by_label('Project folder path', exact=True).fill(str(personal / 'notes'))
            await page.get_by_role('button', name='Add folder', exact=True).click()
            await expect(summary).to_contain_text(str(personal / 'notes'))
            for scale in [1.1, 1.5]:
                await page.evaluate('value => {document.documentElement.style.setProperty("--ui-scale", String(value));document.documentElement.style.zoom=String(value);}', scale)
                await page.get_by_role('button', name='Continue', exact=True).scroll_into_view_if_needed()
                await expect(page.get_by_role('button', name='Continue', exact=True)).to_be_visible()
                assert await page.locator('.first-run-dialog').evaluate('(el) => el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().bottom <= innerHeight + 1')
                await page.screenshot(path=str(ART / f'roots-setup-{round(scale*100)}.png'))
            await page.get_by_role('button', name='Continue', exact=True).click()
            await page.get_by_role('button', name='SKIP FOR NOW', exact=True).click()
            await expect(page.get_by_role('heading', name='Setup complete', exact=True)).to_be_visible()
            await expect(page.get_by_label('Chat folder', exact=True)).to_have_value(str(personal / 'notes'))
            await page.get_by_role('button', name='Go to Home', exact=True).click()
            after = await api(page, '/api/settings')
            assert all(root in after['projectRoots'] for root in before['projectRoots'])
            assert all(folder in after['projects'] for folder in before['projects'])
            assert after['defaultWorkingDirectory'] == before['defaultWorkingDirectory']
            assert after['onboardingComplete'] is True
            assert not (server.home / '.arco' / 'trust.json').exists()
            assert not any(json.loads(frame).get('type') in ['create_workflow', 'create_cluster', 'send_prompt'] for frame in await page.evaluate('window.__sent'))
            assert not b.errors, b.errors
            print('PASS: multi-add setup stays on folder step, rerun preserves earlier roots/projects/settings and launches nothing')
            added = await api(page, '/api/projects', {'path': str(work / 'alpha')})
            alpha = next(p for p in added['projects'] if p['path'] == str(work / 'alpha'))
            await page.get_by_role('button', name=re.compile('SETTINGS')).click()
            await page.get_by_role('button', name='Projects', exact=True).click()
            await page.get_by_role('button', name='Remove location Work', exact=True).click()
            await expect(page.get_by_role('button', name='Remove location Work', exact=True)).to_have_count(0)
            removed = await api(page, '/api/projects')
            kept = next(p for p in removed['projects'] if p['path'] == str(work / 'alpha'))
            assert kept['id'] == alpha['id'] and kept['source'] == 'registered' and not kept.get('rootPath')
            assert (work / 'alpha').is_dir()
            print('PASS: root name editing preserves path/order; removing a root retains explicit projects and their identity')
    finally:
        if b: await b.close()
        server.close()

asyncio.run(main())
