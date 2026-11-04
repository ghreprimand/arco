"""Storage warning approval and budget notice use fixture routes only."""
import asyncio
import os
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
HTML = '''<!doctype html><html><body><div id="fixture"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>'''
async def main():
    requests = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page()
        async def api(route):
            if route.request.url.endswith('/api/storage/budget'):
                await route.fulfill(json={'enabled': True, 'over': True, 'limitBytes': 1073741824, 'totalBytes': 2147483648}); return
            if route.request.url.endswith('/api/storage/keep'):
                requests.append(route.request.post_data_json); await route.fulfill(json={'ok': True}); return
            await route.fulfill(json={})
        await page.route('**/api/**', api)
        await page.route('**/fixture', lambda route: route.fulfill(content_type='text/html', body=HTML))
        await page.goto('http://127.0.0.1:' + os.environ.get('ARCO_CLIENT_PORT', '5249') + '/fixture')
        await page.wait_for_function('window.fixtureReady === true')
        await page.evaluate('''async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const { StorageWarnings } = await import('/src/components/StorageWarnings.tsx');
          const { useAppStore } = await import('/src/stores/appStore.ts');
          const { useStorageWarningStore } = await import('/src/stores/storageWarningStore.ts');
          useAppStore.getState().createJob('conv-1', { name: 'Fixture', workingDirectory: '/fixture-project', primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'low', skipPermissions: false }, undefined, undefined, true);
          useStorageWarningStore.getState().add({ type: 'storage_warning', workflowId: 'conv-1', items: [{path: 'artifacts/large.bin', bytes: 1048576, kind: 'file'}], fileThresholdBytes: 1, conversationThresholdBytes: 2 });
          createRoot(document.getElementById('fixture')).render(React.createElement(React.Fragment, null, React.createElement(StorageWarnings)));
        }''')
        await expect(page.get_by_text('artifacts/large.bin', exact=False)).to_be_visible()
        await page.get_by_role('button', name='KEEP', exact=True).click()
        assert requests[-1]['reason'] == 'size-warning' and requests[-1]['itemPath'] == 'artifacts/large.bin'
        await expect(page.get_by_text('Large artifacts', exact=True)).to_have_count(0)
        await browser.close()
asyncio.run(main())
