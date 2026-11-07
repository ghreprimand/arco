"""Fixture-only catch-up: setup link, successful range/facts, timeout, cancel and narrow layout."""
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
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"></head><body><div id="fixture"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page(viewport={'width': 900, 'height': 800})
        state = {'mode': 'ok', 'release': asyncio.Event(), 'requests': [], 'cancels': []}
        errors, blocked = [], []
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                if url.path == '/fixture': await route.fulfill(content_type='text/html', body=HTML); return
                if url.path == '/api/utility-agent/catch-up':
                    body = json.loads(route.request.post_data or '{}'); state['requests'].append(body)
                    if state['mode'] == 'empty':
                        await route.fulfill(json={'jobId': body['jobId'], 'status': 'ok', 'empty': True, 'from': 0, 'to': 0, 'facts': [], 'elapsedMs': 0}); return
                    start = body['marker'] if isinstance(body.get('marker'), (int, float)) else 1_700_000_000_000
                    result = {'jobId': body['jobId'], 'from': start, 'to': start + 60000, 'facts': [{'label': 'Worker Reply', 'value': 'Fixture work completed'}], 'elapsedMs': 10, 'agent': {'provider': 'ollama', 'model': 'tiny'}}
                    if state['mode'] == 'slow': await state['release'].wait()
                    result['status'] = {'ok': 'ok', 'timeout': 'timeout', 'slow': 'cancelled'}[state['mode']]
                    if result['status'] == 'ok': result['text'] = 'Fixture work completed. ' + 'x' * 500
                    await route.fulfill(json=result); return
                if url.path == '/api/utility-agent/cancel':
                    state['cancels'].append(json.loads(route.request.post_data or '{}')); state['release'].set(); await route.fulfill(json={'cancelled': True}); return
                local = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if route.request.method == 'GET' and (local or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/'))): await route.continue_(); return
            blocked.append(url.path); await route.abort()
        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(ORIGIN + '/fixture'); await page.wait_for_function('window.fixtureReady === true')
        await page.evaluate('''async () => {
          localStorage.setItem('arco.last-viewed.workflow.fixture', String(Date.now()-120000));
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {CatchMeUp}=await import('/src/components/CatchMeUp.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts'); window.s=s;
          const root=createRoot(document.getElementById('fixture')); window.renderScope=(scope)=>root.render(React.createElement(CatchMeUp,{scope}));
          s.setState({settings:{enabledProviders:{ollama:true}}}); renderScope({kind:'workflow',id:'fixture'});
        }''')
        await page.get_by_role('button', name='CATCH ME UP').click()
        await expect(page.get_by_role('dialog')).to_contain_text('No utility agent is chosen')
        await expect(page.get_by_role('button', name='OPEN UTILITY AGENT SETTINGS')).to_be_visible()
        await page.get_by_role('button', name='CLOSE').click()
        await page.evaluate("s.setState({settings:{...s.getState().settings,utilityAgent:{provider:'ollama',model:'tiny'}}})")
        await page.get_by_role('button', name='CATCH ME UP').click(); await page.get_by_role('button', name='SUMMARIZE').click()
        dialog = page.get_by_role('dialog'); await expect(dialog).to_contain_text('Fixture work completed.')
        await expect(dialog).to_contain_text('Requested range:'); await expect(dialog).to_contain_text('OLLAMA / tiny')
        await dialog.get_by_text('Facts used (1)').click(); await expect(dialog).to_contain_text('Worker Reply')
        assert state['requests'][0]['scope'] == 'workflow' and state['requests'][0]['id'] == 'fixture'
        state['mode'] = 'timeout'; await page.get_by_role('button', name='SUMMARIZE').click(); await expect(dialog).to_contain_text('did not answer in time')
        state['mode'] = 'slow'; await page.get_by_role('button', name='SUMMARIZE').click(); await expect(page.get_by_role('button', name='CANCEL')).to_be_visible(); await page.get_by_role('button', name='CANCEL').click(); await expect(dialog).to_contain_text('Cancelled.')
        assert len(state['cancels']) == 1
        await page.set_viewport_size({'width': 340, 'height': 700}); state['mode'] = 'ok'
        await page.get_by_role('button', name='SUMMARIZE').click(); await expect(dialog).to_contain_text('Fixture work completed.')
        assert await dialog.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1 && e.firstElementChild.scrollWidth <= e.firstElementChild.clientWidth + 1')
        await page.keyboard.press('Escape'); await expect(dialog).to_have_count(0)
        # Switching away records this visit; the next cluster uses its own marker.
        before = int(await page.evaluate("localStorage.getItem('arco.last-viewed.workflow.fixture')"))
        await page.evaluate("renderScope(null)")
        await page.wait_for_function("Number(localStorage.getItem('arco.last-viewed.workflow.fixture')) > " + str(before))
        await page.evaluate("localStorage.setItem('arco.last-viewed.cluster.group', String(Date.now()-90000)); renderScope({kind:'cluster',id:'group'})")
        state['mode'] = 'ok'; await page.get_by_role('button', name='CATCH ME UP').click(); await page.get_by_role('button', name='SUMMARIZE').click()
        await expect(page.get_by_role('dialog')).to_contain_text('Fixture work completed.')
        assert state['requests'][-1]['scope'] == 'cluster' and state['requests'][-1]['id'] == 'group'
        await page.get_by_role('button', name='CLOSE').click()
        await page.evaluate("localStorage.removeItem('arco.last-viewed.workflow.unseen'); renderScope({kind:'workflow',id:'unseen'})")
        state['mode'] = 'ok'
        await page.get_by_role('button', name='CATCH ME UP').click()
        dialog = page.get_by_role('dialog')
        await expect(dialog).to_contain_text('No previous visit is recorded')
        await expect(dialog.get_by_role('button', name='SUMMARIZE')).to_be_visible()
        await dialog.get_by_role('button', name='SUMMARIZE').click()
        await expect(dialog).to_contain_text('Fixture work completed.')
        assert 'from' not in state['requests'][-1]
        await dialog.get_by_role('button', name='CLOSE').click()
        await page.evaluate("localStorage.removeItem('arco.last-viewed.workflow.quiet'); renderScope({kind:'workflow',id:'quiet'})")
        state['mode'] = 'empty'
        await page.get_by_role('button', name='CATCH ME UP').click()
        dialog = page.get_by_role('dialog')
        await dialog.get_by_role('button', name='SUMMARIZE').click()
        await expect(dialog).to_contain_text('Nothing has happened in this tab yet.')
        assert 'marker' not in state['requests'][-1]
        await expect(dialog.get_by_role('button', name='SINCE LAST TURN')).to_be_visible()
        await expect(dialog.get_by_role('button', name='LAST HOUR')).to_be_visible()
        await expect(dialog.get_by_role('button', name='TODAY')).to_be_visible()
        state['mode'] = 'ok'
        await dialog.get_by_role('button', name='LAST HOUR').click()
        await expect(dialog).to_contain_text('Fixture work completed.')
        assert state['requests'][-1]['range'] == 'hour'
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: catch up unset, success, facts, timeout, cancel, range, no-visit auto range, empty tab and narrow layout')

asyncio.run(main())
