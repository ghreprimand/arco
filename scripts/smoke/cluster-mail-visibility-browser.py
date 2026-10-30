"""Exercise cluster mail indicators with isolated snapshots and explicit sends."""
import asyncio
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect

PORT = os.environ.get('ARCO_CLIENT_PORT', '5203')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/styles/matrix.css"><link rel="stylesheet" href="/src/themes/phosphor/phosphor.css"></head><body><div id="fixture"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1500, 'height': 900})
        blocked, errors = [], []
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'https' and url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(status=200, content_type='text/css', body='')
                return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and route.request.method == 'GET':
                if url.path == '/api/project-trust':
                    await route.fulfill(json={'trusted':False})
                    return
                if url.path == '/fixture':
                    await route.fulfill(status=200, content_type='text/html', body=HTML)
                    return
                is_local_fs = url.path.startswith('/@fs/') and Path(unquote(url.path[4:])).resolve().is_relative_to(ROOT)
                if is_local_fs or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/', '/phosphor-demo/')):
                    await route.continue_()
                    return
            blocked.append(url.path)
            await route.abort()
        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true', timeout=10000)
        await page.evaluate('''async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ClusterTab} = await import('/src/components/ClusterTab.tsx');
          const {applyTheme} = await import('/src/themes/apply.ts');
          const {getTheme} = await import('/src/themes/registry.ts');
          window.setFixtureTheme = id => applyTheme(getTheme(id));
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          const {handleServerMessage:receive} = await import('/src/ws/handleServerMessage.ts');
          window.sent=[]; window.toggles=[]; window.s=s;
          const member=(id,name,status)=>({workflowId:id,displayName:name,status});
          window.members=[member('worker-a','Alpha','idle'),member('worker-b','Beta','busy')];
          for (const id of ['worker-a','worker-b','worker-c']) s.getState().createJob(id,{name:id,workingDirectory:'/projects/fixture',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',skipPermissions:false});
          window.snapshot=(id,depth,members=window.members,enabled=false)=>receive({type:'cluster_state',clusterId:id,state:{clusterId:id,cwd:'/projects/fixture',createdAt:'',taskBoardMode:'none',taskBoardAttached:false,mailboxDepth:depth,members,idleNudgerEnabled:enabled}},{wsRef:{current:null},scheduleReconnect:()=>{}});
          const root=createRoot(document.getElementById('fixture'));
          window.show=id=>root.render(React.createElement('div',{style:{display:'flex',width:'100%',height:'850px'}},React.createElement(ClusterTab,{clusterId:id,onSendToMember:(...args)=>{sent.push(args);return true},onCancelMember:()=>{},onCancelQueuedForMember:()=>{},onUpload:async()=>null,onToggleIdleNudger:(...args)=>toggles.push(args)})));
          snapshot('cluster-a',{}); show('cluster-a');
        }''')
        cards=page.locator('[data-help="cluster.member-card"]')
        await expect(cards).to_have_count(2)
        nudge=page.locator('button[data-help="cluster.broadcast.nudge"]')
        await expect(nudge).to_have_accessible_name('NUDGE: no pending messages')
        empty_background = await nudge.evaluate('el=>getComputedStyle(el).backgroundColor')
        await expect(cards.locator('text=/^NUDGE [0-9]+$/')).to_have_count(0)
        await page.evaluate("snapshot('cluster-a', {'worker-a':1,'worker-b':3,'removed-worker':8})")
        await expect(cards.nth(0).get_by_label('1 pending message; informational')).to_have_text('NUDGE 1')
        await expect(cards.nth(1).get_by_label('3 pending messages; informational')).to_have_text('NUDGE 3')
        await expect(nudge).to_have_accessible_name('NUDGE: 4 pending messages across 2 members')
        assert await nudge.evaluate('el=>getComputedStyle(el).backgroundColor') != empty_background
        await expect(cards.nth(0).get_by_text('IDLE', exact=True)).to_be_visible()
        await expect(cards.nth(1).get_by_text('BUSY', exact=True)).to_be_visible()
        assert await page.evaluate('sent.length') == 0
        await nudge.focus()
        await page.keyboard.press('Enter')
        dialog=page.get_by_role('dialog', name='Nudge — pick recipients')
        await expect(dialog).to_be_visible()
        await expect(dialog.locator('input[type=checkbox]:checked')).to_have_count(0)
        await expect(dialog.get_by_role('button', name='SEND NUDGE (0)')).to_be_disabled()
        await page.keyboard.press('Escape')
        await expect(dialog).to_have_count(0)
        assert await page.evaluate('sent.length') == 0
        await nudge.click()
        await dialog.get_by_text('Beta',exact=True).click()
        await dialog.get_by_role('button',name='SEND NUDGE (1)').click()
        assert await page.evaluate('sent.map(x=>[x[0],x[3]])') == [['worker-b','steer']]
        await expect(nudge).to_have_accessible_name('NUDGE: 4 pending messages across 2 members')
        await page.get_by_label('SHOW BROADCAST').uncheck()
        await expect(nudge).to_have_accessible_name('NUDGE: 4 pending messages across 2 members')
        assert await nudge.evaluate('el=>getComputedStyle(el).backgroundColor') != empty_background
        await nudge.click()
        await expect(dialog.locator('input[type=checkbox]:checked')).to_have_count(0)
        await dialog.get_by_role('button',name='CANCEL').click()
        assert await page.evaluate('sent.length') == 1
        await page.evaluate("snapshot('cluster-a', {'worker-b':1}, [members[1]])")
        await expect(cards).to_have_count(1)
        await expect(nudge).to_have_accessible_name('NUDGE: 1 pending message across 1 member')
        await page.evaluate("snapshot('cluster-a', {})")
        await expect(nudge).to_have_accessible_name('NUDGE: no pending messages')
        await page.evaluate("snapshot('cluster-b', {'worker-a':2}); show('cluster-b')")
        await expect(nudge).to_have_accessible_name('NUDGE: 2 pending messages across 1 member')
        await page.evaluate("snapshot('cluster-b', {'worker-a':0,'worker-b':2}, members, true)")
        await expect(nudge).to_have_accessible_name('NUDGE: 2 pending messages across 1 member')
        alert=page.get_by_role('button',name='Mail alerts enabled')
        await expect(alert).to_have_attribute('aria-pressed','true')
        await alert.click()
        assert await page.evaluate('toggles') == [['cluster-b',False]]
        await page.evaluate("snapshot('cluster-b', {'worker-b':2}, members, false)")
        await expect(page.get_by_role('button',name='Mail alerts off')).to_have_attribute('aria-pressed','false')
        await page.set_viewport_size({'width':1000,'height':700})
        await page.evaluate("document.documentElement.style.zoom='1.5';document.documentElement.style.setProperty('--ui-scale','1.5')")
        for theme in ('matrix', 'phosphor:arco:electric'):
            await page.evaluate('(theme)=>setFixtureTheme(theme)',theme)
            badge=cards.nth(1).get_by_label('2 pending messages; informational')
            await expect(badge).to_be_visible()
            assert await badge.evaluate('''el=>{const c=el.closest('[data-help="cluster.member-card"]').getBoundingClientRect(),b=el.getBoundingClientRect();return b.left>=c.left && b.right<=c.right && b.top>=c.top && b.bottom<=c.bottom}''')
            assert await badge.evaluate("el=>getComputedStyle(el).color !== 'rgba(0, 0, 0, 0)'")
        assert await page.evaluate('sent.length') == 1
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: cluster mail snapshots, controls, explicit recipients, status, toggle and navigation')

asyncio.run(main())
