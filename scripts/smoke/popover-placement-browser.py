"""Dropdowns, popovers, menus, hover cards and notices stay inside the window.

Actual App against Vite with every API and the WebSocket isolated; synthetic
fixtures only. Each floating panel is opened where the layout puts it and
again with its trigger pinned near each window corner, at 1280x800, 900x700
and 480x800, at 100% and 150% interface scale. Its box must lie inside the
window and it must carry the shared placement marker.

ARCO_POPOVER_REPORT_ONLY=1 records overflows instead of failing (used for the
before-and-after comparison). ARCO_SHOT_DIR=<dir> saves a screenshot of every
overflow and of the cases named in ARCO_POPOVER_SHOTS (name@width@scale@where,
comma separated).
"""
import asyncio
import json
import os
from urllib.parse import urlparse
from playwright.async_api import async_playwright
from host_isolation import chrome_executable

URL = f"http://127.0.0.1:{os.environ.get('ARCO_CLIENT_PORT', '5251')}/"
CHROME = chrome_executable() or None
REPORT_ONLY = os.environ.get('ARCO_POPOVER_REPORT_ONLY') == '1'
SHOTS = os.environ.get('ARCO_SHOT_DIR')
SHOT_CASES = set(filter(None, os.environ.get('ARCO_POPOVER_SHOTS', '').split(',')))
CONFIGS = [(900, 700, 1.1)]
WHERE = ['natural', 'bottom-right']
PROVIDERS = ['claude', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'github']
LOGGED_IN = ('claude', 'codex', 'cursor', 'ollama')
AUTH = {n: {'loggedIn': n in LOGGED_IN, 'installed': True, 'cliInstalled': True} for n in PROVIDERS}
SIGNED_OUT = {**AUTH, 'claude': {'loggedIn': False, 'installed': True, 'cliInstalled': True, 'cli': {'loggedIn': False}}}

# (name, view, trigger, panel, open by). The panel's positioned parent is what
# gets pinned to a corner; 'trigger' cases pin the trigger itself (panels
# placed with position: fixed from the trigger's box).
CASES = [
    ('providers', 'workflow', 'button[aria-label="Provider versions"]', '[data-help="header.cli-versions"][role=dialog]', 'click-fixed'),
    ('more', 'workflow', '[data-testid="composer-more"]', '[data-testid="composer-more-menu"]', 'click'),
    ('needs-you', 'cluster', '[data-testid="cluster-needs-you"]', '[data-testid="cluster-needs-you-list"]', 'click-fixed'),
    ('home-more', 'home', '.home-more > summary', '.home-more > div', 'click'),
    ('project-actions', 'home', '.home-card-menu > summary >> nth=0', '.home-card-menu[open] > div', 'click'),
]
# Set up before and undone after a case: the auth chip shows only while Claude is signed out.
PRE = {'auth-chip': "s.setState(st=>({authStatus:{...st.authStatus, claude:{loggedIn:false, installed:true, cliInstalled:true, cli:{loggedIn:false}, native:{state:'missing', checkedAt:Date.now()}}}}))"}
POST = {'auth-chip': "auth => s.setState({authStatus:auth})"}
VISIBLE_BOX = '''(sel) => {
  const els=[...document.querySelectorAll(sel)].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;});
  if(!els.length) return null;
  const e=els[els.length-1]; const r=e.getBoundingClientRect();
  return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight,marker:e.getAttribute('data-window-placement'),position:getComputedStyle(e).position,headerBottom:document.querySelector('header')?.getBoundingClientRect().bottom??0};
}'''

PIN = '''([el, where]) => {
  if (!el.dataset.ppStyle) el.dataset.ppStyle = el.getAttribute('style') || '';
  const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const r0 = el.getBoundingClientRect();
  Object.assign(el.style, {position:'fixed', margin:'0', right:'auto', bottom:'auto', zIndex:'99990', left:'0px', top:'0px'});
  const gap = 2 * zoom;
  const x = where.endsWith('left') ? gap : innerWidth - r0.width - gap;
  const y = where.startsWith('top') ? gap : innerHeight - r0.height - gap;
  for (let i = 0; i < 2; i++) {
    const r = el.getBoundingClientRect();
    el.style.left = (parseFloat(el.style.left) + (x - r.left) / zoom) + 'px';
    el.style.top = (parseFloat(el.style.top) + (y - r.top) / zoom) + 'px';
  }
}'''
# MORE disappears if its wrapper is removed from the toolbar's layout: the
# test would remove the overflow it is trying to exercise. A transform moves
# the wrapper visually while preserving its original space in the row.
PIN_MORE = """([el, where]) => {
  if (!el.dataset.ppStyle) el.dataset.ppStyle = el.getAttribute('style') || '';
  const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const r = el.getBoundingClientRect(), gap = 2 * z;
  const x = where.endsWith('left') ? gap : innerWidth - r.width - gap;
  const y = where.startsWith('top') ? gap : innerHeight - r.height - gap;
  el.style.zIndex = '99990';
  el.style.transform = `translate(${(x-r.left)/z}px, ${(y-r.top)/z}px)`;
}"""
UNPIN = '''() => { for (const el of document.querySelectorAll('[data-pp-style]')) { el.setAttribute('style', el.dataset.ppStyle); delete el.dataset.ppStyle; } }'''
FRAMES = 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'


def fixture_settings(scale):
    return {'themeId': 'arch', 'enabledProviders': {p: True for p in PROVIDERS}, 'uiScale': scale, 'onboardingComplete': True, 'updateCheck': True,
            'projectRoots': [{'id': 'r1', 'name': 'Projects', 'path': '/demo'}], 'projects': ['/demo/alpha']}


async def open_app(browser, width, height, scale, state):
    context = await browser.new_context(viewport={'width': width, 'height': height})
    await context.add_init_script(f"localStorage.setItem('arco_ui_scale', '{scale}'); localStorage.setItem('arco.layoutMode', 'auto')")
    errors, writes = [], []

    async def api(route):
        path = urlparse(route.request.url).path
        if route.request.method != 'GET' and path != '/api/session':
            writes.append(path)
        data = {'files': [], 'entries': [], 'workflows': [], 'projects': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'tasks': [], 'sessions': [], 'messages': [], 'chats': [], 'models': []}
        if path == '/api/settings':
            data = fixture_settings(scale)
        elif path == '/api/auth-status':
            data = state['auth']
        elif path == '/api/capabilities':
            data = {'efforts': ['low', 'medium', 'high'], 'models': ['claude-opus-4-6'], 'cliVersion': '2.1.0', 'codexVersion': '0.9.0', 'latestVersions': {'claude': '2.1.0', 'codex': '0.9.0'}}
        elif path == '/api/update-check':
            data = {'current': '0.1.4', 'latest': '0.1.5', 'url': 'https://example.invalid/release', 'publishedAt': None, 'checkedAt': None, 'enabled': True, 'updateAvailable': True}
        elif path == '/api/skills':
            # Exercise the loading-to-catalog size change before measuring.
            await asyncio.sleep(0.15)
            data = {'project': [], 'global': [], 'builtin': []}
        elif path == '/api/voice/setup':
            data = {'ready': False, 'install': {'running': False}}
        elif path in ('/api/usage', '/api/codex-usage', '/api/cursor-usage'):
            data = {'available': False}
        elif path == '/api/projects':
            data = {'roots': [{'name': 'Work', 'path': '/demo', 'exists': True}], 'organization': True, 'scanFolder': None, 'homeFolder': '/demo',
                    'projects': [{'id': f'00000000-0000-4000-8000-00000000000{i}', 'name': n, 'path': f'/demo/{n}', 'source': 'registered', 'exists': True, 'rootPath': '/demo'} for i, n in enumerate(['alpha', 'beta', 'gamma'], 1)]}
        elif path.endswith('/catalog'):
            data = {'models': []}
        await route.fulfill(json=data)

    await context.route('**/api/**', api)
    await context.route('**/healthz', lambda r: r.fulfill(json={'status': 'live'}))
    await context.route('https://**/*', lambda r: r.abort())
    await context.route_web_socket('**/*', lambda ws: None)
    page = await context.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    await page.goto(URL)
    await page.evaluate('''async () => {
      const {useAppStore:s}=await import('/src/stores/appStore.ts');
      window.s=s;
      window.warn=(await import('/src/stores/storageWarningStore.ts')).useStorageWarningStore;
      window.receive=(await import('/src/ws/handleServerMessage.ts')).handleServerMessage;
      s.setState({connected:true, connectionState:'connected'});
    }''')
    await page.wait_for_function('() => s.getState().authStatus && s.getState().settings')
    await page.evaluate('document.fonts.ready')
    await page.evaluate('''auth => {
      s.setState({connected:true, connectionState:'connected', authStatus:auth,
        quotaState:{claude:{throttled:true, until:Date.now()+600000, reason:'fixture rate limit'}, codex:{throttled:true, until:Date.now()+600000, reason:'fixture rate limit'}},
        ollamaLive:{loadedModels:[{name:'fixture-small:latest', expiresAt:new Date(Date.now()+900000).toISOString()},{name:'fixture-medium:latest', expiresAt:new Date(Date.now()+1800000).toISOString()}]}});
      for (const [id,name] of [['pp-wf','Placement workflow'],['pp-m1','Director'],['pp-m2','Builder']]) {
        s.getState().createJob(id,{name,primaryProvider:'claude',primaryModel:'claude-opus-4-6',primaryEffort:'low',workingDirectory:'/demo/alpha',skipPermissions:false});
        s.setState(st=>({jobs:{...st.jobs,[id]:{...st.jobs[id],snapshotReceived:true,busy:false}}}));
      }
      const members=[{workflowId:'pp-m1',displayName:'Director',status:'idle',role:'Director role.'},{workflowId:'pp-m2',displayName:'Builder',status:'busy',role:'Builder role.'}];
      receive({type:'cluster_state',clusterId:'pp-cluster',state:{clusterId:'pp-cluster',name:'Placement cluster',cwd:'/demo/alpha',createdAt:'',taskBoardMode:'cluster',taskBoardAttached:true,mailboxDepth:{'pp-m2':1},members,idleNudgerEnabled:false}},{wsRef:{current:null},scheduleReconnect:()=>{}});
      const tasks=[1,2,3,4,5,6,7,8].map(i=>({id:'pp-t'+i,title:'Synthetic review item '+i+' with a long enough title to wrap',status:'review',signoff:{state:'met',summary:'Fixture sign-off '+i},createdAt:i,updatedAt:i}));
      s.getState().setTaskLedger('/demo/alpha', tasks);
    }''', AUTH)
    return context, page, errors, writes


async def show(page, view):
    if view == 'workflow':
        await page.evaluate("s.setState({showCreator:false, showHome:false, activeClusterId:null, activeJobId:'pp-wf'})")
    elif view == 'cluster':
        await page.evaluate("s.setState({showCreator:false, showHome:false}); s.getState().setActiveCluster('pp-cluster')")
        members = page.locator('[data-help="cluster.right-panel.members"]').first
        if await members.count() and await members.is_visible():
            await members.click()
    else:
        await page.evaluate('s.getState().showHomeView()')
    await page.wait_for_timeout(250)


async def close_all(page):
    await page.keyboard.press('Escape')
    await page.evaluate("""() => { document.activeElement?.blur?.();
      for (const d of document.querySelectorAll('[data-testid="provider-dot"]')) d.dispatchEvent(new MouseEvent('mouseout',{bubbles:true, relatedTarget:document.body}));
      document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); document.body.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      for (const d of document.querySelectorAll('details[open]')) d.open = false;
      s.setState({activeHelpPopover:null, notifications:[]}); warn.setState({warnings:[]}); }""")
    size = page.viewport_size
    await page.mouse.move(size['width'] / 2, size['height'] - 2)
    await page.evaluate(FRAMES)


async def visible(page, selector):
    loc = page.locator(selector).first
    return await loc.count() > 0 and await loc.is_visible()


async def prepare(page, name):
    """Narrow windows show the member list and the right panel on request."""
    if name == 'needs-you' and not await visible(page, '[data-testid="cluster-needs-you"]') and await visible(page, '[data-testid="member-list-open"]'):
        await page.get_by_test_id('member-list-open').dispatch_event('click')
    if name == 'role' and not await visible(page, 'button[data-help^="cluster.right-panel.role-"]'):
        if await visible(page, '[data-testid="layout-panel-strip"]'):
            await page.get_by_test_id('layout-panel-strip').get_by_role('button', name='MORE').dispatch_event('click')
            await page.evaluate(FRAMES)
        for sel in ('[data-help="cluster.right-panel.group.workspace"]', '[data-help="cluster.right-panel.members"]'):
            if await visible(page, sel):
                await page.locator(sel).first.dispatch_event('click')
                await page.evaluate(FRAMES)
    await page.evaluate(FRAMES)


async def open_case(page, case, where):
    name, _view, trigger, panel, how = case
    if how == 'help':
        rect = await page.evaluate('''where => { const z=parseFloat(getComputedStyle(document.documentElement).zoom)||1, w=40*z, h=16*z;
          const x = where==='natural' ? innerWidth/2 : where.endsWith('left') ? 2 : innerWidth-w-2;
          const y = where==='natural' ? 60 : where.startsWith('top') ? 2 : innerHeight-h-2;
          return {left:x, right:x+w, top:y, bottom:y+h, width:w, height:h}; }''', where)
        await page.evaluate("r => s.setState({activeHelpPopover:{key:'header.providers', anchorRect:r}})", rect)
        await page.wait_for_timeout(220)
        return True
    if how == 'notice':
        if name == 'storage-notice':
            await page.evaluate("warn.getState().add({type:'storage_warning',workflowId:'pp-wf',fileThresholdBytes:1,conversationThresholdBytes:1,items:[1,2,3].map(i=>({path:'artifacts/synthetic-output-'+i+'-with-a-long-file-name.bin',bytes:1610612736}))})")
        else:
            await page.evaluate("() => { for (const i of [1,2,3]) s.getState().pushNotification('info','Synthetic notice '+i+': a finished turn in a tab with a long name that wraps onto more lines'); }")
            await page.evaluate("() => { const box=[...document.querySelectorAll('div')].find(d=>getComputedStyle(d).position==='fixed' && d.style.top==='16px' && d.style.right==='16px'); if (box) box.setAttribute('data-testid','pp-toast'); }")
        await page.evaluate(FRAMES)
        return True
    loc = page.locator(trigger)
    if not await loc.count() or not await loc.first.is_visible():
        return False
    if where != 'natural':
        if how == 'click-fixed':
            await page.evaluate(PIN, [await loc.first.element_handle(), where])
        else:
            # Pin the panel's positioned parent, found on a first open.
            await (loc.first.hover(timeout=4000) if how == 'hover' else loc.first.click(timeout=4000))
            await page.evaluate(FRAMES)
            parent = await page.evaluate_handle('sel => { const els=[...document.querySelectorAll(sel)].filter(e=>e.getBoundingClientRect().width>0); const e=els[els.length-1]; return e ? e.offsetParent : null; }', panel)
            # Close by the trigger itself: Escape would also close a slide-out.
            if how == 'hover':
                await page.mouse.move(page.viewport_size['width'] / 2, page.viewport_size['height'] - 2)
                await loc.first.dispatch_event('mouseout')
                await page.evaluate('document.activeElement?.blur?.()')
            else:
                await loc.first.dispatch_event('click')
            await page.evaluate(FRAMES)
            if await parent.evaluate('p => !p || p === document.body'):
                return False
            await page.evaluate(PIN_MORE if name == 'more' else PIN, [parent, where])
    if name == 'skills':
        # Its catalog changes the panel height after opening. Wait for the
        # real fixture response and rendered result before measuring placement.
        async with page.expect_response(lambda response: urlparse(response.url).path == '/api/skills'):
            if where == 'natural':
                await loc.first.click(timeout=4000)
            else:
                await loc.first.dispatch_event('click')
            await page.evaluate(FRAMES)
            loading = await page.evaluate(VISIBLE_BOX, panel)
            assert loading and loading['marker'], 'skills loading panel did not open or has no placement marker'
            assert loading['left'] >= -1 and loading['top'] >= -1 and loading['right'] <= loading['w'] + 1 and loading['bottom'] <= loading['h'] + 1, f'skills loading panel left the window: {loading}'
        await page.get_by_text("A skill is reusable guidance for an agent.", exact=False).wait_for()
    elif where == 'natural':
        await (loc.first.hover(timeout=4000) if how == 'hover' else loc.first.click(timeout=4000))
    else:
        # A pinned trigger can sit under the composer or a panel (it keeps its
        # own stacking context), so the event goes to it directly.
        # Hover cards also open on keyboard focus, which no cover can block.
        await (loc.first.focus() if how == 'hover' else loc.first.dispatch_event('click'))
    await page.evaluate(FRAMES)
    return True


async def run_config(browser, width, height, scale, failures, overflow, reached):
    state = {'auth': AUTH}
    context, page, errors, writes = await open_app(browser, width, height, scale, state)
    for view in ('workflow', 'cluster', 'home'):
        await show(page, view)
        for case in [c for c in CASES if c[1] == view]:
            name = case[0]
            if name in PRE:
                state['auth'] = SIGNED_OUT
                await page.evaluate(PRE[name])
            if name == 'more':
                # Check the natural toolbar first if it has overflow. Font and
                # scrollbar metrics decide whether MORE exists at this width.
                await close_all(page)
                await prepare(page, name)
                if await visible(page, case[2]):
                    await open_case(page, case, 'natural')
                    box = await page.evaluate(VISIBLE_BOX, case[3])
                    if not box:
                        failures.append(f'{name}@{width}@{scale}@natural-unmodified: panel did not open')
                    else:
                        out = max(0, -box['left'], -box['top'], box['right'] - box['w'], box['bottom'] - box['h'])
                        if out > 1:
                            overflow.append((round(out), f'{name}@{width}@{scale}@natural-unmodified', box))
                        if not box['marker'] and not (name == 'providers' and box['position'] == 'fixed' and box['top'] >= box['headerBottom'] - 1):
                            failures.append(f'{name}@{width}@{scale}@natural-unmodified: no placement marker')
                else:
                    hidden = await page.locator('[data-testid="composer-toolbar"] > [data-overflowed="true"]:not([data-overflow-more])').count()
                    if hidden:
                        failures.append(f'{name}@{width}@{scale}@natural-unmodified: {hidden} tools hidden without MORE')
                await close_all(page)
                # Force enough overflow for the corner-placement checks on
                # every platform, independent of system font metrics.
                await page.locator('[data-testid="composer-toolbar"]').evaluate("e => { e.dataset.ppToolbarStyle = e.getAttribute('style') || ''; e.style.maxWidth = '400px'; }")
                await page.evaluate(FRAMES)
            for where in WHERE:
                tag = f'{name}@{width}@{scale}@{where}'
                await close_all(page)
                await page.evaluate(UNPIN)
                await prepare(page, name)
                try:
                    opened = await open_case(page, case, where)
                except Exception as e:  # noqa: BLE001 - reported with what covered the trigger
                    cover = await page.evaluate('''sel => { const t=document.querySelector(sel.split(' >> ')[0]); if(!t) return null; const r=t.getBoundingClientRect(); const e=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return e ? e.outerHTML.slice(0,160) : null; }''', case[2] or 'body')
                    failures.append(f'{tag}: could not open ({str(e).splitlines()[0][:80]}); covered by {cover}')
                    if SHOTS:
                        await page.screenshot(path=os.path.join(SHOTS, f'popover-{tag.replace("@", "-")}-blocked.png'))
                    continue
                if not opened:
                    if where != 'natural':
                        failures.append(f'{tag}: could not pin the trigger')
                    else:
                        failures.append(f'{tag}: trigger not found')
                    continue
                box = await page.evaluate(VISIBLE_BOX, case[3])
                if not box:
                    failures.append(f'{tag}: panel did not open')
                    continue
                reached[name] = reached.get(name, 0) + 1
                out = max(0, -box['left'], -box['top'], box['right'] - box['w'], box['bottom'] - box['h'])
                if SHOTS and (out > 1 or tag in SHOT_CASES):
                    await page.screenshot(path=os.path.join(SHOTS, f'popover-{tag.replace("@", "-")}.png'))
                if out > 1:
                    overflow.append((round(out), tag, {k: round(v) if isinstance(v, float) else v for k, v in box.items()}))
                if not box['marker'] and not (name == 'providers' and box['position'] == 'fixed' and box['top'] >= box['headerBottom'] - 1):
                    failures.append(f'{tag}: no placement marker')
            if name == 'more':
                await close_all(page)
                await page.evaluate(UNPIN)
                await page.locator('[data-testid="composer-toolbar"]').evaluate("e => { e.setAttribute('style', e.dataset.ppToolbarStyle); delete e.dataset.ppToolbarStyle; }")
                await page.evaluate(FRAMES)
            if name in POST:
                state['auth'] = AUTH
                await close_all(page)
                await page.evaluate(POST[name], AUTH)
        await close_all(page)
        await page.evaluate(UNPIN)
    if errors:
        failures.append(f'{width}x{height}@{scale}: page errors {errors[:3]}')
    if writes:
        failures.append(f'{width}x{height}@{scale}: writes {sorted(set(writes))}')
    await context.close()


async def main():
    failures, overflow = [], []
    reached = {}
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        # Three windows at a time keep the run short; each has its own context.
        for i in range(0, len(CONFIGS), 3):
            await asyncio.gather(*(run_config(browser, w, h, sc, failures, overflow, reached) for w, h, sc in CONFIGS[i:i + 3]))
        await browser.close()
    overflow.sort(reverse=True)
    for out, tag, box in overflow:
        print(f'OVERFLOW {out}px {tag} {json.dumps(box)}')
    missing = sorted({c[0] for c in CASES} - set(reached))
    print('opened per panel: ' + ', '.join(f'{k}={v}' for k, v in sorted(reached.items())))
    if REPORT_ONLY:
        print(f'REPORT: {len(overflow)} overflowing opens, {len(failures)} other findings, never opened: {missing}')
        for f in failures[:600]:
            print('FINDING', f)
        return
    assert not missing, f'panels never opened: {missing}'
    assert not failures, '\n'.join(failures[:80])
    assert not overflow, f'{len(overflow)} panels left the window'
    print(f'PASS popover placement: {len(CASES)} panels x {len(CONFIGS)} window sizes and scales x {len(WHERE)} positions stay inside the window')

asyncio.run(main())
