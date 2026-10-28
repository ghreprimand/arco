"""Browser acceptance: a relocation must not leave saved sessions from the old folder resumable in the new one.

Isolated server (throwaway HOME and folders, provider-CLI stubs, empty network namespace where
available), an in-process model fixture as the only endpoint, no credentials, no real model. Reuses
the harness of connections-browser.py; needs Playwright and a built client/dist.

Scenarios (both use a session saved under the old folder, the Home card for the project, and an
external move of the folder followed by Relocate to the same project id):
  1  the saved-session list was expanded and loaded BEFORE the move: after Relocate the old
     session is not offered for Resume in the new folder
  2  the saved-session request for the old folder is still in flight when Relocate completes: the
     late reply is not shown as a resumable session in the new folder
In both, the session may be listed read-only under the previous location, nothing is launched.
"""
import asyncio
import importlib.util
import json
import re
import sys
import traceback
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('workbench_harness', HERE / 'connections-browser.py')
h = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(h)
h.MODEL = "fixture-model:latest"

class HomeServer(h.IsolatedServer):
    def extra_settings(self): return {'defaultWorkingDirectory': '', 'projects': [str(self.projects / 'app')]}

h.IsolatedServer = HomeServer

OLD_SESSION = '0a0b0c0d-1111-4222-8333-444455556666'
OLD_TITLE = 'Draft the stale landing page'


def records(server):
    path = server.home / '.arco' / 'projects.json'
    return json.loads(path.read_text())['records'] if path.exists() else []


def save_session(server, folder):
    claude_dir = server.home / '.claude' / 'projects' / re.sub(r'[^A-Za-z0-9-]', '-', str(folder))
    claude_dir.mkdir(parents=True, exist_ok=True)
    (claude_dir / f'{OLD_SESSION}.jsonl').write_text(json.dumps(
        {'type': 'user', 'timestamp': '2026-10-01T10:00:00Z', 'message': {'content': OLD_TITLE}}) + '\n')


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


async def add_folder(page, path):
    await page.get_by_role('button', name='Add project', exact=True).click()
    await page.locator('#home-add').fill(str(path))
    await page.get_by_role('button', name='Add', exact=True).click()
    await page.wait_for_function("document.querySelector('#home-add-status').innerText !== ''", timeout=10000)
    result = await page.locator('#home-add-status').inner_text()
    await page.get_by_role('button', name='Close Add project', exact=True).click()
    return result


async def launched(page):
    return await page.evaluate("() => window.__sent.filter((s) => s.includes('create_workflow') || s.includes('create_cluster')).length")


async def resumable(page, label):
    """Resume buttons the project card offers for the old session."""
    return await card(page, label).get_by_role('button', name=re.compile('^Resume')).count()


async def relocate_in_ui(page, label, new):
    await page.get_by_role('button', name='Reload list').click()
    await card(page, label).get_by_text('Folder not found').wait_for(timeout=10000)
    await page.get_by_role('button', name=f'Relocate or manage {label}', exact=True).click()
    await page.get_by_label('New folder location').fill(str(new))
    await page.get_by_role('button', name='Relocate', exact=True).click()
    # The card is labelled by the folder name unless the project has a display name.
    await card(page, new.name).get_by_text('Moved from ').wait_for(timeout=10000)


async def scenario_loaded_before_move(playwright, server):
    old = server.root / 'elsewhere' / 'stale-loaded'
    new = server.root / 'elsewhere' / 'stale-loaded-2026'
    old.mkdir(parents=True)
    save_session(server, old)
    b, page = await open_home(playwright, server)
    try:
        assert (await add_folder(page, old)).startswith('Added')
        await page.get_by_role('button', name='Show saved sessions for stale-loaded').click()
        current = page.get_by_role('list', name='Saved sessions in stale-loaded')
        await current.get_by_text(OLD_TITLE).wait_for(timeout=15000)
        assert await resumable(page, 'stale-loaded') == 1, 'sanity: the session is resumable where it was saved'
        old.rename(new)
        await relocate_in_ui(page, 'stale-loaded', new)
        await page.wait_for_timeout(1500)
        offered = await resumable(page, new.name)
        shown_as_current = await page.get_by_role('list', name=f'Saved sessions in {new.name}').count()
        assert offered == 0, f'Resume is still offered for a session saved under the old folder ({offered} button(s), current list shown={shown_as_current})'
        assert await launched(page) == 0
    finally:
        await b.close()


async def scenario_in_flight_during_move(playwright, server):
    old = server.root / 'elsewhere' / 'stale-inflight'
    new = server.root / 'elsewhere' / 'stale-inflight-2026'
    old.mkdir(parents=True)
    save_session(server, old)
    b, page = await open_home(playwright, server)
    release = asyncio.Event()
    held = {'seen': 0}

    async def hold_old(route):
        asked = parse_qs(urlparse(route.request.url).query).get('path', [''])[0]
        if asked == str(old):
            held['seen'] += 1
            await release.wait()
        await route.continue_()

    try:
        # Cards request previews as soon as they mount. Hold that first request,
        # before adding the project, so relocation still races an old-path reply.
        await page.route('**/api/sessions?path=*', hold_old)
        assert (await add_folder(page, old)).startswith('Added')
        await page.get_by_role('button', name='Show saved sessions for stale-inflight').click()
        for _ in range(50):
            if held['seen']:
                break
            await page.wait_for_timeout(100)
        assert held['seen'], 'the saved-session request for the old folder never started'
        old.rename(new)
        await relocate_in_ui(page, 'stale-inflight', new)
        release.set()
        await page.wait_for_timeout(2000)
        offered = await resumable(page, new.name)
        assert offered == 0, f'a late reply for the old folder is resumable in the new folder ({offered} button(s))'
        assert await launched(page) == 0
    finally:
        release.set()
        await b.close()


async def main():
    if not (h.REPO / 'client' / 'dist' / 'index.html').exists():
        sys.exit('client/dist is missing; run npm run build first')
    model = h.FakeModel()
    server = h.IsolatedServer(model.url)
    failures = []
    try:
        async with h.async_playwright() as playwright:
            for label, run in (
                ('saved sessions loaded before a move are not resumable in the relocated folder', lambda: scenario_loaded_before_move(playwright, server)),
                ('a saved-session reply that lands after Relocate is not resumable in the relocated folder', lambda: scenario_in_flight_during_move(playwright, server)),
            ):
                if len(sys.argv) > 1 and sys.argv[1].lower() not in label.lower():
                    continue
                try:
                    await asyncio.wait_for(run(), 120)
                    print(f'PASS: {label}')
                except BaseException as error:
                    failures.append(label)
                    where = traceback.extract_tb(error.__traceback__)[-1] if error.__traceback__ else None
                    print(f'FAIL: {label}: {type(error).__name__}: {str(error)[:700]}' + (f' (project-relocate-stale-browser.py:{where.lineno})' if where else ''))
    finally:
        server.close()
        model.close()
    if failures:
        sys.exit(f'stale relocation acceptance failed: {len(failures)}')
    print('PASS: stale relocation acceptance')


asyncio.run(main())
