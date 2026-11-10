"""Artifacts render independently of a delayed project document scan."""
import asyncio
import os
import time
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults
from host_isolation import chrome_executable

install_navigation_defaults()

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        context = await browser.new_context()
        ready = asyncio.Event()
        now = int(time.time() * 1000)
        opened = []
        revealed = []
        async def api(route):
            path = urlparse(route.request.url).path
            if path == '/api/explorer/docs':
                await ready.wait()
                await route.fulfill(json={'entries': [], 'partial': True})
            elif path == '/api/explorer/changed':
                await route.fulfill(json={'entries': [{'path': '/projects/fixture/notes.md', 'name': 'notes.md', 'project': 'Fixture', 'mtime': now - 1000, 'size': 80}, {'path': '/projects/fixture/image.png', 'name': 'image.png', 'project': 'Fixture', 'mtime': now - 2000, 'size': 40}, {'path': '/projects/beta/beta.md', 'name': 'beta.md', 'project': 'beta', 'mtime': now, 'size': 30}, {'path': '/data/external/external.md', 'name': 'external.md', 'project': 'external', 'mtime': now, 'size': 30}], 'partial': True})
            elif path == '/api/file-content':
                opened.append(parse_qs(urlparse(route.request.url).query)['path'][0])
                await route.fulfill(json={'type': 'text', 'content': 'Opened synthetic project file', 'size': 30})
            elif path == '/api/files':
                revealed.append(parse_qs(urlparse(route.request.url).query))
                await route.fulfill(json={'files': []})
            elif path == '/api/explorer/recents':
                await route.fulfill(json={'records': [{'path': '/projects/fixture/notes.md', 'ts': now - 1500, 'tabTitle': 'Builder', 'provider': 'fixture'}, {'path': '/projects/fixture/image.png', 'ts': now - 6000, 'tabTitle': 'Old tab', 'provider': 'fixture'}]})
            elif path == '/api/explorer/artifacts':
                await route.fulfill(json={'entries': [{'path': '/projects/fixture/.arco/workflows/fixture/artifacts/review.md', 'name': 'review.md', 'size': 10, 'mtime': 1, 'workflowId': 'fixture', 'tabTitle': 'Fixture', 'provider': 'fixture', 'project': 'Fixture', 'cwd': '/projects/fixture'}]})
            else:
                await route.fulfill(json={'entries': [], 'parent': '/projects', 'dirs': []})
        await context.route('**/api/**', api)
        page = await context.new_page()
        try:
            await page.goto('http://127.0.0.1:' + os.environ.get('ARCO_CLIENT_PORT', '5255') + '/?app=explorer&lens=artifacts')
            await expect(page.get_by_text('review.md', exact=True)).to_be_visible()
            await expect(page.get_by_text('Loading project documents...', exact=True)).to_be_visible()
            ready.set()
            await expect(page.get_by_text('Showing the newest 0; open a project for more.', exact=True)).to_be_visible()
            await expect(page.get_by_text('Loading project documents...', exact=True)).to_have_count(0)
            await page.goto('http://127.0.0.1:' + os.environ.get('ARCO_CLIENT_PORT', '5255') + '/?app=explorer&lens=recents')
            await expect(page.get_by_role('button', name='⌁ CHANGED FILES', exact=True)).to_be_visible()
            await expect(page.get_by_text('Results truncated: showing the newest files found within the scan budget. Open one project for a fuller list.', exact=True)).to_be_visible()
            await expect(page.get_by_text('notes.md', exact=True)).to_be_visible()
            await expect(page.get_by_text('Builder · fixture', exact=False)).to_be_visible()
            await expect(page.get_by_text('Old tab', exact=False)).to_have_count(0)
            await expect(page.get_by_role('button', name='AGENT WRITES', exact=True)).to_have_count(0)
            if os.environ.get('ARCO_CHANGED_FILES_SCREENSHOT'):
                await page.screenshot(path=os.environ['ARCO_CHANGED_FILES_SCREENSHOT'])
            await page.get_by_role('button', name='IMAGES', exact=True).click()
            await expect(page.get_by_text('image.png', exact=True)).to_be_visible()
            await expect(page.get_by_text('notes.md', exact=True)).to_have_count(0)
            await page.get_by_role('button', name='DOCS', exact=True).click()
            await expect(page.get_by_text('notes.md', exact=True)).to_be_visible()
            await expect(page.get_by_text('image.png', exact=True)).to_have_count(0)
            for project, filename, fullpath in [('beta', 'beta.md', '/projects/beta/beta.md'), ('external', 'external.md', '/data/external/external.md')]:
                await page.get_by_role('combobox').select_option(project)
                await expect(page.get_by_text(filename, exact=True)).to_be_visible()
                await expect(page.get_by_text('notes.md', exact=True)).to_have_count(0)
                await page.locator('.archive-row').filter(has=page.get_by_text(filename, exact=True)).locator('button').first.click()
                await expect(page.get_by_text('Opened synthetic project file', exact=True)).to_be_visible()
                assert opened[-1] == fullpath
                await page.keyboard.press('Escape')
                reveal_action = page.locator('.archive-row').filter(has=page.get_by_text(filename, exact=True)).get_by_title('Reveal in the file tree')
                if project == 'external':
                    await expect(reveal_action).to_have_count(0)
                    continue
                await expect(reveal_action).to_be_visible()
                await reveal_action.click()
                await expect(page.get_by_role('button', name='⊞ TREE', exact=True)).to_be_visible()
                for _ in range(30):
                    if any(fullpath.rsplit('/', 1)[0] in str(query) for query in revealed):
                        break
                    await page.wait_for_timeout(20)
                assert any(fullpath.rsplit('/', 1)[0] in str(query) for query in revealed), revealed
                await expect(page.get_by_text('Opened synthetic project file', exact=True)).to_be_visible()
                await page.keyboard.press('Escape')
                await page.get_by_role('button', name='⌁ CHANGED FILES', exact=True).click()
            print('artifacts: independent loading, partial notices and cross-project filter/open, in-root reveal and outside-root action exclusion passed')
        finally:
            ready.set()
            await browser.close()

asyncio.run(main())
