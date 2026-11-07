"""Check visible controls, colors and fonts in the real app with fixture APIs.

The walk exercises workspace, creator, cluster, settings, help and explorer
surfaces in Classic and Phosphor at two window sizes. A sentinel detects text
inheriting the body color; native controls are compared with unstyled controls
in an isolated frame. No provider execution or persistent writes are allowed.
Set ARCO_HELP_COVERAGE_REPORT to save the measured results as JSON.
"""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.async_api import async_playwright
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path, fs_url
from host_isolation import chrome_executable

URL = os.environ.get('ARCO_HELP_PREVIEW_URL', f"http://127.0.0.1:{os.environ.get('ARCO_CLIENT_PORT', '5179')}/")
CHROME = chrome_executable() or None
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
OPTIONAL_OPENERS = {
    'header.providers': 'The fixture has no actionable provider status chip.',
    'header.archive': 'The explorer is opened and checked in this page directly.',
    'header.plans': 'The explorer Plans lens is checked in this page directly.',
}

ALLOWLIST = []
# Browser-owned subcontrols are retained for their native interaction. The
# input itself is still checked for its background, border, color and font.
NATIVE_AFFORDANCES = [
    ('input[type=number] stepper', 'Retains pointer and keyboard stepping on each platform.'),
    ('input[type=date] calendar', 'Retains the browser and operating system date picker.'),
]
# Panels whose controls must find their key inside the panel: the element right
# after each matched splitter. A broad key on an outer wrapper does not count.
STRICT_SCOPES = ['[data-help="cluster.right-panel-splitter"]']

PROBE = r'''
(view) => {
  const iframe = document.createElement('iframe'); iframe.style.display='none'; document.body.append(iframe);
  const refs={}; for (const type of ['text','number','search','email','url','password','date','time','checkbox','radio','range','select-one','textarea']) {
    const tag=type==='textarea'?'textarea':type==='select-one'?'select':'input';
    const el=iframe.contentDocument.createElement(tag); if(tag==='input')el.type=type;
    iframe.contentDocument.body.append(el); const s=iframe.contentWindow.getComputedStyle(el);
    refs[type]={backgroundColor:s.backgroundColor,borderTopColor:s.borderTopColor,color:s.color,fontFamily:s.fontFamily};
  }
  const root=getComputedStyle(document.documentElement), tokenColors=new Set(), tokenFonts=new Set();
  const sample=document.createElement('span'); document.body.append(sample);
  for(const name of root) {
    if(name.startsWith('--color-') || name.startsWith('--arco-')) { sample.style.color=''; sample.style.color=`var(${name})`; const c=getComputedStyle(sample).color; if(c)tokenColors.add(c); }
    if(name.startsWith('--font-')) {sample.style.fontFamily=`var(${name})`;tokenFonts.add(getComputedStyle(sample).fontFamily);}
  }
  sample.remove(); const sentinel='rgb(1, 2, 3)', errors=[]; let total=0;
  const previousColor=document.body.style.getPropertyValue('color'), previousPriority=document.body.style.getPropertyPriority('color');
  document.body.style.setProperty('color',sentinel,'important');
  const visible=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect(); if(r.width<=0 || r.height<=0 || r.right<=0 || r.bottom<=0 || r.left>=innerWidth || r.top>=innerHeight || s.display==='none' || s.visibility==='hidden' || Number(s.opacity)===0 || e.closest('[inert],[aria-hidden="true"]'))return false; for(let p=e.parentElement;p;p=p.parentElement){const ps=getComputedStyle(p),pr=p.getBoundingClientRect(); if(/auto|scroll|hidden|clip/.test(ps.overflowX) && (r.right<=pr.left || r.left>=pr.right))return false; if(/auto|scroll|hidden|clip/.test(ps.overflowY) && (r.bottom<=pr.top || r.top>=pr.bottom))return false;} return true;};
  const path=e=>{const bits=[]; while(e && e.nodeType===1 && bits.length<6){let s=e.tagName.toLowerCase(); if(e.id){bits.unshift(s+'#'+CSS.escape(e.id));break;} const h=e.getAttribute('data-help'); if(h){bits.unshift(s+'[data-help="'+h+'"]');break;} const label=e.getAttribute('aria-label'); if(label)s+='[aria-label="'+label+'"]'; else if(e.parentElement) s+=':nth-child('+([...e.parentElement.children].indexOf(e)+1)+')'; bits.unshift(s); e=e.parentElement;}return bits.join(' > ');};
  for(const e of document.querySelectorAll('*')) {
    if(!visible(e))continue; const s=getComputedStyle(e), problems=[];
    if(e.matches('select,input,textarea') && refs[e.type]) { total++; for(const [key,value] of Object.entries(refs[e.type]))if(s[key]===value)problems.push('default '+key+'='+value); if(s.color===sentinel)problems.push('inherited control color'); else if(!tokenColors.has(s.color))problems.push('non-token control color '+s.color); if(!tokenFonts.has(s.fontFamily))problems.push('non-theme control font '+s.fontFamily); }
    if([...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())) {total++; if(s.color===sentinel)problems.push('inherited page color'); else if(!tokenColors.has(s.color))problems.push('non-token color '+s.color); if(!tokenFonts.has(s.fontFamily))problems.push('non-theme font '+s.fontFamily);}
    if(problems.length)errors.push({view,tag:e.tagName.toLowerCase(),label:path(e),key:problems.join(', ')});
  }
  if(previousColor) document.body.style.setProperty('color',previousColor,previousPriority); else document.body.style.removeProperty('color');
  iframe.remove(); return {uncovered:errors,unresolved:[],total};
}
'''


async def main(theme, viewport):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        context = await browser.new_context(viewport=viewport)
        await context.add_init_script("localStorage.setItem('arco_ui_scale', '1')")
        errors, writes, messages = [], [], []
        requested = set()

        async def api(route):
            path = urlparse(route.request.url).path
            if route.request.method != 'GET' and path not in ('/api/session', '/api/skills/share/preview', '/api/architecture-review/candidates'):
                writes.append(path)
            data = {'files': [], 'entries': [], 'workflows': [], 'projects': [], 'roots': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'tasks': [], 'sessions': [], 'messages': [], 'chats': [], 'presets': [], 'templates': [], 'models': [], 'profiles': []}
            if path == '/api/settings':
                data = {'themeId': 'arch', 'enabledProviders': {name: True for name in ['claude', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek']}, 'uiScale': 1, 'onboardingComplete': True, 'projectRoots': [{'id': 'r1', 'name': 'Projects', 'path': '/demo'}], 'projects': ['/demo/alpha']}
            elif path == '/api/auth-status':
                data = {n: {'loggedIn': n in ('claude', 'codex', 'ollama'), 'installed': True, 'cliInstalled': True, 'installedModels': ['local-small'] if n == 'ollama' else []} for n in ['claude', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'github']}
            elif path == '/api/capabilities':
                data = {'efforts': ['low', 'medium', 'high'], 'models': ['claude-opus-4-6'], 'cliVersion': 'fixture', 'strataVersion': '0.1.0', 'xolotlRevision': '1111111111111111111111111111111111111111', 'latestVersions': {'strata': '0.2.0', 'xolotl': '2222222222222222222222222222222222222222'}}
            elif path.endswith('/catalog'):
                data = {'models': []}
            elif path == '/api/list-dirs':
                data = {'dirs': [{'name': 'alpha', 'path': '/demo/alpha'}, {'name': 'beta', 'path': '/demo/beta'}], 'path': '/demo', 'parent': '/'}
            elif path == '/api/app-browsers':
                browser = {'id': 'chromium', 'name': 'Chromium', 'path': '/fixture/browser'}
                data = {'platform': 'linux', 'choice': None, 'browsers': [browser], 'using': browser, 'missing': False}
            elif path == '/api/storage/policy':
                data = {'autoArchiveClosedDays': None, 'budgetGiB': 100, 'budgetNotice': False}
            elif path == '/api/storage-report':
                if parse_qs(urlparse(route.request.url).query).get('scope') == ['all']:
                    data = {'measuredAt': 2000000000000, 'totalBytes': 1000, 'home': {'stateBytes': 100, 'buckets': {}, 'biggest': None}, 'projects': [{'path': '/demo/alpha', 'kind': 'project', 'stateBytes': 900, 'buckets': {'events': 900}, 'biggest': None, 'conversations': 1, 'openConversations': 0, 'archives': [], 'errors': 0}], 'budget': {'enabled': False, 'limitBytes': 1000000, 'over': False}}
                else:
                    data = {'measuredAt': 2000000000000, 'workflows': [{'id': 'fixture-closed', 'name': 'Fixture conversation', 'open': False, 'busy': False, 'lastActive': 2000000000000, 'eventBytes': 900, 'artifactBytes': 0, 'handoffBytes': 0, 'checkpointBytes': 0, 'keep': {'readable': True, 'whole': False, 'items': 0}}], 'archives': []}
            elif path == '/api/explorer/plans':
                data = {'projects': [{'cwd': '/demo/alpha', 'name': 'Fixture project', 'plans': [{'id': 'fixture-plan', 'title': 'Fixture plan', 'createdAt': 2000000000000, 'updatedAt': 2000000000000, 'refCount': 0, 'attached': False, 'clusters': [], 'checkboxTotal': 1, 'checkboxDone': 0}]}]}
            elif path == '/api/plans/body':
                data = {'plan': {'id': 'fixture-plan', 'title': 'Fixture plan', 'body': '# Fixture plan\n\n- [ ] Fixture item', 'createdAt': 2000000000000, 'updatedAt': 2000000000000}}
            elif path == '/api/outputs':
                data = {'outputs': [{'id': 'a' * 32, 'name': 'architecture-review-fixture.md', 'title': 'Fixture report', 'path': '/demo/alpha/.arco/workflows/cov-wf/artifacts/architecture-review-fixture.md', 'originPath': '/demo/alpha/.arco/workflows/cov-wf/artifacts/architecture-review-fixture.md', 'category': 'documents', 'workflowId': 'cov-wf', 'cwd': '/demo/alpha', 'producer': 'Fixture', 'createdAt': 1793210000000, 'updatedAt': 1793210000000, 'size': 32, 'missing': False, 'source': 'artifact event'}]}
            elif path == '/api/architecture-review/candidates':
                data = {'plan': {'id': 'fixture-plan', 'title': 'Fixture plan'}, 'recommendation': 'c1', 'candidates': [{'id': 'c1', 'title': 'Fixture candidate', 'files': ['src/example.ts'], 'problem': 'Fixture problem.', 'proposal': 'Fixture change.', 'strength': 'Strong', 'benefits': {'locality': 'One place.', 'leverage': 'Shared.', 'tests': 'At the boundary.'}}]}
            elif path in ('/api/outputs/content', '/api/file-content'):
                data = {'type': 'text', 'content': '# Fixture report\n\nExample text.\n', 'size': 32}
            elif path == '/api/deepseek':
                data = {'managed': False, 'baseUrl': 'http://127.0.0.1:8150/v1', 'profiles': [{'id': 'exact', 'label': 'Exact', 'model': 'fixture', 'serviceState': 'active', 'loaded': True, 'capabilities': {'vision': False}}], 'live': None}
            elif path == '/api/notification-channels':
                data = {'desktop': {'finished': True, 'failed': False, 'waiting': False}, 'phone': {'finished': False, 'failed': False, 'waiting': False}, 'phoneText': False, 'clusterFinished': 'director', 'ntfy': {'server': 'https://example.invalid', 'topic': 'fixture', 'tokenSet': False}, 'ntfyFromEnvironment': False}
            elif path == '/api/skills':
                data = {'project': [{'scope': 'project', 'slug': 'fixture-skill', 'name': 'Fixture skill', 'description': 'Synthetic skill.'}], 'global': [], 'builtin': []}
            elif path == '/api/skills/share/preview':
                data = {'files': ['SKILL.md'], 'alreadyTrackable': False, 'publicRepository': False, 'lines': []}
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
            elif path == '/api/update-manager':
                data = {'mode': 'service', 'result': None, 'fail': False}
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
        try:
            await page.wait_for_function('() => s.getState().authStatus && s.getState().settings')
        except Exception as error:
            raise AssertionError(f'Fixture did not start: {errors}') from error
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
                    sig = (view, kind, item.get('component'), item.get('tag'), item.get('label'), item.get('key'))
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
            await page.evaluate('''async theme => {
              const {applyTheme}=await import('/src/themes/apply.ts');
              const {getTheme}=await import('/src/themes/registry.ts');
              applyTheme(getTheme(theme));
              s.setState(st => ({settings:{...st.settings,themeId:theme}}));
            }''', theme)
            await walk(page, probe, tap, click_all, missing_openers)
            await page.goto(URL + '?app=explorer')
            await page.evaluate('''async theme => {
              const {applyTheme}=await import('/src/themes/apply.ts');
              const {getTheme}=await import('/src/themes/registry.ts');
              applyTheme(getTheme(theme));
            }''', theme)
            for lens in ['ARTIFACTS', 'RECENTS', 'PLANS', 'STORAGE', 'TREE']:
                await page.locator('nav button').filter(has_text=lens).click()
                await probe('explorer:' + lens.lower())
                if lens == 'PLANS':
                    await page.get_by_role('button', name='Fixture project', exact=False).click()
                    await page.get_by_role('button', name='Fixture plan', exact=False).click()
                    await probe('explorer:plan-detail')
                if lens == 'STORAGE':
                    await page.get_by_text('STORAGE SETTINGS', exact=True).click()
                    await probe('explorer:storage-settings')
                    await page.locator('button[data-help="storage.project"]').first.click()
                    await probe('explorer:storage-project')
        finally:
            if REPORT:
                suffix = f"-{theme.replace(':', '-')}-{viewport['width']}x{viewport['height']}"
                target = Path(REPORT)
                target.with_name(target.stem + suffix + target.suffix).write_text(json.dumps({**inventory, 'counts': counts, 'errors': errors, 'missing': sorted(requested)}, indent=1))
        if missing_openers:
            print('openers not found: ' + ', '.join(missing_openers))
        required_openers = set(OPENERS) - set(OPTIONAL_OPENERS)
        assert not (required_openers & set(missing_openers)), f'Required dialogs not reached: {sorted(required_openers & set(missing_openers))}'
        print(f'{theme} {viewport}: controls checked per view: ' + ', '.join(f'{v}={n}' for v, n in counts.items()))
        problems = inventory['uncovered'] + inventory['unresolved']
        for item in problems[:400]:
            print('UNCOVERED' if 'tag' in item else 'UNRESOLVED', json.dumps(item))
        assert not errors, errors
        assert not writes, writes
        assert {'cluster:auto-pickup-armed', 'cluster:auto-pickup-dialog', 'cluster:auto-pickup-limits', 'cluster:auto-pickup-rule-limits'} <= set(counts), 'AUTO-PICKUP chip, dialog or limits not reached'
        assert not problems, f'{len(inventory["uncovered"])} uncovered controls, {len(inventory["unresolved"])} unresolved keys'
        await browser.close()
        print('PASS theme coverage: visible controls and text use the active theme; native affordances: ' + '; '.join(f'{name} ({reason})' for name, reason in NATIVE_AFFORDANCES))


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


CLUSTER_PANEL = ':is([data-help="cluster.right-panel-splitter"] + *, [data-testid="right-panel-slide-out"])'


async def walk_cluster_panel(page, probe, tap):
    """Open the cluster right-panel states a tab click leaves closed: inline
    editors, pickers, pending mail, a running review, the detached board and
    saved snapshots. Each step reports its view, and a missing control fails."""
    panel = CLUSTER_PANEL
    reached = []

    async def step(view, opener, closer=None, key=None):
        if not await page.locator(panel).count():
            await tap('[data-testid="layout-panel-strip"] button[title="Open MORE"]')
        if view == 'efficiency-note' and await page.locator(f'{panel} [data-testid="cluster-settings-toggle"][aria-expanded="false"]').count():
            await tap(f'{panel} [data-testid="cluster-settings-toggle"]')
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
        if not await page.locator(panel).count():
            await tap('[data-testid="layout-panel-strip"] button[title="Open MORE"]')
        await tap(f'{panel} [data-help="cluster.right-panel.group.{group}"]')
        narrow = page.locator(f'{panel} select[data-help^="cluster.right-panel.tab."]')
        if await narrow.count():
            value = {'cluster.right-panel.members': 'members', 'cluster.mailbox': 'mailbox', 'cluster.board-tab': 'board', 'cluster.plan-tab': 'plan'}.get(tab, tab.rsplit('.', 1)[-1])
            await narrow.select_option(value)
        else:
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
        await page.evaluate("s.setState({quotaState:{claude:{throttled:true,resetsAt:Date.now()+3600000}}})")
        await page.get_by_role('button', name='⚠ PROVIDER THROTTLING (1)').click()
        await probe('home:provider-throttling')
        await page.keyboard.press('Escape')
        await page.evaluate('s.setState({quotaState:{}})')
        await page.evaluate("s.setState({updateStatus:{current:'0.1.0',latest:'0.2.0',url:'https://example.invalid/release',enabled:true,updateAvailable:true}})")
        await page.get_by_test_id('header-version-box').click()
        await probe('home:version')
        await page.get_by_role('dialog', name='Confirm update').wait_for()
        await probe('home:confirm-update')
        await page.get_by_role('dialog', name='Confirm update').get_by_role('button', name='CANCEL').click()
        await page.get_by_test_id('header-version-box').click()
        await page.evaluate("s.setState({capabilities:{efforts:['low','medium','high'],models:[],cliVersion:'fixture',strataVersion:'0.1.0',xolotlRevision:'1111111111111111111111111111111111111111',latestVersions:{strata:'0.2.0',xolotl:'2222222222222222222222222222222222222222'}},ollamaLive:{version:'0.1.0'}})")
        for provider in ['XOLOTL', 'STRATA', 'OLLAMA']:
            version_button = page.locator('[data-providers-cluster] button').filter(has_text=provider).first
            if not await version_button.count():
                await page.get_by_test_id('provider-dot').first.click()
            await version_button.click()
            await page.get_by_role('dialog', name=provider + (' changes' if provider == 'XOLOTL' else ' releases')).wait_for()
            await probe('home:provider-releases:' + provider.lower())
            await page.keyboard.press('Escape')
        for selector, view in [('[data-add-location]', 'home:add-location'), ('[data-open-folder]', 'home:folder-browser')]:
            assert await tap(selector), f'{view} opener missing'
            await probe(view)
            await dismiss(page, selector)

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
        await page.evaluate('''async () => {
          const {handleServerMessage:receive}=await import('/src/ws/handleServerMessage.ts');
          s.getState().createJob('cov-question',{kind:'chat',name:'Fixture questions',primaryProvider:'codex',primaryModel:'fixture',primaryEffort:'low',codexTransport:'appserver',workingDirectory:'',skipPermissions:false});
          s.setState(st=>({activeJobId:'cov-question',jobs:{...st.jobs,'cov-question':{...st.jobs['cov-question'],snapshotReceived:true,busy:true}}}));
          receive({type:'operator_question',workflowId:'cov-question',question:{requestId:'fixture-question',provider:'codex',threadId:'thread',turnId:'turn',itemId:'item',createdAt:Date.now(),mode:'blocking',status:'pending',questions:[{id:'choice',header:'Choice',question:'Which option?',options:[{label:'First',description:'Fixture option.'}],allowOther:true,secret:false},{id:'private',header:'Private',question:'Fixture value?',allowOther:true,secret:true}]}},{wsRef:{current:null},scheduleReconnect:()=>{}});
        }''')
        await page.get_by_role('button', name='? 1 QUESTION', exact=True).click()
        await probe('workflow:pending-question')
        await page.keyboard.press('Escape')
        await page.evaluate("s.getState().setActiveJob('cov-wf')")
        await page.evaluate('''async () => {
          const {useTerminalStore:t}=await import('/src/stores/terminalStore.ts'); window.term=t;
          t.getState().setSessions('cov-wf',[{sessionId:'fixture-terminal',label:'Fixture shell',cwd:'/demo/alpha',createdAt:Date.now()}]);
          t.getState().openTerminal({workflowId:'cov-wf'});
        }''')
        await probe('workflow:terminal')
        await page.evaluate("term.setState({windows:[]})")
        await page.evaluate("async () => { const {useDraftStore:d}=await import('/src/stores/draftStore.ts'); d.getState().setDraft('cov-wf','Fixture draft'); }")
        assert await tap('button[data-help="composer.tidy"]'), 'TIDY opener missing'
        await probe('open:tidy')
        await tap('button:has-text("KEEP ORIGINAL")')
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
        if await page.locator('[data-testid="layout-panel-strip"] button[title="Open MORE"]').count():
            await tap('[data-testid="layout-panel-strip"] button[title="Open MORE"]')
            await probe('rightpanel:slideout')
        narrow_workflow = page.locator('select[data-help^="rightpanel.tab."]')
        if await narrow_workflow.count():
            choices = await narrow_workflow.locator('option').evaluate_all('(xs) => xs.map(x=>x.value)')
            for choice in choices:
                await narrow_workflow.select_option(choice)
                await probe('rightpanel:tab:' + choice)
                if choice == 'preview':
                    bounds = await page.get_by_text('unbound', exact=True).first.evaluate('''e => {
                      const r=e.getBoundingClientRect(), p=e.closest('[data-testid="right-panel-slide-out"]')?.getBoundingClientRect();
                      return {right:r.right,limit:p ? p.right : innerWidth};
                    }''')
                    assert bounds['right'] <= bounds['limit'] + 1, f'Preview status is clipped: {bounds}'
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
                    if tk == 'rightpanel.tab.preview':
                        bounds = await page.get_by_text('unbound', exact=True).first.evaluate('''e => {
                          const r=e.getBoundingClientRect(), p=e.closest('[data-testid="right-panel-slide-out"]')?.getBoundingClientRect();
                          return {right:r.right,limit:p ? p.right : innerWidth};
                        }''')
                        assert bounds['right'] <= bounds['limit'] + 1, f'Preview status is clipped: {bounds}'
        if not await page.locator('[data-help="rightpanel.outputs"]').count():
            if await page.locator('[data-testid="layout-panel-strip"] button[title="Open FILES"]').count() and not await page.get_by_test_id('right-panel-slide-out').count():
                await tap('[data-testid="layout-panel-strip"] button[title="Open FILES"]')
            await tap('[data-help="rightpanel.group.workspace"]')
            narrow = page.locator('select[data-help^="rightpanel.tab."]')
            if await narrow.count(): await narrow.select_option('files')
            else: await tap('[data-help="rightpanel.tab.files"]')
        await page.locator('[data-help="rightpanel.outputs"]').first.wait_for(timeout=5000)
        assert await tap('[data-help="rightpanel.outputs"]'), 'OUTPUTS opener missing'
        await page.get_by_role('button', name='Save a copy', exact=True).first.wait_for()
        await probe('rightpanel:outputs')
        await page.get_by_role('button', name='Open in editor', exact=True).first.click()
        await page.locator('.cm-content').first.wait_for()
        await probe('rightpanel:outputs:editor')
        await page.locator('[data-dialog-surface="viewer"]').get_by_role('button', name='×', exact=True).click()
        for button, dialog in [('Save a copy', 'Save a copy'), ('Move', 'Move output')]:
            assert await tap(f'button:text-is("{button}")'), f'{dialog} opener missing'
            await probe('rightpanel:outputs:' + dialog.lower())
            await page.get_by_role('dialog', name=dialog, exact=True).get_by_role('button', name='Cancel', exact=True).click()
        assert await tap('button[data-help="storage.move-project"]'), 'MOVE TO PROJECT opener missing'
        await probe('rightpanel:outputs:move-to-project')
        await page.get_by_role('dialog', name='Move artifact to project').get_by_role('button', name='CLOSE', exact=True).click()
        assert await tap('button[data-help="architecture-review.candidates"]'), 'Architecture candidates opener missing'
        await page.get_by_test_id('architecture-candidate').first.wait_for()
        await probe('rightpanel:outputs:architecture-review')
        await page.get_by_role('button', name='RECORD DECISION', exact=True).click()
        await probe('rightpanel:outputs:architecture-decision')
        await page.get_by_role('dialog', name='Architecture review candidates').get_by_role('button', name='Close', exact=True).click()

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
          s.getState().addMessage('cov-m1',{id:'cluster-fixture-message',role:'user',content:'Fixture message',isStreaming:false,timestamp:Date.now()});
          s.getState().setActiveCluster('cov-cluster');
        }''')
        await probe('cluster')
        await page.get_by_test_id('message-select').first.click()
        await page.get_by_test_id('message-selection-bar').get_by_role('button', name='FORWARD').click()
        await probe('cluster:forward')
        await page.get_by_role('dialog', name='Forward messages').get_by_role('button', name='CANCEL').click()
        assert await tap('[data-testid="composer-recipients"]'), 'Cluster recipients opener missing'
        await probe('cluster:recipients')
        await tap('[data-testid="recipients-done"]')
        assert await tap('[data-testid="cluster-nudge"]'), 'Cluster nudge opener missing'
        await probe('cluster:nudge')
        await page.keyboard.press('Escape')
        assert await tap('button[data-help="cluster.transcript-send"]'), 'Cluster transcript opener missing'
        await probe('cluster:transcript')
        await page.keyboard.press('Escape')
        assert await tap('[data-testid="composer-brief"]'), 'Cluster BRIEF opener missing'
        await probe('cluster:brief-menu')
        await page.keyboard.press('Escape')
        assert await tap('button[data-help="utility.catch-up"]'), 'CATCH ME UP opener missing'
        await probe('cluster:catch-me-up')
        await page.keyboard.press('Escape')
        if await page.locator('[data-testid="layout-panel-strip"] button[title="Open MORE"]').count():
            await tap('[data-testid="layout-panel-strip"] button[title="Open MORE"]')
            await probe('cluster:panel-slideout')
        narrow_cluster = page.locator('select[data-help^="cluster.right-panel.tab."]')
        if await narrow_cluster.count():
            choices = await narrow_cluster.locator('option').evaluate_all('(xs) => xs.map(x=>x.value)')
            for choice in choices:
                await narrow_cluster.select_option(choice)
                await probe('cluster:tab:' + choice)
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
        if not await page.locator(CLUSTER_PANEL).count():
            await tap('[data-testid="layout-panel-strip"] button[title="Open MORE"]')
        await tap(f'{CLUSTER_PANEL} [data-help="cluster.right-panel.group.workspace"]')
        narrow = page.locator(f'{CLUSTER_PANEL} select[data-help^="cluster.right-panel.tab."]')
        if await narrow.count():
            await narrow.select_option('members')
        else:
            await tap(f'{CLUSTER_PANEL} [data-help="cluster.right-panel.members"]')
        if await page.locator(f'{CLUSTER_PANEL} [data-testid="cluster-settings-toggle"][aria-expanded="false"]').count():
            await tap(f'{CLUSTER_PANEL} [data-testid="cluster-settings-toggle"]')

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
        await page.evaluate('s.getState().setShowManual(true)')
        await probe('manual')
        await page.evaluate('s.getState().setShowManual(false)')
        await page.evaluate('s.getState().setHelpMode(true)')
        await probe('contextual-help')
        await tap('[data-help="header.arco-mark"]')
        await probe('contextual-help:card')
        await page.evaluate('s.getState().setHelpMode(false)')
        await page.evaluate('s.getState().setShowSettings(true)')
        await page.wait_for_timeout(300)
        await probe('settings')
        await click_all('[data-help^="settings.page."], [role=dialog] nav button', 'settings')
        await page.get_by_role('navigation', name='Settings categories').get_by_role('button', name='Projects', exact=False).first.click()
        await page.locator('details.saved-project-management > summary').click()
        await probe('settings:projects-bookmarks')
        overlap = await page.evaluate('''() => {
          const note=document.querySelector('[data-help="settings.first-run"] p');
          const summary=[...document.querySelectorAll('summary')].find(e=>e.textContent.includes('Other available folders'));
          if (!note || !summary || !summary.getClientRects().length) return null;
          const a=note.getBoundingClientRect(),b=summary.getBoundingClientRect();
          return {note:[a.top,a.bottom], summary:[b.top,b.bottom], overlaps:a.top<b.bottom && b.top<a.bottom};
        }''')
        assert overlap is not None and not overlap['overlaps'], f'Projects text overlaps: {overlap}'
        await page.get_by_role('navigation', name='Settings categories').get_by_role('button', name='Providers and models', exact=False).first.click()
        assert await tap('button[title="Open this tool\'s help"]'), 'Provider help opener missing'
        await probe('settings:provider-help')
        await page.evaluate('s.getState().setActiveHelpCard(null)')
        await page.get_by_role('navigation', name='Settings categories').get_by_role('button', name='Agents and clusters', exact=False).first.click()
        assert await tap('button[data-help="settings.skills.import"]'), 'Skill import opener missing'
        await probe('settings:skill-import')
        await page.keyboard.press('Escape')
        assert await tap('button[data-help="settings.skills.share"]'), 'Skill share opener missing'
        await probe('settings:skill-share')
        await page.keyboard.press('Escape')
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


async def run():
    for theme in ['matrix', 'phosphor:arco:electric']:
        for viewport in [{'width': 1366, 'height': 768}, {'width': 1920, 'height': 1080}]:
            await main(theme, viewport)

asyncio.run(run())
