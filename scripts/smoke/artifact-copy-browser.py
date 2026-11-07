"""Copy an artifact through the dialog against an isolated synthetic Git project."""
import asyncio
import importlib.util
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect

spec = importlib.util.spec_from_file_location('storage_harness', Path(__file__).with_name('connections-browser.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
class Server(h.IsolatedServer):
    def extra_settings(self):
        return {'projects': [str(self.projects / 'app')], 'onboardingComplete': True}

HTML = '''<!doctype html><html><body><div id="fixture"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>'''
async def main():
    server = Server(f'http://127.0.0.1:{h.host_isolation.closed_port()}')
    project = server.projects / 'app'
    vite = None
    try:
        subprocess.run(['git', 'init', '-q', str(project)], check=True)
        (project / '.gitignore').write_text('.arco/\n')
        conv = project / '.arco' / 'workflows' / 'conv-1'
        (conv / 'artifacts').mkdir(parents=True)
        (conv / 'meta.json').write_text(json.dumps({'name': 'Fixture'}))
        (conv / 'artifacts' / 'picture.png').write_bytes(b'\x89PNG' + b'api_' + b'key=fixture_value')
        # A file past the 1,000-findings limit and a binary with readable text
        # are reviewed, not refused, and listed as not fully scanned. Line
        # numbers in a binary count its newline bytes (64 in the first part).
        (conv / 'artifacts' / 'noisy.txt').write_text('password=fixture\n' * 1001)
        (conv / 'artifacts' / 'disk.bin').write_bytes(bytes(range(256)) * 64 + b'\n' + b'password=' + b'synthetic\n' + bytes(range(255, -1, -1)) * 64)
        source = conv / 'artifacts' / 'report.txt'
        source.write_text('Email: ' + '@'.join(['person', 'example.test']) + '\n')
        port = h.host_isolation.closed_port()
        env = {**server.env, 'ARCO_CLIENT_PORT': str(port), 'ARCO_PORT': str(server.port)}
        vite = subprocess.Popen(['node', 'node_modules/vite/bin/vite.js', 'client', '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=h.REPO, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        base = f'http://127.0.0.1:{port}'
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if vite.poll() is not None: raise RuntimeError('Fixture Vite exited')
            try:
                with urllib.request.urlopen(base, timeout=1): break
            except Exception: await asyncio.sleep(.15)
        else: raise RuntimeError('Fixture Vite did not start')
        async with async_playwright() as p:
            browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
            context = await browser.new_context()
            async def local_only(route):
                parsed = urlparse(route.request.url)
                if parsed.netloc == urlparse(base).netloc and parsed.path == '/fixture': await route.fulfill(content_type='text/html', body=HTML)
                elif parsed.netloc in (urlparse(base).netloc, urlparse(server.base).netloc): await route.continue_()
                else: await route.abort()
            await context.route('http**://**/*', local_only)
            page = await context.new_page()
            await page.goto(server.base)
            await page.goto(base + '/fixture')
            await page.evaluate('(cwd) => localStorage.setItem("arco.publicProject." + cwd, "1")', str(project))
            await page.wait_for_function('window.fixtureReady === true')
            saved = await page.evaluate('''async (cwd) => {
              const headers = {'Content-Type':'application/json'};
              const choice = await fetch('/api/public-project/choice', {method:'POST', headers, body:JSON.stringify({path:cwd,value:true})});
              const review = await fetch('/api/storage/copy-review', {method:'POST', headers, body:JSON.stringify({path:cwd,workflowId:'conv-1',itemPath:'artifacts',destinationFolder:cwd,publicProject:false,confirm:true})});
              return {ok:choice.ok, data:await review.json()};
            }''', str(project))
            assert saved['ok'] and saved['data']['publicRepository'] is True, saved
            await page.evaluate('''async (cwd) => {
              const React = (await import('/node_modules/.vite/deps/react.js')).default;
              const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
              const { ArtifactMoveDialog } = await import('/src/components/ArtifactMoveDialog.tsx');
              createRoot(document.getElementById('fixture')).render(React.createElement(ArtifactMoveDialog, { cwd, workflowId: 'conv-1', itemPath: 'artifacts', onClose: () => {} }));
            }''', str(project))
            dialog = page.get_by_role('dialog', name='Move artifact to project')
            await dialog.get_by_role('button', name='ADD TO PROJECT FILES').click()
            await dialog.get_by_role('button', name='REVIEW DESTINATION').click()
            await expect(dialog.get_by_text('report.txt:1 - email-address')).to_be_visible(timeout=30000)
            await expect(dialog.get_by_text('Files here are included in your repository unless you exclude them.')).to_be_visible()
            await expect(dialog.get_by_text('picture.png', exact=True)).to_be_visible()
            await expect(dialog.get_by_text('noisy.txt (findings limit reached; the rest was not scanned)', exact=True)).to_be_visible()
            await expect(dialog.get_by_text('disk.bin', exact=True)).to_be_visible()
            await expect(dialog.get_by_text('disk.bin:66 - password-or-secret', exact=True)).to_be_visible()
            await expect(dialog.get_by_text('noisy.txt:1000 - password-or-secret', exact=True)).to_be_visible()
            await expect(dialog.get_by_text('noisy.txt:1001 - password-or-secret', exact=True)).to_have_count(0)
            review = await page.evaluate('''async (cwd) => {
              const body = {path: cwd, workflowId: 'conv-1', itemPath: 'artifacts', destinationFolder: cwd, publicProject: true, confirm: true};
              const review = await (await fetch('/api/storage/copy-review', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)})).json();
              const response = await fetch('/api/storage/copy-confirm', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...body, token:review.token})});
              return response.status;
            }''', str(project))
            assert review != 200 and not (project / 'artifacts').exists()
            confirmations = []
            async def confirm_copy(prompt):
                confirmations.append(prompt.message)
                if len(confirmations) == 1: await prompt.dismiss()
                else: await prompt.accept()
            page.on('dialog', lambda prompt: asyncio.create_task(confirm_copy(prompt)))
            await dialog.get_by_role('button', name='COPY INTO PUBLIC REPOSITORY').click()
            await page.wait_for_timeout(300)
            assert not (project / 'artifacts').exists() and 'picture.png' in confirmations[0]
            assert 'noisy.txt' in confirmations[0] and 'disk.bin' in confirmations[0]
            await dialog.get_by_role('button', name='COPY INTO PUBLIC REPOSITORY').click()
            await expect(dialog.get_by_text('Copied into the project.', exact=False)).to_be_visible(timeout=30000)
            assert (project / 'artifacts' / 'report.txt').read_text() == source.read_text()
            assert source.exists()
            assert subprocess.check_output(['git', 'diff', '--cached', '--name-only'], cwd=project).strip() == b''
            await browser.close()
    finally:
        if vite:
            vite.terminate()
            try: vite.wait(timeout=10)
            except subprocess.TimeoutExpired: vite.kill(); vite.wait(timeout=5)
        server.close()
asyncio.run(main())
