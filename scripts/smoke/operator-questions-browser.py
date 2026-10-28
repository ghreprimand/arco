"""Browser acceptance against isolated Vite; every API/WS request is stubbed."""
import asyncio, os
from urllib.parse import urlparse
from playwright.async_api import async_playwright

async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME',os.path.expanduser('~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')))
  context=await browser.new_context(viewport={'width':1500,'height':1000})
  errors=[]
  async def api(route):
   path=urlparse(route.request.url).path
   data={'files':[],'entries':[],'workflows':[],'projects':[],'clusters':[],'skills':[],'plans':[],'items':[],'tasks':[],'sessions':[],'messages':[],'chats':[]}
   if path=='/api/settings':data={'themeId':'arch','enabledProviders':{'codex':True}}
   elif path=='/api/auth-status':data={n:{'loggedIn':n=='codex','installed':True,'cliInstalled':True} for n in ['claude','codex','cursor','gemini','ollama','llamacpp','lmstudio','strata','antigravity','github']}
   elif path=='/api/capabilities':data={'efforts':['low','medium','high'],'models':['gpt-5.5'],'cliVersion':'unknown','codexVersion':'0.162.1'}
   elif path.endswith('/catalog'):data={'models':[]}
   elif path.endswith('/usage'):data={'available':False}
   await route.fulfill(json=data)
  await context.route('**/api/**',api)
  await context.route('**/healthz',lambda r:r.fulfill(json={'status':'live'}))
  await context.route('https://**/*',lambda r:r.abort())
  await context.route_web_socket('**/*',lambda ws:ws.on_message(lambda msg:None))
  page=await context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  await page.goto(os.environ.get('ARCO_QUESTIONS_PREVIEW_URL','http://127.0.0.1:5187/'));await page.wait_for_timeout(600)
  await page.evaluate('''async()=>{
   const {useAppStore:s}=await import('/src/stores/appStore.ts');window.testStore=s;window.sent=[];
   const {handleServerMessage:h}=await import('/src/ws/handleServerMessage.ts');window.dispatchQuestion=m=>h(m,{wsRef:{current:null},scheduleReconnect:()=>{}});
   s.getState().createJob('question-ui',{kind:'chat',name:'Codex questions',primaryProvider:'codex',primaryModel:'gpt-5.5',primaryEffort:'high',codexTransport:'appserver',workingDirectory:'',skipPermissions:false});
   s.setState(st=>({focusMode:false,connected:true,connectionState:'connected',showCreator:false,activeJobId:'question-ui',wsSendRaw:m=>window.sent.push(m),jobs:{...st.jobs,'question-ui':{...st.jobs['question-ui'],snapshotReceived:true,busy:true}}}));
   window.question={requestId:'browser-question',provider:'codex',threadId:'thread',turnId:'turn',itemId:'item',createdAt:Date.now(),mode:'blocking',status:'pending',questions:[
    {id:'where',header:'Destination',question:'Where should I work?',options:[{label:'Stay',description:'Use the current location.'},{label:'Move',description:'Choose a different location.'}],allowOther:true,secret:false},
    {id:'secret',header:'Secret',question:'What is the value?',allowOther:true,secret:true}
   ]};
   dispatchQuestion({type:'operator_question',workflowId:'question-ui',question:window.question});
  }''')
  badge=page.get_by_role('button',name='? 1 QUESTION',exact=True);await badge.wait_for();await badge.click()
  dialog=page.get_by_role('dialog',name='Pending agent questions');await dialog.wait_for()
  submit=dialog.get_by_role('button',name='SEND ANSWERS');assert await submit.is_disabled()
  await dialog.get_by_role('button',name='Stay Use the current location.').click()
  # Password inputs do not have a textbox ARIA role.
  secret=dialog.locator('input[type=password]');await secret.fill('private-browser-value')
  await submit.click();await page.wait_for_timeout(50)
  sent=await page.evaluate('window.sent');assert sent[-1]['answers']=={'where':['Stay'],'secret':['private-browser-value']}
  await page.evaluate("dispatchQuestion({type:'operator_question_reply_result',workflowId:'question-ui',requestId:'browser-question',ok:false,error:'Retry this answer.'})")
  await dialog.get_by_role('alert').wait_for();assert await submit.is_enabled()
  await submit.click()
  await page.evaluate("dispatchQuestion({type:'operator_question',workflowId:'question-ui',question:{...window.question,status:'answered',answers:{where:['Stay'],secret:['[redacted]']}}})")
  await dialog.wait_for(state='hidden');assert await badge.count()==0
  body=await page.locator('body').inner_text();assert 'private-browser-value' not in body;assert 'Answer sent (hidden)' in body
  await page.evaluate("dispatchQuestion({type:'operator_question',workflowId:'question-ui',question:{...window.question,requestId:'async-browser',mode:'async',questions:[{id:'color',header:'Color',question:'Which color next?',options:[{label:'Blue',description:''}],allowOther:true,secret:false}]}})")
  await badge.click();await page.evaluate("testStore.setState({connected:false})")
  assert await dialog.get_by_role('button',name='Blue',exact=True).is_disabled()
  await page.evaluate("testStore.setState({connected:true}); dispatchQuestion({type:'workflow_state_snapshot',workflowId:'question-ui',workers:{},busy:false,transcriptTail:[],operatorQuestions:[]})")
  await dialog.wait_for(state='hidden');assert await badge.count()==0
  assert 'no longer pending on the server' in await page.locator('body').inner_text()
  assert not errors,errors
  await page.screenshot(path='/tmp/arco-questions-browser.png')
  print('PASS: pending question button/modal, options and descriptions, multiple replies, password input, explicit submit, validation retry, authoritative answered state, disconnect disable and stale snapshot closure. No page errors.')
  await browser.close()
asyncio.run(main())
