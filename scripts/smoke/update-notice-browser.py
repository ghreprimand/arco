"""Fixture-only release toast and Settings acceptance. No server or GitHub requests."""
import asyncio
import json
import os
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect

URL = f"http://127.0.0.1:{os.environ.get('ARCO_CLIENT_PORT', '5198')}/"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        context = await browser.new_context()
        settings = {'themeId': 'arch', 'enabledProviders': {'claude': True}, 'onboardingComplete': True, 'updateCheck': True}
        release = {'type': 'app_update_available', 'current': '0.1.0', 'latest': 'v0.2.0', 'url': 'https://github.com/ghreprimand/arco/releases/tag/v0.2.0', 'publishedAt': '2026-10-27T12:00:00Z'}
        status = {'current': '0.1.0', 'latest': None, 'url': None, 'publishedAt': None, 'checkedAt': None, 'updateAvailable': False, 'enabled': True}
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
            elif path == '/api/auth-status':
                data = {n: {'loggedIn': n == 'claude', 'installed': True, 'cliInstalled': True} for n in ['claude', 'codex',  'cursor', 'gemini', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'github']}
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
        await page.goto(URL)
        await page.evaluate("async()=>{window.testStore=(await import('/src/stores/appStore.ts')).useAppStore;window.updateStore=(await import('/src/stores/appUpdateStore.ts')).useAppUpdateStore}")
        await page.wait_for_function("() => !!window.testStore.getState().settings")
        await page.wait_for_function("() => !!window.updateStore.getState().status")
        assert sockets
        push_release()
        await page.wait_for_timeout(400)
        notice = page.get_by_test_id('app-update-notice')
        await expect(notice).to_contain_text('Arco v0.2.0 is available')
        link = notice.get_by_role('link', name='OPEN RELEASE')
        await expect(link).to_have_attribute('href', release['url'])
        await expect(link).to_have_attribute('target', '_blank')
        await page.wait_for_timeout(6200)
        await expect(notice).to_be_visible()
        await notice.get_by_role('button', name='DISMISS', exact=True).click()
        await expect(notice).to_have_count(0)
        assert {'updateCheckDismissed': 'v0.2.0'} in writes
        await page.reload()
        await page.evaluate("async()=>{window.testStore=(await import('/src/stores/appStore.ts')).useAppStore}")
        await page.wait_for_function("() => window.testStore.getState().settings?.updateCheckDismissed==='v0.2.0'")
        push_release()
        await page.wait_for_timeout(300)
        await expect(notice).to_have_count(0)
        release['latest'] = 'v0.3.0'; release['url'] = release['url'].replace('v0.2.0', 'v0.3.0')
        push_release()
        await expect(notice).to_contain_text('Arco v0.3.0 is available')
        await page.evaluate("async()=>{const {useAppStore:s}=await import('/src/stores/appStore.ts');s.getState().setShowSettings(true);location.hash='settings/advanced/cli-versions'}")
        row = page.locator('[data-help="settings.app-updates"]')
        await expect(row).to_contain_text('Arco: v0.1.0')
        await page.wait_for_timeout(800)
        assert not errors, errors
        await row.get_by_role('button', name='CHECK NOW').click()
        await expect(row).to_contain_text('Latest release: v0.3.0 (2026-10-27)')
        assert {'check': True} in writes
        await row.get_by_role('checkbox', name='Check for new releases').click()
        await expect(row.get_by_role('checkbox', name='Check for new releases')).not_to_be_checked()
        await expect(row.get_by_role('button', name='CHECK NOW')).to_be_disabled()
        await expect(notice).to_have_count(0)
        assert {'updateCheck': False} in writes
        await row.get_by_role('checkbox', name='Check for new releases').click()
        await expect(row.get_by_role('checkbox', name='Check for new releases')).to_be_checked()
        await expect(row.get_by_role('button', name='CHECK NOW')).to_be_enabled()
        await expect(row.get_by_role('link', name='Updating Arco')).to_have_attribute('href', 'https://github.com/ghreprimand/arco/blob/main/docs/OPERATIONS.md#updating-arco')
        assert not errors, errors
        await browser.close()
        print('PASS: update toast, release target, persistent dismissal, newer release, Settings check, opt-out and update instructions; no live network.')

asyncio.run(main())
