"""FORWARD on selected chat messages and the SEND TRANSCRIPT note, recipients and include switches."""
import asyncio
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path, fs_url
from host_isolation import chrome_executable

PORT = os.environ.get('ARCO_CLIENT_PORT', '5203')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/styles/matrix.css"><link rel="stylesheet" href="/src/themes/phosphor/phosphor.css"></head><body><div id="fixture"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page(viewport={'width': 1300, 'height': 1100}, has_touch=True)
        blocked, errors = [], []
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'https' and url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(status=200, content_type='text/css', body='')
                return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and route.request.method == 'GET':
                if url.path == '/fixture':
                    await route.fulfill(status=200, content_type='text/html', body=HTML)
                    return
                if url.path.startswith('/api/'):
                    await route.fulfill(json={'models': []}); return
                is_local_fs = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if is_local_fs or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/', '/phosphor-demo/', '/themes/', '/backgrounds/')):
                    await route.continue_()
                    return
            blocked.append(url.path)
            await route.abort()
        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true', timeout=10000)
        await page.evaluate('''async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ChatMessage} = await import('/src/components/ChatMessage.tsx');
          const {MessageSelectionBar, ForwardDialog} = await import('/src/components/ForwardMessages.tsx');
          const {TranscriptSendDialog} = await import('/src/components/TranscriptSendDialog.tsx');
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          const {handleServerMessage:receive} = await import('/src/ws/handleServerMessage.ts');
          window.sends = [];
          s.getState().createJob('wf-a',{name:'Alpha',workingDirectory:'/projects/fixture',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',skipPermissions:false});
          receive({type:'cluster_state',clusterId:'cl-1',state:{clusterId:'cl-1',cwd:'/projects/fixture',createdAt:'',taskBoardMode:'none',taskBoardAttached:false,mailboxDepth:{},members:[
            {workflowId:'wf-a',displayName:'Alpha',status:'idle'},{workflowId:'wf-b',displayName:'Beta',status:'idle'},{workflowId:'wf-c',displayName:'Gamma',status:'idle'}],idleNudgerEnabled:false}},{wsRef:{current:null},scheduleReconnect:()=>{}});
          receive({type:'peer_message_received',workflowId:'wf-a',msgId:'in',from:'wf-b',fromName:'Beta',content:'Beta says the fix looks right '+ 'x'.repeat(240)+'\\nReceived ending',ts:3},{wsRef:{current:null},scheduleReconnect:()=>{}});
          receive({type:'peer_message_sent',workflowId:'wf-a',msgId:'out',from:'wf-a',to:'wf-b',contentPreview:'Thanks Beta, landing now (shortened ec...',ts:4},{wsRef:{current:null},scheduleReconnect:()=>{}});
          receive({type:'peer_message_sent',workflowId:'wf-a',msgId:'out',from:'wf-a',to:'wf-b',contentPreview:'Thanks Beta, landing now (shortened ec...',content:'Thanks Beta, landing now (shortened echo)\\nThe full second line remains available.',ts:4},{wsRef:{current:null},scheduleReconnect:()=>{}});
          const peerRows=s.getState().jobs['wf-a'].messages;
          const messages = [
            {id:'m1',role:'user',content:'Please fix the login bug',isStreaming:false,timestamp:1},
            {id:'m2',role:'assistant',content:'Found it: the token is never refreshed.',isStreaming:false,timestamp:2},
            ...peerRows,
          ];
          function Harness() {
            const [dialog, setDialog] = React.useState('none');
            const cluster = useAppStoreCluster();
            return React.createElement('div', null,
              ...messages.map(m => React.createElement(ChatMessage, {key:m.id, message:m, jobId:'wf-a', jobCwd:'/projects/fixture'})),
              React.createElement(MessageSelectionBar, {jobId:'wf-a', onForward: () => setDialog('forward')}),
              React.createElement('button', {onClick: () => setDialog('transcript')}, 'OPEN TRANSCRIPT'),
              dialog === 'forward' && React.createElement(ForwardDialog, {cluster, fromWorkflowId:'wf-a', messages, onConfirm:(to,content)=>{window.sends.push({kind:'forward',to,content}); setDialog('none');}, onCancel:()=>setDialog('none')}),
              dialog === 'transcript' && React.createElement(TranscriptSendDialog, {cluster, fromWorkflowId:'wf-a', messages, onConfirm:(to,content)=>{window.sends.push({kind:'transcript',to,content}); setDialog('none');}, onCancel:()=>setDialog('none')}));
          }
          function useAppStoreCluster() { return s(st => st.clusters['cl-1']); }
          createRoot(document.getElementById('fixture')).render(React.createElement(Harness));
        }''')
        boxes = page.get_by_test_id('message-select')
        await expect(boxes).to_have_count(4)
        await expect(page.get_by_test_id('message-selection-bar')).to_have_count(0)

        # Read both directions, keeping sent previews and the original line breaks.
        sent = page.get_by_role('button', name='Open peer message sent to Beta', exact=True)
        await sent.focus(); await page.keyboard.press('Enter')
        mail = page.get_by_role('dialog', name='Peer message', exact=True)
        await expect(mail).to_contain_text('The full second line remains available.')
        await expect(mail).to_contain_text('From: Alpha')
        await expect(mail).to_contain_text('To: Beta')
        assert '\nThe full second line' in await mail.inner_text()
        await page.keyboard.press('Escape'); await expect(sent).to_be_focused()
        received = page.get_by_role('button', name='Open peer message from Beta', exact=True)
        await expect(received).not_to_contain_text('Received ending')
        await received.tap()
        mail = page.get_by_role('dialog', name='Peer message', exact=True)
        await expect(mail).to_contain_text('Beta says the fix looks right')
        await expect(mail).to_contain_text('Received ending')
        await mail.get_by_role('button', name='CLOSE', exact=True).click()

        # FORWARD two messages to two members with a note.
        await boxes.nth(0).click()
        await boxes.nth(1).click()
        bar = page.get_by_test_id('message-selection-bar')
        await expect(bar).to_contain_text('2 SELECTED')
        await bar.get_by_role('button', name='FORWARD').click()
        dlg = page.get_by_role('dialog', name='Forward messages')
        await expect(dlg).to_be_visible()
        preview = dlg.get_by_test_id('forward-preview')
        await expect(preview).to_contain_text('Please fix the login bug')
        await expect(preview).to_contain_text('the token is never refreshed')
        await expect(preview).not_to_contain_text('Beta says')
        await expect(dlg.get_by_role('button', name='SEND', exact=True)).to_be_disabled()
        await dlg.get_by_label('Forward to Beta').click()
        await dlg.get_by_label('Forward to Gamma').click()
        await dlg.get_by_label('Covering note').fill('Please take over from here')
        await expect(preview).to_contain_text('Please take over from here')
        await dlg.get_by_role('button', name='SEND TO 2').click()
        sends = await page.evaluate('sends')
        assert len(sends) == 1 and sends[0]['kind'] == 'forward' and sends[0]['to'] == ['wf-b', 'wf-c'], sends
        assert sends[0]['content'].startswith('Please take over from here'), sends[0]['content']
        assert 'Forwarded by the operator from Alpha' in sends[0]['content'], sends[0]['content']

        # SEND TRANSCRIPT: several recipients, note, include switches, shortened echoes off by default.
        await page.evaluate('sends.length = 0')
        await page.get_by_role('button', name='OPEN TRANSCRIPT').click()
        dlg = page.get_by_role('dialog').last
        await dlg.get_by_label('Send to Beta').click()
        await dlg.get_by_label('Send to Gamma').click()
        await dlg.get_by_label('Full transcript').click()
        pre = dlg.locator('pre')
        await expect(pre).to_contain_text('Please fix the login bug')
        await expect(pre).to_contain_text('Beta says the fix looks right')
        await expect(pre).not_to_contain_text('landing now')
        await dlg.get_by_label('Shortened copies of mail sent').click()
        await expect(pre).to_contain_text('landing now')
        await dlg.get_by_label('Shortened copies of mail sent').click()
        await dlg.get_by_label('Operator messages').click()
        await expect(pre).not_to_contain_text('Please fix the login bug')
        await dlg.get_by_label('Mail lines').click()
        await expect(pre).not_to_contain_text('Beta says')
        await expect(pre).to_contain_text('the token is never refreshed')
        await dlg.get_by_label('Covering note').fill('For the record')
        await expect(pre).to_contain_text('For the record')
        await dlg.get_by_role('button', name='SEND TO 2').click()
        sends = await page.evaluate('sends')
        assert len(sends) == 1 and sends[0]['to'] == ['wf-b', 'wf-c'] and sends[0]['content'].startswith('For the record'), sends
        assert 'Please fix' not in sends[0]['content'] and 'landing now' not in sends[0]['content'], sends

        # One new-worker journey, with a server-owned preview and retained draft
        # after a stale-snapshot refusal. Existing member sends above stay intact.
        await page.set_viewport_size({'width': 650, 'height': 1000})
        await page.evaluate('''async () => {
          const {useAppStore:s}=await import('/src/stores/appStore.ts'); window.s=s;
          const {handleServerMessage:receive}=await import('/src/ws/handleServerMessage.ts');
          (await import('/src/themes/apply.ts')).applyTheme((await import('/src/themes/registry.ts')).getTheme('arch'));
          document.documentElement.style.zoom='1.1';document.documentElement.style.setProperty('--ui-scale','1.1');
          window.workerRequests=[];let createCount=0;
          s.setState({connected:true,connectionState:'online',settings:{enabledProviders:{claude:false,codex:true,cursor:false,ollama:false,llamacpp:false,lmstudio:false,strata:false,deepseek:false}},authStatus:{claude:{loggedIn:false},codex:{loggedIn:true}},wsSendRaw:message=>{
            workerRequests.push(message);
            if(message.type==='transcript_worker_preview'){
              const seed=message.preface+'\\n\\nSource project: /projects/fixture\\nUSER: "Stored request"\\nAGENT: "Stored reply not loaded in this browser"';
              receive({type:'transcript_worker_result',requestId:message.requestId,preview:{token:'preview-'+workerRequests.length,seed,bytes:new TextEncoder().encode(seed).length,availableTurns:1,selectedTurns:1,partialIncluded:false,cutoffSeq:8}},{wsRef:{current:null},scheduleReconnect:()=>{}});
            }
            if(message.type==='transcript_worker_create'){
              if(!createCount++)receive({type:'transcript_worker_result',requestId:message.requestId,error:'The source history changed. Refresh the preview.'},{wsRef:{current:null},scheduleReconnect:()=>{}});
              else {
                s.getState().createJob('new-worker',{kind:'workflow',name:message.destination.name,workingDirectory:message.destination.workingDirectory,primaryProvider:message.destination.provider,primaryModel:message.destination.model,primaryEffort:message.destination.effort,skipPermissions:false});
                receive({type:'transcript_worker_result',requestId:message.requestId,newWorkflowId:'new-worker'},{wsRef:{current:null},scheduleReconnect:()=>{}});
              }
            }
          }});
        }''')
        await page.get_by_role('button', name='OPEN TRANSCRIPT').click()
        await page.get_by_role('dialog', name='Send transcript').get_by_role('button', name='NEW WORKER', exact=True).tap()
        worker = page.get_by_role('dialog', name='Send turns to a new worker', exact=True)
        await expect(worker.get_by_label('New worker provider')).to_have_value('claude')
        await expect(worker).to_contain_text('Claude is not ready')
        await worker.get_by_label('New worker provider').select_option('codex')
        await expect(worker.get_by_label('Turns to copy')).to_have_value('3')
        await expect(worker.get_by_role('button', name='SEND TO NEW WORKER', exact=True)).to_be_disabled()
        await worker.get_by_label('New worker preface').fill('x' * 4097)
        await expect(worker.get_by_label('New worker preface')).to_have_value('x' * 4097)
        await expect(worker.get_by_role('button', name='PREVIEW', exact=True)).to_be_disabled()
        await worker.get_by_label('New worker preface').fill('Use the copied decision.')
        await worker.get_by_label('New worker working directory').fill('/projects/another-fixture')
        await worker.get_by_role('button', name='PREVIEW', exact=True).tap()
        await expect(worker.get_by_label('New worker seed preview')).to_contain_text('Stored reply not loaded in this browser')
        surface = await worker.locator('[data-dialog-surface]').bounding_box()
        assert surface['x'] >= -1 and surface['x'] + surface['width'] <= 651 and surface['y'] + surface['height'] <= 1001, surface
        await worker.get_by_role('button', name='SEND TO NEW WORKER', exact=True).tap()
        await expect(worker.get_by_role('alert')).to_contain_text('Refresh the preview')
        await expect(worker.get_by_label('New worker preface')).to_have_value('Use the copied decision.')
        await expect(worker.get_by_label('New worker working directory')).to_have_value('/projects/another-fixture')
        await worker.get_by_role('button', name='PREVIEW', exact=True).tap()
        await worker.get_by_role('button', name='SEND TO NEW WORKER', exact=True).focus()
        await page.keyboard.press('Enter')
        await expect(worker).to_have_count(0)
        assert await page.evaluate('s.getState().activeJobId') == 'new-worker'
        requests = await page.evaluate('workerRequests')
        assert requests[-1]['destination']['workingDirectory'] == '/projects/another-fixture'
        assert requests[-1]['destination']['provider'] == 'codex'
        assert requests[0]['turns'] == 3 and requests[0]['preface'] == 'Use the copied decision.'
        assert 'pinnedSkills' not in requests[-1]['destination']
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: select messages, FORWARD to several members with a note, SEND TRANSCRIPT recipients, note and include switches, sent-mail echoes off by default')

asyncio.run(main())
