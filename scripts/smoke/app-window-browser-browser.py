"""App window browser: the one-time notice in a non-Chromium browser and the Settings choice (synthetic APIs)."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from fs_url import fs_path

PORT = os.environ.get('ARCO_CLIENT_PORT', '5252')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = """<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"></head><body><div id="fixture"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>"""
FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0'
# Make a Chromium page look like Firefox: no client hints, a Firefox user agent.
AS_FIREFOX = "Object.defineProperty(Navigator.prototype,'userAgentData',{get:()=>undefined,configurable:true}); Object.defineProperty(Navigator.prototype,'userAgent',{get:()=>%s,configurable:true});" % json.dumps(FIREFOX_UA)
MOUNT = """async () => {
  const React=(await import('/node_modules/.vite/deps/react.js')).default;
  const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
  const {BrowserNotice}=await import('/src/components/BrowserNotice.tsx');
  const {AppWindowBrowserSection}=await import('/src/components/settings/AppWindowBrowserSection.tsx');
  const {useAppStore}=await import('/src/stores/appStore.ts');
  const {useStartupStore}=await import('/src/stores/startupStore.ts');
  window.fixtureState=()=>({settingsOpen:useAppStore.getState().showSettings, section:useStartupStore.getState().settingsSection});
  const h=React.createElement;
  createRoot(document.getElementById('fixture')).render(h('div',null,h(BrowserNotice),h(AppWindowBrowserSection)));
}"""


async def fixture_page(browser, state, init=None):
    context = await browser.new_context(viewport={'width': 1280, 'height': 800})
    if init:
        await context.add_init_script(init)
    page = await context.new_page()

    async def isolate(route):
        url = urlparse(route.request.url)
        if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
            if url.path == '/fixture':
                await route.fulfill(content_type='text/html', body=HTML); return
            if url.path == '/api/app-browsers':
                choice = state['choice']
                found = [b for b in state['browsers'] if b['id'] == choice] if choice else state['browsers'][:1]
                other = choice and not found and choice.startswith('/opt/')
                using = found[0] if found else ({'id': 'path', 'name': 'chrome', 'path': choice} if other else (state['browsers'][0] if state['browsers'] else None))
                await route.fulfill(json={'platform': 'linux', 'choice': choice, 'browsers': state['browsers'], 'using': using, 'missing': bool(choice) and not found and not other, 'unsupported': choice == 'firefox'}); return
            if url.path == '/api/settings' and route.request.method == 'POST':
                body = json.loads(route.request.post_data or '{}')
                state['posts'].append(body)
                value = body.get('appWindowBrowser', '').strip()
                state['choice'] = None if value.lower() in ('', 'automatic') else value
                await route.fulfill(json={'enabledProviders': {}, **({'appWindowBrowser': state['choice']} if state['choice'] else {})}); return
            local = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
            if route.request.method == 'GET' and (local or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/'))):
                await route.continue_(); return
        await route.abort()

    await page.route('**/*', isolate)

    async def load():
        await page.goto(ORIGIN + '/fixture'); await page.wait_for_function('window.fixtureReady === true')
        await page.evaluate(MOUNT)
    await load()
    return context, page, load


async def notice_checks(browser, init, label):
    state = {'choice': None, 'browsers': [], 'posts': []}
    context, page, load = await fixture_page(browser, state, init)
    notice = page.locator('[data-browser-notice]')
    await expect(notice).to_be_visible()
    await expect(notice).to_contain_text('Arco runs lighter in Chrome, Edge, Brave, Vivaldi or Chromium.')
    await expect(page.get_by_role('status').filter(has_text='No Chromium browser found')).to_be_visible()
    await notice.get_by_role('button', name='CHOOSE BROWSER').click()
    assert await page.evaluate('window.fixtureState()') == {'settingsOpen': True, 'section': 'app-window-browser'}, label
    await expect(notice).to_be_visible()
    await notice.get_by_role('button', name='DISMISS').click()
    await expect(notice).to_have_count(0)
    await load()
    await expect(page.get_by_text('APP WINDOW BROWSER')).to_be_visible()
    await expect(notice).to_have_count(0)
    await context.close()
    print(f'PASS notice in {label}: shown, CHOOSE BROWSER opens the setting, DISMISS remembered after reload')


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        # A Chromium-family page shows no notice; the Settings choice saves and reports.
        state = {'choice': None, 'browsers': [{'id': 'chromium', 'name': 'Chromium', 'path': '/usr/bin/chromium'}, {'id': 'vivaldi-flatpak', 'name': 'Vivaldi (Flatpak)', 'path': '/var/lib/flatpak/exports/bin/com.vivaldi.Vivaldi'}], 'posts': []}
        context, page, load = await fixture_page(browser, state)
        await expect(page.get_by_text('APP WINDOW BROWSER')).to_be_visible()
        assert await page.locator('[data-browser-notice]').count() == 0
        status = page.get_by_role('status').filter(has_text='Opens in')
        await expect(status).to_contain_text('Chromium (/usr/bin/chromium)')
        select = page.get_by_label('App window browser', exact=True)
        await expect(select).to_have_value('')
        await select.select_option('vivaldi-flatpak')
        await expect(status).to_contain_text('Vivaldi (Flatpak)')
        assert state['posts'][-1] == {'appWindowBrowser': 'vivaldi-flatpak'}, state['posts']
        await select.select_option('__other__')
        path = page.get_by_label('Browser program name or path')
        save = page.get_by_role('button', name='SAVE')
        await expect(save).to_be_disabled()
        await path.fill('/opt/thorium/chrome')
        await save.click()
        await expect(status).to_contain_text('/opt/thorium/chrome')
        assert state['posts'][-1] == {'appWindowBrowser': '/opt/thorium/chrome'}
        await load()
        await expect(page.get_by_label('App window browser', exact=True)).to_have_value('__other__')
        await expect(page.get_by_label('Browser program name or path')).to_have_value('/opt/thorium/chrome')
        # A saved choice that is no longer installed: Automatic is used and the page says so.
        state['choice'] = 'edge'
        await load()
        await expect(page.get_by_role('alert')).to_contain_text('The chosen browser "edge" was not found, so Automatic is used.')
        await expect(page.get_by_role('status').filter(has_text='Opens in')).to_contain_text('Chromium')
        state['choice'] = 'firefox'
        await load()
        await expect(page.get_by_role('alert')).to_contain_text('The chosen browser "firefox" has no app window (not a Chromium-family browser), so Automatic is used.')
        await page.get_by_label('App window browser', exact=True).select_option('')
        assert state['posts'][-1] == {'appWindowBrowser': ''}
        await expect(page.get_by_role('alert')).to_have_count(0)
        await context.close()
        print('PASS Settings > App window browser: detected list, saved choice, another program, missing choice falls back')
        await notice_checks(browser, AS_FIREFOX, 'Chromium posing as Firefox')
        await browser.close()
        # Real Firefox when Playwright has it installed (hosted CI installs Chromium only).
        try:
            firefox = await p.firefox.launch()
        except Exception as error:  # noqa: BLE001
            print(f'SKIP real Firefox: {str(error).splitlines()[0]}')
        else:
            await notice_checks(firefox, None, 'Firefox')
            await firefox.close()


asyncio.run(main())
