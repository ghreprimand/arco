"""Shared form-control styling on real creator, cluster, worker, Outputs and Computer controls.

Synthetic stores and APIs only; no provider calls. Every visible select and
text/number input must use theme typography instead of the browser default,
help lines must stay inside their containers, and values must still save.
"""
import asyncio
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect

PORT = os.environ.get('ARCO_CLIENT_PORT', '5207')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
ART = Path('/tmp/arco-form-controls')
ART.mkdir(parents=True, exist_ok=True)
CWD = '/projects/fixture'
HTML = """<!doctype html><html><body><main style="display:flex;flex-wrap:wrap;gap:16px;padding:12px;align-items:flex-start">
<div id="creator" style="width:640px;background:var(--color-bg-panel)"></div>
<div id="cluster" style="width:900px;height:620px;display:flex;background:var(--color-bg-panel)"></div>
<div id="config" style="width:420px;padding:12px;background:var(--color-bg-panel)"></div>
<div id="outputs" style="width:320px;height:420px;background:var(--color-bg-panel)"></div>
<div id="computer" style="width:420px;background:var(--color-bg-panel)"></div>
<div id="rename" style="width:320px;background:var(--color-bg-panel)"></div></main>
<script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};
window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;window.fixtureReady=true;</script></body></html>"""

MEASURE = r"""() => [...document.querySelectorAll('select, input, textarea')]
  .filter(e => !['checkbox','radio','range','file','hidden','color'].includes(e.type) && e.offsetParent)
  .map(e => { const st = getComputedStyle(e); const host = e.closest('main > div');
    return {host: host ? host.id : 'dialog', label: e.getAttribute('aria-label') || e.placeholder || e.tagName, size: st.fontSize,
      family: st.fontFamily, bg: st.backgroundColor, border: st.borderTopStyle}; })"""

HELP = r"""() => [...document.querySelectorAll('.arco-field-help')].filter(e => e.offsetParent).map(e => {
  const box = e.getBoundingClientRect(), host = e.closest('main > div').getBoundingClientRect();
  return {text: e.textContent.slice(0, 40), right: box.right, hostRight: host.right, scroll: e.scrollWidth, client: e.clientWidth};
})"""

GAPS = r"""() => [...document.querySelectorAll('label.arco-field-label')].filter(e => e.offsetParent).map(l => {
  const c = l.querySelector('.arco-field'); if (!c) return null;
  const text = [...l.childNodes].find(n => n.nodeType === 3 && n.textContent.trim()); if (!text) return null;
  const r = document.createRange(); r.selectNodeContents(text);
  const t = r.getBoundingClientRect(), b = c.getBoundingClientRect();
  return {label: text.textContent.trim(), gap: Math.round(b.left - t.right), wrapped: b.top >= t.bottom - 1};
}).filter(Boolean)"""


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1920, 'height': 1200})
        errors, blocked, writes = [], [], []
        activity = {'policy': {'enabled': True, 'agentUpdates': 'off'}, 'pending': 0, 'updatesPerHour': 12, 'updatesThisHour': 0, 'ledger': [], 'deliveries': []}
        outputs = [{'id': c * 32, 'name': n, 'title': n, 'path': CWD + '/' + n, 'originPath': CWD + '/' + n, 'category': k, 'workflowId': 'worker-a', 'cwd': CWD,
                    'producer': 'Alpha', 'createdAt': 1793210000000, 'updatedAt': 1793210000000, 'size': 10, 'missing': False, 'source': 'artifact event'}
                   for c, n, k in [('a', 'diagram.png', 'images'), ('b', 'notes.md', 'documents'), ('c', 'tone.wav', 'audio')]]

        async def isolate(route):
            u = urlparse(route.request.url)
            if u.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(content_type='text/css', body=''); return
            if u.scheme == 'http' and u.netloc == '127.0.0.1:' + PORT:
                if u.path == '/fixture':
                    await route.fulfill(content_type='text/html', body=HTML); return
                if u.path.startswith('/api/'):
                    if route.request.method != 'GET':
                        body = route.request.post_data_json
                        writes.append({'path': u.path, 'body': body})
                        assert u.path == '/api/voice/activity', writes
                        if body.get('agent_updates'):
                            activity['policy']['agentUpdates'] = body['agent_updates']
                    data = {'items': [], 'projects': [], 'roots': [], 'sessions': [], 'presets': [], 'templates': [], 'skills': [], 'models': [], 'clusters': [], 'entries': [], 'files': []}
                    if u.path == '/api/outputs': data = {'outputs': outputs}
                    if u.path == '/api/voice/activity': data = activity
                    await route.fulfill(json=data); return
                path = unquote(u.path)
                local = path.startswith('/@fs/') and Path(path[4:]).resolve().is_relative_to(ROOT)
                if local or path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/', '/themes/', '/backgrounds/', '/fonts/')):
                    await route.continue_(); return
            blocked.append(route.request.url); await route.abort()

        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true')
        await page.evaluate(r"""async (cwd) => {
          await import('/src/styles/global.css'); await import('/src/styles/matrix.css');
          await import('/src/themes/phosphor/phosphor.css'); await import('/src/components/Home/home.css');
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const h=React.createElement;
          const {WorkflowCreator}=await import('/src/components/WorkflowCreator/index.tsx');
          const {ClusterTab}=await import('/src/components/ClusterTab.tsx');
          const {ConfigTab}=await import('/src/components/RightPanel/ConfigTab.tsx');
          const {OutputsPanel}=await import('/src/components/RightPanel/OutputsPanel.tsx');
          const {ComputerActivityPanel}=await import('/src/components/ComputerActivityPanel.tsx');
          const {WorkspaceRename}=await import('/src/components/WorkspaceRename.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts');
          const {useComputerStore}=await import('/src/stores/computerStore.ts');
          const {useComputerActivity}=await import('/src/voice/activity.ts');
          const {THEME_REGISTRY}=await import('/src/themes/registry.ts');
          const {applyTheme}=await import('/src/themes/apply.ts');
          const {applyUiScale}=await import('/src/themes/bootstrap.ts');
          const {applyPhosphorPreferences}=await import('/src/themes/phosphor/preferences.ts');
          window.s=s; window.created=[]; window.updates=[]; window.clusterPolicies=[]; window.guards=[];
          s.setState({connected:true,creatorPrefill:{mode:'cluster',workDir:cwd},settings:{...s.getState().settings,enabledProviders:{claude:true},
            claude:{transport:'native'},workflowDefaults:{primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'medium'},projectRoots:[]},
            authStatus:{claude:{loggedIn:true,native:{credentialPresent:true}}}});
          for (const id of ['worker-a','worker-b']) s.getState().createJob(id,{name:id,workingDirectory:cwd,primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'medium',claudeTransport:'native'});
          const cluster={clusterId:'fixture-cluster',cwd,createdAt:'',taskBoardMode:'cluster',taskBoardAttached:true,progressTracking:'both',efficiencyLevel:'balanced',
            messageGuard:{mode:'warn',threshold:15},autoCompaction:{enabled:true,thresholdPercent:70},
            members:[{workflowId:'worker-a',displayName:'Alpha',status:'idle',role:'Implementer'},{workflowId:'worker-b',displayName:'Beta',status:'idle',role:'Director'}],mailboxDepth:{}};
          s.setState({clusters:{[cluster.clusterId]:cluster}});
          useComputerStore.setState({activeId:'voice'});
          useComputerActivity.setState({ownerId:'voice',snapshot:{policy:{enabled:true,agentUpdates:'off'},pending:0,updatesPerHour:12,updatesThisHour:0,ledger:[],deliveries:[]},error:null});
          const patchCluster=p=>{const c=s.getState().clusters['fixture-cluster'];s.setState({clusters:{'fixture-cluster':{...c,...p}}});};
          createRoot(document.getElementById('creator')).render(h(WorkflowCreator,{onCreate:()=>{},onCreateCluster:p=>created.push(p)}));
          createRoot(document.getElementById('cluster')).render(h(ClusterTab,{clusterId:'fixture-cluster',onSendToMember:()=>true,onCancelMember:()=>{},onCancelQueuedForMember:()=>{},onUpload:async()=>null,
            onSetEfficiency:(id,level,addendum,messageGuard)=>{guards.push(messageGuard);patchCluster({efficiencyLevel:level,...(messageGuard?{messageGuard}:{})});},
            onSetProgress:(id,mode)=>patchCluster({progressTracking:mode}),
            onSetAutoCompaction:(id,policy)=>{clusterPolicies.push(policy);patchCluster({autoCompaction:policy??undefined});}}));
          const configRoot=createRoot(document.getElementById('config'));
          window.renderConfig=()=>configRoot.render(h(ConfigTab,{job:s.getState().jobs['worker-a'],onUpdatePrimary:patch=>{updates.push(patch);
            s.setState(st=>({jobs:{...st.jobs,'worker-a':{...st.jobs['worker-a'],config:{...st.jobs['worker-a'].config,...patch}}}}));window.renderConfig();}}));
          renderConfig();
          createRoot(document.getElementById('outputs')).render(h(OutputsPanel,{cwd,workflowId:'worker-a'}));
          createRoot(document.getElementById('computer')).render(h(ComputerActivityPanel,{ownerId:'voice'}));
          createRoot(document.getElementById('rename')).render(h(WorkspaceRename,{workflowId:'worker-a',name:'Fixture workspace',onRename:()=>true}));
          window.chooseTheme=(id,scale)=>{applyPhosphorPreferences({phosphorEffects:false,phosphorSoftness:50});
            applyTheme(THEME_REGISTRY[id],'victor-mono-uniform',null,null,{bg:0,text:30});applyUiScale(scale);};
          chooseTheme('phosphor:arco:electric',1.1);
        }""", CWD)
        # Coordination settings and member defaults are collapsed in cluster mode.
        await page.locator('#creator button[aria-controls="creator-cluster-policy"]').click()
        await page.locator('#creator button[aria-controls="creator-member-defaults"]').click()
        await expect(page.locator('#creator').get_by_label('Message guard', exact=True)).to_be_visible()
        await expect(page.locator('#outputs').get_by_label('Output type', exact=True)).to_be_visible()
        await page.locator('#rename').get_by_role('button', name='Rename workspace Fixture workspace').click()
        await expect(page.get_by_label('Workspace name', exact=True)).to_be_visible()
        await page.evaluate('document.fonts.ready')

        cases = 0
        for theme in ['phosphor:arco:electric', 'arco-default']:
            for scale in [1.1, 1.5]:
                await page.evaluate('([t,s])=>chooseTheme(t,s)', [theme, scale])
                await page.wait_for_timeout(50)
                controls = await page.evaluate(MEASURE)
                default_font = [c for c in controls if c['size'].startswith('13.33') or c['family'].split(',')[0].strip() in ('system-ui', 'Arial', '-apple-system')]
                assert not default_font, (theme, scale, default_font)
                unstyled = [c for c in controls if c['bg'] in ('rgb(255, 255, 255)', 'rgb(240, 240, 240)', 'rgb(59, 59, 59)')]
                assert not unstyled, (theme, scale, unstyled)
                hosts = {c['host'] for c in controls}
                assert {'creator', 'cluster', 'config', 'outputs', 'computer', 'rename'} <= hosts, hosts
                overflow = [x for x in await page.evaluate(HELP) if x['right'] > x['hostRight'] + 1 or x['scroll'] > x['client'] + 1]
                assert not overflow, (theme, scale, overflow)
                gaps = await page.evaluate(GAPS)
                jammed = [g for g in gaps if not g['wrapped'] and g['gap'] < 4]
                assert not jammed, (theme, scale, jammed)
                cases += 1
                tag = f"{theme.replace(':', '-')}-{int(scale * 100)}"
                await page.locator('#creator [data-help="cluster.efficiency"]').first.screenshot(path=str(ART / f'creator-{tag}.png'))
                await page.locator('#computer').screenshot(path=str(ART / f'computer-{tag}.png'))
                print(f'{theme} at {int(scale * 100)}%: {len(controls)} controls, {len(gaps)} labels, no default fonts or overflow', flush=True)
        await page.keyboard.press('Escape')

        # Values still save through the existing handlers.
        await page.evaluate("chooseTheme('phosphor:arco:electric',1.1)")
        creator = page.locator('#creator')
        await creator.get_by_label('Message guard', exact=True).select_option('hard')
        await creator.get_by_label('Message threshold', exact=True).fill('9')
        await creator.get_by_label('Message threshold', exact=True).press('Enter')
        await creator.get_by_label('Cluster task board', exact=True).select_option('project')
        await creator.get_by_label('Keep current', exact=True).select_option('plan')
        await creator.get_by_label('Cluster NOTE', exact=True).fill('Fixture note')
        assert await creator.get_by_label('Cluster NOTE', exact=True).get_attribute('placeholder') == "Optional note added to this cluster's coordination instructions"
        await creator.get_by_role('button', name='CREATE CLUSTER', exact=True).click()
        await page.wait_for_function('created.length===1')
        got = await page.evaluate('({guard:created[0].messageGuard,board:created[0].taskBoardMode,progress:created[0].progressTracking,note:created[0].efficiencyAddendum})')
        assert got == {'guard': {'mode': 'hard', 'threshold': 9}, 'board': 'project', 'progress': 'plan', 'note': 'Fixture note'}, got

        cluster = page.locator('#cluster')
        await cluster.get_by_label('Cluster auto-compaction', exact=True).select_option('off')
        assert await page.evaluate('clusterPolicies.at(-1)') == {'enabled': False, 'thresholdPercent': 70}
        await expect(cluster.get_by_label('Cluster auto-compaction', exact=True)).to_have_value('off')
        await cluster.get_by_label('Message guard', exact=True).select_option('none')
        assert await page.evaluate('guards.at(-1)') == {'mode': 'none', 'threshold': 15}, await page.evaluate('guards')

        config = page.locator('#config')
        await config.get_by_label('Worker auto-compaction', exact=True).select_option('off')
        last = await page.evaluate('updates.at(-1)')
        assert last['autoCompaction']['enabled'] is False, last
        await expect(config.get_by_label('Worker auto-compaction', exact=True)).to_have_value('off')

        outputs_panel = page.locator('#outputs')
        await outputs_panel.get_by_label('Output type', exact=True).select_option('audio')
        await expect(outputs_panel.get_by_text('tone.wav', exact=True).first).to_be_visible()
        await expect(outputs_panel.get_by_text('notes.md', exact=True)).to_have_count(0)

        computer = page.locator('#computer')
        await computer.get_by_label('Computer agent activity updates', exact=True).select_option('matches')
        await expect(computer.get_by_label('Computer agent activity updates', exact=True)).to_have_value('matches')
        assert writes == [{'path': '/api/voice/activity', 'body': {'action': 'configure', 'agent_updates': 'matches'}}], writes

        assert not blocked, blocked
        assert not errors, errors
        await browser.close()
        print(f'PASS form controls: {cases} theme/scale cases, shared styling, wrapped help, values saved')

asyncio.run(main())
