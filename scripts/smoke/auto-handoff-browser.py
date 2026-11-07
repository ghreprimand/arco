"""CONFIG > AUTO-HANDOFF: hand off after N compactions, reasons where Arco cannot count, saved percent settings.

Synthetic stores and APIs only; no provider calls.
"""
import asyncio
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path
from host_isolation import chrome_executable

PORT = os.environ.get('ARCO_CLIENT_PORT', '5253')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
CWD = '/projects/fixture'
HTML = """<!doctype html><html><body><div id="config" style="width:420px;padding:12px"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};
window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;window.fixtureReady=true;</script></body></html>"""


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page(viewport={'width': 1280, 'height': 1600})
        errors, blocked = [], []

        async def isolate(route):
            u = urlparse(route.request.url)
            if u.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(content_type='text/css', body=''); return
            if u.scheme == 'http' and u.netloc == '127.0.0.1:' + PORT:
                if u.path == '/fixture':
                    await route.fulfill(content_type='text/html', body=HTML); return
                if u.path.startswith('/api/'):
                    assert route.request.method == 'GET', route.request.url
                    await route.fulfill(json={'items': [], 'projects': [], 'sessions': [], 'skills': [], 'models': [], 'entries': [], 'files': []}); return
                path = unquote(u.path)
                local = path.startswith('/@fs/') and fs_path(path).resolve().is_relative_to(ROOT)
                if local or path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/', '/themes/', '/fonts/')):
                    await route.continue_(); return
            blocked.append(route.request.url); await route.abort()

        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true')
        await page.evaluate(r"""async (cwd) => {
          await import('/src/styles/global.css');
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const h=React.createElement;
          const {ConfigTab}=await import('/src/components/RightPanel/ConfigTab.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts');
          window.s=s; window.updates=[];
          s.setState({connected:true,settings:{...s.getState().settings,enabledProviders:{claude:true,codex:true,cursor:true,ollama:true},claude:{transport:'native'},codex:{transport:'exec'}}});
          const root=createRoot(document.getElementById('config'));
          window.show=(id,config)=>{
            s.getState().createJob(id,{name:id,workingDirectory:cwd,primaryModel:'sonnet',primaryEffort:'medium',...config});
            const render=()=>root.render(h(ConfigTab,{key:id,job:s.getState().jobs[id],onUpdatePrimary:patch=>{updates.push(patch);
              s.setState(st=>({jobs:{...st.jobs,[id]:{...st.jobs[id],config:{...st.jobs[id].config,...patch}}}}));render();}}));
            render();
          };
        }""", CWD)

        box = page.get_by_label('Hand off automatically after compactions')
        count = page.get_by_label('Compactions before auto-handoff')
        line = page.locator('[data-auto-handoff-availability]')
        updates = lambda: page.evaluate('window.updates.filter(u => u.autoHandoff).map(u => u.autoHandoff)')

        # Claude Native with the provider default auto-compaction: off by default, 5, counts.
        await page.evaluate("show('native', {claudeTransport:'native'})")
        await expect(box).not_to_be_checked(); await expect(box).to_be_enabled()
        await expect(count).to_have_value('5')
        await expect(line).to_have_text('Counts Claude Native compactions (automatic and COMPACT).')
        await expect(page.get_by_text('WARN', exact=True)).to_have_count(0)
        await box.check()
        assert (await updates())[-1] == {'enabled': True, 'afterCompactions': 5, 'warnAt': 75, 'autoAt': 90}, await updates()
        await count.fill('3'); await count.press('Enter')
        assert (await updates())[-1] == {'enabled': True, 'afterCompactions': 3, 'warnAt': 75, 'autoAt': 90}, await updates()
        await count.fill('40'); await count.blur()
        await expect(count).to_have_value('20')
        assert (await updates())[-1]['afterCompactions'] == 20
        await page.screenshot(path='/tmp/arco-auto-handoff-native.png', full_page=True)
        print('PASS Claude Native: off by default, tick and N saved, N capped at 20')

        # Auto-compaction off: the control needs it.
        await page.evaluate("show('native-off', {claudeTransport:'native', autoCompaction:{enabled:false,thresholdPercent:80}})")
        await expect(box).to_be_disabled()
        await expect(line).to_have_text('Needs auto-compaction. Turn on AUTO-COMPACTION to use auto-handoff.')
        print('PASS auto-compaction off: control disabled, says it needs auto-compaction')

        for job, config, text in [
            ('codex-exec', "{primaryProvider:'codex',primaryModel:'gpt-fixture'}", 'Codex on the exec transport does not report compactions. Use the app-server transport.'),
            ('cursor', "{primaryProvider:'cursor',primaryModel:'auto'}", 'Cursor compresses its context without reporting it, so Arco cannot count compactions.'),
            ('llamacpp', "{primaryProvider:'llamacpp',primaryModel:'local'}", 'This provider has no compaction. Use HANDOFF when the context fills.'),
        ]:
            await page.evaluate(f"show('{job}', {config})")
            await expect(box).to_be_disabled(); await expect(count).to_be_disabled()
            await expect(line).to_have_text(text)
        print('PASS Codex exec, Cursor and llama.cpp: disabled with the reason')

        for job, config, text in [
            ('codex-app', "{primaryProvider:'codex',primaryModel:'gpt-fixture',codexTransport:'appserver'}", 'Counts the compactions Codex reports, including its own.'),
            ('claude-cli', "{claudeTransport:'cli'}", 'Counts the compactions the Claude CLI reports.'),
        ]:
            await page.evaluate(f"show('{job}', {config})")
            await expect(box).to_be_enabled(); await expect(line).to_have_text(text)
        print('PASS Codex app-server and Claude CLI: enabled, counting their reports')

        # A tab saved before 0.1.5 with percentages: on stays on, with 5 compactions.
        await page.evaluate("show('legacy', {claudeTransport:'native', autoHandoff:{enabled:true, warnAt:75, autoAt:90}})")
        await expect(box).to_be_checked(); await expect(count).to_have_value('5')
        await count.fill('6'); await count.press('Enter')
        assert (await updates())[-1] == {'enabled': True, 'afterCompactions': 6, 'warnAt': 75, 'autoAt': 90}, await updates()
        print('PASS saved percent setting reads as on with 5; the next save drops the percentages')

        assert not errors, errors
        assert not blocked, blocked
        await browser.close()


asyncio.run(main())
