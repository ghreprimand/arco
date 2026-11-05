"""An open page recovers its session and detects a new bundle after a restart."""
import asyncio
import importlib.util
import os
import re
import subprocess
import time
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from playwright.async_api import async_playwright, expect

spec = importlib.util.spec_from_file_location('connections', Path(__file__).with_name('connections-browser.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)

class Server(h.IsolatedServer):
    def extra_settings(self):
        return {'projects': [str(self.projects / 'app')], 'onboardingComplete': True}

async def main():
    server = Server('http://127.0.0.1:1')
    index = h.REPO / 'client' / 'dist' / 'index.html'
    original = index.read_text()
    try:
        async with async_playwright() as p:
            browser = h.Browser(p, server)
            page = await browser.open()
            # A draft-bearing page keeps its contents and presents RELOAD.
            await page.evaluate("""() => {
                const field = document.createElement('textarea'); field.id = 'fixture-unsaved';
                document.body.appendChild(field); field.value = 'Unsent fixture draft';
                field.dispatchEvent(new Event('input', { bubbles: true }));
            }""")
            # Separate contexts let both independent application windows stay
            # open; a second tab in one context is intentionally rejected.
            other = h.Browser(p, SimpleNamespace(base=server.base.replace('127.0.0.1', 'localhost')))
            second = await other.open()
            second_url = second.url
            await second.evaluate("document.body.insertAdjacentHTML('beforeend', '<div role=dialog aria-label=fixture>Unsaved fixture</div>')")
            await second.route('**/index.html?build=*', lambda route: route.fulfill(status=200, content_type='text/html', body=original))
            clean_browser = h.Browser(p, server)
            clean = await clean_browser.open()
            await clean.route('**/index.html?build=*', lambda route: route.fulfill(status=200, content_type='text/html', body=original))
            old_url = page.url
            assert await page.evaluate("fetch('/api/settings').then(r => r.status)") == 200
            server.proc.terminate()
            await asyncio.to_thread(server.proc.wait, 10)
            await page.get_by_title('ONLINE', exact=True).wait_for(state='hidden', timeout=15000)
            changed, count = re.subn(r'(/assets/index-)[^"/]+(\.js)', r'\g<1>fixture-new-build\2', original, count=1)
            assert count == 1
            index.write_text(changed)
            server.proc = subprocess.Popen(['node', '--conditions', 'development', '--import', 'tsx', 'server/src/index.ts'], cwd=h.REPO, env=server.env, stdout=server.log, stderr=server.log)
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if server.proc.poll() is not None: raise RuntimeError('restarted server exited')
                try:
                    with urllib.request.urlopen(server.base + '/readyz', timeout=1) as response:
                        if response.status == 200: break
                except Exception: await asyncio.sleep(.15)
            else: raise RuntimeError('restarted server not ready')
            await page.get_by_title('ONLINE', exact=True).wait_for(timeout=30000)
            await expect(page.get_by_role('button', name='Reload Arco')).to_be_visible(timeout=30000)
            assert page.url == old_url
            assert await page.locator('#fixture-unsaved').input_value() == 'Unsent fixture draft'
            assert await page.evaluate("fetch('/api/settings').then(r => r.status)") == 200
            # Both the initial request and the retry fail even after a mint.
            # The page must expose a reload action while work remains open.
            await expect(second.get_by_role('button', name='Reload Arco')).to_have_count(0)
            refusals = []
            async def refuse(route):
                refusals.append(route.request.method)
                await route.fulfill(status=401, json={'error':'fixture'})
            await second.route('**/api/settings*', refuse)
            assert await second.evaluate("fetch('/api/settings').then(r => r.status)") == 401
            assert len(refusals) == 2
            assert await second.evaluate("fetch(new Request('/api/settings')).then(r => r.status)") == 401
            assert len(refusals) == 4
            await expect(second.get_by_role('button', name='Reload Arco')).to_be_visible(timeout=10000)
            await expect(second.get_by_role('alert').filter(has_text='ARCO RESTARTED')).to_be_visible()
            assert second.url == second_url
            # A clean page reloads once. Restore the real bundle before that
            # navigation so the isolated server can serve it normally.
            index.write_text(original)
            await clean.route('**/api/settings*', lambda route: route.fulfill(status=401, json={'error':'fixture'}))
            async with clean.expect_navigation(wait_until='domcontentloaded', timeout=15000):
                assert await clean.evaluate("fetch('/api/settings').then(r => r.status)") == 401
            await clean_browser.close()
            await other.close()
            await browser.close()
    finally:
        index.write_text(original)
        server.close()

asyncio.run(main())
