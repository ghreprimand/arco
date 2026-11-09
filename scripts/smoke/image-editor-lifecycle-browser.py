"""Real editor lifecycle and composer clipboard coverage with synthetic image and APIs."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults
from host_isolation import chrome_executable

install_navigation_defaults()

URL = os.environ.get('ARCO_INTERRUPT_PREVIEW_URL', 'http://127.0.0.1:5254/')
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
            elif path == '/api/auth-status':
                data = {n: {'loggedIn': True, 'installed': True, 'cliInstalled': True} for n in ['claude', 'codex',  'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'github']}
            elif path == '/api/capabilities':
                data = {'efforts': ['low', 'medium', 'high'], 'models': ['gpt-5.5'], 'cliVersion': 'fixture', 'codexVersion': '0.164.0'}
            elif path.endswith('/catalog'):
                data = {'models': []}
            await route.fulfill(json=data)

        await context.route('**/api/**', api)
        await context.route('**/upload', lambda r: r.fulfill(json={'fileId':'pasted','filename':'clipboard.png','path':'uploads/clipboard.png'}))
        await context.route('**/healthz', lambda r: r.fulfill(json={'status': 'live'}))
        await context.route('https://**/*', lambda r: r.abort())
        await context.route_web_socket('**/*', lambda ws: ws.on_message(lambda raw: messages.append(json.loads(raw))))
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
        await page.evaluate("""async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ImageEditor}=await import('/src/components/media/ImageEditor/ImageEditor.tsx');
          const host=document.createElement('div'); host.id='editor-fixture';
          host.style.cssText='position:fixed;inset:20px;z-index:9999;background:white;display:flex';
          document.body.appendChild(host); const root=createRoot(host);
          const canvas=document.createElement('canvas'); canvas.width=32;canvas.height=32;
          window.fixtureImage=canvas.toDataURL();
          window.openEditorFixture=()=>{host.style.display='flex';root.render(React.createElement(ImageEditor,{src:window.fixtureImage,filename:'fixture.png'}))};
          window.closeEditorFixture=()=>{root.render(null);host.style.display='none'};
          window.pasteImageFixture=async target=>{
            const blob=await (await fetch(window.fixtureImage)).blob();
            const dt=new DataTransfer();dt.items.add(new File([blob],'clipboard.png',{type:'image/png'}));
            return document.querySelector(target).dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));
          };
          window.editorState=(await import('/src/vendor/odysseus-editor/editor/state.js')).state;
          window.openEditorFixture();
        }""")
        await page.wait_for_function('window.editorState.layers.length === 1')
        await page.evaluate("window.pasteImageFixture('#gallery-editor-container')")
        await page.wait_for_function('window.editorState.layers.length === 2')
        await expect(page.locator('#ge-vendor-toast-host')).to_contain_text('Pasted as new layer')
        await page.evaluate("window.closeEditorFixture();document.getElementById('ge-vendor-toast-host')?.remove()")
        await page.wait_for_timeout(100)
        await page.evaluate("window.pasteImageFixture('[data-help=\"composer.input\"] textarea')")
        await page.wait_for_function("(window.testStore.getState().attachments['interrupt-ui'] ?? []).length === 1",timeout=5000)
        assert await page.evaluate('window.editorState.editorOpen') is False
        assert await page.locator('#ge-vendor-toast-host').count() == 0
        assert await page.evaluate("""() => {
          const input=document.createElement('textarea');document.body.appendChild(input);
          return ['z','s','Escape'].every(key=>input.dispatchEvent(new KeyboardEvent('keydown',{key,ctrlKey:key!=='Escape',bubbles:true,cancelable:true})));
        }""")
        # A stale open flag must not reactivate handlers on hidden or detached DOM.
        await page.evaluate('window.openEditorFixture()')
        await page.wait_for_function('window.editorState.layers.length === 1')
        # Reopening must activate just one generation of shortcut listeners.
        await page.evaluate('window.editorState.brushSize=100')
        await page.locator('#gallery-editor-container').dispatch_event('keydown',{'key':']'})
        assert await page.evaluate('window.editorState.brushSize') == 110
        await page.evaluate("document.getElementById('editor-fixture').style.display='none'")
        assert await page.evaluate("""() => document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))""")
        await page.evaluate("window.pasteImageFixture('[data-help=\"composer.input\"] textarea')")
        await page.wait_for_function("window.testStore.getState().attachments['interrupt-ui'].length === 2")
        assert await page.evaluate('window.editorState.layers.length') == 1
        # A hidden drop zone must not consume an image drop either.
        assert await page.evaluate('''async () => {
          const blob=await (await fetch(window.fixtureImage)).blob();const dt=new DataTransfer();
          dt.items.add(new File([blob],'drop.png',{type:'image/png'}));
          return document.getElementById('gallery-editor-container').dispatchEvent(new DragEvent('drop',{bubbles:false,cancelable:true,dataTransfer:dt}));
        }''')
        await page.evaluate("document.getElementById('editor-fixture').remove()")
        await page.evaluate("window.pasteImageFixture('[data-help=\"composer.input\"] textarea')")
        await page.wait_for_function("window.testStore.getState().attachments['interrupt-ui'].length === 3")
        await page.evaluate('window.closeEditorFixture()')
        assert not errors, errors
        await browser.close()
        print('PASS: open editor receives image layers; closed and hidden editors leave composer paste and shortcuts usable')

asyncio.run(main())
