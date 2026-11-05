"""AUTO-PICKUP modes: chip, dialog, evaluator choice, limits and one-click off.

Renders the cluster tab with isolated snapshots; every WebSocket send is
captured instead of reaching a server. No provider calls.
"""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path, fs_url

PORT = os.environ.get('ARCO_CLIENT_PORT', '5211')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/styles/matrix.css"><link rel="stylesheet" href="/src/themes/phosphor/phosphor.css"></head><body><div id="fixture"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''
CAPABILITIES = [
    {'provider': 'claude', 'available': True},
    {'provider': 'codex', 'available': False, 'reason': 'Codex can run shell commands during any request.'},
    {'provider': 'cursor', 'available': True},
    {'provider': 'ollama', 'available': True},
]
LIMITS = {'maxInFlight': 1, 'callsPerClusterHour': 12, 'callsPerMemberHour': 3, 'wakesPerMemberHour': 3, 'wakesPerSession': 12,
          'sessionMinutes': 30, 'timeoutSeconds': 30, 'maxInputBytes': 12288, 'maxOutputTokens': 64}


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1500, 'height': 900})
        # This suite checks controls in the Standard layout; layout-ranges-browser.py covers the other layouts.
        await page.add_init_script("localStorage.setItem('arco.layoutMode', 'standard')")
        blocked, errors = [], []

        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'https' and url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(status=200, content_type='text/css', body='')
                return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and route.request.method == 'GET':
                if url.path == '/api/smart-pickup/evaluators':
                    await route.fulfill(json={'evaluators': CAPABILITIES})
                    return
                if url.path == '/api/outputs':
                    await route.fulfill(json={'outputs':[]})
                    return
                if url.path == '/api/project-trust':
                    await route.fulfill(json={'trusted': False})
                    return
                if url.path == '/fixture':
                    await route.fulfill(status=200, content_type='text/html', body=HTML)
                    return
                is_local_fs = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if is_local_fs or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/', '/phosphor-demo/', '/themes/victor-mono/')):
                    await route.continue_()
                    return
            blocked.append(url.path)
            await route.abort()

        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true', timeout=10000)
        await page.evaluate('''async (limits) => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ClusterTab} = await import('/src/components/ClusterTab.tsx');
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          const {useStartupStore:st} = await import('/src/stores/startupStore.ts');
          const {handleServerMessage:receive} = await import('/src/ws/handleServerMessage.ts');
          window.s=s; window.st=st; window.sent=[]; window.toggles=[];
          s.setState({connected:true, wsSendRaw:(m)=>{window.sent.push(m);return true;},
            settings:{enabledProviders:{claude:true,codex:false,cursor:true,ollama:true}},
            authStatus:{claude:{loggedIn:true},codex:{loggedIn:true},cursor:{loggedIn:true},ollama:{loggedIn:false,installedModels:[]}}});
          const members=[{workflowId:'worker-a',displayName:'Alpha',status:'idle'},{workflowId:'worker-b',displayName:'Beta',status:'idle'}];
          for (const m of members) s.getState().createJob(m.workflowId,{name:m.displayName,workingDirectory:'/projects/fixture',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',skipPermissions:false});
          window.snapshot=(extra)=>receive({type:'cluster_state',clusterId:'cluster-a',state:{clusterId:'cluster-a',cwd:'/projects/fixture',createdAt:'',taskBoardMode:'none',taskBoardAttached:false,mailboxDepth:{},members,...extra}},{wsRef:{current:null},scheduleReconnect:()=>{}});
          window.emitPause=()=>receive({type:'cluster_auto_turn_fired',clusterId:'cluster-a',workflowId:'worker-a',sender:'worker-b',chainDepth:4,reason:'mailbox_arrival',fired:true,notice:'Alternating wakes paused between Alpha and Beta.'},{wsRef:{current:null},scheduleReconnect:()=>{}});
          window.limits=limits;
          const root=createRoot(document.getElementById('fixture'));
          window.show=()=>root.render(React.createElement('div',{style:{display:'flex',width:'100%',height:'850px'}},React.createElement(ClusterTab,{clusterId:'cluster-a',onSendToMember:()=>true,onCancelMember:()=>{},onCancelQueuedForMember:()=>{},onUpload:async()=>null,onToggleIdleNudger:()=>{},onToggleAutoTurn:(...a)=>toggles.push(a)})));
          snapshot({autoTurnOnMailboxEnabled:true}); show();
        }''', LIMITS)

        chip = page.locator('button[data-help="cluster.auto-turn"]')
        # A cluster saved before modes existed (only the boolean) reads as Rule-based.
        await expect(chip).to_have_text('RULE')
        await expect(chip).to_have_accessible_name('AUTO-PICKUP: Rule-based')
        await chip.click()
        rule_dialog = page.get_by_role('dialog', name='AUTO-PICKUP')
        await expect(rule_dialog.get_by_text('Advanced: model-assisted')).to_be_visible()
        # The heading sits above the Smart: Observe-only radio, which stays on
        # the same line as its label and does not take the heading as its name.
        observe_radio = rule_dialog.get_by_role('radio', name='Smart: Observe-only', exact=False)
        assert 'Advanced' not in (await observe_radio.evaluate('el => el.closest("label").textContent'))
        measure = """d => {
          const heading = d.querySelector('[data-testid="auto-pickup-advanced-heading"]').getBoundingClientRect();
          const radio = d.querySelector('input[value="smart-observe"]');
          const r = radio.getBoundingClientRect();
          const name = radio.closest('label').querySelector('strong').getBoundingClientRect();
          return {headingBottom: heading.bottom, radioTop: r.top, radioMid: (r.top + r.bottom) / 2, nameTop: name.top, nameBottom: name.bottom};
        }"""
        # At 100% and at 150% interface scale (bootstrap.ts sets zoom and --ui-scale).
        for scale in ('1', '1.5'):
            await page.evaluate("s => { document.documentElement.style.zoom = s; document.documentElement.style.setProperty('--ui-scale', s); }", scale)
            layout = await rule_dialog.evaluate(measure)
            assert layout['headingBottom'] <= layout['radioTop'] + 0.5, (scale, layout)
            assert layout['nameTop'] <= layout['radioMid'] <= layout['nameBottom'], (scale, layout)
        await page.evaluate("() => { document.documentElement.style.zoom = ''; document.documentElement.style.removeProperty('--ui-scale'); }")
        await expect(rule_dialog.get_by_text('Rule-based limits')).to_be_visible()
        pair_limit = rule_dialog.get_by_label('Alternating wakes before pause (2 to 10 wakes)')
        await pair_limit.fill('7')
        await rule_dialog.get_by_role('button', name='RESET LIMITS').click()
        await expect(pair_limit).to_have_value('4')
        await pair_limit.fill('5')
        await rule_dialog.get_by_label('Automatic wakes per member (1 to 30 per hour)').fill('9')
        await rule_dialog.get_by_label('Automatic wakes per arming (5 to 200 wakes)').fill('50')
        await rule_dialog.get_by_label('Maximum chain depth (1 to 20 depth)').fill('10')
        await rule_dialog.get_by_role('button', name='APPLY', exact=True).click()
        assert (await page.evaluate('sent.at(-1)'))['ruleLimits'] == {'pingPongWakes': 5, 'wakesPerMemberHour': 9, 'wakesPerArming': 50, 'maxChainDepth': 10}
        await page.evaluate('emitPause()')
        assert await page.evaluate("s.getState().notifications.some(n => n.message.includes('Alternating wakes paused between Alpha and Beta.'))")
        await page.evaluate("snapshot({autoPickup:{mode:'rule',limits,ruleStatus:{wakes:40,budgetPaused:true}}})")
        await page.get_by_role('button', name='RESUME', exact=True).click()
        assert await page.evaluate('sent.at(-1)') == {'type':'cluster_auto_pickup_set','clusterId':'cluster-a','mode':'rule','resumeRule':True}
        off = page.get_by_role('button', name='Turn AUTO-PICKUP off', exact=True)
        await off.click()
        assert await page.evaluate('sent.at(-1)') == {'type': 'cluster_auto_pickup_set', 'clusterId': 'cluster-a', 'mode': 'off'}
        await page.evaluate("snapshot({autoPickup:{mode:'off',limits}})")
        await expect(chip).to_have_text('OFF')
        await expect(off).to_have_count(0)

        # First Smart arming: nothing preselected, only enabled and connected supported providers.
        await chip.click()
        dialog = page.get_by_role('dialog', name='AUTO-PICKUP')
        await expect(dialog).to_be_visible()
        await expect(dialog.get_by_role('radio', name='Off')).to_be_checked()
        await dialog.get_by_role('radio', name='Smart: Observe-only').check()
        await expect(dialog.get_by_text('a large or high-effort model adds cost without benefit', exact=False)).to_be_visible()
        provider = dialog.get_by_label('Evaluator provider')
        await expect(provider).to_have_value('')
        assert await provider.locator('option').all_inner_texts() == ['Choose a provider', 'Claude', 'Cursor'], 'Codex disabled, Ollama not connected'
        await expect(dialog.get_by_label('Providers that cannot evaluate')).to_contain_text('Codex: Codex can run shell commands during any request.')
        arm = dialog.get_by_role('button', name='ARM OBSERVE-ONLY', exact=True)
        await expect(arm).to_be_disabled()
        await expect(dialog.get_by_role('alert')).to_have_text('Choose an evaluator provider and model.')
        await provider.select_option('cursor')
        model = dialog.get_by_label('Evaluator model')
        await expect(model).to_have_value('')
        await model.select_option('auto')
        # Limits: an out-of-range value blocks arming; only changed limits are sent.
        await dialog.get_by_text('LIMITS', exact=True).click()
        session = dialog.get_by_label('Armed session length (5 to 480 minutes)')
        await session.fill('1000')
        await expect(arm).to_be_disabled()
        await expect(dialog.get_by_role('alert')).to_have_text('Each limit must be a whole number within its range.')
        await session.fill('45')
        await expect(arm).to_be_enabled()
        sends_before = await page.evaluate('sent.length')
        await arm.click()
        await expect(dialog).to_have_count(0)
        assert await page.evaluate('sent.length') == sends_before + 1
        assert await page.evaluate('sent.at(-1)') == {'type': 'cluster_auto_pickup_set', 'clusterId': 'cluster-a', 'mode': 'smart-observe',
                                                      'evaluator': {'provider': 'cursor', 'model': 'auto'}, 'limits': {'sessionMinutes': 45}}

        # Armed state: chip, counters, last decision; the last choice is offered again.
        await page.evaluate('''() => snapshot({autoPickup:{mode:'smart-observe',limits:{...limits,sessionMinutes:45},evaluator:{provider:'cursor',model:'auto'},lastEvaluator:{provider:'cursor',model:'auto'},
          session:{id:'s1',armedAt:Date.now(),expiresAt:Date.now()+45*60000},counters:{inFlight:0,callsLastHour:2,callsThisSession:2,wakesLastHour:0,wakesThisSession:0},
          lastDecision:{at:Date.now(),recipientWorkflowId:'worker-a',action:'defer',reason:'acknowledgment_only',outcome:'logged'}}})''')
        await expect(chip).to_have_text('OBSERVE · 0/12')
        await chip.click()
        await expect(dialog.get_by_role('radio', name='Smart: Observe-only')).to_be_checked()
        await expect(provider).to_have_value('cursor')
        await expect(model).to_have_value('auto')
        status = dialog.get_by_label('AUTO-PICKUP status')
        await expect(status).to_contain_text('Evaluator requests: 2 this session, 2 in the last hour, 0 in progress.')
        await expect(status).to_contain_text('answered defer (acknowledgment only), logged')
        await page.evaluate('''() => snapshot({autoPickup:{mode:'smart-observe',limits:{...limits,sessionMinutes:45},evaluator:{provider:'cursor',model:'auto'},lastEvaluator:{provider:'cursor',model:'auto'},
          session:{id:'s1',armedAt:Date.now(),expiresAt:Date.now()+45*60000},counters:{inFlight:0,callsLastHour:2,callsThisSession:2,wakesLastHour:0,wakesThisSession:0},
          lastDecision:{at:Date.now(),recipientWorkflowId:'worker-a',action:null,reason:'evaluator_error:model_not_loaded_llamacpp',outcome:'none'}}})''')
        await expect(status).to_contain_text('model not loaded in llama.cpp; load it or choose another')
        # Automatic is its own explicit choice with its own button.
        await dialog.get_by_role('radio', name='Smart: Automatic').check()
        await expect(dialog.get_by_role('button', name='ARM AUTOMATIC', exact=True)).to_be_enabled()
        await dialog.get_by_role('button', name='CANCEL', exact=True).click()
        await expect(dialog).to_have_count(0)
        assert await page.evaluate('sent.length') == sends_before + 1, 'CANCEL sends nothing'

        # A last choice whose provider is no longer connected is not offered.
        await page.evaluate("s.setState(st=>({authStatus:{...st.authStatus,cursor:{loggedIn:false}}}))")
        await chip.click()
        await expect(provider).to_have_value('')
        await page.keyboard.press('Escape')
        await expect(dialog).to_have_count(0)

        # No supported provider connected: explained, with Connections.
        await page.evaluate("s.setState(st=>({authStatus:{...st.authStatus,claude:{loggedIn:false}}}))")
        await chip.click()
        await expect(dialog.get_by_role('status')).to_contain_text('No provider that can evaluate is enabled and connected.')
        await expect(dialog.get_by_role('alert')).to_have_text('Connect an evaluator provider first.')
        await expect(dialog.get_by_role('button', name='ARM OBSERVE-ONLY', exact=True)).to_be_disabled()
        await dialog.get_by_role('button', name='Open Connections', exact=True).click()
        assert await page.evaluate('st.getState().setupOpen') is True
        await page.evaluate('st.setState({setupOpen:false})')
        await page.keyboard.press('Escape')

        # A connected provider the server reports as unable to evaluate is not offered.
        await page.evaluate("s.setState(st=>({authStatus:{...st.authStatus,claude:{loggedIn:true},cursor:{loggedIn:true}}}))")
        CAPABILITIES[0] = {'provider': 'claude', 'available': False, 'reason': 'Needs Claude Native sign-in.'}
        await chip.click()
        await expect(provider).to_have_value('cursor')
        assert await provider.locator('option').all_inner_texts() == ['Choose a provider', 'Cursor']
        await expect(dialog.get_by_label('Providers that cannot evaluate')).to_contain_text('Claude: Needs Claude Native sign-in.')
        await page.keyboard.press('Escape')

        # One click turns a Smart session off.
        await page.get_by_role('button', name='Turn AUTO-PICKUP off', exact=True).click()
        assert await page.evaluate('sent.at(-1)') == {'type': 'cluster_auto_pickup_set', 'clusterId': 'cluster-a', 'mode': 'off'}
        assert await page.evaluate('toggles.length') == 0, 'the legacy toggle is not used'

        # Local evaluators are offered only while connected and use their discovered models.
        CAPABILITIES.extend({'provider': p, 'available': True} for p in ('lmstudio', 'llamacpp', 'strata', 'deepseek'))
        await page.evaluate("""() => {
          s.setState(st => ({settings:{...st.settings,enabledProviders:{...st.settings.enabledProviders,lmstudio:true,llamacpp:true,strata:true,deepseek:true}},
            authStatus:{...st.authStatus,lmstudio:{loggedIn:true,installedModels:['lms-fixture']},llamacpp:{loggedIn:true,installedModels:['llama-fixture']},strata:{loggedIn:true,installedModels:['strata-fixture']},deepseek:{loggedIn:true,installedModels:['deepseek-fixture']}}}));
          snapshot({autoPickup:{mode:'off',limits}});
        }""")
        await chip.click()
        await dialog.get_by_role('radio', name='Smart: Observe-only').check()
        for provider_id, model_id in [('lmstudio', 'lms-fixture'), ('llamacpp', 'llama-fixture'), ('strata', 'strata-fixture'), ('deepseek', 'deepseek-fixture')]:
            await provider.select_option(provider_id)
            assert model_id in await model.locator('option').all_text_contents()
        await page.keyboard.press('Escape')

        assert not blocked, blocked
        assert not errors, errors
        await browser.close()
        print('PASS auto-pickup: legacy Rule-based chip, one-click off, Smart arming with no preselection and connected supported providers only, bounded limits, changed limits only, counters and last decision, last choice re-offered only while connected, Connections when none')

asyncio.run(main())
