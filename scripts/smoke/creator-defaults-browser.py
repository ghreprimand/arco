"""Creator effort cap and tuning defaults on the real creator; synthetic APIs, no provider calls."""
import asyncio
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect

PORT = os.environ.get('ARCO_CLIENT_PORT', '5208')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><body><div id="fixture" style="width:900px"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>'''


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1300, 'height': 1000})
        errors, blocked, saved = [], [], []

        async def isolate(route):
            u = urlparse(route.request.url)
            if u.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(content_type='text/css', body=''); return
            if u.scheme == 'http' and u.netloc == '127.0.0.1:' + PORT:
                if u.path == '/fixture':
                    await route.fulfill(content_type='text/html', body=HTML); return
                if u.path.startswith('/api/'):
                    if route.request.method != 'GET':
                        assert u.path == '/api/settings', u.path
                        saved.append(route.request.post_data_json)
                        await route.fulfill(json={'enabledProviders': {'claude': True}, **route.request.post_data_json}); return
                    await route.fulfill(json={'items': [], 'projects': [], 'roots': [], 'sessions': [], 'presets': [], 'templates': [], 'skills': [], 'models': [], 'clusters': []}); return
                path = unquote(u.path)
                local = path.startswith('/@fs/') and Path(path[4:]).resolve().is_relative_to(ROOT)
                if local or path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/')):
                    await route.continue_(); return
            blocked.append(route.request.url); await route.abort()

        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady')
        await page.evaluate('''async () => {
          await import('/src/styles/global.css');
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {WorkflowCreator}=await import('/src/components/WorkflowCreator/index.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts');
          window.s=s; window.created=[];
          const root=createRoot(document.getElementById('fixture')); let gen=0;
          window.show=(defaults)=>{
            s.setState({connected:true,creatorPrefill:{mode:'cluster',workDir:'/projects/fixture'},
              settings:{enabledProviders:{claude:true},...(defaults?{workflowDefaults:defaults}:{}),projectRoots:[]},
              authStatus:{claude:{loggedIn:true,native:{credentialPresent:true}}}});
            root.render(React.createElement(WorkflowCreator,{key:++gen,onCreate:()=>{},onCreateCluster:p=>created.push(p)}));
          };
          show();
        }''')
        effort = page.locator('[data-help="creator.effort"]')
        defaults = page.locator('button[aria-controls="creator-member-defaults"]')

        async def open_defaults():
            # Cluster mode keeps the new-member defaults collapsed, with a note
            # that existing members do not change.
            await expect(defaults).to_have_attribute('aria-expanded', 'false')
            await expect(page.get_by_text('Existing members do not change', exact=False)).to_be_visible()
            await expect(effort).to_have_count(0)
            await defaults.click()

        await open_defaults()
        await expect(effort.get_by_role('button', name='HIGH', exact=True)).to_be_visible()

        async def pressed(label):
            return await effort.get_by_role('button', name=label, exact=True).evaluate("e => e.style.border.includes('accent-primary)')")

        # Fresh home: HIGH, conservative filter, lite output; members seeded at HIGH.
        assert await pressed('HIGH') and not await pressed('MAX')
        await page.get_by_role('button', name='CREATE CLUSTER', exact=True).click()
        await page.wait_for_function('created.length===1')
        members = await page.evaluate('created[0].members')
        assert all(m['effort'] == 'high' for m in members), members
        assert all(m.get('efficiencyToolFilter') == 'conservative' and m.get('outputStyle') == 'lite' for m in members), members

        # Explicit MAX, then a model switch: back to HIGH with a visible note.
        await effort.get_by_role('button', name='MAX', exact=True).click()
        assert await pressed('MAX')
        model = page.locator('[data-help="creator.model"] select')
        options = await model.evaluate('e => [...e.options].map(o => o.value)')
        current = await model.input_value()
        await model.select_option(next(o for o in options if o != current and 'opus' in o))
        await expect(effort.get_by_role('status')).to_have_text('Effort reset to HIGH after the model changed. Choose XHIGH or MAX again if needed.')
        assert await pressed('HIGH') and not await pressed('MAX')

        # Explicit MAX is saved as HIGH, with a note.
        await effort.get_by_role('button', name='MAX', exact=True).click()
        await page.get_by_role('button', name='SAVE AS DEFAULTS', exact=True).click()
        await expect(effort.get_by_role('status')).to_have_text('Defaults store at most HIGH; saved effort as HIGH.')
        assert saved and saved[-1]['workflowDefaults']['primaryEffort'] == 'high', saved

        # Saved MAX default loads as HIGH; saved off/normal tuning is kept.
        await page.evaluate("show({primaryProvider:'claude',primaryModel:'opus',primaryEffort:'max',efficiencyToolFilter:'off',outputStyle:'normal'})")
        await open_defaults()
        await expect(effort.get_by_role('button', name='HIGH', exact=True)).to_be_visible()
        assert await pressed('HIGH') and not await pressed('MAX')
        await page.get_by_role('button', name='CREATE CLUSTER', exact=True).click()
        await page.wait_for_function('created.length===2')
        members = await page.evaluate('created[1].members')
        assert all(m['effort'] == 'high' and 'efficiencyToolFilter' not in m and 'outputStyle' not in m for m in members), members

        assert not blocked, blocked
        assert not errors, errors
        await browser.close()
        print('PASS creator defaults: fresh HIGH/conservative/lite, explicit MAX reset with note, saved MAX loads and saves as HIGH, saved off/normal kept')

asyncio.run(main())
