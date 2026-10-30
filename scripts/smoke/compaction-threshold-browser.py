"""Exercise threshold edits with controlled state and isolated browser traffic."""
import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect

PORT = os.environ.get('ARCO_CLIENT_PORT', '5203')
ORIGIN = 'http://127.0.0.1:' + PORT
VITE_ENV = '/@fs' + str((Path(__file__).resolve().parents[2] / 'node_modules/vite/dist/client/env.mjs').resolve())
HTML = '''<!doctype html><html><body><div id="fixture"></div><button id="outside">Outside</button>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(has_touch=True)
        blocked = []
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                if url.path == '/fixture':
                    await route.fulfill(status=200, content_type='text/html', body=HTML)
                    return
                if url.path == VITE_ENV or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/components/AutoCompactionThreshold/')):
                    await route.continue_()
                    return
            blocked.append(route.request.url)
            await route.abort()
        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: print('fixture error:', error, flush=True))
        await page.goto(ORIGIN + '/fixture')
        try:
            await page.wait_for_function('window.fixtureReady === true', timeout=5000)
        except Exception:
            print('blocked requests:', blocked, flush=True)
            raise
        await page.evaluate('''async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {AutoCompactionThreshold} = await import('/src/components/AutoCompactionThreshold/index.tsx');
          window.commits = []; window.accept = true;
          const root = createRoot(document.getElementById('fixture'));
          function Fixture({id}) {
            const [policy, setPolicy] = React.useState({enabled:true, thresholdPercent:80});
            window.setPolicy = setPolicy; window.fixturePolicy = policy;
            return React.createElement(AutoCompactionThreshold, {
              key:`${id}:${policy.enabled}`, label:id, value:policy.thresholdPercent,
              onCommit:v=>{ window.commits.push([id,v]); if(window.accept) setPolicy(p=>({...p,thresholdPercent:v})); }
            });
          }
          window.renderFixture = id => root.render(React.createElement(Fixture, {key:id,id}));
          window.renderFixture('worker');
        }''')
        for name in ('worker', 'cluster'):
            if name == 'cluster': await page.evaluate("renderFixture('cluster')")
            slider = page.get_by_label(name)
            await expect(slider).to_be_visible()
            await slider.focus()
            await page.keyboard.press('ArrowRight')
            await expect(slider).to_have_value('81')
            await expect(slider).to_be_focused()
            await page.keyboard.press('ArrowRight')
            await expect(slider).to_have_value('82')
            await expect(slider).to_be_focused()
            await page.evaluate('window.accept = false')
            await page.keyboard.press('ArrowRight')
            await expect(slider).to_have_value('82')
            await expect(slider).to_be_focused()
            await page.evaluate('window.accept = true')
            box = await slider.bounding_box()
            y = box['y'] + box['height']/2
            before = await page.evaluate('commits.length')
            await page.mouse.move(box['x'] + box['width']*.5, y)
            await page.mouse.down()
            await page.mouse.move(box['x'] + box['width']*.8, y, steps=8)
            assert await page.evaluate('commits.length') == before
            await page.mouse.up()
            assert await page.evaluate('commits.length') == before + 1
            await slider.focus()
            await page.keyboard.down('ArrowLeft')
            await page.locator('#outside').focus()
            await page.keyboard.up('ArrowLeft')
            assert await page.evaluate('commits.length') == before + 2
            await page.touchscreen.tap(box['x'] + box['width']*.25, y)
            assert await page.evaluate('commits.length') == before + 3
            await slider.focus()
            await page.keyboard.press('Home')
            await page.keyboard.press('End')
            assert await page.evaluate('commits.slice(-2).map(x=>x[1])') == [30, 95]
            before = await page.evaluate('commits.length')
            await page.mouse.move(box['x'] + box['width']*.5, y)
            await page.mouse.down()
            await page.mouse.move(box['x'] + box['width']*.7, y)
            await slider.dispatch_event('pointercancel')
            await page.mouse.up()
            assert await page.evaluate('commits.length') == before
            await page.mouse.move(box['x'] + box['width']*.5, y)
            await page.mouse.down()
            await page.mouse.move(box['x'] + box['width']*.7, y)
            await page.evaluate("setPolicy(p=>({...p, enabled:!p.enabled}))")
            await page.wait_for_function("window.fixturePolicy.enabled === false")
            await page.mouse.up()
            assert await page.evaluate('commits.length') == before
            await page.mouse.move(box['x'] + box['width']*.5, y)
            await page.mouse.down()
            await page.mouse.move(box['x'] + box['width']*.7, y)
            await page.evaluate("setPolicy(p=>({...p, thresholdPercent:60}))")
            await expect(slider).to_have_value('60')
            await page.mouse.up()
            assert await page.evaluate('commits.length') == before
            await slider.focus()
            await page.keyboard.down('ArrowRight')
            await page.keyboard.press('Escape')
            await page.keyboard.up('ArrowRight')
            await expect(slider).to_have_value('60')
            assert await page.evaluate('commits.length') == before
        await page.mouse.move(box['x'] + box['width']*.5, y)
        await page.mouse.down()
        await page.mouse.move(box['x'] + box['width']*.7, y)
        await page.evaluate("renderFixture('another-worker')")
        await expect(page.get_by_label('another-worker')).to_be_visible()
        await page.mouse.up()
        assert await page.evaluate('commits.length') == before
        assert not blocked, blocked
        await browser.close()
        print('PASS: controlled worker and cluster feedback, focus, rejected saves and interaction boundaries')

asyncio.run(main())
