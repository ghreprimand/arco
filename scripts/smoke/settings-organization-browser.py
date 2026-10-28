"""Settings organized by task (P3.4) against an isolated server and the built client.

Temporary homes and folders, denying provider stubs, closed local endpoints and
an empty network namespace where available (host_isolation.py). No provider
credentials or model calls. Requires `npm run build`, Python Playwright and
ARCO_TEST_CHROME when its default browser is unavailable.
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
PAGES = ['Appearance', 'Projects', 'Providers and models', 'Agents and clusters', 'Voice', 'Files and media', 'Advanced']


async def visible_sections(dialog):
    return await dialog.locator('[data-settings-section]').evaluate_all(
        "els => els.filter(e => !e.hidden).map(e => [e.dataset.settingsSection, e.querySelector('[data-settings-scope]').textContent])")


async def check_browser(base):
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
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            await page.goto(base)
            opener = page.locator('[data-help="header.settings"]')
            await opener.click(timeout=30000)
            dialog = page.get_by_role('dialog', name='Settings', exact=True)
            nav = dialog.get_by_role('navigation', name='Settings categories')
            assert await nav.get_by_role('button').all_inner_texts() == PAGES
            assert await nav.locator('[aria-current="page"]').inner_text() == 'Appearance'
            mounted = await dialog.locator('[data-settings-section]').count()

            seen = {}
            for label in PAGES:
                await nav.get_by_role('button', name=label, exact=True).click()
                await dialog.get_by_role('heading', name=label, exact=True).wait_for()
                rows = await visible_sections(dialog)
                assert rows, f'{label} shows at least one section'
                for section, scope in rows:
                    assert section not in seen, f'{section} appears in two categories'
                    assert scope.split(',')[0].split(' ')[0] in ('Global', 'Project', 'Workflow'), (section, scope)
                    seen[section] = label
            all_ids = await dialog.locator('[data-settings-section]').evaluate_all('els => els.map(e => e.dataset.settingsSection)')
            assert len(all_ids) == mounted == 21, mounted
            # Only the Phosphor controls are withheld, because the fixture uses a Classic theme.
            assert set(all_ids) - set(seen) == {'phosphor'}, sorted(set(all_ids) - set(seen))
            assert seen['media-access'] == 'Files and media' and seen['voice-setup'] == 'Voice' and seen['authentication'] == 'Providers and models'

            # Hidden sections stay mounted: a draft survives switching categories.
            await nav.get_by_role('button', name='Appearance', exact=True).click()
            operator = dialog.locator('[data-help="settings.operator-name"] input').first
            await operator.fill('Draft name kept')
            await nav.get_by_role('button', name='Advanced', exact=True).click()
            await nav.get_by_role('button', name='Appearance', exact=True).click()
            assert await operator.input_value() == 'Draft name kept'
            await operator.fill('')

            search = dialog.get_by_role('searchbox')
            await search.fill('media folders')
            await dialog.get_by_role('heading', name='Search results', exact=True).wait_for()
            assert [s for s, _ in await visible_sections(dialog)] == ['media-access']
            assert await nav.locator('[aria-current="page"]').count() == 0
            await search.fill('lm studio')
            assert [s for s, _ in await visible_sections(dialog)] == ['authentication']
            await search.fill('no such control anywhere')
            await dialog.get_by_role('status').filter(has_text='No settings match').wait_for()
            assert await visible_sections(dialog) == []
            await search.press('Escape')
            assert await search.input_value() == ''
            await dialog.get_by_role('heading', name='Appearance', exact=True).wait_for()

            help_toggle = dialog.locator('[data-settings-section="media-access"] summary')
            await nav.get_by_role('button', name='Files and media', exact=True).click()
            await help_toggle.click()
            assert 'Media Studio' in await dialog.locator('[data-settings-section="media-access"] .settings-section-help').inner_text()
            assert page.url.endswith('#settings/files')

            await search.press('Escape')
            await dialog.wait_for(state='detached')
            assert not page.url.endswith('#settings/files'), 'closing clears the address'
            assert await page.evaluate("document.activeElement?.getAttribute('data-help')") == 'header.settings', 'focus returns to the opener'

            await page.goto(base + '/#settings/agents/handoff-prompts')
            await dialog.wait_for()
            assert await nav.locator('[aria-current="page"]').inner_text() == 'Agents and clusters'
            await page.get_by_role('button', name='Close settings', exact=True).click()
            await page.goto(base + '/#settings/voice/media-access')
            await page.wait_for_timeout(800)
            assert await dialog.count() == 0, 'a section on the wrong category is not opened'

            await page.set_viewport_size({'width': 390, 'height': 844})
            await page.goto(base + '/#settings/providers')
            await dialog.wait_for()
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'no horizontal overflow at 390 px'
            assert not errors, errors
            print(f'PASS: seven categories, {len(seen)} sections each in one category with a scope label, drafts kept across categories, search by label and help, Escape, help disclosure, addresses, focus return, 390 px layout.')
        finally:
            await browser.close()


def main():
    enter_isolated_network()
    with tempfile.TemporaryDirectory(prefix='arco-settings-browser-') as temporary:
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
            'ARCO_PORT': str(port), 'ARCO_HOST': '127.0.0.1',
            'ARCO_UPLOADS_DIR': str(root / 'uploads'),
        }, root)
        env['ARCO_SERVE_CLIENT'] = '1'
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
                asyncio.run(check_browser(base))
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)


if __name__ == '__main__':
    main()
