"""Save readiness and staged inspection regressions with synthetic browser fixtures."""
import asyncio
import json
import os
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright, expect
from host_isolation import chrome_executable
from browser_navigation import install_navigation_defaults
install_navigation_defaults()
URL='http://127.0.0.1:'+os.environ.get('ARCO_CLIENT_PORT','5291')+'/'
PATCH='diff --git a/note.txt b/note.txt\nindex 1111111..2222222 100644\n--- a/note.txt\n+++ b/note.txt\n@@ -1,2 +1,2 @@\n heading\n-HEAD version\n+INDEX version\n'
async def main():
  async with async_playwright() as p:
    browser=await p.chromium.launch(executable_path=chrome_executable() or None)
    page=await browser.new_page(); errors=[]; file_reads=[]; pending=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    staged_only=True
    async def api(route):
      u=urlparse(route.request.url); q=parse_qs(u.query); data={}
      if u.path=='/api/settings': data={'onboardingComplete':True}
      elif u.path=='/api/list-dirs':
        folder=q.get('path',['/fixture'])[0] or '/fixture'
        if folder=='/waiting': pending.append(route); return
        if folder=='/failed': await route.fulfill(status=500,json={'error':'fixture failure'}); return
        data={'parent':folder,'dirs':[]}
      elif u.path=='/api/git/diff':
        data={'isRepo':True,'staged':[{'path':'note.txt','status':'M'}] if staged_only else [],'unstaged':[] if staged_only else [{'path':'note.txt','status':'M'}],'untracked':[]}
        if 'file' in q: data={'isRepo':True,'patch':PATCH,'path':'note.txt','staged':True}
      elif u.path=='/api/file-content':
        file_reads.append(u.path); data={'type':'text','content':'UNSTAGED insertion\nheading\nWORKTREE version\n','size':45}
      await route.fulfill(json=data)
    await page.route('**/api/**',api)
    await page.goto(URL)
    await page.evaluate("""async()=>{
      const React=(await import('/node_modules/.vite/deps/react.js')).default;
      const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
      const host=document.createElement('div');host.id='fixture';host.style='position:fixed;inset:0;z-index:20000;background:black';document.body.append(host);
      window.fixtureRoot=createRoot(host);window.mount=async(kind)=>{
        if(kind==='picker'){const {DirectoryBrowser}=await import('/src/components/media/DirectoryPicker.tsx');window.picks=[];window.fixtureRoot.render(React.createElement(DirectoryBrowser,{initialPath:'/fixture',inline:true,onDone:r=>window.picks.push(r)}));}
        else {const {LiveChangesPanel}=await import('/src/components/diff/LiveChangesPanel.tsx');window.fixtureRoot.render(React.createElement(LiveChangesPanel,{wfid:'fixture',cwd:'/fixture'}));}
      };await window.mount('picker');
    }""")
    save=page.get_by_role('button',name='SAVE HERE'); filename=page.get_by_placeholder('filename (blank = auto; the op sets the extension)'); path=page.get_by_label('Browse folder path')
    await expect(save).to_be_enabled(); await filename.fill('report')
    await path.fill('/typed'); await expect(save).to_be_disabled(); await filename.press('Enter')
    assert await page.evaluate('window.picks.length')==0,'B184: uncommitted folder must not submit'
    await path.fill('/waiting'); await path.press('Enter'); await expect(save).to_be_disabled(); await filename.press('Enter')
    assert await page.evaluate('window.picks.length')==0,'B184: loading folder must not submit'
    while not pending: await page.wait_for_timeout(10)
    await pending.pop().fulfill(json={'parent':'/waiting','dirs':[]}); await expect(save).to_be_enabled()
    await filename.press('Enter'); assert await page.evaluate('window.picks.pop()')=={'dir':'/waiting','basename':'report'}
    await save.click(); assert await page.evaluate('window.picks.pop()')=={'dir':'/waiting','basename':'report'}
    await path.fill('/failed'); await path.press('Enter'); await expect(page.get_by_text('Folder listing is unavailable.')).to_be_visible(); await filename.press('Enter')
    assert await page.evaluate('window.picks.length')==0,'B184: failed listing must not submit'
    await page.evaluate("window.mount('live')")
    await expect(page.get_by_text('INDEX version',exact=True)).to_be_visible()
    await expect(page.get_by_text('WORKTREE version',exact=True)).to_have_count(0)
    assert not file_reads,'B183: staged inspection must not request working-tree source'
    # The index insertion stays on line two despite the worktree-only inserted line.
    row=page.locator('tr').filter(has_text='INDEX version')
    await expect(row.get_by_role('cell').nth(1)).to_have_text('2')
    staged_only=False
    await expect(page.get_by_text('WORKTREE version',exact=True)).to_be_visible()
    assert file_reads,'B183: unstaged inspection keeps working-tree source'
    assert not errors,errors
    await browser.close()
    print('PASS B184: draft/loading/error Enter refused; ready mouse and keyboard agree. B183: index patch and line positions shown.')
asyncio.run(main())
