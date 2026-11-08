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

URL = os.environ.get('ARCO_INTERRUPT_PREVIEW_URL', 'http://127.0.0.1:5194/')
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
            elif path == '/api/skills':
                data = {'project': [{'scope': 'project', 'slug': 'restored', 'name': 'Restored rule', 'description': 'Synthetic restored skill'}, {'scope': 'project', 'slug': 'existing', 'name': 'Existing rule', 'description': 'Synthetic existing skill'}], 'global': [], 'builtin': []}
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
        queue_items = {}
        def socket_route(ws):
            def receive(raw):
                msg = json.loads(raw)
                messages.append(msg)
                if msg.get('type') != 'cancel_queued_message' or not msg.get('editRequestId'): return
                item = queue_items.pop(msg['clientMessageId'], None)
                result = {'type': 'queued_message_edit_result', 'workflowId': msg['workflowId'], 'clientMessageId': msg['clientMessageId'], 'requestId': msg['editRequestId']}
                if item:
                    ws.send(json.dumps({'type': 'queued_message_cancelled', 'workflowId': msg['workflowId'], 'clientMessageId': msg['clientMessageId']}))
                    ws.send(json.dumps({'type': 'queue_update', 'workflowId': msg['workflowId'], 'steering': [], 'followUp': []}))
                    result['item'] = item
                else: result['error'] = 'Already sent, nothing to edit'
                ws.send(json.dumps(result))
            ws.on_message(receive)
        await context.route_web_socket('**/*', socket_route)
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
        await page.wait_for_timeout(100)
        assert not errors, errors
        draft = page.locator('textarea').first
        button = page.get_by_role('button', name='INTERRUPT & SEND', exact=True)
        normal = page.get_by_role('button', name='SEND', exact=True)
        await expect(normal).to_be_visible()
        await expect(normal).to_be_disabled()
        await draft.fill('normal button steering')
        await expect(normal).to_be_enabled()
        await expect(button).to_be_enabled()
        await normal.click()
        await expect(draft).to_have_value('')
        assert messages[-1]['kind'] == 'steer' and messages[-1]['content'] == 'normal button steering'
        assert not any(m['type'] == 'cancel' for m in messages)

        await expect(button).to_be_visible()
        await expect(button).to_be_disabled()
        await draft.fill('change direction now')
        await expect(button).to_be_enabled()
        await button.click()
        await expect(draft).to_have_value('')
        assert messages[-1]['type'] == 'user_message' and messages[-1]['kind'] == 'interrupt', messages[-1]
        assert messages[-1]['content'] == 'change direction now'
        assert not any(m['type'] == 'cancel' for m in messages)
        await draft.fill('keyboard correction')
        await draft.press('Control+Enter')
        await expect(draft).to_have_value('')
        assert messages[-1]['kind'] == 'interrupt' and messages[-1]['content'] == 'keyboard correction'
        await draft.fill('normal steering'); await draft.press('Enter')
        assert messages[-1]['kind'] == 'steer'
        await draft.fill('later task'); await draft.press('Alt+Enter')
        assert messages[-1]['kind'] == 'follow-up'
        # P8.24: list and preview EDIT restore metadata in standalone and cluster tabs.
        for clustered in [False, True]:
            if clustered:
                await page.evaluate("""() => {
                  const cluster = {clusterId:'edit-cluster',cwd:'/tmp',createdAt:'',members:[{workflowId:'interrupt-ui',displayName:'Editor',role:'Director',status:'running'}],mailboxDepth:{},taskBoardMode:'none',taskBoardAttached:false};
                  testStore.getState().setClusterState('edit-cluster',cluster);
                  testStore.getState().setActiveCluster('edit-cluster');
                }""")
            for kind in ['steer', 'follow-up', 'interrupt']:
                queued_id = f'edit-{clustered}-{kind}'
                content = f'Queued {kind}'
                path = '/tmp/fixture-attachment.txt'
                queue_items[queued_id] = {'content': content, 'kind': kind, 'attachments': [path], 'pickedSkills': [{'scope': 'project', 'slug': 'restored'}, {'scope': 'project', 'slug': 'existing'}]}
                await page.evaluate("""({id,content,kind}) => {
                  const q={clientMessageId:id,content,...(kind==='interrupt'?{interrupt:true}:{})};
                  testStore.setState(st=>({jobs:{...st.jobs,'interrupt-ui':{...st.jobs['interrupt-ui'],queue:{steering:kind==='follow-up'?[]:[q],followUp:kind==='follow-up'?[q]:[]},turnMessages:{[id]:{content,kind,state:'queued'}}}}}));
                }""", {'id': queued_id, 'content': content, 'kind': kind})
                await page.locator('[data-help="composer.skills"]').click()
                await page.get_by_title('Apply this skill to the next turn only', exact=True).nth(1).click()
                await page.keyboard.press('Escape')
                await expect(page.get_by_text('INLINE SKILLS:', exact=True)).to_be_visible()
                await draft.fill('Unsent work')
                await page.locator('[data-help="composer.turn-messages"] button').first.click()
                if kind != 'steer':
                    await page.get_by_role('button', name='PREVIEW', exact=True).click()
                    await expect(page.get_by_role('button', name='BACK TO LIST', exact=True)).to_be_visible()
                await page.get_by_role('button', name='EDIT', exact=True).click()
                await expect(draft).to_have_value('Unsent work\n\n' + content)
                await expect(page.get_by_text('EDITING ' + kind.upper(), exact=True)).to_be_visible()
                await expect(page.get_by_title('Inline "Restored rule" (project) into the next turn', exact=True)).to_be_visible()
                await expect(page.get_by_title('Inline "Existing rule" (project) into the next turn', exact=True)).to_have_count(1)
                await expect(page.get_by_title('Remove attachment').first).to_be_visible()
                await draft.fill('Unsent work\n\nEdited ' + kind)
                await normal.click()
                await expect(draft).to_have_value('')
                assert messages[-1]['type'] == 'user_message' and messages[-1]['kind'] == kind, messages[-1]
                assert messages[-1]['content'] == 'Unsent work\n\nEdited ' + kind, messages[-1]
                assert messages[-1]['attachments'] == [path]
                assert messages[-1]['pickedSkills'] == [{'scope': 'project', 'slug': 'existing'}, {'scope': 'project', 'slug': 'restored'}]
                await expect(page.get_by_text('INLINE SKILLS:', exact=True)).to_have_count(0)
                assert messages[-1]['clientMessageId'] != queued_id
                await expect(page.get_by_text('EDITING ' + kind.upper(), exact=True)).to_have_count(0)
        # A server-side delivery wins even if the browser still shows the pending snapshot.
        await page.evaluate("""() => {
          testStore.getState().setActiveCluster(null); testStore.getState().setActiveJob('interrupt-ui');
          const item={clientMessageId:'already-sent',content:'Already delivered'};
          testStore.setState(st=>({jobs:{...st.jobs,'interrupt-ui':{...st.jobs['interrupt-ui'],queue:{steering:[item],followUp:[]},turnMessages:{'already-sent':{content:item.content,kind:'steer',state:'queued'}}}}}));
        }""")
        await draft.fill('Keep current draft')
        await page.locator('[data-help="composer.turn-messages"] button').first.click()
        await page.get_by_role('button', name='EDIT', exact=True).click()
        await expect(page.get_by_text('Already sent, nothing to edit', exact=True)).to_be_visible()
        await expect(draft).to_have_value('Keep current draft')
        await page.keyboard.press('Escape')
        await page.evaluate("testStore.setState(st=>({jobs:{...st.jobs,'interrupt-ui':{...st.jobs['interrupt-ui'],queue:{steering:[],followUp:[]},turnMessages:{}}}}))")
        await draft.fill('keep this draft'); await draft.press('Shift+Enter')
        await expect(draft).to_have_value('keep this draft\n')
        count = len(messages)
        await page.evaluate('''() => {
          testSocket.close();
          document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',ctrlKey:true,bubbles:true}));
        }''')
        await expect(draft).to_have_value('keep this draft\n')
        assert len(messages) == count, 'disconnected interrupt keeps the unsent draft'
        await page.evaluate("testStore.getState().endPrimaryTurn('interrupt-ui')")
        await expect(button).to_have_count(0)
        await expect(normal).to_be_visible()
        await page.evaluate("testStore.getState().beginPrimaryTurn('interrupt-ui',Date.now());testStore.getState().updateJobPrimary('interrupt-ui',{provider:'claude',claudeTransport:'native'})")
        await expect(button).to_be_visible()
        await page.evaluate("testStore.getState().updateJobPrimary('interrupt-ui',{provider:'ollama'})")
        await expect(button).to_have_count(0)
        await page.evaluate("testStore.getState().updateJobPrimary('interrupt-ui',{provider:'codex'});testStore.getState().setActiveJob('interrupt-ui')")
        await page.set_viewport_size({'width': 700, 'height': 900})
        await expect(button).to_be_visible()
        for width in [700, 400]:
            await page.set_viewport_size({'width': width, 'height': 900})
            for control in [normal, button]:
                await expect(control).to_be_visible()
                rect = await control.bounding_box()
                assert rect and rect['x'] >= 0 and rect['x'] + rect['width'] <= width, rect
        Path('/tmp/arco-interrupt-ui').mkdir(exist_ok=True)
        await page.screenshot(path='/tmp/arco-interrupt-ui/composer.png')
        assert not errors, errors
        print('PASS: pending EDIT, preview, append, kind/attachment restore, change/resend in single and cluster tabs, delivery race; visible normal SEND and INTERRUPT & SEND, normal send payload, button/draft updates, Ctrl+Enter, ordinary steer/follow-up, newline, disconnected draft retention, provider/idle visibility and narrow layout.')
        await browser.close()


asyncio.run(main())
