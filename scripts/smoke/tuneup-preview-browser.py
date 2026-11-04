"""Fixture-only tune-up preview, accept and conflict-confirmed undo."""
import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from fs_url import fs_path

PORT = os.environ.get('ARCO_CLIENT_PORT', '5239')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><body><div id="fixture"></div><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type;
window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;
</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1000, 'height': 900})
        errors, blocked = [], []
        async def route(req):
            url = urlparse(req.request.url)
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                if url.path == '/fixture': await req.fulfill(content_type='text/html', body=HTML); return
                if url.path == '/api/file-content': await req.fulfill(json={'type':'text','content':'Current fixture text\n'}); return
                if url.path.startswith('/api/'): await req.fulfill(json={}); return
                local = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if req.request.method == 'GET' and (local or url.path.startswith(('/@react-refresh','/@vite/','/@id/','/node_modules/','/src/'))): await req.continue_(); return
            blocked.append(url.path); await req.abort()
        await page.route('**/*', route); await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(ORIGIN + '/fixture'); await page.wait_for_function('window.fixtureReady === true')
        await page.evaluate('''async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {MdTuneupDialog}=await import('/src/components/MdTuneupDialog.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts');
          const m=await import('/src/stores/mdTuneupStore.ts'); window.m=m; window.calls=[];
          s.getState().createJob('fixture',{name:'Fixture',workingDirectory:'/fixture',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'medium',skipPermissions:false});
          m.registerMdTuneupCandidatesSender((id)=>setTimeout(()=>m.useMdTuneupStore.getState().onCandidates(id,[{path:'AGENTS.md',baseName:'AGENTS.md',bytes:120,lines:3,approximateTokens:30,hints:['Repeated lines found.']}],'AGENTS.md'),0));
          m.registerMdTuneupRequestSender((a)=>{window.calls.push(['request',a]);setTimeout(()=>m.useMdTuneupStore.getState().onProposed(a.workflowId,{tuneupId:'tuneup',filePath:'/fixture/AGENTS.md',baseName:'AGENTS.md',original:'Original',proposed:'Tuned',notes:'',originalBytes:8,proposedBytes:5}),0)});
          m.registerMdTuneupAcceptSender((a)=>{window.calls.push(['accept',a]);setTimeout(()=>m.useMdTuneupStore.getState().onApplied(a.workflowId,{tuneupId:a.tuneupId,filePath:a.filePath,ok:true,backupPath:'/fixture/.arco/md-backups/fixture.bak',undoId:'undo'}),0)});
          m.registerMdTuneupUndoSender((a)=>{window.calls.push(['undo',a]);setTimeout(()=>m.useMdTuneupStore.getState().onUndone(a.workflowId,a.confirmedHash?{undoId:a.undoId,ok:true,safetyBackupPath:'/fixture/.arco/md-backups/safety.bak'}:{undoId:a.undoId,ok:false,conflictHash:'changed'}),0);return true});
          createRoot(document.getElementById('fixture')).render(React.createElement(MdTuneupDialog,{workflowId:'fixture',editor:{provider:'claude',model:'sonnet',effort:'medium'},onClose:()=>{}}));
        }''')
        await expect(page.get_by_text('3 lines, ~30 tokens')).to_be_visible()
        await expect(page.get_by_text('Repeated lines found.')).to_be_visible()
        assert await page.evaluate('window.calls.length') == 0
        await page.get_by_role('button', name='VIEW', exact=True).click()
        await expect(page.get_by_text('Current fixture text')).to_be_visible()
        assert await page.evaluate('window.calls.length') == 0
        await page.get_by_role('button', name='HIDE', exact=True).click()
        await page.get_by_role('button', name='TUNE SELECTED', exact=False).click()
        await expect(page.get_by_role('button', name='ACCEPT & BACK UP')).to_be_visible()
        await page.get_by_role('button', name='ACCEPT & BACK UP').click()
        await page.get_by_role('button', name='UNDO', exact=True).click()
        await expect(page.get_by_text('The file changed after ACCEPT.', exact=False)).to_be_visible()
        await page.get_by_role('button', name='CONFIRM UNDO').click()
        await expect(page.get_by_text('Original instruction file restored.')).to_be_visible()
        assert await page.evaluate("window.calls.filter(x=>x[0]==='undo').at(-1)[1].confirmedHash") == 'changed'
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()

asyncio.run(main())
