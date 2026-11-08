#!/usr/bin/env python3
"""Window-size layout (Settings > Appearance > Layout) against the built client
and a temporary server, with a synthetic cluster served by a fixture API and
WebSocket. Automatic switches at 1500 and 2000 interface pixels; fixed
layouts apply at every width, the interface scale counts, the
choice survives a reload, the narrow rail and strip open their panels, the
composer tools that do not fit move into MORE, the cluster settings fold, and
splitter widths are kept per range. No provider or model calls."""
import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'scripts' / 'smoke'))
import host_isolation  # noqa: E402
from host_isolation import chrome_executable

host_isolation.enter_isolated_network()


def free_port():
    while True:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        if port != 3002:
            return port


def job(wid, name, text):
    return {'id': wid, 'currentSessionId': wid,
            'config': {'name': name, 'workingDirectory': '/projects/harbor', 'primaryProvider': 'claude', 'primaryModel': 'sonnet', 'primaryEffort': 'high'},
            'messages': [{'id': wid + '-user', 'role': 'user', 'content': 'Please coordinate the next release.', 'timestamp': 1793400000000, 'isStreaming': False},
                         {'id': wid + '-reply', 'role': 'assistant', 'content': text, 'timestamp': 1793400060000, 'isStreaming': False}],
            'workers': {}, 'reviews': [], 'research': [], 'handoffs': [], 'activity': [], 'sessionChat': [],
            'totalCost': 0, 'totalTokens': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheCreate': 0},
            'totalWorkers': 0, 'snapshotReceived': True}


NAMES = ['Director', 'Builder', 'Tester', 'Documenter', 'Reviewer']
REPLIES = ['The release plan is ready.\nBuilder and Tester have the next tasks.\nI will review their results.\nThen the release notes.',
           'The workspace changes are complete. The focused checks pass and the patch is ready for review.',
           'The browser checks cover the project list and the empty-state path. Both scenarios pass.',
           'The manual has been checked against the controls.',
           'The changes are ready for the final review.']


def fixture_state():
    jobs = {f'worker-{i}': job(f'worker-{i}', name, REPLIES[i]) for i, name in enumerate(NAMES)}
    members = [{'workflowId': f'worker-{i}', 'displayName': name, 'status': 'idle', 'role': name} for i, name in enumerate(NAMES)]
    cluster = {'clusterId': 'demo-cluster', 'name': 'Release readiness', 'cwd': '/projects/harbor', 'createdAt': '2026-10-31T12:00:00Z', 'members': members, 'mailboxDepth': {}, 'taskBoardMode': 'cluster', 'taskBoardAttached': True, 'taskBoardKey': 'demo', 'progressTracking': 'both', 'efficiencyLevel': 'balanced'}
    return {'state': {'jobs': jobs, 'clusters': {'demo-cluster': cluster}, 'activeClusterId': 'demo-cluster', 'activeJobId': None, 'showHome': False, 'showCreator': False, 'clusterCardLayout': 'rows', 'clusterFocusedMember': {'demo-cluster': 'worker-0'}}, 'version': 0}


def single_state():
    s = fixture_state()
    st = s['state']
    st.update({'activeClusterId': None, 'activeJobId': 'worker-1', 'clusters': {}})
    for k in ['worker-0', 'worker-2', 'worker-3', 'worker-4']:
        st['jobs'].pop(k)
    return s


def api_data(path, scale):
    roots = [{'name': 'Projects', 'path': '/projects', 'exists': True}]
    if path == '/api/settings':
        return {'uiScale': scale, 'projectRoots': roots, 'onboardingComplete': True, 'enabledProviders': {'claude': True, 'codex': False}, 'updateCheck': False}
    if path == '/api/auth-status':
        return {key: {'loggedIn': key == 'claude'} for key in ['claude', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'github']}
    if path == '/api/installation-history': return {'used': True}
    if path == '/api/projects': return {'roots': roots, 'projects': [], 'organization': True, 'homeFolder': '/projects'}
    if path == '/api/update-check': return {'current': '0.0.0', 'latest': None, 'url': None, 'publishedAt': None, 'checkedAt': None, 'enabled': False, 'updateAvailable': False}
    if path.endswith('/catalog'): return {'models': []}
    if path == '/api/capabilities': return {'efforts': ['low', 'medium', 'high'], 'models': ['sonnet'], 'cliVersion': 'fixture'}
    return {'files': [], 'workflows': [], 'projects': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'sessions': [], 'chats': [], 'tasks': [], 'profiles': []}


TASKS = [{'id': f'task-{i}', 'title': title, 'status': status, 'links': [], 'notes': '', 'priority': 50, 'parentIds': [], 'blockedReason': '', 'reviewRequired': False, 'goalMode': False, 'createdAt': 1793400000000, 'updatedAt': 1793400000000}
         for i, (title, status) in enumerate([('Review the release checklist', 'review'), ('Verify the project list', 'in_progress')], 1)]


async def open_page(browser, base, width, scale=1.0, layout=None, height=800, single=False, no_director=False):
    context = await browser.new_context(viewport={'width': width, 'height': height})
    snapshot = json.dumps({'type': 'task_ledger_snapshot', 'workflowId': 'worker-0', 'cwd': '/projects/harbor', 'boardKey': 'demo', 'tasks': TASKS})
    fixture = single_state() if single else fixture_state()
    if no_director: fixture['state']['clusters']['demo-cluster']['members'][0]['role'] = 'Builder'
    layout_line = f"localStorage.setItem('arco.layoutMode', {json.dumps(layout)});" if layout else ''
    await context.add_init_script(f"""if (!sessionStorage.getItem('fixture-seeded')) {{
        sessionStorage.setItem('fixture-seeded', '1');
        localStorage.setItem('arco-jobs', {json.dumps(json.dumps(fixture))}); localStorage.setItem('arco_ui_scale', '{scale}');
        localStorage.setItem('arco.clusterSidePanelTab.byCluster', JSON.stringify({{'demo-cluster':'board'}}));
        {layout_line}
      }}
      class FixtureSocket {{
        static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3;
        constructor() {{ this.readyState=0; setTimeout(()=>{{ this.readyState=1; this.onopen?.(new Event('open')); this.onmessage?.({{data:JSON.stringify({{type:'connected',sessionId:'demo'}})}}); setTimeout(()=>{{ for (let i=0;i<5;i++) this.onmessage?.({{data:JSON.stringify({{type:'workflow_state_snapshot',workflowId:'worker-'+i,workers:{{}},busy:false,transcriptTail:[]}})}}); this.onmessage?.({{data:{json.dumps(snapshot)}}}); }}, 250); }}, 20); }}
        send() {{}} close() {{this.readyState=3;}}
      }}
      window.WebSocket=FixtureSocket;""")

    async def route_request(route):
        u = urlparse(route.request.url)
        if u.netloc != urlparse(base).netloc:
            await route.abort(); return
        if u.path == '/api/settings' and route.request.method == 'GET':
            # The real temporary server answers; only the interface scale and
            # the first-run flag are set for the fixture.
            response = await route.fetch()
            data = await response.json()
            data.update({'uiScale': scale, 'onboardingComplete': True, 'updateCheck': False})
            await route.fulfill(response=response, json=data); return
        if u.path in ('/api/auth-status', '/api/capabilities') or u.path.endswith('/catalog'):
            await route.fulfill(json=api_data(u.path, scale)); return
        await route.continue_()
    await context.route('**/*', route_request)
    page = await context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    await page.goto(base, wait_until='domcontentloaded')
    if single:
        await page.get_by_text('The workspace changes are complete.', exact=False).first.wait_for(timeout=30000)
    else:
        await page.get_by_text('Release readiness', exact=False).first.wait_for(timeout=30000)
        await page.locator('[data-help="cluster.member-card"], [data-testid="member-rail"]').first.wait_for(timeout=30000)
    return context, page, errors


async def state(page):
    return await page.evaluate("""() => {
      // Widths in interface pixels: boxes inside the zoomed page are reported zoomed.
      const scale = parseFloat(document.documentElement.style.getPropertyValue('--ui-scale')) || 1;
      const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 ? Math.round(r.width / scale) : null; };
      const card = document.querySelector('[data-help="cluster.member-card"]');
      return {
        rail: !!document.querySelector('[data-testid="member-rail"]'),
        strip: !!document.querySelector('[data-testid="layout-panel-strip"]'),
        grid: box('[data-help="cluster.grid"]'),
        density: card ? card.getAttribute('data-density') : null,
        summary: !!document.querySelector('[data-testid="cluster-settings-summary"]'),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    }""")


async def expect_range(page, name, width):
    await page.set_viewport_size({'width': width, 'height': 800})
    want = {'narrow': (True, None), 'medium': (False, 'compact'), 'standard': (False, 'standard')}[name]
    await page.wait_for_function("([rail, density]) => !!document.querySelector('[data-testid=\"member-rail\"]') === rail && (density === null || document.querySelector('[data-help=\"cluster.member-card\"]')?.getAttribute('data-density') === density)", arg=list(want), timeout=10000)
    s = await state(page)
    assert s['overflowX'] <= 0, (name, width, s)
    if name == 'narrow':
        assert s['strip'] and s['grid'] is None, (width, s)
    elif name == 'medium':
        assert s['grid'] == 250 and s['summary'], (width, s)
    else:
        assert not s['summary'] and not s['strip'], (width, s)
    return s


async def palette(page, label):
    await page.keyboard.press('Control+p')
    box = page.get_by_placeholder('Search tabs, files, transcript, commands', exact=False)
    await box.fill(label)
    await page.get_by_text(label, exact=True).first.click()


async def run(base):
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=chrome_executable() or None)
        try:
            # Automatic (default) follows the agreed interface-width boundaries.
            context, page, errors = await open_page(browser, base, 1280)
            for width, name in [(1499, 'narrow'), (1500, 'medium'), (1999, 'medium'), (2000, 'standard'), (1920, 'medium')]:
                await expect_range(page, name, width)

            # Compact at a laptop width forces the optional tools into MORE.
            await palette(page, 'Layout: Compact')
            await page.set_viewport_size({'width': 1280, 'height': 800})
            toolbar = page.get_by_test_id('composer-toolbar')
            more = page.get_by_test_id('composer-more')
            await expect(more).to_be_visible()
            assert await toolbar.evaluate('e => e.scrollWidth <= e.clientWidth + 1'), 'composer toolbar overflows'
            for keep in ['composer.attach', 'composer.plan', 'composer.brief']:
                await expect(toolbar.locator(f':scope > [data-help="{keep}"]')).to_be_visible()
            await more.click()
            menu = page.get_by_test_id('composer-more-menu')
            await expect(menu).to_be_visible()
            items = await menu.locator('[data-overflow-item]').evaluate_all('els => els.map(e => e.getAttribute("data-overflow-item"))')
            assert items and not ({'composer.attach', 'composer.plan', 'composer.brief'} & set(items)), items
            hidden = await toolbar.locator(':scope > [data-overflowed="true"]').evaluate_all('els => els.map(e => e.getAttribute("data-help")).filter(h => h !== "layout.composer-more")')
            assert hidden == items, (hidden, items)
            await page.keyboard.press('Escape')
            await expect(menu).to_be_hidden()
            # B41 no longer reproduces: SKILLS is outside the overflowing toolbar.
            skills = page.locator('[data-help="composer.skills"]')
            assert await skills.evaluate('el => !el.closest("[data-overflowed=true]")')
            await skills.get_by_role('button', name='SKILLS', exact=False).click()
            await expect(skills.get_by_text('BUILT-IN', exact=True)).to_be_visible()
            await page.keyboard.press('Escape')
            # A wider window brings the tools back.
            await page.set_viewport_size({'width': 1999, 'height': 800})
            await page.wait_for_function("() => document.querySelectorAll('[data-testid=\"composer-toolbar\"] > [data-overflowed=\"true\"]').length < %d" % (len(items) + 1), timeout=10000)

            # A compact draft opens the public-project choice before sending.
            await page.set_viewport_size({'width': 1920, 'height': 800})
            hint = page.locator('[data-help="cluster.no-plan-hint"]')
            await hint.get_by_role('button', name='DRAFT A PLAN').click()
            await expect(page.get_by_test_id('cluster-public-project')).to_be_visible()
            await hint.get_by_role('button', name='LESS').click()
            # Cluster settings fold into one line; SETTINGS opens them.
            await page.set_viewport_size({'width': 1920, 'height': 800})
            summary = page.get_by_test_id('cluster-settings-summary')
            await expect(summary).to_contain_text('MAIL ALERTS OFF')
            await expect(page.locator('button[aria-label^="Mail alerts"]')).to_have_count(0)
            await page.get_by_test_id('cluster-settings-toggle').click()
            await expect(page.locator('button[aria-label^="Mail alerts"]')).to_be_visible()
            await page.get_by_test_id('cluster-settings-toggle').click()

            # Splitter widths are kept per range: a drag in medium saves only the medium key.
            splitter = page.locator('[data-help="cluster.right-panel-splitter"]')
            sb = await splitter.bounding_box()
            await page.mouse.move(sb['x'] + 2, sb['y'] + 200)
            await page.mouse.down()
            await page.mouse.move(sb['x'] - 120, sb['y'] + 200, steps=6)
            await page.mouse.up()
            keys = await page.evaluate("() => ({m: localStorage.getItem('arco.clusterRightPanelWidth.medium'), w: localStorage.getItem('arco.clusterRightPanelWidth.wide'), s: localStorage.getItem('arco.clusterRightPanelWidth')})")
            assert keys['m'] is not None and keys['w'] is None and keys['s'] is None, keys
            await palette(page, 'Layout: Automatic')
            await expect_range(page, 'standard', 2560)
            standard_right = await page.evaluate("() => Math.round(document.querySelector('[data-help=\"cluster.right-panel-splitter\"]').nextElementSibling.getBoundingClientRect().width)")
            assert 650 <= standard_right <= 760, standard_right  # the default share, not the medium drag

            # Narrow: the rail opens the member list; a card puts that member in view.
            await expect_range(page, 'narrow', 1024)
            await page.get_by_test_id('member-list-open').click()
            slide = page.get_by_test_id('member-list-slide-out')
            await expect(slide.locator('[data-help="cluster.member-card"]')).to_have_count(5)
            await slide.locator('[data-help="cluster.member-card"]').nth(1).click()
            await expect(slide).to_have_count(0)
            await expect(page.locator('[data-testid="member-rail"] button[aria-pressed="true"]')).to_have_attribute('aria-label', 'Builder', timeout=5000)
            # The strip opens the right panel at BOARD; Esc closes it.
            await page.get_by_test_id('layout-panel-strip').get_by_role('button', name='BOARD').click()
            right = page.get_by_test_id('right-panel-slide-out')
            await expect(right.get_by_text('Verify the project list').first).to_be_visible()
            older = right.get_by_text('1 older', exact=False).first
            if await older.is_visible():
                await older.click()
            await expect(right.get_by_text('Review the release checklist').first).to_be_visible()
            await page.keyboard.press('Escape')
            await expect(right).to_have_count(0)

            # Standard from the command palette: the original layout at every width, at once.
            await page.set_viewport_size({'width': 1280, 'height': 800})
            await palette(page, 'Layout: Standard')
            for width in (1024, 1280, 1920):
                await expect_range(page, 'standard', width)
            await expect(page.get_by_test_id('composer-more')).to_have_count(0)
            # Compact from Settings stays compact at every width.
            await palette(page, 'Open Settings')
            await page.get_by_test_id('layout-mode-compact').click()
            await expect(page.get_by_test_id('layout-mode-compact')).to_have_attribute('aria-checked', 'true')
            await page.keyboard.press('Escape')
            await expect_range(page, 'medium', 1920)
            await expect_range(page, 'medium', 1099)
            # A reload keeps the choice.
            await page.set_viewport_size({'width': 1920, 'height': 800})
            await page.reload(wait_until='domcontentloaded')
            await page.locator('[data-help="cluster.member-card"]').first.wait_for(timeout=30000)
            await expect_range(page, 'medium', 1920)
            assert await page.evaluate("() => localStorage.getItem('arco.layoutMode')") == 'compact'
            assert not errors, errors
            await context.close()

            # The interface scale counts at both thresholds.
            context, page, errors = await open_page(browser, base, 1920, scale=1.5)
            await page.wait_for_function("() => document.documentElement.style.getPropertyValue('--ui-scale').trim() === '1.5'", timeout=10000)
            for width, name in [(2249, 'narrow'), (2250, 'medium'), (2999, 'medium'), (3000, 'standard')]:
                await expect_range(page, name, width)
            assert not errors, errors
            await context.close()
            # The top-bar chip cycles and settings track the same saved choice.
            context, page, errors = await open_page(browser, base, 1920, no_director=True)
            chip = page.get_by_test_id('header-layout')
            await expect(chip).to_have_text('AUTO: COMPACT')
            await expect(page.get_by_test_id('plan-line-members')).to_be_visible()
            await expect(page.locator('[data-help="cluster.no-plan-hint"]')).to_contain_text('Set a director in')
            await page.get_by_label('Online', exact=True).first.wait_for(timeout=10000)
            art = os.environ.get('ARCO_LAYOUT_ARTIFACTS')
            if art: await page.screenshot(path=str(Path(art) / 'layout-no-director-1920.png'), animations='disabled')
            await page.get_by_test_id('plan-line-members').click()
            await expect(page.get_by_text('SAVED CLUSTERS', exact=True)).to_be_visible()
            await page.set_viewport_size({'width': 1280, 'height': 800})
            await page.get_by_test_id('member-list-open').click()
            await page.get_by_test_id('member-list-slide-out').get_by_test_id('plan-line-members').click()
            await expect(page.get_by_test_id('right-panel-slide-out').get_by_text('SAVED CLUSTERS', exact=True)).to_be_visible()
            await page.keyboard.press('Escape')
            await page.set_viewport_size({'width': 1920, 'height': 800})
            for label in ('STANDARD', 'COMPACT', 'NARROW', 'AUTO: COMPACT'):
                await chip.click()
                await expect(chip).to_have_text(label)
            await palette(page, 'Open Settings')
            await expect(page.get_by_test_id('layout-mode-auto')).to_have_attribute('aria-checked', 'true')
            await page.get_by_test_id('layout-mode-narrow').click()
            await expect(chip).to_have_text('NARROW')
            await page.keyboard.press('Escape')
            assert not errors, errors
            await context.close()
            # Inspect five-member layouts and the whole top bar at representative sizes.
            for width, height, scale in [(1280, 800, 1.0), (1280, 800, 1.5), (1366, 768, 1.0), (1920, 1080, 1.0), (1920, 1080, 1.2), (1920, 1080, 1.5), (2560, 1440, 1.0), (3840, 2160, 1.5), (1499, 800, 1.0), (1500, 800, 1.0), (1999, 800, 1.0), (2000, 800, 1.0)]:
                context, page, errors = await open_page(browser, base, width, scale=scale, height=height)
                chip = page.get_by_test_id('header-layout')
                await page.get_by_label('Online', exact=True).first.wait_for(timeout=10000)
                await expect(chip).to_be_visible()
                expected = 'NARROW' if width / scale < 1500 else 'COMPACT' if width / scale < 2000 else 'STANDARD'
                await expect(chip).to_have_text('AUTO' if width / scale < 1100 else 'AUTO: ' + expected)
                dimensions = await page.evaluate("""() => {
                  const word = document.querySelector('[data-help="header.arco-mark"]').getBoundingClientRect();
                  const chip = document.querySelector('[data-testid="header-layout"]').getBoundingClientRect();
                  const power = document.querySelector('[data-help="header.power"]').getBoundingClientRect();
                  return {wordY: word.y, chipY: chip.y, powerY: power.y, powerRight: power.right, width: innerWidth};
                }""")
                assert abs(dimensions['wordY'] - dimensions['powerY']) < 20, dimensions
                assert dimensions['powerRight'] <= dimensions['width'] + 1, dimensions
                art = os.environ.get('ARCO_LAYOUT_ARTIFACTS')
                if art: await page.screenshot(path=str(Path(art) / f'layout-{width}x{height}-{round(scale*100)}.png'), animations='disabled')
                assert not errors, errors
                await context.close()
            # A single tab under 1100 px: the right panel is a strip; FILES opens it over the chat.
            context, page, errors = await open_page(browser, base, 1024, single=True)
            strip = page.get_by_test_id('layout-panel-strip')
            await expect(strip.get_by_role('button')).to_have_text(['FILES', 'PLAN', 'MEMORY', 'MORE'])
            await strip.get_by_role('button', name='PLAN').click()
            right = page.get_by_test_id('right-panel-slide-out')
            await expect(right.locator('[data-help="rightpanel.tab.plan"]').first).to_be_visible()
            await right.get_by_role('button', name='CLOSE').click()
            await expect(right).to_have_count(0)
            await page.set_viewport_size({'width': 1500, 'height': 800})
            await expect(strip).to_have_count(0)
            assert not errors, errors
            await context.close()
            print('PASS: Automatic boundaries and scale, fixed modes, MORE, splitters and panels')
        finally:
            await browser.close()


def main():
    if not (ROOT / 'client' / 'dist' / 'index.html').exists():
        raise SystemExit('Run npm run build first.')
    with tempfile.TemporaryDirectory(prefix='arco-layout-') as tmp:
        root = Path(tmp)
        home = root / 'home'; home.mkdir()
        (root / 'projects' / 'harbor').mkdir(parents=True)
        port = free_port()
        env = host_isolation.harden({'HOME': str(home), 'ARCO_HOME': str(home / '.arco'), 'TMPDIR': str(root), 'ARCO_PORT': str(port), 'ARCO_HOST': '127.0.0.1'}, root)
        env['ARCO_SERVE_CLIENT'] = '1'
        proc = subprocess.Popen(['node', 'scripts/start.mjs'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            base = f'http://127.0.0.1:{port}'
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                if proc.poll() is not None: raise RuntimeError('Layout test server exited early.')
                try:
                    with urllib.request.urlopen(base + '/readyz', timeout=2) as response:
                        if response.status == 200: break
                except OSError: time.sleep(0.25)
            else: raise RuntimeError('Layout test server did not become ready.')
            asyncio.run(run(base))
        finally:
            try: os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: proc.wait(timeout=10)
            except subprocess.TimeoutExpired: os.killpg(proc.pid, signal.SIGKILL); proc.wait()


if __name__ == '__main__':
    main()
