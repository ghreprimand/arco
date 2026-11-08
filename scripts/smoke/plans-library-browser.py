"""Synthetic plans library: project groups, versions, search and completion."""
import asyncio
import os
import time
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults
from host_isolation import chrome_executable

install_navigation_defaults()
now = int(time.time() * 1000)
def plan(id, title, **kw):
    return {'id': id, 'title': title, 'createdAt': now, 'updatedAt': now, 'refCount': 0, 'attached': False, 'clusters': [], 'taskCount': 1, 'checkboxTotal': 0, 'checkboxDone': 0, **kw}
projects = [
    {'cwd': '/projects/one', 'name': 'One', 'plans': [plan('a', 'Draft', updatedAt=now-31*86400000), plan('b', ' draft ', attached=True, attachments=[{'workflowId':'w','workflowName':'Builder','attachedAt':now,'detachedAt':None}]), plan('c', 'Finished', checkboxTotal=1, checkboxDone=1)]},
    {'cwd': '/projects/two', 'name': 'Two', 'plans': [plan('d', 'Old', updatedAt=now-31*86400000)]},
]
async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        context = await browser.new_context()
        attached = []
        body_reads = []
        async def api(route):
            req = route.request
            path = urlparse(req.url).path
            if path in ('/api/plans/attach', '/api/explorer/plans/attach') and req.method == 'POST':
                attached.append((path, parse_qs(urlparse(req.url).query)))
                await route.fulfill(json={'ok': True}); return
            if path == '/api/explorer/plans/target':
                query = parse_qs(urlparse(req.url).query)
                await route.fulfill(json={'sameProject': query.get('path') == ['/projects/one']}); return
            if path == '/api/public-project/choice':
                await route.fulfill(json={'choice': True}); return
            if path == '/api/public-project/remote':
                await route.fulfill(json={'state': 'none'}); return
            if path == '/api/plans/body':
                body_reads.append(req.url)
                await route.fulfill(json={'plan': {**projects[0]['plans'][0], 'body':'# Draft\n\n### Phase\n- [ ] Task'}}); return
            if path == '/api/plans/refs':
                await route.fulfill(json={'refs': []}); return
            if path == '/api/explorer/plans':
                await route.fulfill(json={'projects': projects}); return
            if path == '/api/plans' and req.method == 'GET':
                query = parse_qs(urlparse(req.url).query)
                group = next((group for group in projects if group['cwd'] == query.get('path', [''])[0]), None)
                await route.fulfill(json={'plans': group['plans'] if group else []}); return
            if path == '/api/plans' and req.method == 'PATCH':
                id = parse_qs(urlparse(req.url).query)['planId'][0]
                target = next(x for group in projects for x in group['plans'] if x['id'] == id)
                target['completedAt'] = now
                await route.fulfill(json={'plan': {**target, 'body': ''}}); return
            await route.fulfill(json={'parent': '/projects', 'dirs': []})
        await context.route('**/api/**', api)
        page = await context.new_page()
        await page.goto('http://127.0.0.1:' + os.environ.get('ARCO_CLIENT_PORT', '5247') + '/?app=explorer&lens=plans&cwd=%2Fprojects%2Fone')
        one = page.get_by_role('button', name='▾ One', exact=False)
        await expect(one).to_be_visible()
        await expect(page.get_by_text('4 plans, 1 in use, 3 probably finished')).to_be_visible()
        await page.get_by_role('button', name='Draft - 2 versions').click()
        await expect(page.get_by_text('In use: Builder')).to_be_visible()
        await page.get_by_role('button', name='Draft', exact=False).last.click()
        await expect(page.get_by_role('button', name='ATTACH TO', exact=False)).to_have_count(0)
        await expect(page.get_by_test_id('plans-library-public-project')).to_be_checked()
        await page.get_by_role('button', name='INSERT GUARDRAILS', exact=True).click()
        assert '## Privacy and public safety' in (await page.locator('textarea').input_value())
        await expect(page.get_by_role('button', name='MARK DONE')).to_have_count(1)
        await page.get_by_role('button', name='Probably finished (1)').click()
        await page.get_by_role('button', name='MARK DONE').last.click()
        await expect(page.get_by_text('3 plans, 1 in use, 2 probably finished')).to_be_visible()
        await page.get_by_role('button', name='COMPLETED', exact=True).click()
        await expect(page.get_by_text('Finished', exact=True)).to_be_visible()
        await page.get_by_role('button', name='ACTIVE', exact=True).click()
        await page.get_by_role('button', name='▾ One', exact=False).click()
        await page.reload()
        await expect(page.get_by_role('button', name='▸ One', exact=False)).to_be_visible()
        await page.get_by_placeholder('Search plan or project…').fill('Old')
        await expect(page.get_by_text('Old', exact=True)).to_be_visible()
        await page.goto('http://127.0.0.1:' + os.environ.get('ARCO_CLIENT_PORT', '5247') + '/?app=explorer&lens=plans&cwd=%2Fprojects%2Fone&targetKind=cluster&targetId=cluster-1&targetName=Team&targetCwd=%2Fprojects%2Fone')
        await page.get_by_placeholder('Search plan or project…').fill('Old')
        await page.get_by_text('Old', exact=True).click()
        await expect(page.get_by_text('Belongs to another project', exact=True)).to_be_visible()
        await expect(page.get_by_role('button', name='ATTACH TO Team', exact=True)).to_have_count(0)
        await page.get_by_placeholder('Search plan or project…').fill('Draft')
        await page.get_by_role('button', name='Draft - 2 versions').click()
        await page.get_by_role('button', name='Draft', exact=False).last.click()
        await page.get_by_role('button', name='ATTACH TO Team', exact=True).click()
        await expect(page.get_by_text('Attached to Team.', exact=True)).to_be_visible()
        assert attached[-1][0] == '/api/explorer/plans/attach'
        assert attached[-1][1]['clusterId'] == ['cluster-1']
        assert attached[-1][1]['path'] == ['/projects/one']
        await page.goto('http://127.0.0.1:' + os.environ.get('ARCO_CLIENT_PORT', '5247') + '/?app=explorer&lens=plans&cwd=%2Fprojects%2Fone&targetKind=workflow&targetId=workflow-1&targetName=Tab&targetCwd=%2Fprojects%2Fone')
        await page.get_by_placeholder('Search plan or project…').fill('Draft')
        await page.get_by_role('button', name='Draft - 2 versions').click()
        await page.get_by_role('button', name='Draft', exact=False).last.click()
        await page.get_by_role('button', name='ATTACH TO Tab', exact=True).click()
        await expect(page.get_by_text('Attached to Tab.', exact=True)).to_be_visible()
        assert attached[-1][0] == '/api/plans/attach'
        assert attached[-1][1]['workflowId'] == ['workflow-1']
        before_chooser = len(body_reads)
        await page.evaluate('''async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {PlanChooser} = await import('/src/components/plans/PlanChooser.tsx');
          document.body.innerHTML = '<main id="chooser-fixture"></main>';
          window.chosenPlan = null;
          createRoot(document.getElementById('chooser-fixture')).render(React.createElement(PlanChooser, {
            cwd: '/projects/one', onAttach: p => { window.chosenPlan = p.id; },
            onNew: () => {}, onGenesis: () => {}, onAllPlans: () => {},
          }));
        }''')
        await expect(page.get_by_text('1 task').first).to_be_visible()
        assert len(body_reads) == before_chooser
        assert await page.get_by_test_id('plan-chooser-list').evaluate("e => getComputedStyle(e).overflowY === 'auto' && getComputedStyle(e).maxHeight !== 'none'")
        await expect(page.get_by_role('button', name='Show finished (1)')).to_be_visible()
        await page.get_by_role('button', name='Show finished (1)').click()
        await expect(page.get_by_role('button', name='Attach Finished', exact=True)).to_be_visible()
        await page.get_by_role('button', name='Preview Draft').first.click()
        await expect(page.locator('pre')).to_contain_text('- [ ] Task')
        await page.get_by_role('button', name='Attach Draft').first.click()
        assert await page.evaluate('window.chosenPlan') == 'a'
        await browser.close()
asyncio.run(main())
