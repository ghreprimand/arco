"""Synthetic dialog geometry, viewport matrix and remembered resize."""
import asyncio
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from fs_url import fs_path
from host_isolation import chrome_executable

PORT = os.environ.get('ARCO_CLIENT_PORT', '5250')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
ART = Path(os.environ.get('ARCO_DIALOG_SIZE_ARTIFACTS', str(Path(tempfile.gettempdir()) / 'arco-dialog-sizes')))
HTML = """<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/components/workSurface/workSurface.css"></head><body><div id="fixture"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>"""

async def main():
    ART.mkdir(parents=True, exist_ok=True)
    rows = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page(viewport={'width':1280, 'height':800})
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                if url.path == '/fixture': await route.fulfill(content_type='text/html', body=HTML); return
                if url.path == '/api/list-dirs':
                    await route.fulfill(json={'parent':'/fixture','dirs':[{'name':f'Folder {i+1}','path':f'/fixture/folder-{i+1}'} for i in range(15)]}); return
                if url.path == '/api/file-content':
                    text = '# Synthetic report\n\n' + ('A sample paragraph for reading in the dialog.\n\n' * 10)
                    await route.fulfill(json={'type':'text','content':text,'size':len(text)}); return
                local = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if route.request.method == 'GET' and (local or url.path.startswith(('/@react-refresh','/@vite/','/@id/','/node_modules/.vite/deps/','/src/'))): await route.continue_(); return
            await route.abort()
        await page.route('**/*', isolate)
        await page.goto(ORIGIN + '/fixture'); await page.wait_for_function('window.fixtureReady === true')
        await page.evaluate("""async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {DialogShell}=await import('/src/components/DialogShell.tsx');
          const {ForwardDialog}=await import('/src/components/ForwardMessages.tsx');
          const {PurgeConversationModal}=await import('/src/components/PurgeConversationModal.tsx');
          const {DirectoryBrowser}=await import('/src/components/media/DirectoryPicker.tsx');
          const {FileViewerModal}=await import('/src/components/FileViewerModal.tsx');
          const root=createRoot(document.getElementById('fixture'));
          window.showFixture=(size) => {
            const h=React.createElement;
            const close=()=>root.render(null);
            if(size==='confirm') root.render(h(PurgeConversationModal,{workflowId:'fixture-a',cwd:'/fixture',name:'Synthetic conversation',onClose:close,onPurged:close}));
            else if(size==='form') root.render(h(ForwardDialog,{cluster:{members:[{workflowId:'fixture-a',displayName:'Worker A'},{workflowId:'fixture-b',displayName:'Worker B'}]},fromWorkflowId:'fixture-a',messages:[],onConfirm:()=>{},onCancel:close}));
            else if(size==='picker') root.render(h(DirectoryBrowser,{initialPath:'/fixture',title:'Choose a folder',onDone:close}));
            else root.render(h(FileViewerModal,{path:'/fixture/report.md',onClose:close}));
          };
          window.closeFixture=()=>root.render(null);
          window.showForward=()=>root.render(React.createElement(ForwardDialog,{cluster:{members:[{workflowId:'fixture-a',displayName:'Worker A'},{workflowId:'fixture-b',displayName:'Worker B'}]},fromWorkflowId:'fixture-a',messages:[],onConfirm:()=>{},onCancel:()=>root.render(null)}));
        }""")
        for width,height in [(1280,800),(1920,1080),(1920,1200),(2560,1440),(3840,2160)]:
            await page.set_viewport_size({'width':width,'height':height})
            for scale in [1,1.5]:
                await page.evaluate('s => {document.documentElement.style.zoom=String(s);document.documentElement.style.setProperty("--ui-scale",String(s));localStorage.clear()}',scale)
                for kind in ['confirm','form','picker','viewer']:
                    await page.evaluate('kind=>window.showFixture(kind)',kind)
                    box=page.locator('[data-dialog-surface="'+kind+'"]'); dialog=box
                    await expect(box).to_be_visible(); rect=await box.bounding_box(); assert rect
                    if kind=='picker': await expect(box.get_by_role('button').filter(has_text='Folder 1').first).to_be_visible()
                    if kind=='viewer': await expect(box.get_by_text('Synthetic report',exact=True)).to_be_visible()
                    font=await box.evaluate('el=>parseFloat(getComputedStyle(el).fontSize)') * scale
                    if kind == 'confirm': expected=min(width*.96,max(22*font,min(width*.4,36*font)))
                    elif kind == 'form': expected=min(width*.96,max(36*font,(640/14)*font,min(width*.5,60*font)))
                    elif kind == 'picker': expected=min(width*.96,max(40*font,min(width*.7,90*font)))
                    else: expected=min(width*.9,140*font)
                    assert abs(rect['width']-expected)<4, (kind,width,height,scale,rect,expected,font)
                    assert rect['x']>=0 and rect['y']>=0 and rect['x']+rect['width']<=width+1 and rect['y']+rect['height']<=height+1
                    if kind in ['confirm','form']: assert rect['height'] < min(height*.9, 40*font)
                    if kind == 'picker': assert abs(rect['height']-min(height*.94,max(24*font,min(height*.75,60*font))))<4
                    if kind == 'viewer': assert abs(rect['height']-height*.85)<4
                    filename=f'{kind}-{width}x{height}-{round(scale*100)}.png'
                    await page.screenshot(path=str(ART/filename))
                    rows.append((filename,rect['width'],rect['height']))
                    await page.evaluate('window.closeFixture()'); await expect(dialog).to_have_count(0)
        await page.set_viewport_size({'width':1280,'height':800}); await page.evaluate("document.documentElement.style.zoom='1';document.documentElement.style.setProperty('--ui-scale','1');localStorage.clear();window.showFixture('form')")
        dialog=page.locator('[data-dialog-surface="form"]'); box=dialog
        before=await box.bounding_box(); await dialog.get_by_role('button',name='Resize dialog').focus(); await page.keyboard.press('ArrowRight')
        resized=await box.bounding_box(); assert resized['width'] > before['width']
        await page.evaluate('window.closeFixture()'); await expect(dialog).to_have_count(0)
        await page.evaluate("window.showFixture('form')"); await expect(dialog).to_be_visible(); reopened=await box.bounding_box()
        assert abs(reopened['width']-resized['width'])<2
        await dialog.get_by_role('button',name='Reset dialog size').click(); reset=await box.bounding_box(); assert abs(reset['width']-before['width'])<2
        await page.mouse.move(reset['x']+reset['width']-3,reset['y']+reset['height']-3)
        await page.mouse.down(); await page.mouse.move(reset['x']+reset['width']+57,reset['y']+reset['height']+47,steps=5); await page.mouse.up()
        native=await box.bounding_box(); assert native['width']>reset['width']+10
        await page.evaluate('window.closeFixture()'); await expect(dialog).to_have_count(0)
        await page.evaluate("window.showFixture('form')"); await expect(dialog).to_be_visible(); native_reopened=await box.bounding_box()
        assert abs(native_reopened['width']-native['width'])<2
        await dialog.get_by_role('button',name='Reset dialog size').click()
        await dialog.get_by_role('button',name='Maximize dialog').click()
        await page.evaluate('window.closeFixture()'); await expect(dialog).to_have_count(0)
        await page.evaluate("window.showFixture('form')"); await expect(dialog.get_by_role('button',name='Restore dialog size')).to_be_visible()
        await dialog.get_by_role('button',name='Reset dialog size').click()
        for width,height,scale in [(2560,1440,1),(1280,800,1.5)]:
            await page.set_viewport_size({'width':width,'height':height})
            await page.evaluate('s => {document.documentElement.style.zoom=String(s);document.documentElement.style.setProperty("--ui-scale",String(s));window.showForward()}',scale)
            forward=page.get_by_role('dialog',name='Forward messages'); frame=forward.locator('[tabindex="-1"]').first
            await expect(frame).to_be_visible(); rect=await frame.bounding_box()
            assert rect and rect['width'] <= min(width*.96, max(640*scale, 60*14*scale))+4
            assert rect['height'] < height*.9
            await page.evaluate('window.closeFixture()'); await expect(forward).to_have_count(0)
        await page.set_viewport_size({'width':1024,'height':700})
        for kind in ['confirm','form','picker','viewer']:
            await page.evaluate('kind=>window.showFixture(kind)',kind)
            candidate=page.locator('[data-dialog-surface="'+kind+'"]')
            await expect(candidate).to_be_visible(); rect=await candidate.bounding_box()
            assert rect and rect['x']>=0 and rect['y']>=0 and rect['x']+rect['width']<=1025 and rect['y']+rect['height']<=701
            await page.evaluate('window.closeFixture()')
        with (ART/'index.md').open('w') as f:
            f.write('# Dialog size screenshots\n\n| File | Width | Height |\n| --- | ---: | ---: |\n')
            for name,w,h in rows: f.write(f'| [{name}]({name}) | {w:.1f}px | {h:.1f}px |\n')
        await browser.close()
    print('PASS: four dialog classes at five sizes and two scales; remembered resize and reset')

asyncio.run(main())
