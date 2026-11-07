"""One status per tab with synthetic turn events; every API and WebSocket request is stubbed."""
import asyncio
import os
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults
from host_isolation import chrome_executable

install_navigation_defaults()

URL = 'http://127.0.0.1:' + os.environ.get('ARCO_CLIENT_PORT', '5203') + '/'

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page(viewport={'width': 400, 'height': 800})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        async def api(route):
            path = urlparse(route.request.url).path
            data = {'files': [], 'entries': [], 'workflows': [], 'projects': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'tasks': [], 'sessions': [], 'messages': []}
            if path == '/api/settings': data = {'themeId': 'phosphor:arco:electric', 'uiScale': 1, 'onboardingComplete': True, 'enabledProviders': {'codex': True}}
            elif path == '/api/auth-status': data = {key: {'loggedIn': False, 'installed': True, 'cliInstalled': True} for key in ['claude','codex','cursor','ollama','llamacpp','lmstudio','strata','deepseek','github']}
            elif path == '/api/capabilities': data = {'efforts': ['low'], 'models': ['fixture'], 'cliVersion': 'fixture'}
            elif path == '/api/installation-history': data = {'used': True}
            elif path == '/api/projects': data = {'roots': [], 'projects': [], 'organization': True}
            elif path == '/api/update-check': data = {'current': '0.1.0', 'enabled': False, 'updateAvailable': False}
            await route.fulfill(json=data)
        await page.route('**/api/**', api)
        await page.route('**/healthz', lambda route: route.fulfill(json={'status': 'live'}))
        await page.route('https://**/*', lambda route: route.abort())
        await page.route_web_socket('**/*', lambda ws: None)
        await page.goto(URL)
        await page.locator('#home-title').wait_for()
        await page.evaluate('''async () => {
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          const {handleServerMessage:receive} = await import('/src/ws/handleServerMessage.ts');
          const {setClaudeQuestionIds} = await import('/src/questions/waitingQuestion.ts');
          window.testStore = s; window.setQuestion = setClaudeQuestionIds;
          window.send = (type, id, fields={}) => receive({type, workflowId:id, phase:'passthrough', ...fields}, {wsRef:{current:null}, scheduleReconnect:()=>{}});
          for (const id of ['alpha','beta']) {
            s.getState().createJob(id,{name:id, workingDirectory:'/projects/fixture', primaryProvider:'codex', primaryModel:'fixture', primaryEffort:'low', skipPermissions:false});
          }
          s.setState(st=>({connected:true, connectionState:'online', jobs:{...st.jobs, alpha:{...st.jobs.alpha,snapshotReceived:true}, beta:{...st.jobs.beta,snapshotReceived:true}}}));
          s.getState().setActiveJob('beta');
        }''')
        # The single-workflow meter lives above the transcript, outside the composer.
        meter = page.locator('[data-help="worker.header.ctx"]')
        await expect(meter).to_have_count(1)
        await expect(meter).to_contain_text('CTX')
        assert await meter.evaluate("e => !e.closest('[data-help=\"composer.input\"]')")
        await page.evaluate("testStore.setState(s => ({jobs:{...s.jobs,beta:{...s.jobs.beta,config:{...s.jobs.beta.config,primaryProvider:'cursor'}}}}))")
        await expect(meter).to_contain_text('CTX: Cursor-managed')
        await page.evaluate("testStore.setState(s => ({jobs:{...s.jobs,beta:{...s.jobs.beta,config:{...s.jobs.beta.config,primaryProvider:'codex'},modelContextWindow:100000,lastTurnTokens:{input:25000,output:100,cacheRead:0,cacheCreate:0}}}}))")
        await expect(meter).to_contain_text('CTX: 25k / 100k')
        chip = lambda name: page.locator('[data-help="tabbar.tab"]').filter(has_text=name.upper()).locator('[data-tab-status]')
        async def status(name): return await chip(name).get_attribute('data-tab-status')
        assert await status('alpha') == 'idle' and await status('beta') == 'idle'
        tab_button = lambda name: page.locator('[data-help="tabbar.tab"]').filter(has_text=name.upper()).locator('button').first
        await expect(tab_button('alpha')).to_have_attribute('title', 'Idle')
        await expect(tab_button('alpha')).to_have_accessible_name('alpha: Idle')
        assert (await chip('alpha').inner_text()).strip() == '' and await chip('alpha').get_attribute('title') is None
        await page.evaluate("send('primary_turn_started','alpha',{startedAt:Date.now()})")
        await expect(chip('alpha')).to_have_attribute('data-tab-status', 'working')
        await expect(tab_button('alpha')).to_have_accessible_name('alpha: Working')
        assert (await chip('alpha').inner_text()).strip() == '' and await chip('alpha').get_attribute('title') == 'Working' and await chip('alpha').get_attribute('aria-label') == 'Working'
        await page.evaluate("send('primary_turn_ended','alpha')")
        await expect(chip('alpha')).to_have_attribute('data-tab-status', 'new-reply')
        await expect(tab_button('alpha')).to_have_attribute('title', 'New reply')
        assert await status('beta') == 'idle'
        await page.evaluate("setQuestion('alpha',['q1'])")
        await expect(chip('alpha')).to_have_attribute('data-tab-status', 'needs-you')
        await expect(tab_button('alpha')).to_have_accessible_name('alpha: Needs you')
        await page.evaluate("setQuestion('alpha',[])")
        await expect(chip('alpha')).to_have_attribute('data-tab-status', 'new-reply')
        # Home cards carry the same status.
        await page.evaluate("testStore.getState().showHomeView()")
        await page.locator('#home-title').wait_for()
        card = page.locator('.home-work-grid li').filter(has_text='alpha')
        await expect(card.locator('[data-tab-status]')).to_have_attribute('data-tab-status', 'new-reply')
        await expect(card.locator('[data-tab-status]')).to_contain_text('New reply')
        await card.locator('button.home-primary').click()
        await expect(chip('alpha')).to_have_attribute('data-tab-status', 'idle')
        # A turn that ends on the tab being viewed is not an unread reply.
        await page.evaluate("send('primary_turn_started','alpha',{startedAt:Date.now()}); send('primary_turn_ended','alpha')")
        await expect(chip('alpha')).to_have_attribute('data-tab-status', 'idle')
        assert not errors, errors
        await browser.close()
        print('tab status browser suite passed')

asyncio.run(main())
