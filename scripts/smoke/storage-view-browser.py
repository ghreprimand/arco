"""STORAGE lens against an isolated real server and a synthetic home: sizes,
KEEP state, EMPTY SCRATCH, COMPRESS OLD LOGS, ARCHIVE, RESTORE, DELETE, the
storage settings and the disk budget notice. Every action needs a confirmation;
kept items and plans stay."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
spec = importlib.util.spec_from_file_location('storage_harness', Path(__file__).with_name('connections-browser.py'))
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)

class Server(h.IsolatedServer):
    def extra_settings(self):
        app = self.projects / 'app'
        state = app / '.arco'
        closed = state / 'workflows' / 'closed-0001'
        whole = state / 'workflows' / 'kept-0001'
        candidate = state / 'workflows' / 'candidate-0001'
        for d in (closed / 'artifacts', closed / 'scratch', whole / 'artifacts', candidate / 'artifacts', state / 'plans'):
            d.mkdir(parents=True, exist_ok=True)
        (state / 'plans' / 'p.md').write_text('# Plan\n')
        (closed / 'meta.json').write_text(json.dumps({'workflowId': 'closed-0001', 'name': 'Closed draft', 'cwd': str(app), 'cliSessions': []}))
        lines = [json.dumps({'seq': i, 'ts': i, 'type': 'primary_text', 'workflowId': 'closed-0001', 'text': f'line {i} ' * 40}) for i in range(1, 3001)]
        (closed / 'events.jsonl').write_text('\n'.join(lines) + '\n')
        (closed / 'artifacts' / 'report.md').write_text('report')
        (closed / 'artifacts' / 'keep.md').write_text('kept')
        (closed / 'scratch' / 'build.o').write_text('x' * 5000)
        (closed / 'keep.json').write_text(json.dumps({'version': 1, 'items': [{'path': 'artifacts/keep.md', 'reason': 'operator', 'at': 1}]}))
        (whole / 'meta.json').write_text(json.dumps({'workflowId': 'kept-0001', 'name': 'Kept study', 'cwd': str(app), 'cliSessions': []}))
        (whole / 'events.jsonl').write_text('{"seq":1,"type":"workflow_created"}\n')
        with open(whole / 'artifacts' / 'disk.img', 'wb') as f: f.truncate(2 * 1024 ** 3)  # sparse; logical size counts
        (whole / 'keep.json').write_text(json.dumps({'version': 1, 'items': [{'path': '.', 'reason': 'operator', 'at': 1}]}))
        (candidate / 'meta.json').write_text(json.dumps({'workflowId': 'candidate-0001', 'name': 'Candidate', 'cwd': str(app), 'cliSessions': []}))
        (candidate / 'events.jsonl').write_text('{"seq":1,"type":"workflow_created"}\n')
        self.app = app
        return {'projects': [str(app)], 'onboardingComplete': True}
    def extra_env(self): return {'ARCO_STORAGE_POLICY': '0'}

async def main():
    server = Server(f'http://127.0.0.1:{h.host_isolation.closed_port()}'); b = None
    app = server.projects / 'app'; closed = app / '.arco' / 'workflows' / 'closed-0001'
    try:
        async with async_playwright() as p:
            b = h.Browser(p, server); page = await b.open()
            answers = []
            async def on_dialog(d):
                answers.append(d.message)
                await (d.accept() if not answers[-1].startswith('Delete "Closed draft"') or len([a for a in answers if a.startswith('Delete "Closed draft"')]) > 1 else d.dismiss())
            page.on('dialog', lambda d: asyncio.ensure_future(on_dialog(d)))
            await page.goto(server.base + '/?app=explorer&lens=storage')
            await expect(page.get_by_text("Arco's folder", exact=False).first).to_be_visible(timeout=60000)
            project = page.get_by_role('button', name='▸ app', exact=False)
            await expect(project).to_be_visible()
            # The sparse 2 GiB image passes a 1 GiB budget.
            await page.get_by_text('STORAGE SETTINGS').click()
            budget = page.get_by_label('Disk budget in GiB'); await budget.fill('1'); await budget.blur()
            await page.get_by_label('Days closed before archiving').fill('45')
            auto = page.get_by_role('checkbox').first
            await auto.click(); await expect(auto).to_be_checked()
            await page.get_by_role('button', name='MEASURE AGAIN').click()
            await expect(page.get_by_role('alert').filter(has_text='over the disk budget')).to_be_visible(timeout=60000)
            policy = json.loads((server.home / '.arco' / 'storage-policy.json').read_text())
            assert policy['budgetGiB'] == 1 and policy['autoArchiveClosedDays'] == 45, policy
            await auto.click(); await expect(auto).not_to_be_checked()
            await project.click()
            await expect(page.get_by_text('Closed draft')).to_be_visible()
            await expect(page.get_by_text('1 kept item')).to_be_visible()
            await expect(page.get_by_text('Kept', exact=True)).to_be_visible()
            await expect(page.get_by_role('button', name='ARCHIVE Kept study')).to_be_disabled()
            candidate_row = page.locator('div').filter(has=page.get_by_text('Candidate', exact=True)).filter(has=page.get_by_role('button', name='ARCHIVE Candidate')).last
            await candidate_row.get_by_role('button', name='KEEP', exact=True).click()
            await expect(page.get_by_role('status')).to_contain_text('Kept "Candidate"')
            await expect(page.get_by_role('button', name='ARCHIVE Candidate')).to_be_disabled()
            await expect(candidate_row.get_by_text('Kept', exact=True)).to_be_visible()
            assert json.loads((app / '.arco' / 'workflows' / 'candidate-0001' / 'keep.json').read_text())['items'][0]['path'] == '.'
            # UNKEEP undoes it after a confirmation; no file changes.
            await page.get_by_role('button', name='UNKEEP Candidate').click()
            await expect(page.get_by_role('status')).to_contain_text('"Candidate" is no longer kept')
            await expect(page.get_by_role('button', name='ARCHIVE Candidate')).to_be_enabled()
            assert json.loads((app / '.arco' / 'workflows' / 'candidate-0001' / 'keep.json').read_text())['items'] == []
            await expect(page.get_by_role('button', name='UNKEEP Candidate')).to_have_count(0)
            # A dismissed confirmation changes nothing.
            await page.get_by_role('button', name='DELETE Closed draft').click()
            await page.wait_for_timeout(500)
            assert (closed / 'meta.json').exists()
            await page.get_by_role('button', name='EMPTY SCRATCH of Closed draft').click()
            await expect(page.get_by_role('status')).to_contain_text('Emptied scratch of "Closed draft"')
            assert not (closed / 'scratch' / 'build.o').exists()
            await page.get_by_role('button', name='COMPRESS OLD LOGS in app').click()
            await expect(page.get_by_role('status')).to_contain_text('Compressed 1 logs in app')
            assert any(n.endswith('.jsonl.br') for n in os.listdir(closed))
            await page.get_by_role('button', name='ARCHIVE Closed draft').click()
            await expect(page.get_by_role('status')).to_contain_text('Archived "Closed draft"')
            await expect(page.get_by_role('button', name='RESTORE closed-0')).to_be_visible()
            assert (closed / 'artifacts' / 'keep.md').read_text() == 'kept' and (closed / 'keep.json').exists()
            assert not (closed / 'meta.json').exists()
            await page.get_by_role('button', name='RESTORE closed-0').click()
            await expect(page.get_by_role('status')).to_contain_text('Restored')
            assert (closed / 'meta.json').exists() and (closed / 'artifacts' / 'report.md').read_text() == 'report'
            await expect(page.get_by_role('button', name='DELETE Closed draft')).to_be_visible()
            await page.get_by_role('button', name='DELETE Closed draft').click()
            await expect(page.get_by_role('status')).to_contain_text('Deleted "Closed draft"')
            assert not (closed / 'meta.json').exists()
            assert (closed / 'artifacts' / 'keep.md').read_text() == 'kept'
            assert (app / '.arco' / 'plans' / 'p.md').read_text() == '# Plan\n'
            actions = [json.loads(l)['action'] for l in (app / '.arco' / 'storage-actions.jsonl').read_text().splitlines()]
            assert actions == ['empty_scratch', 'compress_logs', 'archive', 'restore', 'delete'], actions
            assert len(answers) == 8, answers
            assert not b.errors, b.errors
            await b.close(); b = None
            print('PASS: STORAGE lens on a synthetic home: sizes, budget notice, settings, KEEP and UNKEEP, every action confirmed and logged, kept items and plans intact.')
    finally:
        if b: await b.close()
        server.close()

asyncio.run(main())
