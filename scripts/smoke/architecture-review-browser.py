"""Architecture review against an isolated synthetic project: RUN and EDITABLE
COPY in the SKILLS menu, the report's CANDIDATES in OUTPUTS, ADD TO PLAN and
RECORD DECISION. The turn itself (facts reaching the model) is covered by the
unit test server/src/ws/builtinSkillPick.test.ts with a fixture provider."""
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

HTML = '''<!doctype html><html><body><div id="fixture"></div><div id="outputs"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>'''

CANDIDATES = {'version': 1, 'recommendation': 'c1', 'candidates': [
    {'id': 'c1', 'title': 'One owner for turn boundaries', 'files': ['src/engine.ts'], 'problem': 'Two paths repeat the same steps.', 'proposal': 'One function both paths call.', 'benefits': {'locality': 'One place.', 'leverage': 'Less to learn.', 'tests': 'At the function.'}, 'strength': 'Strong'},
    {'id': 'c2', 'title': 'Split the settings panel', 'files': ['src/panel.tsx'], 'problem': 'Large.', 'proposal': 'Split by section.', 'benefits': {'locality': 'x', 'leverage': 'y', 'tests': 'z'}, 'strength': 'Speculative'},
]}

async def main():
    server = Server(f'http://127.0.0.1:{h.host_isolation.closed_port()}')
    project = server.projects / 'app'
    vite = None
    try:
        subprocess.run(['git', 'init', '-q', str(project)], check=True)
        (project / 'src').mkdir()
        (project / 'src' / 'engine.ts').write_text('export const a = 1;\n' * 40)
        conv = project / '.arco' / 'workflows' / 'conv-1'
        (conv / 'artifacts').mkdir(parents=True)
        (conv / 'artifacts' / 'architecture-review-2026-11-05.md').write_text('# Architecture review\n\nTwo candidates.\n')
        (conv / 'artifacts' / 'architecture-review-2026-11-05.json').write_text(json.dumps(CANDIDATES))
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
            await page.goto(server.base)
            await page.goto(base + '/fixture')
            await page.wait_for_function('window.fixtureReady === true')
            # The plan the conversation works from.
            plan = await page.evaluate('''async (cwd) => (await (await fetch('/api/plans?path=' + encodeURIComponent(cwd), {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title:'Release', body:'# Release\\n\\n### Phase 1\\n- [ ] Ship it\\n'})})).json()).plan''', str(project))
            (conv / 'meta.json').write_text(json.dumps({'name': 'Fixture', 'planId': plan['id']}))

            # SKILLS > BUILT-IN: RUN sends the builtin pick; EDITABLE COPY saves a skill.
            await page.evaluate('''async (cwd) => {
              const React = (await import('/node_modules/.vite/deps/react.js')).default;
              const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
              const { TerminalInput } = await import('/src/components/TerminalInput.tsx');
              const { useAppStore: s } = await import('/src/stores/appStore.ts');
              s.getState().createJob('conv-1', { name: 'Fixture', workingDirectory: cwd, primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', claudeTransport: 'native', skipPermissions: false });
              window.sent = [];
              function View() { const job = s((x) => x.jobs['conv-1']); return React.createElement(TerminalInput, { job, onSend: (...args) => { window.sent.push(args); return true; }, onCancel: () => {}, onUpload: async () => ({}), onUpdatePrimary: () => {} }); }
              createRoot(document.getElementById('fixture')).render(React.createElement(View));
            }''', str(project))
            skills = page.get_by_role('button', name='SKILLS', exact=False).first
            await skills.click()
            builtin = page.get_by_test_id('builtin-skills')
            await expect(builtin.get_by_text('Architecture review', exact=True)).to_be_visible(timeout=30000)
            # Several built-in skills are listed; act on the Architecture review row.
            review_row = builtin.locator(':scope > div').filter(has=page.get_by_text('Architecture review', exact=True))
            await expect(review_row).to_have_count(1)
            await review_row.get_by_role('button', name='EDITABLE COPY').click()
            await expect(builtin.get_by_text('Saved "Architecture review (copy)" to your project skills', exact=False)).to_be_visible(timeout=15000)
            copied = (project / '.arco' / 'skills' / 'architecture-review-copy' / 'SKILL.md').read_text()
            assert 'operator-only: true' in copied and 'Deletion test' in copied
            await review_row.get_by_role('button', name='RUN').click()
            sent = await page.evaluate('window.sent')
            assert sent == [['Run the Architecture review on this project.', None, None, None, [{'scope': 'builtin', 'slug': 'architecture-review'}]]], sent

            # OUTPUTS: CANDIDATES on the report, ADD TO PLAN and RECORD DECISION.
            await page.evaluate('''async (cwd) => {
              const React = (await import('/node_modules/.vite/deps/react.js')).default;
              const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
              const { OutputsPanel } = await import('/src/components/RightPanel/OutputsPanel.tsx');
              createRoot(document.getElementById('outputs')).render(React.createElement(OutputsPanel, { cwd, workflowId: 'conv-1' }));
            }''', str(project))
            await page.get_by_role('button', name='CANDIDATES').click()
            dialog = page.get_by_role('dialog', name='Architecture review candidates')
            await expect(dialog.get_by_test_id('architecture-review-plan')).to_contain_text('Plan: Release', timeout=15000)
            cards = dialog.get_by_test_id('architecture-candidate')
            await expect(cards).to_have_count(2)
            await expect(cards.nth(0)).to_contain_text('Strong · recommended')
            prompts = []
            async def accept(prompt):
                prompts.append(prompt.message); await prompt.accept()
            page.on('dialog', lambda prompt: asyncio.create_task(accept(prompt)))
            await cards.nth(0).get_by_role('button', name='ADD TO PLAN').click()
            await expect(dialog.get_by_text('Added "One owner for turn boundaries" to Release.', exact=True)).to_be_visible(timeout=15000)
            assert 'Release' in prompts[0]
            body = (project / '.arco' / 'plans' / f"{plan['id']}.md").read_text()
            assert body.endswith('### Architecture review\n- [ ] One owner for turn boundaries [Architecture](ref:arch-one-owner-for-turn-boundaries)\n'), body
            assert (project / '.arco' / 'plans' / f"{plan['id']}.refs" / 'arch-one-owner-for-turn-boundaries.md').exists()
            await expect(cards.nth(0).get_by_role('button', name='ADD TO PLAN')).to_be_disabled()
            await cards.nth(1).get_by_role('button', name='RECORD DECISION').click()
            record = cards.nth(1).get_by_role('button', name='RECORD', exact=True)
            await expect(record).to_be_disabled()
            await cards.nth(1).get_by_label('Reason for the decision').fill('The panel is replaced next release.')
            await record.click()
            await expect(dialog.get_by_text('Recorded the decision on "Split the settings panel"', exact=False)).to_be_visible(timeout=15000)
            decisions = (project / '.arco' / 'plans' / f"{plan['id']}.refs" / 'decisions.md').read_text()
            assert '## Not pursued: Split the settings panel' in decisions and 'The panel is replaced next release.' in decisions
            assert not errors, errors
            await browser.close()
        print('PASS: built-in RUN and EDITABLE COPY, CANDIDATES in OUTPUTS, ADD TO PLAN, RECORD DECISION')
    finally:
        if vite:
            vite.terminate()
            try: vite.wait(timeout=10)
            except subprocess.TimeoutExpired: vite.kill(); vite.wait(timeout=5)
        server.close()
asyncio.run(main())
