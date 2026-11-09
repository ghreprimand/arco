"""New workflow page per mode: which controls appear, their order and wording, and what each create sends. Synthetic APIs, no provider calls."""
import asyncio
import os
from pathlib import Path
from urllib.parse import unquote, urlparse, parse_qs
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path, fs_url
from host_isolation import chrome_executable

PORT = os.environ.get('ARCO_CLIENT_PORT', '5209')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><body><div id="fixture" style="width:1000px"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>'''
PRESET = {'id': 'preset-local', 'name': 'Local pair', 'createdAt': '2026-10-01T00:00:00Z', 'members': [
    {'provider': 'claude', 'model': 'sonnet', 'effort': 'medium', 'role': 'Reviewer role.'},
    {'provider': 'ollama', 'model': 'local-model', 'effort': 'low'},
]}
LEGACY_PRESET = {'id': 'legacy-directors', 'name': 'Legacy directors', 'createdAt': '2026-10-01T00:00:00Z', 'members': [
    {'provider': 'claude', 'model': 'sonnet', 'effort': 'medium', 'role': 'Director first'},
    {'provider': 'claude', 'model': 'sonnet', 'effort': 'medium', 'role': 'Coordinator second'},
]}
SESSIONS = [{'sessionId': 'saved-session-1', 'provider': 'claude', 'name': 'Earlier work', 'startedAt': 1793210400000, 'cwd': '/projects/fixture'}]


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page(viewport={'width': 1300, 'height': 1000})
        errors, blocked, writes = [], [], []
        public_choices = {}
        delayed_choice = {'enabled': False, 'entered': asyncio.Event(), 'release': asyncio.Event()}

        async def isolate(route):
            u = urlparse(route.request.url)
            if u.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(content_type='text/css', body=''); return
            if u.scheme == 'http' and u.netloc == '127.0.0.1:' + PORT:
                if u.path == '/fixture':
                    await route.fulfill(content_type='text/html', body=HTML); return
                if u.path == '/api/public-project/choice':
                    if route.request.method == 'POST':
                        body = route.request.post_data_json
                        public_choices[body['path']] = body['value']
                        await route.fulfill(json={'choice': body['value']}); return
                    if delayed_choice['enabled']:
                        delayed_choice['entered'].set()
                        await delayed_choice['release'].wait()
                    await route.fulfill(json={'choice': public_choices.get(parse_qs(u.query)['path'][0])}); return
                if u.path.startswith('/api/'):
                    if route.request.method != 'GET':
                        writes.append(u.path)
                    if u.path == '/api/plans' and route.request.method == 'POST':
                        body = route.request.post_data_json
                        await route.fulfill(json={'plan': {'id': 'new-plan', 'title': body['title'], 'body': body['body'], 'createdAt': 1, 'updatedAt': 1}}); return
                    data = {'items': [], 'projects': [], 'roots': [], 'sessions': [], 'presets': [], 'templates': [], 'skills': [], 'models': [], 'clusters': [], 'chats': []}
                    if u.path == '/api/cluster-presets':
                        data['presets'] = [PRESET, LEGACY_PRESET]
                    if u.path == '/api/sessions':
                        data['sessions'] = SESSIONS
                    if u.path == '/api/plans':
                        data['plans'] = [{'id': 'fixture-plan', 'title': 'Fixture plan', 'createdAt': 1, 'updatedAt': 1}]
                    if u.path == '/api/plans/body':
                        data = {'plan': {'id': 'fixture-plan', 'title': 'Fixture plan', 'createdAt': 1, 'updatedAt': 1, 'body': '- [ ] Task'}}
                    await route.fulfill(json=data); return
                path = unquote(u.path)
                local = path.startswith('/@fs/') and fs_path(path).resolve().is_relative_to(ROOT)
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
          const {handleServerMessage}=await import('/src/ws/handleServerMessage.ts');
          window.finishCreate=requestId=>handleServerMessage({type:'cluster_creation_finished',requestId},{wsRef:{current:null},scheduleReconnect(){}});
          const root=createRoot(document.getElementById('fixture')); let gen=0;
          const fullAuth={claude:{loggedIn:true},codex:{loggedIn:true},ollama:{loggedIn:false,installedModels:[]},cursor:{loggedIn:true},llamacpp:{loggedIn:false}};
          window.show=(mode,opt={})=>{
            s.setState({connected:true,clusterCreationPending:false,creatorPrefill:{mode,...(mode==='single'||mode==='cluster'?{workDir:'/projects/fixture'}:{})},
              settings:{enabledProviders:{claude:true,codex:true,ollama:true,cursor:false},workflowDefaults:opt.defaults??{primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'medium'},projectRoots:[]},
              authStatus:opt.auth??fullAuth});
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
        await page.locator('[data-help="creator.name"] input').fill('Harbor idea')
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
        await expect(rows.first).not_to_contain_text('Work size')
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
        await expect(rows.first).to_contain_text('Work size: heavy')

        # A second director is disabled, including typed coordinator text.
        await rows.first.get_by_role('button', name='↓ EDIT').click()
        await rows.first.get_by_role('button', name='DIRECTOR', exact=True).click()
        await rows.nth(1).get_by_role('button', name='↓ EDIT').click()
        await expect(rows.nth(1).get_by_role('button', name='DIRECTOR', exact=True)).to_be_disabled()
        role_input = rows.nth(1).get_by_placeholder('(optional: pick a preset above or type a custom role, ≤120 chars)')
        await role_input.fill('Coordinator custom')
        await expect(page.get_by_role('button', name='CREATE CLUSTER', exact=True)).to_be_disabled()
        await expect(rows.nth(1).get_by_role('alert')).to_contain_text('at most one director')
        await role_input.fill('')
        await rows.nth(1).get_by_role('button', name='↑ COLLAPSE').click()
        await rows.first.get_by_role('button', name='↑ COLLAPSE').click()

        # Historical presets load unchanged but require a role correction before launch.
        await page.get_by_role('button', name='Legacy directors', exact=True).click()
        await expect(rows.first).to_contain_text('Director first')
        await expect(rows.nth(1)).to_contain_text('Coordinator second')
        await expect(page.get_by_role('button', name='CREATE CLUSTER', exact=True)).to_be_disabled()
        await expect(page.get_by_text("Change one director's role.", exact=False).first).to_be_visible()
        await rows.nth(1).get_by_role('button', name='↓ EDIT').click()
        await rows.nth(1).get_by_placeholder('(optional: pick a preset above or type a custom role, ≤120 chars)').fill('Builder')
        await expect(page.get_by_role('button', name='CREATE CLUSTER', exact=True)).to_be_enabled()
        await rows.nth(1).get_by_role('button', name='↑ COLLAPSE').click()
        assert LEGACY_PRESET['members'][1]['role'] == 'Coordinator second'

        # A saved preset keeps an unavailable provider visible instead of dropping it.
        await page.get_by_role('button', name='Local pair', exact=True).click()
        await expect(rows.nth(1)).to_contain_text('Ollama (not connected)')
        await expect(page.get_by_role('button', name='CREATE CLUSTER', exact=True)).to_be_disabled()
        await expect(page.get_by_test_id('cluster-provider-problem')).to_contain_text('Member #2')
        await expect(page.get_by_test_id('cluster-provider-problem')).to_contain_text('Ollama')
        await expect(page.get_by_test_id('cluster-provider-problem').get_by_role('button', name='Open Connections')).to_be_visible()
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
        assert 'initialPlanGoal' not in cluster

        # A purpose requests a reviewable director draft; no director is never chosen silently.
        await page.evaluate("show('cluster')")
        toggle = page.get_by_label('Have the director draft a plan after creation')
        await expect(toggle).not_to_be_checked()
        await toggle.check()
        goal = page.get_by_label('Project description')
        await page.get_by_test_id('creator-public-project').check()
        await goal.fill('Build a fixture tool')
        await expect(page.get_by_role('button', name='CREATE CLUSTER', exact=True)).to_be_disabled()
        await expect(page.get_by_text('Add more detail: the goal, what done looks like, constraints, and what must not change.', exact=False)).to_be_visible()
        await expect(page.get_by_text('Choose a director below to draft the plan.', exact=False)).to_be_visible()
        rows = page.locator('[data-help="creator.cluster-members"] > div[style*="border"]')
        await rows.first.get_by_role('button', name='↓ EDIT').click()
        await rows.first.get_by_role('button', name='DIRECTOR', exact=True).click()
        await rows.first.get_by_role('button', name='↑ COLLAPSE').click()
        await expect(page.get_by_role('button', name='CREATE CLUSTER', exact=True)).to_be_disabled()
        description = 'Build a fixture tool that tracks work for a small team and keeps saved project data intact while working entirely offline.'
        await goal.fill(description)
        await page.get_by_role('button', name='CREATE CLUSTER', exact=True).click()
        await page.wait_for_function('clusters.length===2')
        assert (await page.evaluate('clusters[1].initialPlanGoal')) == description
        assert public_choices['/projects/fixture'] is True
        await page.evaluate("show('cluster')")
        await expect(page.get_by_label('No plan', exact=True)).to_be_checked()
        await expect(page.get_by_role('button', name='CREATE CLUSTER', exact=True)).to_be_enabled()
        await page.get_by_role('button', name='CREATE CLUSTER', exact=True).click()
        await page.wait_for_function('clusters.length===3')
        assert 'initialPlanGoal' not in (await page.evaluate('clusters[2]'))

        # An existing plan attaches without requiring a director.
        await page.evaluate("show('cluster')")
        await page.get_by_label('Attach an existing plan', exact=True).check()
        await page.get_by_role('button', name='Attach Fixture plan', exact=True).click()
        await expect(page.get_by_text('Selected plan: Fixture plan', exact=True)).to_be_visible()
        folder = page.get_by_placeholder('Pick a project below, or type a folder path', exact=True)
        await folder.fill('/projects/other')
        await expect(page.get_by_label('No plan', exact=True)).to_be_checked()
        await folder.fill('/projects/fixture')
        await page.get_by_label('Attach an existing plan', exact=True).check()
        await page.get_by_role('button', name='Attach Fixture plan', exact=True).click()
        # A pending project-choice refresh cannot delay the create request.
        delayed_choice['enabled'] = True
        try:
            await page.get_by_role('button', name='CREATE CLUSTER', exact=True).click()
            await page.wait_for_function('clusters.length===4', timeout=1000)
            await expect(page.get_by_role('button', name='Starting...', exact=True)).to_be_disabled()
        finally:
            delayed_choice['release'].set()
            delayed_choice['enabled'] = False
        delayed_choice['entered'] = asyncio.Event()
        delayed_choice['release'] = asyncio.Event()
        assert (await page.evaluate('clusters[3].initialPlanId')) == 'fixture-plan'
        await page.evaluate("finishCreate('unrelated-request')")
        await expect(page.get_by_role('button', name='Starting...', exact=True)).to_be_disabled()
        await page.evaluate('finishCreate(clusters[3].requestId)')
        await expect(page.get_by_role('button', name='CREATE CLUSTER', exact=True)).to_be_enabled()

        await page.evaluate("show('cluster')")
        await page.get_by_label('Attach an existing plan', exact=True).check()
        await page.get_by_role('button', name='+ NEW PLAN', exact=True).click()
        await page.get_by_label('Plan title', exact=True).fill('New plan')
        await page.get_by_label('Plan body', exact=True).fill('### Phase\n- [ ] Task')
        await page.get_by_role('button', name='CREATE AND ATTACH', exact=True).click()
        await expect(page.get_by_text('Selected plan: New plan', exact=True)).to_be_visible()

        # The saved-message contract returns to the kept creator with the plan selected.
        await page.evaluate("show('cluster'); window.rawMessages=[]; s.setState({wsSendRaw:m=>rawMessages.push(m)});")
        name = page.get_by_placeholder('Optional. Leave empty to name it after the folder.')
        await name.fill('Kept creator')
        await page.get_by_label('Draft in Genesis first', exact=True).check()
        await expect(page.get_by_test_id('creator-public-project')).to_be_visible()
        await page.get_by_role('button', name='OPEN GENESIS', exact=True).click()
        await page.wait_for_function("rawMessages.some(m=>m.type==='create_workflow')")
        config = await page.evaluate("rawMessages.find(m=>m.type==='create_workflow').config")
        assert config['workingDirectory'] == '/projects/fixture' and config['genesisSeed']['planOnly'] is True
        await page.evaluate('''async config => {
          const {handleServerMessage: receive}=await import('/src/ws/handleServerMessage.ts');
          const d={wsRef:{current:null},scheduleReconnect:()=>{}};
          receive({type:'workflow_created',workflowId:'genesis-creator',config},d);
          receive({type:'genesis_plan_saved',workflowId:'genesis-creator',cwd:'/projects/fixture',planId:'fixture-plan',written:[]},d);
        }''', config)
        await expect(page.get_by_text('Selected plan: Fixture plan', exact=True)).to_be_visible()
        await expect(name).to_have_value('Kept creator')

        # A delayed choice refresh must not open Genesis for a folder left behind.
        await page.evaluate("show('cluster'); window.rawMessages=[]; s.setState({wsSendRaw:m=>rawMessages.push(m)});")
        delayed_choice['enabled'] = True
        await page.get_by_label('Draft in Genesis first', exact=True).check()
        await page.get_by_role('button', name='OPEN GENESIS', exact=True).click()
        await asyncio.wait_for(delayed_choice['entered'].wait(), 5)
        await page.get_by_placeholder('Pick a project below, or type a folder path', exact=True).fill('/projects/other')
        delayed_choice['release'].set()
        delayed_choice['enabled'] = False
        await page.wait_for_timeout(150)
        assert not await page.evaluate("rawMessages.some(m=>m.type==='create_workflow')")

        # Codex-only home, no saved provider: single and chat start on Codex.
        codex_only = "{claude:{loggedIn:false},codex:{loggedIn:true},ollama:{loggedIn:false,installedModels:[]},cursor:{loggedIn:false},llamacpp:{loggedIn:false}}"
        picker = page.locator('[data-help="creator.provider"] select')
        problem = page.get_by_test_id('creator-provider-problem')
        for mode, button in [('single', 'LAUNCH WORKFLOW'), ('chat', 'START CHAT')]:
            await page.evaluate(f"show('{mode}', {{defaults:{{}}, auth:{codex_only}}})")
            await expect(picker).to_have_value('codex')
            assert await picker.locator('option').all_inner_texts() == ['CODEX: GPT'], 'only the connected provider is offered'
            await expect(problem).to_have_count(0)
            await expect(page.get_by_role('button', name=button, exact=True)).to_be_enabled()
            before = await page.evaluate('created.length')
            await page.get_by_role('button', name=button, exact=True).click()
            await page.wait_for_function(f'created.length==={before + 1}')
            sent = await page.evaluate('created[created.length-1]')
            assert sent['primaryProvider'] == 'codex', (mode, sent)
            assert sent['primaryModel'] and 'claude' not in str(sent['primaryModel']), (mode, sent)

        # Codex-only home with a saved Claude default: Claude stays selected,
        # marked not connected, launch is disabled with a reason and a link.
        await page.evaluate(f"show('single', {{auth:{codex_only}}})")
        await expect(picker).to_have_value('claude')
        assert await picker.locator('option').all_inner_texts() == ['CLAUDE: default (not connected)', 'CODEX: GPT']
        await expect(problem).to_contain_text('Claude is not connected. Choose a connected provider or sign in from Connections.')
        await expect(page.get_by_role('button', name='LAUNCH WORKFLOW', exact=True)).to_be_disabled()
        assert await page.evaluate("s.getState().settings.workflowDefaults.primaryProvider") == 'claude', 'saved default untouched'
        await problem.get_by_role('button', name='Open Connections', exact=True).click()
        assert await page.evaluate('st.getState().setupOpen') is True
        await page.evaluate('st.setState({setupOpen:false})')
        await picker.select_option('codex')
        await expect(problem).to_have_count(0)
        await expect(page.get_by_role('button', name='LAUNCH WORKFLOW', exact=True)).to_be_enabled()
        before = await page.evaluate('created.length')
        await page.get_by_role('button', name='LAUNCH WORKFLOW', exact=True).click()
        await page.wait_for_function(f'created.length==={before + 1}')
        assert (await page.evaluate('created[created.length-1]'))['primaryProvider'] == 'codex'

        # No provider connected: nothing to pick, every primary launch is disabled.
        none = "{claude:{loggedIn:false},codex:{loggedIn:false},ollama:{loggedIn:false,installedModels:[]},cursor:{loggedIn:false},llamacpp:{loggedIn:false}}"
        for mode, button in [('single', 'LAUNCH WORKFLOW'), ('chat', 'START CHAT')]:
            await page.evaluate(f"show('{mode}', {{defaults:{{}}, auth:{none}}})")
            await expect(problem).to_contain_text('No provider is connected. Connect one in Connections to launch.')
            await expect(problem.get_by_role('button', name='Open Connections', exact=True)).to_be_visible()
            await expect(page.get_by_role('button', name=button, exact=True)).to_be_disabled()
            await page.get_by_role('button', name=button, exact=True).click(force=True)
        await page.wait_for_timeout(200)
        await page.evaluate("show('genesis', {defaults:{}, auth:%s})" % none)
        await page.locator('[data-help="creator.name"] input').fill('Harbor idea')
        await page.locator('[data-help="creator.genesis-spark"] textarea').fill('A small synthetic idea.')
        await expect(page.get_by_role('button', name='START GENESIS', exact=True)).to_be_disabled()
        assert await page.evaluate('created.length') == before + 1, 'nothing launched without a connected provider'

        assert writes == ['/api/plans'], writes
        assert not blocked, blocked
        assert not errors, errors
        await browser.close()
        print('PASS creator modes: single sends Ultracode/advanced; chat hides unsent Claude tuning; Genesis and cluster hide Ultracode, Advanced and Resume; cluster order, words, connected providers, permission notes and preset fallback; Codex-only and no-provider homes pick or block the primary provider')

asyncio.run(main())
