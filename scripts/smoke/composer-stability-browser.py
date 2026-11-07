"""Composer coverage against isolated Vite APIs/WS; no provider calls.
Run ARCO_CLIENT_PORT=5194 npm run dev:client, then python3 this file.
"""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()

URL = os.environ.get('ARCO_INTERRUPT_PREVIEW_URL', 'http://127.0.0.1:5254/')
CHROME = os.environ.get('ARCO_TEST_CHROME', os.path.expanduser('~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'))


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME)
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000})
        messages, errors = [], []

        async def api(route):
            path = urlparse(route.request.url).path
            data = {'files': [], 'entries': [], 'workflows': [], 'projects': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'tasks': [], 'sessions': [], 'messages': [], 'chats': [], 'dirs': []}
            if path == '/api/settings':
                data = {'themeId': 'arch', 'enabledProviders': {'codex': True, 'claude': True}}
            elif path == '/api/auth-status':
                data = {n: {'loggedIn': True, 'installed': True, 'cliInstalled': True} for n in ['claude', 'codex',  'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'github']}
            elif path == '/api/capabilities':
                data = {'efforts': ['low', 'medium', 'high'], 'models': ['gpt-5.5'], 'cliVersion': 'fixture', 'codexVersion': '0.164.0'}
            elif path.endswith('/catalog'):
                data = {'models': []}
            await route.fulfill(json=data)

        await context.route('**/api/**', api)
        await context.route('**/healthz', lambda r: r.fulfill(json={'status': 'live'}))
        await context.route('https://**/*', lambda r: r.abort())
        await context.route_web_socket('**/*', lambda ws: ws.on_message(lambda raw: messages.append(json.loads(raw))))
        await context.add_init_script('''
          const OriginalWebSocket = window.WebSocket;
          window.WebSocket = class extends OriginalWebSocket {
            constructor(...args) { super(...args); window.testSocket = this; }
          };
        ''')
        page = await context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(URL)
        await page.wait_for_timeout(500)
        await page.evaluate('''async () => {
          const loaded = path => performance.getEntriesByType('resource').map(e => e.name).findLast(url => new URL(url).pathname === path) ?? path;
          const {useAppStore:s} = await import(loaded('/src/stores/appStore.ts')); window.testStore=s;
          s.getState().createJob('interrupt-ui', {kind:'workflow',name:'Interrupt UI',primaryProvider:'codex',primaryModel:'gpt-5.5',primaryEffort:'high',codexTransport:'appserver',workingDirectory:'/tmp',skipPermissions:false});
          s.getState().beginPrimaryTurn('interrupt-ui', Date.now());
          s.setState({connected:true,connectionState:'online',focusMode:true});
        }''')
        for width in [1366, 1920]:
            await page.set_viewport_size({'width': width, 'height': 768 if width == 1366 else 1080})
            for mode in ['standard', 'compact', 'narrow']:
                await page.evaluate("mode => localStorage.setItem('arco.layoutMode', mode)", mode)
                await page.reload()
                await page.wait_for_timeout(300)
                await page.evaluate('''async () => {
                  const {useAppStore:s}=await import('/src/stores/appStore.ts'); window.testStore=s;
                  s.getState().createJob('interrupt-ui',{kind:'workflow',name:'Fixture',primaryProvider:'codex',primaryModel:'gpt-5.5',primaryEffort:'high',codexTransport:'appserver',workingDirectory:'/demo',skipPermissions:false});
                  s.getState().beginPrimaryTurn('interrupt-ui',Date.now());
                  s.setState({connected:true,connectionState:'online',focusMode:true});
                }''')
                toolbar = page.get_by_test_id('composer-toolbar')
                await expect(toolbar).to_have_css('flex-wrap', 'wrap' if mode == 'standard' else 'nowrap')
                for theme in ['matrix', 'phosphor:arco:electric']:
                    await page.evaluate('''async theme => {
                      const {applyTheme}=await import('/src/themes/apply.ts');
                      const {getTheme}=await import('/src/themes/registry.ts'); applyTheme(getTheme(theme));
                    }''', theme)
                    await page.wait_for_timeout(250)
                    samples = await page.evaluate('''async () => {
                      const s=window.testStore, jobId='interrupt-ui';
                      const el=document.querySelector('[data-help="composer.input"]').parentElement;
                      const samples=[]; let start=performance.now(), last=-1;
                      return await new Promise(resolve => {
                        function frame(t) {
                          const phase=Math.floor((t-start)/250);
                          if (phase !== last) {
                            last=phase;
                            const j=s.getState().jobs[jobId];
                            const names=['Read','A very long tool name with many words that keeps changing while a turn is running and should never force a line to wrap','Bash','Search'];
                            const entry={id:'fixture',kind:'tool_use',tool:names[phase%names.length],status:'started',at:Date.now()-phase*1000,input:JSON.stringify({command:'Inspect synthetic files'})};
                            const queued=phase%2 ? [{content:'Synthetic queued message',clientMessageId:'fixture'}] : [];
                            s.setState({jobs:{...s.getState().jobs,[jobId]:{...j,activity:[entry],queue:{steering:queued,followUp:[]}}}});
                          }
                          const r=el.getBoundingClientRect(); samples.push([r.x,r.y,r.width,r.height]);
                          if (t-start<1800) requestAnimationFrame(frame); else resolve(samples);
                        }
                        requestAnimationFrame(frame);
                      });
                    }''')
                    unique = sorted({tuple(round(v, 2) for v in row) for row in samples})
                    print(width, mode, theme, len(samples), unique, flush=True)
                    assert len(unique) == 1, (width, mode, theme, unique)
                    status = page.locator('[data-help="composer.turn-step"]')
                    await expect(status).to_be_visible()
                    assert await status.get_attribute('title')
        assert not errors, errors
        await browser.close()
        print('PASS: composer remains stable during changing turn steps')

asyncio.run(main())
