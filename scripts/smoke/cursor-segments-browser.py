"""Cursor reply segments: one streaming cursor, separate segments, no layout shift."""
import asyncio
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path, fs_url

PORT = os.environ.get('ARCO_CLIENT_PORT', '5232')
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
        page = await browser.new_page(viewport={'width': 1500, 'height': 900})
        blocked, errors = [], []
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'https' and url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(status=200, content_type='text/css', body='')
                return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and route.request.method == 'GET':
                if url.path == '/api/project-trust':
                    await route.fulfill(json={'trusted':False})
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
        await page.evaluate("""async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ChatMessage} = await import('/src/components/ChatMessage.tsx');
          const {applyTheme} = await import('/src/themes/apply.ts');
          const {getTheme} = await import('/src/themes/registry.ts');
          applyTheme(getTheme('matrix'));
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          const {handleServerMessage:receive} = await import('/src/ws/handleServerMessage.ts');
          window.s=s;
          window.send=m=>receive(m,{wsRef:{current:null},scheduleReconnect:()=>{}});
          s.getState().createJob('wf-cursor',{name:'cursor',workingDirectory:'/projects/fixture',primaryProvider:'cursor',primaryModel:'auto',primaryEffort:'low',skipPermissions:false});
          const root=createRoot(document.getElementById('fixture'));
          window.renderMessages=(width)=>root.render(React.createElement('div',{id:'col',style:{width:width+'px',padding:'0'}},
            s.getState().jobs['wf-cursor'].messages.filter(m=>m.role==='assistant'&&!m.toolUse).map(m=>React.createElement(ChatMessage,{key:m.id,jobId:'wf-cursor',message:m}))));
          window.layout=(text,streaming,width)=>{
            root.render(React.createElement('div',{id:'col',style:{width:width+'px'}},React.createElement(ChatMessage,{key:'x',jobId:'wf-cursor',message:{id:'x',role:'assistant',content:text,isStreaming:streaming,timestamp:1,phase:'passthrough'}})));
          };
        }""")
        # Reply segments: reasoning and tool updates between chunks.
        await page.evaluate("""() => {
          let seq = 0; const w = 'wf-cursor';
          const text = t => send({type:'primary_text',workflowId:w,phase:'passthrough',text:t,seq:++seq});
          const think = () => send({type:'primary_thinking',workflowId:w,text:'considering',seq:++seq});
          const tool = st => send({type:'primary_tool_use',workflowId:w,tool:'Read',input:'{}',status:st,toolUseId:'t1',provider:'cursor',seq:++seq});
          send({type:'primary_turn_started',workflowId:w,startedAt:1000});
          text('I will fix.'); think(); text('While here'); tool('started'); text('Then'); tool('completed'); text('Done');
          renderMessages(600);
        }""")
        cursors = page.locator('#col [data-streaming="true"]')
        await expect(cursors).to_have_count(1)
        body = await page.locator('#col').inner_text()
        for part in ('I will fix.', 'While here', 'Then', 'Done'):
            assert part in body, (part, body)
        assert 'fix.While' not in body
        shown = await page.evaluate("() => { const p = document.querySelector('#col [data-streaming=\"true\"] p'); const a = getComputedStyle(p, '::after'); return [a.content, a.display, parseFloat(a.height) > 8]; }")
        assert shown == ['""', 'inline-block', True], shown
        # The one cursor belongs to the last segment.
        last = await page.evaluate("s.getState().jobs['wf-cursor'].messages.filter(m=>m.role==='assistant'&&!m.toolUse).map(m=>[m.content,m.isStreaming])")
        assert last == [['I will fix.', False], ['While here', False], ['Then', False], ['Done', True]], last
        await page.evaluate("send({type:'primary_complete',workflowId:'wf-cursor',phase:'passthrough',seq:99}); renderMessages(600)")
        await expect(cursors).to_have_count(0)
        # The cursor never changes the height of its message, at any wrap point.
        words = ' '.join(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'] * 3)
        shifts = []
        for width in range(180, 260, 3):
            await page.evaluate("([t, w]) => layout(t, false, w)", [words, width])
            plain = await page.evaluate("document.getElementById('col').getBoundingClientRect().height")
            await page.evaluate("([t, w]) => layout(t, true, w)", [words, width])
            await expect(cursors).to_have_count(1)
            live = await page.evaluate("document.getElementById('col').getBoundingClientRect().height")
            if abs(plain - live) > 0.5:
                shifts.append((width, plain, live))
        assert not shifts, shifts
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: cursor segments stay separate, one streaming cursor, no layout shift from the cursor')

asyncio.run(main())
