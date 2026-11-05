"""Contextual help coverage: every reachable interactive control in each main view
has a data-help key on itself or an ancestor, and every key resolves in the help
registry. Actual App against Vite with all APIs and the WebSocket isolated;
synthetic fixtures only, no provider execution and no writes.

Set ARCO_HELP_COVERAGE_REPORT=<file> to write the full inventory as JSON.
"""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path, fs_url

URL = os.environ.get('ARCO_HELP_PREVIEW_URL', f"http://127.0.0.1:{os.environ.get('ARCO_CLIENT_PORT', '5179')}/")
CHROME = os.environ.get('ARCO_TEST_CHROME') or None
REPORT = os.environ.get('ARCO_HELP_COVERAGE_REPORT')
ROOT = Path(__file__).resolve().parents[2]
fixtures = {}

# Controls deliberately without a help key. Each entry: (CSS selector matched by
# element.closest, reason). Keep this short; prefer adding a key.
GENERIC = set()
CLUSTER_TABS = '[data-help^="cluster.right-panel.tab."],[data-help="cluster.right-panel.members"],[data-help="cluster.mailbox"],[data-help="cluster.plan-tab"],[data-help="cluster.board-tab"],[data-help="cluster.right-panel.github"]'
# Workflow-view controls that open a dialog, menu or popover; each is opened,
# probed and closed with Escape. Controls that act immediately are not listed.
OPENERS = ['actions.review', 'actions.handoff', 'actions.spawn', 'composer.plan', 'composer.docs', 'composer.git',
           'composer.tuneup', 'composer.research', 'composer.compare', 'composer.skills',
           'header.notifications', 'header.providers', 'header.archive', 'header.plans']

ALLOWLIST = [
    ('.help-system-ui', 'the help toggle, banner, popover, help card and user manual are the help system itself'),
    ('label:has(> select[aria-label="Cluster auto-compaction"])', 'the cluster-bar Auto-compaction control is owned by P6.72, which adds its key; remove this entry when it lands'),
]
# Panels whose controls must find their key inside the panel: the element right
# after each matched splitter. A broad key on an outer wrapper does not count.
STRICT_SCOPES = ['[data-help="cluster.right-panel-splitter"]']

PROBE = r'''
(view) => {
  const keys = window.__helpKeys;
  const allow = window.__helpAllow;
  const sel = 'button,a[href],input,select,textarea,[role=tab],[role=switch],[role=menuitem],[role=checkbox]';
  const visible = (el) => {
    if (el.closest('[aria-hidden="true"],[inert]')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
    if (el.type === 'hidden') return false;
    return true;
  };
  const component = (el) => {
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
    let f = k ? el[k] : null; const names = [];
    while (f && names.length < 3) { const t = f.type; if (typeof t === 'function' && t.name) names.push(t.name); f = f.return; }
    return names.join('<');
  };
  const label = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.textContent || el.value || el.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  // The cluster tab root carries the broad cluster.tab key. Inside the cluster
  // right panel (the element after its splitter) a control must resolve to a
  // key within the panel, so that wrapper cannot hide a missing control key.
  const scopes = [...document.querySelectorAll(window.__helpScopes)].map((s) => s.nextElementSibling).filter(Boolean);
  const uncovered = [], unresolved = []; let total = 0;
  for (const el of document.querySelectorAll('[data-help]')) {
    const key = el.getAttribute('data-help');
    if (!keys.has(key) && visible(el)) unresolved.push({ view, key, component: component(el) });
  }
  for (const el of document.querySelectorAll(sel)) {
    if (!visible(el)) continue;
    total++;
    if (allow.some((a) => el.closest(a))) continue;
    const host = el.closest('[data-help]');
    const scope = scopes.find((s) => s.contains(el));
    if (host && keys.has(host.getAttribute('data-help')) && (!scope || scope.contains(host))) continue;
    uncovered.push({ view, tag: el.tagName.toLowerCase() + (el.type ? ':' + el.type : ''), label: label(el), component: component(el), key: host ? host.getAttribute('data-help') : null });
  }
  return { uncovered, unresolved, total };
}
'''


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        context = await browser.new_context(viewport={'width': 1600, 'height': 1100})
        await context.add_init_script("localStorage.setItem('arco_ui_scale', '1')")
        errors, writes, messages = [], [], []
        requested = set()

        async def api(route):
            path = urlparse(route.request.url).path
            if route.request.method != 'GET' and path != '/api/session':
                writes.append(path)
            data = {'files': [], 'entries': [], 'workflows': [], 'projects': [], 'roots': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'tasks': [], 'sessions': [], 'messages': [], 'chats': [], 'presets': [], 'templates': [], 'models': [], 'profiles': []}
            if path == '/api/settings':
                data = {'themeId': 'arch', 'enabledProviders': {'claude': True, 'codex': True, 'ollama': True}, 'uiScale': 1, 'onboardingComplete': True, 'projectRoots': [{'id': 'r1', 'name': 'Projects', 'path': '/demo'}], 'projects': ['/demo/alpha']}
            elif path == '/api/auth-status':
                data = {n: {'loggedIn': n in ('claude', 'codex', 'ollama'), 'installed': True, 'cliInstalled': True, 'installedModels': ['local-small'] if n == 'ollama' else []} for n in ['claude', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'github']}
            elif path == '/api/capabilities':
                data = {'efforts': ['low', 'medium', 'high'], 'models': ['claude-opus-4-6'], 'cliVersion': 'fixture'}
            elif path.endswith('/catalog'):
                data = {'models': []}
            elif path == '/api/list-dirs':
                data = {'dirs': ['alpha', 'beta'], 'path': '/demo', 'parent': '/'}
            elif path == '/api/usage-stats':
                data = {'days': [], 'perProvider': {}, 'grandTotals': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheCreate': 0, 'turns': 0, 'promptTokens': 0, 'cacheHitRatio': 0}, 'from': None, 'to': None, 'workflowsScanned': 0, 'turnsAggregated': 0}
            elif path == '/api/projects':
                data = {'roots': [{'name': 'Work', 'path': '/demo', 'exists': True}], 'organization': True, 'scanFolder': None, 'homeFolder': '/demo',
                        'projects': [{'id': '00000000-0000-4000-8000-000000000001', 'name': 'alpha', 'path': '/demo/alpha', 'source': 'registered', 'exists': True, 'pinned': True, 'rootPath': '/demo'},
                                     {'id': '00000000-0000-4000-8000-000000000002', 'name': 'bookmark', 'path': '/elsewhere/bookmark', 'source': 'registered', 'exists': True},
                                     {'name': 'beta', 'path': '/demo/beta', 'source': 'scanned', 'exists': True, 'rootPath': '/demo'},
                                     {'id': '00000000-0000-4000-8000-000000000003', 'name': 'gone', 'path': '/demo/gone', 'source': 'registered', 'exists': False, 'rootPath': '/demo'}]}
            elif path == '/api/sessions':
                data = {'sessions': [{'sessionId': 'saved-1', 'provider': 'claude', 'name': 'Earlier work', 'startedAt': 1793210400000, 'cwd': '/demo/alpha'}]}
            elif path == '/api/smart-pickup/evaluators':
                data = {'evaluators': [{'provider': 'claude', 'available': True}, {'provider': 'ollama', 'available': True},
                                       {'provider': 'codex', 'available': False, 'reason': 'Codex requests can run tools.'}]}
            elif path == '/api/app/version':
                data = {'version': '0.1.0'}
            elif path == '/api/update-check':
                data = {'current': '0.1.0', 'latest': '0.2.0', 'url': 'https://example.invalid/release', 'publishedAt': None, 'checkedAt': None, 'enabled': True, 'updateAvailable': True}
            elif path == '/api/connections' and fixtures.get('catalog'):
                data = fixtures['catalog']
            elif path in ('/api/usage', '/api/codex-usage'):
                data = {'available': False}
            elif path not in GENERIC:
                # Unknown endpoints answer like a server without that feature, so
                # components take their own empty or error path.
                requested.add(path)
                await route.fulfill(status=404, json={'error': 'not available in the coverage fixture'})
                return
            await route.fulfill(json=data)

        await context.route('**/api/**', api)
        await context.route('**/healthz', lambda r: r.fulfill(json={'status': 'live'}))
        await context.route('https://**/*', lambda r: r.abort())
        await context.route_web_socket('**/*', lambda ws: ws.on_message(lambda msg: None if msg == '{"type":"ping"}' else messages.append(msg)))
        page = await context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e) + ' :: ' + (e.stack or '')[:600]))
        await page.goto(URL)
        await page.wait_for_timeout(800)
        await page.evaluate('''async (allow) => {
          const {useAppStore:s}=await import('/src/stores/appStore.ts');
          const {useStartupStore:st}=await import('/src/stores/startupStore.ts');
          const {useComputerStore:cs}=await import('/src/stores/computerStore.ts');
          const {HELP_CONTENT}=await import('/src/help/content/index.tsx');
          window.s=s; window.st=st; window.cs=cs;
          window.__helpKeys=new Set(Object.keys(HELP_CONTENT)); window.__helpAllow=allow.allow; window.__helpScopes=allow.scopes;
          s.setState({connected:true,connectionState:'connected'});
        }''', {'allow': [a for a, _ in ALLOWLIST], 'scopes': ','.join(STRICT_SCOPES)})
        await page.wait_for_function('() => s.getState().authStatus && s.getState().settings')
        # The real connection catalog, built from its source module with no environment.
        fixtures['catalog'] = await page.evaluate("async root => (await import(root + '/server/src/connectionCatalog.ts')).connectionCatalog({})", fs_url(ROOT))

        inventory = {'uncovered': [], 'unresolved': []}
        counts = {}
        missing_openers = []
        seen = set()

        async def probe(view):
            await page.wait_for_timeout(250)
            res = await page.evaluate(PROBE, view)
            counts[view] = res['total']
            for kind in ('uncovered', 'unresolved'):
                for item in res[kind]:
                    sig = (kind, item.get('component'), item.get('tag'), item.get('label'), item.get('key'))
                    if sig in seen:
                        continue
                    seen.add(sig)
                    inventory[kind].append(item)

        async def tap(selector):
            loc = page.locator(selector).first
            if not await loc.count() or not await loc.is_visible():
                return False
            try:
                await loc.click(timeout=3000)
            except Exception as e:  # noqa: BLE001 - an obscured control is reported by the probe instead
                print('skip', selector, str(e).splitlines()[0])
                return False
            return True

        async def click_all(selector, view_prefix):
            n = await page.locator(selector).count()
            for i in range(n):
                el = page.locator(selector).nth(i)
                if not await el.is_visible():
                    continue
                name = (await el.inner_text()).strip()[:30] or str(i)
                try:
                    await el.click(timeout=3000)
                except Exception:  # noqa: BLE001
                    continue
                await probe(f'{view_prefix}:{name}')

        try:
            await walk(page, probe, tap, click_all, missing_openers)
        finally:
            if REPORT:
                Path(REPORT).write_text(json.dumps({**inventory, 'counts': counts, 'errors': errors, 'missing': sorted(requested)}, indent=1))
        if missing_openers:
            print('openers not found: ' + ', '.join(missing_openers))
        print('controls checked per view: ' + ', '.join(f'{v}={n}' for v, n in counts.items()))
        problems = inventory['uncovered'] + inventory['unresolved']
        for item in problems[:400]:
            print('UNCOVERED' if 'tag' in item else 'UNRESOLVED', json.dumps(item))
        assert not errors, errors
        assert not writes, writes
        assert {'cluster:auto-pickup-armed', 'cluster:auto-pickup-dialog', 'cluster:auto-pickup-limits', 'cluster:auto-pickup-rule-limits'} <= set(counts), 'AUTO-PICKUP chip, dialog or limits not reached'
        assert not problems, f'{len(inventory["uncovered"])} uncovered controls, {len(inventory["unresolved"])} unresolved keys'
        await browser.close()
        print('PASS help coverage: every probed control has a resolving help key; allowlist: ' + '; '.join(f'{a} ({r})' for a, r in ALLOWLIST))


async def dismiss(page, opener):
    """Close whatever an opener showed: Escape, then an explicit cancel or close
    button in a remaining dialog, then the opener itself when it is a toggle."""
    await page.keyboard.press('Escape')
    await page.wait_for_timeout(150)
    for _ in range(3):
        closed = await page.evaluate('''() => {
          const cancel=[...document.querySelectorAll('[data-help$=".cancel"] button, button[data-help$=".cancel"]')].find(b=>b.getBoundingClientRect().width>0);
          if (cancel) { cancel.click(); return false; }
          const plain=[...document.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().width>0 && /^(cancel|close)$/i.test((b.textContent||'').trim()));
          if (plain.length) { plain[plain.length-1].click(); return false; }
          const backdrop=document.elementFromPoint(2, innerHeight-2);
          if (backdrop && getComputedStyle(backdrop).position==='fixed' && backdrop.getBoundingClientRect().width>=innerWidth-2) { backdrop.click(); return false; }
          const dialogs=[...document.querySelectorAll('[role=dialog],[aria-modal=true]')].filter(d=>d.getBoundingClientRect().width>0);
          if (!dialogs.length) return true;
          const d=dialogs[dialogs.length-1];
          const b=[...d.querySelectorAll('button')].find(x=>/^(cancel|close|×|✕|close ✕|× close)$/i.test((x.getAttribute('aria-label')||x.textContent||'').trim()) || /^(cancel|close)/i.test((x.textContent||'').trim()));
          if (b) { b.click(); return false; }
          return true;
        }''')
        await page.wait_for_timeout(150)
        if closed:
            break
    if opener:
        still = page.locator(opener).first
        if await still.count() and await still.get_attribute('aria-expanded') == 'true':
            await still.click(timeout=3000)
    await page.evaluate("s.setState({showPlans:false,showArchive:false})")


CLUSTER_PANEL = '[data-help="cluster.right-panel-splitter"] + *'


async def walk_cluster_panel(page, probe, tap):
    """Open the cluster right-panel states a tab click leaves closed: inline
    editors, pickers, pending mail, a running review, the detached board and
    saved snapshots. Each step reports its view, and a missing control fails."""
    panel = CLUSTER_PANEL
    reached = []

    async def step(view, opener, closer=None, key=None):
        if not await tap(opener):
            return
        await probe('cluster:' + view)
        reached.append(view)
        if key:
            await page.keyboard.press(key)
        if closer:
            await tap(closer)
        await page.wait_for_timeout(100)

    async def show(group, tab):
        await tap(f'{panel} [data-help="cluster.right-panel.group.{group}"]')
        await tap(f'{panel} [data-help="{tab}"]')

    await show('workspace', 'cluster.right-panel.members')
    await step('cluster-rename', f'{panel} button:text-is("RENAME")', f'{panel} button:text-is("CANCEL")')
    await step('save-state', f'{panel} button:text-is("SAVE STATE")', f'{panel} button:text-is("CANCEL")')
    await step('add-fresh', f'{panel} button[data-help="cluster.add-fresh"]', f'{panel} button[data-help="cluster.add-fresh"]')
    await step('add-existing', f'{panel} button[data-help="cluster.add-existing"]', f'{panel} button[data-help="cluster.add-existing"]')
    await step('member-rename', f'{panel} button[data-help="cluster.right-panel.rename"]', f'{panel} button:text-is("ESC")')
    await step('role-popover', f'{panel} button[data-help^="cluster.right-panel.role-"]')
    await step('role-custom', f'{panel} button[data-help="cluster.right-panel.role-custom"]', f'{panel} button:text-is("ESC")')
    await step('member-focus', f'{panel} button[data-help="cluster.right-panel.focus-display"]', key='Escape')
    # Outside the Standard layout the cluster settings are folded; open them.
    if await page.locator(f'{panel} [data-testid="cluster-settings-toggle"][aria-expanded="false"]').count():
        await tap(f'{panel} [data-testid="cluster-settings-toggle"]')
    await step('efficiency-note', f'{panel} button:text-matches("^NOTE")', key='Escape')

    await page.evaluate('''async () => {
      const {useClusterSnapshotsStore:snap} = await import('/src/stores/clusterSnapshotsStore.ts');
      const {useHubLinkStore:hub} = await import('/src/stores/hubLinkStore.ts');
      window.__hub = hub;
      snap.setState({snapshots:[{id:'cov-snap',name:'Coverage snapshot',createdAt:'2026-01-01T00:00:00.000Z',memberCount:2,sourceCwd:'/demo/alpha'}]});
      hub.getState().setStatus({connected:true});
    }''')
    await probe('cluster:saved-snapshots')
    await step('snapshot-restore', f'{panel} [data-help="cluster.saved-snapshots"] button:text-is("RESTORE")')
    await step('snapshot-cloud', f'{panel} [data-help="cluster.saved-snapshots"] button:text-is("CLOUD")')
    await page.evaluate("__hub.setState({connected:false,known:false})")

    await show('agent', 'cluster.mailbox')
    await step('mailbox-inspect', f'{panel} button:has-text("INSPECT")', key='Escape')
    await page.evaluate('''() => { const c=[...document.querySelectorAll('[data-help="cluster.mailbox-modal"] button')].find(b=>/close/i.test(b.textContent||'')); if (c) c.click(); }''')

    await page.evaluate('''() => s.getState().upsertReview('cov-m1','cov-review',{artifactName:'review.md',reviewer:{provider:'codex',model:'gpt-5',effort:'high'},startedAt:Date.now()})''')
    await show('agent', 'cluster.right-panel.tab.reviews')
    await probe('cluster:reviews-running')
    reached.append('reviews-running')

    await page.evaluate('''async () => {
      const {handleServerMessage:receive} = await import('/src/ws/handleServerMessage.ts');
      const c = s.getState().clusters['cov-cluster'];
      receive({type:'cluster_state',clusterId:'cov-cluster',state:{...c,taskBoardMode:'none',taskBoardAttached:false}},{wsRef:{current:null},scheduleReconnect:()=>{}});
    }''')
    await show('agent', 'cluster.board-tab')
    await probe('cluster:board-detached')
    reached.append('board-detached')

    expected = {'cluster-rename', 'save-state', 'add-fresh', 'add-existing', 'member-rename', 'role-popover', 'role-custom',
                'member-focus', 'efficiency-note', 'snapshot-restore', 'snapshot-cloud', 'mailbox-inspect'}
    missing = expected - set(reached)
    assert not missing, f'cluster right-panel states not reached: {sorted(missing)}'


async def walk(page, probe, tap, click_all, missing_openers):
        # Home
        await page.evaluate('s.getState().showHomeView()')
        await probe('home')

        # Creator in every mode (remounted so each prefill applies), plus a template review
        for mode in ['chat', 'single', 'cluster', 'genesis']:
            await page.evaluate("m => { s.getState().showHomeView(); }", mode)
            await page.wait_for_timeout(100)
            await page.evaluate("m => s.getState().openCreatorWith({mode:m, workDir:'/demo/alpha'})", mode)
            await probe(f'creator:{mode}')
            if mode == 'single':
                await tap('[data-help="creator.advanced"] button')
                await probe('creator:single-advanced')
            if mode == 'cluster':
                for frame in ['creator-member-defaults', 'creator-cluster-policy']:
                    await tap(f'button[aria-controls="{frame}"]')
                await tap('[data-help="creator.cluster-members"] button:has-text("EDIT")')
                await probe('creator:cluster-expanded')
                if await tap('[data-help="creator.cluster-templates"] button[title]'):
                    await probe('creator:template-review')

        # Workflow with every right-panel tab
        await page.evaluate('''() => {
          s.getState().createJob('cov-wf',{name:'Coverage workflow',primaryProvider:'claude',primaryModel:'claude-opus-4-6',workingDirectory:'/demo/alpha',skipPermissions:false});
          s.setState(st=>({showCreator:false,showHome:false,activeJobId:'cov-wf',jobs:{...st.jobs,'cov-wf':{...st.jobs['cov-wf'],snapshotReceived:true,busy:false}}}));
        }''')
        await probe('workflow')
        for key in OPENERS:
            target = f'button[data-help="{key}"], [data-help="{key}"] button'
            if not await tap(target):
                missing_openers.append(key)
                continue
            await probe('open:' + key)
            if key == 'composer.skills' and await tap('button:has-text("NEW SKILL")'):
                await probe('open:skill-editor')
                await tap('[data-help="composer.skills"] button:has-text("CLOSE")')
            await dismiss(page, target)
        await page.evaluate("s.getState().setActiveJob('cov-wf')")
        tab = page.locator('[data-help="tabbar.tab"]').first
        if await tab.count():
            await tab.click(button='right')
            await probe('tab-context-menu')
            await dismiss(page, None)
        group_keys = await page.evaluate("[...new Set([...document.querySelectorAll('[data-help^=\"rightpanel.group.\"]')].map(e=>e.getAttribute('data-help')))]")
        for gk in group_keys:
            if not await tap(f'[data-help="{gk}"]'):
                continue
            await probe('rightpanel:' + gk)
            tab_keys = await page.evaluate("[...new Set([...document.querySelectorAll('[data-help^=\"rightpanel.tab.\"]')].map(e=>e.getAttribute('data-help')))]")
            for tk in tab_keys:
                await tap(f'[data-help="{gk}"]')
                if await tap(f'[data-help="{tk}"]'):
                    await probe('rightpanel:' + tk)

        # Chat
        await page.evaluate('''() => {
          s.getState().createJob('cov-chat',{kind:'chat',name:'Coverage chat',primaryProvider:'claude',primaryModel:'claude-opus-4-6',workingDirectory:'',skipPermissions:false});
          s.setState(st=>({activeJobId:'cov-chat',jobs:{...st.jobs,'cov-chat':{...st.jobs['cov-chat'],snapshotReceived:true,busy:false}}}));
        }''')
        await page.evaluate('''() => {
          const add=(id,role,content)=>s.getState().addMessage('cov-chat',{id,role,content,isStreaming:false,timestamp:Date.now()});
          add('m1','user','Summarize the synthetic notes.');
          add('m2','assistant','Here is a [reference](https://example.invalid/doc) and code:\\n\\n```js\\nconsole.log(1)\\n```');
        }''')
        await probe('chat')
        await page.evaluate("async () => { const {useVoiceStore:v}=await import('/src/voice/store.ts'); window.vs=v; v.setState({open:true}); }")
        await probe('voice-controls')
        await page.evaluate("vs.setState({open:false})")

        # Cluster tab, every right-panel tab and the focused member
        await page.evaluate('''async () => {
          const {handleServerMessage:receive} = await import('/src/ws/handleServerMessage.ts');
          for (const [id,name] of [['cov-m1','Director'],['cov-m2','Builder']]) {
            s.getState().createJob(id,{name,workingDirectory:'/demo/alpha',primaryProvider:'claude',primaryModel:'claude-opus-4-6',primaryEffort:'low',skipPermissions:false});
            s.setState(st=>({jobs:{...st.jobs,[id]:{...st.jobs[id],snapshotReceived:true,busy:false}}}));
          }
          const members=[{workflowId:'cov-m1',displayName:'Director',status:'idle',role:'Director role.'},{workflowId:'cov-m2',displayName:'Builder',status:'busy',role:'Builder role.'}];
          receive({type:'cluster_state',clusterId:'cov-cluster',state:{clusterId:'cov-cluster',name:'Coverage cluster',cwd:'/demo/alpha',createdAt:'',taskBoardMode:'cluster',taskBoardAttached:true,mailboxDepth:{'cov-m2':1},members,idleNudgerEnabled:false}},{wsRef:{current:null},scheduleReconnect:()=>{}});
          s.getState().setActiveCluster('cov-cluster');
        }''')
        await probe('cluster')
        group_keys = await page.evaluate("[...new Set([...document.querySelectorAll('[data-help^=\"cluster.right-panel.group.\"]')].map(e=>e.getAttribute('data-help')))]")
        for gk in group_keys:
            if not await tap(f'[data-help="{gk}"]'):
                continue
            await probe('cluster:' + gk)
            tab_keys = await page.evaluate("sel => [...new Set([...document.querySelectorAll(sel)].map(e=>e.getAttribute('data-help')))]", CLUSTER_TABS)
            for tk in tab_keys:
                await tap(f'[data-help="{gk}"]')
                if await tap(f'[data-help="{tk}"]'):
                    await probe('cluster:' + tk)
        await walk_cluster_panel(page, probe, tap)

        # AUTO-PICKUP: armed Smart chip with TURN OFF, then the dialog in a Smart mode with limits open
        await page.evaluate('''async root => {
          const {handleServerMessage:receive} = await import('/src/ws/handleServerMessage.ts');
          const {DEFAULT_SMART_PICKUP_LIMITS} = await import(root + '/shared/src/protocol/autoPickup.ts');
          const now=Date.now();
          const members=[{workflowId:'cov-m1',displayName:'Director',status:'idle',role:'Director role.'},{workflowId:'cov-m2',displayName:'Builder',status:'busy',role:'Builder role.'}];
          receive({type:'cluster_state',clusterId:'cov-cluster',state:{clusterId:'cov-cluster',name:'Coverage cluster',cwd:'/demo/alpha',createdAt:'',taskBoardMode:'cluster',taskBoardAttached:true,mailboxDepth:{'cov-m2':1},members,idleNudgerEnabled:false,
            autoPickup:{mode:'smart-auto',evaluator:{provider:'claude',model:'claude-opus-4-6'},limits:{...DEFAULT_SMART_PICKUP_LIMITS},
              session:{id:'cov-session',armedAt:now,expiresAt:now+3600000},counters:{inFlight:0,callsLastHour:1,callsThisSession:1,wakesLastHour:0,wakesThisSession:0},
              lastDecision:{at:now,recipientWorkflowId:'cov-m2',action:'defer',reason:'waiting_on_peer',outcome:'logged'}}}},{wsRef:{current:null},scheduleReconnect:()=>{}});
        }''', fs_url(ROOT))
        await probe('cluster:auto-pickup-armed')
        if await tap('button[data-help="cluster.auto-turn"]'):
            await probe('cluster:auto-pickup-dialog')
            await tap('[data-help="cluster.auto-pickup-limits"] summary')
            await probe('cluster:auto-pickup-limits')
            await page.get_by_role('radio', name='Rule-based').check()
            await probe('cluster:auto-pickup-rule-limits')
            await page.keyboard.press('Escape')

        # Sub-worker detail
        await page.evaluate('''() => {
          s.setState(st=>({activeClusterId:null,activeJobId:'cov-wf',jobs:{...st.jobs,'cov-wf':{...st.jobs['cov-wf'],workers:{...(st.jobs['cov-wf'].workers||{}),'w1':{id:'w1',workerId:'w1',kind:'reviewer',status:'complete',provider:'codex',model:'gpt-5',output:'',text:'',toolCalls:[],denials:[],startedAt:Date.now(),label:'Reviewer'}}}}}));
          s.getState().setDetailWorker({jobId:'cov-wf',workerId:'w1'});
        }''')
        await probe('worker-detail')
        await page.evaluate("s.getState().setDetailWorker(null)")

        # Full-screen surfaces opened from the header
        for name, on, off in [('recall', 's.getState().setShowRecall(true)', 's.getState().setShowRecall(false)'),
                              ('github', 's.getState().setShowGithub(true)', 's.getState().setShowGithub(false)'),
                              ('media-studio', 's.getState().setMediaStudio({open:true})', 's.getState().setMediaStudio({open:false})')]:
            await page.evaluate(on)
            await probe(name)
            await page.evaluate(off)

        # Settings pages
        await page.evaluate('s.getState().setShowSettings(true)')
        await page.wait_for_timeout(300)
        await probe('settings')
        await click_all('[data-help^="settings.page."], [role=dialog] nav button', 'settings')
        await page.evaluate('s.getState().setShowSettings(false)')

        # Connections and welcome
        await page.evaluate('st.getState().openConnections()')
        await probe('connections')
        ids = [p['id'] for p in fixtures['catalog']['providers']]
        for pid in ids:
            await page.evaluate("id => st.getState().openConnections(id)", pid)
            await probe('connections:' + pid)
        await page.evaluate('st.getState().setSetupOpen(false)')
        await page.evaluate('st.getState().setFirstRunOpen(true)')
        await probe('welcome')
        if await tap('button:has-text("Get started")'):
            for step in range(6):
                await probe(f'welcome:{step}')
                if not await tap('button:has-text("Skip this step")'):
                    break
            await probe('welcome:done')
        await page.evaluate('st.getState().setFirstRunOpen(false)')

        # Computer
        await page.evaluate('cs.getState().setOpen(true)')
        await probe('computer')
        await page.evaluate('cs.getState().setOpen(false)')


asyncio.run(main())
