"""Cluster join warnings: real dialog and chat components, synthetic browser state only."""
import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path
from host_isolation import chrome_executable

PORT = os.environ.get('ARCO_CLIENT_PORT', '5267')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/styles/matrix.css"></head><body><div id="fixture"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''

CWD = '/projects/fixture'
MEMBERS = ['member-%d' % i for i in range(1, 8)]


def config(name):
    return {'name': name, 'workingDirectory': CWD, 'primaryProvider': 'claude', 'primaryModel': 'claude-sonnet-4-6', 'primaryEffort': 'high', 'skipPermissions': True}


def state(cluster_id, name, ids):
    return {'clusterId': cluster_id, 'name': name, 'cwd': CWD, 'createdAt': '2026-11-07T00:00:00Z', 'mailboxDepth': {},
            'members': [{'workflowId': w, 'displayName': w, 'status': 'idle'} for w in ids]}


def created(w):
    return {'type': 'workflow_created', 'workflowId': w, 'config': config(w), 'clusterMemberPending': True}


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page(viewport={'width': 1500, 'height': 900})
        blocked, errors = [], []

        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'https' and url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(status=200, content_type='text/css', body=''); return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and route.request.method == 'GET':
                if url.path.startswith('/api/'):
                    await route.fulfill(json={}); return
                if url.path == '/fixture':
                    await route.fulfill(status=200, content_type='text/html', body=HTML); return
                is_local_fs = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if is_local_fs or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/', '/themes/', '/backgrounds/')):
                    await route.continue_(); return
            blocked.append(url.path)
            await route.abort()
        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true', timeout=10000)
        await page.evaluate("""async () => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {flushSync}=(await import('/node_modules/.vite/deps/react-dom.js')).default;
          const {TabContextMenu}=await import('/src/components/TabContextMenu.tsx');
          const {ChatPanel}=await import('/src/components/ChatPanel.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts');
          const {applyTheme}=await import('/src/themes/apply.ts');
          const {getTheme,THEME_REGISTRY}=await import('/src/themes/registry.ts');
          const {setLayoutMode}=await import('/src/layout/layoutRange.ts');
          window.setLayout=setLayoutMode;window.s=s;window.theme=id=>applyTheme(getTheme(id));
          window.themeIds=Object.keys(THEME_REGISTRY);window.root=createRoot(document.getElementById('fixture'));
          for(const id of ['anchor','other'])s.getState().createJob(id,{name:id,workingDirectory:'/projects/fixture',primaryProvider:'codex',primaryModel:'gpt-5.5',primaryEffort:'low'});
          window.render=(kind='dialog')=>{
            const App=()=>{const jobs=s(x=>x.jobs);return kind==='dialog'?React.createElement(TabContextMenu,{anchorJobId:'anchor',onClose:()=>{},onCreateCluster:()=>window.created=true,onAddClusterMember:()=>window.created=true,onCreateClusterWithFreshWorkers:()=>window.created=true}):React.createElement('div',{style:{height:'75vh',display:'flex',flexDirection:'column'}},React.createElement(ChatPanel,{job:jobs.anchor}));};
            flushSync(()=>window.root.render(React.createElement(App)));
          };
          window.setBusy=(id,busy)=>s.setState(st=>({jobs:{...st.jobs,[id]:{...st.jobs[id],busy}}}));
          window.render();window.setBusy('anchor',true);
        }""")
        notice='This tab is working. It gets its cluster tools when the current turn ends.'
        try:
            await expect(page.get_by_text(notice,exact=True)).to_be_visible()
        except Exception:
            print('Fixture errors:',errors,'state:',await page.evaluate('({href:location.href,jobs:Object.keys(window.s?.getState()?.jobs??{}),html:document.body.innerHTML.slice(-1500)})'))
            raise

        cases=0
        for mode in ['auto','standard','compact','narrow']:
            for scale in [1,1.1]:
                for width,height in [(1500,900),(1050,650),(390,500)]:
                    for theme in ['matrix','phosphor:arco:electric']:
                        await page.set_viewport_size({'width':width,'height':height})
                        await page.evaluate('([mode,scale,theme])=>{window.setLayout(mode);window.theme(theme);document.documentElement.style.zoom=String(scale);document.documentElement.style.setProperty("--ui-scale",String(scale))}',[mode,scale,theme])
                        await expect(page.get_by_text(notice,exact=True)).to_be_visible()
                        button=page.get_by_role('button',name='CREATE CLUSTER (2)',exact=True)
                        await page.locator('input[type=checkbox]').first.check()
                        await expect(button).to_be_enabled()
                        await button.focus()
                        box=await button.bounding_box();assert box and box['y']>=0 and box['y']+box['height']<=height,(mode,scale,width,box)
                        assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(mode,scale,width,'horizontal overflow')
                        cases+=1
        themes=await page.evaluate('window.themeIds')
        for theme in themes:
            await page.evaluate('theme=>window.theme(theme)',theme)
            await expect(page.get_by_text(notice,exact=True)).to_be_visible()
        await page.emulate_media(forced_colors='active')
        await expect(page.get_by_text(notice,exact=True)).to_be_visible()
        await page.emulate_media(forced_colors='none')
        await page.evaluate("document.documentElement.style.zoom='1';document.documentElement.style.setProperty('--ui-scale','1');window.created=false")
        await page.get_by_role('button',name='CREATE CLUSTER (2)',exact=True).focus()
        await page.keyboard.press('Enter');assert await page.evaluate('window.created')
        await page.evaluate("window.setBusy('anchor',false);window.setBusy('other',true)")
        await expect(page.get_by_text(notice,exact=True)).to_be_visible()
        await page.locator('input[type=checkbox]').first.uncheck()
        await expect(page.get_by_text(notice,exact=True)).to_have_count(0)
        await page.evaluate("window.setBusy('anchor',true)")
        await page.get_by_role('button',name='CREATE WITH FRESH',exact=True).click()
        await expect(page.get_by_text(notice,exact=True)).to_be_visible()
        await page.evaluate("window.s.setState({clusters:{fixture:{clusterId:'fixture',cwd:'/projects/fixture',createdAt:'',members:[]}}})")
        await page.get_by_role('button',name='ADD TO EXISTING',exact=True).click()
        await expect(page.get_by_text(notice,exact=True)).to_be_visible()
        # Many selected working tabs cannot push the footer out of view at 110%.
        await page.get_by_role('button',name='CREATE WITH EXISTING',exact=True).click()
        await page.evaluate("""()=>{for(let n=0;n<20;n++){const id='busy-'+n;window.s.getState().createJob(id,{name:'Working tab '+n,workingDirectory:'/projects/fixture',primaryProvider:'codex',primaryModel:'gpt-5.5'});window.setBusy(id,true)}document.documentElement.style.zoom='1.1';document.documentElement.style.setProperty('--ui-scale','1.1')}""")
        for checkbox in await page.locator('input[type=checkbox]').all():
            await checkbox.check()
        submit=page.get_by_role('button',name='CREATE CLUSTER (22)',exact=True)
        await submit.focus();box=await submit.bounding_box()
        assert box and box['y']>=0 and box['y']+box['height']<=500,box
        for provider,phrase in [('cursor','An open Cursor tab cannot join a cluster.'),('lmstudio','LM Studio tabs cannot join clusters.')]:
            await page.evaluate("provider=>window.s.setState(st=>({jobs:{...st.jobs,anchor:{...st.jobs.anchor,config:{...st.jobs.anchor.config,primaryProvider:provider}}}}))",provider)
            await expect(page.get_by_text(phrase,exact=False)).to_be_visible()
            await expect(page.get_by_text(notice,exact=True)).to_have_count(0)
        await page.evaluate("""notice=>{window.s.setState(st=>({jobs:{...st.jobs,anchor:{...st.jobs.anchor,config:{...st.jobs.anchor.config,primaryProvider:'codex'}}}}));window.s.getState().addMessage('anchor',{id:'notice',role:'system',content:notice,isStreaming:false,timestamp:Date.now()});window.render('chat')}""",notice)
        await expect(page.get_by_text(notice,exact=True)).to_be_visible()
        assert await page.get_by_role('status').inner_text() == '', 'existing transcript is not announced on mount'
        await page.evaluate("notice=>window.s.getState().addMessage('anchor',{id:'new-notice',role:'system',content:notice,isStreaming:false,timestamp:Date.now()})",notice)
        await expect(page.get_by_role('status')).to_have_text(notice)
        assert not errors,errors
        assert not blocked,blocked
        print(f'PASS: {cases} dialog layout/scale/viewport/theme cases; {len(themes)} palettes; forced colors and long 110% selection; busy selections, fresh/add, keyboard, refusals and real ChatPanel notice')
        await browser.close()

asyncio.run(main())
