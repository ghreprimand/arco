"""Cluster tab single typing surface: director focus, composer TO chip, NUDGE and BRIEF, marks, hint."""
import asyncio
import os
from pathlib import Path
from urllib.parse import unquote, urlparse, parse_qs
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path, fs_url
from host_isolation import chrome_executable

PORT = os.environ.get('ARCO_CLIENT_PORT', '5231')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/styles/matrix.css"><link rel="stylesheet" href="/src/themes/phosphor/phosphor.css"></head><body><div id="fixture"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page(viewport={'width': 1500, 'height': 900})
        # This suite checks controls in the Standard layout; layout-ranges-browser.py covers the other layouts.
        await page.add_init_script("localStorage.setItem('arco.layoutMode', 'standard')")
        blocked, errors = [], []
        public_choices = {}
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'http' and url.netloc == '127.0.0.1:4300':
                await route.fulfill(status=200, content_type='text/html', body='<p>Separate preview fixture</p>'); return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and url.path.startswith('/api/preview/lease/'):
                await route.fulfill(json={'id': 'fixture-lease', 'port': 4300, 'capability': 'fixture-access'}); return
            if url.scheme == 'https' and url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(status=200, content_type='text/css', body='')
                return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and url.path == '/api/public-project/choice':
                cwd = parse_qs(url.query).get('path', [''])[0]
                if route.request.method == 'POST':
                    body = route.request.post_data_json
                    cwd = body['path']; public_choices[cwd] = body['value']
                await route.fulfill(json={'choice': public_choices.get(cwd)})
                return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and url.path == '/api/explorer/plans/attach' and route.request.method == 'POST':
                await route.fulfill(json={'ok': True})
                return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and route.request.method == 'GET':
                if url.path == '/api/cluster-snapshots':
                    await route.fulfill(json={'snapshots': [{'id':'snapshot-a','sameFolder':True}]})
                    return
                if url.path == '/api/cluster-snapshots/cloud':
                    await route.fulfill(json={'snapshots': []})
                    return
                if url.path.startswith('/api/preview/'):
                    await route.fulfill(status=200, content_type='text/html', body='<p>Preview fixture</p>')
                    return
                if url.path == '/api/outputs':
                    await route.fulfill(json={'outputs':[]})
                    return
                if url.path == '/api/public-project/remote':
                    await route.fulfill(json={'state':'none'})
                    return
                if url.path == '/api/public-project/state':
                    await route.fulfill(json={'isGit':False,'hasState':False,'tracked':0,'trackedSample':[],'ignored':True,'ignoreFile':'default'})
                    return
                if url.path == '/api/project-trust':
                    await route.fulfill(json={'trusted':False})
                    return
                if url.path == '/api/plans':
                    await route.fulfill(json={'plans':[]})
                    return
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
        await page.evaluate("""async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ClusterTab} = await import('/src/components/ClusterTab.tsx');
          const {SavedClustersList} = await import('/src/components/SavedClustersList.tsx');
          window.showSaved=()=>root.render(React.createElement(SavedClustersList));
          const {useHubLinkStore:hub} = await import('/src/stores/hubLinkStore.ts');
          const {useClusterSnapshotsStore:snapshots} = await import('/src/stores/clusterSnapshotsStore.ts');
          window.hub=hub; snapshots.setState({snapshots:[{id:'snapshot-a',name:'Fixture snapshot',createdAt:'2026-01-01T00:00:00Z',memberCount:1,sourceCwd:'/projects/fixture'}]});
          const {applyTheme} = await import('/src/themes/apply.ts');
          const {getTheme} = await import('/src/themes/registry.ts');
          applyTheme(getTheme('matrix'));
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          const {handleServerMessage:receive} = await import('/src/ws/handleServerMessage.ts');
          window.s=s; window.receive=receive; window.broadcasts=[]; window.sent=[]; window.planWrites=[]; window.recalibrated=[];
          const member=(id,name,status,role)=>({workflowId:id,displayName:name,status,role});
          window.members=[member('worker-a','Alpha','idle','Builder'),member('worker-b','Beta','busy','Director'),member('worker-c','Gamma','idle','Tester')];
          for (const id of ['worker-a','worker-b','worker-c']) s.getState().createJob(id,{name:id,workingDirectory:'/projects/fixture',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',skipPermissions:false,remoteEnabled:true,reviewSafe:true});
          receive({type:'cluster_state',clusterId:'cluster-a',state:{clusterId:'cluster-a',cwd:'/projects/fixture',createdAt:'',taskBoardMode:'none',taskBoardAttached:false,mailboxDepth:{'worker-a':2},members:window.members,idleNudgerEnabled:false,remoteEnabled:true}},{wsRef:{current:null},scheduleReconnect:()=>{}});
          const root=createRoot(document.getElementById('fixture'));
          window.root=root;
          window.show=(clusterId='cluster-a')=>root.render(React.createElement('div',{style:{display:'flex',width:'100%',height:'850px'}},React.createElement(ClusterTab,{key:clusterId,clusterId,onSendToMember:(...a)=>{sent.push(a);return true},onBroadcast:(...a)=>{if(window.broadcastConnected===false)return false;broadcasts.push(a);return true},onSetClusterPlan:(...a)=>planWrites.push(a),onAttachClusterPlan:()=>{},onAttachPlanToMember:()=>{},onRecalibrateMember:(id)=>recalibrated.push(id),onCancelMember:()=>{},onCancelQueuedForMember:()=>{},onUpload:async()=>null,onSetRemote:()=>{},onSetGates:()=>{},onUpdateMemberPrimary:()=>{},onArmPlanModeMember:()=>{}})));
          show();
        }""")
        # PLAN FIRST is shown for a coding member, but hidden for director and reviewer roles.
        await page.evaluate("s.setState(st=>({jobs:Object.fromEntries(Object.entries(st.jobs).map(([id,j])=>[id,{...j,config:{...j.config,claudeTransport:'native'}}]))}))")
        await expect(page.locator('[data-help="composer.plan-first"]')).to_have_count(0)
        await page.evaluate("s.getState().setClusterFocusedMember('cluster-a','worker-a')")
        plan_first = page.locator('[data-help="composer.plan-first"]')
        await expect(plan_first).to_be_visible()
        await page.evaluate("s.getState().beginPrimaryTurn('worker-a', Date.now()-1620000)")
        await expect(page.get_by_test_id('turn-timer')).to_contain_text('TURN 27m')
        await page.evaluate("s.getState().endPrimaryTurn('worker-a')")
        await expect(page.get_by_test_id('turn-timer')).to_have_count(0)
        await plan_first.click()
        await expect(plan_first).to_have_attribute('aria-pressed','true')
        await page.evaluate("s.setState(st=>({clusters:{...st.clusters,'cluster-a':{...st.clusters['cluster-a'],members:st.clusters['cluster-a'].members.map(m=>m.workflowId==='worker-a'?{...m,role:'Reviewer role. Read'}:m)}}}))")
        await expect(plan_first).to_have_count(0)
        await page.evaluate("s.setState(st=>({clusters:{...st.clusters,'cluster-a':{...st.clusters['cluster-a'],members:st.clusters['cluster-a'].members.map(m=>m.workflowId==='worker-a'?{...m,role:'Builder'}:m)}}}))")
        await expect(plan_first).to_have_attribute('aria-pressed','false')
        await page.evaluate("s.getState().setClusterFocusedMember('cluster-a','worker-b')")
        # Context is in the focused member header and calibration stays available.
        meter=page.locator('[data-help="worker.header.ctx"]')
        await expect(meter).to_have_count(1)
        await expect(meter).to_contain_text('CTX')
        await page.evaluate("s.setState(st=>({jobs:{...st.jobs,'worker-b':{...st.jobs['worker-b'],busy:false,contextUsage:{estimatedTokens:25000,windowSize:100000,percentOfWindow:25,method:'estimate',messagesTokens:20000,overheadTokens:5000,jsonlBytes:20000}}}}))")
        await expect(meter).to_contain_text('CTX: 25k / 100k')
        await meter.locator('[title*="Context fill estimate"]').click()
        assert await page.evaluate('recalibrated') == ['worker-b']
        # Hub-only actions appear on a live connection and disappear on loss.
        await expect(page.locator('[data-help="cluster.remote"]')).to_have_count(0)
        await expect(page.locator('[data-help="composer.remote"]')).to_have_count(0)
        await page.get_by_role('button', name='SAVE STATE', exact=True).click()
        await expect(page.get_by_role('button', name='SAVE LOCAL', exact=True)).to_be_visible()
        await expect(page.get_by_role('button', name='SAVE CLOUD', exact=True)).to_have_count(0)
        await page.evaluate("hub.getState().setStatus({connected:true,hubUrl:'http://fixture.invalid'})")
        await expect(page.locator('[data-help="cluster.remote"]')).to_have_count(1)
        await expect(page.locator('[data-help="cluster.remote-gates"]')).to_have_count(1)
        await expect(page.locator('[data-help="composer.remote"]')).to_have_count(1)
        await expect(page.get_by_role('button', name='SAVE CLOUD', exact=True)).to_be_visible()
        await page.evaluate("hub.getState().setStatus({connected:false,hubUrl:'http://fixture.invalid'})")
        await expect(page.locator('[data-help="cluster.remote"]')).to_have_count(0)
        await expect(page.locator('[data-help="cluster.remote-gates"]')).to_have_count(0)
        await expect(page.locator('[data-help="composer.remote"]')).to_have_count(0)
        await expect(page.get_by_role('button', name='SAVE CLOUD', exact=True)).to_have_count(0)
        await page.keyboard.press('Escape')
        cards=page.locator('[data-help="cluster.member-card"]')
        await expect(cards).to_have_count(3)
        # Opens on the director, listed first; no bottom composer.
        await expect(cards.nth(0)).to_contain_text('BETA')
        assert await page.evaluate("s.getState().clusterFocusedMember['cluster-a']") == 'worker-b'
        await expect(page.get_by_label('SHOW BROADCAST')).to_have_count(0)
        await expect(page.get_by_role('button', name='BROADCAST', exact=True)).to_have_count(0)
        await expect(page.locator('[data-help="cluster.broadcast"]')).to_have_count(0)
        # Composer controls: TO chip, NUDGE and BRIEF sit in the message box; the header lost them.
        to=page.get_by_test_id('composer-recipients'); nudge=page.get_by_test_id('cluster-nudge'); brief=page.get_by_test_id('composer-brief')
        await expect(page.get_by_test_id('cluster-send-several')).to_have_count(0)
        await expect(page.get_by_text('SEND TO SEVERAL')).to_have_count(0)
        await expect(page.get_by_text('BRIEF CLUSTER')).to_have_count(0)
        await expect(to).to_contain_text('TO: BETA')
        await expect(nudge).to_have_text('NUDGE 2')
        nb=await nudge.bounding_box(); bb=await brief.bounding_box()
        assert nb['height'] > bb['height'], (nb, bb)
        await page.add_style_tag(content='*{font-family:monospace !important;letter-spacing:0.12em !important}')
        for width in (1500, 900, 560):
            await page.set_viewport_size({'width': width, 'height': 900})
            for b in (to, nudge, brief):
                await expect(b).to_be_visible()
                box=await b.bounding_box()
                assert box['x'] >= 0 and box['x'] + box['width'] <= width + 1, (width, box)
        await page.set_viewport_size({'width': 1500, 'height': 900})
        # Placeholder names the target: director by default.
        msg=page.locator('textarea:not([data-testid])').first
        await expect(msg).to_have_attribute('placeholder', 'Message the director, your main contact...')
        # TO chip: starts with the member in view; pick a subset, then everyone.
        await to.click()
        dialog=page.get_by_test_id('recipients-dialog')
        await expect(dialog.locator('input[type=checkbox]:checked')).to_have_count(1)
        done=page.get_by_test_id('recipients-done')
        await expect(done).to_have_text('DONE (1)')
        await dialog.get_by_text('Alpha', exact=True).click()
        await dialog.get_by_text('Beta', exact=True).click()
        await dialog.get_by_text('Gamma', exact=True).click()
        await expect(done).to_have_text('DONE (2)')
        await done.click()
        await expect(dialog).to_have_count(0)
        await expect(to).to_contain_text('TO: 2 MEMBERS')
        await expect(msg).to_have_attribute('placeholder', 'Message 2 members...')
        # B145: the voice chooser reflects the latest explicit recipients.
        await page.evaluate("async () => (await import('/src/voice/dialogs.ts')).requestVoiceDialog('broadcast',null,'cluster-a')")
        await expect(dialog.locator('input[type=checkbox]:checked')).to_have_count(2)
        await page.keyboard.press('Escape')
        # A closed sender must retain the composer and its explicit recipients.
        await page.evaluate('window.broadcastConnected=false')
        await msg.fill('unsent subset'); await msg.press('Enter')
        await expect(msg).to_have_value('unsent subset')
        await expect(to).to_contain_text('TO: 2 MEMBERS')
        assert await page.evaluate('broadcasts.length') == 0
        await page.evaluate('window.broadcastConnected=true')
        await msg.fill('hello subset'); await msg.press('Enter')
        b=await page.evaluate('broadcasts')
        assert len(b) == 1 and b[0][1] == 'hello subset' and sorted(b[0][4]) == ['worker-a', 'worker-c'], b
        assert await page.evaluate('sent.length') == 0
        await expect(to).to_contain_text('TO: BETA')
        await to.click()
        await page.get_by_test_id('recipients-everyone').click()
        await expect(dialog.locator('input[type=checkbox]:checked')).to_have_count(3)
        await done.click()
        await expect(to).to_contain_text('TO: EVERYONE')
        await msg.fill('hello all'); await msg.press('Enter')
        b=await page.evaluate('broadcasts')
        assert len(b) == 2 and b[1][1] == 'hello all' and b[1][4] is None, b
        await to.click(); await page.keyboard.press('Escape'); await expect(dialog).to_have_count(0)
        assert len(await page.evaluate('broadcasts')) == 2
        await msg.fill('just beta'); await msg.press('Enter')
        assert len(await page.evaluate('broadcasts')) == 2 and await page.evaluate('sent.length') == 1
        # B144: a different single recipient uses the per-member send path.
        await to.click()
        await dialog.get_by_text('Alpha', exact=True).click()
        await dialog.get_by_text('Beta', exact=True).click()
        await done.click()
        await msg.fill('single alpha'); await msg.press('Enter')
        await page.wait_for_function("sent.at(-1)?.[1] === 'single alpha'")
        assert await page.evaluate("sent.at(-1)[0]") == 'worker-a'
        assert len(await page.evaluate('broadcasts')) == 2
        # NEW REPLY on the director card: quiet, no focus change, clears on open.
        mark=page.get_by_test_id('member-new-reply')
        await expect(mark).to_have_count(0)
        await cards.nth(1).click()
        assert await page.evaluate("s.getState().clusterFocusedMember['cluster-a']") == 'worker-a'
        await page.evaluate("""() => { const st=s.getState(); const j=st.jobs['worker-b']; s.setState({jobs:{...st.jobs,'worker-b':{...j,messages:[...j.messages,{id:'r1',role:'assistant',content:'Done.',isStreaming:false,timestamp:1}]}}}); }""")
        await expect(mark).to_have_text('NEW REPLY')
        assert await page.evaluate("s.getState().clusterFocusedMember['cluster-a']") == 'worker-a'
        await cards.nth(0).click()
        await expect(mark).to_have_count(0)
        # Message box size: the focused member's message box grows with the setting.
        box=page.locator('textarea:not([data-testid])').first
        small=(await box.bounding_box())['height']
        assert small < 80, small
        for size, floor in (('medium', 96), ('large', 192)):
            await page.evaluate("async (size) => (await import('/src/utils/messageBoxSize.ts')).setMessageBoxSize(size)", size)
            await page.wait_for_function("([f]) => { const t=[...document.querySelectorAll('textarea')].find(x=>!x.dataset.testid); return t && t.getBoundingClientRect().height >= f - 1; }", arg=[floor])
        await page.evaluate("async () => (await import('/src/utils/messageBoxSize.ts')).setMessageBoxSize('small')")
        await page.wait_for_function("() => { const t=[...document.querySelectorAll('textarea')].find(x=>!x.dataset.testid); return t && t.getBoundingClientRect().height < 80; }")
        # Drag-reordered flag stops director-first.
        assert await page.evaluate("localStorage.getItem('arco.clusterReordered.cluster-a')") is None
        # A missing plan can open the attach list or request a reviewable draft.
        plan_hint=page.locator('[data-help="cluster.no-plan-hint"]')
        await expect(plan_hint).to_be_visible()
        await plan_hint.get_by_role('button', name='ATTACH EXISTING').click()
        await expect(page.get_by_text('No open plans in this folder.')).to_be_visible()
        await expect(page.get_by_role('button', name='DRAFT IN GENESIS', exact=True)).to_be_visible()
        await expect(page.get_by_role('button', name='ALL PLANS', exact=True)).to_be_visible()
        await page.evaluate("window.open=(url)=>{window.archiveUrl=url;return {focus:()=>{}}}")
        await page.get_by_role('button', name='ALL PLANS', exact=True).click()
        assert await page.evaluate("archiveUrl.includes('targetKind=cluster') && archiveUrl.includes('targetId=cluster-a') && archiveUrl.includes('targetCwd=%2Fprojects%2Ffixture')")
        await page.evaluate("window.rawMessages=[]; s.setState({connected:true,wsSendRaw:m=>rawMessages.push(m)});")
        plan_editor = page.get_by_placeholder('# Cluster plan\n- step 1: …\n- step 2: …', exact=True)
        await plan_editor.fill('Unsaved plan text')
        page.once('dialog', lambda dialog: dialog.dismiss())
        await page.get_by_role('button', name='DRAFT IN GENESIS', exact=True).click()
        assert not await page.evaluate("rawMessages.some(m=>m.type==='create_workflow')")
        await expect(plan_editor).to_have_value('Unsaved plan text')
        await plan_editor.fill('')
        await page.get_by_role('button', name='DRAFT IN GENESIS', exact=True).click()
        genesis = await page.evaluate("rawMessages.find(m=>m.type==='create_workflow')")
        assert genesis['config']['genesisSeed']['planOnly'] is True
        assert genesis['config']['workingDirectory'] == '/projects/fixture'
        await page.evaluate('''(config) => {
          const d={wsRef:{current:null},scheduleReconnect:()=>{}};
          receive({type:'workflow_created',workflowId:'genesis-fixture',config},d);
          receive({type:'genesis_plan_saved',workflowId:'genesis-fixture',cwd:'/projects/fixture',planId:'plan-fixture',written:[]},d);
        }''', genesis['config'])
        await expect(page.get_by_text('Genesis saved a plan for this project.')).to_be_visible()
        await page.get_by_role('button', name='ATTACH', exact=True).click()
        await expect(page.get_by_text('Genesis saved a plan for this project.')).to_have_count(0)
        await page.get_by_test_id('cluster-public-project').check()
        await plan_hint.get_by_role('button', name='DRAFT A PLAN').click()
        await page.wait_for_function("sent.at(-1)?.[4] === 'plan-review'")
        assert 'Privacy and public safety' in (await page.evaluate('sent.at(-1)[1]'))
        assert await page.evaluate("s.getState().jobs['worker-b'].pendingPlanCapture") == 'review'
        assert await page.evaluate('planWrites.length') == 0
        await page.evaluate("""() => {
          const d={wsRef:{current:null},scheduleReconnect:()=>{}};
          receive({type:'primary_turn_started',workflowId:'worker-b',startedAt:10,seq:100},d);
          receive({type:'primary_text',workflowId:'worker-b',phase:'passthrough',text:'# Fixture plan\\n- [ ] First',seq:101},d);
          receive({type:'primary_complete',workflowId:'worker-b',phase:'passthrough',seq:102},d);
          receive({type:'primary_turn_ended',workflowId:'worker-b',seq:103},d);
        }""")
        await expect(page.get_by_text('PLAN DRAFT READY', exact=True)).to_be_visible()
        assert await page.evaluate('planWrites.length') == 0
        assert await page.get_by_role('button', name='ATTACH TO WORKER').count() == 0
        sent_before = await page.evaluate('sent.length')
        await page.get_by_role('button', name='REFINE', exact=True).click()
        await page.get_by_placeholder('What should change in this draft?').fill('Add a release phase')
        await page.get_by_placeholder('What should change in this draft?').press('Enter')
        await page.wait_for_function('(n) => sent.length === n + 1', arg=sent_before)
        refine_args = await page.evaluate('sent.at(-1)')
        assert refine_args[4] == 'plan-review' and 'Add a release phase' in refine_args[1] and 'Fixture plan' in refine_args[1]
        assert await page.evaluate("s.getState().jobs['worker-b'].pendingPlanCapture") == 'review'
        await expect(page.get_by_text('REVISING PLAN DRAFT...', exact=True)).to_be_visible()
        assert await page.evaluate("s.getState().jobs['worker-b'].planCandidate.body.includes('Fixture plan')")
        await page.evaluate("""() => {
          const d={wsRef:{current:null},scheduleReconnect:()=>{}};
          receive({type:'primary_turn_started',workflowId:'worker-b',startedAt:20,seq:110},d);
          receive({type:'primary_text',workflowId:'worker-b',phase:'passthrough',text:'# Revised plan\\n- [ ] First\\n- [ ] Release',seq:111},d);
          receive({type:'primary_complete',workflowId:'worker-b',phase:'passthrough',seq:112},d);
          receive({type:'primary_turn_ended',workflowId:'worker-b',seq:113},d);
        }""")
        await expect(page.get_by_text('PLAN DRAFT READY', exact=True)).to_be_visible()
        assert await page.evaluate("s.getState().jobs['worker-b'].planCandidate.body.startsWith('# Revised plan')")
        assert await page.evaluate('planWrites.length') == 0
        await expect(page.get_by_test_id('plan-banner-public-project')).to_be_checked()
        await page.get_by_test_id('plan-banner-insert-guardrails').click()
        assert await page.evaluate("s.getState().jobs['worker-b'].planCandidate.body.includes('## Privacy and public safety')")
        await page.get_by_role('button', name='ATTACH TO CLUSTER').click()
        await page.wait_for_function('planWrites.length === 1')
        assert 'Privacy and public safety' in (await page.evaluate('planWrites[0][1]'))
        await plan_hint.get_by_role('button', name='NOT NOW').click()
        assert await page.evaluate("localStorage.getItem('arco.clusterPlanHint.cluster-a')") == '1'
        await expect(plan_hint).to_have_count(0)
        await page.evaluate("""() => {
          const a=s.getState().clusters['cluster-a'];
          s.getState().setClusterState('cluster-b',{...a,clusterId:'cluster-b'});
          show('cluster-b');
        }""")
        await expect(page.locator('[data-help="cluster.no-plan-hint"]')).to_be_visible()
        # Exercise the actual cluster tab at the supported viewport and text scales.
        await page.locator('[data-help="cluster.right-panel.group.runtime"]').click()
        await page.locator('[data-help="cluster.right-panel.preview"]').click()
        member_id = await page.get_by_label('PREVIEW of member').input_value()
        await page.evaluate("""id => s.setState(st => ({jobs: {...st.jobs, [id]: {...st.jobs[id], preview: {port: 5173}}}}))""", member_id)
        frame = page.locator('iframe')
        await expect(frame).to_be_visible()
        for width, height in [(1280, 800), (1920, 1080), (1920, 1200), (2560, 1440), (3840, 2160)]:
            await page.set_viewport_size({'width': width, 'height': height})
            for zoom in [1, 1.5]:
                await page.evaluate("""([zoom, height]) => {
                  document.documentElement.style.zoom = String(zoom);
                  document.querySelector('#fixture > div').style.height = (height / zoom - 40) + 'px';
                }""", [zoom, height])
                await expect(frame).to_be_visible()
                box = await frame.bounding_box()
                assert box and box['width'] > 0 and box['height'] > 0, (width, height, zoom, box)
        await page.evaluate("document.documentElement.style.zoom = '1'")
        await page.set_viewport_size({'width': 1500, 'height': 900})
        await page.evaluate('showSaved()')
        await expect(page.get_by_text('Fixture snapshot', exact=True)).to_be_visible()
        await expect(page.get_by_role('button', name='CLOUD', exact=True)).to_have_count(0)
        await expect(page.get_by_role('button', name='IMPORT FILE', exact=True)).to_be_visible()
        await page.evaluate("hub.getState().setStatus({connected:true,hubUrl:'http://fixture.invalid'})")
        await expect(page.get_by_role('button', name='CLOUD', exact=True)).to_have_count(2)
        await page.get_by_role('button', name='CLOUD', exact=True).first.click()
        await expect(page.get_by_role('button', name='COPY VAULT KEY', exact=True)).to_be_visible()
        await page.evaluate("hub.getState().setStatus({connected:false,hubUrl:'http://fixture.invalid'})")
        await expect(page.get_by_role('button', name='CLOUD', exact=True)).to_have_count(0)
        await expect(page.get_by_text('Fixture snapshot', exact=True)).to_be_visible()
        await expect(page.get_by_role('button', name='COPY VAULT KEY', exact=True)).to_have_count(0)
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: cluster single typing surface, composer recipients, director focus, marks and hint')

asyncio.run(main())
