"""Turn diff and undo controls use fixture refs and a stubbed socket."""
import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults
from fs_url import fs_path

install_navigation_defaults()
ROOT = Path(__file__).resolve().parents[2]
PORT = os.environ.get('ARCO_CLIENT_PORT', '5234')
ORIGIN = 'http://127.0.0.1:' + PORT
HTML = '''<!doctype html><html><body><main id="fixture"></main><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true; window.ready = true;
</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page()
        errors, unexpected, diffs = [], [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        async def route_request(route):
            u = urlparse(route.request.url)
            if u.netloc == '127.0.0.1:' + PORT and u.path == '/fixture':
                await route.fulfill(status=200, content_type='text/html', body=HTML); return
            if u.netloc == '127.0.0.1:' + PORT and u.path == '/api/outputs':
                await route.fulfill(json={'outputs':[]}); return
            if u.netloc == '127.0.0.1:' + PORT and u.path == '/api/workflows/diff':
                diffs.append(parse_qs(u.query))
                await route.fulfill(json={'patch':'','isRepo':True,'from':'fixture','to':'fixture'}); return
            if u.netloc == '127.0.0.1:' + PORT and (u.path.startswith(('/@react-refresh','/@vite/','/@id/','/node_modules/.vite/deps/','/src/')) or (u.path.startswith('/@fs/') and fs_path(u.path).resolve().is_relative_to(ROOT))):
                await route.continue_(); return
            unexpected.append(u.path); await route.abort()
        await page.route('**/*', route_request)
        await page.route_web_socket('**/*', lambda ws: None)
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.ready === true')
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {CheckpointActions}=await import('/src/components/CheckpointActions.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts');
          window.sent=[]; s.setState({wsSendRaw:msg=>sent.push(msg)});
          window.root=createRoot(document.getElementById('fixture'));
          root.render(React.createElement(CheckpointActions,{
            workflowId:'fixture',cwd:'/projects/demo',busy:false,
            entry:{seq:8,category:'checkpoint',label:'Before turn',checkpointSeq:8,checkpointRef:'refs/arco/fixture/8'},
            turn:{endRef:'refs/arco/fixture/12',fileCount:2,added:3,removed:1,paths:['alpha.txt','beta.txt'],pathsTruncated:false,skippedLargeFiles:1}
          }));
        }''')
        await expect(page.get_by_text('alpha.txt, beta.txt', exact=False)).to_be_visible()
        await expect(page.get_by_text('at least 1 large file skipped', exact=False)).to_be_visible()
        await page.get_by_role('button', name='Changed 2 files (+3 -1)').click()
        await expect(page.get_by_text('DIFF: TURN CHANGES')).to_be_visible()
        assert diffs and diffs[0]['from'] == ['refs/arco/fixture/8'] and diffs[0]['to'] == ['refs/arco/fixture/12'], diffs
        await page.get_by_role('button', name='CLOSE', exact=True).click()
        await page.get_by_role('button', name='UNDO THIS TURN', exact=True).click()
        await expect(page.get_by_text('Changes made after this turn', exact=False)).to_be_visible()
        await expect(page.get_by_text('pre-revert safety snapshot', exact=False)).to_be_visible()
        await page.get_by_role('button', name='REVERT', exact=True).click()
        assert await page.evaluate('sent') == [{'type':'revert_to_checkpoint','workflowId':'fixture','seq':8}]
        # Once the server confirms the restore, the line reads Undone, undo is disabled, and the diff is labelled as the undone change.
        await page.evaluate('''async () => {
          const {useAppStore:s}=await import('/src/stores/appStore.ts');
          const {handleServerMessage:receive}=await import('/src/ws/handleServerMessage.ts');
          s.getState().createJob('fixture',{name:'Demo',workingDirectory:'/projects/demo',primaryProvider:'codex',primaryModel:'fixture',primaryEffort:'low',skipPermissions:false});
          receive({type:'checkpoint_reverted',workflowId:'fixture',seq:40,restoredSeq:8,fileCount:2,safetySnapshotRef:'refs/arco/fixture/39',safetySnapshotSeq:39,backend:'git',ts:Date.now()},{wsRef:{current:null},scheduleReconnect:()=>{}});
        }''')
        await expect(page.get_by_test_id('turn-undone')).to_have_text('Undone')
        await expect(page.get_by_role('button', name='UNDO THIS TURN', exact=True)).to_be_disabled()
        await page.get_by_role('button', name='Changed 2 files (+3 -1)').click()
        await expect(page.get_by_text('DIFF: UNDONE TURN CHANGES')).to_be_visible()
        await page.get_by_role('button', name='CLOSE', exact=True).click()
        assert len(await page.evaluate('sent')) == 1
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {CheckpointActions}=await import('/src/components/CheckpointActions.tsx');
          root.render(React.createElement(CheckpointActions,{workflowId:'fixture',cwd:'/projects/demo',busy:true,
            entry:{seq:8,category:'checkpoint',label:'Before turn',checkpointSeq:8,checkpointRef:'refs/arco/fixture/8'},
            turn:{endRef:'refs/arco/fixture/12',fileCount:2,added:3,removed:1,paths:['alpha.txt'],pathsTruncated:false}}));
        }''')
        await expect(page.get_by_role('button', name='UNDO THIS TURN', exact=True)).to_be_disabled()
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {CheckpointActions}=await import('/src/components/CheckpointActions.tsx');
          root.render(React.createElement(CheckpointActions,{workflowId:'fixture',cwd:'/projects/demo',busy:false,
            entry:{seq:8,category:'checkpoint',label:'Before turn',checkpointSeq:8,checkpointRef:'refs/arco/fixture/8'},
            turn:{endRef:'refs/arco/fixture/12',fileCount:2,added:3,removed:1,paths:['alpha.txt'],pathsTruncated:false,otherWriters:true}}));
        }''')
        await expect(page.get_by_text('other agents were also working here', exact=False)).to_be_visible()
        await expect(page.get_by_role('button', name='VIEW DIFF', exact=True)).to_be_visible()
        await expect(page.get_by_role('button', name='UNDO THIS TURN', exact=True)).to_have_count(0)
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {ChatPanel}=await import('/src/components/ChatPanel.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts');
          const {handleServerMessage:receive}=await import('/src/ws/handleServerMessage.ts');
          s.getState().createJob('chat-fixture',{name:'Demo',workingDirectory:'/projects/demo',primaryProvider:'codex',primaryModel:'fixture',primaryEffort:'low',skipPermissions:false});
          s.getState().addMessage('chat-fixture',{id:'answer',role:'assistant',content:'Finished.',isStreaming:false,timestamp:1,eventSeq:2});
          const event={type:'turn_changes',workflowId:'chat-fixture',checkpointSeq:8,fromRef:'refs/arco/chat-fixture/8',toRef:'refs/arco/chat-fixture/12',fileCount:2,added:3,removed:1,binaryFiles:0,paths:['alpha.txt','beta.txt'],pathsTruncated:false,timestamp:2,seq:3};
          const deps={wsRef:{current:null},scheduleReconnect:()=>{}};
          receive({...event,fileCount:0,checkpointSeq:7,seq:4},deps); receive(event,deps); receive(event,deps);
          const Wrap=()=>React.createElement('div',{style:{height:600,width:700}},React.createElement(ChatPanel,{job:s(x=>x.jobs['chat-fixture'])}));
          window.showChat=(cluster)=>root.render(React.createElement('div',{style:{height:600,width:700}},React.createElement(ChatPanel,{job:s.getState().jobs['chat-fixture'],...(cluster ? {clusterContext:{clusterId:'cluster',name:'Cluster'}} : {})})));
          root.render(React.createElement(Wrap));
        }''')
        await expect(page.get_by_text('Finished.', exact=True)).to_be_visible()
        await expect(page.get_by_role('button', name='Changed 2 files (+3 -1)')).to_have_count(1)
        await expect(page.locator('[data-help="chat.turn-changes"]')).to_have_count(3)
        await page.evaluate('showChat(true)')
        await expect(page.get_by_role('button', name='Changed 2 files (+3 -1)')).to_have_count(1)
        assert not errors, errors
        assert not unexpected, unexpected
        await browser.close()
        print('PASS: immutable turn diff and existing confirm-before-revert use fixture refs')

asyncio.run(main())
