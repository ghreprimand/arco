"""Browser acceptance for project identity, organization and folder recovery on Home.

Isolated server (throwaway HOME and project folders, provider-CLI stubs, empty
network namespace where available - see host_isolation.py), an in-process
Ollama-protocol fixture as the only model endpoint, no credentials, no real
model. Reuses the harness of connections-browser.py; needs Playwright and
a built client/dist.

Scenarios:
  1  pin and rename survive a reload and a server restart; the record file keeps
     one stable id per project; nothing is launched
  2  archive moves a project out of the main lists, Show archived brings it back,
     Unarchive restores it
  3  Remove from list asks first, says files are not touched, forgets only the
     registration and leaves the folder and its file in place
  4  a moved folder shows Folder not found with start actions disabled; a bad
     relocation says why and changes nothing; Relocate keeps the name, pin and id,
     registers the new folder in place, lists sessions saved under the old
     location without Resume, and never lists the old path again
  5  Create makes one empty folder at an explicit path or inside the scan folder;
     existing targets and unsafe names are refused; an absolute path needs no scan folder
  6  the filesystem root and the home folder cannot be added
  7  an unreadable record file is reported, left untouched, and disables only the
     organization controls
"""
import asyncio
import importlib.util
import json
import re
import subprocess
import sys
import time
import traceback
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('workbench_harness', HERE / 'connections-browser.py')
h = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(h)
h.MODEL = "fixture-model:latest"

class HomeServer(h.IsolatedServer):
    def extra_settings(self): return {'defaultWorkingDirectory': '', 'projects': [str(self.projects / 'app')]}

h.IsolatedServer = HomeServer

OLD_SESSION = '0a0b0c0d-1111-4222-8333-444455556666'
OLD_TITLE = 'Draft the sample landing page'


def records(server):
    path = server.home / '.arco' / 'projects.json'
    return json.loads(path.read_text())['records'] if path.exists() else []


def settings_projects(server):
    return json.loads((server.home / '.arco' / 'settings.json').read_text()).get('projects', [])


def restart(server):
    """Stop the isolated server and start it again on the same HOME and port."""
    server.proc.terminate()
    server.proc.wait(timeout=30)
    server.proc = subprocess.Popen(
        ['node', '--conditions', 'development', '--import', 'tsx', 'server/src/index.ts'],
        cwd=h.REPO, env=server.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 90
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f'{server.base}/readyz', timeout=2) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.3)
    raise RuntimeError('restarted server never became ready')


async def open_home(playwright, server):
    b = h.Browser(playwright, server)
    page = await b.open()
    await page.get_by_role('button', name=re.compile('^Home:')).click()
    await page.get_by_role('heading', name='HOME', exact=True).wait_for(timeout=5000)
    await page.get_by_role('button', name='Reload list').click()
    await page.wait_for_timeout(300)
    return b, page


def card(page, label):
    return page.get_by_role('listitem', name=f'Project {label}', exact=True)


async def group_names(page, group_key):
    """Group identity survives Classic's transient heading-text reveal."""
    return await page.evaluate("""(key) => {
      const heading = document.getElementById(`home-group-${key}`);
      if (!heading) return null;
      return [...heading.closest('section').querySelectorAll('li[aria-label^="Project "]')].map((li) => li.getAttribute('aria-label').slice(8));
    }""", group_key)


async def status_text(page):
    return await page.locator('main [role="status"]').first.inner_text()


async def add_folder(page, path):
    if not await page.locator('#home-add').is_visible(): await page.get_by_role('button', name='Add project', exact=True).click()
    await page.locator('#home-add').fill(str(path))
    await page.get_by_role('button', name='Add', exact=True).click()
    await page.wait_for_function("document.querySelector('#home-add-status').innerText !== ''", timeout=10000)
    result = await page.locator('#home-add-status').inner_text()
    await page.get_by_role('button', name='Close Add project', exact=True).click()
    return result


async def manage(page, label, missing=False):
    """Open the project's Manage panel (left open if it already is)."""
    button = page.get_by_role('button', name=f'{"Relocate or manage" if missing else "Manage"} {label}', exact=True)
    if await button.get_attribute('aria-expanded') != 'true':
        await button.click()


async def launched(page):
    return await page.evaluate("() => window.__sent.filter((s) => s.includes('create_workflow') || s.includes('create_cluster')).length")


async def scenario_pin_rename_persist(playwright, server):
    b, page = await open_home(playwright, server)
    try:
        before = {r['path']: r['id'] for r in records(server)}
        app = str(server.projects / 'app')
        assert app in before, f'no record minted for the registered project: {list(before)}'
        await page.get_by_role('button', name='Pin app', exact=True).click()
        await page.wait_for_function("() => !!document.getElementById('home-group-pinned')", timeout=10000)
        assert await group_names(page, 'pinned') == ['app']
        await manage(page, 'app')
        await page.get_by_label('Display name').fill('Budget tracker')
        await page.get_by_role('button', name='Save name').click()
        await card(page, 'Budget tracker').wait_for(timeout=10000)
        assert 'Renamed to Budget tracker.' in await status_text(page)
        assert await launched(page) == 0
    finally:
        await b.close()
    restart(server)
    b, page = await open_home(playwright, server)
    try:
        await card(page, 'Budget tracker').wait_for(timeout=10000)
        assert await group_names(page, 'pinned') == ['Budget tracker']
        assert await card(page, 'Budget tracker').get_by_text('Folder name: app').count() == 1
        after = {r['path']: r['id'] for r in records(server)}
        assert after[app] == before[app], 'the project id changed across a restart'
        # Back to the folder name and unpinned.
        await manage(page, 'Budget tracker')
        await page.get_by_label('Display name').fill('')
        await page.get_by_role('button', name='Save name').click()
        await card(page, 'app').wait_for(timeout=10000)
        await page.get_by_role('button', name='Unpin app', exact=True).click()
        await page.wait_for_function("() => !document.getElementById('home-group-pinned')", timeout=10000)
        assert await launched(page) == 0
    finally:
        await b.close()


async def scenario_archive(playwright, server):
    folder = server.projects / 'archive-me'
    folder.mkdir()
    b, page = await open_home(playwright, server)
    try:
        assert (await add_folder(page, folder)).startswith('Added')
        await manage(page, 'archive-me')
        await page.get_by_role('button', name='Archive', exact=True).click()
        await page.get_by_role('button', name='Show archived (1)').wait_for(timeout=10000)
        assert await card(page, 'archive-me').count() == 0, 'an archived project is still in the main lists'
        await page.get_by_role('button', name='Show archived (1)').click()
        assert await group_names(page, 'archived') == ['archive-me']
        await manage(page, 'archive-me')
        await page.get_by_role('button', name='Unarchive', exact=True).click()
        await page.wait_for_function("() => !document.getElementById('home-group-archived')", timeout=10000)
        await page.get_by_role('heading', name=re.compile(r'^Other projects')).wait_for()
        assert 'archive-me' in await group_names(page, 'registered')
        assert folder.is_dir()
    finally:
        await b.close()


async def scenario_remove(playwright, server):
    folder = server.projects / 'remove-me'
    folder.mkdir()
    (folder / 'keep.txt').write_text('synthetic content')
    b, page = await open_home(playwright, server)
    try:
        assert (await add_folder(page, folder)).startswith('Added')
        await manage(page, 'remove-me')
        await page.get_by_role('button', name='Remove from list...').click()
        group = page.get_by_role('group', name='Confirm removing remove-me')
        await group.get_by_text('Files are not touched.').wait_for(timeout=5000)
        await group.get_by_role('button', name='Cancel').click()
        assert str(folder) in settings_projects(server), 'Cancel removed the project'
        await page.get_by_role('button', name='Remove from list...').click()
        await page.get_by_role('group', name='Confirm removing remove-me').get_by_role('button', name='Remove from list').click()
        await page.wait_for_function("() => !document.querySelector('li[aria-label=\"Project remove-me\"]')", timeout=10000)
        assert 'Its files were not touched.' in await status_text(page)
        assert str(folder) not in settings_projects(server)
        assert (folder / 'keep.txt').read_text() == 'synthetic content'
        # A scanned or recent project explains why it can only be archived.
        await manage(page, 'app')
        assert await page.get_by_role('button', name='Remove from list...').count() == 1, 'registered app offers removal'
    finally:
        await b.close()


async def scenario_relocate(playwright, server):
    old = server.root / 'elsewhere' / 'client-site'
    new = server.root / 'elsewhere' / 'client-site-2026'
    old.mkdir(parents=True)
    (old / 'notes.txt').write_text('synthetic notes')
    # A saved provider session recorded under the old folder.
    claude_dir = server.home / '.claude' / 'projects' / re.sub(r'[^A-Za-z0-9-]', '-', str(old))
    claude_dir.mkdir(parents=True, exist_ok=True)
    (claude_dir / f'{OLD_SESSION}.jsonl').write_text(json.dumps(
        {'type': 'user', 'timestamp': '2026-10-01T10:00:00Z', 'message': {'content': OLD_TITLE}}) + '\n')
    b, page = await open_home(playwright, server)
    try:
        assert (await add_folder(page, old)).startswith('Added')
        await page.get_by_role('button', name='Pin client-site', exact=True).click()
        # Pinning moves the card to the Pinned group, which remounts it; open Manage only afterwards.
        await page.wait_for_function("() => !!document.getElementById('home-group-pinned')", timeout=15000)
        assert await group_names(page, 'pinned') == ['client-site']
        await manage(page, 'client-site')
        await page.get_by_label('Display name').fill('Client site')
        await page.get_by_role('button', name='Save name').click()
        await card(page, 'Client site').wait_for(timeout=10000)
        project_id = next(r['id'] for r in records(server) if r['path'] == str(old))
        order = settings_projects(server)
        old.rename(new)
        await page.get_by_role('button', name='Reload list').click()
        missing = card(page, 'Client site')
        await missing.get_by_text('Folder not found').wait_for(timeout=10000)
        for name in ('New session in Client site', 'New cluster in Client site', 'Show saved sessions for Client site'):
            assert await page.get_by_role('button', name=name).is_disabled(), f'{name} is enabled for a missing folder'
        await manage(page, 'Client site', missing=True)
        move = page.get_by_label('New folder location')
        for bad in (str(server.root / 'elsewhere' / 'nowhere'), '/'):
            await move.fill(bad)
            await page.get_by_role('button', name='Relocate', exact=True).click()
            await missing.get_by_role('alert').filter(has_text='Not changed:').wait_for(timeout=10000)
            assert settings_projects(server) == order, 'a refused relocation changed the registration'
        await move.fill(str(new))
        await page.get_by_role('button', name='Relocate', exact=True).click()
        moved = card(page, 'Client site')
        await moved.get_by_text(f'Moved from {old}').wait_for(timeout=10000)
        assert await page.get_by_role('button', name='New session in Client site').is_enabled()
        assert await group_names(page, 'pinned') == ['Client site']
        assert next(r for r in records(server) if r['id'] == project_id)['path'] == str(new), 'relocation changed the project id'
        assert settings_projects(server) == [str(new) if p == str(old) else p for p in order], 'registration not replaced in place'
        listed = await page.evaluate("() => fetch('/api/projects').then((r) => r.json()).then((j) => j.projects.map((p) => p.path))")
        assert str(old) not in listed, 'the old location is listed again on its own'
        assert (new / 'notes.txt').read_text() == 'synthetic notes'
        # Sessions saved under the old location stay listed, read-only.
        await page.get_by_role('button', name='Show saved sessions for Client site').click()
        earlier = page.get_by_role('list', name=f'Saved sessions from {old}')
        await earlier.get_by_text(OLD_TITLE).wait_for(timeout=15000)
        assert await earlier.get_by_role('button').count() == 0, 'a session from the old location offers Resume'
        assert await launched(page) == 0
    finally:
        await b.close()


async def scenario_create(playwright, server):
    scan = server.home / 'Projects'
    b, page = await open_home(playwright, server)
    try:
        if not await page.locator('#home-add').is_visible(): await page.get_by_role('button', name='Add project', exact=True).click()
        if not await page.locator('#home-create').is_visible(): await page.get_by_text('Create a new project folder', exact=True).first.click()
        assert await page.locator('#home-create').is_enabled(), 'Absolute folder creation needs no scan folder'
        explicit = server.root / 'explicit-created'
        if not await page.locator('#home-add').is_visible(): await page.get_by_role('button', name='Add project', exact=True).click()
        if not await page.locator('#home-create').is_visible(): await page.get_by_text('Create a new project folder', exact=True).first.click()
        await page.locator('#home-create').fill(str(explicit))
        await page.get_by_role('button', name='Create', exact=True).click()
        await page.wait_for_function("document.querySelector('#home-create-status').innerText.startsWith('Created and added')")
        assert explicit.is_dir() and not any(explicit.iterdir())
    finally:
        await b.close()
    scan.mkdir()
    b, page = await open_home(playwright, server)
    await page.evaluate("""async root => { const res = await fetch('/api/settings', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({defaultWorkingDirectory:root})}); if (!res.ok) throw new Error('scan setting refused'); }""", str(scan))
    await page.get_by_role('button', name='Reload list').click()
    try:
        if not await page.locator('#home-add').is_visible(): await page.get_by_role('button', name='Add project', exact=True).click()
        if not await page.locator('#home-create').is_visible(): await page.get_by_text('Create a new project folder', exact=True).first.click()
        await page.locator('#home-create').fill('new-idea')
        await page.get_by_role('button', name='Create', exact=True).click()
        await page.wait_for_function("document.querySelector('#home-create-status').innerText.startsWith('Created and added')", timeout=10000)
        assert (scan / 'new-idea').is_dir() and not any((scan / 'new-idea').iterdir())
        assert 'new-idea' in await group_names(page, 'registered')
        for name, expect in (('new-idea', 'already exists'), ('../escape', 'folder name')):
            if not await page.locator('#home-add').is_visible(): await page.get_by_role('button', name='Add project', exact=True).click()
            if not await page.locator('#home-create').is_visible(): await page.get_by_text('Create a new project folder', exact=True).first.click()
            await page.locator('#home-create').fill(name)
            await page.get_by_role('button', name='Create', exact=True).click()
            await page.wait_for_function("document.querySelector('#home-create-status').innerText.startsWith('Not created')", timeout=10000)
            assert expect in await page.locator('#home-create-status').inner_text()
        assert not (server.home / 'escape').exists() and not (server.root / 'escape').exists()
    finally:
        await b.close()


async def scenario_refused_roots(playwright, server):
    b, page = await open_home(playwright, server)
    try:
        for path in ('/', str(server.home)):
            message = await add_folder(page, path)
            assert message.startswith('Not added:') and len(message) > 20, f'{path}: {message!r}'
        assert '/' not in settings_projects(server) and str(server.home) not in settings_projects(server)
    finally:
        await b.close()


async def scenario_unreadable_store(playwright, server):
    path = server.home / '.arco' / 'projects.json'
    good = path.read_text()
    path.write_text('{"version": 1, "records": [')
    try:
        b, page = await open_home(playwright, server)
        try:
            await page.get_by_role('alert').filter(has_text='project record file could not be read').wait_for(timeout=10000)
            await card(page, 'app').wait_for(timeout=5000)
            for name in ('Pin app', 'Unpin app', 'Manage app'):
                assert await page.get_by_role('button', name=name, exact=True).count() == 0, f'{name} offered without a record store'
            assert await page.get_by_role('button', name='New session in app').is_enabled()
            assert path.read_text() == '{"version": 1, "records": [', 'the unreadable file was rewritten'
        finally:
            await b.close()
    finally:
        path.write_text(good)


async def main():
    if not (h.REPO / 'client' / 'dist' / 'index.html').exists():
        sys.exit('client/dist is missing; run npm run build first')
    model = h.FakeModel()
    server = h.IsolatedServer(model.url)
    failures = []
    try:
        async with h.async_playwright() as playwright:
            for label, run in (
                ('pin and rename survive reload and restart with a stable id', lambda: scenario_pin_rename_persist(playwright, server)),
                ('archive hides, Show archived reveals, Unarchive restores', lambda: scenario_archive(playwright, server)),
                ('Remove from list confirms and leaves files in place', lambda: scenario_remove(playwright, server)),
                ('missing folder relocation keeps identity and lists earlier sessions', lambda: scenario_relocate(playwright, server)),
                ('create a folder in the scan folder; refusals', lambda: scenario_create(playwright, server)),
                ('the filesystem root and home folder cannot be added', lambda: scenario_refused_roots(playwright, server)),
                ('an unreadable record file disables organization only', lambda: scenario_unreadable_store(playwright, server)),
            ):
                if len(sys.argv) > 1 and sys.argv[1].lower() not in label.lower():
                    continue
                try:
                    await asyncio.wait_for(run(), 180)
                    print(f'PASS: {label}')
                except BaseException as error:
                    failures.append(label)
                    where = traceback.extract_tb(error.__traceback__)[-1] if error.__traceback__ else None
                    print(f'FAIL: {label}: {type(error).__name__}: {str(error)[:700]}' + (f' (project-organization-browser.py:{where.lineno}: {where.line})' if where else ''))
    finally:
        server.close()
        model.close()
    if failures:
        sys.exit(f'project organization acceptance failed: {len(failures)}')
    print('PASS: project organization acceptance')


asyncio.run(main())
