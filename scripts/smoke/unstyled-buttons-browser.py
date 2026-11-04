"""Fail when visible buttons keep the browser-default ButtonFace look.

Covers Home, a workflow composer (TIDY), Catch me up, BRIEF, the version box
popover and the Utility agent settings picker. Synthetic stores only.
"""
import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults
from fs_url import fs_path

install_navigation_defaults()

PORT = os.environ.get('ARCO_CLIENT_PORT', '5228')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"></head><body><div id="fixture" style="padding:16px;background:var(--color-bg-panel);min-height:100vh"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>'''

PROBE = r'''() => {
  const theme = getComputedStyle(document.documentElement).getPropertyValue('--font-display').trim();
  const themeToken = (theme.split(',')[0] || '').replace(/["']/g, '').trim().toLowerCase();
  const sample = document.createElement('button');
  sample.setAttribute('data-probe', '1');
  sample.textContent = 'probe';
  // Measure an unstyled control outside the document so theme CSS still applies
  // via the document stylesheet, then compare live buttons against ButtonFace.
  document.body.append(sample);
  const face = getComputedStyle(sample).backgroundColor;
  sample.remove();
  return [...document.querySelectorAll('button')].filter((b) => b.offsetParent && !b.hasAttribute('data-probe')).map((b) => {
    const st = getComputedStyle(b);
    const family = st.fontFamily.toLowerCase();
    const hasThemeFont = themeToken ? family.includes(themeToken) : family.includes('var(--font-display)') === false && family.length > 0;
    const looksFace = st.backgroundColor === 'rgb(239, 239, 239)' || st.backgroundColor.toLowerCase() === 'buttonface';
    return { text: (b.textContent || '').trim().slice(0, 40), bg: st.backgroundColor, family: st.fontFamily, border: st.borderTopColor, looksFace, hasThemeFont };
  }).filter((row) => row.looksFace || !row.hasThemeFont);
}'''


async def main():
    assert PORT != '3001'
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1100, 'height': 900})
        errors, blocked = [], []

        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                if url.path == '/fixture':
                    await route.fulfill(content_type='text/html', body=HTML); return
                if url.path == '/api/utility-agent/providers':
                    await route.fulfill(json={'providers': [{'provider': 'ollama', 'available': True}]}); return
                if url.path == '/api/settings' and route.request.method == 'POST':
                    await route.fulfill(json={'utilityAgent': {'provider': 'ollama', 'model': 'tiny'}, 'enabledProviders': {'ollama': True}}); return
                if url.path.startswith('/api/'):
                    await route.fulfill(json={}); return
                local = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if route.request.method == 'GET' and (local or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/', '/themes/'))):
                    await route.continue_(); return
            blocked.append(url.path); await route.abort()

        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true')
        await page.evaluate('''async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {CatchMeUp} = await import('/src/components/CatchMeUp.tsx');
          const {TidyComposer} = await import('/src/components/TidyComposer.tsx');
          const {BriefControl} = await import('/src/components/BriefControl.tsx');
          const {UtilityAgentPicker} = await import('/src/components/UtilityAgentPicker.tsx');
          const {HeaderVersionBox} = await import('/src/components/HeaderVersionBox.tsx');
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          const {useDraftStore:d} = await import('/src/stores/draftStore.ts');
          s.getState().createJob('fixture', { name: 'Fixture', workingDirectory: '/projects/fixture', primaryProvider: 'ollama', primaryModel: 'tiny', primaryEffort: 'low', skipPermissions: false });
          s.setState({
            connected: true, connectionState: 'online', activeJobId: 'fixture',
            settings: { enabledProviders: { ollama: true }, utilityAgent: { provider: 'ollama', model: 'tiny' }, onboardingComplete: true },
            authStatus: { ollama: { loggedIn: true } },
            updateStatus: { current: '0.1.2', latest: null, enabled: true, updateAvailable: false, checkedAt: Date.now() },
          });
          d.getState().setDraft('fixture', 'tidy this draft please');
          localStorage.setItem('arco.last-viewed.workflow.fixture', String(Date.now() - 60_000));
          const host = document.getElementById('fixture');
          createRoot(host).render(React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
            React.createElement(HeaderVersionBox, null),
            React.createElement(CatchMeUp, { scope: { kind: 'workflow', id: 'fixture' } }),
            React.createElement(TidyComposer, { jobId: 'fixture' }),
            React.createElement(BriefControl, { scope: 'worker', targetId: 'fixture', label: 'BRIEF', 'data-help': 'composer.brief', testId: 'brief', title: 'Brief' }),
            React.createElement(UtilityAgentPicker, null),
          ));
        }''')

        await page.get_by_role('button', name='CATCH ME UP').click()
        await expect(page.get_by_role('dialog', name='Catch me up')).to_be_visible()
        await page.get_by_role('button', name='CLOSE').click()
        await page.get_by_role('button', name='TIDY').click()
        await expect(page.get_by_role('dialog', name='Tidy draft')).to_be_visible()
        await page.get_by_role('button', name='KEEP ORIGINAL').click()
        await page.get_by_test_id('brief').click()
        await expect(page.get_by_test_id('brief-panel')).to_be_visible()
        await page.get_by_test_id('brief-close').click()
        await page.get_by_test_id('header-version-box').click()
        await expect(page.get_by_test_id('header-version-popover')).to_be_visible()
        await expect(page.get_by_text('UTILITY AGENT', exact=True)).to_be_visible()
        await expect(page.get_by_test_id('utility-save')).to_be_visible()

        bad = await page.evaluate(PROBE)
        assert not bad, bad
        assert not errors, errors
        await browser.close()
        print('unstyled-buttons-browser: pass')


if __name__ == '__main__':
    asyncio.run(main())
