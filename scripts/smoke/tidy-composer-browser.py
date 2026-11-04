"""Fixture-only tidy proposal, revisions, undo, timeout, cancel and narrow layout."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from fs_url import fs_path

PORT = os.environ.get('ARCO_CLIENT_PORT', '5226')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"></head><body><div id="fixture"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 900, 'height': 800})
        state = {'mode': 'ok', 'release': asyncio.Event(), 'requests': [], 'cancels': []}
        errors, blocked = [], []
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                if url.path == '/fixture': await route.fulfill(content_type='text/html', body=HTML); return
                if url.path == '/api/utility-agent/tidy':
                    body = json.loads(route.request.post_data or '{}'); state['requests'].append(body)
                    if state['mode'] == 'slow': await state['release'].wait()
                    status = {'ok': 'ok', 'timeout': 'timeout', 'slow': 'cancelled'}[state['mode']]
                    result = {'jobId': body['jobId'], 'status': status, 'facts': [{'label': 'Draft characters', 'value': str(len(body['original']))}], 'elapsedMs': 10, 'agent': {'provider': 'ollama', 'model': 'tiny'}}
                    if status == 'ok': result['text'] = 'Proposal ' + str(len(body['directives']) + 1)
                    await route.fulfill(json=result); return
                if url.path == '/api/utility-agent/cancel':
                    state['cancels'].append(json.loads(route.request.post_data or '{}')); state['release'].set(); await route.fulfill(json={'cancelled': True}); return
                local = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if route.request.method == 'GET' and (local or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/'))): await route.continue_(); return
            blocked.append(url.path); await route.abort()
        await page.route('**/*', isolate); await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(ORIGIN + '/fixture'); await page.wait_for_function('window.fixtureReady === true')
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {TidyComposer}=await import('/src/components/TidyComposer.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts'); window.s=s;
          const {useDraftStore:d}=await import('/src/stores/draftStore.ts'); window.d=d;
          s.setState({settings:{enabledProviders:{ollama:true}}}); d.getState().setDraft('fixture','original draft');
          createRoot(document.getElementById('fixture')).render(React.createElement(TidyComposer,{jobId:'fixture'}));
        }''')
        await page.get_by_role('button', name='TIDY', exact=True).click(); dialog = page.get_by_role('dialog')
        await expect(dialog).to_contain_text('No utility agent is chosen'); assert not state['requests']
        await page.keyboard.press('Tab'); assert await dialog.evaluate('(e) => e.contains(document.activeElement)')
        await page.keyboard.press('Shift+Tab'); assert await dialog.evaluate('(e) => e.contains(document.activeElement)')
        await page.keyboard.press('Escape'); await expect(dialog).to_have_count(0)
        assert await page.evaluate("d.getState().drafts.fixture") == 'original draft'
        await page.evaluate("s.setState({settings:{...s.getState().settings,utilityAgent:{provider:'ollama',model:'tiny'}}})")
        await page.get_by_role('button', name='TIDY', exact=True).click(); proposal = page.get_by_label('Proposed draft')
        await expect(proposal).to_have_value('Proposal 1'); assert await page.evaluate("d.getState().drafts.fixture") == 'original draft'
        for instruction, expected in [('shorter', 'Proposal 2'), ('keep file list', 'Proposal 3')]:
            await page.get_by_role('button', name='REFINE').click(); await page.get_by_label('Refinement directive').fill(instruction)
            await page.get_by_role('button', name='REFINE').click(); await expect(proposal).to_have_value(expected)
        assert state['requests'][-1]['original'] == 'original draft'
        assert state['requests'][-1]['proposal'] == 'Proposal 2' and state['requests'][-1]['directives'] == ['shorter', 'keep file list']
        await expect(dialog).to_contain_text('revision 3 of 3'); await page.get_by_role('button', name='BACK').click(); await expect(proposal).to_have_value('Proposal 2')
        await proposal.fill('Edited proposal'); await page.get_by_role('button', name='ACCEPT').click(); await expect(dialog).to_have_count(0)
        assert await page.evaluate("d.getState().drafts.fixture") == 'Edited proposal'
        await page.get_by_role('button', name='UNDO TIDY').click(); assert await page.evaluate("d.getState().drafts.fixture") == 'original draft'
        await page.get_by_role('button', name='TIDY', exact=True).click(); await expect(proposal).to_have_value('Proposal 1'); await page.get_by_role('button', name='KEEP ORIGINAL').click()
        assert await page.evaluate("d.getState().drafts.fixture") == 'original draft'
        await page.get_by_role('button', name='TIDY', exact=True).click(); await expect(proposal).to_have_value('Proposal 1')
        state['mode'] = 'timeout'; await page.get_by_role('button', name='REFINE').click(); await page.get_by_label('Refinement directive').fill('timed out instruction'); await page.get_by_role('button', name='REFINE').click(); await expect(dialog).to_contain_text('did not answer in time')
        state['mode'] = 'ok'; await page.get_by_role('button', name='REFINE').click(); await page.get_by_label('Refinement directive').fill('next instruction'); await page.get_by_role('button', name='REFINE').click(); await expect(proposal).to_have_value('Proposal 3')
        assert state['requests'][-1]['directives'] == ['timed out instruction', 'next instruction']
        await page.get_by_role('button', name='KEEP ORIGINAL').click()
        state['mode'] = 'timeout'; await page.get_by_role('button', name='TIDY', exact=True).click(); await expect(dialog).to_contain_text('did not answer in time'); await page.keyboard.press('Escape')
        state['mode'] = 'slow'; await page.get_by_role('button', name='TIDY', exact=True).click(); await page.get_by_role('button', name='CANCEL').click(); await expect(dialog).to_contain_text('Cancelled.'); assert len(state['cancels']) == 1; await page.keyboard.press('Escape')
        state['mode'] = 'ok'; await page.evaluate("d.getState().setDraft('fixture', 'x'.repeat(12000))"); await page.set_viewport_size({'width': 340, 'height': 700})
        await page.get_by_role('button', name='TIDY', exact=True).click(); await expect(proposal).to_have_value('Proposal 1')
        assert await dialog.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1 && e.firstElementChild.scrollWidth <= e.firstElementChild.clientWidth + 1')
        assert await dialog.locator('pre').evaluate('(e) => e.scrollHeight > e.clientHeight')
        await page.get_by_role('button', name='KEEP ORIGINAL').click(); assert len(await page.evaluate("d.getState().drafts.fixture")) == 12000
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: tidy unset, refine twice, back, edit, accept, undo, keep, timeout, cancel and narrow long draft')

asyncio.run(main())
