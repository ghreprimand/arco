"""Exercise the handoff choices with fixture state and no provider calls."""
import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from fs_url import fs_path

PORT = os.environ.get('ARCO_CLIENT_PORT', '5203')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><body><div id="fixture"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1100, 'height': 1000})
        errors, blocked = [], []
        async def route(request):
            url = urlparse(request.request.url)
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                if url.path == '/fixture':
                    await request.fulfill(content_type='text/html', body=HTML); return
                if url.path.startswith('/api/'):
                    await request.fulfill(json={}); return
                local = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if request.request.method == 'GET' and (local or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/', '/src/'))):
                    await request.continue_(); return
            blocked.append(url.path); await request.abort()
        await page.route('**/*', route)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(ORIGIN + '/fixture')
        try:
            await page.wait_for_function('window.fixtureReady === true', timeout=10000)
        except Exception:
            print('Fixture failed:', errors, blocked)
            raise
        await page.evaluate('''async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {HandoffDialog} = await import('/src/components/HandoffDialog.tsx');
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          s.setState({settings:{enabledProviders:{claude:true}},authStatus:{claude:{loggedIn:true}}});
          window.result = [];
          const config = {name:'fixture',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'high',skipPermissions:false};
          createRoot(document.getElementById('fixture')).render(React.createElement(HandoffDialog, {
            currentConfig:config, onConfirm:(...args)=>window.result.push(args), onCancel:()=>{}
          }));
        }''')
        await expect(page.get_by_text('QUICK', exact=True)).to_be_visible()
        await page.get_by_text('ROTATE', exact=True).click()
        assert (await page.evaluate('window.result[0][0]')) == 'quick'
        await page.get_by_text('ORIGINAL WORKER', exact=True).click()
        await expect(page.get_by_text('WRITER EFFORT', exact=True)).to_be_visible()
        await page.get_by_text('ROTATE', exact=True).click()
        assert (await page.evaluate('window.result[1][2].effort')) == 'medium'
        await page.get_by_text('FRESH SUMMARIZER', exact=True).click()
        await expect(page.get_by_text('SUMMARIZER (WRITES THE HANDOFF)', exact=True)).to_be_visible()
        await page.get_by_text('ROTATE', exact=True).click()
        assert (await page.evaluate('window.result[2][0]')) == 'fresh-summarizer'
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()

asyncio.run(main())
