"""Cluster panel: HISTORY and PREVIEW follow the member in view, REWIND CONVERSATION says why it is unavailable, and MEMORY has USAGE."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path

PORT = os.environ.get('ARCO_CLIENT_PORT', '5203')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/styles/matrix.css"><link rel="stylesheet" href="/src/themes/phosphor/phosphor.css"></head><body><div id="fixture" style="display:flex;height:900px"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''
USAGE = {'perProvider': {}, 'grandTotals': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheCreate': 0, 'promptTokens': 0, 'cacheHitRatio': 0}, 'days': [], 'turnsAggregated': 0, 'workflowsScanned': 0}

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 700, 'height': 950})
        blocked, errors, usage_requests = [], [], []
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'https' and url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(status=200, content_type='text/css', body=''); return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and route.request.method == 'GET':
                if url.path == '/fixture':
                    await route.fulfill(status=200, content_type='text/html', body=HTML); return
                if url.path == '/api/usage-stats':
                    usage_requests.append(url.query)
                    await route.fulfill(json=USAGE); return
                if url.path.startswith('/api/'):
                    # Panels that load on their own (outputs, trust, previews) get an empty answer.
                    await route.fulfill(json={}); return
                is_local_fs = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if is_local_fs or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/', '/phosphor-demo/', '/themes/victor-mono/')):
                    await route.continue_(); return
            blocked.append(url.path)
            await route.abort()
        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.add_init_script("localStorage.setItem('arco.clusterSidePanelTab.byCluster', JSON.stringify({c1: 'history'}))")
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true', timeout=10000)
        await page.evaluate('''async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ClusterRightPanel} = await import('/src/components/ClusterRightPanel/index.tsx');
          const {useAppStore: s} = await import('/src/stores/appStore.ts');
          window.s = s;
          const job = (id, provider, extra) => s.getState().createJob(id, {name: id, workingDirectory: '/projects/fixture', primaryProvider: provider, primaryModel: 'fixture', primaryEffort: 'low', skipPermissions: false, ...extra});
          job('builder-cli', 'claude', {claudeTransport: 'cli'});
          job('lead-codex', 'codex', {});
          job('helper-native', 'claude', {claudeTransport: 'native'});
          const members = [
            {workflowId: 'builder-cli', displayName: 'Builder', role: 'Builder', status: 'idle'},
            {workflowId: 'lead-codex', displayName: 'Lead', role: 'Director', status: 'idle'},
            {workflowId: 'helper-native', displayName: 'Helper', role: 'Builder', status: 'idle'},
          ];
          const cluster = {clusterId: 'c1', cwd: '/projects/fixture', createdAt: '', taskBoardMode: 'none', taskBoardAttached: false, mailboxDepth: {}, members};
          s.getState().setClusterState('c1', cluster);
          createRoot(document.getElementById('fixture')).render(React.createElement(ClusterRightPanel, {cluster}));
        }''')
        picker = page.get_by_label('HISTORY of member')
        # No member chosen yet: the director (not the first member) is in view.
        await expect(picker).to_have_value('lead-codex')
        unavailable = page.get_by_test_id('rewind-unavailable')
        await expect(unavailable).to_have_text('Available for Claude Native workers only.')
        await expect(page.get_by_role('button', name='REWIND CONVERSATION')).to_be_disabled()
        # Focusing another member (card, tab or this picker) switches HISTORY to it.
        await page.evaluate("s.getState().setClusterFocusedMember('c1', 'helper-native')")
        await expect(picker).to_have_value('helper-native')
        await expect(unavailable).to_have_count(0)
        await picker.select_option('builder-cli')
        assert await page.evaluate("s.getState().clusterFocusedMember.c1") == 'builder-cli'
        await expect(unavailable).to_have_text('Available for Claude Native workers only; this worker uses the Claude CLI.')
        # PREVIEW follows the same member.
        await page.locator('[data-help="cluster.right-panel.group.runtime"]').click()
        await page.locator('[data-help="cluster.right-panel.preview"]').click()
        await expect(page.get_by_label('PREVIEW of member')).to_have_value('builder-cli')
        # MEMORY > USAGE covers the cluster's project folder.
        await page.locator('[data-help="cluster.right-panel.group.memory"]').click()
        await page.locator('[data-help="cluster.right-panel.tab.usage"]').click()
        await expect(page.get_by_text('Covers every conversation saved in this project folder, all members included.')).to_be_visible()
        await expect(page.get_by_role('button', name='MEASURE STORAGE')).to_be_visible()
        for _ in range(50):
            if usage_requests: break
            await page.wait_for_timeout(100)
        assert 'path=%2Fprojects%2Ffixture' in usage_requests[0], usage_requests
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: cluster HISTORY and PREVIEW follow the member in view, rewind availability per provider, USAGE in MEMORY')

asyncio.run(main())
