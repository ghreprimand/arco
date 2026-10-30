"""Exercise the workspace rename control with isolated synthetic results."""
import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
PORT=os.environ.get('ARCO_CLIENT_PORT','5203')
ORIGIN='http://127.0.0.1:'+PORT
ROOT=Path(__file__).resolve().parents[2]
ENV='/@fs'+str((ROOT/'node_modules/vite/dist/client/env.mjs').resolve())
SHARED='/@fs'+str((ROOT/'shared').resolve())+'/'
HTML='''<!doctype html><html><body><div id="fixture"></div><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;window.ready=true;</script></body></html>'''
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
  page=await browser.new_page(); blocked=[]; errors=[]
  async def isolate(route):
   u=urlparse(route.request.url)
   if u.scheme=='http' and u.netloc=='127.0.0.1:'+PORT:
    if u.path=='/fixture': return await route.fulfill(status=200,content_type='text/html',body=HTML)
    if u.path==ENV or u.path.startswith(SHARED) or u.path.startswith(('/@react-refresh','/@vite/','/@id/','/node_modules/.vite/deps/','/src/')): return await route.continue_()
   blocked.append(route.request.url); await route.abort()
  await page.route('**/*',isolate); await page.route_web_socket('**/*',lambda ws:None)
  page.on('pageerror',lambda e:errors.append(str(e)))
  await page.goto(ORIGIN+'/fixture'); await page.wait_for_function('window.ready===true')
  await page.evaluate('''async()=>{
   const React=(await import('/node_modules/.vite/deps/react.js')).default;
   const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
   const {TabBar} = await import('/src/components/TabBar.tsx');
   const {useAppStore}=await import('/src/stores/appStore.ts');
   const {handleServerMessage}=await import('/src/ws/handleServerMessage.ts');
   const {useDraftStore}=await import('/src/stores/draftStore.ts');
   window.connected=true;window.requests=[];
   useAppStore.getState().createJob('fixture-id',{name:'Original',primaryModel:'fixture',primaryEffort:'low',primaryProvider:'claude',workingDirectory:'/projects/fixture'});
   useAppStore.getState().setActiveJob('fixture-id');
   useDraftStore.getState().setDraft('fixture-id','Retained draft');
   useAppStore.getState().addAttachment('fixture-id',{filename:'fixture.txt',path:'/projects/fixture/fixture.txt',isImage:false});
   useAppStore.setState(s=>({jobs:{...s.jobs,'fixture-id':{...s.jobs['fixture-id'],busy:true}}}));
   window.stores={useAppStore,useDraftStore};
   const noop=()=>{};
   createRoot(document.getElementById('fixture')).render(React.createElement(TabBar,{onRenameWorkflow:(id,value,requestId)=>{if(!window.connected)return false;window.requests.push({id,value,requestId});return true;},onRemoveWorkflow:noop,onCreateCluster:noop,onDeleteCluster:noop,onAddClusterMember:noop,onCreateClusterWithFreshWorkers:noop}));
   window.reply=(error)=>{const r=window.requests.at(-1);if(!error)handleServerMessage({type:'workflow_renamed',workflowId:r.id,name:r.value||null},{wsRef:{current:null},scheduleReconnect:noop});handleServerMessage({type:'workflow_rename_result',workflowId:r.id,requestId:r.requestId,error},{wsRef:{current:null},scheduleReconnect:noop});};
  }''')
  await page.get_by_role('button',name='Rename workspace Original',exact=True).click()
  field=page.get_by_label('Workspace name'); await field.fill('cancelled'); await field.press('Escape')
  assert await page.get_by_role('button',name='ORIGINAL',exact=True).count()==1 and await page.evaluate('requests.length')==0
  await page.get_by_role('button',name='Rename workspace Original',exact=True).click()
  await field.fill('x'*65); await field.press('Enter'); await expect(page.get_by_role('alert')).to_contain_text('64')
  await field.fill('  Revised  '); await page.evaluate('connected=false'); await field.press('Enter'); await expect(page.get_by_role('alert')).to_contain_text('Not connected')
  await page.evaluate('connected=true'); await field.press('Enter'); await expect(page.get_by_role('button',name='SAVING...')).to_be_disabled()
  assert await page.get_by_role('button',name='ORIGINAL',exact=True).count()==1
  await page.evaluate("window.dispatchEvent(new CustomEvent('arco:workflow-rename-result',{detail:{workflowId:'fixture-id',requestId:'wrong'}}))")
  await expect(page.get_by_role('button',name='SAVING...')).to_be_disabled()
  await page.evaluate("reply('Could not save the workspace name.')"); await expect(page.get_by_role('alert')).to_contain_text('Could not save')
  await field.press('Enter'); await page.evaluate('reply()'); await expect(page.get_by_role('dialog')).to_have_count(0)
  assert await page.get_by_role('button',name='REVISED',exact=True).count()==1
  await page.get_by_role('button',name='Rename workspace Revised',exact=True).click(); await field.fill('<img src=x>'); await field.press('Enter'); await page.evaluate('reply()')
  await expect(page.get_by_role('dialog')).to_have_count(0)
  assert await page.locator('img').count()==0
  await page.get_by_role('button',name='Rename workspace <img src=x>',exact=True).click(); await field.fill('   '); await field.press('Enter')
  assert await page.evaluate('requests.at(-1).value')==''
  await page.evaluate('reply()'); await expect(page.get_by_role('dialog')).to_have_count(0)
  assert await page.evaluate("stores.useDraftStore.getState().drafts['fixture-id']")=='Retained draft'
  assert await page.evaluate("stores.useAppStore.getState().attachments['fixture-id'][0].filename")=='fixture.txt'
  assert await page.evaluate("stores.useAppStore.getState().jobs['fixture-id'].busy") is True
  assert not blocked and not errors, (blocked,errors)
  await browser.close(); print('PASS workspace rename validation, cancellation, disconnect, failure and matching acknowledgement')
asyncio.run(main())
