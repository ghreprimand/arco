"""New workflow page per mode: which controls appear, their order and wording, and what each create sends. Synthetic APIs, no provider calls."""
import asyncio
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect

PORT = os.environ.get('ARCO_CLIENT_PORT', '5209')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><body><div id="fixture" style="width:1000px"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>'''
PRESET = {'id': 'preset-local', 'name': 'Local pair', 'createdAt': '2026-10-01T00:00:00Z', 'members': [
    {'provider': 'claude', 'model': 'sonnet', 'effort': 'medium', 'role': 'Reviewer role.'},
    {'provider': 'ollama', 'model': 'local-model', 'effort': 'low'},
]}
SESSIONS = [{'sessionId': 'saved-session-1', 'provider': 'claude', 'name': 'Earlier work', 'startedAt': 1793210400000, 'cwd': '/projects/fixture'}]


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1300, 'height': 1000})
        errors, blocked, writes = [], [], []

        async def isolate(route):
            u = urlparse(route.request.url)
            if u.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(content_type='text/css', body=''); return
            if u.scheme == 'http' and u.netloc == '127.0.0.1:' + PORT:
                if u.path == '/fixture':
                    await route.fulfill(content_type='text/html', body=HTML); return
                if u.path.startswith('/api/'):
                    if route.request.method != 'GET':
                        writes.append(u.path)
                    data = {'items': [], 'projects': [], 'roots': [], 'sessions': [], 'presets': [], 'templates': [], 'skills': [], 'models': [], 'clusters': [], 'chats': []}
                    if u.path == '/api/cluster-presets':
                        data['presets'] = [PRESET]
                    if u.path == '/api/sessions':
                        data['sessions'] = SESSIONS
                    await route.fulfill(json=data); return
                path = unquote(u.path)
                local = path.startswith('/@fs/') and Path(path[4:]).resolve().is_relative_to(ROOT)
                if local or path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/')):
                    await route.continue_(); return
            blocked.append(route.request.url); await route.abort()

        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady')
        await page.evaluate('''async () => {
          await import('/src/styles/global.css');
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {WorkflowCreator}=await import('/src/components/WorkflowCreator/index.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts');
          const {useStartupStore:st}=await import('/src/stores/startupStore.ts');
          window.s=s; window.st=st; window.created=[]; window.clusters=[];
          const root=createRoot(document.getElementById('fixture')); let gen=0;
          window.show=(mode)=>{
            s.setState({connected:true,creatorPrefill:{mode,...(mode==='single'||mode==='cluster'?{workDir:'/projects/fixture'}:{})},
              settings:{enabledProviders:{claude:true,codex:true,ollama:true,cursor:false},workflowDefaults:{primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'medium'},projectRoots:[]},
              authStatus:{claude:{loggedIn:true},codex:{loggedIn:true},ollama:{loggedIn:false,installedModels:[]},cursor:{loggedIn:true},llamacpp:{loggedIn:false}}});
            root.render(React.createElement(WorkflowCreator,{key:++gen,onCreate:c=>created.push(c),onCreateCluster:c=>clusters.push(c)}));
          };
        }''')

        absent = lambda sel: expect(page.locator(sel)).to_have_count(0)

        # Single workflow: every single-only control is present and sent.
        await page.evaluate("show('single')")
        await expect(page.locator('[data-help="creator.ultracode"]')).to_be_visible()
        await expect(page.locator('[data-help="creator.resume"]')).to_be_visible()
        await expect(page.locator('[data-help="creator.advanced"]')).to_be_visible()
        await expect(page.get_by_text('SAVED TEMPLATES', exact=True)).to_be_visible()
        await expect(page.get_by_text('AUTO: tools run without asking, with full access to this computer.', exact=True)).to_be_visible()
        await page.locator('[data-help="creator.advanced"] button').first.click()
        await expect(page.locator('[data-help="creator.fallback-model"]')).to_contain_text('Claude Native ignores it')
        await page.locator('[data-help="creator.additional-dirs"] textarea').fill('/projects/shared')
        order = await page.evaluate('''() => { const a=document.querySelector('[data-help="creator.cwd"]'), b=document.querySelector('[data-help="creator.launch"]'), t=[...document.querySelectorAll('label')].find(l=>l.textContent==='SAVED TEMPLATES');
          return !!(a.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(t.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); }''')
        assert order, 'saved templates follow the required folder and precede launch'
        await page.locator('[data-help="creator.ultracode"] button').click()
        await page.get_by_role('button', name='LAUNCH WORKFLOW', exact=True).click()
        await page.wait_for_function('created.length===1')
        single = await page.evaluate('created[0]')
        assert single['workingDirectory'] == '/projects/fixture' and single.get('ultracode') is True and single['advanced'] == {'additionalDirectories': ['/projects/shared']}, single

        # Chat: Claude fast mode and tool filter are not sent, so they are hidden.
        await page.evaluate("show('chat')")
        await expect(page.locator('[data-help="creator.output-style"]')).to_be_visible()
        for sel in ['creator.fast-mode', 'creator.tool-filter', 'creator.ultracode', 'creator.advanced', 'creator.resume', 'creator.permissions']:
            await absent(f'[data-help="{sel}"]')
        await expect(page.get_by_text('OUTPUT TUNING', exact=True)).to_be_visible()
        await page.get_by_role('button', name='START CHAT', exact=True).click()
        await page.wait_for_function('created.length===2')
        chat = await page.evaluate('created[1]')
        assert chat['kind'] == 'chat' and 'fastMode' not in chat and 'efficiencyToolFilter' not in chat and 'ultracode' not in chat, chat

        # Genesis: plain wording; no Ultracode, Advanced options or Resume.
        await page.evaluate("show('genesis')")
        await expect(page.get_by_text('Describe your idea; create files later', exact=True)).to_be_visible()
        await expect(page.get_by_text('YOUR IDEA', exact=True)).to_be_visible()
        for sel in ['creator.ultracode', 'creator.advanced', 'creator.resume', 'creator.cwd']:
            await absent(f'[data-help="{sel}"]')
        await page.locator('[data-help="creator.name"]').locator('xpath=..').locator('input').fill('Harbor idea')
        await page.locator('[data-help="creator.genesis-spark"] textarea').fill('A small synthetic idea.')
        await page.get_by_role('button', name='START GENESIS', exact=True).click()
        await page.wait_for_function('created.length===3')
        genesis = await page.evaluate('created[2]')
        assert genesis['genesisSeed']['spark'] == 'A small synthetic idea.' and 'ultracode' not in genesis and 'advanced' not in genesis, genesis

        # Cluster: required folder and members first; defaults and policy collapsed.
        await page.evaluate("show('cluster')")
        await expect(page.get_by_text('Several agents, one shared project folder', exact=True)).to_be_visible()
        await expect(page.get_by_text('SHARED PROJECT FOLDER', exact=True)).to_be_visible()
        for sel in ['creator.ultracode', 'creator.advanced', 'creator.resume', 'creator.effort']:
            await absent(f'[data-help="{sel}"]')
        rows = page.locator('[data-help="creator.cluster-members"] > div[style*="border"]')
        await expect(rows).to_have_count(2)
        await expect(rows.first).to_contain_text('Role not set')
        await expect(rows.first).to_contain_text('Tier not set')
        await expect(rows.first).to_contain_text('medium effort')
        order = await page.evaluate('''() => { const pos=(sel)=>document.querySelector(sel); const before=(a,b)=>!!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
          const cwd=pos('[data-help="creator.cwd"]'), members=pos('[data-help="creator.cluster-members"]'), defaults=pos('[data-help="creator.member-defaults"]'),
            policy=pos('button[aria-controls="creator-cluster-policy"]'), presets=[...document.querySelectorAll('label')].find(l=>l.textContent==='SAVED CLUSTER PRESETS'), launch=pos('[data-help="creator.launch"]');
          return [before(cwd,members), before(members,defaults), before(defaults,policy), before(policy,presets), before(presets,launch)]; }''')
        assert all(order), ('cluster order: folder, members, defaults, policy, saved presets, launch', order)
        await rows.first.get_by_role('button', name='↓ EDIT').click()
        editor = rows.first
        providers = await editor.locator('xpath=.//label[text()="PROVIDER"]/following-sibling::div[1]/button').all_inner_texts()
        assert providers == ['CLAUDE', 'CODEX'], ('only enabled, connected member providers', providers)
        await expect(editor.get_by_text('AUTO: tools run without asking, with full access to this computer.', exact=True)).to_be_visible()
        await expect(editor.get_by_text('TUNING FOR THIS MEMBER', exact=True)).to_be_visible()
        await editor.get_by_role('button', name='Connect another provider', exact=True).click()
        assert await page.evaluate('st.getState().setupOpen') is True
        await page.evaluate('st.setState({setupOpen:false})')
        await editor.get_by_role('button', name='SAFE', exact=True).click()
        await expect(editor.get_by_text('SAFE: privileged tool calls wait for your approval.', exact=True)).to_be_visible()
        await editor.get_by_role('button', name='BUILDER', exact=True).click()
        await editor.get_by_role('button', name='HEAVY', exact=True).click()
        await editor.get_by_role('button', name='↑ COLLAPSE').click()
        await expect(rows.first).to_contain_text('Builder')
        await expect(rows.first).to_contain_text('Heavy tier')

        # A saved preset keeps an unavailable provider visible instead of dropping it.
        await page.get_by_role('button', name='Local pair', exact=True).click()
        await expect(rows.nth(1)).to_contain_text('Ollama (not connected)')
        await rows.nth(1).get_by_role('button', name='↓ EDIT').click()
        await expect(rows.nth(1).get_by_role('button', name='OLLAMA (NOT CONNECTED)', exact=True)).to_be_visible()
        await rows.nth(1).get_by_role('button', name='CODEX', exact=True).click()
        await rows.nth(1).get_by_role('button', name='↑ COLLAPSE').click()

        defaults = page.locator('button[aria-controls="creator-member-defaults"]')
        await expect(defaults).to_have_attribute('aria-expanded', 'false')
        await expect(page.get_by_text('Existing members do not change', exact=False)).to_be_visible()
        await page.get_by_role('button', name='CREATE CLUSTER', exact=True).click()
        await page.wait_for_function('clusters.length===1')
        cluster = await page.evaluate('clusters[0]')
        members = cluster['members']
        assert cluster['cwd'] == '/projects/fixture' and len(members) == 2, cluster
        assert [m['provider'] for m in members] == ['claude', 'codex'], members
        assert members[0]['role'] == 'Reviewer role.' and all('ultracode' not in m for m in members), members
        assert 'advanced' not in cluster and 'resumeSessionId' not in cluster, cluster

        assert writes == [], writes
        assert not blocked, blocked
        assert not errors, errors
        await browser.close()
        print('PASS creator modes: single sends Ultracode/advanced; chat hides unsent Claude tuning; Genesis and cluster hide Ultracode, Advanced and Resume; cluster order, words, connected providers, permission notes and preset fallback')

asyncio.run(main())
