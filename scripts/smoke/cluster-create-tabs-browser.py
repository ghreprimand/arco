"""Creating or growing a cluster never shows a member as its own tab.

Real TabBar, store and handleServerMessage under Vite, fixture messages only,
no server or provider. The messages arrive in the server's order: each new
member (workflow_created) before the cluster state that lists it. Every
animation frame and every tab bar change is checked: no member tab may appear
outside the cluster tab, and no member may take focus. Covered: a 7-member
CREATE CLUSTER, ADD WORKERS on an existing cluster, and REPLACE.
"""
import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path

PORT = os.environ.get('ARCO_CLIENT_PORT', '5263')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/styles/matrix.css"></head><body><div id="fixture"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''

CWD = '/projects/fixture'
MEMBERS = ['member-%d' % i for i in range(1, 8)]


def config(name):
    return {'name': name, 'workingDirectory': CWD, 'primaryProvider': 'claude', 'primaryModel': 'claude-sonnet-4-6', 'primaryEffort': 'high', 'skipPermissions': True}


def state(cluster_id, name, ids):
    return {'clusterId': cluster_id, 'name': name, 'cwd': CWD, 'createdAt': '2026-11-07T00:00:00Z', 'mailboxDepth': {},
            'members': [{'workflowId': w, 'displayName': w, 'status': 'idle'} for w in ids]}


def created(w):
    return {'type': 'workflow_created', 'workflowId': w, 'config': config(w), 'clusterMemberPending': True}


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1500, 'height': 400})
        blocked, errors = [], []

        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'https' and url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(status=200, content_type='text/css', body=''); return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and route.request.method == 'GET':
                if url.path.startswith('/api/'):
                    await route.fulfill(json={}); return
                if url.path == '/fixture':
                    await route.fulfill(status=200, content_type='text/html', body=HTML); return
                is_local_fs = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if is_local_fs or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/', '/themes/victor-mono/')):
                    await route.continue_(); return
            blocked.append(url.path)
            await route.abort()
        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true', timeout=10000)
        await page.evaluate("""async (members) => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {TabBar} = await import('/src/components/TabBar.tsx');
          const {applyTheme} = await import('/src/themes/apply.ts');
          const {getTheme} = await import('/src/themes/registry.ts');
          applyTheme(getTheme('matrix'));
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          const {handleServerMessage:receive} = await import('/src/ws/handleServerMessage.ts');
          const socket = {readyState: 1, send: () => {}};
          window.send = m => receive(m, {wsRef:{current:socket}, scheduleReconnect:()=>{}});
          s.setState({jobs: {}, clusters: {}, activeJobId: null, activeClusterId: null, showCreator: true, creatorRequested: true, showHome: false});
          // An ordinary workflow that keeps its own tab throughout.
          s.getState().createJob('own-tab', {name:'own-tab', workingDirectory:'/projects/fixture', primaryProvider:'claude', primaryModel:'claude-sonnet-4-6', primaryEffort:'high', skipPermissions:true});
          const noop = () => {};
          createRoot(document.getElementById('fixture')).render(React.createElement(TabBar, {
            onRemoveWorkflow: noop, onCreateCluster: noop, onDeleteCluster: noop, onAddClusterMember: noop, onCreateClusterWithFreshWorkers: noop }));
          // Every frame and every DOM change of the tab bar: the workflow tabs
          // shown, and the job in focus. Recorded whenever a member shows up.
          window.watched = new Set(members);
          window.violations = [];
          window.frames = 0;
          const tabNames = () => [...document.querySelectorAll('#fixture [aria-label]')]
            .map(e => e.getAttribute('aria-label')).filter(l => /: /.test(l)).map(l => l.split(/[:,]/)[0]);
          const look = (when) => {
            const shown = tabNames().filter(n => window.watched.has(n));
            const st = s.getState();
            if (shown.length) window.violations.push(`${when}: member tab(s) ${shown.join(' ')}`);
            if (st.activeJobId && window.watched.has(st.activeJobId)) window.violations.push(`${when}: ${st.activeJobId} took focus`);
          };
          new MutationObserver(() => look('dom change')).observe(document.getElementById('fixture'), {subtree: true, childList: true, attributes: true, characterData: true});
          const frame = () => { window.frames += 1; look('frame ' + window.frames); requestAnimationFrame(frame); };
          requestAnimationFrame(frame);
          window.tabNames = tabNames;
        }""", MEMBERS + ['member-8', 'member-9'])

        async def deliver(msg):
            # One message per task, as from the socket, with frames rendered between.
            await page.evaluate('m => send(m)', msg)
            await page.evaluate('() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')

        # CREATE CLUSTER with seven members.
        for w in MEMBERS:
            await deliver(created(w))
        await deliver({'type': 'cluster_created', 'clusterId': 'c7', 'state': state('c7', 'Team of seven', MEMBERS)})
        names = await page.evaluate('() => tabNames()')
        assert 'Team of seven' in names and 'own-tab' in names, names
        # ADD WORKERS: one fresh member joins the existing cluster.
        await deliver(created('member-8'))
        await deliver({'type': 'cluster_member_added', 'clusterId': 'c7', 'member': {'workflowId': 'member-8', 'displayName': 'member-8', 'status': 'idle'}})
        await deliver({'type': 'cluster_state', 'clusterId': 'c7', 'state': state('c7', 'Team of seven', MEMBERS + ['member-8'])})
        # REPLACE member-2 with member-9.
        await deliver(created('member-9'))
        await deliver({'type': 'cluster_member_replaced', 'clusterId': 'c7', 'oldWorkflowId': 'member-2', 'newWorkflowId': 'member-9', 'accessMode': 'standard'})
        after = [w for w in MEMBERS if w != 'member-2'] + ['member-8', 'member-9']
        await deliver({'type': 'cluster_state', 'clusterId': 'c7', 'state': state('c7', 'Team of seven', after)})
        await page.evaluate('() => new Promise(r => setTimeout(r, 200))')

        violations = await page.evaluate('() => window.violations')
        frames = await page.evaluate('() => window.frames')
        names = await page.evaluate('() => tabNames()')
        active = await page.evaluate('async () => (await import("/src/stores/appStore.ts")).useAppStore.getState().activeClusterId')
        assert not violations, f'{len(violations)} problem(s), first: ' + '; '.join(violations[:5])
        assert frames >= 20, frames
        assert sorted(n for n in names if n != 'Home') == ['Team of seven', 'own-tab'], names
        assert active == 'c7', active
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print(f'PASS: 7-member create, ADD WORKERS and REPLACE: no member tab and no member focus in {frames} frames; one cluster tab')


asyncio.run(main())
