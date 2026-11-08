"""Automatic message folding survives replay and leaves typed messages intact."""
import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults
from fs_url import fs_path
from host_isolation import chrome_executable

install_navigation_defaults()
PORT = os.environ.get('ARCO_CLIENT_PORT', '5265')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><body><div id="fixture"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page()
        errors, blocked = [], []
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and route.request.method == 'GET':
                if url.path == '/fixture':
                    await route.fulfill(status=200, content_type='text/html', body=HTML); return
                is_local = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if is_local or url.path.startswith(('/@react-refresh','/@vite/','/@id/','/node_modules/.vite/deps/','/src/')):
                    await route.continue_(); return
            blocked.append(url.path); await route.abort()
        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true')
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ChatMessage} = await import('/src/components/ChatMessage.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts');
          const {handleServerMessage}=await import('/src/ws/handleServerMessage.ts');
          const {narrativeEventFromMessage}=await import('/src/utils/historyEvents.ts');
          const {projectChatMessages}=await import('/src/utils/displayMessages.ts');
          const {HistoryTab}=await import('/src/components/HistoryTab.tsx');
          const {QueuedMessagesIndicator}=await import('/src/components/QueuedMessagesIndicator.tsx');
          const id='fold-fixture'; s.getState().createJob(id,{name:'fixture',workingDirectory:'/projects/fixture',primaryProvider:'claude',primaryModel:'fixture',primaryEffort:'low',skipPermissions:false});
          const events=[{type:'user_message_echo',workflowId:id,seq:1,timestamp:1,content:'(nudge) full synthetic reminder',automaticKind:'nudge'}, {type:'user_message_echo',workflowId:id,seq:2,timestamp:2,content:'(nudge) typed by hand'}, {type:'user_message_echo',workflowId:id,seq:3,timestamp:3,content:'(auto-pickup) full synthetic wake',automaticKind:'auto-pickup'}];
          for(const event of events) handleServerMessage(event,{wsRef:{current:null},scheduleReconnect:()=>{}});
          const root=createRoot(document.getElementById('fixture')); window.root=root; window.s=s;
          window.showChat=()=>root.render(React.createElement('div',null,...projectChatMessages(s.getState().jobs[id]).map(m=>React.createElement(ChatMessage,{key:m.id,message:m,jobId:id}))));
          window.replay=()=>{s.getState().removeJob(id);s.getState().createJob(id,{name:'fixture',workingDirectory:'/projects/fixture',primaryProvider:'claude',primaryModel:'fixture',primaryEffort:'low',skipPermissions:false});for(const event of events) handleServerMessage(event,{wsRef:{current:null},scheduleReconnect:()=>{}});showChat();};
          window.showCli=()=>{s.setState(st=>({jobs:{...st.jobs,[id]:{...st.jobs[id],sessionChat:[{id:'cli-auto',role:'user',content:events[0].content,isStreaming:false,timestamp:1},{id:'cli-typed',role:'user',content:events[1].content,isStreaming:false,timestamp:2}]}}}));showChat();};
          window.showHistory=()=>{const job={...s.getState().jobs[id],historyEvents:events.map(narrativeEventFromMessage)};root.render(React.createElement(HistoryTab,{job}));};
          window.showQueue=()=>{const job={...s.getState().jobs[id],queue:{steering:[{content:'(nudge) full synthetic reminder',automaticKind:'nudge',clientMessageId:'q'}],followUp:[]},turnMessages:{}};root.render(React.createElement(QueuedMessagesIndicator,{job,onCancel:()=>{}}));};
          showChat();
        }''')
        await expect(page.get_by_text('(nudge) Peer mail waiting')).to_be_visible()
        await expect(page.get_by_text('(nudge) typed by hand')).to_be_visible()
        await expect(page.get_by_text('(nudge) full synthetic reminder')).to_have_count(0)
        toggle=page.get_by_role('button',name='Expand nudge message')
        await toggle.click(); await expect(page.get_by_text('(nudge) full synthetic reminder')).to_be_visible()
        await page.get_by_role('button',name='Fold nudge message').click()
        await expect(page.get_by_text('(nudge) full synthetic reminder')).to_have_count(0)
        await page.evaluate('replay()')
        await expect(page.get_by_text('(nudge) Peer mail waiting')).to_be_visible()
        await expect(page.get_by_text('(nudge) full synthetic reminder')).to_have_count(0)
        await expect(page.get_by_text('(auto-pickup) Peer mail waiting')).to_be_visible()
        await page.evaluate('showCli()')
        await expect(page.get_by_text('(nudge) Peer mail waiting')).to_be_visible()
        await expect(page.get_by_text('(nudge) typed by hand')).to_be_visible()
        await page.get_by_role('button',name='Expand nudge message').click()
        await expect(page.get_by_text('(nudge) full synthetic reminder')).to_be_visible()
        await page.evaluate('showHistory()')
        await expect(page.get_by_text('(nudge) Peer mail waiting')).to_be_visible()
        await page.get_by_role('button',name='Expand nudge message').click()
        await expect(page.get_by_text('(nudge) full synthetic reminder')).to_be_visible()
        await page.evaluate('showQueue()')
        await page.get_by_role('button',name='PENDING · 1').click()
        await expect(page.get_by_text('(nudge) Peer mail waiting')).to_be_visible()
        await page.get_by_role('button',name='PREVIEW',exact=True).click()
        await expect(page.get_by_text('(nudge) Peer mail waiting')).to_be_visible()
        await page.get_by_role('button',name='Expand nudge message').click()
        await expect(page.get_by_text('(nudge) full synthetic reminder')).to_be_visible()
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: automatic message fold, expansion, replay, history and pending preview')

asyncio.run(main())
