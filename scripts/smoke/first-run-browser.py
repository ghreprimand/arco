"""Fresh setup to a real fixture turn, skip persistence and returning users.

Temporary server homes, synthetic projects, denying CLIs, isolated network.
The local Ollama fixture emits a fixed response; no credentials or inference.
"""
import asyncio
import importlib.util
import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect

spec = importlib.util.spec_from_file_location('connections_fixture', Path(__file__).with_name('connections-browser.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)

ANSWER = 'Synthetic setup conversation is working.'


class Model(h.FakeModel):
    def __init__(self):
        super().__init__()
        original = self.server.RequestHandlerClass
        outer = self

        class Handler(original):
            def do_POST(self):
                if self.path != '/api/chat':
                    return super().do_POST()
                self.rfile.read(int(self.headers.get('Content-Length') or 0))
                outer.chats += 1
                data = (json.dumps({'model': 'fixture-model:latest', 'message': {'role': 'assistant', 'content': ANSWER}, 'done': True, 'done_reason': 'stop', 'prompt_eval_count': 5, 'eval_count': 8}) + '\n').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/x-ndjson')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server.RequestHandlerClass = Handler


class Fresh(h.IsolatedServer):
    def extra_settings(self):
        return {'defaultWorkingDirectory': '', 'projects': []}

    def __init__(self):
        super().__init__(f'http://127.0.0.1:{h.host_isolation.closed_port()}')
        (self.home / '.arco/known-cwds.json').unlink(missing_ok=True)


async def page_for(playwright, server):
    b = h.Browser(playwright, server)
    b.browser = await playwright.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
    b.context = await b.browser.new_context()

    async def local_only(route):
        if urlparse(route.request.url).netloc == urlparse(server.base).netloc:
            await route.continue_()
        else:
            await route.abort()

    await b.context.route('http**://**/*', local_only)
    await b.context.add_init_script(h.INSTRUMENT)
    b.page = await b.context.new_page()
    b.errors = []
    b.writes = []
    b.page.on('request', lambda request: b.writes.append(urlparse(request.url).path) if request.method not in ('GET', 'HEAD', 'OPTIONS') else None)
    b.page.on('pageerror', lambda error: b.errors.append(str(error)))
    await b.page.goto(server.base)
    # A fresh gate intentionally hides the workspace header and its ONLINE text.
    await b.page.locator('#first-run-title, #home-title').first.wait_for(timeout=30000)
    return b, b.page


async def setup_chat(playwright):
    model, server = Model(), Fresh()
    b = None
    try:
        b, page = await page_for(playwright, server)
        await page.get_by_role('heading', name='Welcome to Arco', exact=True).wait_for()
        await page.get_by_role('button', name='Get started', exact=True).click()
        await page.get_by_label('Project folder path', exact=True).fill(str(server.projects / 'missing'))
        await page.get_by_role('button', name='Add folder and continue', exact=True).click()
        await expect(page.get_by_role('status')).to_contain_text('project directory')
        await page.get_by_label('Folder to scan', exact=True).fill(str(server.projects))
        await page.get_by_role('button', name='Scan folder', exact=True).click()
        await page.get_by_role('button', name=f'app: {server.projects / "app"}', exact=True).click()
        await expect(page.get_by_label('Project folder path', exact=True)).to_have_value(str(server.projects / 'app'))
        await page.get_by_role('button', name='Add folder and continue', exact=True).click()
        dialog = page.get_by_role('dialog', name='Welcome - Connections', exact=True)
        await dialog.get_by_role('navigation', name='Connections').get_by_role('button', name=re.compile('^Ollama')).click()
        await page.get_by_label('Model server address', exact=True).fill(model.url)
        await page.get_by_role('button', name='Save endpoint', exact=True).click()
        await page.get_by_role('button', name='Test connection', exact=True).click()
        await expect(page.get_by_role('button', name='Continue to chat', exact=True)).to_be_enabled()
        assert model.chats == 0, 'connection checks sent a prompt'
        assert await page.evaluate("window.__sent.filter(s=>/create_workflow|create_cluster|send_prompt/.test(s)).length") == 0
        await page.get_by_role('button', name='Continue to chat', exact=True).click()
        await expect(page.locator('select').first).to_have_value('ollama')
        await page.get_by_placeholder(re.compile('^e.g. Code Review')).fill('Setup fixture')
        await page.get_by_role('button', name='LAUNCH WORKFLOW', exact=True).click()
        await page.get_by_role('button', name='+ NEW', exact=True).wait_for(timeout=30000)
        frames = await page.evaluate('window.__sent.map(s=>{try{return JSON.parse(s)}catch{return {}}})')
        created = next(m for m in frames if m.get('type') == 'create_workflow')
        assert created['config']['workingDirectory'] == str(server.projects / 'app'), created
        assert created['config']['primaryProvider'] == 'ollama', created
        composer = page.locator('textarea:visible').first
        await composer.fill('Reply with the synthetic setup confirmation.')
        await composer.press('Enter')
        await page.get_by_text(ANSWER, exact=False).first.wait_for(timeout=30000)
        assert model.chats >= 1
        settings = (await (await page.request.get(server.base + '/api/settings')).json())
        assert settings['onboardingComplete'] is True
        # Remove project and endpoint signals, then use a fresh browser.
        await page.request.post(server.base + '/api/settings', data={'projects': [], 'ollama': {'baseUrl': f'http://127.0.0.1:{h.host_isolation.closed_port()}'}})
        (server.home / '.arco/known-cwds.json').unlink(missing_ok=True)
        await b.close()
        b, page = await page_for(playwright, server)
        await expect(page.get_by_role('heading', name='Welcome to Arco', exact=True)).to_have_count(0)
        assert not b.errors, b.errors
        print('PASS: fresh folder -> real Connections -> selected provider -> fixture conversation; completion survives a new browser')
    finally:
        if b:
            await b.close()
        server.close()
        model.close()


async def skip_and_reopen(playwright):
    server = Fresh()
    b = None
    try:
        b, page = await page_for(playwright, server)
        await page.get_by_role('button', name='Skip this step', exact=True).click()
        await page.get_by_role('button', name='Skip this step', exact=True).click()
        await page.get_by_role('button', name='SKIP FOR NOW', exact=True).click()
        await page.get_by_role('heading', name='Start a chat', exact=True).wait_for()
        await page.get_by_role('button', name='Skip this step', exact=True).click()
        await page.locator('#home-title').wait_for()
        await page.reload()
        await page.locator('#home-title').wait_for()
        await expect(page.get_by_role('heading', name='Welcome to Arco', exact=True)).to_have_count(0)
        await page.goto(server.base + '/#settings/projects/projects')
        await page.get_by_role('button', name='Run setup again', exact=True).click()
        await page.get_by_role('heading', name='Welcome to Arco', exact=True).wait_for()
        await page.get_by_role('button', name='Skip setup', exact=True).click()
        await page.locator('#home-title').wait_for()
        print('PASS: every step skips; reload stays on Home; Settings reopens setup')
    finally:
        if b:
            await b.close()
        server.close()


async def registered_returning(playwright):
    server = Fresh()
    b = None
    try:
        # Merely registered: no workflow history or connected provider.
        settings = json.loads((server.home / '.arco/settings.json').read_text())
        settings['projects'] = [str(server.projects / 'app')]
        (server.home / '.arco/settings.json').write_text(json.dumps(settings))
        b, page = await page_for(playwright, server)
        await page.locator('#home-title').wait_for()
        await expect(page.get_by_role('heading', name='Welcome to Arco', exact=True)).to_have_count(0)
        history = await (await page.request.get(server.base + '/api/installation-history')).json()
        assert history['used'] is True
        stored = await (await page.request.get(server.base + '/api/settings')).json()
        assert 'onboardingComplete' not in stored, 'browsing must not complete setup by writing settings'
        await page.reload()
        await page.locator('#home-title').wait_for()
        await expect(page.get_by_role('heading', name='Welcome to Arco', exact=True)).to_have_count(0)
        assert '/api/settings' not in b.writes, b.writes
        print('PASS: an existing project bypasses setup without earlier workflow history or page-load settings writes')
    finally:
        if b:
            await b.close()
        server.close()


async def main():
    async with async_playwright() as playwright:
        await setup_chat(playwright)
        await skip_and_reopen(playwright)
        await registered_returning(playwright)


asyncio.run(main())
