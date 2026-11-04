"""Fixture-only release toast and Settings acceptance. No server or GitHub requests."""
import asyncio
import json
import os
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()

URL = f"http://127.0.0.1:{os.environ.get('ARCO_CLIENT_PORT', '5198')}/"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        context = await browser.new_context()
        settings = {'themeId': 'arch', 'enabledProviders': {'claude': True}, 'onboardingComplete': True, 'updateCheck': True}
        release = {'type': 'app_update_available', 'current': '0.1.0', 'latest': 'v0.2.0', 'url': 'https://github.com/ghreprimand/arco/releases/tag/v0.2.0', 'publishedAt': '2026-10-27T12:00:00Z'}
        status = {'current': '0.1.0', 'latest': None, 'url': None, 'publishedAt': None, 'checkedAt': None, 'updateAvailable': False, 'enabled': True}
        sockets, writes, errors = [], [], []
        manager = {'mode': 'service', 'result': None, 'fail': False}
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
            status_code = 200
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
                if route.request.method == 'POST':
                    writes.append({'update': route.request.post_data_json})
                    if manager['fail']:
                        status_code = 503
                        data = {'error':'Could not start a separate updater. Run npm run arco:update from a terminal.'}
                    else:
                        if manager.get('slow'):
                            await asyncio.sleep(2.5)
                        manager['result'] = {'outcome':'running','startedAt':1, 'attemptId':'fixture-attempt'}
                        data = {'ok':True, 'latest':release['latest'], 'attemptId':'fixture-attempt'}
                else: data = manager
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
            await route.fulfill(status=status_code, json=data)
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
        await notice.get_by_role('button', name='UPDATE AND RESTART').click()
        confirm = page.get_by_role('dialog', name='Confirm update')
        await expect(confirm).to_contain_text('v0.2.0')
        await expect(confirm).to_contain_text('Running turns will stop')
        await expect(confirm.get_by_role('link', name='Release notes')).to_have_attribute('href', release['url'])
        await confirm.get_by_role('button', name='CANCEL').click()
        assert not any('update' in entry for entry in writes)
        await page.evaluate("testStore.getState().setShowSettings(true);location.hash='settings/advanced/cli-versions'")
        service_row=page.locator('[data-help="settings.app-updates"]')
        await service_row.get_by_role('button', name='UPDATE AND RESTART').click()
        await expect(page.get_by_role('dialog', name='Confirm update')).to_contain_text('v0.2.0')
        await page.get_by_role('dialog', name='Confirm update').get_by_role('button', name='CANCEL').click()
        await page.evaluate('testStore.getState().setShowSettings(false)')
        manager['fail'] = True
        await notice.get_by_role('button', name='UPDATE AND RESTART').click()
        await confirm.get_by_role('button', name='UPDATE AND RESTART').click()
        await expect(notice).to_contain_text('Could not start a separate updater')
        await page.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async value=>{window.copiedUpdate=value}}})")
        await notice.get_by_role('button', name='COPY COMMAND').click()
        assert await page.evaluate('window.copiedUpdate') == 'npm run arco:update'
        manager['fail'] = False
        manager['result'] = {'outcome':'failed', 'message':'Previous fixture failure.', 'finishedAt':12344, 'attemptId':'old-attempt'}
        manager['slow'] = True
        await notice.get_by_role('button', name='UPDATE AND RESTART').click()
        await confirm.get_by_role('button', name='UPDATE AND RESTART').click()
        assert {'update': {'expectedLatest': 'v0.2.0'}} in writes
        await page.wait_for_timeout(2100)
        await expect(notice.locator('[data-help="settings.update-action"]')).not_to_contain_text('Previous fixture failure.')
        await page.wait_for_timeout(800)
        manager['slow'] = False
        manager['result'] = {'outcome':'updated', 'message':'Fixture update complete.', 'finishedAt':12345, 'attemptId':'fixture-attempt'}
        await expect(page.locator('[data-help="settings.update-result"]')).to_contain_text('Fixture update complete.', timeout=10000)
        await page.locator('[data-help="settings.update-result"]').get_by_role('button', name='DISMISS').click()
        await page.wait_for_timeout(6200)
        await expect(notice).to_be_visible()
        await notice.get_by_role('button', name='DISMISS', exact=True).click()
        await expect(notice).to_have_count(0)
        assert {'updateCheckDismissed': 'v0.2.0'} in writes
        manager['mode'] = 'foreground'
        manager['result'] = None
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
        await page.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async value=>{window.copiedUpdate=value}}})")
        await row.get_by_role('button', name='COPY COMMAND').click()
        assert await page.evaluate('window.copiedUpdate') == 'npm run arco:update'
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
        manager['mode'] = 'foreground'
        manager['packaged'] = True
        manager['platform'] = 'win32'
        manager['result'] = None
        await page.reload()
        await page.evaluate("async()=>{const {useAppStore:s}=await import('/src/stores/appStore.ts');s.getState().setShowSettings(true);location.hash='settings/advanced/cli-versions'}")
        row = page.locator('[data-help="settings.app-updates"]')
        await expect(row).to_contain_text('Stop Arco before updating, then run arco start.')
        await page.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async value=>{window.copiedUpdate=value}}})")
        await row.get_by_role('button', name='COPY COMMAND').click()
        assert await page.evaluate('window.copiedUpdate') == 'arco update'
        manager['packaged'] = False
        manager['mode'] = 'docker'
        manager['result'] = {'outcome':'failed', 'message':'Fixture update failed and rolled back.', 'finishedAt':67890}
        await page.reload()
        await page.wait_for_function("() => !!window.localStorage")
        await expect(page.locator('[data-help="settings.update-result"]')).to_contain_text('failed and rolled back', timeout=10000)
        # Once the server stops reporting a result, the previous message must
        # disappear rather than surviving as stale client state.
        manager['result'] = None
        await expect(page.locator('[data-help="settings.update-result"]')).to_have_count(0, timeout=10000)
        manager['result'] = {'outcome':'failed', 'message':'Fresh fixture failure.', 'finishedAt':67891}
        await expect(page.locator('[data-help="settings.update-result"]')).to_contain_text('Fresh fixture failure.', timeout=10000)
        await page.locator('[data-help="settings.update-result"]').get_by_role('button', name='DISMISS').click()
        await page.evaluate("async()=>{const {useAppStore:s}=await import('/src/stores/appStore.ts');s.getState().setShowSettings(true);location.hash='settings/advanced/cli-versions'}")
        row = page.locator('[data-help="settings.app-updates"]')
        await expect(row.get_by_role('button',name='COPY COMMAND')).to_be_visible()
        await page.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async value=>{window.copiedUpdate=value}}})")
        await row.get_by_role('button',name='COPY COMMAND').click()
        assert await page.evaluate('window.copiedUpdate') == 'git fetch --tags origin && git checkout --detach v0.3.0 && docker compose up -d --build'
        await row.get_by_role('button',name='COPY POWERSHELL COMMAND').click()
        assert await page.evaluate('window.copiedUpdate') == 'git fetch --tags origin; if ($LASTEXITCODE -eq 0) { git checkout --detach v0.3.0; if ($LASTEXITCODE -eq 0) { docker compose up -d --build } }'
        assert not errors, errors
        await browser.close()
        print('PASS: service confirmation, release-only update request, reconnect result and foreground copy in toast and Settings; no live network.')

asyncio.run(main())
