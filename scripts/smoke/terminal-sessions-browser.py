"""Terminal session choices use synthetic API data and never reach providers."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults
from fs_url import fs_path

install_navigation_defaults()
ROOT = Path(__file__).resolve().parents[2]
PORT = os.environ.get('ARCO_CLIENT_PORT', '5233')
ORIGIN = 'http://127.0.0.1:' + PORT
HTML = '''<!doctype html><html><body><main id="fixture"></main><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true; window.ready = true;
</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page()
        errors, unexpected, discovered = [], [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        async def route_request(route):
            u = urlparse(route.request.url)
            if u.netloc == '127.0.0.1:' + PORT and u.path == '/fixture':
                await route.fulfill(status=200, content_type='text/html', body=HTML); return
            if u.netloc == '127.0.0.1:' + PORT and u.path == '/api/terminal-sessions':
                discovered.append(u.query)
                assert route.request.method == 'GET'
                rows = [] if 'empty' in u.query else [
                    {'provider':'claude','sessionId':'00000000-0000-4000-8000-000000000001','cwd':'/projects/a','name':'Claude terminal task','startedAt':1793670000000},
                    {'provider':'codex','sessionId':'00000000-0000-4000-8000-000000000002','cwd':'/projects/a','name':'Codex terminal task','startedAt':1793670000000},
                    {'provider':'codex','sessionId':'00000000-0000-4000-8000-000000000003','cwd':'/projects/a','name':'Already open','startedAt':1793670000000},
                ]
                await route.fulfill(json={'sessions':rows}); return
            if u.netloc == '127.0.0.1:' + PORT and u.path == '/api/projects':
                await route.fulfill(json={'roots':[{'name':'Projects','path':'/projects','exists':True}],'projects':[{'name':'a','path':'/projects/a','source':'registered','exists':True,'rootPath':'/projects'}],'organization':False}); return
            if u.netloc == '127.0.0.1:' + PORT and u.path.startswith('/api/'):
                await route.fulfill(json={'sessions':[], 'projects':[], 'roots':[], 'items':[], 'models':[], 'templates':[], 'presets':[]}); return
            if u.netloc == '127.0.0.1:' + PORT and (u.path.startswith(('/@react-refresh','/@vite/','/@id/','/node_modules/.vite/deps/','/src/')) or (u.path.startswith('/@fs/') and fs_path(u.path).resolve().is_relative_to(ROOT))):
                await route.continue_(); return
            unexpected.append(u.path); await route.abort()
        await page.route('**/*', route_request)
        await page.route_web_socket('**/*', lambda ws: None)
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.ready === true')
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {TerminalSessions}=await import('/src/components/TerminalSessions.tsx');
          const {ProjectCard}=await import('/src/components/Home/ProjectCard.tsx');
          const {HomeView}=await import('/src/components/Home/HomeView.tsx');
          const {WorkflowCreator}=await import('/src/components/WorkflowCreator/index.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts');
          window.s=s; window.opened=[];
          s.getState().createJob('active',{name:'Existing',workingDirectory:'/projects/a',primaryProvider:'codex',primaryModel:'m',primaryEffort:'low',skipPermissions:false,resumeSessionId:'00000000-0000-4000-8000-000000000003'});
          s.setState({connected:true,authStatus:{claude:{loggedIn:true,cli:{loggedIn:true}},codex:{loggedIn:true}}});
          window.root=createRoot(document.getElementById('fixture'));
          window.showHome=()=>root.render(React.createElement(HomeView,{onResume:c=>opened.push({home:c})}));
          window.showCard=()=>root.render(React.createElement(ProjectCard,{project:{path:'/projects/a',name:'a',source:'registered',exists:true},label:'a',work:[],organization:false,onOpen:()=>{},onStart:()=>{},onList:()=>{},announce:()=>{},onResumeTerminal:s=>opened.push({card:s})}));
          window.showCreator=()=>{s.getState().openCreatorWith({mode:'single',workDir:'/projects/a'});root.render(React.createElement(WorkflowCreator,{onCreate:c=>opened.push({config:c})}));};
          window.show=(cwd)=>root.render(React.createElement(TerminalSessions,{cwd,onOpen:s=>opened.push(s)}));
          show('/projects/a');
        }''')
        summary = page.get_by_text('Continue a session from the terminal', exact=True)
        await expect(summary).to_be_visible(); await summary.click()
        await expect(page.get_by_text('Already open', exact=False)).to_have_count(0)
        await expect(page.get_by_text('Close the terminal session', exact=False)).to_be_visible()
        await page.get_by_role('button', name='Open terminal session Claude terminal task').click()
        assert (await page.evaluate('opened[0]')).get('provider') == 'claude'
        await page.evaluate("s.setState({authStatus:{claude:{loggedIn:true,native:{credentialsPresent:true}},codex:{loggedIn:true}}})")
        await expect(page.get_by_role('button', name='Open terminal session Claude terminal task')).to_be_disabled()
        await expect(page.get_by_text('Connect Claude CLI in Settings', exact=False)).to_be_visible()
        await page.get_by_role('button', name='Open terminal session Codex terminal task').click()
        assert (await page.evaluate('opened[1]')).get('provider') == 'codex'
        async with page.expect_response(lambda response: '/api/terminal-sessions' in response.url and 'empty' in response.url):
            await page.evaluate("show('/projects/empty')")
        await expect(summary).to_have_count(0)
        await page.evaluate("s.setState({authStatus:{claude:{loggedIn:true,cli:{loggedIn:true}},codex:{loggedIn:true}}})")
        before = len(discovered)
        await page.evaluate('showCard()')
        await expect(page.get_by_label('More actions for a')).to_be_visible()
        await page.wait_for_timeout(500)
        assert len(discovered) == before, 'closed project menu started terminal discovery'
        await page.get_by_label('More actions for a').click()
        await expect(summary).to_be_visible(); await summary.click()
        await page.get_by_role('button', name='Open terminal session Claude terminal task').click()
        assert (await page.evaluate('opened[2].card')).get('provider') == 'claude'
        await page.evaluate('showCreator()')
        await expect(summary).to_be_visible(); await summary.click()
        await page.get_by_role('button', name='Open terminal session Codex terminal task').click()
        config = await page.evaluate('opened[3].config')
        assert config['primaryProvider'] == 'codex' and config['providerAccountRef'] == '@terminal', config
        assert config['resumeSessionId'].endswith('000002'), config
        await page.evaluate('showHome()')
        await page.get_by_label('More actions for a').click()
        await expect(summary).to_be_visible(); await summary.click()
        await page.get_by_role('button', name='Open terminal session Claude terminal task').click()
        home = await page.evaluate('opened[4].home')
        assert home['primaryProvider'] == 'claude' and home['claudeTransport'] == 'cli', home
        assert home['resumeSessionId'].endswith('000001'), home
        assert not errors, errors
        assert not unexpected, unexpected
        await browser.close()
        print('PASS: terminal sessions hide empty/open rows, gate CLI, and open explicit provider selection')

asyncio.run(main())
