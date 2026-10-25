"""Real ChatPanel + VoiceExecutor, isolated Vite page; no API/WS/provider actions.
ARCHON_CLIENT_PORT=5195 npm run dev:client; npm run smoke:voice-scroll
"""
import asyncio
import os
from playwright.async_api import async_playwright

URL = os.environ.get('ARCHON_VOICE_SCROLL_URL', 'http://127.0.0.1:5195')
CHROME = os.environ.get('ARCHON_TEST_CHROME', os.path.expanduser('~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'))

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        page = await browser.new_page(viewport={'width': 1100, 'height': 800})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.route('**/api/**', lambda r: r.fulfill(json={}))
        await page.route('**/voice-scroll-fixture', lambda r: r.fulfill(content_type='text/html', body='''<html><body><div id="root" style="display:flex;height:650px"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;window.fixtureReady=true;</script></body></html>'''))
        await page.goto(URL + '/voice-scroll-fixture')
        await page.wait_for_function('window.fixtureReady')
        await page.evaluate('''async () => {
          const {default:React} = await import('/node_modules/.vite/deps/react.js');
          const {default:{createRoot}} = await import('/node_modules/.vite/deps/react-dom_client.js');
          const {ChatPanel} = await import('/src/components/ChatPanel.tsx');
          const {useAppStore} = await import('/src/stores/appStore.ts');
          const {VoiceExecutor} = await import('/src/voice/executor.ts');
          const {useVoiceStore} = await import('/src/voice/store.ts');useVoiceStore.setState({enabled:true,mode:'archon'});
          window.store=useAppStore;const s=useAppStore.getState();
          for(const id of ['worker-a','worker-b']) {
            s.createJob(id,{name:id,kind:'workflow',workingDirectory:'/tmp/voice-scroll-fixture',primaryProvider:'codex',primaryModel:'gpt-6-luna',primaryEffort:'low'});
            for(let i=0;i<45;i++) s.addMessage(id,{id:id+i,role:'assistant',content:('History paragraph '+i+'. ').repeat(35),timestamp:i+1,isStreaming:false});
          }
          s.setActiveJob('worker-a');useAppStore.setState({connected:true});
          window.executor=new VoiceExecutor({sendMessage:()=>true,cancel:()=>{}});
          window.tool=(tool,args)=>window.executor.runTool({type:'voice_tool_call',workflowId:'computer-fixture',requestId:'test',tool,args});
          window.frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          window.stream=async()=>{const s=useAppStore.getState(),id=s.activeJobId;
            const key='stream-'+Date.now();s.addMessage(id,{id:key,role:'assistant',content:'New output. ',timestamp:Date.now(),isStreaming:true});
            for(let i=0;i<8;i++){s.updateMessage(id,key,{content:('Streaming paragraph '+i+'. ').repeat(150+i*20)});await window.frame();}
            s.updateMessage(id,key,{isStreaming:false});await window.frame();};
          function Harness(){const id=useAppStore(s=>s.activeJobId);const job=useAppStore(s=>s.jobs[id]);return React.createElement(ChatPanel,{job});}
          createRoot(document.getElementById('root')).render(React.createElement(Harness));
        }''')
        pane = page.locator('[data-help="chat.panel"]')
        await pane.wait_for()
        await page.wait_for_timeout(200)
        async def distance():
            return await pane.evaluate('(el)=>el.scrollHeight-el.clientHeight-el.scrollTop')
        async def detach():
            await pane.evaluate('el=>{el.dispatchEvent(new WheelEvent("wheel",{deltaY:-500}));el.scrollTop=400;el.dispatchEvent(new Event("scroll"));}')
            await page.wait_for_timeout(80)
            assert await distance() > 1000
        await detach()
        await page.evaluate('tool("archon_select",{target:"worker-a"})')
        await page.wait_for_timeout(150)
        assert await distance() < 40, 'selecting the current worker must resume follow'
        await page.evaluate('stream()')
        assert await distance() < 40, 'streaming after voice selection must stay visible'
        await detach()
        await page.evaluate('stream()')
        assert await distance() > 1000, 'manual scroll-up must retain reading position'
        await page.evaluate('tool("archon_send_message",{target:"worker-b",text:"Background task."})')
        assert await distance() > 1000, 'sending to another worker must preserve current reading'
        await page.evaluate('tool("archon_send_message",{target:"worker-a",text:"Visible task."})')
        await page.evaluate('stream()')
        assert await distance() < 40, 'a send to the selected worker must resume follow'
        await detach()
        await page.evaluate('tool("archon_select",{target:"worker-b"})')
        await page.evaluate('stream()')
        assert await distance() < 40, 'reused ChatPanel must follow a newly selected worker'
        assert not errors, errors
        print('PASS: actual virtualized ChatPanel follows voice selection, selected-worker sends and streaming; manual scroll and background recipients retain reading position.')
        await browser.close()

asyncio.run(main())
