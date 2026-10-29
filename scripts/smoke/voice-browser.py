"""Real browser/microphone lifecycle; API/WS isolated, no provider calls."""
import asyncio
import json
import os
import io
import wave
from collections import deque
from urllib.parse import urlparse
from playwright.async_api import async_playwright

async def main():
 async with async_playwright() as p:
  browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME', os.path.expanduser('~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')), args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
  context = await browser.new_context(viewport={'width':1600,'height':1000}, permissions=['microphone'])
  errors, messages, requests = [], [], []
  transcripts = deque()
  delayed = asyncio.Event(); slow = asyncio.Event()
  sample=io.BytesIO()
  with wave.open(sample,'wb') as wav:
   wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000);wav.writeframes(b'\x00\x00'*1600)
  async def api(route):
   path = urlparse(route.request.url).path
   if path.startswith('/api/voice/'):
    requests.append(path)
    if path.endswith('/ready-sound'):
     await route.fulfill(body=sample.getvalue(),content_type='audio/wav');return
    if path.endswith('/session'): data = {'sessionId':'browser-voice'}
    elif path.endswith('/audio'):
     heard=transcripts.popleft() if transcripts else ''
     if isinstance(heard,dict) and heard.pop('slow',False): await slow.wait()
     data = heard if isinstance(heard,dict) else {'text':heard}
    elif path.endswith('/interpret'):
     body = route.request.post_data_json
     assert body['context']['currentId'] in ['worker-a','worker-b']
     if 'delayed' in body['text']:
      await delayed.wait()
     data = {'command':{'action':'member','target':'worker-b','value':''},'model':'gpt-6-luna','effort':'low','usage':{'inputTokens':200,'outputTokens':20,'cachedInputTokens':100}}
    else: data = {'ok':True}
    try: await route.fulfill(json=data)
    except Exception: pass
    return
   data = {'files':[],'entries':[],'dirs':[],'workflows':[],'projects':[],'clusters':[],'skills':[],'plans':[],'items':[],'tasks':[],'sessions':[],'messages':[],'chats':[]}
   if path == '/api/settings': data = {'themeId':'arch','enabledProviders':{'codex':True}}
   elif path == '/api/auth-status': data = {n:{'loggedIn':n=='codex','installed':True,'cliInstalled':True} for n in ['claude','codex','cursor','ollama','llamacpp','lmstudio','strata','deepseek','github']}
   elif path == '/api/capabilities': data = {'efforts':['low','medium','high'],'models':['gpt-6-luna'],'cliVersion':'fixture','codexVersion':'0.162.1'}
   elif path.endswith('/catalog'): data = {'models':[]}
   elif path.endswith('/usage'): data = {'available':False}
   await route.fulfill(json=data)
  await context.route('**/api/**',api)
  await context.route('**/healthz',lambda r:r.fulfill(json={'status':'live'}))
  await context.route('https://**/*',lambda r:r.abort())
  # The app may reconnect, so push server-initiated messages to every socket.
  sockets=[]
  def push(message):
   for sk in sockets:
    try: sk.send(json.dumps(message))
    except Exception: pass
  def ws(ws):
   sockets.append(ws)
   def incoming(raw):
    try:
     data = json.loads(raw); messages.append(data)
     if data.get('type') == 'create_workflow' and data.get('config',{}).get('kind') == 'chat':
      ws.send(json.dumps({'type':'workflow_created','workflowId':'computer-chat','config':data['config']}))
    except Exception: pass
   ws.on_message(incoming)
  await context.route_web_socket('**/*',ws)
  await context.add_init_script('''
   window.micCalls=0;window.micStreams=[];
   const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
   navigator.mediaDevices.getUserMedia=async opts=>{window.micCalls++;const stream=await original(opts);window.micStreams.push(stream);if(window.delayMic)await new Promise(r=>window.releaseMic=r);return stream;};
   const OriginalNode=window.AudioWorkletNode;
   window.AudioWorkletNode=class extends OriginalNode{constructor(...args){super(...args);window.voiceNode=this;}};
  ''')
  page = await context.new_page(); page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('console',lambda m:errors.append(m.text) if '[arco] render boundary caught' in m.text else None)
  await page.goto(os.environ.get('ARCO_VOICE_PREVIEW_URL','http://127.0.0.1:5193/')); await page.wait_for_timeout(700)
  await page.evaluate('''async()=>{
   // Match modules already loaded by Vite, including any HMR timestamp.
   const loaded=path=>performance.getEntriesByType('resource').map(e=>e.name).findLast(url=>new URL(url).pathname===path) ?? path;
   const {useAppStore:s}=await import(loaded('/src/stores/appStore.ts'));window.testStore=s;
   const {useVoiceStore:v}=await import(loaded('/src/voice/store.ts'));window.voiceStore=v;
   const {readDraft}=await import(loaded('/src/stores/draftStore.ts'));window.readVoiceDraft=readDraft;
   for(const id of ['worker-a','worker-b','notes'])s.getState().createJob(id,{name:id,workingDirectory:'/tmp/voice-browser',skipPermissions:false,primaryProvider:'codex',primaryModel:'gpt-6-luna',primaryEffort:'low',codexTransport:'appserver'});
   s.getState().setClusterState('atlas',{clusterId:'atlas',name:'Atlas',cwd:'/tmp/voice-browser',createdAt:'',taskBoardMode:'none',taskBoardAttached:false,mailboxDepth:{'worker-b':2},members:[{workflowId:'worker-a',displayName:'Builder one',status:'idle'},{workflowId:'worker-b',displayName:'Reviewer',status:'busy'}]});
   s.setState(st=>({focusMode:false,connected:true,connectionState:'connected',showCreator:false,jobs:Object.fromEntries(Object.entries(st.jobs).map(([id,j])=>[id,{...j,snapshotReceived:true,busy:id==='worker-b'}]))}));
   s.getState().setActiveJob('notes');
  }''')
  assert await page.evaluate('window.micCalls') == 0
  await page.get_by_role('button',name='Hands-free voice controls',exact=True).click()
  assert await page.evaluate('window.micCalls') == 0
  await page.get_by_label('Spoken feedback',exact=True).uncheck()
  await page.get_by_role('button',name='ENABLE HANDS-FREE',exact=True).click()
  await page.wait_for_function("window.voiceNode && voiceStore.getState().phase==='listening'")
  assert await page.evaluate('window.micCalls') == 1
  layout=await page.get_by_role('complementary',name='Hands-free controls').evaluate('''el=>({height:el.getBoundingClientRect().height,position:getComputedStyle(el).position,bottom:el.getBoundingClientRect().bottom,contentTop:el.nextElementSibling.getBoundingClientRect().top})''')
  assert layout['height']<=42 and layout['position'] not in ['fixed','absolute'] and layout['bottom']<=layout['contentTop'],layout
  assert not await page.get_by_label('Spoken feedback',exact=True).is_visible()
  await page.get_by_role('button',name='Open voice details',exact=True).click()
  assert await page.get_by_label('Spoken feedback',exact=True).is_visible()
  assert await page.get_by_role('complementary',name='Hands-free controls').evaluate('el=>el.getBoundingClientRect().bottom<=el.nextElementSibling.getBoundingClientRect().top')
  await page.get_by_role('button',name='Close voice details',exact=True).click()
  # Only one tab on this browser origin may own the microphone.
  other = await context.new_page()
  other.on('pageerror', lambda e: errors.append('other: '+str(e)))
  await other.goto(os.environ.get('ARCO_VOICE_PREVIEW_URL','http://127.0.0.1:5193/'))
  await other.wait_for_timeout(700)
  # Arco's existing single-tab guard blocks the duplicate App. Mount
  # the real voice controls alone to exercise the additional mic lock.
  await other.evaluate('''async()=>{
   const reactModule=await import('/node_modules/.vite/deps/react.js');
   const React=reactModule.default ?? reactModule;
   const domModule=await import('/node_modules/.vite/deps/react-dom_client.js');
   const createRoot=domModule.createRoot ?? domModule.default.createRoot;
   const {VoiceControl,VoiceButton}=await import('/src/components/VoiceControl.tsx');
   const node=document.createElement('div');node.style.cssText='position:relative;z-index:100000';document.body.appendChild(node);
   createRoot(node).render(React.createElement(React.Fragment,null,React.createElement(VoiceControl,{sendMessage:()=>false,cancel:()=>{}}),React.createElement(VoiceButton)));
  }''')
  await other.get_by_role('button',name='Hands-free voice controls',exact=True).click()
  await other.get_by_role('button',name='ENABLE HANDS-FREE',exact=True).click()
  await other.get_by_role('alert').filter(has_text='another Arco window').wait_for()
  assert await other.evaluate('window.micCalls') == 0
  await other.close()
  async def say(text, predicate):
   transcripts.append(text)
   await page.evaluate("window.voiceNode.port.onmessage({data:new Int16Array(400).buffer})")
   try: await page.wait_for_function(predicate, timeout=10000)
   except Exception:
    print('Command failed:',text,await page.evaluate('JSON.stringify({voice:voiceStore.getState(),cluster:testStore.getState().activeClusterId,clusters:testStore.getState().clusters,job:testStore.getState().activeJobId})'),errors)
    raise
  await say('Computer',"voiceStore.getState().commandText===''")
  assert await page.evaluate('testStore.getState().activeClusterId') is None
  await page.wait_for_timeout(10000)
  assert await page.evaluate('testStore.getState().activeClusterId') is None
  # Every directive goes to the Computer chat (runtime.ts: no exact matching);
  # the model acts through voice_tool_call round trips, which this fixture
  # plays the part of. A settled "Done." reply ends each request silently.
  chat_sent=lambda:[m for m in messages if m.get('type')=='user_message' and m.get('workflowId')=='computer-chat']
  tool_results=lambda:[m for m in messages if m.get('type')=='voice_tool_result']
  replies=[0]
  async def sent_to_computer(count, ending):
   for _ in range(100):
    if len(chat_sent())>=count: break
    await page.wait_for_timeout(100)
   assert len(chat_sent())==count and chat_sent()[-1]['content'].endswith('\n\n'+ending),chat_sent()
  async def computer_tool(request_id, tool, args, predicate):
   push({'type':'voice_tool_call','workflowId':'computer-chat','requestId':request_id,'tool':tool,'args':args})
   try: await page.wait_for_function(predicate, timeout=8000)
   except Exception:
    print('Tool failed:',tool,args,[r for r in tool_results() if r['requestId']==request_id],await page.evaluate('JSON.stringify({cluster:testStore.getState().activeClusterId,job:testStore.getState().activeJobId,status:voiceStore.getState().status})'),errors)
    raise
   for _ in range(50):
    if any(r['requestId']==request_id for r in tool_results()): break
    await page.wait_for_timeout(100)
   result=[r for r in tool_results() if r['requestId']==request_id]
   assert len(result)==1 and result[0]['ok'] is True,result
   return result[0]['result']
  async def settle():
   replies[0]+=1
   await page.evaluate("id=>testStore.getState().addMessage('computer-chat',{id,role:'assistant',content:'Done.',isStreaming:false,timestamp:Date.now()})",f'done-{replies[0]}')
   await page.wait_for_function("voiceStore.getState().status==='Done.'")
  await say('open Atlas',"voiceStore.getState().commandText==='open Atlas'")
  await say({'text':'And capture','phrases':'end capture'},"voiceStore.getState().calls===1 && !!testStore.getState().jobs['computer-chat']")
  await sent_to_computer(1,'open Atlas')
  assert await page.evaluate('testStore.getState().activeClusterId') is None, 'nothing moves before Computer acts'
  await computer_tool('n1','arco_select',{'target':'Atlas'},"testStore.getState().activeClusterId==='atlas'")
  await settle()
  # The END CAPTURE button flushes the real worklet and queues behind the
  # phrase still being recognized, so the directive keeps its last words.
  await say('Computer open',"voiceStore.getState().commandText==='open'")
  transcripts.append({'text':'plan','slow':True})
  await page.evaluate("window.voiceNode.port.onmessage({data:new Int16Array(400).buffer})")
  await page.wait_for_function("voiceStore.getState().phase==='recognizing'")
  await page.get_by_role('button',name='END CAPTURE',exact=True).click()
  await page.wait_for_function("voiceStore.getState().status.startsWith('Finishing the last phrase')")
  await page.wait_for_timeout(400)
  assert await page.evaluate("voiceStore.getState().commandText") == 'open'
  assert len(chat_sent())==1, 'nothing reaches Computer before the last phrase is recognized'
  slow.set()
  await page.wait_for_function("voiceStore.getState().commandText===null")
  await sent_to_computer(2,'open plan')
  await computer_tool('n2','arco_open_panel',{'panel':'plan'},"localStorage.getItem('arco.clusterSidePanelTab.byCluster')?.includes('plan')")
  await settle()
  await say('Computer show member two. End capture',"voiceStore.getState().commandText===null && voiceStore.getState().calls===3")
  await sent_to_computer(3,'show member two')
  await computer_tool('n3','arco_select',{'target':'member two'},"testStore.getState().clusterFocusedMember.atlas==='worker-b'")
  await settle()
  await say('Computer open activity. End capture',"voiceStore.getState().commandText===null && voiceStore.getState().calls===4")
  await sent_to_computer(4,'open activity')
  await computer_tool('n4','arco_open_panel',{'panel':'activity'},"localStorage.getItem('arco.clusterSidePanelTab.byCluster')?.includes('activity')")
  await settle()
  assert '/api/voice/interpret' not in requests
  await page.evaluate("testStore.getState().setClusterFocusedMember('atlas','worker-a')")
  await say('Computer bring up my reviewer please. End capture',"voiceStore.getState().calls===5 && testStore.getState().clusterFocusedMember.atlas==='worker-a' && testStore.getState().activeClusterId==='atlas'")
  created=[m for m in messages if m.get('type')=='create_workflow']
  assert len(created)==1 and created[0]['config']['voiceOperator'] is True and created[0]['config']['kind']=='chat',created
  await sent_to_computer(5,'bring up my reviewer please')
  assert chat_sent()[-1]['content'].startswith('[Arco context] selected: Builder one'),chat_sent()
  assert '/api/voice/interpret' not in requests
  # The model calls a tool: the server relays it to this window, which executes
  # it through the bounded executor and answers; the window never guesses.
  assert await computer_tool('r1','arco_select',{'target':'member two'},"testStore.getState().clusterFocusedMember.atlas==='worker-b'") == 'Reviewer selected.'
  assert await computer_tool('r2','arco_send_message',{'target':'reviewer','text':'Please re-run the failing tests.','mode':'follow-up'},"true") == 'Follow-up queued to Reviewer.'
  relayed=[m for m in messages if m.get('type')=='user_message' and m.get('workflowId')=='worker-b' and m.get('kind')=='follow-up']
  assert len(relayed)==1 and relayed[-1]['content']=='Please re-run the failing tests.',relayed
  before=len(tool_results())
  push({'type':'voice_tool_call','workflowId':'other-chat','requestId':'r3','tool':'arco_status','args':{}})
  await page.wait_for_timeout(200)
  assert len(tool_results())==before, 'a call for a chat this window did not open is ignored'
  # The settled reply of the Computer chat is spoken (status) once; a late reply after disable is not.
  await page.evaluate("testStore.getState().addMessage('computer-chat',{id:'a1',role:'assistant',content:'Your reviewer is up.',isStreaming:false,timestamp:Date.now()})")
  await page.wait_for_function("voiceStore.getState().status==='Your reviewer is up.'")
  await say("Computer go to notes and find out where things stand with it. End capture", "voiceStore.getState().calls===6")
  await sent_to_computer(6,'go to notes and find out where things stand with it')
  # A project update is now the model's choice of tools: select, then ask.
  assert await computer_tool('n5','arco_select',{'target':'notes'},"testStore.getState().activeJobId==='notes'") == 'notes selected.'
  assert await computer_tool('n6','arco_send_message',{'target':'notes','text':'Give me a concise status update. Do not start new work.','mode':'follow-up'},"true") == 'Follow-up queued to notes.'
  updates=[m for m in messages if m.get('type')=='user_message' and m.get('workflowId')=='notes']
  assert len(updates)==1 and 'Do not start new work' in updates[0]['content'],updates
  await settle()
  await page.evaluate("testStore.getState().setActiveCluster('atlas');testStore.getState().setClusterFocusedMember('atlas','worker-b')")
  await say('Computer', "voiceStore.getState().commandText===''")
  await say('Explain what', "voiceStore.getState().commandText==='Explain what'")
  await say('Computer means here.', "voiceStore.getState().commandText==='Explain what Computer means here.'")
  await say('End capture', "voiceStore.getState().calls===7")
  await sent_to_computer(7,'Explain what Computer means here')
  assert chat_sent()[-1]['content'].startswith('[Arco context] selected: Reviewer'),chat_sent()
  assert await page.evaluate("testStore.getState().activeClusterId") == 'atlas', 'voice never moves the operator onto the Computer tab'
  assert len([m for m in messages if m.get('type')=='create_workflow']) == 1
  await page.evaluate("testStore.getState().setActiveCluster('atlas')")
  await page.evaluate("testStore.getState().setClusterFocusedMember('atlas','worker-a')")
  await say('Computer tell me something slow please. End capture', "voiceStore.getState().calls===8")
  await sent_to_computer(8,'tell me something slow please')
  await page.get_by_role('button',name='DISABLE · MIC OFF',exact=True).click()
  assert await page.evaluate("micStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))")
  await page.evaluate("testStore.getState().addMessage('computer-chat',{id:'a2',role:'assistant',content:'Late answer.',isStreaming:false,timestamp:Date.now()})")
  await page.wait_for_timeout(150)
  assert await page.evaluate("voiceStore.getState().status") != 'Late answer.', 'a reply after disable is not spoken'
  before=len(tool_results())
  push({'type':'voice_tool_call','workflowId':'computer-chat','requestId':'r4','tool':'arco_select','args':{'target':'member two'}})
  await page.wait_for_timeout(200)
  assert len(tool_results())==before, 'no tool runs after disable'
  assert await page.evaluate("testStore.getState().clusterFocusedMember.atlas") == 'worker-a'
  assert not await page.evaluate('voiceStore.getState().enabled')
  # A permission/device promise resolving after disable must close its stream.
  await page.get_by_role('button',name='Hands-free voice controls',exact=True).click()
  await page.evaluate('window.delayMic=true')
  await page.get_by_role('button',name='ENABLE HANDS-FREE',exact=True).click()
  await page.wait_for_function("typeof window.releaseMic==='function'")
  await page.get_by_role('button',name='DISABLE · MIC OFF',exact=True).click()
  await page.evaluate('window.releaseMic()')
  await page.wait_for_function("micStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))")
  await page.screenshot(path='/tmp/arco-voice-browser.png')
  assert not errors,errors
  await page.reload(); await page.wait_for_timeout(600)
  assert await page.evaluate('window.micCalls') == 0
  assert await page.get_by_role('button',name='Hands-free voice controls',exact=True).get_attribute('aria-pressed')=='false'
  print('PASS: standalone Computer survives a ten-second pause until End capture; later Computer is literal text and cannot reset capture; off has zero mic access; explicit enable; cluster/member/panel navigation through Computer tool calls; follow-up; END button waits for in-flight recognition; free-form requests go to the voiceOperator Computer chat with the context line while the operator selection is kept; voice_tool_call round trips execute through the bounded executor and ignore other chats; settled replies are spoken once and never after disable; late permission closes tracks; reload stays off; no page errors.')
  await browser.close()
asyncio.run(main())
