"""Skill management against an isolated synthetic project: IMPORT a fixture
skill from a folder (files and the security check shown first), TURN OFF (left
out of the composer SKILLS menu), MOVE TO GLOBAL and back, and SHARE WITH
REPOSITORY. GitHub and zip imports are covered by server/src/skillManagement.test.ts
with a mocked network."""
import asyncio
import importlib.util
import json
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

HTML = '''<!doctype html><html><body><div id="fixture"></div><div id="composer"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>'''
ZWSP = chr(0x200b)

# Git without the machine's own configuration or excludes file, as the
# isolated server runs it.
GIT_ENV = {}

def ignored(project, rel):
    return subprocess.run(['git', 'check-ignore', '-q', '--no-index', '--', rel], cwd=project, env=GIT_ENV).returncode == 0

async def main():
    server = Server(f'http://127.0.0.1:{h.host_isolation.closed_port()}')
    project = server.projects / 'app'
    GIT_ENV.update({**h.os.environ, 'HOME': str(server.home), 'XDG_CONFIG_HOME': str(server.home / '.config'), 'GIT_CONFIG_NOSYSTEM': '1'})
    vite = None
    try:
        subprocess.run(['git', 'init', '-q', str(project)], check=True, env=GIT_ENV)
        source = server.root / 'fixture-skill'
        (source / 'reference').mkdir(parents=True)
        (source / 'SKILL.md').write_text('---\nname: "Release checklist"\ndescription: "Steps before a release"\n---\n\nFollow the steps, then use the release-notes skill.\n')
        (source / 'reference' / 'steps.md').write_text('1. Build' + ZWSP + '\n')
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
            browser = await p.chromium.launch(executable_path=h.os.environ.get('ARCO_TEST_CHROME') or None)
            context = await browser.new_context(viewport={'width': 1200, 'height': 1000})
            async def local_only(route):
                parsed = urlparse(route.request.url)
                if parsed.netloc == urlparse(base).netloc and parsed.path == '/fixture': await route.fulfill(content_type='text/html', body=HTML)
                elif parsed.netloc in (urlparse(base).netloc, urlparse(server.base).netloc): await route.continue_()
                else: await route.abort()
            await context.route('http**://**/*', local_only)
            page = await context.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            prompts = []
            async def accept(prompt):
                prompts.append(prompt.message); await prompt.accept()
            page.on('dialog', lambda prompt: asyncio.create_task(accept(prompt)))
            await page.goto(server.base)
            await page.goto(base + '/fixture')
            await page.wait_for_function('window.fixtureReady === true')
            await page.evaluate('''async (cwd) => {
              const React = (await import('/node_modules/.vite/deps/react.js')).default;
              const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
              const { SkillsSettings } = await import('/src/components/SkillsSettings.tsx');
              createRoot(document.getElementById('fixture')).render(React.createElement(SkillsSettings, { cwd }));
            }''', str(project))
            await expect(page.get_by_text('which Git ignores like the rest of', exact=False)).to_be_visible(timeout=30000)

            # IMPORT from a folder: review lists files and the security finding.
            await page.get_by_role('button', name='IMPORT', exact=True).click()
            dialog = page.get_by_role('dialog', name='Import skill')
            await dialog.get_by_label('Folder').check()
            await dialog.get_by_label('Skill folder').fill(str(source))
            await expect(dialog.get_by_role('button', name='IMPORT', exact=True)).to_be_disabled()
            await dialog.get_by_role('button', name='REVIEW').click()
            preview = dialog.get_by_test_id('skill-import-preview')
            await expect(preview).to_contain_text('Release checklist', timeout=15000)
            await expect(preview).to_contain_text('reference/steps.md')
            await expect(preview).to_contain_text('1 finding')
            assert not (project / '.arco' / 'skills').exists(), 'nothing is saved before IMPORT'
            await dialog.get_by_role('button', name='IMPORT', exact=True).click()
            await expect(page.get_by_text('Imported Release checklist.', exact=True)).to_be_visible(timeout=15000)
            skill = project / '.arco' / 'skills' / 'release-checklist'
            assert (skill / 'reference' / 'steps.md').exists()
            row = page.locator('[data-testid="skill-row"][data-skill="release-checklist"]')
            await expect(row.get_by_test_id('skill-contents')).to_contain_text('Also 1 file: reference/steps.md')
            await expect(row.get_by_test_id('skill-contents')).to_contain_text('Refers to release-notes, not installed.')

            # A built-in can be switched off and back on without deleting it.
            builtin = page.get_by_test_id('builtin-skill-row').filter(has_text='domain-modeling')
            await builtin.get_by_role('button', name='TURN OFF').click()
            await expect(builtin.get_by_role('button', name='TURN ON')).to_be_visible(timeout=15000)
            await builtin.get_by_role('button', name='TURN ON').click()
            await expect(builtin.get_by_role('button', name='TURN OFF')).to_be_visible(timeout=15000)

            # TURN OFF: shown greyed with OFF, left out of the composer SKILLS menu.
            await row.get_by_role('button', name='TURN OFF').click()
            await expect(row.get_by_text('OFF', exact=True)).to_be_visible(timeout=15000)
            assert json.loads((skill / '.arco-skill.json').read_text())['off'] is True
            await page.evaluate('''async (cwd) => {
              const React = (await import('/node_modules/.vite/deps/react.js')).default;
              const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
              const { TerminalInput } = await import('/src/components/TerminalInput.tsx');
              const { useAppStore: s } = await import('/src/stores/appStore.ts');
              s.getState().createJob('fixture', { name: 'Fixture', workingDirectory: cwd, primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', claudeTransport: 'native', skipPermissions: false });
              function View() { const job = s((x) => x.jobs.fixture); return React.createElement(TerminalInput, { job, onSend: () => true, onCancel: () => {}, onUpload: async () => ({}), onUpdatePrimary: () => {} }); }
              createRoot(document.getElementById('composer')).render(React.createElement(View));
            }''', str(project))
            composer = page.locator('#composer')
            await composer.get_by_role('button', name='SKILLS', exact=False).first.click()
            await expect(composer.get_by_role('button', name='IMPORT', exact=True)).to_be_visible()
            await expect(composer.get_by_text('A skill is reusable guidance', exact=False)).to_be_visible(timeout=15000)
            await page.keyboard.press('Escape')
            await row.get_by_role('button', name='TURN ON').click()
            await expect(row.get_by_text('OFF', exact=True)).to_have_count(0)

            # MOVE TO GLOBAL and back.
            await row.get_by_role('button', name='MOVE TO GLOBAL').click()
            await expect(page.get_by_text('Moved Release checklist to global skills.', exact=True)).to_be_visible(timeout=15000)
            assert not skill.exists() and (server.home / '.arco' / 'skills' / 'release-checklist' / 'reference' / 'steps.md').exists()
            assert 'global skills' in prompts[-1]
            await page.locator('[data-testid="skill-row"][data-skill="release-checklist"]').get_by_role('button', name='MOVE TO PROJECT').click()
            await expect(page.get_by_text('Moved Release checklist to project skills.', exact=True)).to_be_visible(timeout=15000)
            assert (skill / 'SKILL.md').exists()

            # SHARE WITH REPOSITORY: lists the files, then Git sees them.
            assert ignored(project, '.arco/skills/release-checklist/SKILL.md')
            await page.locator('[data-testid="skill-row"][data-skill="release-checklist"]').get_by_role('button', name='SHARE WITH REPOSITORY').click()
            share = page.get_by_role('dialog', name='Share skill with repository')
            await expect(share.get_by_test_id('skill-share-files')).to_contain_text('.arco/skills/release-checklist/reference/steps.md', timeout=15000)
            await share.get_by_role('button', name='SHARE', exact=True).click()
            await expect(page.get_by_text('Release checklist can now be committed with the project.', exact=True)).to_be_visible(timeout=15000)
            assert not ignored(project, '.arco/skills/release-checklist/SKILL.md')
            assert ignored(project, '.arco/workflows/x/events.jsonl')
            assert subprocess.check_output(['git', 'diff', '--cached', '--name-only'], cwd=project, env=GIT_ENV).strip() == b''
            assert not errors, errors
            await browser.close()
        print('PASS: IMPORT from a folder with review, TURN OFF in the SKILLS menu, MOVE and back, SHARE WITH REPOSITORY')
    finally:
        if vite:
            vite.terminate()
            try: vite.wait(timeout=10)
            except subprocess.TimeoutExpired: vite.kill(); vite.wait(timeout=5)
        server.close()
asyncio.run(main())
