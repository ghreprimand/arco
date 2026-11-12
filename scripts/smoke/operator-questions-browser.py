"""Browser acceptance against isolated Vite; every API/WS request is stubbed."""
import os as _artifact_os
import tempfile as _artifact_tempfile
_artifact_root = _artifact_tempfile.TemporaryDirectory(prefix='arco-browser-artifacts-')
import asyncio, os
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults
from host_isolation import chrome_executable

install_navigation_defaults()

async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=chrome_executable())
  context=await browser.new_context(viewport={'width':1500,'height':1000}, has_touch=True)
  errors=[]
  async def api(route):
   path=urlparse(route.request.url).path
   data={'files':[],'entries':[],'workflows':[],'projects':[],'clusters':[],'skills':[],'plans':[],'items':[],'tasks':[],'sessions':[],'messages':[],'chats':[]}
   if path=='/api/settings':data={'themeId':'arch','enabledProviders':{'codex':True}}
   elif path=='/api/auth-status':data={n:{'loggedIn':n=='codex','installed':True,'cliInstalled':True} for n in ['claude','codex','cursor','ollama','llamacpp','lmstudio','strata','github']}
   elif path=='/api/capabilities':data={'efforts':['low','medium','high'],'models':['gpt-5.5'],'cliVersion':'unknown','codexVersion':'0.162.1'}
   elif path.endswith('/catalog'):data={'models':[]}
   elif path.endswith('/usage'):data={'available':False}
   elif path.endswith('/peer/task-show'):
    task_id=parse_qs(urlparse(route.request.url).query)['id'][0]
    data={'task':await page.evaluate('id=>attentionTasks.find(t=>t.id===id)',task_id),'runs':[],'comments':[]}
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
  mark=page.locator('[data-help="tabbar.waiting-question"]');await mark.wait_for();assert 'Codex questions' in await mark.get_attribute('title')
  assert await mark.evaluate('''el=>{const tab=el.parentElement,close=tab.querySelector('button[aria-label^="Close "]');close.style.minWidth='48px';const a=el.getBoundingClientRect(),b=close.getBoundingClientRect(),h=tab.getBoundingClientRect().height;el.style.display='none';const before=tab.getBoundingClientRect().height;el.style.display='flex';return a.right<=b.left && h===before;}''')
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
  await page.evaluate("""() => {
   testStore.getState().createJob('question-peer',{kind:'chat',name:'Peer',primaryProvider:'codex',primaryModel:'gpt-5.5',primaryEffort:'high',workingDirectory:'/projects/fixture',skipPermissions:false});
   dispatchQuestion({type:'cluster_state',clusterId:'fixture-cluster',state:{clusterId:'fixture-cluster',name:'Fixture team',cwd:'/projects/fixture',createdAt:'',taskBoardMode:'none',taskBoardAttached:false,mailboxDepth:{},members:[{workflowId:'question-ui',displayName:'Alpha',status:'idle'},{workflowId:'question-peer',displayName:'Beta',status:'idle'}]}});
   testStore.getState().setActiveCluster('fixture-cluster');
   dispatchQuestion({type:'operator_question',workflowId:'question-ui',question:{...window.question,requestId:'cluster-question',questions:[{id:'color',header:'Color',question:'Which color?',options:[{label:'Blue',description:''}],allowOther:true,secret:false}]}});
  }""")
  await page.get_by_role('button',name='Alpha in Fixture team has a question').click()
  assert await page.evaluate("testStore.getState().clusterFocusedMember['fixture-cluster']") == 'question-ui'
  # A pending question remains visible even while the narrow list is closed.
  await expect(page.locator('[data-help="tabbar.waiting-question"]')).to_be_visible()
  await expect(page.get_by_role('button',name='? 1 QUESTION',exact=True)).to_be_visible()
  # Open the full list only to inspect the member card.
  member_list=page.get_by_role('button',name='Show the member list',exact=True)
  if await member_list.is_visible(): await member_list.click()
  card=page.locator('[data-help="cluster.member-card"]').filter(has_text='ALPHA')
  await card.get_by_text('? QUESTION',exact=True).wait_for()
  assert await card.get_by_text('? QUESTION',exact=True).evaluate("el=>getComputedStyle(el).color === getComputedStyle(el.closest('[data-help=\"cluster.member-card\"]')).borderColor")
  assert await card.evaluate("el => {const p=document.createElement('i');p.style.color='var(--color-warning)';document.body.appendChild(p);const c=getComputedStyle(p).color;p.remove();return getComputedStyle(el).borderColor===c;}")
  mark=page.locator('[data-help="tabbar.waiting-question"]');await mark.wait_for();assert 'Alpha' in await mark.get_attribute('title')
  # A wider close control models fallback-font metrics seen on hosted runners.
  await mark.locator('xpath=..').locator('button[aria-label^="Delete cluster"]').evaluate("el => { el.style.minWidth = '48px'; }")
  measurements=await page.evaluate(r"""async () => {
   const {THEME_REGISTRY}=await import('/src/themes/registry.ts');
   const {PROVIDER_THEMES}=await import('/src/themes/providerThemes.ts');
   const {applyTheme}=await import('/src/themes/apply.ts');
   const mark=document.querySelector('[data-help="tabbar.waiting-question"]');
   const parse=c=>c.match(/[\d.]+/g).slice(0,3).map(Number);
   const lum=c=>c.map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0);
   return Object.values(THEME_REGISTRY).concat(Object.values(PROVIDER_THEMES)).map(theme=>{
    applyTheme(theme); const style=getComputedStyle(mark), a=lum(parse(style.color)), b=lum(parse(style.backgroundColor));
    const rect=mark.getBoundingClientRect(), tab=mark.parentElement.getBoundingClientRect(), close=mark.parentElement.querySelector('button[aria-label^="Delete cluster"]').getBoundingClientRect();
    return {id:theme.id,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),width:parseFloat(mark.style.width),height:parseFloat(mark.style.height),inside:rect.right<tab.right&&rect.top>tab.top,clear:rect.right<=close.left||rect.bottom<=close.top||rect.top>=close.bottom,animation:style.animationName};
   });
  }""")
  assert measurements and all(m['contrast'] >= 4.5 and m['width'] == 14 and m['height'] == 14 and m['inside'] and m['clear'] and m['animation'] == 'none' for m in measurements), [m for m in measurements if m['contrast'] < 4.5 or m['width'] != 14 or m['height'] != 14 or not m['inside'] or not m['clear'] or m['animation'] != 'none']
  assert await mark.evaluate("el=>{const tab=el.parentElement,h=tab.getBoundingClientRect().height;el.style.display='none';const before=tab.getBoundingClientRect().height;el.style.display='flex';return h===before}")
  print('Question badge themes checked:', len(measurements))
  await page.evaluate("dispatchQuestion({type:'operator_question',workflowId:'question-ui',question:{...window.question,requestId:'cluster-question',status:'answered' ,answers:{color:['Blue']},questions:[{id:'color',header:'Color',question:'Which color?',options:[{label:'Blue',description:''}],allowOther:true,secret:false}]}})")
  await page.locator('[data-help="cluster.member-question"]').wait_for(state='detached');await mark.wait_for(state='detached')
  # Task attention stays visible without opening the narrow member list.
  await page.evaluate("""() => {
   window.attentionTasks=[{id:'accept-fixture',title:'Review fixture change',status:'review',signoff:{state:'met',summary:'Ready',at:1}},{id:'blocked-fixture',title:'Operator decision fixture',status:'blocked',blockedReason:'Needs operator approval'}].map(t=>({links:[],notes:'',priority:0,parentIds:[],createdAt:1,updatedAt:1,...t}));
   window.attentionMembers=testStore.getState().clusters['fixture-cluster'].members;
   testStore.setState(s=>({clusters:{...s.clusters,'fixture-cluster':{...s.clusters['fixture-cluster'],taskBoardMode:'shared',taskBoardAttached:true}},taskLedger:{'/projects/fixture':attentionTasks}}));
  }""")
  capture_dir=_artifact_os.environ.get('ARCO_ATTENTION_SCREENSHOT_DIR',_artifact_root.name)
  _artifact_os.makedirs(capture_dir,exist_ok=True)
  gaps=[]
  for width in [900,1600]:
   await page.set_viewport_size({'width':width,'height':1000})
   await page.evaluate("""async()=>{(await import('/src/layout/layoutRange.ts')).setLayoutMode('narrow');testStore.setState({focusMode:false});document.documentElement.style.zoom='1.1';document.documentElement.style.setProperty('--ui-scale','1.1');dispatchEvent(new Event('resize'));}""")
   close=page.get_by_role('button',name='Close MEMBERS',exact=True)
   if await close.is_visible():await close.click()
   await page.screenshot(path=_artifact_os.path.join(capture_dir,f'attention-{width}.png'))
   if not await page.get_by_test_id('cluster-needs-you').is_visible():gaps.append(f'{width}:closed-list badge missing')
   await page.evaluate("async()=>{(await import('/src/stores/boardTaskRequest.ts')).requestBoardTask('fixture-cluster','accept-fixture')}")
   await page.wait_for_timeout(100)
   if not await page.get_by_test_id('right-panel-slide-out').is_visible():gaps.append(f'{width}:task request did not open BOARD')
   close=page.get_by_role('button',name='Close CLUSTER PANEL',exact=True)
   if await close.is_visible():await close.click()
  assert not gaps,gaps
  theme_ids=await page.evaluate("async()=>Object.keys((await import('/src/themes/registry.ts')).THEME_REGISTRY)")
  cases=[(mode,scale,focus,theme_ids[0],width,members) for mode in ['auto','standard','compact','narrow'] for scale in [1,1.1] for focus in [False,True] for width in [900,1600] for members in [1,24]]
  cases += [('narrow',1.1,False,name,900,24) for name in theme_ids[1:]]
  for n,(mode,scale,focus,theme,width,members) in enumerate(cases):
   await page.set_viewport_size({'width':width,'height':1000})
   await page.evaluate("""async c=>{
    (await import('/src/layout/layoutRange.ts')).setLayoutMode(c.mode);
    const state=testStore.getState(),base=attentionMembers[0];
    const members=Array.from({length:c.members},(_,n)=>({...base,workflowId:n?'attention-peer-'+n:base.workflowId,displayName:'Member '+n}));
    const jobs={...state.jobs};for(const member of members)if(!jobs[member.workflowId])jobs[member.workflowId]={...jobs[base.workflowId],workflowId:member.workflowId};
    testStore.setState({focusMode:c.focus,jobs,clusters:{...state.clusters,'fixture-cluster':{...state.clusters['fixture-cluster'],members}}});
    (await import('/src/themes/apply.ts')).applyTheme((await import('/src/themes/registry.ts')).THEME_REGISTRY[c.theme]);
    document.documentElement.style.zoom=String(c.scale);document.documentElement.style.setProperty('--ui-scale',String(c.scale));dispatchEvent(new Event('resize'));
   }""",{'mode':mode,'scale':scale,'focus':focus,'theme':theme,'members':members})
   badge=page.get_by_test_id('cluster-needs-you')
   await expect(badge).to_have_count(1);await expect(badge).to_be_visible()
   rail=page.get_by_test_id('member-rail')
   narrow=await rail.is_visible()
   if narrow:
    assert await rail.evaluate("e=>{const r=e.getBoundingClientRect(),b=[...e.querySelectorAll('button')].map(x=>x.getBoundingClientRect());return e.scrollWidth<=e.clientWidth+1&&b.every(x=>x.left>=r.left-1&&x.right<=r.right+1)&&b.every((a,i)=>b.slice(i+1).every(z=>Math.min(a.right,z.right)-Math.max(a.left,z.left)<=1||Math.min(a.bottom,z.bottom)-Math.max(a.top,z.top)<=1));}"),(n,'rail overflow/overlap')
   for task_id,label in [('accept-fixture','ACCEPT'),('blocked-fixture','BLOCKED')]:
    if n%2:await badge.tap()
    else:await badge.focus();await page.keyboard.press('Enter')
    choice=page.get_by_role('menuitem').filter(has_text=label).first
    if n%2:await choice.tap()
    else:await choice.focus();await page.keyboard.press('Enter')
    await expect(page.locator('[data-help="cluster.task-drawer"]')).to_be_visible()
    await expect(page.locator('[data-help="cluster.task-drawer"]')).to_contain_text('Review fixture change' if task_id=='accept-fixture' else 'Operator decision fixture')
    if narrow:
     await expect(page.get_by_test_id('right-panel-slide-out')).to_be_visible();await expect(page.get_by_test_id('member-list-slide-out')).to_have_count(0)
     await page.get_by_role('button',name='Close CLUSTER PANEL',exact=True).tap()
   if narrow:
    await page.get_by_role('button',name='Show the member list',exact=True).tap()
    await expect(badge).to_have_count(1)
    await expect(page.get_by_test_id('member-list-slide-out').get_by_test_id('cluster-needs-you')).to_be_visible()
    await badge.tap();await page.get_by_role('menuitem').filter(has_text='ACCEPT').first.tap()
    await expect(page.get_by_test_id('member-list-slide-out')).to_have_count(0)
    await expect(page.get_by_test_id('right-panel-slide-out')).to_be_visible()
    await page.get_by_role('button',name='Close CLUSTER PANEL',exact=True).tap()
  print(f'PASS attention matrix: {len(cases)} cases, one/24 members, every theme, keyboard/touch, accept/blocked and open-list navigation',flush=True)
  assert not errors,errors
  await page.screenshot(path=_artifact_os.path.join(_artifact_root.name, 'arco-questions-browser.png'))
  print('PASS: pending question button/modal, options and descriptions, multiple replies, password input, explicit submit, validation retry, authoritative answered state, disconnect disable and stale snapshot closure. No page errors.')
  await browser.close()
asyncio.run(main())
