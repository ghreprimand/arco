"""Media-folder grants and revocation through Settings against an isolated server.

Uses temporary homes and synthetic files, denying provider stubs and closed local
endpoints. No provider credentials or model calls. Requires a built client,
Python Playwright and ARCO_TEST_CHROME when its default browser is unavailable.
"""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

from playwright.async_api import async_playwright
from host_isolation import closed_port, enter_isolated_network, harden

REPO = Path(__file__).resolve().parents[2]


async def check_browser(base, folder):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        try:
            context = await browser.new_context(viewport={'width': 1400, 'height': 1000})
            async def local_only(route):
                if route.request.url.startswith(base + '/'):
                    await route.continue_()
                else:
                    await route.abort()
            await context.route('**/*', local_only)
            page = await context.new_page()
            await page.goto(base)
            await page.locator('[data-help="header.settings"]').click(timeout=30000)
            section = page.locator('section[data-help="settings.media-unconfined"]')
            await section.wait_for()
            assert await section.locator('[data-media-access-state="confined"]').count() == 1
            raw = base + '/api/media/raw?' + urllib.parse.urlencode({'path': str(folder / 'sample.txt')})
            assert (await context.request.get(raw)).status == 403
            entry = section.get_by_label('Allowed folder (absolute path on the Arco server)', exact=True)
            await entry.fill('relative-folder')
            await section.get_by_role('button', name='+ ADD FOLDER', exact=True).click()
            await section.get_by_role('alert').filter(has_text='Use an absolute path').wait_for()
            await entry.fill(str(folder))
            await section.get_by_role('button', name='+ ADD FOLDER', exact=True).click()
            await section.locator('[data-media-access-state="folders-off"]').wait_for()
            assert (await context.request.get(raw)).status == 403
            await section.get_by_role('button', name='OUTSIDE-FOLDER ACCESS OFF', exact=False).click()
            await section.locator('[data-media-access-state="allowed"]').wait_for()
            response = await context.request.get(raw, headers={'Range': 'bytes=0-2'})
            assert response.status == 206
            assert await response.text() == 'fix'
            await section.get_by_role('button', name='REVOKE ALL', exact=True).click()
            await section.locator('[data-media-access-state="confined"]').wait_for()
            assert (await context.request.get(raw)).status == 403
            settings = await (await context.request.get(base + '/api/settings')).json()
            assert settings['mediaUnconfined'] is False
            assert settings['mediaAllowedRoots'] == []
            print('PASS: Settings default confinement, validation, explicit grant, Range read and revocation (8 checks).')
        finally:
            await browser.close()


def main():
    enter_isolated_network()
    with tempfile.TemporaryDirectory(prefix='arco-media-browser-') as temporary:
        root = Path(temporary)
        home, project, media = root / 'home', root / 'project', root / 'media'
        for directory in (home / '.arco', project, media, root / 'tmp', root / 'uploads'):
            directory.mkdir(parents=True, exist_ok=True)
        (media / 'sample.txt').write_text('fixture-body')
        (home / '.arco/settings.json').write_text(json.dumps({'defaultWorkingDirectory': str(project)}))
        port = closed_port()
        base = f'http://127.0.0.1:{port}'
        env = harden({
            'HOME': str(home), 'ARCO_HOME': str(home / '.arco'), 'TMPDIR': str(root / 'tmp'),
            'ARCO_PORT': str(port), 'ARCO_HOST': '127.0.0.1', 'ARCO_SERVE_CLIENT': '1',
            'ARCO_UPLOADS_DIR': str(root / 'uploads'),
        }, root)
        with (root / 'server.log').open('w') as log:
            server = subprocess.Popen(['node', '--conditions', 'development', '--import', 'tsx', 'server/src/index.ts'], cwd=REPO, env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    if server.poll() is not None:
                        raise RuntimeError('isolated server exited before readiness')
                    try:
                        with urllib.request.urlopen(base + '/readyz', timeout=1) as response:
                            if response.status == 200:
                                break
                    except Exception:
                        time.sleep(0.1)
                else:
                    raise RuntimeError('isolated server readiness timed out')
                asyncio.run(check_browser(base, media))
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)


if __name__ == '__main__':
    main()
