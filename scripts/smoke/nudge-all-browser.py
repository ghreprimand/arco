"""NUDGE ALL WITH MAIL: one click nudges exactly the members with waiting mail, idle or busy."""
import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path
from host_isolation import chrome_executable

PORT = os.environ.get('ARCO_CLIENT_PORT', '5203')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/styles/matrix.css"><link rel="stylesheet" href="/src/themes/phosphor/phosphor.css"></head><body><div id="fixture"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''
SETUP = '''async () => {
  const React = (await import('/node_modules/.vite/deps/react.js')).default;
  const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
  const {ClusterTab} = await import('/src/components/ClusterTab.tsx');
  const {useAppStore:s} = await import('/src/stores/appStore.ts');
  const {handleServerMessage:receive} = await import('/src/ws/handleServerMessage.ts');
  window.nudge = await import('/src/utils/clusterNudge.ts');
  window.dialogs = await import('/src/voice/dialogs.ts');
  window.sent = [];
  // Two idle members with mail, one busy member with mail, one idle member without.
  window.members = [['alpha','Alpha','idle'],['beta','Beta','idle'],['gamma','Gamma','busy'],['delta','Delta','idle']].map(([workflowId,displayName,status]) => ({workflowId,displayName,status}));
  for (const m of members) s.getState().createJob(m.workflowId,{name:m.displayName,workingDirectory:'/projects/fixture',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',skipPermissions:false});
  window.snapshot = (depth) => receive({type:'cluster_state',clusterId:'cluster-a',state:{clusterId:'cluster-a',cwd:'/projects/fixture',createdAt:'',taskBoardMode:'none',taskBoardAttached:false,mailboxDepth:depth,members}},{wsRef:{current:null},scheduleReconnect:()=>{}});
  snapshot({alpha:1,beta:2,gamma:3,removed:4});
  createRoot(document.getElementById('fixture')).render(React.createElement('div',{style:{display:'flex',width:'100%',height:'100vh'}},React.createElement(ClusterTab,{clusterId:'cluster-a',onSendToMember:(...args)=>{sent.push(args);return true},onCancelMember:()=>{},onCancelQueuedForMember:()=>{},onUpload:async()=>null})));
}'''

async def open_page(browser, width, height, layout):
    page = await browser.new_page(viewport={'width': width, 'height': height})
    await page.add_init_script(f"localStorage.setItem('arco.layoutMode', '{layout}')")
    blocked, errors = [], []
    async def isolate(route):
        url = urlparse(route.request.url)
        if url.scheme == 'https' and url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
            await route.fulfill(status=200, content_type='text/css', body='')
            return
        if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and route.request.method == 'GET':
            fixtures = {
                '/api/outputs': {'outputs': []},
                '/api/project-trust': {'trusted': False},
                '/api/public-project/remote': {'state': 'none'},
                '/api/public-project/state': {'isGit': False, 'hasState': False, 'tracked': 0, 'trackedSample': [], 'ignored': True, 'ignoreFile': 'default'},
            }
            if url.path in fixtures:
                await route.fulfill(json=fixtures[url.path])
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
    await page.evaluate(SETUP)
    # Narrow windows show the member rail instead of cards.
    if width >= 1100:
        await expect(page.locator('[data-help="cluster.member-card"]')).to_have_count(4)
    return page, blocked, errors

async def open_picker(page):
    # The same picker the NUDGE button opens, reached in every layout.
    await page.wait_for_function("dialogs.requestVoiceDialog('nudge', null, 'cluster-a')", timeout=10000)
    dialog = page.get_by_role('dialog', name='Nudge: pick recipients')
    await expect(dialog).to_be_visible()
    return dialog

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page, blocked, errors = await open_page(browser, 1500, 900, 'standard')
        await page.locator('button[data-help="cluster.broadcast.nudge"]').click()
        dialog = page.get_by_role('dialog', name='Nudge: pick recipients')
        everyone = dialog.get_by_role('button', name='NUDGE ALL WITH MAIL (3)')
        await expect(everyone).to_be_enabled()
        # Nothing is ticked: NUDGE ALL does not depend on the checkboxes.
        await expect(dialog.locator('input[type=checkbox]:checked')).to_have_count(0)
        await everyone.click()
        await expect(dialog).to_have_count(0)
        sent = await page.evaluate("sent.map(x=>[x[0], x[1]===nudge.buildClusterNudge(undefined,false,undefined) ? 'wake' : x[1]===nudge.buildClusterNudge(undefined,true,undefined) ? 'reminder' : 'other', x[3], x[6]])")
        assert sent == [['alpha', 'wake', 'steer', 'nudge'], ['beta', 'wake', 'steer', 'nudge'], ['gamma', 'reminder', 'steer', 'nudge']], sent
        await expect(page.get_by_text('Nudged 3 members (1 busy: reminded to read mail when convenient)')).to_be_visible()
        # No mail: disabled, with the reason in the dialog and the tooltip.
        await page.evaluate('sent.length=0; snapshot({removed:2})')
        dialog = await open_picker(page)
        everyone = dialog.get_by_role('button', name='NUDGE ALL WITH MAIL (0)')
        await expect(everyone).to_be_disabled()
        await expect(everyone).to_have_attribute('title', 'No member has waiting mail')
        await expect(dialog.get_by_test_id('nudge-all-reason')).to_have_text('No member has waiting mail')
        await page.keyboard.press('Escape')
        await expect(dialog).to_have_count(0)
        # The command palette entry runs the same nudge in the active cluster tab.
        await page.evaluate("snapshot({delta:1})")
        await expect(page.locator('[data-help="cluster.member-card"]').nth(3).locator('[data-help="cluster.member-mail"]')).to_be_visible()
        assert await page.evaluate("nudge.requestNudgeAll('cluster-a')")
        assert await page.evaluate('sent.map(x=>x[0])') == ['delta']
        assert not await page.evaluate("nudge.requestNudgeAll('other-cluster')")
        await page.evaluate('sent.length=0; snapshot({})')
        assert await page.evaluate("nudge.requestNudgeAll('cluster-a')")
        assert await page.evaluate('sent.length') == 0
        await expect(page.get_by_text('No member has waiting mail').first).to_be_visible()
        assert not errors, errors
        assert not blocked, blocked
        await page.close()
        # The picker's buttons fit inside the dialog and the window in Compact and narrow Automatic.
        for layout, width, height in (('compact', 1280, 800), ('automatic', 900, 700), ('automatic', 480, 800)):
            page, blocked, errors = await open_page(browser, width, height, layout)
            dialog = await open_picker(page)
            box = await dialog.bounding_box()
            assert box['x'] >= 0 and box['x'] + box['width'] <= width + 1, (layout, width, box)
            for name in ('CANCEL', 'NUDGE ALL WITH MAIL (3)', 'SEND NUDGE (0)'):
                b = await dialog.get_by_role('button', name=name).bounding_box()
                assert b['x'] >= box['x'] - 1 and b['x'] + b['width'] <= box['x'] + box['width'] + 1, (layout, width, name, b, box)
            await dialog.get_by_role('button', name='NUDGE ALL WITH MAIL (3)').click()
            assert await page.evaluate('sent.map(x=>x[0])') == ['alpha', 'beta', 'gamma'], (layout, width)
            assert not errors, errors
            assert not blocked, blocked
            await page.close()
        await browser.close()
        print('PASS: NUDGE ALL WITH MAIL nudges exactly the members with mail (busy ones get the reminder); disabled with a reason; palette request; fits Standard, Compact and narrow')

asyncio.run(main())
