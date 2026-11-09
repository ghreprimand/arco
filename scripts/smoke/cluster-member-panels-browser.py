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
from host_isolation import chrome_executable

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
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page(viewport={'width': 700, 'height': 950})
        blocked, errors, usage_requests = [], [], []
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'http' and url.netloc == '127.0.0.1:4300':
                await route.fulfill(status=200, content_type='text/html', body='<p>Separate preview fixture</p>'); return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and url.path.startswith('/api/preview/lease/'):
                await route.fulfill(json={'id': 'fixture-lease', 'port': 4300, 'capability': 'fixture-access'}); return
            if url.scheme == 'https' and url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(status=200, content_type='text/css', body=''); return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and route.request.method == 'GET':
                if url.path == '/fixture':
                    await route.fulfill(status=200, content_type='text/html', body=HTML); return
                if url.path == '/api/cluster-snapshots':
                    await route.fulfill(json={'snapshots': [{'id': 'own', 'sameFolder': True}, {'id': 'other', 'sameFolder': False}]}); return
                if url.path == '/api/files':
                    await route.fulfill(json={'files': [{'name': 'notes.txt', 'path': '/projects/fixture/notes.txt', 'isDirectory': False}]}); return
                if url.path == '/api/file-content':
                    await route.fulfill(json={'type': 'text', 'content': 'Palette fixture contents', 'size': 24}); return
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
        MOUNT = '''async () => {
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
          window.fixtureRoot = createRoot(document.getElementById('fixture'));
          window.fixtureRoot.render(React.createElement(ClusterRightPanel, {cluster}));
        }'''
        await page.evaluate(MOUNT)
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
        # A reload keeps the member in view (P8.11).
        await page.wait_for_function("(JSON.parse(localStorage.getItem('arco-jobs') || '{}').state || {}).clusterFocusedMember?.c1 === 'builder-cli'", timeout=10000)
        await page.reload()
        await page.wait_for_function('window.fixtureReady === true', timeout=10000)
        await page.evaluate(MOUNT)
        await expect(picker).to_have_value('builder-cli')
        # PREVIEW follows the same member.
        await page.locator('[data-help="cluster.right-panel.group.runtime"]').click()
        await page.locator('[data-help="cluster.right-panel.preview"]').click()
        await expect(page.get_by_label('PREVIEW of member')).to_have_value('builder-cli')
        # B160/B161: real layout under zoom and captures use the member in view.
        await page.evaluate("""() => {
          window.captureCalls = [];
          s.setState(st => ({wsSendRaw: m => {captureCalls.push(m); return true}, jobs: {...st.jobs, 'builder-cli': {...st.jobs['builder-cli'], preview: {port: 5173}}}}));
        }""")
        # The bound frame must receive height through the actual cluster panel.
        cluster_frame = page.locator('iframe')
        await expect(cluster_frame).to_be_visible()
        for width, height in [(1280, 800), (1920, 1080), (1920, 1200), (2560, 1440), (3840, 2160)]:
            await page.set_viewport_size({'width': width, 'height': height})
            for zoom in [1, 1.5]:
                await page.evaluate("""([zoom, height]) => {
                  document.documentElement.style.zoom = String(zoom);
                  document.getElementById('fixture').style.height = (height / zoom - 40) + 'px';
                }""", [zoom, height])
                await expect(cluster_frame).to_be_visible()
                box = await cluster_frame.bounding_box()
                assert box and box['width'] > 0 and box['height'] > 0, (width, height, zoom, box)
        await page.evaluate("document.documentElement.style.zoom = '1'")
        await page.set_viewport_size({'width': 700, 'height': 950})
        await page.evaluate("document.getElementById('fixture').style.height = '900px'")
        await page.get_by_role('button', name='MOBILE', exact=True).click()
        for label in ['CAPTURE SCREENSHOT', 'CHECK CONSOLE', 'CHECK NETWORK']:
            await page.get_by_role('button', name=label, exact=True).click()
        assert await page.evaluate('window.captureCalls') == [
            {'type': 'preview_capture_request', 'workflowId': 'builder-cli', 'captures': [kind], 'viewport': 'mobile'}
            for kind in ['screenshot', 'console', 'network']
        ]
        # MEMORY > USAGE covers the cluster's project folder.
        await page.locator('[data-help="cluster.right-panel.group.memory"]').click()
        await page.locator('[data-help="cluster.right-panel.tab.usage"]').click()
        await expect(page.get_by_text('Covers every conversation saved in this project folder, all members included.')).to_be_visible()
        await expect(page.get_by_role('button', name='MEASURE STORAGE')).to_be_visible()
        for _ in range(50):
            if usage_requests: break
            await page.wait_for_timeout(100)
        assert 'path=%2Fprojects%2Ffixture' in usage_requests[0], usage_requests
        # Measure the standalone fitted surface in a bounded flex host.
        await page.evaluate("""async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {PreviewTab} = await import('/src/components/PreviewTab.tsx');
          fixtureRoot.render(React.createElement(PreviewTab, {job: s.getState().jobs['builder-cli']}));
        }""")
        frame = page.locator('iframe')
        await expect(frame).to_be_visible()
        for zoom in [1, 1.5]:
            for width in [600, 440]:
                await page.evaluate("""([zoom, width]) => {
                  document.documentElement.style.zoom = String(zoom);
                  document.getElementById('fixture').style.width = width + 'px';
                  document.getElementById('fixture').style.height = '700px';
                }""", [zoom, width])
                await page.wait_for_timeout(100)
                fits = await frame.evaluate("""el => {
                  const box = el.parentElement.getBoundingClientRect();
                  const wrap = el.parentElement.parentElement.getBoundingClientRect();
                  return box.width > 0 && box.height > 0 && box.width <= wrap.width + 1 && box.height <= wrap.height + 1;
                }""")
                assert fits, [zoom, width]
        await page.evaluate("document.documentElement.style.zoom = '1'")
        # B151: viewer owns the top hit-tested surface; Escape restores the palette.
        await page.evaluate("""async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {CommandPalette} = await import('/src/components/CommandPalette.tsx');
          s.setState({activeJobId: 'builder-cli', activeClusterId: null});
          window.paletteCloses = 0;
          fixtureRoot.render(React.createElement(CommandPalette, {onClose: () => paletteCloses++}));
        }""")
        search = page.get_by_placeholder('Search tabs, files, transcript, commands', exact=False)
        await search.fill('notes')
        await page.get_by_text('notes.txt', exact=True).click()
        await expect(search).to_have_count(0)
        await expect(page.get_by_text('Palette fixture contents', exact=False)).to_be_visible()
        close = page.get_by_role('button', name='×', exact=True)
        assert await close.evaluate("""el => { const r=el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); }""")
        await page.keyboard.press('Escape')
        await expect(search).to_have_value('notes')
        assert await page.evaluate('window.paletteCloses') == 0
        # The MEMBERS panel starts with snapshots from this exact folder.
        await page.evaluate("""async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {ClusterRightPanel} = await import('/src/components/ClusterRightPanel/index.tsx');
          const {useClusterSnapshotsStore} = await import('/src/stores/clusterSnapshotsStore.ts');
          useClusterSnapshotsStore.getState().onList([
            {id:'own',name:'Own snapshot',sourceCwd:'/aliases/fixture',createdAt:'2026-01-01',memberCount:1},
            {id:'other',name:'Other snapshot',sourceCwd:'/projects/fixture ',createdAt:'2026-01-01',memberCount:1},
          ]);
          localStorage.setItem('arco.clusterSidePanelTab.byCluster', JSON.stringify({c1:'members'}));
          fixtureRoot.render(React.createElement(ClusterRightPanel, {cluster:s.getState().clusters.c1}));
        }""")
        await expect(page.get_by_text('Own snapshot', exact=True)).to_be_visible()
        await expect(page.get_by_text('Other snapshot', exact=True)).to_have_count(0)
        await page.get_by_role('button', name='Show all projects (2)', exact=True).click()
        await expect(page.get_by_text('Other snapshot', exact=True)).to_be_visible()
        await page.get_by_role('button', name='This project only', exact=True).click()
        await expect(page.get_by_text('Other snapshot', exact=True)).to_have_count(0)
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: member HISTORY/PREVIEW, zoomed fit, scoped captures, palette viewer, rewind availability and USAGE')

asyncio.run(main())
