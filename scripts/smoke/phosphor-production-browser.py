"""Real App + real SettingsPanel, fixture-only network. Run against Vite :5179.
No workflow server, production preferences or real WebSocket are accessed.
"""
import asyncio, json, os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright

ART = Path('/tmp/arco-phosphor-production'); ART.mkdir(exist_ok=True)
CHROME = os.environ.get('ARCO_TEST_CHROME', os.path.expanduser('~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'))
async def main():
 async with async_playwright() as p:
  browser = await p.chromium.launch(executable_path=CHROME, args=['--enable-unsafe-swiftshader'])
  context = await browser.new_context(viewport={'width':1536,'height':1080})
  initial_scale = os.environ.get('ARCO_TEST_UI_SCALE', '1.1')
  await context.add_init_script(f"localStorage.setItem('arco_ui_scale', '{initial_scale}')")
  settings = {'themeId':'arch','enabledProviders':{'claude':True},'fontPackOverride':'jetbrains-uniform','uiScale':float(initial_scale)}
  errors, writes, messages = [], [], []
  async def api(route):
   nonlocal settings
   req=route.request; path=urlparse(req.url).path
   # POST /api/session mints the WebSocket session cookie (client/src/utils/wsSession.ts).
   if req.method != 'GET' and path == '/api/session':
    await route.fulfill(json={'ok':True}); return
   if req.method != 'GET':
    assert path == '/api/settings', 'Unexpected consequential operation: '+path
    patch=req.post_data_json; writes.append(patch); settings={**settings, **patch}
   data={}
   if path == '/api/settings': data=settings
   elif path == '/api/auth-status': data={name:{'loggedIn':name=='claude','installed':True,'cliInstalled':True} for name in ['claude','codex','cursor','ollama','llamacpp','lmstudio','strata','deepseek','github']}
   elif path == '/api/capabilities': data={'efforts':['low','medium','high'],'models':['claude-opus-4-6'],'cliVersion':'fixture'}
   elif path == '/api/usage': data={'available':False}
   elif path.endswith('/catalog'): data={'models':[]}
   elif path == '/api/project-trust': data={'entries':[],'defaultProjectTrust':'ask'}
   elif path == '/api/skills': data={'project':[],'global':[]}
   elif path == '/api/deepseek': data={'managed':False,'profiles':[],'live':None}
   elif path == '/api/list-dirs': data={'dirs':[],'path':'/demo/Arco','parent':'/demo'}
   elif path == '/api/handoff-prompts':
    modes=['original-worker','fresh-summarizer','ollama-compaction']
    data={'defaults':{m:'Fixture handoff prompt' for m in modes},'global':{m:None for m in modes},'project':{m:None for m in modes},'effective':{m:{'source':'default','sourcePath':None} for m in modes}}
   else: data={'files':[],'entries':[],'workflows':[],'projects':[],'clusters':[],'skills':[],'plans':[],'items':[],'tasks':[],'sessions':[],'messages':[]}
   await route.fulfill(json=data)
  await context.route('**/api/**',api)
  await context.route('**/healthz',lambda r:r.fulfill(json={'status':'live'}))
  await context.route('https://**/*',lambda r:r.abort())
  await context.route_web_socket('**/*', lambda ws: ws.on_message(lambda msg: messages.append(msg)))
  page=await context.new_page(); page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('console',lambda msg: print(msg.text) if msg.type=='error' and 'Error' in msg.text else None)
  await page.goto(f"http://127.0.0.1:{os.environ.get('ARCO_CLIENT_PORT', '5179')}/")
  await page.wait_for_timeout(1000)
  await page.evaluate('''async () => {
    const {useAppStore:s}=await import('/src/stores/appStore.ts'); window.testStore=s;
    const fixtures=await import('/src/phosphor-demo/fixtures.ts');
    s.getState().createJob('style-fixture',{name:'Presentation review',primaryProvider:'claude',primaryModel:'claude-opus-4-6',primaryEffort:'high',skipPermissions:false,workingDirectory:'/demo/Arco'});
    s.setState(st=>({connected:true,connectionState:'connected',showCreator:false,activeJobId:'style-fixture',jobs:{...st.jobs,'style-fixture':{...st.jobs['style-fixture'],messages:[...fixtures.history,...fixtures.recent],snapshotReceived:true,busy:false}}}));
  }''')
  await page.wait_for_timeout(1200)
  await page.screenshot(path=str(ART/'classic-real-app.png'))
  assert await page.get_by_text('THIS VIEW HIT A RENDER ERROR',exact=True).count()==0, await page.locator('body').inner_text()
  assert not errors, errors
  await page.evaluate("testStore.getState().setSettings({...testStore.getState().settings, fontPackOverride:''})")
  # Only theme/settings objects change; the workbench JSX and contents stay mounted.
  await page.evaluate("testStore.getState().setThemeId('phosphor:arco:arco-crt')")
  await page.wait_for_timeout(400)
  await page.screenshot(path=str(ART/'phosphor-real-app.png'))
  assert await page.locator('html').get_attribute('data-theme-family') == 'phosphor'
  assert await page.locator('.phosphor-ambient').count()==1
  assert await page.locator('canvas').count()==1
  assert await page.locator('.arco-markdown').first.evaluate('e=>getComputedStyle(e).textShadow') != 'none'
  baseline=await page.evaluate('JSON.stringify(testStore.getState().jobs)')
  buttons=await page.locator('button').all_text_contents()
  text=await page.locator('.arco-markdown').all_text_contents()
  for palette in ['default','everforest','amber','phosphor','red-planet','arco-crt']:
   await page.evaluate('(id)=>testStore.getState().setThemeId(id)','phosphor:arco:'+palette)
   await page.wait_for_timeout(100)
   now=await page.evaluate('JSON.stringify(testStore.getState().jobs)')
   if now!=baseline:
    # Name the changed fields: the Windows runner reported only a bare AssertionError.
    a,b=json.loads(baseline),json.loads(now)
    changed=[(j,k,str(a.get(j,{}).get(k))[:200],str(b.get(j,{}).get(k))[:200]) for j in sorted(set(a)|set(b)) for k in sorted(set(a.get(j,{}))|set(b.get(j,{}))) if a.get(j,{}).get(k)!=b.get(j,{}).get(k)]
    raise AssertionError({'palette':palette,'changed':changed})
   current_buttons=await page.locator('button').all_text_contents()
   assert current_buttons==buttons, {'palette':palette,'before':buttons,'after':current_buttons}
   assert await page.locator('.arco-markdown').all_text_contents()==text
   assert await page.locator('.phosphor-ambient').count()==1
  await page.evaluate('testStore.getState().setShowSettings(true)')
  await page.wait_for_timeout(500)
  await page.screenshot(path=str(ART/'settings-open.png'))
  assert not errors, errors
  assert await page.locator('[data-help="settings.themes"]').count()==1, await page.locator('body').inner_text()
  # At the smallest supported desktop viewport, scale changes must leave the
  # Settings header and CLOSE reachable while the body remains scrollable.
  await page.set_viewport_size({'width':1280,'height':720})
  scale_control = page.get_by_role('group', name='Interface text size')
  for percent in ['150%', '90%', '100%', '110%', '120%', '130%']:
   await scale_control.get_by_role('button', name=percent, exact=True).click()
   await page.wait_for_function('(value) => Number(document.documentElement.style.zoom) === value', arg=int(percent[:-1]) / 100)
   content = page.locator('.settings-content')
   assert await content.evaluate('e => e.scrollHeight > e.clientHeight')
   await content.evaluate('e => e.scrollTop = e.scrollHeight')
   close = page.get_by_role('button', name='Close settings', exact=True)
   bounds = await close.bounding_box()
   assert bounds and bounds['x'] >= 0 and bounds['y'] >= 0 and bounds['x'] + bounds['width'] <= 1280 and bounds['y'] + bounds['height'] <= 720, (percent, bounds)
   await close.click(timeout=5000)
   await page.evaluate('testStore.getState().setShowSettings(true)')
  await scale_control.get_by_role('button',name=f'{round(float(initial_scale)*100)}%',exact=True).click()
  await page.set_viewport_size({'width':1536,'height':1080})
  await page.evaluate("""async () => {
    const {useTerminalStore:s}=await import('/src/stores/terminalStore.ts');
    s.setState({windows:[{windowId:'scale-fixture',workflowId:'style-fixture',sessionId:'fixture-session'}]});
  }""")
  await page.locator('.xterm').wait_for()
  terminal_width = await page.locator('.xterm').evaluate('e => e.getBoundingClientRect().width')
  if initial_scale == '1.5': await page.screenshot(path=str(ART/'scale-settings-15.png'))
  scale = page.get_by_role('group', name='Interface text size')
  assert await page.locator('html').evaluate("e => e.style.zoom") == initial_scale
  await scale.get_by_role('button',name='130%',exact=True).click()
  await page.wait_for_function("() => document.documentElement.style.zoom === '1.3' && localStorage.getItem('arco_ui_scale') === '1.3'")
  assert await scale.get_by_role('button',name='130%',exact=True).get_attribute('aria-pressed') == 'true'
  await page.evaluate("async () => (await import('/src/themes/bootstrap.ts')).bootstrapCachedTheme()")
  assert await page.locator('html').evaluate("e => e.style.zoom") == '1.3'
  assert await page.locator('canvas').count()>=1
  scaled_width = await page.locator('.xterm').evaluate('e => e.getBoundingClientRect().width')
  assert (scaled_width > terminal_width) if float(initial_scale) < 1.3 else (scaled_width < terminal_width)
  await page.evaluate("async () => (await import('/src/stores/terminalStore.ts')).useTerminalStore.getState().closeWindow('scale-fixture')")
  await scale.get_by_role('button',name='Reset to default',exact=True).click()
  await page.wait_for_function("() => document.documentElement.style.zoom === '1.1'")

  assert await page.get_by_text('THIS VIEW HIT A RENDER ERROR',exact=True).count()==0, await page.locator('body').inner_text()
  font = page.get_by_label('Font pack override')
  await font.select_option('victor-mono-uniform')
  await page.wait_for_function("() => testStore.getState().settings.fontPackOverride === 'victor-mono-uniform'")
  async with page.expect_response(lambda response: '/api/settings' in response.url and response.request.method == 'POST'):
   await font.select_option('')
  await page.wait_for_function("() => testStore.getState().settings.fontPackOverride === null")
  assert await font.input_value() == ''
  await page.wait_for_function("() => localStorage.getItem('arco_font_pack_override') === ''")
  assert settings['fontPackOverride'] is None
  assert await page.evaluate("async () => (await import('/src/themes/bootstrap.ts')).readCachedFontPackOverride()") is None
  theme_font = await page.evaluate("document.documentElement.style.getPropertyValue('--font-body')")
  await page.evaluate("async () => (await import('/src/themes/bootstrap.ts')).bootstrapCachedTheme()")
  assert await page.evaluate("document.documentElement.style.getPropertyValue('--font-body')") == theme_font
  await page.get_by_role('button',name='THEME · ARCO PHOSPHOR',exact=False).click()
  assert await page.get_by_label('Theme family').input_value()=='phosphor'
  await page.get_by_label('Palette category').select_option('Terminal')
  assert await page.locator('[data-theme-choice]').count()==16
  await page.get_by_label('Palette category').select_option('All')
  await page.get_by_label('Search themes').fill('red-planet')
  assert await page.locator('[data-theme-choice]').count()==1
  await page.get_by_label('Search themes').fill('')
  await page.get_by_label('Glow softness').focus();await page.keyboard.press('ArrowLeft')
  await page.wait_for_timeout(100)
  assert settings['phosphorSoftness']==45
  await page.get_by_label('PHOSPHOR EFFECTS',exact=True).uncheck()
  assert await page.locator('.phosphor-ambient').count()==0
  assert await page.get_by_label('Glow softness').is_disabled()
  await page.get_by_label('PHOSPHOR EFFECTS',exact=True).check()
  await page.screenshot(path=str(ART/'real-settings.png'))
  await page.get_by_role('button',name='THEME · ARCO PHOSPHOR',exact=False).click()
  assert await page.get_by_label('Font pack override').is_visible()
  for width,height in [(768,540),(390,700)]:
   await page.set_viewport_size({'width':width,'height':height})
   bounds=await page.get_by_role('dialog',name='Settings',exact=True).bounding_box()
   assert bounds['x']>=0 and bounds['y']>=0 and bounds['x']+bounds['width']<=width+1 and bounds['y']+bounds['height']<=height+1
   await page.get_by_label('Glow softness').focus();await page.keyboard.press('Tab')
   await page.screenshot(path=str(ART/f'settings-{width}.png'))
  await page.set_viewport_size({'width':1536,'height':1080})
  # Keyboard brightness controls keep their independent native settings path.
  before_ink=await page.locator('html').evaluate("e=>e.style.getPropertyValue('--color-fg')")
  bg=page.locator('[data-help="settings.theme-brightness"] input').nth(1)
  await bg.focus();await page.keyboard.press('ArrowRight')
  await page.wait_for_timeout(100)
  assert settings['bgBrightness']==1
  assert await page.locator('html').evaluate("e=>e.style.getPropertyValue('--color-fg')")==before_ink
  await page.keyboard.press('ArrowLeft')
  await page.get_by_role('button',name='Close settings',exact=True).click()
  await page.emulate_media(reduced_motion='reduce');await page.wait_for_timeout(200)
  frames=await page.evaluate('arcoPhosphorStats.frames');await page.wait_for_timeout(200)
  assert await page.evaluate('arcoPhosphorStats.frames')==frames
  assert await page.locator('.arco-markdown').first.evaluate('e=>getComputedStyle(e).textShadow') != 'none'
  await page.evaluate('testStore.getState().setCrispText(true)')
  assert await page.locator('.arco-wordmark').evaluate('e=>getComputedStyle(e).textShadow')=='none'
  await page.evaluate('testStore.getState().setCrispText(false)')
  await page.evaluate("testStore.getState().setThemeId('arch')")
  assert await page.locator('.phosphor-raster').count()==0
  assert await page.locator('html').evaluate("e=>e.style.getPropertyValue('--arco-accent')")==''
  assert await page.locator('html').evaluate("e=>e.style.getPropertyValue('--phosphor-text')")==''
  await page.evaluate("testStore.getState().setThemeId('phosphor:arco:arco-crt')")
  await page.emulate_media(reduced_motion='no-preference')
  await page.evaluate("testStore.getState().setThemeId('matrix')")
  await page.wait_for_timeout(650)
  assert await page.locator('canvas').count()==1
  assert await page.locator('.phosphor-raster').count()==0
  await page.evaluate("testStore.getState().setThemeId('phosphor:arco:arco-crt')")
  await page.wait_for_timeout(200)
  assert await page.locator('canvas').count()==1
  await page.reload();await page.wait_for_timeout(600)
  assert await page.locator('html').get_attribute('data-theme-family')=='phosphor'
  assert await page.locator('html').get_attribute('data-phosphor-softness')=='45'
  if initial_scale == '1.5':
   await page.evaluate("""async () => {
    (await import('/src/themes/bootstrap.ts')).applyUiScale(1.5);
    await import('/src/vendor/odysseus-editor/editor.css');
    const el=document.createElement('div'); el.id='gallery-editor-container';
    Object.assign(el.style,{position:'fixed',inset:'0',zIndex:'100'}); document.body.appendChild(el);
    const editor=await import('/src/vendor/odysseus-editor/galleryEditor.js'); window.scaleEditor=editor;
    editor.openEditor('',null,{w:128,h:128});
   }""")
   await page.locator('#gallery-editor-container canvas').first.wait_for()
   await page.locator('#ge-history-btn').click()
   head=page.locator('[data-history-drag]'); await head.wait_for()
   before=await head.bounding_box()
   await page.mouse.move(before['x']+before['width']/2,before['y']+10)
   await page.mouse.down(); await page.mouse.move(before['x']+before['width']/2+60,before['y']+10,steps=5); await page.mouse.up()
   after=await head.bounding_box()
   assert abs(after['x']-before['x']-60)<3
   await page.evaluate("scaleEditor.closeEditor(); document.getElementById('gallery-editor-container').remove()")
  assert not errors,errors
  result={'errors':errors,'settingsWrites':writes,'interceptedWsMessages':len(messages),'checks':['Real App/SettingsPanel, no demo layout','Six palettes preserve workflow data, transcript DOM and action labels','Family/category/search picker','Softness save, effects override, reduced motion, crisp wordmark','Classic cleanup','Cached startup restores family and softness']}
  (ART/'results.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
  await browser.close()
asyncio.run(main())
