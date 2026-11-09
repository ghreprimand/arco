"""Artifacts render independently of a delayed project document scan."""
import asyncio
import os
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults
from host_isolation import chrome_executable

install_navigation_defaults()

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        context = await browser.new_context()
        ready = asyncio.Event()
        async def api(route):
            path = urlparse(route.request.url).path
            if path == '/api/explorer/docs':
                await ready.wait()
                await route.fulfill(json={'entries': [], 'partial': True})
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
            print('artifacts: independent loading and partial result notice passed')
        finally:
            ready.set()
            await browser.close()

asyncio.run(main())
