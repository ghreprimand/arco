"""Release-dialog focus, dismissal and bounds across layouts and themes.

All APIs and sockets are synthetic. Failure capture is diagnostic only: the
original exception is re-raised and the runner never retries this suite.
"""
import asyncio
import json
import os
import time
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults
from host_isolation import chrome_executable

install_navigation_defaults()
URL = f"http://127.0.0.1:{os.environ.get('ARCO_CLIENT_PORT', '5264')}/"
PROVIDERS = ['claude', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek']
CAPABILITIES = {'efforts': ['low', 'medium', 'high'], 'models': [], 'cliVersion': 'fixture',
                'strataVersion': '0.1.0', 'xolotlRevision': '1' * 40,
                'latestVersions': {'strata': '0.2.0', 'xolotl': '2' * 40}}


def progress(message):
    print(f'{time.monotonic():.1f} {message}', flush=True)


async def capture(page, case):
    try:
        data = await page.evaluate("""() => {
          const x=s.getState(), dialog=document.querySelector('[role="dialog"][aria-label="Provider versions"]');
          return {dialogOpen:!!dialog && dialog.getBoundingClientRect().width>0,
            visibleRows:dialog ? [...dialog.querySelectorAll('button')].filter(e=>e.getBoundingClientRect().width>0).map(e=>e.innerText):[],
            connected:x.connected,connectionState:x.connectionState,enabledProviders:x.settings?.enabledProviders,
            localRuntimeStatus:x.localRuntimeStatus,ollamaLive:x.ollamaLive,capabilities:x.capabilities,
            ...window.__releaseDiagnostics};
        }""")
        progress('FAILURE CAPTURE '+json.dumps({'case': case, 'state': data}))
    except Exception as error:
        progress('FAILURE CAPTURE unavailable: '+str(error))


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        context = await browser.new_context(viewport={'width':1366,'height':768}, has_touch=True)
        await context.add_init_script("""localStorage.setItem('arco_ui_scale','1');
          window.__releaseDiagnostics={transitions:[],sockets:[]};
          const record=entry=>{const log=window.__releaseDiagnostics.sockets;log.push({at:performance.now(),...entry});if(log.length>200)log.shift();};
          const RealWebSocket=window.WebSocket;
          window.WebSocket=class extends RealWebSocket {constructor(...args){
            super(...args);const path=new URL(this.url).pathname;record({path,event:'created',state:this.readyState});
            for(const event of ['open','close','error'])this.addEventListener(event,()=>record({path,event,state:this.readyState}));
          }};
        """)
        errors, writes, requests = [], [], []

        async def api(route):
            path=urlparse(route.request.url).path
            if route.request.method != 'GET' and path != '/api/session': writes.append(path)
            if path == '/api/settings':
                data={'themeId':'matrix','enabledProviders':{name:True for name in PROVIDERS},'uiScale':1,'onboardingComplete':True,'projectRoots':[],'projects':[]}
            elif path == '/api/auth-status':
                data={name:{'loggedIn':name in ['claude','codex','ollama'],'installed':True,'cliInstalled':True,'installedModels':['local-small'] if name == 'ollama' else []} for name in PROVIDERS}
            elif path == '/api/capabilities': data=CAPABILITIES
            elif path == '/api/local-runtime-status':
                data={'fetchedAt':1,'rows':[{'provider':'ollama','state':'idle','models':[]}],
                      'ollama':{'up':True,'version':'0.1.0','loadedModels':[],'fetchedAt':1}}
                requests.append({'at':time.monotonic(),'response':data})
            elif path.endswith('/catalog'): data={'models':[]}
            elif path == '/api/session': data={}
            else:
                await route.fulfill(status=404,json={'error':'not available in the focus fixture'})
                return
            await route.fulfill(json=data)

        await context.route('**/api/**',api)
        await context.route('**/healthz',lambda r:r.fulfill(json={'status':'live'}))
        await context.route('https://**/*',lambda r:r.abort())
        await context.route_web_socket('**/*',lambda ws:ws.on_message(lambda msg:None))
        page=await context.new_page()
        page.on('pageerror',lambda error:errors.append(str(error)+' :: '+(error.stack or '')[:1600]))
        await page.goto(URL)
        await page.wait_for_timeout(800)
        await page.evaluate("""async () => {
          const {useAppStore:s}=await import('/src/stores/appStore.ts');window.s=s;
          const sample=x=>({connected:x.connected,connectionState:x.connectionState,
            enabledProviders:x.settings?.enabledProviders,localRuntimeStatus:x.localRuntimeStatus,ollamaLive:x.ollamaLive});
          let previous='';const record=x=>{const value=sample(x),key=JSON.stringify(value);if(key===previous)return;previous=key;
            const log=window.__releaseDiagnostics.transitions;log.push({at:performance.now(),...value});if(log.length>200)log.shift();};
          s.subscribe(record);record(s.getState());s.setState({connected:true,connectionState:'connected'});
          s.getState().showHomeView();
        }""")
        await page.wait_for_function('() => s.getState().authStatus && s.getState().settings')
        await page.evaluate('c => s.setState({capabilities:c,ollamaLive:{version:"0.1.0"}})',CAPABILITIES)
        try:
            await matrix(page)
            assert not errors, errors
            assert not writes, writes
        except Exception:
            progress('FIXTURE REQUESTS '+json.dumps(requests))
            raise
        finally:
            await browser.close()


async def matrix(page):
    theme_ids = await page.evaluate("async()=>Object.keys((await import('/src/themes/registry.ts')).THEME_REGISTRY)")
    cases = [(mode, scale, focus, theme_ids[0], width, provider)
             for mode in ['auto', 'standard', 'compact', 'narrow']
             for scale in [1, 1.1] for focus in [False, True]
             for width in [900, 1600] for provider in ['XOLOTL', 'STRATA', 'OLLAMA']]
    base_case_count = len(cases)
    cases += [('narrow', 1.1, False, name, 900, ['XOLOTL', 'STRATA', 'OLLAMA'][n % 3]) for n, name in enumerate(theme_ids[1:])]
    for n, (mode, scale, focus, name, width, provider) in enumerate(cases):
        case={'index':n+1,'mode':mode,'scale':scale,'focus':focus,'theme':name,'width':width,'runtime':provider}
        try:
            await page.set_viewport_size({'width': width, 'height': 1000})
            await page.evaluate("""async c => {
                (await import('/src/layout/layoutRange.ts')).setLayoutMode(c.mode);
                s.setState({focusMode:c.focus});
                (await import('/src/themes/apply.ts')).applyTheme((await import('/src/themes/registry.ts')).THEME_REGISTRY[c.theme]);
                document.documentElement.style.zoom=String(c.scale);
                document.documentElement.style.setProperty('--ui-scale',String(c.scale));dispatchEvent(new Event('resize'));
            }""", {'mode': mode, 'scale': scale, 'focus': focus, 'theme': name})
            versions = page.get_by_role('button', name='Provider versions', exact=True)
            panel = page.get_by_role('dialog', name='Provider versions', exact=True)
            chip = panel.get_by_role('button').filter(has_text=provider).first
            modal = page.get_by_role('dialog', name=provider + (' changes' if provider == 'XOLOTL' else ' releases'), exact=True)
            if n < base_case_count:
                progress(f'release-close {n + 1}/{base_case_count} mode={mode} scale={scale} focus={focus} theme={name} width={width} runtime={provider} input=touch')
                if not await panel.is_visible(): await versions.tap()
                await chip.focus()
                await chip.tap()
                await expect(modal).to_be_focused()
                await modal.get_by_role('button', name='CLOSE', exact=True).tap()
                await expect(modal).to_have_count(0)
                await expect(chip).to_be_focused()
            for touch in [False, True]:
                progress(f'release-matrix {n + 1}/{len(cases)} mode={mode} scale={scale} focus={focus} theme={name} width={width} runtime={provider} input={"touch" if touch else "keyboard"}')
                if not await panel.is_visible():
                    await versions.focus()
                    await page.keyboard.press('Enter')
                await chip.focus()
                if touch: await chip.tap()
                else: await page.keyboard.press('Enter')
                modal = page.get_by_role('dialog', name=provider + (' changes' if provider == 'XOLOTL' else ' releases'), exact=True)
                await expect(modal).to_be_focused()
                bounds = await modal.bounding_box()
                assert bounds and bounds['x'] >= -1 and bounds['y'] >= -1 and bounds['x'] + bounds['width'] <= width + 1, (n, bounds)
                await page.keyboard.press('Escape')
                await expect(modal).to_have_count(0)
                if await panel.is_visible(): await expect(chip).to_be_focused()
                else: await expect(versions).to_be_focused()
            await page.keyboard.press('Escape')
            await expect(panel).to_have_count(0)
        except Exception:
            await capture(page,case)
            raise
    print(f'PASS release focus matrix: {len(cases)} cases, keyboard/touch Escape; {base_case_count} base cases touch CLOSE and prior-chip focus return', flush=True)


if __name__ == '__main__':
    asyncio.run(main())
