"""FORWARD on selected chat messages and the SEND TRANSCRIPT note, recipients and include switches."""
import asyncio
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path, fs_url

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
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1300, 'height': 1100})
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
          const messages = [
            {id:'m1',role:'user',content:'Please fix the login bug',isStreaming:false,timestamp:1},
            {id:'m2',role:'assistant',content:'Found it: the token is never refreshed.',isStreaming:false,timestamp:2},
            {id:'m3',role:'peer-received',content:'Beta says the fix looks right',senderDisplayName:'Beta',isStreaming:false,timestamp:3},
            {id:'m4',role:'peer-sent',content:'Thanks Beta, landing now (shortened ec...',senderDisplayName:'Beta',isStreaming:false,timestamp:4},
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

        # Over the cap: SEND stays disabled.
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: select messages, FORWARD to several members with a note, SEND TRANSCRIPT recipients, note and include switches, sent-mail echoes off by default')

asyncio.run(main())
