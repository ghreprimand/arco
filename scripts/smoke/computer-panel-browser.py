"""Computer's dedicated header surface against Vite; APIs/WS isolated, no mic or provider calls.
Run with ARCO_CLIENT_PORT=5193 npm run dev:client, then python3 this file.
"""
import asyncio
import json
import os
import time
import io
import wave
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect

URL = os.environ.get('ARCO_COMPUTER_PREVIEW_URL', 'http://127.0.0.1:5193/')
CHROME = os.environ.get('ARCO_TEST_CHROME', os.path.expanduser('~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'))
ART = Path('/tmp/arco-computer-panel-review')


async def main():
    ART.mkdir(exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000})
        errors, messages, writes, previews = [], [], [], []

        async def api(route):
            path = urlparse(route.request.url).path
            if route.request.method != 'GET':
                writes.append(path)
            data = {'files': [], 'entries': [], 'workflows': [], 'projects': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'tasks': [], 'sessions': [], 'messages': [], 'chats': [], 'dirs': [], 'watches': [], 'rules': []}
            if path == '/api/settings':
                data = {'themeId': 'arch', 'enabledProviders': {'codex': True}}
            elif path == '/api/voice/status':
                data = {'localSpeech': True, 'defaultVoice': 'en-GB-SoniaNeural'}
            elif path == '/api/voice/activity':
                if route.request.method != 'GET':
                    assert route.request.post_data_json in [{'action': 'status'}, {'action': 'configure', 'agent_updates': 'off'}], route.request.post_data_json
                data = {'policy': {'enabled': True, 'agentUpdates': 'off'}, 'pending': 0, 'updatesPerHour': 12, 'updatesThisHour': 0, 'ledger': [], 'deliveries': []}
            elif path == '/api/voice/preview':
                previews.append(route.request.post_data_json)
                audio = io.BytesIO()
                with wave.open(audio, 'wb') as wav:
                    wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
                    wav.writeframes(bytes(16000))
                await route.fulfill(body=audio.getvalue(), content_type='audio/wav')
                return
            elif path == '/api/auth-status':
                data = {n: {'loggedIn': n == 'codex', 'installed': True, 'cliInstalled': True} for n in ['claude', 'codex',  'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'github']}
            elif path == '/api/capabilities':
                data = {'efforts': ['low', 'medium', 'high'], 'models': ['gpt-6-luna'], 'cliVersion': 'fixture', 'codexVersion': '0.163.0'}
            elif path.endswith('/catalog'):
                data = {'models': []}
            elif path.endswith('/usage'):
                data = {'available': False}
            await route.fulfill(json=data)

        await context.route('**/api/**', api)
        await context.route('**/healthz', lambda r: r.fulfill(json={'status': 'live'}))
        await context.route('https://**/*', lambda r: r.abort())
        context_state = {'resetAtPercent': 50, 'keepContext': False, 'resets': 0}
        created_ids = []
        def socket(ws):
            def incoming(raw):
                msg = json.loads(raw)
                messages.append(msg)
                if msg.get('type') == 'create_workflow':
                    workflow_id = f'computer-created-{len(created_ids)}'
                    created_ids.append(workflow_id)
                    ws.send(json.dumps({'type':'workflow_created','workflowId':workflow_id,'config':msg['config']}))
                    return
                if msg.get('type') == 'user_message' and msg['workflowId'] == 'voice':
                    ws.send(json.dumps({'type':'primary_turn_started','workflowId':'voice','startedAt':int(time.time()*1000)}))
                    ws.send(json.dumps({'type':'voice_tool_call','workflowId':'voice','requestId':'typed-targets','tool':'arco_targets','args':{}}))
                    return
                if msg.get('type') == 'voice_tool_result' and msg['requestId'] == 'typed-targets':
                    assert msg['ok'], msg
                    ws.send(json.dumps({'type':'primary_text','workflowId':'voice','phase':'passthrough','text':'Which turn limit did you mean: two or twenty?'}))
                    ws.send(json.dumps({'type':'primary_complete','workflowId':'voice','phase':'passthrough'}))
                    ws.send(json.dumps({'type':'primary_turn_ended','workflowId':'voice','endedAt':int(time.time()*1000)}))
                    ws.send(json.dumps({'type':'computer_context_updated','workflowId':'voice','state':context_state,'settled':True}))
                    return
                if msg.get('type') != 'computer_context_control':
                    return
                fresh = msg['action'] == 'fresh'
                if fresh:
                    context_state.update(resets=context_state['resets'] + 1, lastResetAt=int(time.time() * 1000), lastResetReason='operator')
                else:
                    context_state.update({k: msg[k] for k in ['keepContext', 'resetAtPercent'] if k in msg})
                ws.send(json.dumps({'type': 'computer_context_updated', 'workflowId': msg['workflowId'], 'state': context_state, 'fresh': fresh, 'settled': True, 'discardTranscript': fresh and msg['workflowId'].startswith('computer-created')}))
            ws.on_message(incoming)
        await context.route_web_socket('**/*', socket)
        await context.add_init_script('''
          window.micCalls = 0;
          navigator.mediaDevices.getUserMedia = async () => { window.micCalls++; throw Error('No microphone in this smoke'); };
        ''')
        page = await context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(URL)
        await page.wait_for_timeout(700)
        await page.evaluate('''async () => {
          const loaded = path => performance.getEntriesByType('resource').map(e => e.name).findLast(url => new URL(url).pathname === path) ?? path;
          const {useAppStore:s} = await import(loaded('/src/stores/appStore.ts')); window.testStore = s;
          const {useVoiceStore:v} = await import(loaded('/src/voice/store.ts')); window.voiceStore = v;
          const {useComputerStore:c} = await import(loaded('/src/stores/computerStore.ts')); window.computerStore = c;
          s.getState().createJob('project', {kind:'chat',name:'Project notes',primaryProvider:'codex',primaryModel:'gpt-6-luna',primaryEffort:'low',workingDirectory:'',skipPermissions:false});
          s.setState({connected:true,connectionState:'online',focusMode:true});
        }''')
        header = page.get_by_role('button', name='COMPUTER', exact=True)
        await header.click()
        dialog = page.get_by_role('dialog', name='COMPUTER', exact=True)
        await expect(dialog).to_be_visible()
        await expect(dialog.get_by_text('Your conversations with Computer will appear here.')).to_be_visible()
        await page.evaluate("window.savedComputerAuth = testStore.getState().authStatus; testStore.setState({authStatus:Object.fromEntries(Object.entries(window.savedComputerAuth).map(([provider,status])=>[provider,{...status,loggedIn:false}]))})")
        await expect(dialog.get_by_text('No Computer agent is connected.', exact=False)).to_be_visible()
        await expect(dialog.get_by_role('link', name='Connections', exact=True)).to_have_attribute('href', '#connections')
        await expect(dialog.get_by_role('button', name='USE AGENT', exact=True)).to_be_disabled()
        await page.evaluate('testStore.setState({authStatus:window.savedComputerAuth})')
        assert await page.evaluate('testStore.getState().activeJobId') == 'project'
        await page.keyboard.press('Escape')
        await expect(dialog).to_have_count(0)
        await expect(header).to_be_focused()

        await page.evaluate('''() => {
          testStore.getState().createJob('voice', {kind:'chat',name:'Computer',voiceOperator:true,primaryProvider:'codex',primaryModel:'gpt-6-luna',primaryEffort:'low',codexTransport:'appserver',workingDirectory:'',skipPermissions:false});
          testStore.getState().addMessage('voice', {id:'question',role:'user',content:'How does Strata work?',timestamp:Date.now()-1000,isStreaming:false});
          testStore.getState().addMessage('voice', {id:'answer',role:'assistant',content:'Strata runs your models locally and remembers your selected profile.',timestamp:Date.now(),isStreaming:false});
          testStore.getState().setLastTurnTokens('voice', {input:78300,output:0,cacheRead:77000,cacheCreate:0});
          testStore.getState().setModelContextWindow('voice', 828400);
        }''')
        assert await page.evaluate('testStore.getState().activeJobId') == 'project'
        assert await page.evaluate('computerStore.getState().open') is False
        await expect(header).to_have_count(1)
        await expect(page.locator('[data-help="tabbar.tab"]', has_text='COMPUTER')).to_have_count(0)
        await header.click()
        await expect(dialog.get_by_text('How does Strata work?', exact=True)).to_be_visible()
        await expect(dialog.get_by_text('Strata runs your models locally and remembers your selected profile.', exact=True)).to_be_visible()
        composer = dialog.get_by_role('textbox', name='Message to Computer')
        await expect(composer).to_be_visible()
        await composer.fill('Use twenty turns for all SignalQueue workers.')
        await composer.press('Enter')
        await expect(composer).to_have_value('')
        await expect(dialog.get_by_text('Which turn limit did you mean: two or twenty?', exact=True)).to_be_visible()
        assert any(m.get('type') == 'user_message' and m.get('workflowId') == 'voice' and m.get('content') == 'Use twenty turns for all SignalQueue workers.' for m in messages)
        assert any(m.get('type') == 'voice_tool_result' and m.get('requestId') == 'typed-targets' and m.get('ok') for m in messages)
        assert await page.evaluate('window.micCalls') == 0
        assert await page.evaluate('voiceStore.getState().enabled') is False
        # Drafts survive a closed dialog; an unfinished queue/reset boundary
        # keeps Stop available even after the provider releases busy.
        await composer.fill('Keep this clarification.')
        await dialog.get_by_role('button', name='Close Computer').click()
        await header.click()
        await expect(composer).to_have_value('Keep this clarification.')
        await page.evaluate("testStore.setState(s=>({jobs:{...s.jobs,voice:{...s.jobs.voice,busy:false,computerTurnActive:true}}}))")
        await expect(dialog.get_by_role('button', name='STOP REQUEST', exact=True)).to_be_visible()
        await expect(dialog.get_by_role('button', name='SEND', exact=True)).to_be_disabled()
        sent_before = sum(m.get('type') == 'user_message' for m in messages)
        await composer.press('Enter')
        assert sum(m.get('type') == 'user_message' for m in messages) == sent_before
        await dialog.get_by_role('button', name='STOP REQUEST', exact=True).click()
        await page.wait_for_timeout(50)
        assert any(m.get('type') == 'cancel' and m.get('workflowId') == 'voice' for m in messages)
        await page.evaluate("testStore.setState(s=>({jobs:{...s.jobs,voice:{...s.jobs.voice,computerTurnActive:false}}}))")
        await expect(dialog.get_by_role('button', name='STOP REQUEST', exact=True)).to_have_count(0)
        await composer.fill('')
        await expect(dialog.get_by_text('CONTEXT 9.5%', exact=True)).to_be_visible()
        await expect(dialog.get_by_label('Computer fresh-context threshold')).to_have_value('50')
        assert await page.evaluate('testStore.getState().activeJobId') == 'project'
        assert await page.evaluate('window.micCalls') == 0
        # Long-running scripts display null budgets and real counters; old
        # finite definitions retain their numbers rather than showing 1970.
        await page.evaluate('''async () => {
          const url=performance.getEntriesByType('resource').map(e=>e.name).findLast(url=>new URL(url).pathname==='/src/voice/conditions.ts')??'/src/voice/conditions.ts';
          const {useComputerConditions:s}=await import(url);window.conditionStore=s;
          const rule={ownerId:'voice',status:'watching',reason:'Waiting for new mail.',createdAt:Date.now(),actions:160,workerTurns:{'fixture-builder':{count:160,at:Date.now()}},members:[{id:'fixture-builder',name:'Builder',clusterId:'fixture-cluster'}],announcements:[],executions:{},fired:[],mailSeen:{},definition:{label:'Unlimited script',cluster_ids:['fixture-cluster'],hold_on_input:true,stop_on_error:true,stop_on_interrupt:true,clauses:[],ttl_minutes:null,max_actions:null,max_worker_turns:null,cooldown_seconds:0}};
          window.scriptFixture=rule;
          s.setState({rules:[{...rule,id:'unlimited-script',expiresAt:null},{...rule,id:'budgeted-script',expiresAt:Date.now()+6*3600000,definition:{...rule.definition,label:'Budgeted script',ttl_minutes:360,max_actions:500,max_worker_turns:1000,cooldown_seconds:5}}]});
        }''')
        scripts = dialog.locator('[data-help="computer.scripts"]')
        unlimited = scripts.locator('details').filter(has=scripts.page.locator('summary', has_text='Unlimited script'))
        budgeted = scripts.locator('details').filter(has=scripts.page.locator('summary', has_text='Budgeted script'))
        await unlimited.locator('summary').click()
        await expect(unlimited.get_by_text('Actions: 160 (no limit).', exact=True)).to_be_visible()
        await expect(unlimited.get_by_text('Scope:', exact=False)).to_contain_text('No expiry')
        await expect(unlimited.get_by_text('Worker actions:', exact=False)).to_contain_text('Builder: 160 (no limit). Cooldown: 0s.')
        await budgeted.locator('summary').click()
        await expect(budgeted.get_by_text('Actions: 160/500.', exact=True)).to_be_visible()
        await expect(budgeted.get_by_text('Worker actions:', exact=False)).to_contain_text('Builder: 160/1000. Cooldown: 5s.')
        assert '1970' not in await scripts.inner_text()
        await page.screenshot(path=str(ART / 'script-limits.png'), animations='disabled')
        await unlimited.locator('summary').click()
        await budgeted.locator('summary').click()
        # Active/paused items stay visible; terminal records are closed history,
        # including old records whose stale paused flag must not imply activity.
        await page.evaluate('''async () => {
          const load=async path=>import(performance.getEntriesByType('resource').map(e=>e.name).findLast(url=>new URL(url).pathname===path)??path);
          const {useComputerWatches:w}=await load('/src/voice/watches.ts');window.watchStore=w;
          const {useComputerMailRules:m}=await load('/src/voice/mailRules.ts');window.mailRuleStore=m;
          const {useComputerActivity:a}=await load('/src/voice/activity.ts');window.activityStore=a;
          const base=window.scriptFixture;
          window.scriptHistory=['finished','cancelled','expired','interrupted','limited','failed'].map((status,i)=>({...base,id:`past-script-${i}`,status,paused:status==='cancelled',reason:`Stopped because ${status}`,expiresAt:null,definition:{...base.definition,label:`Past script ${status}`}}));
          conditionStore.setState(s=>({rules:[...s.rules,{...base,id:'paused-script',paused:true,expiresAt:null,definition:{...base.definition,label:'Paused mail script'}},...window.scriptHistory,{...base,id:'private-other',ownerId:'other-owner',private:true,expiresAt:null,definition:{...base.definition,label:'PRIVATE OTHER RULE'}}]}));
          window.watchFixture={id:'live-watch',ownerId:'voice',label:'Current Builder work',status:'watching',createdAt:Date.now(),targets:[{id:'fixture-builder',name:'Builder',status:'working'}]};
          w.setState({watches:[window.watchFixture,...['finished','failed','cancelled','interrupted'].map((status,i)=>({...window.watchFixture,id:`past-watch-${i}`,label:`Past watch ${status}`,status}))]});
        }''')
        await expect(scripts.get_by_text('2 active · 1 paused', exact=True)).to_be_visible()
        await expect(scripts.get_by_text('Past script expired', exact=True)).not_to_be_visible()
        await expect(scripts.get_by_text('PRIVATE OTHER RULE', exact=True)).to_have_count(0)
        await expect(scripts.get_by_role('button', name='Resume script Paused mail script', exact=True)).to_be_visible()
        await expect(scripts.get_by_role('button', name='Cancel script Unlimited script', exact=True)).to_be_visible()
        script_history = scripts.locator('details').filter(has=page.locator('summary', has_text='History (6)'))
        await expect(script_history.locator(':scope > summary')).to_have_text('History (6)')
        assert await script_history.get_attribute('open') is None
        await expect(scripts.get_by_text('0/24 Luna LOW input-observation batches this hour.', exact=False)).not_to_be_visible()
        await expect(dialog.locator('[data-help="computer.mail-rules"]')).to_have_count(0)
        watches = dialog.locator('[data-help="computer.watches"]')
        await expect(watches.get_by_text('1 active', exact=True)).to_be_visible()
        await expect(watches.get_by_text('Past watch finished', exact=True)).not_to_be_visible()
        chat_bounds = await dialog.locator('[data-help="chat.panel"]').bounding_box()
        assert chat_bounds and chat_bounds['height'] >= 200, chat_bounds
        await dialog.get_by_role('region', name='Computer settings and automations').evaluate('(el)=>el.scrollTop=0')
        await page.screenshot(path=str(ART / 'automation-active.png'), animations='disabled')
        await page.evaluate('''() => {
          const base={id:'legacy-active',ownerId:'voice',clusterId:'fixture-cluster',label:'Legacy active mail',memberIds:['fixture-builder'],workers:[{id:'fixture-builder',name:'Builder',nudges:1}],finalId:'fixture-director',finalName:'Director',status:'watching',reason:'Waiting for new mail.',createdAt:Date.now(),expiresAt:Date.now()+3600000,cooldownMs:30000,maxNudgesPerWorker:8};
          mailRuleStore.setState({rules:[base,{...base,id:'legacy-paused',paused:true,label:'Legacy paused mail'},...['finished','limited'].map(status=>({...base,id:`legacy-${status}`,status,paused:true,label:`Past legacy ${status}`}))]});
        }''')
        legacy = dialog.locator('[data-help="computer.mail-rules"]')
        await expect(legacy.get_by_text('1 active · 1 paused', exact=True)).to_be_visible()
        await expect(legacy.get_by_text('Past legacy limited', exact=True)).not_to_be_visible()
        await expect(legacy.get_by_role('button', name='Resume mailbox rule Legacy paused mail', exact=True)).to_be_visible()
        await page.set_viewport_size({'width': 900, 'height': 700})
        small_chat = await dialog.locator('[data-help="chat.panel"]').bounding_box()
        assert small_chat and small_chat['height'] >= 120, small_chat
        await page.set_viewport_size({'width': 1440, 'height': 1000})
        await script_history.locator(':scope > summary').click()
        await expect(scripts.get_by_text('These items have stopped and cannot run.', exact=True)).to_be_visible()
        await expect(scripts.get_by_text('Past script cancelled', exact=True)).to_be_visible()
        assert await script_history.get_by_role('button').count() == 0
        await script_history.locator(':scope > summary').click()
        await page.evaluate("activityStore.setState(s=>({snapshot:{...s.snapshot,policy:{enabled:false,agentUpdates:'off'}}}))")
        await expect(scripts.get_by_text('0 active · 3 paused', exact=True)).to_be_visible()
        await expect(scripts.get_by_text('Paused by the event automations switch.', exact=True)).to_have_count(3)
        await expect(watches.get_by_text('1 active', exact=True)).to_be_visible()
        await expect(legacy.get_by_text('0 active · 2 paused', exact=True)).to_be_visible()
        await page.evaluate('''() => {
          activityStore.setState(s=>({snapshot:{...s.snapshot,policy:{enabled:true,agentUpdates:'off'}}}));
          conditionStore.setState(s=>({rules:s.rules.map(r=>r.id==='unlimited-script'?{...r,status:'finished'}:r)}));
        }''')
        await expect(scripts.get_by_text('1 active · 1 paused', exact=True)).to_be_visible()
        await expect(scripts.get_by_text('Unlimited script', exact=True)).not_to_be_visible()
        await page.evaluate('''() => {
          activityStore.setState(s=>({snapshot:{...s.snapshot,policy:{enabled:true,agentUpdates:'off'}}}));
          conditionStore.setState({rules:window.scriptHistory});
          mailRuleStore.setState({rules:[]});
          watchStore.setState(s=>({watches:s.watches.map(w=>({...w,status:'finished'}))}));
        }''')
        await expect(scripts.get_by_text('0 active', exact=True)).to_be_visible()
        await expect(scripts.get_by_text('No active scripts.', exact=False)).to_be_visible()
        await expect(scripts.get_by_text('Past script expired', exact=True)).not_to_be_visible()
        await expect(watches.get_by_text('0 active', exact=True)).to_be_visible()
        await expect(watches.get_by_text('No active watches.', exact=False)).to_be_visible()
        await expect(legacy).to_have_count(0)
        await dialog.get_by_role('region', name='Computer settings and automations').evaluate('(el)=>el.scrollTop=0')
        await page.screenshot(path=str(ART / 'automation-history-only.png'), animations='disabled')
        await page.evaluate("conditionStore.setState({rules:[]});watchStore.setState({watches:[]});mailRuleStore.setState({rules:[]})")
        # Native controls follow actual font packs; code-specific fields keep their override.
        for pack in ['jetbrains-uniform', 'cinzel-lora-courier', 'inter-jetbrains']:
            fonts = await page.evaluate('''async (pack) => {
              const {applyTheme} = await import('/src/themes/apply.ts');
              const {THEME_REGISTRY} = await import('/src/themes/registry.ts');
              applyTheme(THEME_REGISTRY.arch, pack);
              const fixture = document.createElement('div');
              fixture.innerHTML = '<span style="font-family:var(--font-display)">Label</span><input><textarea></textarea><textarea style="font-family:var(--font-code)"></textarea><button>Test</button><select><optgroup label="Test"><option>Test</option></optgroup></select>';
              document.body.append(fixture);
              const family = el => getComputedStyle(el).fontFamily;
              const display = family(fixture.firstElementChild);
              const body = family(document.body);
              const code = family(fixture.children[3]);
              const defaults = [...fixture.querySelectorAll('button,select,optgroup,option')].map(family);
              const fields = [family(fixture.children[1]),family(fixture.children[2])];
              const controls = [...document.querySelectorAll('[role="dialog"][aria-labelledby="computer-title"] button,[role="dialog"][aria-labelledby="computer-title"] select')].map(family);
              fixture.remove();
              return {display,body,code,defaults,fields,controls};
            }''', pack)
            assert fonts['controls'] and all(f == fonts['display'] for f in fonts['controls']), (pack, fonts)
            assert all(f == fonts['display'] for f in fonts['defaults']), (pack, fonts)
            assert all(f == fonts['body'] for f in fonts['fields']), (pack, fonts)
            if pack == 'cinzel-lora-courier':
                assert len({fonts['display'],fonts['body'],fonts['code']}) == 3, fonts
        await page.evaluate('''async () => {
          const {applyTheme} = await import('/src/themes/apply.ts');
          const {THEME_REGISTRY} = await import('/src/themes/registry.ts');
          applyTheme(THEME_REGISTRY.arch);
        }''')
        await page.screenshot(path=str(ART / 'computer-panel.png'), animations='disabled')
        await page.evaluate("testStore.getState().addMessage('voice', {id:'compaction',role:'system',content:'[codex] Thread context was compacted internally.',timestamp:Date.now(),isStreaming:false})")
        await expect(dialog.get_by_text('Last Codex compaction:', exact=False)).to_be_visible()
        await dialog.get_by_label('Keep Computer context').click()
        await expect(dialog.get_by_label('Keep Computer context')).to_be_checked()
        await expect(dialog.get_by_text('Keeping this context for follow-ups.', exact=False)).to_be_visible()
        await dialog.get_by_label('Computer fresh-context threshold').select_option('25')
        await expect(dialog.get_by_label('Computer fresh-context threshold')).to_have_value('25')
        await dialog.get_by_role('button', name='CLEAR CONTEXT', exact=True).click()
        await expect(dialog.get_by_text('CONTEXT 0.0%', exact=True)).to_be_visible()
        await expect(dialog.get_by_text('Strata runs your models locally and remembers your selected profile.', exact=True)).to_be_visible()
        await dialog.get_by_role('button', name='Close Computer').click()
        sizes = await page.evaluate('''() => {
          const style = el => {const s=getComputedStyle(el); return [el.getBoundingClientRect().height,s.fontFamily,s.fontSize,s.padding];};
          return [style(document.querySelector('button[aria-label="Hands-free voice controls"]')),style([...document.querySelectorAll('header button')].find(el=>el.textContent.trim()==='COMPUTER'))];
        }''')
        assert sizes[0] == sizes[1], sizes

        # A link to the saved thread opens the panel without selecting it.
        await page.evaluate("testStore.getState().setActiveJob('voice')")
        await expect(dialog).to_be_visible()
        assert await page.evaluate('testStore.getState().activeJobId') == 'project'
        await dialog.get_by_role('button', name='VOICE CONTROLS').click()
        await expect(dialog).to_have_count(0)
        await expect(page.get_by_role('button', name='ENABLE HANDS-FREE', exact=True)).to_be_visible()
        assert await page.evaluate('window.micCalls') == 0

        controls = page.get_by_role('complementary', name='Hands-free controls')
        await page.evaluate("voiceStore.setState({status:'Computer is working on it…'})")
        await expect(controls.locator('[role="status"][aria-live="polite"]')).to_contain_text('Computer is idle.')
        await expect(controls.get_by_role('button', name='OPEN COMPUTER', exact=True)).to_be_visible()
        await page.evaluate("testStore.setState(s=>({jobs:{...s.jobs,voice:{...s.jobs.voice,busy:true,computerTurnActive:true}}}))")
        await expect(controls.locator('[role="status"][aria-live="polite"]')).to_have_text('Computer is working on it…')
        await expect(controls.get_by_role('button', name='STOP REQUEST', exact=True)).to_be_visible()
        await page.evaluate("testStore.setState(s=>({jobs:{...s.jobs,voice:{...s.jobs.voice,busy:false,computerTurnActive:false}}}))")
        await expect(controls.locator('[role="status"][aria-live="polite"]')).to_contain_text('Computer is idle.')
        await expect(controls.get_by_role('button', name='STOP REQUEST', exact=True)).to_have_count(0)
        picker = controls.get_by_label('Computer reply voice')
        await expect(picker.locator('option')).to_have_count(25)
        await expect(picker.locator('optgroup')).to_have_count(14)
        labels = await picker.locator('optgroup option').all_text_contents()
        assert all(' · ' in label for label in labels), labels
        # Every listed voice is selectable, including the newly added accents.
        for voice_id in await picker.locator('optgroup option').evaluate_all('(els)=>els.map(el=>el.value)'):
            await picker.select_option(voice_id)
            assert await page.evaluate('voiceStore.getState().outputVoice') == voice_id
        await picker.select_option('en-US-JennyNeural')
        await controls.get_by_role('button', name='LISTEN', exact=True).click()
        await page.wait_for_timeout(250)
        assert previews == [{'voice': 'en-US-JennyNeural'}], previews
        assert await page.evaluate('window.micCalls') == 0
        assert '/api/voice/session' not in writes
        await page.evaluate("voiceStore.setState({enabled:true,phase:'listening',commandText:'keep this directive'})")
        await picker.select_option('en-CA-ClaraNeural')
        assert await page.evaluate('voiceStore.getState().commandText') == 'keep this directive'
        assert await page.evaluate('voiceStore.getState().enabled') is True
        await expect(controls.get_by_role('button', name='LISTEN', exact=True)).to_be_disabled()
        for font in ['"Courier New", monospace', 'Verdana, sans-serif']:
            await page.evaluate('(font) => document.documentElement.style.setProperty("--font-display",font)', font)
            fonts = await controls.locator('button,select').evaluate_all('(els)=>els.map(el=>getComputedStyle(el).fontFamily)')
            assert all(f == font for f in fonts), fonts
        await page.screenshot(path=str(ART / 'voice-picker.png'), animations='disabled')
        await page.evaluate("voiceStore.setState({enabled:false,phase:'off',commandText:null})")

        # A queued model/privacy switch waits for the authoritative clean boundary.
        await header.click()
        await page.evaluate('''() => {
          testStore.setState({authStatus:{...testStore.getState().authStatus,ollama:{installed:true,loggedIn:true,installedModels:['qwen-fixture']},strata:{installed:true,loggedIn:true,installedModels:['strata-fixture']}}});
          computerStore.setState({activeId:'voice'});
          testStore.setState(s=>({jobs:{...s.jobs,voice:{...s.jobs.voice,busy:true,computerTurnActive:true}}}));
        }''')
        await dialog.get_by_label('Computer provider', exact=True).select_option('ollama')
        await dialog.get_by_label('Computer history mode', exact=True).select_option('none')
        await dialog.get_by_role('button', name='USE AGENT', exact=True).click()
        await expect(dialog.get_by_text('Switch requested:', exact=False)).to_be_visible()
        assert created_ids == [], created_ids
        # A per-provider ended event is too early: a queued follow-up can still run.
        await page.evaluate("testStore.setState(s=>({jobs:{...s.jobs,voice:{...s.jobs.voice,busy:false}}}))")
        await page.wait_for_timeout(100)
        assert created_ids == [], created_ids
        await page.evaluate("testStore.setState(s=>({jobs:{...s.jobs,voice:{...s.jobs.voice,computerTurnActive:false}}}))")
        await expect(dialog.get_by_text('NO HISTORY', exact=True)).to_be_visible()
        assert len(created_ids) == 1, created_ids
        private_id = created_ids[0]
        await expect(dialog.get_by_label('Computer fresh-context threshold')).to_have_value('75')
        await page.evaluate('''(id) => {
          testStore.getState().addMessage(id,{id:'private-marker',role:'user',content:'PRIVATE_BROWSER_SENTINEL_93471',timestamp:Date.now(),isStreaming:false});
          window.dispatchEvent(new Event('pagehide'));
        }''', private_id)
        assert 'PRIVATE_BROWSER_SENTINEL_93471' not in await page.evaluate('JSON.stringify(localStorage)')
        await dialog.get_by_role('button', name='CLEAR CONTEXT', exact=True).click()
        await expect(dialog.get_by_text('PRIVATE_BROWSER_SENTINEL_93471')).to_have_count(0)
        # Unsupported private backends cannot silently downgrade to saved history.
        await dialog.get_by_label('Computer provider', exact=True).select_option('strata')
        await expect(dialog.get_by_role('button', name='USE AGENT', exact=True)).to_be_disabled()
        await expect(dialog.get_by_text('Strata’s standalone service keeps logs/cache.', exact=False)).to_be_visible()
        # Restore Luna's separate saved history; private content must not follow it.
        await dialog.get_by_label('Computer provider', exact=True).select_option('codex')
        await dialog.get_by_label('Computer history mode', exact=True).select_option('saved')
        await dialog.get_by_role('button', name='USE AGENT', exact=True).click()
        await expect(dialog.get_by_text('SAVED HISTORY', exact=True)).to_be_visible()
        assert await page.evaluate('computerStore.getState().activeId') == 'voice'
        assert await page.evaluate('(id)=>!!testStore.getState().jobs[id]', private_id) is False
        await expect(dialog.get_by_text('Strata runs your models locally and remembers your selected profile.', exact=True)).to_be_visible()
        await dialog.get_by_role('button', name='Close Computer').click()

        # Existing builds saved Computer as an active tab; replay that state.
        await page.evaluate('''() => {
          testStore.setState({activeJobId:'voice',activeClusterId:null,showCreator:false});
          window.dispatchEvent(new Event('pagehide'));
        }''')
        await page.reload()
        await page.wait_for_timeout(700)
        restored = await page.evaluate('''async () => {
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          return {active:s.getState().activeJobId, history:s.getState().jobs.voice?.messages.some(m => m.id === 'answer')};
        }''')
        assert restored == {'active': 'project', 'history': True}, restored
        voice_pref = await page.evaluate('''async () => {
          const {useVoiceStore:v} = await import('/src/voice/store.ts');
          return {voice:v.getState().outputVoice,enabled:v.getState().enabled};
        }''')
        assert voice_pref == {'voice':'en-CA-ClaraNeural','enabled':False}, voice_pref
        await header.click()
        await expect(dialog.get_by_text('Strata runs your models locally and remembers your selected profile.', exact=True)).to_be_visible()
        assert await page.evaluate('window.micCalls') == 0
        assert [m['content'] for m in messages if m.get('type') == 'user_message'] == ['Use twenty turns for all SignalQueue workers.'], messages
        assert len([m for m in messages if m.get('type') == 'create_workflow']) == 1, messages
        assert [path for path in writes if path.startswith('/api/voice/') and path != '/api/voice/activity'] == ['/api/voice/preview'], writes
        assert not errors, errors
        await browser.close()
    print('PASS: Typed Computer request + browser tool with mic off, retained draft, Stop through settlement, stale working status cleared, automation history and controls, transcript space on smaller viewports, voice choices, saved/private context boundaries; zero microphone/provider calls.')


asyncio.run(main())
