"""Fixture-only header version box acceptance. No server or GitHub requests."""
import asyncio
import json
import os
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from host_isolation import chrome_executable

URL = f"http://127.0.0.1:{os.environ.get('ARCO_CLIENT_PORT', '5198')}/"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        context = await browser.new_context()
        settings = {'themeId': 'arch', 'enabledProviders': {'claude': True}, 'onboardingComplete': True, 'updateCheck': True}
        release = {'type': 'app_update_available', 'current': '0.1.1', 'latest': 'v0.1.2', 'url': 'https://github.com/ghreprimand/arco/releases/tag/v0.1.2', 'publishedAt': '2026-10-27T12:00:00Z'}
        status = {'current': '0.1.1', 'latest': None, 'url': None, 'publishedAt': None, 'checkedAt': '2026-11-02T12:00:00Z', 'updateAvailable': False, 'enabled': True}
        sockets, writes, errors = [], [], []
        def push_release():
            status.update({k: v for k, v in release.items() if k != 'type'})
            status['updateAvailable'] = True
            for ws in sockets:
                try:
                    ws.send(json.dumps(release))
                except Exception:
                    pass
        async def api(route):
            path = urlparse(route.request.url).path
            data = {'files': [], 'entries': [], 'workflows': [], 'projects': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'tasks': [], 'sessions': [], 'messages': [], 'chats': []}
            if path == '/api/settings':
                if route.request.method == 'POST':
                    patch = route.request.post_data_json
                    writes.append(patch)
                    settings.update(patch)
                data = settings
            elif path == '/api/update-check':
                if route.request.method == 'POST':
                    writes.append({'check': True})
                    status.update({k: v for k, v in release.items() if k != 'type'})
                    status['updateAvailable'] = True
                status['enabled'] = settings['updateCheck']
                data = status
            elif path == '/api/update-manager':
                if route.request.method == 'POST': writes.append({'update': route.request.post_data_json})
                else: data = {'mode': 'service', 'platform': 'win32', 'packaged': True, 'result': None}
            elif path == '/api/auth-status':
                data = {n: {'loggedIn': n == 'claude', 'installed': True, 'cliInstalled': True} for n in ['claude', 'codex',  'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'github']}
            elif path == '/api/capabilities': data = {'efforts': ['low', 'medium', 'high'], 'models': ['claude-opus-4-6'], 'cliVersion': 'fixture'}
            elif path == '/api/skills': data = {'project': [], 'global': []}
            elif path == '/api/handoff-prompts':
                modes = ['original-worker', 'fresh-summarizer', 'ollama-compaction']
                data = {'defaults': {m: 'Fixture prompt' for m in modes}, 'project': {m: None for m in modes}, 'global': {m: None for m in modes}, 'effective': {m: {'source': 'default', 'sourcePath': None} for m in modes}}
            elif path == '/api/deepseek': data = {'managed': False, 'profiles': [], 'live': None}
            elif path.endswith('/catalog'): data = {'models': []}
            elif path == '/api/usage': data = {'available': False}
            await route.fulfill(json=data)
        await context.route('**/api/**', api)
        await context.route('**/healthz', lambda r: r.fulfill(json={'status': 'live'}))
        await context.route('https://**/*', lambda r: r.abort())
        def socket(ws):
            sockets.append(ws)
            ws.on_message(lambda raw: ws.send(json.dumps({'type': 'pong'})) if json.loads(raw).get('type') == 'ping' else None)
            ws.send(json.dumps({'type': 'connected', 'sessionId': 'release-fixture'}))
        await context.route_web_socket('**/ws', socket)
        page = await context.new_page()
        page.on('pageerror', lambda e: errors.append(e.stack))
        await page.set_viewport_size({'width': 1280, 'height': 800})
        await page.goto(URL)
        await page.evaluate("async()=>{window.testStore=(await import('/src/stores/appStore.ts')).useAppStore;window.updateStore=(await import('/src/stores/appUpdateStore.ts')).useAppUpdateStore}")
        await page.wait_for_function("() => !!window.testStore.getState().settings")
        await page.wait_for_function("() => !!window.updateStore.getState().status")
        box = page.get_by_test_id('header-version-box')
        power = page.locator('[data-help="header.power"]')
        shots = os.environ.get('ARCO_SHOT_DIR')
        async def shot(name):
            if shots: await page.screenshot(path=os.path.join(shots, name), clip={'x': 0, 'y': 0, 'width': 1280, 'height': 120})
        # Up to date: muted box with the running version, left of the power button.
        await expect(box).to_have_text('v0.1.1')
        await expect(box).to_have_attribute('data-state', 'current')
        assert 'Up to date' in (await box.get_attribute('title')), await box.get_attribute('title')
        assert 'Last checked' in (await box.get_attribute('title'))
        pb, bb = await power.bounding_box(), await box.bounding_box()
        assert bb['x'] + bb['width'] <= pb['x'] + 1 and abs(bb['y'] - pb['y']) < 12, (pb, bb)
        await expect(box).to_have_attribute('aria-label', 'Arco version v0.1.1. Up to date. Open version details.')
        # The help toggle sits in the top bar before SETTINGS and the version box, and overlaps no header control.
        help_btn = page.locator('header button[data-help="header.help"]')
        await expect(help_btn).to_be_visible()
        hb = await help_btn.bounding_box()
        assert hb['x'] + hb['width'] <= bb['x'] + 1 and hb['y'] < 120, (bb, hb)
        
        for width in (1280, 900):
            await page.set_viewport_size({'width': width, 'height': 800})
            # No two visible header buttons intersect.
            hit = await page.evaluate("""() => {
              const r = [...document.querySelectorAll('header button')].filter(e => e.getClientRects().length).map(e => ({t: e.textContent.trim().slice(0, 20), r: e.getBoundingClientRect()}));
              const out = [];
              for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) { const a = r[i].r, b = r[j].r; if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) out.push([r[i].t, r[j].t]); }
              return out;
            }""")
            assert hit == [], (width, hit)
        await page.set_viewport_size({'width': 1280, 'height': 800})
        await box.focus(); await shot('version-box-current.png')
        await box.click()
        pop = page.get_by_test_id('header-version-popover')
        await expect(pop).to_contain_text('Running: v0.1.1')
        await expect(pop).to_contain_text('Last checked')
        await expect(pop.get_by_role('button', name='CHECK NOW')).to_be_visible()
        await expect(pop.get_by_role('link', name='Release notes')).to_have_attribute('target', '_blank')
        await pop.get_by_role('button', name='CLI and runtime versions in Settings').click()
        await expect(page.locator('[data-help="settings.app-updates"]')).to_be_visible()
        await page.keyboard.press('Escape')
        await page.evaluate("()=>window.testStore.getState().setShowSettings(false)")
        # Update available: accent box with arrow, version and dot.
        push_release()
        await expect(box).to_have_text('\u2191 v0.1.2')
        await expect(box).to_have_attribute('data-state', 'available')
        await expect(page.get_by_test_id('header-version-dot')).to_be_visible()
        await expect(box).to_have_attribute('title', 'Update available: v0.1.2. Click to update.')
        notice = page.get_by_test_id('app-update-notice')
        await expect(notice).to_contain_text('stays available from the version box')
        await shot('version-box-available.png')
        # Still visible after DISMISS.
        await notice.get_by_role('button', name='DISMISS', exact=True).click()
        await expect(notice).to_have_count(0)
        await expect(box).to_have_text('\u2191 v0.1.2')
        await page.reload()
        await page.evaluate("async()=>{window.testStore=(await import('/src/stores/appStore.ts')).useAppStore;window.updateStore=(await import('/src/stores/appUpdateStore.ts')).useAppUpdateStore}")
        await expect(box).to_have_text('\u2191 v0.1.2')
        # Click opens the Confirm update dialog through UpdateAction.
        await box.click()
        dialog = page.get_by_role('dialog', name='Confirm update')
        await expect(dialog).to_contain_text('Update to v0.1.2 and restart Arco?')
        await dialog.get_by_role('button', name='CANCEL').click()
        await expect(dialog).to_have_count(0)
        # A newly mounted UpdateAction must not clear an update in progress.
        await page.evaluate("()=>window.updateStore.getState().setUpdating(true)")
        await expect(box).to_have_text('UPDATING')
        await page.evaluate("()=>window.testStore.getState().setShowSettings(true)")
        await page.wait_for_timeout(600)
        await expect(box).to_have_text('UPDATING')
        await page.evaluate("()=>{window.testStore.getState().setShowSettings(false);window.updateStore.getState().setUpdating(false)}")
        # Checks off: muted version only.
        await page.evaluate("async()=>{const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({updateCheck:false})});window.testStore.getState().setSettings(await r.json());await window.updateStore.getState().refresh()}")
        await page.keyboard.press('Escape')
        await expect(box).to_have_text('v0.1.1')
        await expect(box).to_have_attribute('data-state', 'off')
        assert 'checks are off' in (await box.get_attribute('title')).lower()
        assert not errors, errors
        await browser.close()
        print('PASS: version box up to date, update available, persistent after dismissal, confirm dialog, popover and checks off; no live network.')

asyncio.run(main())
