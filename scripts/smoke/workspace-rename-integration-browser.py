"""Verify workspace naming with a disposable isolated server and no provider calls."""
import asyncio, importlib.util, json, os
from pathlib import Path
from playwright.async_api import async_playwright, expect
os.environ['ARCO_TEST_REQUIRE_NETNS']='1'
spec=importlib.util.spec_from_file_location('connections_fixture',Path(__file__).with_name('connections-browser.py'))
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
class Server(h.IsolatedServer):
 def extra_settings(self): return {'onboardingComplete':True}
async def main():
 server=Server('http://127.0.0.1:'+str(h.host_isolation.closed_port())); b=None
 try:
  async with async_playwright() as p:
   b=h.Browser(p,server)
   async def setup(context):
    await context.add_init_script("(()=>{const f=WebSocket.prototype.send;WebSocket.prototype.send=function(x){window.fixtureSocket=this;return f.call(this,x)}})()")
   b.on_context=setup; page=await b.open()
   await page.wait_for_function("window.fixtureSocket && window.fixtureSocket.readyState===1")
   config={'name':'Original','workingDirectory':str(server.projects/'app'),'primaryProvider':'claude','primaryModel':'sonnet','primaryEffort':'low','skipPermissions':False,'claudeTransport':'native'}
   await page.evaluate("cfg=>window.fixtureSocket.send(JSON.stringify({type:'create_workflow',config:cfg}))",config)
   rename=page.get_by_role('button',name='Rename workspace Original',exact=True)
   await rename.wait_for(timeout=30000)
   assert await page.locator('[data-help="tabbar.tab"]').get_by_role('button',name='Rename workspace Original').count()==0
   await expect(page.get_by_label('Workspace name row').get_by_text('Original',exact=True)).to_be_visible()
   await rename.click(); await page.get_by_label('Workspace name',exact=True).fill('Renamed'); await page.get_by_role('button',name='SAVE',exact=True).click()
   await page.get_by_role('button',name='Rename workspace Renamed',exact=True).wait_for(timeout=15000)
   sessions=(await (await page.request.get(server.base+'/api/sessions',params={'path':str(server.projects/'app')})).json())['sessions']
   assert any(s.get('arcoName')=='Renamed' for s in sessions),sessions
   frames=await page.evaluate('window.__sent.map(s=>JSON.parse(s))')
   assert not any(f.get('type')=='user_message' for f in frames)
   await page.reload(); await page.get_by_role('button',name='Rename workspace Renamed',exact=True).wait_for(timeout=30000)
   saved={'name':'Saved chat','kind':'chat','workingDirectory':'','primaryProvider':'claude','primaryModel':'sonnet','primaryEffort':'low','skipPermissions':False,'claudeTransport':'native'}
   await page.evaluate("cfg=>window.fixtureSocket.send(JSON.stringify({type:'create_workflow',config:cfg}))",saved)
   header=page.locator('[data-help="chat.mode-status"]')
   await expect(header.get_by_text('Saved chat',exact=True).first).to_be_visible(timeout=30000)
   await header.locator('summary').click(); await header.get_by_role('button',name='Rename workspace Saved chat').click()
   await page.get_by_label('Workspace name',exact=True).fill('Saved revised'); await page.get_by_role('button',name='SAVE',exact=True).click()
   await expect(header.get_by_text('Saved revised',exact=True).first).to_be_visible()
   await page.reload(); await page.get_by_role('button',name='SAVED REVISED',exact=True).click(timeout=30000)
   await expect(header.get_by_text('Saved revised',exact=True).first).to_be_visible()
   private={**saved,'name':'Private chat','incognito':True}
   await page.wait_for_function("window.fixtureSocket && window.fixtureSocket.readyState===1")
   await page.evaluate("cfg=>window.fixtureSocket.send(JSON.stringify({type:'create_workflow',config:cfg}))",private)
   await expect(header.get_by_text('Private chat',exact=True).first).to_be_visible(timeout=30000)
   await header.locator('summary').click(); await header.get_by_role('button',name='Rename workspace Private chat').click()
   await page.get_by_label('Workspace name',exact=True).fill('Private revised'); await page.get_by_role('button',name='SAVE',exact=True).click()
   await expect(header.get_by_text('Private revised',exact=True).first).to_be_visible()
   frames=await page.evaluate('window.__sent.map(s=>JSON.parse(s))')
   assert not any(f.get('type')=='user_message' for f in frames)
   await page.reload(); await page.wait_for_timeout(1000)
   assert await page.get_by_role('button',name='PRIVATE REVISED',exact=True).count()==0
   frames=await page.evaluate('window.__sent.map(s=>JSON.parse(s))')
   assert not any(f.get('type')=='user_message' for f in frames)
   assert not b.errors,b.errors
   print('PASS isolated real-server workflow and saved/incognito chat rename and reload without provider turns')
 finally:
  if b: await b.close()
  server.close()
asyncio.run(main())
