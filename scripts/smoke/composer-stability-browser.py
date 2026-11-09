"""Composer coverage against isolated Vite APIs/WS; no provider calls.
Run ARCO_CLIENT_PORT=5194 npm run dev:client, then python3 this file.
"""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults
from host_isolation import chrome_executable

install_navigation_defaults()

URL = os.environ.get('ARCO_INTERRUPT_PREVIEW_URL', 'http://127.0.0.1:5254/')
CHROME = chrome_executable()


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000})
        messages, errors = [], []

        async def api(route):
            path = urlparse(route.request.url).path
            data = {'files': [], 'entries': [], 'workflows': [], 'projects': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'tasks': [], 'sessions': [], 'messages': [], 'chats': [], 'dirs': []}
            if path == '/api/settings':
                data = {'themeId': 'arch', 'enabledProviders': {'codex': True, 'claude': True}}
            elif path == '/api/auth-status':
                data = {n: {'loggedIn': True, 'installed': True, 'cliInstalled': True} for n in ['claude', 'codex',  'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'github']}
            elif path == '/api/capabilities':
                data = {'efforts': ['low', 'medium', 'high'], 'models': ['gpt-5.5'], 'cliVersion': 'fixture', 'codexVersion': '0.164.0'}
            elif path.endswith('/catalog'):
                data = {'models': []}
            await route.fulfill(json=data)

        await context.route('**/api/**', api)
        await context.route('**/healthz', lambda r: r.fulfill(json={'status': 'live'}))
        await context.route('https://**/*', lambda r: r.abort())
        await context.route_web_socket('**/*', lambda ws: ws.on_message(lambda raw: messages.append(json.loads(raw))))
        await context.add_init_script('''
          const OriginalWebSocket = window.WebSocket;
          window.WebSocket = class extends OriginalWebSocket {
            constructor(...args) { super(...args); window.testSocket = this; }
          };
        ''')
        page = await context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(URL)
        await page.wait_for_timeout(500)
        await page.evaluate('''async () => {
          const loaded = path => performance.getEntriesByType('resource').map(e => e.name).findLast(url => new URL(url).pathname === path) ?? path;
          const {useAppStore:s} = await import(loaded('/src/stores/appStore.ts')); window.testStore=s;
          s.getState().createJob('interrupt-ui', {kind:'workflow',name:'Interrupt UI',primaryProvider:'codex',primaryModel:'gpt-5.5',primaryEffort:'high',codexTransport:'appserver',workingDirectory:'/tmp',skipPermissions:false});
          s.getState().beginPrimaryTurn('interrupt-ui', Date.now());
          s.setState({connected:true,connectionState:'online',focusMode:true});
        }''')
        for width in [1280, 1366, 1920]:
            await page.set_viewport_size({'width': width, 'height': 800 if width == 1280 else 768 if width == 1366 else 1080})
            for mode in ['standard', 'compact', 'narrow']:
                await page.evaluate("mode => localStorage.setItem('arco.layoutMode', mode)", mode)
                await page.reload()
                await page.wait_for_timeout(300)
                await page.evaluate('''async () => {
                  const {useAppStore:s}=await import('/src/stores/appStore.ts'); window.testStore=s;
                  s.getState().createJob('interrupt-ui',{kind:'workflow',name:'Fixture',primaryProvider:'codex',primaryModel:'gpt-5.5',primaryEffort:'high',codexTransport:'appserver',workingDirectory:'/demo',skipPermissions:false});
                  s.getState().beginPrimaryTurn('interrupt-ui',Date.now()-1620000);
                  s.setState({connected:true,connectionState:'online',focusMode:true});
                }''')
                toolbar = page.get_by_test_id('composer-toolbar')
                await expect(toolbar).to_have_css('flex-wrap', 'wrap' if mode == 'standard' else 'nowrap')
                for theme in ['matrix', 'phosphor:arco:electric']:
                    await page.evaluate('''async theme => {
                      const {applyTheme}=await import('/src/themes/apply.ts');
                      const {getTheme}=await import('/src/themes/registry.ts'); applyTheme(getTheme(theme));
                    }''', theme)
                    await page.wait_for_timeout(250)
                    samples = await page.evaluate('''async () => {
                      const s=window.testStore, jobId='interrupt-ui';
                      const el=document.querySelector('[data-help="composer.input"]').parentElement;
                      const samples=[]; let start=performance.now(), last=-1;
                      return await new Promise(resolve => {
                        function frame(t) {
                          const phase=Math.floor((t-start)/250);
                          if (phase !== last) {
                            last=phase;
                            const j=s.getState().jobs[jobId];
                            const names=['Read','A very long tool name with many words that keeps changing while a turn is running and should never force a line to wrap','Bash','Search'];
                            const entry={id:'fixture',kind:'tool_use',tool:names[phase%names.length],status:'started',at:Date.now()-phase*1000,input:JSON.stringify({command:'Inspect synthetic files'})};
                            const queued=phase%2 ? [{content:'Synthetic queued message',clientMessageId:'fixture'}] : [];
                            s.setState({jobs:{...s.getState().jobs,[jobId]:{...j,busy:true,activity:[entry],queue:{steering:queued,followUp:[]}}}});
                          }
                          const r=el.getBoundingClientRect(); samples.push([r.x,r.y,r.width,r.height]);
                          if (t-start<1800) requestAnimationFrame(frame); else resolve(samples);
                        }
                        requestAnimationFrame(frame);
                      });
                    }''')
                    unique = sorted({tuple(round(v, 2) for v in row) for row in samples})
                    print(width, mode, theme, len(samples), unique, flush=True)
                    assert len(unique) == 1, (width, mode, theme, unique)
                    timer = page.get_by_test_id('turn-timer')
                    await expect(timer).to_be_visible()
                    assert (await timer.text_content()).startswith('TURN 27m ')
                    timer_box = await timer.bounding_box()
                    north_box = await page.locator('[data-help="composer.north-star"]').bounding_box()
                    line_box = await page.get_by_test_id('composer-status-line').bounding_box()
                    assert timer_box['y'] < north_box['y'] + north_box['height'], (timer_box, north_box)
                    assert timer_box['x'] >= north_box['x'] + north_box['width'] - 1, (timer_box, north_box)
                    assert timer_box['x'] + timer_box['width'] <= line_box['x'] + line_box['width'] + 1, (timer_box, line_box)
                    status = page.locator('[data-help="composer.turn-step"]')
                    await expect(status).to_be_visible()
                    assert await status.get_attribute('title')
                    step_box = await status.bounding_box()
                    counter_box = await page.locator('[data-help="worker.header.ctx"]').bounding_box()
                    assert step_box['x'] + step_box['width'] <= counter_box['x'] + 1, (step_box, counter_box)
        # Native tabs keep PLAN FIRST and the turn time on the same line, including Narrow.
        await page.evaluate("""() => {
          const s=window.testStore, id='interrupt-ui';
          s.setState(st=>({jobs:{...st.jobs,[id]:{...st.jobs[id],busy:true,turnStartedAt:Date.now()-1620000,config:{...st.jobs[id].config,primaryProvider:'claude',claudeTransport:'native'}}}}));
        }""")
        for width, height in [(1280, 800), (1920, 1080)]:
            await page.set_viewport_size({'width':width,'height':height})
            for mode in ['standard', 'narrow']:
                await page.evaluate("mode => localStorage.setItem('arco.layoutMode', mode)", mode)
                await page.reload()
                await page.wait_for_timeout(300)
                await page.evaluate("""async () => {
                  const {useAppStore:s}=await import('/src/stores/appStore.ts'); window.testStore=s;
                  s.getState().createJob('interrupt-ui',{kind:'workflow',name:'Fixture',primaryProvider:'claude',claudeTransport:'native',primaryModel:'sonnet',workingDirectory:'/demo',skipPermissions:false});
                  s.getState().beginPrimaryTurn('interrupt-ui',Date.now()-1620000);
                  s.setState({connected:true,connectionState:'online',focusMode:true});
                }""")
                timer = page.get_by_test_id('turn-timer')
                plan = page.locator('[data-help="composer.plan-first"]')
                await expect(timer).to_be_visible(); await expect(plan).to_be_visible()
                tb = await timer.bounding_box(); pb = await plan.bounding_box(); nb = await page.locator('[data-help="composer.north-star"]').bounding_box()
                assert pb['x'] + pb['width'] <= tb['x'] + 1 and abs(pb['y'] - tb['y']) < 15, (pb, tb)
                assert nb['x'] + nb['width'] <= pb['x'] + 1, (nb, pb)
                if mode == 'standard' and os.environ.get('ARCO_TURN_SCREENSHOT_DIR'):
                    await page.screenshot(path=os.path.join(os.environ['ARCO_TURN_SCREENSHOT_DIR'], f'rc7-turn-timer-{width}.png'))
        # A member opened in WorkflowView keeps its cluster role restrictions.
        await page.evaluate("""() => {
          const s=window.testStore, id='interrupt-ui';
          s.setState(st=>({jobs:{...st.jobs,[id]:{...st.jobs[id],busy:false,config:{...st.jobs[id].config,primaryProvider:'claude',claudeTransport:'native'}}}}));
          s.getState().setActiveJob(id);
        }""")
        await expect(page.get_by_test_id('turn-timer')).to_have_count(0)
        plan_first = page.locator('[data-help="composer.plan-first"]')
        await expect(plan_first).to_be_visible()
        await page.evaluate("""() => {
          const s=window.testStore;
          s.getState().setClusterState('role-fixture',{clusterId:'role-fixture',cwd:'/projects/fixture',createdAt:'',taskBoardMode:'none',taskBoardAttached:false,mailboxDepth:{},members:[{workflowId:'interrupt-ui',displayName:'Fixture',status:'idle',role:'Director role. Delegate'}]});
        }""")
        await expect(plan_first).to_have_count(0)
        await page.evaluate("window.testStore.getState().clearCluster('role-fixture')")
        await expect(plan_first).to_be_visible()
        await page.evaluate("""async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ActivityTab} = await import('/src/components/RightPanel/ActivityTab.tsx');
          const host=document.createElement('div'); host.id='activity-fixture'; document.body.appendChild(host);
          const job={...window.testStore.getState().jobs['interrupt-ui'], activity:[{id:'one',kind:'tool_use',tool:'Read',input:'{}',at:1730000000000}]};
          createRoot(host).render(React.createElement(ActivityTab,{job}));
        }""")
        await expect(page.locator('#activity-fixture [data-testid="activity-time"]')).to_have_text(await page.evaluate('new Date(1730000000000).toLocaleTimeString()'))
        assert not errors, errors
        await browser.close()
        print('PASS: composer remains stable during changing turn steps')

asyncio.run(main())
