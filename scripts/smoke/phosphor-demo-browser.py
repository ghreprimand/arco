"""Browser acceptance against the isolated client preview only; no production access.
Run: python3 scripts/smoke/phosphor-demo-browser.py
Artifacts: /tmp/archon-phosphor-review (override PHOSPHOR_ARTIFACT_DIR).
"""
import asyncio, json, os
from pathlib import Path
from playwright.async_api import async_playwright

BASE = 'http://127.0.0.1:5178/phosphor-demo.html'
ART = Path(os.environ.get('PHOSPHOR_ARTIFACT_DIR', '/tmp/archon-phosphor-review'))
ART.mkdir(parents=True, exist_ok=True)
CHROME = os.environ.get('CHROMIUM_PATH', os.path.expanduser('~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'))

async def main():
 async with async_playwright() as p:
  browser = await p.chromium.launch(executable_path=CHROME, args=['--enable-unsafe-swiftshader'])
  context = await browser.new_context(viewport={'width':1536,'height':1080})
  page = await context.new_page()
  errors, operations = [], []
  page.on('pageerror', lambda e: errors.append(str(e)))
  page.on('request', lambda r: operations.append(r.url) if '/api/' in r.url or '/ws' in r.url or '/terminal?' in r.url else None)
  await page.goto(BASE)
  await page.get_by_role('button', name='▶ PLAY STREAM').wait_for()
  await page.wait_for_timeout(900)
  checks = []
  assert await page.locator('html').get_attribute('data-family') == 'phosphor'
  assert await page.get_by_label('Palette', exact=True).input_value() == 'phosphor:arco:arco-crt'
  assert await page.get_by_label('Density', exact=True).input_value() == 'compact'
  assert await page.locator('canvas').count() == 1
  assert await page.locator('.phosphor-raster').evaluate("e=>getComputedStyle(e).pointerEvents") == 'none'
  assert await page.locator('.phosphor-raster').evaluate("e=>getComputedStyle(e).animationName") == 'none'
  assert await page.locator('.north-star').evaluate("e=>getComputedStyle(e).textShadow") != 'none'
  checks.append('Initial reference palette, compact density, visible static emission, single noninteractive ambient canvas')

  softness = page.get_by_label('Glow softness', exact=True)
  assert await softness.input_value() == '50'
  ink = await page.locator('.north-star').evaluate('e=>getComputedStyle(e).color')
  default_shadow = await page.locator('.north-star').evaluate('e=>getComputedStyle(e).textShadow')
  await page.screenshot(path=str(ART/'softness-50.png'))
  await softness.focus(); await page.keyboard.press('End')
  assert await softness.input_value() == '100'
  assert await page.locator('.north-star').evaluate('e=>getComputedStyle(e).textShadow') != default_shadow
  assert await page.locator('.north-star').evaluate('e=>getComputedStyle(e).color') == ink
  await page.screenshot(path=str(ART/'softness-100.png'))
  await page.keyboard.press('Home')
  assert await page.locator('.north-star').evaluate('e=>getComputedStyle(e).textShadow') == 'none'
  assert await page.locator('.phosphor-raster').count() == 1
  for _ in range(10): await page.keyboard.press('ArrowRight')
  await page.get_by_label('Crisp text', exact=True).check()
  assert await softness.is_disabled()
  assert await page.locator('.north-star').evaluate('e=>getComputedStyle(e).textShadow') == 'none'
  await page.get_by_label('Crisp text', exact=True).uncheck()
  assert await page.locator('.north-star').evaluate('e=>getComputedStyle(e).textShadow') == default_shadow
  await page.get_by_role('button', name='FONTS / BRIGHTNESS').click()
  assert await page.get_by_label('Font override', exact=True).is_visible()
  bg = page.get_by_label('Background brightness', exact=True)
  root_bg = await page.locator('html').evaluate("e=>getComputedStyle(e).getPropertyValue('--color-bg')")
  before_frames = await page.evaluate('archonPhosphorStats.frames')
  await bg.focus(); await page.keyboard.press('End')
  await page.wait_for_timeout(150)
  assert await bg.input_value() == '30'
  assert await page.locator('html').evaluate("e=>getComputedStyle(e).getPropertyValue('--color-bg')") != root_bg
  assert await page.locator('.north-star').evaluate('e=>getComputedStyle(e).color') == ink
  assert await page.evaluate('archonPhosphorStats.frames') > before_frames
  await page.get_by_role('button', name='Close dialog').click()
  await page.screenshot(path=str(ART/'background-plus-30.png'))
  await page.get_by_role('button', name='FONTS / BRIGHTNESS').click()
  await bg.focus(); await page.keyboard.press('Home')
  for _ in range(30): await page.keyboard.press('ArrowRight')
  assert await bg.input_value() == '0'
  assert await page.locator('html').evaluate("e=>getComputedStyle(e).getPropertyValue('--color-bg')") == root_bg
  await page.get_by_role('button', name='Close dialog').click()
  checks.append('Softness 0/50/100 affects shadows only; crisp overrides it; independent background brightness redraws ambient base; fonts discoverable')

  # Programmatic palette swaps deliberately keep DOM selection (native picker click
  # can itself change selection as normal browser behavior).
  await page.evaluate("""() => {
    const node=document.querySelector('.north-star').lastChild;
    const range=document.createRange();range.selectNodeContents(node);
    getSelection().removeAllRanges();getSelection().addRange(range);
    window.fixtureSelection=getSelection().toString();
  }""")
  before = await page.get_by_label('Message composer').input_value()
  for palette in ['arco-crt','default','everforest','amber','phosphor','red-planet']:
   await page.get_by_label('Palette', exact=True).select_option('phosphor:arco:'+palette)
   await page.wait_for_timeout(150)
   assert await page.get_by_label('Message composer').input_value() == before
   assert await page.evaluate('getSelection().toString()===window.fixtureSelection')
   assert await page.locator('canvas').count() == 1
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
   await page.screenshot(path=str(ART/(palette+'.png')))
  checks.append('Six representative actual catalog IDs: same draft, DOM selection, panels and viewport')

  await page.get_by_label('Palette', exact=True).select_option('phosphor:arco:arco-crt')
  await page.evaluate('getSelection().removeAllRanges()')
  await page.get_by_role('button', name='FILES', exact=True).click()
  await page.get_by_role('button', name='SPLIT', exact=True).click()
  await page.get_by_label('Palette', exact=True).select_option('phosphor:arco:amber')
  assert await page.locator('.archon-diff-viewtoggle .active').inner_text() == 'SPLIT'
  await page.screenshot(path=str(ART/'split-diff.png'))
  separator=page.get_by_role('separator')
  await separator.focus();await page.keyboard.press('ArrowLeft')
  assert await separator.get_attribute('aria-valuenow')=='60'
  await page.get_by_label('Palette', exact=True).select_option('phosphor:arco:arco-crt')
  assert await separator.get_attribute('aria-valuenow')=='60'
  checks.append('Native DiffView unified/split state and keyboard panel resize survive palette changes')

  await page.get_by_role('button',name='▶ PLAY STREAM').click()
  await page.wait_for_timeout(550)
  assert await page.get_by_role('button',name='■ STOP STREAM').is_visible()
  await page.get_by_label('Message composer').fill('A synthetic follow-up')
  await page.get_by_label('Message composer').press('Alt+Enter')
  assert 'FOLLOW-UP · A synthetic follow-up' in await page.locator('.queue-strip').inner_text()
  await page.get_by_role('button',name='■ STOP STREAM').click()
  checks.append('Synthetic streaming with follow-up queue; stop control works')

  await page.get_by_role('button',name='APPROVE',exact=True).click()
  await page.get_by_role('button',name='Code and diffs',exact=True).click()
  await page.get_by_label('Fixture terminal command').fill('git status --short')
  await page.get_by_label('Fixture terminal command').press('Enter')
  assert 'no process was launched' in await page.locator('.terminal-body').inner_text()
  checks.append('Native approval and question controls resolve locally; terminal command is stubbed')

  # Find the real ChatPanel scroller; verify reading history is not reset by paint.
  await page.evaluate("""() => {
    const elements=[...document.querySelectorAll('.conversation-scroll *')];
    window.transcriptScroller=elements.find(e=>getComputedStyle(e).overflowY==='auto'&&e.scrollHeight>e.clientHeight);
    transcriptScroller.scrollTop=1500;
  }""")
  await page.wait_for_timeout(700)
  scroll=await page.evaluate('transcriptScroller.scrollTop')
  await page.get_by_label('Palette',exact=True).select_option('phosphor:arco:everforest')
  await page.wait_for_timeout(300)
  assert abs(await page.evaluate('transcriptScroller.scrollTop')-scroll)<2
  checks.append('Long virtualized conversation retains history scroll across palette change')

  await page.get_by_role('button',name='SETTINGS',exact=True).click()
  assert await page.get_by_role('dialog',name='DISPLAY SETTINGS').is_visible()
  await page.get_by_label('Search palettes').fill('red-planet')
  assert await page.locator('.palette-grid>button').count()==1
  await page.get_by_label('Search palettes').fill('')
  await page.get_by_label('Palette category').select_option('Terminal')
  assert await page.locator('.palette-grid>button').count()==16
  await page.screenshot(path=str(ART/'settings.png'))
  await page.keyboard.press('Escape')
  assert not await page.get_by_role('dialog').count()
  checks.append('Search/categories, native modal focus and Escape dismissal')

  await page.get_by_role('button',name='⌕ SEARCH',exact=True).click()
  await page.get_by_label('Search transcript',exact=True).fill('pass: 1,')
  assert await page.locator('.transcript-results details').count()==1
  await page.locator('.transcript-results summary').click()
  assert 'preserved: true' in await page.locator('.transcript-results pre').inner_text()
  await page.keyboard.press('Escape')
  await page.get_by_role('button',name='⌕ BROWSE 68',exact=True).focus()
  assert await page.get_by_role('tooltip').is_visible()
  checks.append('Full transcript search includes unmounted virtualized code; tooltip available by keyboard focus')

  await page.emulate_media(reduced_motion='reduce')
  await page.wait_for_timeout(100)
  a=await page.evaluate('archonPhosphorStats.frames')
  await page.wait_for_timeout(400)
  assert await page.evaluate('archonPhosphorStats.frames')==a
  assert await page.locator('.north-star').evaluate('e=>getComputedStyle(e).textShadow')!='none'
  assert await page.locator('.phosphor-raster').is_visible()
  await page.screenshot(path=str(ART/'reduced-motion.png'))
  await page.get_by_label('Crisp text',exact=True).check()
  assert await page.locator('.north-star').evaluate('e=>getComputedStyle(e).textShadow')=='none'
  assert await page.locator('.phosphor-raster').is_visible()
  await page.get_by_label('Crisp text',exact=True).uncheck()
  await page.get_by_role('button',name='EFFECTS ON',exact=True).click()
  assert await page.locator('canvas').count()==0
  assert await page.locator('.north-star').evaluate('e=>getComputedStyle(e).textShadow')=='none'
  assert await page.locator('.phosphor-raster').count()==0
  checks.append('Reduced motion retains static glow/raster; crisp disables glow; effects-off removes treatment/resources')

  await page.get_by_label('Theme family').select_option('classic')
  await page.emulate_media(reduced_motion='no-preference')
  await page.get_by_role('button',name='EFFECTS OFF',exact=True).click()
  for palette in ['arch','matrix','everforest','red-planet','braun']:
   await page.get_by_label('Palette',exact=True).select_option(palette)
   await page.wait_for_timeout(300)
   assert await page.locator('html').get_attribute('data-theme')==palette
   assert await page.locator('.phosphor-raster').count()==0
   assert await page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--arco-accent').trim()") == ''
   assert await page.locator('canvas').count()<=1
   await page.screenshot(path=str(ART/('classic-'+palette+'.png')))
  checks.append('Five Classic themes restore their IDs/styles with no Phosphor tokens or overlays')
  await page.get_by_label('Theme family').select_option('phosphor')
  await page.get_by_label('Palette',exact=True).select_option('phosphor:arco:arco-crt')
  await page.emulate_media(reduced_motion='no-preference')
  await page.get_by_role('button',name='PREVIEW',exact=True).click()
  await page.screenshot(path=str(ART/'preview-atlas.png'))
  await page.get_by_role('button',name='USAGE',exact=True).click()
  await page.screenshot(path=str(ART/'usage.png'))
  for width in [1024,768,390]:
   await page.set_viewport_size({'width':width,'height':1000})
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),width
   await page.get_by_role('button',name='SETTINGS',exact=True).click()
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),('dialog',width)
   await page.keyboard.press('Escape')
   await page.screenshot(path=str(ART/('width-'+str(width)+'.png')),full_page=True)
  await page.set_viewport_size({'width':1536,'height':1080})
  await page.evaluate("document.body.style.zoom='2'")
  assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  await page.get_by_role('button',name='SETTINGS',exact=True).click()
  assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  assert await page.get_by_role('dialog').evaluate('e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth}')
  assert await page.get_by_role('heading',name='DISPLAY SETTINGS').is_visible()
  await page.screenshot(path=str(ART/'zoom-200.png'))
  await page.keyboard.press('Escape');await page.evaluate("document.body.style.zoom=''")
  checks.append('1024/768/390 layouts, modal access and 200% CSS zoom without page overflow')

  # Real context loss and restoration; CSS is independent of GPU availability.
  await page.evaluate("window.loseExtension=document.querySelector('.phosphor-ambient').getContext('webgl').getExtension('WEBGL_lose_context');loseExtension.loseContext()")
  await page.wait_for_timeout(100)
  assert await page.evaluate('archonPhosphorStats.context')=='lost'
  assert await page.locator('.north-star').evaluate('e=>getComputedStyle(e).textShadow')!='none'
  await page.evaluate('loseExtension.restoreContext()');await page.wait_for_timeout(500)
  assert await page.evaluate('archonPhosphorStats.context')=='webgl'
  checks.append('WebGL context loss retains static style and restores one renderer')

  # A new document exercises the no-WebGL fallback before context creation.
  fallback=await context.new_page()
  await fallback.add_init_script("const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl'?null:get.call(this,type,...args)}")
  await fallback.goto(BASE);await fallback.get_by_role('button',name='▶ PLAY STREAM').wait_for()
  assert await fallback.evaluate('archonPhosphorStats.context')=='fallback'
  assert await fallback.locator('.north-star').evaluate('e=>getComputedStyle(e).textShadow')!='none'
  await fallback.close()
  checks.append('WebGL-unavailable fallback preserves CSS presentation')

  # Headless pages remain visibilityState=visible even behind another page.
  # Exercise the real listener with a controlled hidden state and report that scope.
  await page.mouse.move(600,450)
  await page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))")
  hidden_frames=await page.evaluate('archonPhosphorStats.frames')
  await page.wait_for_timeout(250)
  assert await page.evaluate('archonPhosphorStats.frames')==hidden_frames
  assert await page.evaluate('archonPhosphorStats.running') is False
  await page.evaluate("delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))")
  checks.append('Visibility listener stops scheduling and resumes (controlled hidden-state test)')

  # Cost readings are CPU submit time + browser task duration, NOT GPU/power claims.
  cdp=await context.new_cdp_session(page);await cdp.send('Performance.enable')
  async def metrics():
   data=await cdp.send('Performance.getMetrics')
   return {x['name']:x['value'] for x in data['metrics']}
  async def measure(name,active=False):
   start=await metrics();frames=await page.evaluate('archonPhosphorStats.frames')
   if active:
    for i in range(30):
     await page.mouse.move(200+i*20,400+(i%2)*60);await page.wait_for_timeout(60)
   else: await page.wait_for_timeout(2000)
   end=await metrics()
   return {'mode':name,'elapsedSeconds':end['Timestamp']-start['Timestamp'],'taskMs':(end['TaskDuration']-start['TaskDuration'])*1000,'draws':await page.evaluate('archonPhosphorStats.frames')-frames}
  await page.wait_for_timeout(5000)
  cost=[await measure('idle')]
  await page.get_by_role('button',name='▶ PLAY STREAM').evaluate('e=>e.click()')
  cost.append(await measure('streaming-without-pointer'))
  assert cost[-1]['draws']==0, 'Streamed tokens must not redraw the ambient canvas'
  await page.get_by_role('button',name='■ STOP STREAM').evaluate('e=>e.click()')
  cost.append(await measure('pointer',True))
  await page.get_by_role('button',name='EFFECTS ON',exact=True).click()
  cost.append(await measure('effects-off'))
  assert not operations, operations
  assert not errors,errors
  result={'checks':checks,'rendererCost':cost,'renderer':await page.evaluate('archonPhosphorStats'),'browserErrors':errors,'productionRequests':operations,'limitations':['SwiftShader headless Chromium; not workstation GPU or power measurement','200% CSS zoom, not browser chrome zoom','Specialized surfaces excluded as documented in docs/PHOSPHOR_DEMO.md']}
  (ART/'results.json').write_text(json.dumps(result,indent=2))
  print(json.dumps(result,indent=2))
  await browser.close()

asyncio.run(main())
