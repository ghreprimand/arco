"""Modal dialogs stay opaque under Phosphor glass and Frosted while side panels keep the glass."""
import asyncio
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path, fs_url
from host_isolation import chrome_executable

PORT = os.environ.get('ARCO_CLIENT_PORT', '5203')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/styles/matrix.css"><link rel="stylesheet" href="/src/themes/phosphor/phosphor.css"></head><body><div id="fixture"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page(viewport={'width': 1200, 'height': 800})
        blocked, errors = [], []
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'https' and url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(status=200, content_type='text/css', body='')
                return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and route.request.method == 'GET':
                if url.path == '/fixture':
                    await route.fulfill(status=200, content_type='text/html', body=HTML)
                    return
                is_local_fs = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if is_local_fs or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/', '/phosphor-demo/', '/themes/victor-mono/')):
                    await route.continue_()
                    return
            blocked.append(url.path)
            await route.abort()
        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true', timeout=10000)
        await page.evaluate('''async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ShortcutCheatSheet} = await import('/src/components/ShortcutCheatSheet.tsx');
          const {applyTheme} = await import('/src/themes/apply.ts');
          const {getTheme} = await import('/src/themes/registry.ts');
          window.applyIt = (id, frost) => applyTheme(getTheme(id), null, frost);
          createRoot(document.getElementById('fixture')).render(React.createElement(ShortcutCheatSheet,{onClose:()=>{}}));
        }''')
        alpha = "(c => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return 1; const p = m[1].split(/[ ,\\/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; })"
        for theme, frost in (('matrix', 'on'), ('phosphor', None), ('phosphor', 'on')):
            await page.evaluate("([id, f]) => window.applyIt(id, f)", [theme, frost])
            dialog = page.locator('#fixture [style*="bg-dialog"]').first
            await expect(dialog).to_be_visible()
            a = await dialog.evaluate("el => (" + alpha + ")(getComputedStyle(el).backgroundColor)")
            assert a == 1, f'{theme}/{frost}: dialog alpha {a}'
            side = await page.evaluate("(" + alpha + ")(getComputedStyle(document.documentElement).getPropertyValue('--color-bg-panel'))")
            assert side < 1, f'{theme}/{frost}: side panel token stays translucent, got {side}'
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: modal dialog surface is opaque under glass and frosted; panel token keeps its alpha')

asyncio.run(main())
