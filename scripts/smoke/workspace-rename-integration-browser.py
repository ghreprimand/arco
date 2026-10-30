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
   await rename.click(); await page.get_by_label('Workspace name').fill('Renamed'); await page.get_by_role('button',name='SAVE',exact=True).click()
   await page.get_by_role('button',name='Rename workspace Renamed',exact=True).wait_for(timeout=15000)
   sessions=(await (await page.request.get(server.base+'/api/sessions',params={'path':str(server.projects/'app')})).json())['sessions']
   assert any(s.get('arcoName')=='Renamed' for s in sessions),sessions
   frames=await page.evaluate('window.__sent.map(s=>JSON.parse(s))')
   assert not any(f.get('type')=='user_message' for f in frames)
   await page.reload(); await page.get_by_role('button',name='Rename workspace Renamed',exact=True).wait_for(timeout=30000)
   assert not b.errors,b.errors
   print('PASS isolated real-server rename, session discovery and reload without provider turns')
 finally:
  if b: await b.close()
  server.close()
asyncio.run(main())
