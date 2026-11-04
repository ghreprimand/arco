"""SECOND OPINION: selection entry, question and switches, reply-draft request, blind drafts, pick, tally, USE THIS REPLY."""
import asyncio
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path, fs_url

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
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1400, 'height': 1000})
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
          const {CompareDialogHost} = await import('/src/components/compare/CompareDialogHost.tsx');
          const {CompareOverlay} = await import('/src/components/compare/CompareOverlay.tsx');
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          const cs = await import('/src/stores/compareStore.ts');
          const {useDraftStore} = await import('/src/stores/draftStore.ts');
          window.s = s; window.cs = cs; window.drafts = useDraftStore; window.requests = []; window.votes = []; window.synths = [];
          cs.registerCompareRequestSender(a => window.requests.push(a));
          cs.registerCompareVoteSender((w,c,i) => window.votes.push([w,c,i]));
          cs.registerCompareSynthesizeSender((w,c,i) => window.synths.push([w,c,i]));
          s.setState({connected:true, settings:{enabledProviders:{}}, authStatus:{claude:{loggedIn:true},codex:{loggedIn:true}}});
          s.getState().createJob('wf-a',{name:'Alpha',workingDirectory:'/projects/fixture',primaryProvider:undefined,primaryModel:'sonnet',primaryEffort:'low',skipPermissions:false});
          const msgs = [
            {id:'m1',role:'user',content:'Please fix the login bug',isStreaming:false,timestamp:1},
            {id:'m2',role:'assistant',content:'Should I refactor the session module now or later?',isStreaming:false,timestamp:2},
          ];
          s.setState(st => ({jobs:{...st.jobs,'wf-a':{...st.jobs['wf-a'],messages:msgs}}}));
          createRoot(document.getElementById('fixture')).render(React.createElement('div',null,React.createElement(CompareDialogHost),React.createElement(CompareOverlay)));
        }''')
        # Entry from selected messages: excerpt shown, question optional, hint text corrected.
        await page.evaluate("cs.useCompareStore.getState().openDialog('wf-a', '[Alpha]\\nShould I refactor the session module now or later?')")
        dlg = page.locator('[data-help="composer.compare"]')
        await expect(dlg).to_contain_text('SECOND OPINION')
        await expect(page.get_by_test_id('second-opinion-excerpt')).to_contain_text('refactor the session module')
        text = await dlg.inner_text()
        assert 'tab\'s current primary' not in text and 'spawn a new tab' not in text.lower(), text
        assert 'Nothing is dispatched or opened in a new tab' in text, text
        ask = dlg.get_by_role('button', name='ASK THE MODELS')
        await expect(ask).to_be_enabled()
        await dlg.get_by_label('Include this tab', exact=False).click()
        await dlg.get_by_label('Let the models read project files', exact=False).click()
        await dlg.get_by_placeholder('e.g. Say yes', exact=False).fill('Say later, keep the diff small')
        await ask.click()
        reqs = await page.evaluate('requests')
        assert len(reqs) == 1, reqs
        r = reqs[0]
        assert r['purpose'] == 'reply-draft' and r['fileAccess'] is True and r['blind'] is True, r
        assert 'refactor the session module' in r['context'] and 'Please fix the login bug' in r['context'], r['context']
        assert r['prompt'] == 'Say later, keep the diff small' and len(r['legs']) == 2, r

        # Defaults: both switches off; a typed question alone is enough (composer entry).
        await page.evaluate("cs.useCompareStore.getState().closeDialog(); cs.useCompareStore.getState().openDialog('wf-a')")
        dlg = page.locator('[data-help="composer.compare"]')
        await expect(page.get_by_test_id('second-opinion-excerpt')).to_have_count(0)
        await expect(dlg.get_by_role('button', name='ASK THE MODELS')).to_be_disabled()
        await expect(dlg.get_by_label('Include this tab', exact=False)).not_to_be_checked()
        await expect(dlg.get_by_label('Let the models read project files', exact=False)).not_to_be_checked()
        await dlg.get_by_placeholder('e.g. The worker asks', exact=False).fill('What should I answer?')
        await dlg.get_by_role('button', name='ASK THE MODELS').click()
        reqs = await page.evaluate('requests')
        assert reqs[1]['fileAccess'] is False and reqs[1]['context'] == '', reqs[1]

        # Results: blind drafts, pick one, tally, USE THIS REPLY fills the composer without sending.
        await page.evaluate('''() => {
          const st = cs.useCompareStore.getState();
          st.onStarted({workflowId:'wf-a',compareId:'cmp-1',prompt:'What should I answer?',blind:true,purpose:'reply-draft',legs:[{provider:'claude',model:'opus',effort:'high'},{provider:'codex',model:'gpt-5',effort:'medium'}]});
          st.onLegComplete('cmp-1',0,'Later. Keep this change small.',1200);
          st.onLegComplete('cmp-1',1,'Do it now, in a separate commit.',900);
          st.onComplete('cmp-1');
        }''')
        await expect(page.get_by_text('DRAFT A', exact=False).first).to_be_visible()
        assert 'claude' not in (await page.locator('body').inner_text()).lower().split('pick a draft')[-1][:400]
        await expect(page.get_by_role('button', name='USE THIS REPLY')).to_have_count(0)
        await page.get_by_role('button', name='PICK THIS DRAFT').first.click()
        assert await page.evaluate('votes') == [['wf-a', 'cmp-1', 0]]
        tally = await page.evaluate("JSON.parse(localStorage.getItem('arco.secondOpinion.picks'))")
        assert tally == {'claude/opus': 1}, tally
        await page.evaluate("cs.useCompareStore.getState().onVoteRecorded('cmp-1', 0)")
        await page.evaluate("drafts.getState().setDraft('wf-a', 'half-typed note')")
        await page.get_by_role('button', name='USE THIS REPLY').click()
        assert await page.evaluate("drafts.getState().drafts['wf-a']") == 'Later. Keep this change small.'
        assert await page.evaluate("drafts.getState().tidyUndo['wf-a'].original") == 'half-typed note'
        assert await page.evaluate('requests.length') == 2, 'nothing is sent by USE THIS REPLY'
        await expect(page.get_by_text('DRAFT A', exact=False)).to_have_count(0)

        # The dialog now shows the running tally.
        await page.evaluate("cs.useCompareStore.getState().openDialog('wf-a')")
        await expect(page.get_by_test_id('second-opinion-tally')).to_contain_text('claude/opus 1')
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: second opinion from a selection or a typed question, switches default off, reply-draft request, corrected hint, blind drafts, pick tally, USE THIS REPLY fills the composer with undo and sends nothing')

asyncio.run(main())
