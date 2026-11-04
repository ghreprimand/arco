"""Exercise cluster mail indicators with isolated snapshots and explicit sends."""
import asyncio
import re
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path, fs_url

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
                if url.path == '/api/outputs':
                    await route.fulfill(json={'outputs':[]})
                    return
                if url.path == '/api/project-trust':
                    await route.fulfill(json={'trusted':False})
                    return
                if url.path == '/fixture':
                    await route.fulfill(status=200, content_type='text/html', body=HTML)
                    return
                is_local_fs = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if is_local_fs or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/', '/phosphor-demo/', '/themes/victor-mono/')):
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
        await expect(cards.locator('[data-help="cluster.member-mail"]')).to_have_count(0)
        await page.evaluate("snapshot('cluster-a', {'worker-a':1,'worker-b':3,'removed-worker':8})")
        idle_mail=cards.nth(0).locator('[data-help="cluster.member-mail"]'); busy_mail=cards.nth(1).locator('[data-help="cluster.member-mail"]')
        await expect(idle_mail).to_have_text('\u2709 1')
        await expect(busy_mail).to_have_text('\u2709 3')
        await expect(busy_mail).to_have_attribute('title', "3 messages waiting; delivered at this worker's next turn")
        await expect(idle_mail).to_have_attribute('title', "1 message waiting; delivered at this worker's next turn. Click to nudge.")
        assert await busy_mail.evaluate('el=>el.tagName') == 'SPAN' and await idle_mail.evaluate('el=>el.tagName') == 'BUTTON'
        warn=await page.evaluate("()=>{const p=document.createElement('i');p.style.color='var(--color-warning)';document.body.appendChild(p);const c=getComputedStyle(p).color;p.remove();return c}")
        assert await idle_mail.evaluate('el=>getComputedStyle(el).color') == warn
        assert await busy_mail.evaluate('el=>getComputedStyle(el).color') != warn
        await busy_mail.click(force=True)
        await expect(nudge).to_have_accessible_name('NUDGE: 4 pending messages across 2 members')
        assert await nudge.evaluate('el=>getComputedStyle(el).backgroundColor') != empty_background
        await expect(cards.nth(0).get_by_text('IDLE', exact=True)).to_be_visible()
        await expect(cards.nth(1).get_by_text('BUSY', exact=True)).to_be_visible()
        assert await page.evaluate('sent.length') == 0
        await idle_mail.click()
        assert await page.evaluate('sent.map(x=>[x[0],x[3]])') == [['worker-a','steer']]
        # The mark and the composer button confirm the nudge until the member starts its turn.
        await expect(cards.nth(0).locator('[data-help="cluster.member-mail"]')).to_have_text('Nudged')
        await expect(cards.nth(0).locator('[data-help="cluster.member-mail"]')).to_have_attribute('data-mail-state','nudged')
        await expect(nudge).to_have_text('NUDGED 1')
        assert await cards.nth(0).locator('button[data-help="cluster.member-mail"]').count() == 0
        await expect(page.get_by_text('Nudged 1 member')).to_have_count(0)
        assert await page.evaluate("s.getState().clusterFocusedMember['cluster-a']") != 'worker-a'
        # Once the nudged member starts its turn, the confirmation clears.
        await page.evaluate("snapshot('cluster-a', {'worker-a':1,'worker-b':3,'removed-worker':8}, [{workflowId:'worker-a',displayName:'Alpha',status:'busy'}, window.members[1]])")
        await expect(cards.nth(0).locator('[data-help="cluster.member-mail"]')).not_to_have_text('Nudged')
        await expect(nudge).not_to_have_text('NUDGED 1')
        await page.evaluate("snapshot('cluster-a', {'worker-a':1,'worker-b':3,'removed-worker':8})")
        await page.evaluate('sent.length=0')
        await nudge.focus()
        await page.keyboard.press('Enter')
        dialog=page.get_by_role('dialog', name='Nudge: pick recipients')
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
        await expect(nudge).to_have_accessible_name(re.compile(r'NUDGE:\ 4\ pending\ messages\ across\ 2\ members$'))
        await expect(page.get_by_label('SHOW BROADCAST')).to_have_count(0)
        await expect(nudge).to_have_accessible_name(re.compile(r'NUDGE:\ 4\ pending\ messages\ across\ 2\ members$'))
        assert await nudge.evaluate('el=>getComputedStyle(el).backgroundColor') != empty_background
        await nudge.click()
        await expect(dialog.locator('input[type=checkbox]:checked')).to_have_count(0)
        await dialog.get_by_role('button',name='CANCEL').click()
        assert await page.evaluate('sent.length') == 1
        await page.evaluate("snapshot('cluster-a', {'worker-b':1}, [members[1]])")
        await expect(cards).to_have_count(1)
        await expect(nudge).to_have_accessible_name(re.compile(r'NUDGE:\ 1\ pending\ message\ across\ 1\ member$'))
        await page.evaluate("snapshot('cluster-a', {})")
        await expect(nudge).to_have_accessible_name(re.compile(r'NUDGE:\ no\ pending\ messages$'))
        await page.evaluate("snapshot('cluster-b', {'worker-a':2}); show('cluster-b')")
        await expect(nudge).to_have_accessible_name(re.compile(r'NUDGE:\ 2\ pending\ messages\ across\ 1\ member$'))
        await page.evaluate("snapshot('cluster-b', {'worker-a':0,'worker-b':2}, members, true)")
        await expect(nudge).to_have_accessible_name(re.compile(r'NUDGE:\ 2\ pending\ messages\ across\ 1\ member$'))
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
            badge=cards.nth(1).locator('[data-help="cluster.member-mail"]')
            await expect(badge).to_be_visible()
            assert await badge.evaluate('''el=>{const c=el.closest('[data-help="cluster.member-card"]').getBoundingClientRect(),b=el.getBoundingClientRect();return b.left>=c.left && b.right<=c.right && b.top>=c.top && b.bottom<=c.bottom}''')
            assert await badge.evaluate("el=>getComputedStyle(el).color !== 'rgba(0, 0, 0, 0)'")
        assert await page.evaluate('sent.length') == 1
        await page.evaluate("""async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {MailboxModal} = await import('/src/components/ClusterRightPanel/MailboxModal.tsx');
          const host=document.createElement('div'); document.body.appendChild(host);
          createRoot(host).render(React.createElement(MailboxModal,{cluster:{members:window.members},wfid:'worker-b',messages:[{msgId:'m1',fromWorkflowId:'worker-a',content:'Please check',createdAt:'2026-01-01T00:00:00Z',recipientContext:{state:'busy',task:{id:'abcd1234',title:'Fix the test'},lastMessage:{firstLine:'Review complete',ageSeconds:42}}}],loading:false,error:null,onClose:()=>{},onCancel:()=>{}}));
        }""")
        mailbox = page.locator('[data-help="cluster.mailbox-modal"]')
        await expect(mailbox.get_by_text('Recipient: busy | Task: Fix the test (abcd1234) | Latest reply: Review complete (42s ago)')).to_be_visible()
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: cluster mail snapshots, controls, explicit recipients, status, toggle and navigation')

asyncio.run(main())
