"""Public-project guardrails: the box and its suggestion, INSERT GUARDRAILS and the project state notice, with stubbed routes."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults
from fs_url import fs_path
from host_isolation import chrome_executable

install_navigation_defaults()
ROOT = Path(__file__).resolve().parents[2]
PORT = os.environ.get('ARCO_CLIENT_PORT', '5246')
ORIGIN = 'http://127.0.0.1:' + PORT
HTML = '''<!doctype html><html><body><main id="fixture"></main><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true; window.ready = true;
</script></body></html>'''
REMOTES = {'/p/public': {'state': 'public', 'host': 'github.com'}, '/p/hosted': {'state': 'hosted', 'host': 'gitlab.com'}, '/p/none': {'state': 'none'}}

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page()
        errors, unexpected, posts, plan_attaches = [], [], [], []
        state = {'tracked': 2, 'ignored': True, 'plans': [], 'cluster_attach_status': 500}
        choices = {}
        page.on('pageerror', lambda e: errors.append(str(e)))
        async def route_request(route):
            u = urlparse(route.request.url)
            here = u.netloc == '127.0.0.1:' + PORT
            if here and u.path == '/fixture':
                await route.fulfill(status=200, content_type='text/html', body=HTML); return
            if here and u.path == '/api/plans/body':
                await route.fulfill(json={'plan': {'id':'agent-plan', 'title':'Agent plan', 'body':'# Agent plan\n\n### Phase\n- [ ] Task', 'createdAt':1, 'updatedAt':1}}); return
            if here and u.path == '/api/plans/attach' and route.request.method == 'POST':
                plan_attaches.append(parse_qs(u.query))
                await route.fulfill(json={'ok': True}); return
            if here and u.path == '/api/explorer/plans/attach' and route.request.method == 'POST':
                await route.fulfill(status=state['cluster_attach_status'], json={'error': 'fixture failure'} if state['cluster_attach_status'] != 200 else {'ok': True}); return
            if here and u.path in ('/api/plans', '/api/plans/refs'):
                await route.fulfill(json={'plans': state['plans'], 'refs': []}); return
            if here and u.path == '/api/public-project/choice':
                if route.request.method == 'POST':
                    data = route.request.post_data_json
                    choices[data['path']] = data['value']
                    await route.fulfill(json={'choice': data['value']}); return
                await route.fulfill(json={'choice': choices.get(parse_qs(u.query)['path'][0])}); return
            if here and u.path == '/api/public-project/remote':
                await route.fulfill(json=REMOTES.get(parse_qs(u.query)['path'][0], {'state': 'none'})); return
            if here and u.path == '/api/public-project/state':
                await route.fulfill(json={'isGit': True, 'hasState': True, 'tracked': state['tracked'], 'trackedSample': ['.arco/settings.json'][:state['tracked']], 'ignored': state['ignored'], 'ignoreFile': 'default' if state['ignored'] else 'edited'}); return
            if here and u.path in ('/api/public-project/restore-ignore', '/api/public-project/stop-tracking'):
                posts.append(u.path.rsplit('/', 1)[1])
                if u.path.endswith('restore-ignore'):
                    state['ignored'] = True
                    await route.fulfill(json={'ok': True, 'backup': '.gitignore.backup-test'}); return
                state['tracked'] = 0
                await route.fulfill(json={'ok': True, 'removed': 2}); return
            if here and (u.path.startswith(('/@react-refresh','/@vite/','/@id/','/node_modules/.vite/deps/','/src/')) or (u.path.startswith('/@fs/') and fs_path(u.path).resolve().is_relative_to(ROOT))):
                await route.continue_(); return
            unexpected.append(u.path); await route.abort()
        await page.route('**/*', route_request)
        await page.route_web_socket('**/*', lambda ws: None)
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.ready === true')
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {PublicProjectBox}=await import('/src/components/PublicProjectBox.tsx');
          const {ProjectStateNotice}=await import('/src/components/ProjectStateNotice.tsx');
          const {ClusterPlanTab}=await import('/src/components/ClusterPlanTab.tsx');
          const {effectivePublic}=await import('/src/utils/publicProject.ts');
          const {planDraftPrompt}=await import('/src/components/terminalInput/planDraft.ts');
          window.effectivePublic=effectivePublic; window.planDraftPrompt=planDraftPrompt;
          const h=React.createElement;
          const cluster={clusterId:'c1',cwd:'/p/none',createdAt:'',taskBoardMode:'none',members:[],plan:{id:'pl',title:'Demo',body:'# Demo\\n\\nIntro.\\n\\n### Phase one\\n- [ ] task\\n',updatedAt:1}};
          window.saved=[];
          window.root=createRoot(document.getElementById('fixture'));
          root.render(h('div',null,
            h(PublicProjectBox,{cwd:'/p/public',testId:'b-public'}),
            h(PublicProjectBox,{cwd:'/p/hosted',testId:'b-hosted'}),
            h(PublicProjectBox,{cwd:'/p/none',testId:'b-none'}),
            h(ProjectStateNotice,{cwd:'/p/state'}),
            h(ClusterPlanTab,{cluster,onSetPlan:(b)=>saved.push(b)})));
        }''')
        # Confirmed public: pre-ticked with a visible reason; hosted: hint only; none: nothing.
        await expect(page.get_by_test_id('b-public')).to_be_checked()
        await expect(page.get_by_test_id('b-public-reason')).to_contain_text('public on GitHub')
        await expect(page.get_by_test_id('b-hosted')).not_to_be_checked()
        await expect(page.get_by_test_id('b-hosted-hint')).to_contain_text('remote on gitlab.com')
        await expect(page.get_by_test_id('b-none')).not_to_be_checked()
        await expect(page.get_by_test_id('b-none-hint')).to_have_count(0)
        assert await page.evaluate("effectivePublic('/p/public')") is True
        assert await page.evaluate("effectivePublic('/p/hosted')") is False
        # An explicit choice wins over the suggestion and is remembered.
        await page.get_by_test_id('b-public').uncheck()
        await expect(page.get_by_test_id('b-public-reason')).to_have_count(0)
        assert await page.evaluate("effectivePublic('/p/public')") is False
        await page.get_by_test_id('b-hosted').check()
        assert await page.evaluate("effectivePublic('/p/hosted')") is True
        assert await page.evaluate("localStorage.getItem('arco.publicProject./p/hosted')") == '1'
        await page.wait_for_function("localStorage.getItem('arco.publicProject./p/hosted') === '1'")
        await page.wait_for_timeout(100)
        assert choices['/p/public'] is False and choices['/p/hosted'] is True, choices
        # Prompt: flagged adds the section request; unflagged is unchanged.
        flagged = await page.evaluate("planDraftPrompt('', 'review', false, true)")
        plain = await page.evaluate("planDraftPrompt('', 'review', false, false)")
        assert 'Privacy and public safety' in flagged and 'Privacy and public safety' not in plain
        assert flagged.startswith(plain)
        await expect(page.get_by_test_id('cluster-plan-public-project')).not_to_be_checked()
        await page.get_by_test_id('cluster-plan-public-project').check()
        await expect(page.get_by_test_id('b-none')).to_be_checked()
        # INSERT GUARDRAILS: unsaved edit before the first phase, disabled once present, never saved.
        insert = page.get_by_test_id('cluster-plan-insert-guardrails')
        await expect(insert).to_be_enabled()
        await insert.click()
        area = page.locator('textarea')
        value = await area.input_value()
        assert value.index('## Privacy and public safety') < value.index('### Phase one'), value
        await expect(insert).to_be_disabled()
        await expect(insert).to_have_attribute('title', 'Already in this plan')
        assert await page.evaluate('saved.length') == 0
        # A failed Genesis-plan attachment remains visible in view mode and can be retried.
        await page.get_by_role('button', name='CANCEL', exact=True).click()
        await expect(page.locator('textarea')).to_have_count(0)
        await page.evaluate('''async () => {
          const {usePlanGenesisStore:g}=await import('/src/stores/planGenesisStore.ts');
          g.setState({results:{'genesis-result':{origin:{kind:'cluster',cwd:'/p/none',clusterId:'c1'},planId:'new-plan'}}});
        }''')
        page.once('dialog', lambda dialog: dialog.accept())
        await page.get_by_role('button', name='ATTACH', exact=True).click()
        await expect(page.get_by_role('alert').filter(has_text='Failed to attach')).to_be_visible()
        await expect(page.get_by_text('Genesis saved a plan for this project.', exact=False)).to_be_visible()
        state['cluster_attach_status'] = 200
        page.once('dialog', lambda dialog: dialog.accept())
        await page.get_by_role('button', name='ATTACH', exact=True).click()
        await expect(page.get_by_role('alert').filter(has_text='Failed to attach')).to_have_count(0)
        await expect(page.get_by_text('Genesis saved a plan for this project.', exact=False)).to_have_count(0)
        # Single-tab manual creation and a proposed plan both expose the choice.
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {useAppStore:s}=await import('/src/stores/appStore.ts');
          const {PlanTab}=await import('/src/components/RightPanel/PlanTab.tsx');
          const {PlanComposerDialog}=await import('/src/components/PlanComposerDialog.tsx');
          const {PlanCandidateBanner}=await import('/src/components/PlanCandidateBanner.tsx');
          const {GenesisTab}=await import('/src/components/RightPanel/GenesisTab.tsx');
          s.getState().createJob('plan-fixture',{name:'Fixture',primaryProvider:'codex',primaryModel:'fixture',workingDirectory:'/p/hosted',skipPermissions:false});
          window.showPlanCase=(name)=>{
            const Component=()=>{
              const job=s(st=>st.jobs['plan-fixture']);
              if(name==='manual') return React.createElement(PlanTab,{job,onAttach:id=>{window.planAttached=id}});
              if(name==='dialog') return React.createElement(PlanComposerDialog,{job,onConfirm:()=>{},onCancel:()=>{}});
              if(name==='genesis') return React.createElement(GenesisTab,{job,onScaffold:(...args)=>window.scaffoldArgs=args});
              return React.createElement(PlanCandidateBanner,{job,onAttachPlan:()=>{},onSend:()=>true});
            };
            root.render(React.createElement(Component));
          };
          window.planStore=s;
        }''')
        state['plans'] = [{'id':'agent-plan', 'title':'Agent plan', 'createdAt':1, 'updatedAt':1}]
        await page.evaluate("showPlanCase('manual')")
        await page.evaluate("window.open=(url)=>{window.archiveUrl=url;return {focus:()=>{}}}")
        await page.get_by_role('button', name='ALL PLANS', exact=True).click()
        assert await page.evaluate("archiveUrl.includes('targetKind=workflow') && archiveUrl.includes('targetId=plan-fixture') && archiveUrl.includes('targetCwd=%2Fp%2Fhosted')")
        await page.get_by_role('button', name='Preview Agent plan', exact=True).click()
        await expect(page.locator('pre')).to_contain_text('- [ ] Task')
        await page.get_by_role('button', name='Attach Agent plan', exact=True).click()
        assert await page.evaluate('planAttached') == 'agent-plan'
        await page.evaluate("window.rawMessages=[]; planStore.setState({connected:true,wsSendRaw:m=>rawMessages.push(m)});")
        await page.get_by_role('button', name='DRAFT IN GENESIS', exact=True).click()
        config = await page.evaluate("rawMessages.find(m=>m.type==='create_workflow').config")
        assert config['workingDirectory'] == '/p/hosted' and config['genesisSeed']['planOnly'] is True
        await page.evaluate('''async config => {
          const {handleServerMessage:receive}=await import('/src/ws/handleServerMessage.ts');
          const d={wsRef:{current:null},scheduleReconnect:()=>{}};
          receive({type:'workflow_created',workflowId:'genesis-single',config},d);
          receive({type:'genesis_plan_saved',workflowId:'genesis-single',cwd:'/p/hosted',planId:'agent-plan',written:[]},d);
        }''', config)
        await expect(page.get_by_text('Genesis saved a plan for this project.', exact=False)).to_be_visible()
        await page.get_by_role('button', name='ATTACH', exact=True).click()
        await expect(page.get_by_text('Genesis saved a plan for this project.', exact=False)).to_have_count(0)
        assert plan_attaches[-1]['workflowId'] == ['plan-fixture']
        assert plan_attaches[-1]['planId'] == ['agent-plan']
        await page.get_by_role('button', name='+ NEW PLAN').click()
        await expect(page.get_by_test_id('new-plan-public-project')).to_be_checked()
        await page.get_by_role('button', name='INSERT GUARDRAILS').click()
        assert '## Privacy and public safety' in (await page.locator('textarea').input_value())
        await page.evaluate("""() => { const s=planStore, j=s.getState().jobs['plan-fixture']; s.setState({jobs:{...s.getState().jobs,'plan-fixture':{...j,plan:{id:'agent-plan',title:'Agent plan',createdAt:1,updatedAt:1}}}}); showPlanCase('manual'); }""")
        await expect(page.get_by_text('This public project plan has no Privacy and public safety section.', exact=False)).to_be_visible()
        await expect(page.get_by_test_id('public-plan-insert-guardrails')).to_be_enabled()
        await page.get_by_test_id('public-plan-insert-guardrails').click()
        assert '## Privacy and public safety' in (await page.locator('textarea').input_value())
        await page.evaluate("showPlanCase('dialog')")
        await expect(page.get_by_test_id('plan-dialog-public-project')).to_be_checked()
        await page.evaluate("planStore.getState().setPlanCandidate('plan-fixture', {body:'# Draft\\n\\n### Phase\\n- [ ] Task',mode:'review',capturedAt:1}); showPlanCase('banner')")
        await expect(page.get_by_test_id('plan-banner-public-project')).to_be_checked()
        await page.get_by_test_id('plan-banner-insert-guardrails').click()
        assert await page.evaluate("planStore.getState().jobs['plan-fixture'].planCandidate.body.includes('## Privacy and public safety')")
        await page.evaluate("""() => { const s=planStore, j=s.getState().jobs['plan-fixture']; s.setState({jobs:{...s.getState().jobs,'plan-fixture':{...j,config:{...j.config,workingDirectory:'/demo/.arco/genesis/fixture'},genesisSeed:{title:'Fixture',spark:'A fixture',concept:'',theCase:'',buildDirection:''}}}}); window.confirm=()=>true; showPlanCase('genesis'); }""")
        await expect(page.get_by_test_id('genesis-public-project')).not_to_be_checked()
        await page.get_by_test_id('genesis-public-project').check()
        await page.get_by_role('button', name='CREATE & SCAFFOLD').click()
        assert (await page.evaluate('scaffoldArgs[3]')) is True
        await page.evaluate("""() => { const s=planStore, j=s.getState().jobs['plan-fixture']; s.setState({jobs:{...s.getState().jobs,'plan-fixture':{...j,config:{...j.config,workingDirectory:'/p/hosted'},genesisSeed:{title:'Alternative',spark:'A fixture',concept:'',theCase:'',buildDirection:'',creative:true}}}}); window.scaffoldArgs=null; showPlanCase('genesis'); }""")
        await expect(page.get_by_test_id('genesis-public-project')).to_be_checked()
        await page.get_by_role('button', name='CREATE ALTERNATIVE').click()
        await page.wait_for_function('scaffoldArgs?.[3] === true')
        # The server choice survives a browser cache reset and remains changeable.
        await page.evaluate('localStorage.clear()')
        await page.reload(); await page.wait_for_function('window.ready === true')
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {PublicProjectBox}=await import('/src/components/PublicProjectBox.tsx');
          createRoot(document.getElementById('fixture')).render(React.createElement(PublicProjectBox,{cwd:'/p/hosted',testId:'restored-choice'}));
        }''')
        await expect(page.get_by_test_id('restored-choice')).to_be_checked()
        await page.get_by_test_id('restored-choice').uncheck()
        await page.wait_for_timeout(100)
        assert choices['/p/hosted'] is False
        # Restore the original fixture for project-state checks.
        await page.reload(); await page.wait_for_function('window.ready === true')
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ProjectStateNotice}=await import('/src/components/ProjectStateNotice.tsx');
          createRoot(document.getElementById('fixture')).render(React.createElement(ProjectStateNotice,{cwd:'/p/state'}));
        }''')
        # State notice: tracked files; STOP TRACKING keeps files and explains the commit.
        notice = page.get_by_test_id('project-state-notice')
        await expect(notice).to_contain_text('tracking 2 file(s)')
        await expect(page.get_by_test_id('project-state-restore')).to_have_count(0)
        await page.get_by_test_id('project-state-stop').click()
        await expect(page.get_by_test_id('project-state-message')).to_contain_text('still on disk')
        await expect(page.get_by_test_id('project-state-message')).to_contain_text('remote')
        assert posts == ['stop-tracking'], posts
        # Dismiss hides it and is remembered for the project.
        await page.get_by_test_id('project-state-dismiss').click()
        await expect(notice).to_have_count(0)
        assert await page.evaluate("localStorage.getItem('arco.projectStateNotice./p/state')") == '1'
        # Not ignored: RESTORE IGNORE FILE reports the backup.
        state.update({'tracked': 0, 'ignored': False})
        await page.evaluate("localStorage.removeItem('arco.projectStateNotice./p/state')")
        await page.reload(); await page.wait_for_function('window.ready === true')
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ProjectStateNotice}=await import('/src/components/ProjectStateNotice.tsx');
          createRoot(document.getElementById('fixture')).render(React.createElement(ProjectStateNotice,{cwd:'/p/state'}));
        }''')
        await expect(page.get_by_test_id('project-state-stop')).to_have_count(0)
        await page.get_by_test_id('project-state-restore').click()
        await expect(page.get_by_test_id('project-state-message')).to_contain_text('.gitignore.backup-test')
        assert posts[-1] == 'restore-ignore', posts
        await expect(page.get_by_test_id('project-state-restore')).to_have_count(0)
        assert not errors, errors
        assert not unexpected, unexpected
        await browser.close()
        print('PASS: public-project box and suggestion, INSERT GUARDRAILS, project state notice')

asyncio.run(main())
