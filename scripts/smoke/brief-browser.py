"""BRIEF (worker, and the worker/whole-cluster choice) with fixture APIs and no provider calls: no utility
agent set, success with the facts shown, slow start with cancel, timeout, a
request that sends facts only, and a narrow layout."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from fs_url import fs_path
from host_isolation import chrome_executable

PORT = os.environ.get('ARCO_CLIENT_PORT', '5203')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/styles/matrix.css"></head><body><div id="fixture" style="width:420px"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''
SETTINGS = {'enabledProviders': {'claude': True, 'codex': True, 'cursor': True, 'ollama': True}}

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page(viewport={'width': 900, 'height': 900})
        blocked, errors, briefs, cancels = [], [], [], []
        state = {'mode': 'ok', 'release': asyncio.Event()}
        async def isolate(route):
            url = urlparse(route.request.url)
            method = route.request.method
            if url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(content_type='text/css', body=''); return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                if url.path == '/fixture' and method == 'GET':
                    await route.fulfill(content_type='text/html', body=HTML); return
                if url.path == '/api/utility-agent/brief' and method == 'POST':
                    body = json.loads(route.request.post_data or '{}'); briefs.append(body)
                    agent = {'provider': 'ollama', 'model': 'tiny'}
                    mode = state['mode']
                    if mode == 'ok':
                        await route.fulfill(json={'jobId': body['jobId'], 'status': 'ok', 'text': 'Builder is running a build.', 'agent': agent, 'facts': body['facts'], 'elapsedMs': 1200}); return
                    if mode == 'timeout':
                        await route.fulfill(json={'jobId': body['jobId'], 'status': 'timeout', 'agent': agent, 'facts': body['facts'], 'elapsedMs': 60000, 'reason': 'timeout'}); return
                    await state['release'].wait()
                    await route.fulfill(json={'jobId': body['jobId'], 'status': 'cancelled', 'agent': agent, 'facts': body['facts'], 'elapsedMs': 9000, 'reason': 'cancelled'}); return
                if url.path == '/api/utility-agent/cancel' and method == 'POST':
                    cancels.append(json.loads(route.request.post_data or '{}')); state['release'].set()
                    await route.fulfill(json={'cancelled': True}); return
                if url.path.startswith('/api/'):
                    await route.fulfill(json={}); return
                local = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if method == 'GET' and (local or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/'))):
                    await route.continue_(); return
            blocked.append(url.path); await route.abort()
        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true', timeout=10000)
        await page.evaluate('''async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {BriefControl} = await import('/src/components/BriefControl.tsx');
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          window.s = s;
          const now = Date.now();
          const job = (id, patch) => ({id, config:{name:id, workingDirectory:'/tmp/p'}, messages:[{role:'user', content:'run the build', timestamp:now-60000}], sessionChat:[], workers:{}, reviews:[], research:[], handoffs:[], activity:[], busy:false, ...patch});
          s.setState({connected:true, settings:{enabledProviders:{ollama:true}}, authStatus:{ollama:{loggedIn:true}},
            jobs:{w1: job('w1', {busy:true, turnStartedAt: now-190000, activity:[{id:'a', kind:'tool_use', tool:'Bash', input: JSON.stringify({command:'npm run build'}), status:'started', at: now-150000}]}),
                  w2: job('w2', {})},
            taskLedger:{'/tmp/p':[{id:'t1', title:'Port a thing', status:'in_progress', assignee:'w1'}]},
            clusters:{c1:{id:'c1', cwd:'/tmp/p', members:[{workflowId:'w1', displayName:'Builder', status:'busy'},{workflowId:'w2', displayName:'Checker', status:'idle'}], mailboxDepth:{w1:2}}}});
          const el = document.getElementById('fixture');
          createRoot(el).render(React.createElement('div', {style:{display:'flex', gap:'8px'}},
            React.createElement(BriefControl, {scope:'worker', targetId:'w1', label:'BRIEF', 'data-help':'composer.brief', testId:'worker-brief', title:'t'}),
            React.createElement(BriefControl, {scope:'worker', targetId:'w1', clusterId:'c1', label:'BRIEF', 'data-help':'composer.brief', testId:'cluster-brief', title:'t'})));
        }''')
        panel = page.get_by_test_id('brief-panel')
        # No utility agent set: explains and links to the setting; no request is made.
        await page.get_by_test_id('worker-brief').click()
        await expect(page.get_by_test_id('brief-not-set')).to_contain_text('A utility agent must be chosen')
        await expect(page.get_by_test_id('brief-open-setting')).to_be_visible()
        assert briefs == [], briefs
        await page.get_by_test_id('brief-open-setting').click()
        assert await page.evaluate('s.getState().showSettings') is True
        await page.evaluate("s.getState().setShowSettings(false)")
        await expect(panel).to_have_count(0)
        # Choose an agent (as the setting would): success shows text, model and facts.
        await page.evaluate("s.setState({settings:{...s.getState().settings, utilityAgent:{provider:'ollama', model:'tiny'}}})")
        await page.get_by_test_id('worker-brief').click()
        await expect(page.get_by_test_id('brief-result')).to_contain_text('Builder is running a build.')
        await expect(page.get_by_test_id('brief-result')).to_contain_text('Answered by ollama / tiny in 1.2s')
        assert len(briefs) == 1 and briefs[0]['scope'] == 'worker', briefs
        labels = [f['label'] for f in briefs[0]['facts']]
        for want in ['Turn state', 'Current step', 'Last operator message', 'Recent events', 'Pending question', 'Unread peer mail', 'Board task', 'Uncommitted files']:
            assert want in labels, (want, labels)
        by = {f['label']: f['value'] for f in briefs[0]['facts']}
        assert by['Current step'].startswith('Bash: npm run build, 2m'), by
        assert by['Board task'] == 'Port a thing [in_progress]', by
        assert by['Unread peer mail'] == '2', by
        assert by['Uncommitted files'] == 'not visible', by
        assert set(briefs[0].keys()) == {'jobId', 'scope', 'facts'}, briefs[0].keys()
        facts = page.get_by_test_id('brief-facts')
        await expect(facts).to_contain_text('FACTS USED')
        await facts.locator('summary').click()
        await expect(facts).to_contain_text('Current step:')
        await page.get_by_test_id('brief-close').click()
        # Cluster brief sends one fact per member and the roll-up.
        await page.get_by_test_id('cluster-brief').click()
        await expect(page.get_by_test_id('brief-this-worker')).to_have_text('THIS WORKER')
        await page.get_by_test_id('brief-whole-cluster').click()
        await expect(page.get_by_test_id('brief-result')).to_be_visible()
        await expect(page.get_by_test_id('brief-panel')).to_have_attribute('aria-label', 'BRIEF: WHOLE CLUSTER')
        cb = briefs[-1]
        assert cb['scope'] == 'cluster'
        cl = [f['label'] for f in cb['facts']]
        assert 'Member Builder' in cl and 'Member Checker' in cl and 'Waiting on the operator' in cl, cl
        await page.get_by_test_id('brief-close').click()
        # Timeout.
        state['mode'] = 'timeout'
        await page.get_by_test_id('worker-brief').click()
        await expect(page.get_by_test_id('brief-result')).to_contain_text('did not answer in time')
        await page.get_by_test_id('brief-close').click()
        # Slow start shows the working note; CANCEL stops it.
        state['mode'] = 'slow'
        await page.get_by_test_id('worker-brief').click()
        await expect(page.get_by_test_id('brief-cancel')).to_be_visible()
        await expect(page.get_by_test_id('brief-slow')).to_be_visible(timeout=8000)
        await page.get_by_test_id('brief-cancel').click()
        await expect(page.get_by_test_id('brief-result')).to_contain_text('Cancelled.')
        assert len(cancels) == 1 and cancels[0]['jobId'].startswith('brief-'), cancels
        await page.get_by_test_id('brief-close').click()
        # Narrow layout: the panel fits the viewport.
        state['mode'] = 'ok'
        await page.set_viewport_size({'width': 360, 'height': 640})
        await page.get_by_test_id('cluster-brief').click()
        await page.get_by_test_id('brief-whole-cluster').click()
        await expect(page.get_by_test_id('brief-result')).to_be_visible()
        box = await panel.locator('> div').bounding_box()
        assert box and box['x'] >= 0 and box['x'] + box['width'] <= 360 + 1, box
        await page.keyboard.press('Escape')
        await expect(panel).to_have_count(0)
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: BRIEF no agent set, success with facts, cluster facts, timeout, cancel, narrow layout')

asyncio.run(main())
