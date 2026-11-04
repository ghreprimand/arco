"""One skills menu with fixture APIs, no provider execution or real writes."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.async_api import async_playwright, expect
from fs_url import fs_path

PORT = os.environ.get('ARCO_CLIENT_PORT', '5203')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><body><div id="fixture"></div><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type;
window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;
</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1100, 'height': 900})
        state = {'empty': False, 'requests': [], 'saves': []}
        errors, blocked = [], []
        async def route(req):
            url = urlparse(req.request.url)
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                if url.path == '/fixture': await req.fulfill(content_type='text/html', body=HTML); return
                if url.path == '/api/skills/audit':
                    await req.fulfill(json={'findings':[{'severity':'info','kind':'fixture','detail':'Diagnostic checked.'}]}); return
                if url.path == '/api/skills':
                    if req.request.method == 'POST':
                        state['saves'].append(json.loads(req.request.post_data or '{}'))
                        await req.fulfill(json={'ok': True}); return
                    skill = {'scope':'project','slug':'review','name':'Review guide','description':'Review carefully','operatorOnly':True}
                    await req.fulfill(json={'project': [] if state['empty'] else [skill], 'global': []}); return
                if url.path == '/api/toolbox':
                    query = parse_qs(url.query); state['requests'].append(query)
                    provider = query.get('provider', [''])[0]; transport = query.get('transport', [''])[0]
                    supported = provider == 'codex' or (provider == 'claude' and transport == 'cli')
                    entry = {'name':'fixture','description':'Native fixture','provider':provider,'source':'user','invocation':'$fixture' if provider == 'codex' else '/fixture'}
                    await req.fulfill(json={'provider':provider,'supported':supported,'entries':[entry] if supported else []}); return
                if url.path.startswith('/api/'): await req.fulfill(json={}); return
                local = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if req.request.method == 'GET' and (local or url.path.startswith(('/@react-refresh','/@vite/','/@id/','/node_modules/','/src/'))): await req.continue_(); return
            blocked.append(url.path); await req.abort()
        await page.route('**/*', route); await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(ORIGIN + '/fixture'); await page.wait_for_function('window.fixtureReady === true')
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {TerminalInput}=await import('/src/components/TerminalInput.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts'); window.s=s;
          const {useDraftStore:d}=await import('/src/stores/draftStore.ts'); window.d=d;
          s.getState().createJob('fixture',{name:'Fixture',workingDirectory:'/fixture',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'medium',claudeTransport:'native',skipPermissions:false});
          s.setState({settings:{claude:{transport:'native'},enabledProviders:{claude:true,codex:true}}, authStatus:{claude:{loggedIn:true},codex:{loggedIn:true}}});
          window.sent=[]; window.updates=[];
          function View(){const job=s(x=>x.jobs.fixture);return React.createElement(TerminalInput,{job,onSend:(...args)=>{window.sent.push(args);return true},onCancel:()=>{},onUpload:async()=>({}),onUpdatePrimary:(u)=>{window.updates.push(u);s.getState().updateJobPrimary('fixture',u)}})}
          createRoot(document.getElementById('fixture')).render(React.createElement(View));
        }''')
        button = page.get_by_role('button', name='SKILLS', exact=True)
        await button.click(); await expect(page.get_by_text('YOUR SKILLS', exact=True)).to_be_visible()
        await expect(page.get_by_text('Review guide', exact=True)).to_be_visible()
        await expect(page.get_by_text('OPERATOR', exact=True)).to_be_visible()
        await expect(page.get_by_label('Agent skills')).to_have_count(0)
        await page.get_by_role('button', name='APPLY ONCE').click()
        await expect(page.get_by_role('button', name='SKILLS', exact=False)).to_contain_text('1')
        await page.locator('textarea').first.click()
        await page.locator('textarea').first.fill('run')
        await page.locator('textarea').first.press('Enter')
        assert (await page.evaluate('window.sent[0][4]')) == [{'scope':'project','slug':'review'}]
        await page.get_by_role('button', name='SKILLS', exact=False).click()
        await page.get_by_role('button', name='PIN TO TAB').click()
        assert (await page.evaluate('window.updates.at(-1).pinnedSkills')) == [{'scope':'project','slug':'review'}]
        await page.get_by_role('button', name='UNPIN', exact=False).click()
        assert (await page.evaluate('window.updates.at(-1).pinnedSkills')) == []
        await page.get_by_role('button', name='NEW SKILL').click()
        await expect(page.get_by_text('NEW SKILL', exact=True).last).to_be_visible()
        editor = page.get_by_text('NEW SKILL', exact=True).last.locator('../..')
        await editor.locator('input[type="text"]').first.fill('New fixture')
        await editor.locator('textarea').fill('Reusable guidance')
        await editor.get_by_role('button', name='AUDIT', exact=True).click()
        await expect(editor.get_by_text('Diagnostic checked.', exact=False)).to_be_visible()
        await editor.get_by_role('button', name='SAVE', exact=True).click()
        assert state['saves'][-1]['name'] == 'New fixture'
        await page.evaluate("s.getState().updateJobPrimary('fixture',{provider:'codex'})")
        await page.get_by_role('button', name='SKILLS', exact=False).click()
        await expect(page.get_by_text('$fixture', exact=True)).to_be_visible()
        await page.get_by_text('$fixture', exact=True).click()
        assert state['requests'][-1].get('workflowId') == ['fixture']
        assert (await page.evaluate("d.getState().drafts.fixture")).startswith('$fixture ')
        await page.evaluate("s.getState().updateJobPrimary('fixture',{provider:'claude',claudeTransport:'cli'})")
        await page.get_by_role('button', name='SKILLS', exact=False).click()
        await expect(page.get_by_text('/fixture', exact=True)).to_be_visible()
        await page.get_by_text('/fixture', exact=True).click()
        assert (await page.evaluate("d.getState().drafts.fixture")).startswith('/fixture ')
        state['empty'] = True
        await page.get_by_role('button', name='SKILLS', exact=False).click()
        await expect(page.get_by_text('A skill is reusable guidance', exact=False)).to_be_visible()
        await expect(page.get_by_role('button', name='NEW SKILL')).to_be_visible()
        await page.evaluate("s.getState().updateJobPrimary('fixture',{provider:'ollama'})")
        await expect(page.get_by_label('Agent skills')).to_have_count(0)
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()

asyncio.run(main())
