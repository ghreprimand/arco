"""Turn visibility with synthetic provider events and an injected clock."""
import asyncio
import json
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
        errors, messages = [], []
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
        await page.route_web_socket('**/*', lambda ws: ws.on_message(lambda raw: messages.append(json.loads(raw))))
        await page.goto(URL)
        await page.locator('#home-title').wait_for()
        await page.evaluate('''async () => {
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          const {handleServerMessage:receive} = await import('/src/ws/handleServerMessage.ts');
          window.clock = 1000000; Date.now = () => window.clock;
          window.sendFixture = (type, fields={}) => receive({type, workflowId:'fixture', phase:'passthrough', ...fields}, {wsRef:{current:null}, scheduleReconnect:()=>{}});
          s.getState().createJob('fixture',{name:'Fixture', workingDirectory:'/projects/fixture', primaryProvider:'codex', primaryModel:'fixture', primaryEffort:'low', skipPermissions:false});
          s.setState(st=>({connected:true, connectionState:'online', jobs:{...st.jobs, fixture:{...st.jobs.fixture,snapshotReceived:true}}}));
          s.getState().setActiveJob('fixture');
          sendFixture('primary_turn_started',{startedAt:window.clock});
          sendFixture('primary_tool_use',{tool:'Bash',input:JSON.stringify({command:'npm test\\nother'}),status:'started',itemId:'call'});
        }''')
        await page.locator('[data-help="composer.input"] textarea').fill('Proceed')
        await page.locator('[data-help="composer.input"] textarea').press('Enter')
        await page.evaluate("sendFixture('queue_update',{steering:[{clientMessageId:'message-1',content:'Proceed'}],followUp:[]})")
        indicator = page.locator('[data-help="composer.turn-messages"]')
        await expect(indicator.get_by_role('button', name='PENDING · 1')).to_be_visible()
        await indicator.get_by_role('button', name='PENDING · 1').click()
        await expect(page.get_by_text('STEER · QUEUED')).to_be_visible()
        await expect(page.get_by_text('Proceed', exact=True)).to_be_visible()
        await page.get_by_role('button', name='CANCEL', exact=True).last.click()
        assert any(message.get('type') == 'cancel_queued_message' and message.get('clientMessageId') == 'message-1' for message in messages), messages
        await page.evaluate("sendFixture('queue_update',{steering:[],followUp:[]}); sendFixture('turn_messages_delivered',{clientMessageIds:['message-1']})")
        await expect(page.get_by_text('STEER · DELIVERED')).to_be_visible()
        await page.evaluate("window.clock += 61000")
        step = page.locator('[data-help="composer.turn-step"]')
        await expect(step).to_contain_text('Bash: npm test')
        await expect(step).to_contain_text('LONG-RUNNING', timeout=5000)
        await expect(step).to_contain_text('1m 1s')
        assert await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        await page.evaluate('''async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {MemberCard} = await import('/src/components/MemberCard.tsx');
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          const node = document.createElement('div'); node.id = 'card-fixture'; node.style.width = '280px'; document.body.appendChild(node);
          function CardFixture(){const job=s(st=>st.jobs.fixture);return React.createElement(MemberCard,{job, displayName:'Worker',status:'busy',focused:false,onClick:()=>{}});}
          createRoot(node).render(React.createElement(CardFixture));
        }''')
        await expect(page.locator('#card-fixture')).to_contain_text('[no turns]')
        await page.evaluate("sendFixture('primary_tool_use',{tool:'Bash',input:JSON.stringify({command:'npm test'}),status:'completed',itemId:'call'})")
        await expect(page.locator('#card-fixture')).to_contain_text('Bash: npm test')
        await page.evaluate("sendFixture('primary_text',{text:'Understood'})")
        await expect(indicator).to_have_count(0)
        await page.evaluate('''async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ActivityTab} = await import('/src/components/RightPanel/ActivityTab.tsx');
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          const node = document.createElement('div'); node.id = 'activity-fixture'; document.body.appendChild(node);
          function ActivityFixture(){const job=s(st=>st.jobs.fixture);return React.createElement(ActivityTab,{job});}
          createRoot(node).render(React.createElement(ActivityFixture));
          window.bgFixture = {id:'agent-job',pid:123,command:'npm run dev',toolUseId:'shell-1',startedAt:window.clock,alive:true,cpuActive:false,rssBytes:1024,ageMs:0};
          sendFixture('primary_activity',{jobs:[window.bgFixture]});
        }''')
        background = page.locator('#activity-fixture [data-help="rightpanel.activity.background"]')
        await expect(background).to_contain_text('BACKGROUND · 1')
        await expect(background).to_contain_text('npm run dev')
        await expect(background).to_contain_text('LIVE')
        await page.evaluate("sendFixture('primary_turn_ended',{endedAt:window.clock})")
        await expect(background).to_contain_text('npm run dev')
        await page.evaluate("sendFixture('primary_activity',{jobs:[{...window.bgFixture,alive:false,ageMs:3000}]})")
        await expect(background).to_contain_text('DONE')
        await page.evaluate("sendFixture('primary_activity',{jobs:[]})")
        await expect(background).to_have_count(0)
        assert not errors, errors
        await browser.close()
        print('PASS: queued, delivered, reply, timed step and narrow viewport')

asyncio.run(main())
