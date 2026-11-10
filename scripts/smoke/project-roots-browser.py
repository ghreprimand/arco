"""Named roots across Settings, Home, creator and setup. Isolated fixture server only."""
import os as _artifact_os
import tempfile as _artifact_tempfile
_artifact_root = _artifact_tempfile.TemporaryDirectory(prefix='arco-browser-artifacts-')
import asyncio
import importlib.util
import json
import os
import re
from pathlib import Path
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()

def same_path(actual, expected):
    """True when both paths are the same folder after symlink resolution."""
    return os.path.realpath(actual) == os.path.realpath(expected)

def same_paths(actuals, expecteds):
    return [os.path.realpath(p) for p in actuals] == [os.path.realpath(p) for p in expecteds]

async def expect_path(locator, expected):
    await expect(locator).to_be_visible()
    actual = await locator.input_value()
    assert same_path(actual, expected), (actual, expected)

def card_for(page, folder):
    # The card title and the fixture folder are compared after resolution, and the
    # locator stays live so a later search can show that this card is gone.
    return page.locator('.home-project-card').filter(has=page.get_by_title(os.path.realpath(folder), exact=True))

async def select_folder(locator, folder):
    # Option values are the stored paths. Resolution makes a symlinked temporary
    # directory match, and select_option waits until that option exists.
    await locator.select_option(os.path.realpath(folder))

spec = importlib.util.spec_from_file_location('root_harness', Path(__file__).with_name('connections-browser.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
ART = Path(os.environ.get('ARCO_ROOT_VISUAL_ARTIFACTS', _artifact_os.path.join(_artifact_root.name, 'arco-project-roots')))

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
    old_history, new_history, temp_history = server.root / 'used-old', server.root / 'used-new', server.tmp / 'excluded'
    for folder, at in [(old_history, 100), (new_history, 200), (temp_history, 300)]:
        meta = folder / '.arco' / 'workflows' / 'fixture'
        meta.mkdir(parents=True, exist_ok=True)
        (meta / 'meta.json').write_text(json.dumps({'workflowId':'fixture','name':'Fixture','cwd':str(folder),'createdAt':1,'lastActiveAt':at,'cliSessions':[]}))
    (server.home / '.arco' / 'known-cwds.json').write_text(json.dumps([str(server.projects / 'app'), str(old_history), str(new_history), str(server.root / 'missing'), str(temp_history)]))
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
            assert same_path((await api(page, '/api/projects'))['roots'][0]['path'], work)
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
            assert same_path(next(x for x in body['projects'] if same_path(x['path'], work / 'team' / 'tool'))['rootPath'], work / 'team')
            assert not any(same_path(x['path'], outside / 'one-off') for x in body['projects'])
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
            locations = page.get_by_label('Location', exact=True)
            for name in ['Work', 'Personal', 'Team', 'Offline (unavailable)']:
                await expect(locations.locator('option', has_text=name)).to_have_count(1)
            work_card = card_for(page, work / 'alpha')
            notes_card = card_for(page, personal / 'notes')
            await expect(work_card).to_contain_text('Location: Work')
            await expect(notes_card).to_contain_text('Location: Personal')
            await page.get_by_label('Search folders (press /)', exact=True).fill('notes')
            await expect(notes_card.get_by_role('button', name='New session in notes', exact=True)).to_be_visible()
            await expect(work_card).to_have_count(0)
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
            await select_folder(page.get_by_label('Project location', exact=True), work)
            choice_names = await page.get_by_role('list', name='Project choices').locator('strong').all_text_contents()
            assert choice_names == ['alpha', 'team'], choice_names
            await expect_path(field, outside / 'one-off')
            await page.unroute('**/api/projects', hold)
            await page.get_by_role('button', name='Browse this location', exact=True).click()
            browser = page.locator('.first-run-browser')
            await expect_path(browser.get_by_label('Browse folder path', exact=True), work)
            await browser.get_by_label('Browse folder path', exact=True).fill(str(outside))
            await browser.get_by_role('button', name='Go', exact=True).click()
            await expect(browser.get_by_role('button', name='one-off/', exact=True)).to_be_visible()
            await browser.get_by_label('New folder name', exact=True).fill('fresh-session')
            await browser.get_by_role('button', name='+ FOLDER', exact=True).click()
            await browser.get_by_role('button', name='fresh-session/', exact=True).click()
            await browser.get_by_role('button', name='Use for this session', exact=True).click()
            await expect_path(field, outside / 'fresh-session')
            stored = await api(page, '/api/settings')
            assert same_paths(stored['projects'], [server.projects / 'app'])
            await page.get_by_role('button', name='Bookmark folder', exact=True).click()
            await expect(page.get_by_role('button', name='Bookmark folder', exact=True)).to_have_count(0)
            assert same_paths((await api(page, '/api/settings'))['projects'], [server.projects / 'app', outside / 'fresh-session'])
            await home(page)
            # Explicit caller prefill survives project loading and root filtering.
            await page.get_by_role('button', name='New session in app', exact=True).click()
            await expect_path(field, server.projects / 'app')
            await select_folder(page.get_by_label('Project location', exact=True), personal)
            await expect_path(field, server.projects / 'app')
            # The creator makes a new folder in the selected location, without reusing an existing name.
            await page.get_by_role('button', name='+ NEW FOLDER', exact=True).click()
            assert await page.locator('[data-help="creator.new-folder-form"]').evaluate('el => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= innerWidth + 1')
            await expect_path(page.get_by_label('New folder location', exact=True), personal)
            folder_name = page.get_by_label('New folder name', exact=True)
            await folder_name.fill('bad/name')
            await page.get_by_role('button', name='CREATE FOLDER', exact=True).click()
            await expect(page.get_by_role('alert')).to_contain_text('without path separators')
            await folder_name.fill('notes')
            await page.get_by_role('button', name='CREATE FOLDER', exact=True).click()
            await expect(page.get_by_role('alert')).to_contain_text('already exists')
            await folder_name.fill('new project')
            await page.get_by_role('button', name='CREATE FOLDER', exact=True).click()
            await expect(page.get_by_label('New folder name', exact=True)).to_have_count(0)
            await expect_path(field, personal / 'new project')
            assert (personal / 'new project').is_dir()
            mkdir_entered, mkdir_release = asyncio.Event(), asyncio.Event()
            async def hold_mkdir(route):
                mkdir_entered.set()
                await mkdir_release.wait()
                await route.continue_()
            await page.route('**/api/mkdir', hold_mkdir)
            await page.get_by_role('button', name='+ NEW FOLDER', exact=True).click()
            await page.get_by_label('New folder name', exact=True).fill('delayed project')
            await page.get_by_role('button', name='CREATE FOLDER', exact=True).click()
            await asyncio.wait_for(mkdir_entered.wait(), 5)
            await field.fill(str(outside / 'one-off'))
            mkdir_release.set()
            await expect(page.get_by_role('alert')).to_contain_text('project selection changed')
            await expect_path(field, outside / 'one-off')
            assert (personal / 'delayed project').is_dir()
            await page.unroute('**/api/mkdir', hold_mkdir)
            await page.get_by_role('button', name='CANCEL', exact=True).click()
            await page.get_by_label('Project location', exact=True).select_option('all')
            await page.get_by_role('button', name='+ NEW FOLDER', exact=True).click()
            await expect_path(page.get_by_label('New folder location', exact=True), work)
            await page.get_by_role('button', name='CANCEL', exact=True).click()
            await page.get_by_role('button', name='CLUSTER', exact=False).click()
            await select_folder(page.get_by_label('Project location', exact=True), work)
            await page.get_by_role('button', name='+ NEW FOLDER', exact=True).click()
            await page.get_by_label('New folder name', exact=True).fill('cluster project')
            await page.get_by_role('button', name='CREATE FOLDER', exact=True).click()
            await expect(page.get_by_label('New folder name', exact=True)).to_have_count(0)
            await expect_path(field, work / 'cluster project')
            assert (work / 'cluster project').is_dir()
            (personal / 'new project').rmdir()
            (personal / 'delayed project').rmdir()
            (work / 'cluster project').rmdir()
            print('PASS: no implicit cwd, typed/prefilled selections survive loading, one-off browser/create destination and explicit Bookmark folder')

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
            await page.locator('.first-run-path').get_by_role('button', name='Bookmark folder', exact=True).click()
            folder = personal / 'notes'
            await expect(summary).to_contain_text(re.compile('|'.join(re.escape(text) for text in dict.fromkeys([os.path.realpath(folder), str(folder)]))))
            for scale in [1.1, 1.5]:
                await page.evaluate('value => {document.documentElement.style.setProperty("--ui-scale", String(value));document.documentElement.style.zoom=String(value);}', scale)
                await page.get_by_role('button', name='Continue', exact=True).scroll_into_view_if_needed()
                await expect(page.get_by_role('button', name='Continue', exact=True)).to_be_visible()
                assert await page.locator('.first-run-dialog').evaluate('(el) => el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().bottom <= innerHeight + 1')
                await page.screenshot(path=str(ART / f'roots-setup-{round(scale*100)}.png'))
            await page.get_by_role('button', name='Continue', exact=True).click()
            await page.get_by_role('button', name='SKIP FOR NOW', exact=True).click()
            await expect(page.get_by_role('heading', name='Setup complete', exact=True)).to_be_visible()
            await expect_path(page.get_by_label('Chat folder', exact=True), personal / 'notes')
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
            alpha = next(p for p in added['projects'] if same_path(p['path'], work / 'alpha'))
            await page.get_by_role('button', name=re.compile('SETTINGS')).click()
            await page.get_by_role('button', name='Projects', exact=True).click()
            await page.get_by_role('button', name='Remove location Work', exact=True).click()
            await expect(page.get_by_role('button', name='Remove location Work', exact=True)).to_have_count(0)
            removed = await api(page, '/api/projects')
            kept = next(p for p in removed['projects'] if same_path(p['path'], work / 'alpha'))
            assert kept['id'] == alpha['id'] and kept['source'] == 'registered' and not kept.get('rootPath')
            assert (work / 'alpha').is_dir()
            print('PASS: root name editing preserves path/order; removing a root retains explicit projects and their identity')

            # A project location may itself be a repository while containing projects.
            repo = server.root / 'repository-location'
            for folder in [repo / '.git', repo / 'child-one', repo / 'child-two']:
                folder.mkdir(parents=True, exist_ok=True)
            (repo / '.git' / 'config').write_text('[remote "origin"]\nurl = https://example.invalid/team/fixture-repository.git\n')
            current = await api(page, '/api/settings')
            await api(page, '/api/settings', {'projectRoots': [*current['projectRoots'], {'name': 'Repository location', 'path': str(repo)}]})
            await page.get_by_role('button', name='Close settings', exact=True).click()
            await home(page)
            await page.get_by_role('button', name='Reload list', exact=True).click()
            await page.get_by_label('Location', exact=True).select_option(label='Repository location')
            for label in ['repository-location', 'child-one', 'child-two']:
                await expect(page.get_by_role('button', name=f'New session in {label}', exact=True)).to_be_visible()
            await expect(page.locator('.home-project-card')).to_have_count(3)
            await page.get_by_role('button', name='New session in repository-location', exact=True).click()
            await expect_path(field, repo)
            workflow_name = page.locator('[data-help="creator.name"] input')
            await expect(workflow_name).to_have_value('repository-location')
            choices = page.get_by_role('list', name='Project choices')
            await expect(choices.get_by_role('button', name=re.compile('child-one'))).to_be_visible()
            await expect(choices.get_by_role('button', name=re.compile('child-two'))).to_be_visible()
            await workflow_name.fill('Custom name')
            await choices.get_by_role('button', name=re.compile('child-one')).click()
            await expect(workflow_name).to_have_value('Custom name')
            await page.get_by_label('Project location', exact=True).select_option('all')
            names = await choices.locator('strong').all_text_contents()
            assert names == sorted(names, key=str.casefold), names
            assert 'fixture-repository' not in names and 'used-old' not in names and 'used-new' not in names
            await page.get_by_label('Project location', exact=True).select_option('recent')
            recent_names = await choices.locator('strong').all_text_contents()
            assert recent_names[:2] == ['used-new', 'used-old'], recent_names
            assert 'excluded' not in recent_names
            assert await choices.get_by_text('Missing', exact=True).count() == 0
            print('PASS: repository location and children appear alphabetically with folder names; recently used is separate')

            for i in range(18):
                await api(page, '/api/project-trust', {'cwd': str(server.root / f'trust-{i:02}'), 'decision': 'always'})
            await page.goto(server.base + '/#settings/projects/project-trust')
            trust_list = page.get_by_role('region', name='Trust decisions')
            await expect(trust_list).to_be_visible()
            await expect(trust_list.locator('code')).to_have_count(18)
            assert await trust_list.evaluate('(el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === "auto"')
            await page.get_by_label('Search trust decisions').fill('trust-17')
            await expect(trust_list.locator('code')).to_have_count(1)
            await expect(trust_list.locator('code')).to_contain_text('trust-17')
            print('PASS: trust decisions scroll in their own area and search filters by path')

            old = server.root / 'relocate-old'
            new = server.root / 'relocate-new'
            old.mkdir()
            await api(page, '/api/projects', {'path': str(old)})
            old.rename(new)
            missing_entry = next(item for item in (await api(page, '/api/projects'))['projects'] if same_path(item['path'], old))
            assert not missing_entry['exists'] and missing_entry.get('id'), missing_entry
            await page.goto(server.base + '/#settings/projects/projects')
            await page.reload()
            await page.get_by_text(re.compile(r'^Bookmarked folders')).click()
            available = page.locator('details').filter(has=page.locator('summary').filter(has_text=re.compile(r'^Other available folders'))).last
            await available.locator('summary').click()
            assert await available.get_by_title(str(old_history), exact=True).count() == 0
            assert await available.get_by_title(str(new_history), exact=True).count() == 0
            assert await available.get_by_title(str(temp_history), exact=True).count() == 0
            row = page.get_by_title(str(old), exact=True).locator('..')
            await expect(row.get_by_text('MISSING', exact=True)).to_be_visible()
            await row.get_by_text('Relocate', exact=True).click()
            await row.get_by_label('New folder path').fill(str(new))
            await row.get_by_role('button', name='Save new location').click()
            await expect(page.get_by_title(str(new), exact=True)).to_be_visible()
            assert str(new) in (await api(page, '/api/settings'))['projects']
            print('PASS: a missing bookmark can be relocated from Settings')

            await api(page, '/api/settings', {'projectRoots': [], 'projects': []})
            await page.get_by_role('button', name='Close settings', exact=True).click()
            await page.reload()
            await home(page)
            await page.get_by_label('Location', exact=True).select_option('recent')
            await expect(page.get_by_role('button', name='New session in used-new', exact=True)).to_be_visible()
            await expect(page.get_by_role('button', name='New session in used-old', exact=True)).to_be_visible()
            print('PASS: Home offers recently used folders without locations or bookmarks')
            await page.wait_for_timeout(1000)
    finally:
        if b: await b.close()
        server.close()

asyncio.run(main())
