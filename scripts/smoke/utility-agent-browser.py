"""Utility agent picker with fixture APIs and no provider calls: nothing chosen
until saved, suggestion never applied, save, clear, test success, timeout,
slow start with cancel, unavailable provider note and a narrow layout."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from fs_url import fs_path

PORT = os.environ.get('ARCO_CLIENT_PORT', '5203')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/styles/matrix.css"></head><body><div id="fixture" style="width:420px"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''
SETTINGS = {'enabledProviders': {'claude': True, 'codex': True, 'cursor': True, 'ollama': True, 'lmstudio': True, 'llamacpp': True, 'strata': True, 'deepseek': True}}

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 900, 'height': 900})
        blocked, errors, posts, cancels = [], [], [], []
        state = {'test': 'ok', 'saved': None, 'release': asyncio.Event()}
        async def isolate(route):
            url = urlparse(route.request.url)
            method = route.request.method
            if url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(content_type='text/css', body=''); return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                if url.path == '/fixture' and method == 'GET':
                    await route.fulfill(content_type='text/html', body=HTML); return
                if url.path == '/api/utility-agent/providers':
                    await route.fulfill(json={'providers': [
                        {'provider': 'claude', 'available': True},
                        {'provider': 'cursor', 'available': False, 'reason': 'Cursor Agent is not installed or signed in.'},
                        {'provider': 'ollama', 'available': True},
                        *[{'provider': p, 'available': True} for p in ('lmstudio', 'llamacpp', 'strata', 'deepseek')]]}); return
                if url.path == '/api/settings' and method == 'POST':
                    body = json.loads(route.request.post_data or '{}'); posts.append(body)
                    state['saved'] = body.get('utilityAgent')
                    await route.fulfill(json={**SETTINGS, **({'utilityAgent': state['saved']} if state['saved'] else {})}); return
                if url.path == '/api/utility-agent/test' and method == 'POST':
                    mode = state['test']
                    job = json.loads(route.request.post_data or '{}')['jobId']
                    agent = state['saved']
                    if mode == 'ok':
                        await route.fulfill(json={'jobId': job, 'status': 'ok', 'text': 'OK', 'agent': agent, 'facts': [], 'elapsedMs': 800}); return
                    if mode == 'timeout':
                        await route.fulfill(json={'jobId': job, 'status': 'timeout', 'agent': agent, 'facts': [], 'elapsedMs': 60000, 'reason': 'timeout'}); return
                    await state['release'].wait()
                    await route.fulfill(json={'jobId': job, 'status': 'cancelled', 'agent': agent, 'facts': [], 'elapsedMs': 9000, 'reason': 'cancelled'}); return
                if url.path == '/api/utility-agent/cancel' and method == 'POST':
                    cancels.append(json.loads(route.request.post_data or '{}')); state['release'].set()
                    await route.fulfill(json={'cancelled': True}); return
                if url.path.startswith('/api/'):
                    await route.fulfill(json={}); return
                local = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if method == 'GET' and (local or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/', '/themes/victor-mono/'))):
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
          const {UtilityAgentPicker} = await import('/src/components/UtilityAgentPicker.tsx');
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          window.s = s;
          s.setState({connected:true, settings:{enabledProviders:{claude:true,codex:true,cursor:true,ollama:true,lmstudio:true,llamacpp:true,strata:true,deepseek:true}},
            authStatus:{claude:{loggedIn:true},codex:{loggedIn:true},cursor:{loggedIn:true},ollama:{loggedIn:true,installedModels:['tiny','big']},lmstudio:{loggedIn:true,installedModels:['local-lms']},llamacpp:{loggedIn:true,installedModels:['local-llama']},strata:{loggedIn:true,installedModels:['local-strata']},deepseek:{loggedIn:true,installedModels:['local-deepseek']}}});
          createRoot(document.getElementById('fixture')).render(React.createElement(UtilityAgentPicker));
        }''')
        picker = page.get_by_test_id('utility-agent-picker')
        # Nothing chosen: only supported, available, connected providers are offered.
        await expect(picker).to_contain_text('No utility agent is chosen')
        await expect(page.get_by_test_id('utility-provider-claude')).to_be_visible()
        await expect(page.get_by_test_id('utility-provider-ollama')).to_be_visible()
        await expect(page.get_by_test_id('utility-provider-cursor')).to_have_count(0)
        for provider, model in [('lmstudio', 'local-lms'), ('llamacpp', 'local-llama'), ('strata', 'local-strata'), ('deepseek', 'local-deepseek')]:
            await page.get_by_test_id('utility-provider-' + provider).click()
            await expect(page.get_by_test_id('utility-model').filter(has_text=model)).to_be_visible()
            await expect(page.get_by_test_id('utility-save')).to_be_disabled()

        await expect(picker).to_contain_text('CURSOR: Cursor Agent is not installed')
        await expect(picker).not_to_contain_text('CODEX')
        await expect(page.get_by_test_id('utility-save')).to_be_disabled()
        await expect(page.get_by_test_id('utility-test')).to_be_disabled()
        # Suggestion is offered, never applied.
        await page.get_by_test_id('utility-provider-claude').click()
        await expect(picker).to_contain_text('A fast, low-cost model suits this work')
        assert await page.get_by_test_id('utility-model').evaluate_all("els=>els.filter(e=>e.getAttribute('aria-pressed')==='true').length") == 0
        await expect(page.get_by_test_id('utility-save')).to_be_disabled()
        await page.get_by_test_id('utility-use-suggestion').click()
        await expect(page.get_by_test_id('utility-save')).to_be_enabled()
        assert posts == [], posts
        # Ollama has no suggestion text.
        await page.get_by_test_id('utility-provider-ollama').click()
        await expect(picker).not_to_contain_text('A fast, low-cost model suits this work')
        await expect(page.get_by_test_id('utility-use-suggestion')).to_have_count(0)
        await page.get_by_test_id('utility-model').filter(has_text='tiny').click()
        await page.get_by_test_id('utility-save').click()
        await expect(picker).to_contain_text('Current choice: OLLAMA / tiny')
        assert posts == [{'utilityAgent': {'provider': 'ollama', 'model': 'tiny'}}], posts
        # Test: success.
        await page.get_by_test_id('utility-test').click()
        await expect(page.get_by_test_id('utility-result')).to_contain_text('Answered by OLLAMA / tiny in 0.8 s: OK')
        # Test: timeout.
        state['test'] = 'timeout'
        await page.get_by_test_id('utility-test').click()
        await expect(page.get_by_test_id('utility-result')).to_contain_text('did not answer in time')
        # Test: slow start shows a working note and CANCEL stops it.
        state['test'] = 'slow'
        await page.get_by_test_id('utility-test').click()
        await expect(page.get_by_test_id('utility-cancel')).to_be_visible()
        await expect(page.get_by_test_id('utility-slow')).to_be_visible(timeout=8000)
        await expect(page.get_by_test_id('utility-test')).to_be_disabled()
        await page.get_by_test_id('utility-cancel').click()
        await expect(page.get_by_test_id('utility-result')).to_have_text('Cancelled. Tried OLLAMA / tiny.')
        assert len(cancels) == 1 and cancels[0]['jobId'].startswith('util-test-'), cancels
        # Narrow layout: nothing overflows the container.
        await page.set_viewport_size({'width': 390, 'height': 800})
        await page.evaluate("document.getElementById('fixture').style.width='340px'")
        assert await page.evaluate("(()=>{const f=document.getElementById('fixture');return f.scrollWidth<=f.clientWidth+1})()")
        # Clear.
        await page.get_by_test_id('utility-clear').click()
        await expect(picker).to_contain_text('No utility agent is chosen')
        assert posts[-1] == {'utilityAgent': None}, posts
        await expect(page.get_by_test_id('utility-test')).to_be_disabled()
        # Consumers: USE UTILITY AGENT only fills the choice in, and only with a usable agent.
        await page.evaluate('''async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {RunAsPicker} = await import('/src/components/RunAsPicker.tsx');
          window.picked = [];
          const current = {provider:'claude', model:'sonnet', effort:'medium'};
          const el = document.createElement('div'); el.id = 'consumer'; document.body.appendChild(el);
          createRoot(el).render(React.createElement(RunAsPicker, {current, selection: current, onChange: v => picked.push(v), utility: true}));
        }''')
        use = page.get_by_test_id('run-as-utility')
        await expect(use).to_be_disabled()
        await page.evaluate("s.setState({settings:{...s.getState().settings, utilityAgent:{provider:'ollama', model:'tiny'}}})")
        await expect(use).to_be_enabled()
        assert await page.evaluate('picked.length') == 0
        await use.click()
        picked = await page.evaluate('picked')
        assert len(picked) == 1 and picked[0]['provider'] == 'ollama' and picked[0]['model'] == 'tiny', picked
        # A disconnected utility provider is not usable.
        await page.evaluate("s.setState({authStatus:{...s.getState().authStatus, ollama:{loggedIn:false,installedModels:['tiny']}}})")
        await expect(use).to_be_disabled()
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: utility agent unset by default, suggestion not applied, save, test success/timeout/cancel, unavailable note, narrow layout, clear, USE UTILITY AGENT fill-in')

asyncio.run(main())
