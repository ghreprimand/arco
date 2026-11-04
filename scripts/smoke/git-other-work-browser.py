"""GIT dialog Other work: rows, tab match, counts, quiet missing gh, VIEW CHANGES hand-off."""
import asyncio
import json
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

RESPONSE = {'isRepo': True, 'defaultBranch': 'main', 'prStatus': 'ok', 'truncated': False, 'rows': [
    {'branch': 'feature/x', 'worktreePath': '/work/wt-x', 'isMain': False, 'ahead': 3, 'behind': 1, 'dirtyCount': 2, 'pr': {'number': 12, 'url': 'https://example.test/pr/12', 'title': 'Add x'}},
    {'branch': 'old-idea', 'worktreePath': None, 'isMain': False, 'ahead': 0, 'behind': 7, 'dirtyCount': None, 'pr': None},
    {'branch': None, 'worktreePath': '/work/detached', 'isMain': False, 'ahead': None, 'behind': None, 'dirtyCount': 0, 'pr': None},
]}

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1200, 'height': 900})
        blocked, errors, fetched = [], [], []
        mode = {'kind': 'ok'}
        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'https' and url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(status=200, content_type='text/css', body='')
                return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and route.request.method == 'GET':
                if url.path == '/api/git/other-work':
                    fetched.append(url.query)
                    if mode['kind'] == 'fail':
                        await route.fulfill(status=500, json={'error': 'boom'})
                    elif mode['kind'] == 'nogh':
                        await route.fulfill(json={**RESPONSE, 'prStatus': 'unavailable', 'rows': [{**r, 'pr': None} for r in RESPONSE['rows']]})
                    else:
                        await route.fulfill(json=RESPONSE)
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
        async def mount():
            await page.evaluate('''async () => {
              const React = (await import('/node_modules/.vite/deps/react.js')).default;
              const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
              const {GitOtherWork} = await import('/src/components/GitOtherWork.tsx');
              const nav = await import('/src/utils/worktreeNavigation.ts');
              const {useAppStore:s} = await import('/src/stores/appStore.ts');
              window.viewed = 0; window.selected = [];
              s.getState().createJob('wf-a',{name:'Alpha',workingDirectory:'/work/main',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',skipPermissions:false});
              s.getState().createJob('wf-b',{name:'Beta',workingDirectory:'/work/wt-x',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',skipPermissions:false});
              s.setState({taskLedger: {'/work/main': [{id:'t1', assignee:'wf-a', status:'in_progress', worktree:{path:'/work/detached'}}]}});
              function Probe() { nav.useRequestedWorktree('wf-a', ['/work/main','/work/wt-x'], p => window.selected.push(p)); return null; }
              function Nav() { nav.useWorktreeNavigation(['wf-a'], () => { window.navigated = (window.navigated || 0) + 1; }); return null; }
              createRoot(document.getElementById('fixture')).render(React.createElement('div', null,
                React.createElement(GitOtherWork, {cwd:'/work/main', wfid:'wf-a', onViewed:() => { window.viewed++; }}),
                React.createElement(Probe), React.createElement(Nav)));
            }''')
        await mount()
        section = page.get_by_test_id('git-other-work')
        assert not fetched, 'nothing is read until the section is opened'
        await section.get_by_role('button', name='SHOW OTHER WORK').click()
        rows = section.get_by_test_id('git-other-work-row')
        await expect(rows).to_have_count(3)
        first = rows.nth(0)
        await expect(first).to_contain_text('feature/x')
        await expect(first).to_contain_text('tab: Beta')
        await expect(first).to_contain_text('3 ahead, 1 behind main')
        await expect(first).to_contain_text('2 uncommitted')
        await expect(first.get_by_role('link', name='PR #12')).to_be_visible()
        second = rows.nth(1)
        await expect(second).to_contain_text('old-idea')
        await expect(second).to_contain_text('branch only')
        await expect(second).to_contain_text('0 ahead, 7 behind main')
        await expect(second.get_by_role('button', name='VIEW CHANGES')).to_have_count(0)
        third = rows.nth(2)
        await expect(third).to_contain_text('(detached)')
        await expect(third).to_contain_text('tab: Alpha')
        # Read-only: the only action is VIEW CHANGES.
        names = await section.get_by_role('button').all_inner_texts()
        assert sorted(n for n in names if n != 'HIDE OTHER WORK') == ['VIEW CHANGES', 'VIEW CHANGES'], names
        # VIEW CHANGES hands the worktree to the FILES picker and closes the dialog.
        await first.get_by_role('button', name='VIEW CHANGES').click()
        await page.wait_for_function('window.selected.length === 1')
        assert await page.evaluate('selected') == ['/work/wt-x']
        assert await page.evaluate('viewed') == 1 and await page.evaluate('navigated') >= 1

        # Missing gh: pull requests are absent with a quiet note, no error.
        mode['kind'] = 'nogh'
        await page.reload()
        await page.wait_for_function('window.fixtureReady === true', timeout=10000)
        await mount()
        section = page.get_by_test_id('git-other-work')
        await section.get_by_role('button', name='SHOW OTHER WORK').click()
        await expect(section.get_by_test_id('git-other-work-row')).to_have_count(3)
        await expect(section).to_contain_text('Open pull requests are not shown')
        await expect(section.get_by_role('link')).to_have_count(0)
        mode['kind'] = 'fail'
        await page.reload()
        await page.wait_for_function('window.fixtureReady === true', timeout=10000)
        await mount()
        section = page.get_by_test_id('git-other-work')
        await section.get_by_role('button', name='SHOW OTHER WORK').click()
        await expect(section).to_contain_text('Other work could not be read.')
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: Other work lists worktrees and branches with tab, counts and PR, stays read-only, VIEW CHANGES targets the FILES picker, loads only when opened')

asyncio.run(main())
