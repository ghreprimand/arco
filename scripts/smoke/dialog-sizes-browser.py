"""Synthetic dialog geometry, viewport matrix and remembered resize."""
import asyncio
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright, expect
from fs_url import fs_path
from host_isolation import chrome_executable

PORT = os.environ.get('ARCO_CLIENT_PORT', '5250')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
ART = Path(os.environ['ARCO_DIALOG_SIZE_ARTIFACTS']) if os.environ.get('ARCO_DIALOG_SIZE_ARTIFACTS') else None
HTML = """<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/components/workSurface/workSurface.css"></head><body><div id="fixture"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>"""

async def no_footer_overlap(box, context):
    grip_rect=await box.get_by_role('button',name='Resize dialog').bounding_box()
    actions=box.locator('button:not(.work-surface-resize):not(.work-surface-controls button)')
    if await actions.count():
        action_rect=await actions.last.bounding_box()
        assert action_rect and grip_rect
        assert (action_rect['x']+action_rect['width'] <= grip_rect['x'] or grip_rect['x']+grip_rect['width'] <= action_rect['x'] or action_rect['y']+action_rect['height'] <= grip_rect['y'] or grip_rect['y']+grip_rect['height'] <= action_rect['y']), ('footer action overlaps resize grip',context,action_rect,grip_rect)

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
                    file=parse_qs(url.query)['path'][0]
                    text = '# Synthetic report\n\n' + ('A sample paragraph for reading in the dialog.\n\n' * 10)
                    if file.endswith('wide.md'):
                        text='| '+' | '.join('Column'+str(i)+'X'*30 for i in range(8))+' |\n| '+' | '.join('---' for i in range(8))+' |\n| '+' | '.join('value' for i in range(8))+' |'
                    if file.endswith('.png'):
                        await route.fulfill(json={'type':'image','dataUrl':'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nE8AAAAASUVORK5CYII=','size':68}); return
                    if file.endswith('.pdf'):
                        await route.fulfill(json={'type':'binary','size':100}); return
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
          const {SpawnDialog}=await import('/src/components/SpawnDialog.tsx');
          const {ForwardDialog}=await import('/src/components/ForwardMessages.tsx');
          const {PurgeConversationModal}=await import('/src/components/PurgeConversationModal.tsx');
          const {DirectoryBrowser}=await import('/src/components/media/DirectoryPicker.tsx');
          const {FileViewerModal}=await import('/src/components/FileViewerModal.tsx');
          const {ClusterMemberPicker}=await import('/src/components/ClusterMemberPicker.tsx');
          const root=createRoot(document.getElementById('fixture'));
          window.showFixture=(size) => {
            const h=React.createElement;
            const close=()=>root.render(null);
            if(size==='confirm') root.render(h(PurgeConversationModal,{workflowId:'fixture-a',cwd:'/fixture',name:'Synthetic conversation',onClose:close,onPurged:close}));
            else if(size==='form') root.render(h(ForwardDialog,{cluster:{members:[{workflowId:'fixture-a',displayName:'Worker A'},{workflowId:'fixture-b',displayName:'Worker B'}]},fromWorkflowId:'fixture-a',messages:[],onConfirm:()=>{},onCancel:close}));
            else if(size==='picker') root.render(h(DirectoryBrowser,{initialPath:'/fixture',title:'Choose a folder',onDone:close}));
            else root.render(h(FileViewerModal,{path:'/fixture/report.md',onClose:close}));
          };
          window.showSpawn=()=>root.render(React.createElement(SpawnDialog,{parentConfig:{name:'Fixture',workingDirectory:'/fixture',primaryProvider:'claude',primaryModel:'sonnet'},onConfirm:()=>{},onCancel:()=>root.render(null)}));
          window.closeFixture=()=>root.render(null);
          window.showMemberPicker=(count=60)=>root.render(React.createElement(ClusterMemberPicker,{title:'Choose a synthetic member',cluster:{members:Array.from({length:count},(_,i)=>({workflowId:'member-'+i,displayName:'Member '+(i+1),status:'idle',role:'builder'}))},onPick:m=>{window.pickedMember=m.workflowId},onCancel:()=>root.render(null)}));
          window.showFile=path=>root.render(React.createElement(FileViewerModal,{key:path,path,onClose:()=>root.render(null)}));
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
                    if kind=='viewer':
                        await expect(box.get_by_text('Synthetic report',exact=True)).to_be_visible()
                        rect=await box.bounding_box()
                    font=await box.evaluate('el=>parseFloat(getComputedStyle(el).fontSize)') * scale
                    if kind == 'confirm': expected=min(width*.96,max(22*font,min(width*.4,36*font)))
                    elif kind == 'form': expected=min(width*.96,max(36*font,(640/14)*font,min(width*.5,60*font)))
                    elif kind == 'picker': expected=min(width*.96,max(40*font,min(width*.7,90*font)))
                    else:
                        column=box.locator('.arco-markdown').first
                        reading=await column.evaluate('el=>parseFloat(getComputedStyle(el).maxWidth)')
                        expected=min(width*.96,(reading+38)*scale)
                    assert abs(rect['width']-expected)<4, (kind,width,height,scale,rect,expected,font)
                    assert rect['x']>=0 and rect['y']>=0 and rect['x']+rect['width']<=width+1 and rect['y']+rect['height']<=height+1
                    if kind in ['confirm','form']: assert rect['height'] < min(height*.9, 40*font)
                    if kind == 'picker': assert abs(rect['height']-min(height*.94,max(24*font,min(height*.75,60*font))))<4
                    if kind == 'viewer': assert abs(rect['height']-height*.85)<4
                    await no_footer_overlap(box,(kind,width,height,scale))
                    filename=f'{kind}-{width}x{height}-{round(scale*100)}.png'
                    await page.screenshot(path=str(ART/filename))
                    rows.append((filename,rect['width'],rect['height']))
                    await box.evaluate("el=>{el.style.width='280px';el.style.height='260px'}")
                    await no_footer_overlap(box,('minimum',kind,width,height,scale))
                    await page.evaluate('window.closeFixture()'); await expect(dialog).to_have_count(0)
        for width,height in [(1280,800),(1920,1080),(1920,1200),(2560,1440),(3840,2160)]:
            await page.set_viewport_size({'width':width,'height':height})
            for scale in [1,1.5]:
                await page.evaluate('s=>{document.documentElement.style.zoom=String(s);document.documentElement.style.setProperty("--ui-scale",String(s));localStorage.clear();window.showSpawn()}',scale)
                box=page.locator('[data-dialog-surface="form"]')
                await expect(box.get_by_role('button',name='SPAWN',exact=True)).to_be_visible()
                await no_footer_overlap(box,('spawn',width,height,scale))
                await box.evaluate("el=>{el.style.width='280px';el.style.height='260px'}")
                await no_footer_overlap(box,('minimum','spawn',width,height,scale))
                await page.evaluate('window.closeFixture()')
        # Formatted text defaults, wide content, saved dimensions and current reset target.
        await page.set_viewport_size({'width':1920,'height':1080})
        await page.evaluate("document.documentElement.style.zoom='1';document.documentElement.style.setProperty('--ui-scale','1');localStorage.clear()")
        for path,wide in [('/fixture/report.txt',False),('/fixture/wide.md',True),('/fixture/report.ts',True),('/fixture/report.png',True),('/fixture/report.pdf',True)]:
            await page.evaluate('p=>window.showFile(p)',path)
            box=page.locator('[data-dialog-surface="viewer"]')
            await expect(box.locator('.arco-file-body')).not_to_contain_text('Loading')
            rect=await box.bounding_box()
            if wide: assert abs(rect['width']-1920*.9)<4, (path,rect)
            else:
                column=box.locator('[data-document-column]')
                reading=await column.evaluate('el=>parseFloat(getComputedStyle(el).maxWidth)')
                assert abs(rect['width']-(reading+38))<4
            await page.evaluate('window.closeFixture()')
        await page.evaluate("window.showFile('/fixture/report.md')")
        box=page.locator('[data-dialog-surface="viewer"]')
        await expect(box.get_by_text('Synthetic report',exact=True)).to_be_visible()
        natural=await box.bounding_box()
        grip=box.get_by_role('button',name='Resize dialog')
        assert await grip.inner_text() == ''
        assert await grip.evaluate('el=>getComputedStyle(el).cursor') == 'nwse-resize'
        grip_rect=await grip.bounding_box()
        assert abs(grip_rect['x']+grip_rect['width']-(natural['x']+natural['width']))<3
        assert abs(grip_rect['y']+grip_rect['height']-(natural['y']+natural['height']))<3
        await box.get_by_role('button',name='Maximize dialog').click()
        assert abs((await box.bounding_box())['width']-1920*.96)<4
        await box.get_by_role('button',name='Restore dialog size').click()
        assert abs((await box.bounding_box())['width']-natural['width'])<2
        await box.get_by_role('button',name='RAW',exact=True).click()
        assert abs((await box.bounding_box())['width']-1920*.9)<4
        await box.get_by_role('button',name='Reset dialog size').click()
        assert abs((await box.bounding_box())['width']-1920*.9)<4
        await box.get_by_role('button',name='FORMATTED',exact=True).click()
        assert abs((await box.bounding_box())['width']-natural['width'])<2
        await grip.hover(); await page.mouse.down(); await page.mouse.move(grip_rect['x']+75,grip_rect['y']+55,steps=5); await page.mouse.up()
        dragged=await box.bounding_box()
        assert dragged['width']>natural['width']+80 and dragged['height']>natural['height']+50
        await page.evaluate('window.closeFixture()')
        await page.evaluate("window.showFile('/fixture/report.md')")
        await expect(box.get_by_text('Synthetic report',exact=True)).to_be_visible()
        assert abs((await box.bounding_box())['width']-dragged['width'])<2
        await box.get_by_role('button',name='Resize dialog').focus(); await page.keyboard.press('Home')
        assert abs((await box.bounding_box())['width']-natural['width'])<2
        await page.evaluate('window.closeFixture()')
        # RC6-13: the actual picker scrolls as a whole, unlike the inner-body fixtures.
        await page.set_viewport_size({'width':1280,'height':800})
        await page.evaluate("document.documentElement.style.zoom='1';document.documentElement.style.setProperty('--ui-scale','1');localStorage.clear();window.showMemberPicker()")
        surface=page.locator('.work-surface-resizable')
        await expect(surface.get_by_text('Member 60',exact=True)).to_have_count(1)
        await expect(surface.get_by_role('button',name='Resize dialog')).to_be_visible()
        initial=await surface.get_by_role('button',name='Resize dialog').bounding_box(); outer=await surface.bounding_box()
        assert abs(initial['y']+initial['height']-(outer['y']+outer['height']))<3
        scroll_height=await surface.evaluate('el=>el.scrollHeight')
        await surface.evaluate('el=>{el.scrollTop=800}')
        await page.wait_for_function("()=>{const s=document.querySelector('.work-surface-scroll-frame'),r=s.getBoundingClientRect(),g=s.querySelector('.work-surface-resize').getBoundingClientRect();return Math.abs(g.bottom-(r.top+s.clientTop+s.clientHeight))<3}")
        assert await surface.evaluate('el=>el.scrollHeight') == scroll_height
        assert await surface.evaluate('el=>el.scrollTop') == 800
        grip=surface.get_by_role('button',name='Resize dialog')
        frame=await surface.bounding_box(); handle=await grip.bounding_box()
        await page.screenshot(path=str(ART/'member-picker-scrolled.png'))
        assert abs(handle['y']+handle['height']-(frame['y']+frame['height']))<3, (frame,handle)
        assert await grip.evaluate('el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}')
        assert await surface.evaluate("el=>{const h=el.querySelector('.work-surface-resize').getBoundingClientRect(),r=el.getBoundingClientRect();return h.right<=r.left+el.clientLeft+el.clientWidth+1}")
        await grip.hover(); await page.mouse.down(); await page.mouse.move(handle['x']+handle['width']/2+35,handle['y']+handle['height']/2+20,steps=5); await page.mouse.up()
        resized=await surface.bounding_box()
        assert resized['width']>frame['width']+50 and resized['height']>frame['height']+20
        assert await surface.evaluate('el=>el.scrollTop') >= 800
        await grip.focus(); await page.keyboard.press('ArrowLeft')
        assert abs((await surface.bounding_box())['width']-(resized['width']-20))<2
        await surface.evaluate("el=>{el.querySelector('button.display-font').style.minWidth='1600px';el.scrollLeft=300}")
        await page.wait_for_function("()=>{const s=document.querySelector('.work-surface-scroll-frame'),r=s.getBoundingClientRect(),g=s.querySelector('.work-surface-resize').getBoundingClientRect();return s.scrollLeft>0&&Math.abs(g.right-(r.left+s.clientLeft+s.clientWidth))<3}")
        assert await grip.evaluate('el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}')
        await surface.evaluate("el=>{el.querySelector('button.display-font').style.minWidth='';el.scrollLeft=0}")
        scroll_height=await surface.evaluate('el=>el.scrollHeight')
        await surface.evaluate('el=>{el.scrollTop=el.scrollHeight}')
        await page.wait_for_function("()=>{const s=document.querySelector('.work-surface-scroll-frame'),r=s.getBoundingClientRect(),g=s.querySelector('.work-surface-resize').getBoundingClientRect();return Math.abs(g.bottom-(r.top+s.clientTop+s.clientHeight))<3}")
        assert await surface.evaluate('el=>el.scrollHeight') == scroll_height
        last=surface.get_by_role('button').filter(has_text='Member 60')
        last_rect=await last.bounding_box(); handle=await grip.bounding_box()
        assert last_rect['x']+last_rect['width'] <= handle['x']+1 or last_rect['y']+last_rect['height'] <= handle['y']+1, (last_rect,handle)
        await last.click(); assert await page.evaluate('window.pickedMember') == 'member-59'
        await grip.focus(); await page.keyboard.press('Home')
        assert abs((await surface.bounding_box())['width']-frame['width'])<2
        await page.evaluate('window.closeFixture()')
        await expect(surface).to_have_count(0)
        await page.evaluate('window.showMemberPicker(3)')
        surface=page.locator('.work-surface-resizable')
        await expect(surface.get_by_text('Member 3',exact=True)).to_have_count(1)
        await expect(surface.get_by_text('Member 4',exact=True)).to_have_count(0)
        await page.wait_for_function("()=>{const s=document.querySelector('.work-surface-scroll-frame'),r=s.getBoundingClientRect(),g=s.querySelector('.work-surface-resize').getBoundingClientRect();return Math.abs(g.bottom-(r.top+s.clientTop+s.clientHeight))<3}")
        short=await surface.bounding_box(); handle=await surface.get_by_role('button',name='Resize dialog').bounding_box()
        assert await surface.evaluate('el=>el.scrollHeight<=el.clientHeight+1')
        assert abs(handle['y']+handle['height']-(short['y']+short['height']))<3
        await page.evaluate('window.closeFixture()')
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

if ART is not None:
    asyncio.run(main())
else:
    with tempfile.TemporaryDirectory(prefix='arco-dialog-sizes-') as directory:
        ART = Path(directory)
        asyncio.run(main())
