"""Render real worker controls with isolated APIs and every shipped theme."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect

PORT = os.environ.get('ARCO_CLIENT_PORT', '5205')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
ART = Path('/tmp/arco-selected-contrast')
ART.mkdir(exist_ok=True)
HTML = """<!doctype html><html><body><main style="position:relative;z-index:1;padding:18px;display:flex;gap:20px;align-items:start">
<div id="native" style="width:580px;padding:18px;background:var(--color-bg-panel)"></div>
<div id="codex" style="width:580px;padding:18px;background:var(--color-bg-panel)"></div></main>
<div id="effects"></div><script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;
window.__vite_plugin_react_preamble_installed__=true;window.fixtureReady=true;</script></body></html>"""

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None, args=['--enable-unsafe-swiftshader'])
        page = await browser.new_page(viewport={'width':1400,'height':1000})
        errors, blocked, writes = [], [], []
        trust_release = asyncio.Event()
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'https' and url.netloc == 'fonts.googleapis.com':
                await route.fulfill(content_type='text/css', body='')
                return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                if url.path == '/fixture':
                    await route.fulfill(content_type='text/html', body=HTML)
                    return
                if url.path.startswith('/api/'):
                    if route.request.method != 'GET':
                        writes.append({'path':url.path,'body':route.request.post_data_json})
                        assert url.path == '/api/project-trust', writes
                        await trust_release.wait()
                    data = {'models':[], 'entries':[], 'defaultProjectTrust':'ask', 'resources':[]}
                    if url.path == '/api/project-trust':
                        decision = (route.request.post_data_json or {}).get('decision','clear')
                        data['cwd'] = {'path':'/projects/fixture','status':'always' if decision=='always' else 'ask','resources':[]}
                    await route.fulfill(json=data)
                    return
                path = unquote(url.path)
                local = '/@fs/' + (ROOT/'node_modules/vite/dist/client/env.mjs').resolve().as_posix().lstrip('/')
                shared = '/@fs/' + (ROOT/'shared').resolve().as_posix().lstrip('/') + '/'
                if path == local or path.startswith((shared,'/@react-refresh','/@vite/','/@id/','/node_modules/.vite/deps/','/src/','/themes/','/backgrounds/','/phosphor-demo/')):
                    await route.continue_()
                    return
            blocked.append(route.request.url)
            await route.abort()
        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(ORIGIN+'/fixture')
        await page.wait_for_function('window.fixtureReady === true')
        await page.evaluate(r"""async () => {
          await import('/src/styles/global.css'); await import('/src/styles/matrix.css');
          await import('/src/themes/phosphor/phosphor.css');
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ConfigTab}=await import('/src/components/RightPanel/ConfigTab.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts');
          const {useDraftStore:d}=await import('/src/stores/draftStore.ts');
          const {THEME_REGISTRY}=await import('/src/themes/registry.ts');
          const {PROVIDER_THEMES}=await import('/src/themes/providerThemes.ts');
          const {applyTheme}=await import('/src/themes/apply.ts');
          const {applyPhosphorPreferences}=await import('/src/themes/phosphor/preferences.ts');
          const {default:Backdrop}=await import('/src/themes/phosphor/PhosphorBackdrop.tsx');
          window.s=s; window.updates=[]; window.themeCatalog=Object.values(THEME_REGISTRY).concat(Object.values(PROVIDER_THEMES));
          window.snapshot=()=>JSON.stringify({jobs:s.getState().jobs,settings:s.getState().settings,drafts:d.getState().drafts});
          s.setState({settings:{claude:{transport:'native'},themeId:'phosphor:arco:electric',fontPackOverride:'victor-mono-uniform',textBrightness:30,uiScale:1.1},jobs:{},activeJobId:null});
          const effects=createRoot(document.getElementById('effects'));
          const roots={};
          for (const [id,provider] of [['native','claude'],['codex','codex']]) {
            s.getState().createJob(id,{name:'Style fixture',workingDirectory:'/projects/fixture',primaryProvider:provider,primaryModel:provider==='claude'?'claude-opus-4-6':'gpt-5.5',primaryEffort:'high',skipPermissions:false,claudeTransport:'native',codexTransport:'appserver'});
            d.getState().setDraft(id,'Keep the existing composer draft.');
            roots[id]=createRoot(document.getElementById(id));
          }
          window.renderControls=()=>{for(const [id,root] of Object.entries(roots)) root.render(React.createElement(ConfigTab,{job:s.getState().jobs[id],onUpdatePrimary:patch=>{window.updates.push({id,patch});s.setState(st=>({jobs:{...st.jobs,[id]:{...st.jobs[id],config:{...st.jobs[id].config,...patch}}}}));window.renderControls();}}));};
          window.chooseTheme=(id,profile={})=>{
            const t=window.themeCatalog.find(t=>t.id===id);
            applyPhosphorPreferences({phosphorEffects:profile.effects??true,phosphorSoftness:profile.softness??50});
            applyTheme(t,'victor-mono-uniform',profile.frosted??null,profile.opacity??null,{bg:profile.bg??0,text:profile.text??30});
            effects.render(t.family==='phosphor' && profile.effects!==false ? React.createElement(Backdrop) : null);
            document.documentElement.style.zoom=String(profile.scale??1.1);
          };
          const rgb=c=>{const v=c.match(/[\d.]+/g).map(Number);return [v[0],v[1],v[2],v[3]??1];};
          const over=(a,b)=>[0,1,2].map(i=>a[i]*a[3]+b[i]*(1-a[3])).concat(1);
          const lum=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((v,x,i)=>v+x*[.2126,.7152,.0722][i],0);
          const ratio=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
          window.measure=()=>{
            const selected=[...document.querySelectorAll('#native button,#codex button')].filter(b=>b.style.background.includes('color-accent-primary-dim'));
            return selected.map(b=>({group:b.parentElement.previousElementSibling?.textContent.trim(),buttons:[...b.parentElement.querySelectorAll('button')].filter(e=>e.classList.contains('filled-control')).map(e=>{
              const st=getComputedStyle(e),chain=[];for(let a=e;a;a=a.parentElement)chain.push(a);
              const bg=chain.reverse().reduce((v,a)=>over(rgb(getComputedStyle(a).backgroundColor),v),[255,255,255,1]);
              const fg=over(rgb(st.color),bg);
              e.focus();const focus=getComputedStyle(e);const panelBg=chain.slice(0,-1).reduce((v,a)=>over(rgb(getComputedStyle(a).backgroundColor),v),[255,255,255,1]);
              const focusRatio=ratio(over(rgb(focus.outlineColor),panelBg),panelBg);
              const focused=e.matches(':focus-visible') && focus.outlineStyle!=='none' && parseFloat(focus.outlineWidth)>0;
              e.blur();
              return {label:e.textContent.trim(),selected:e===b,fg:st.color,bg:st.backgroundColor,composited:bg,contrast:ratio(fg,bg),shadow:st.textShadow,focused,focusRatio,outline:focused? 'visible':'none',disabled:e.disabled};
            })}));
          };
          window.renderControls();window.chooseTheme('phosphor:arco:electric');
        }""")
        await expect(page.get_by_text('THINKING VISIBILITY',exact=True)).to_be_visible()
        await expect(page.locator('#native [data-help="rightpanel.config.project-trust"]')).to_be_visible()
        await page.evaluate('document.fonts.ready')
        await page.keyboard.press('Tab')
        # The store's periodic memory trim materializes empty history arrays.
        # Normalize before the whole-state baseline and verify another trim is
        # stable, so the matrix still detects any substantive job mutation.
        await page.evaluate('window.__ARCO_TRIM_MEMORY__()')
        baseline = await page.evaluate('snapshot()')
        await page.evaluate('window.__ARCO_TRIM_MEMORY__()')
        assert await page.evaluate('snapshot()') == baseline
        save = page.locator('#native [data-help="rightpanel.config.north-star"]').get_by_role('button',name='Save',exact=True)
        arm = page.locator('#native [data-help="rightpanel.config.goal-run"]').get_by_role('button',name='Arm',exact=True)
        await expect(save).to_be_disabled()
        await expect(arm).to_be_disabled()
        results=[]
        for profile in [
            {'name':'shipped','text':30},
            {'name':'neutral','text':0,'effects':False},
            {'name':'dim-ink-light-surface','text':-30,'bg':30,'softness':100},
            {'name':'bright-ink-dark-surface','text':80,'bg':-30,'softness':0},
            {'name':'transparent-frost','text':15,'bg':15,'frosted':'on','opacity':.3,'softness':100,'scale':1.5},
            {'name':'opaque-frost','text':0,'bg':-15,'frosted':'on','opacity':.95,'effects':False,'scale':.9},
        ]:
            for theme in await page.evaluate('themeCatalog.map(t=>({id:t.id,family:t.family??"classic"}))'):
                await page.evaluate('({id,profile})=>chooseTheme(id,profile)',{'id':theme['id'],'profile':profile})
                result={**theme,'profile':profile['name'],'groups':await page.evaluate('measure()')}
                results.append(result)
                if profile['name']=='shipped' and theme['id'] in ('phosphor:arco:electric','matrix','braun','arco-default'):
                    await page.locator('#native [data-help="rightpanel.config.thinking-visibility"]').screenshot(path=str(ART/(theme['id'].replace(':','-')+'.png')))

        (ART/'computed-results.json').write_text(json.dumps(results,indent=2))
        electric=next(r for r in results if r['id']=='phosphor:arco:electric' and r['profile']=='shipped')
        print('Electric Blue reported controls:',json.dumps([{'group':g['group'],'selected':[b for b in g['buttons'] if b['selected']]} for g in electric['groups'][:4]]),flush=True)
        failed=[{'theme':r['id'],'profile':r['profile'],'group':g['group'],'label':b['label'],'contrast':b['contrast']} for r in results for g in r['groups'] for b in g['buttons'] if not b['disabled'] and b['contrast']<4.5]
        print('Theme cases:',len(results),'selected/unselected contrast failures:',len(failed),flush=True)
        assert not failed, failed[:12]
        focus_failed=[(r['id'],r['profile'],g['group'],b['label'],b['focusRatio']) for r in results for g in r['groups'] for b in g['buttons'] if not b['disabled'] and (not b['focused'] or b['focusRatio']<3)]
        print('Focus failures:',len(focus_failed),flush=True)
        assert not focus_failed,focus_failed[:12]
        assert all(b['shadow']=='none' for r in results for g in r['groups'] for b in g['buttons'] if b['selected'])
        assert await page.evaluate('snapshot()') == baseline
        await expect(save).to_be_disabled()
        await expect(arm).to_be_disabled()
        await page.evaluate("chooseTheme('phosphor:arco:electric')")
        # Use the real handlers and keyboard activation; each selection retains
        # its saved value on re-render and changes only its named config field.
        for heading, new_label, old_label, key, value in [
            ('THINKING VISIBILITY','summarized','omitted','claudeNativeThinkingDisplay','summarized'),
            ('TOOL-RESULT FILTER','aggressive','off','efficiencyToolFilter','aggressive'),
            ('WEB LOOKUPS / TURN','25','15','webSearchMaxUses',25),
            ('FACT-FORCE FIRST EDIT','on','off','efficiencyFactForce','on'),
        ]:
            group=page.locator('#native').get_by_text(heading,exact=True).locator('..')
            before=await page.evaluate('JSON.stringify(s.getState().jobs.native.config)')
            button=group.get_by_role('button',name=new_label,exact=True)
            await button.focus()
            await page.keyboard.press('Space')
            await expect(button).to_have_attribute('aria-pressed','true')
            latest=await page.evaluate('updates.at(-1)')
            assert latest=={'id':'native','patch':{key:value}},latest
            after=await page.evaluate('s.getState().jobs.native.config')
            assert after=={**json.loads(before),key:value}
            await group.get_by_role('button',name=old_label,exact=True).click()
        context=page.locator('#codex [data-help="rightpanel.config.codex-context"]')
        await context.get_by_role('button',name='STANDARD',exact=False).click()
        await expect(context.get_by_role('button',name='STANDARD',exact=False)).to_have_attribute('aria-pressed','true')
        assert await page.evaluate('updates.at(-1)')=={'id':'codex','patch':{'codexContextPolicy':'standard'}}
        await context.get_by_role('button',name='MAX',exact=False).click()
        # A held fixture write exercises existing disabled semantics, without
        # writing any host settings or enabling provider work.
        trust=page.locator('#native [data-help="rightpanel.config.project-trust"]')
        await trust.get_by_role('button',name='TRUSTED',exact=True).click()
        await expect(trust.locator('button:disabled')).to_have_count(3)
        trust_release.set()
        await expect(trust.get_by_role('button',name='TRUSTED',exact=True)).to_have_attribute('aria-pressed','true')
        await trust.get_by_role('button',name='ASK',exact=True).click()
        await expect(trust.get_by_role('button',name='ASK',exact=True)).to_have_attribute('aria-pressed','true')
        assert writes==[
            {'path':'/api/project-trust','body':{'cwd':'/projects/fixture','decision':'always'}},
            {'path':'/api/project-trust','body':{'cwd':'/projects/fixture','decision':'clear'}},
        ],writes
        original=await page.evaluate('JSON.stringify({settings:s.getState().settings,drafts:JSON.parse(snapshot()).drafts})')
        goal=page.locator('#native [data-help="rightpanel.config.north-star"] textarea')
        await goal.fill('Fixture objective')
        await expect(save).to_be_enabled()
        assert await save.evaluate("e=>getComputedStyle(e).textShadow")=='none'
        assert await page.evaluate("measure().flatMap(g=>g.buttons).find(b=>b.label==='Save'&&b.selected)?.contrast >= 4.5")
        await save.click()
        await expect(save).to_be_disabled()
        await expect(arm).to_be_enabled()
        assert await arm.evaluate("e=>getComputedStyle(e).textShadow")=='none'
        assert await page.evaluate("measure().flatMap(g=>g.buttons).find(b=>b.label==='Arm'&&b.selected)?.contrast >= 4.5")
        await goal.fill('')
        await save.click()
        await expect(arm).to_be_disabled()
        assert await page.evaluate('JSON.stringify({settings:s.getState().settings,drafts:JSON.parse(snapshot()).drafts})')==original
        # Rendered inspection includes the real Phosphor overlays and a
        # visible keyboard ring, rather than a token-only swatch.
        thinking=page.locator('#native [data-help="rightpanel.config.thinking-visibility"]')
        await thinking.get_by_role('button',name='summarized',exact=True).focus()
        await page.keyboard.press('ArrowRight')
        await thinking.screenshot(path=str(ART/'electric-focus.png'))
        assert not errors, errors
        assert not blocked, blocked
        print('PASS real Config selections, keyboard focus, disabled trust/save/arm, preserved appearance/drafts and no provider traffic',flush=True)
        await browser.close()

asyncio.run(main())
