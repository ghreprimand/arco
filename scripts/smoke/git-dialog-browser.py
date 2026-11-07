"""Exercise the composer GIT dialog against a synthetic repo and local remote.

The browser sees real branch/status data and branch checkout is performed by
Git in the temporary repo. Prompt dispatch is captured at the dialog boundary;
no provider is invoked.
"""
import asyncio
import json
import os
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright, expect

from browser_navigation import install_navigation_defaults
from host_isolation import chrome_executable

install_navigation_defaults()
PORT = os.environ.get('ARCO_CLIENT_PORT', '5233')
ORIGIN = f'http://127.0.0.1:{PORT}'
HTML = '''<!doctype html><html><head>
<link rel="stylesheet" href="/src/styles/global.css">
<link rel="stylesheet" href="/src/styles/matrix.css">
</head><body><div id="fixture"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{};
window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
window.fixtureReady=true;</script></body></html>'''


def git(cwd: Path, *args: str, check=True) -> str:
    result = subprocess.run(['git', *args], cwd=cwd, text=True, capture_output=True)
    if check and result.returncode:
        raise AssertionError(f'git {" ".join(args)} failed: {result.stderr}')
    return result.stdout.strip()


def make_repo(root: Path):
    bare = root / 'remote.git'
    repo = root / 'project'
    writer = root / 'writer'
    git(root, 'init', '--bare', '--initial-branch=main', str(bare))
    git(root, 'clone', str(bare), str(repo))
    git(repo, 'config', 'user.name', 'Arco Browser Fixture')
    git(repo, 'config', 'user.email', 'fixture@example.invalid')
    (repo / 'base.txt').write_text('base\n')
    git(repo, 'add', 'base.txt')
    git(repo, 'commit', '-m', 'base')
    git(repo, 'push', '-u', 'origin', 'main')
    git(repo, 'remote', 'set-head', 'origin', 'main')

    git(root, 'clone', str(bare), str(writer))
    git(writer, 'config', 'user.name', 'Arco Browser Fixture')
    git(writer, 'config', 'user.email', 'fixture@example.invalid')
    (writer / 'remote-only.txt').write_text('remote change\n')
    git(writer, 'add', 'remote-only.txt')
    git(writer, 'commit', '-m', 'remote change')
    git(writer, 'push', 'origin', 'main')

    git(repo, 'fetch', 'origin')
    (repo / 'local-only.txt').write_text('local commit\n')
    git(repo, 'add', 'local-only.txt')
    git(repo, 'commit', '-m', 'local commit')
    (repo / 'dirty.txt').write_text('unstaged change\n')
    (repo / 'staged.txt').write_text('staged change\n')
    git(repo, 'add', 'staged.txt')
    return repo


def name_files(cwd: Path, *args: str):
    raw = git(cwd, *args, check=False)
    return [{'path': p, 'status': 'M'} for p in raw.splitlines() if p]


def status_for(cwd: Path):
    branch = git(cwd, 'branch', '--show-current') or None
    upstream = git(cwd, 'rev-parse', '--abbrev-ref', '@{upstream}', check=False) or None
    ahead = behind = 0
    to_push = to_pull = []
    if upstream:
        counts = git(cwd, 'rev-list', '--left-right', '--count', f'{upstream}...HEAD').split()
        behind, ahead = map(int, counts)
        to_push = name_files(cwd, 'diff', '--name-only', f'{upstream}...HEAD')
        to_pull = name_files(cwd, 'diff', '--name-only', f'HEAD...{upstream}')

    staged, dirty = [], []
    porcelain = subprocess.run(
        ['git', 'status', '--porcelain=v1', '-z'], cwd=cwd, text=True, capture_output=True, check=True,
    ).stdout
    for record in porcelain.split('\0'):
        if not record:
            continue
        xy, path = record[:2], record[3:]
        item = {'path': path, 'status': xy.strip() or '?'}
        if xy[0] not in (' ', '?'):
            staged.append(item)
        if xy[1] not in (' ', '?') or xy == '??':
            dirty.append(item)
    branches = []
    for line in git(cwd, 'for-each-ref', '--format=%(refname:short)%09%(upstream:short)', 'refs/heads/').splitlines():
        name, _, branch_upstream = line.partition('\t')
        branches.append({'name': name, 'hasUpstream': bool(branch_upstream), 'upstream': branch_upstream or None, 'isCurrent': name == branch})
    branches.sort(key=lambda b: (not b['isCurrent'], b['name']))
    remotes = [{'name': 'origin', 'url': git(cwd, 'remote', 'get-url', 'origin'), 'isGitHub': False}]
    return {
        'isRepo': True, 'currentBranch': branch, 'upstream': upstream,
        'ahead': ahead, 'behind': behind, 'dirtyCount': len(dirty), 'stagedCount': len(staged),
        'toPushFiles': to_push, 'toPullFiles': to_pull, 'dirtyFiles': dirty, 'stagedFiles': staged,
        'branches': branches, 'remotes': remotes, 'hasGitHubRemote': False, 'defaultBranch': 'main',
    }


async def main():
    with tempfile.TemporaryDirectory(prefix='arco-git-dialog-') as temp:
        repo = make_repo(Path(temp))
        dispatches, checkouts = [], []
        async with async_playwright() as p:
            browser = await p.chromium.launch(executable_path=chrome_executable() or None)
            context = await browser.new_context(viewport={'width': 1280, 'height': 900})

            async def api(route):
                request = route.request
                parsed = urlparse(request.url)
                if parsed.path == '/fixture':
                    await route.fulfill(content_type='text/html', body=HTML)
                    return
                if parsed.path == '/api/git/status':
                    await route.fulfill(json=status_for(repo))
                    return
                if parsed.path == '/api/git/checkout':
                    payload = request.post_data_json
                    checkouts.append(payload)
                    branch = payload['branch']
                    if payload.get('create'):
                        result = subprocess.run(
                            ['git', 'switch', '-c', branch, payload['create']['fromBranch']],
                            cwd=repo, text=True, capture_output=True,
                        )
                    else:
                        result = subprocess.run(['git', 'switch', branch], cwd=repo, text=True, capture_output=True)
                    await route.fulfill(json={'ok': result.returncode == 0, **({'error': result.stderr} if result.returncode else {})})
                    return
                if parsed.path.endswith('/catalog'):
                    await route.fulfill(json={'models': []})
                    return
                if parsed.path == '/api/utility-agent/providers':
                    await route.fulfill(json={'providers': []})
                    return
                if parsed.path.startswith('/api/'):
                    await route.fulfill(json={})
                    return
                await route.continue_()

            await context.route('**/api/**', api)
            await context.route('**/fixture', api)
            await context.route('https://**/*', lambda route: route.abort())
            page = await context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.goto(ORIGIN + '/fixture')
            await page.wait_for_function('window.fixtureReady')
            await page.evaluate('''async cwd => {
              const React = (await import('/node_modules/.vite/deps/react.js')).default;
              const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
              const {GitDialog} = await import('/src/components/GitDialog.tsx');
              const {useAppStore:s} = await import('/src/stores/appStore.ts');
              s.setState({settings:{...s.getState().settings,enabledProviders:{claude:true,codex:true}},
                authStatus:{claude:{loggedIn:true},codex:{loggedIn:true}}});
              const host=document.getElementById('fixture'); const root=createRoot(host); let key=0;
              window.dispatches=[]; window.cancelCount=0;
              const config={kind:'workflow',name:'Synthetic',workingDirectory:cwd,primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'medium',skipPermissions:false};
              window.mountDialog=()=>root.render(React.createElement(GitDialog,{key:++key,cwd,wfid:'git-dialog-fixture',parentConfig:config,
                onConfirm:prompt=>window.dispatches.push({kind:'same-tab',prompt}),
                onSpawn:(newConfig,prompt,includePlan)=>window.dispatches.push({kind:'new-tab',newConfig,prompt,includePlan}),
                onCancel:()=>{window.cancelCount++;root.render(null)}}));
              window.testRoot=root; window.mountDialog();
            }''', str(repo))

            await expect(page.get_by_text('main', exact=True).first).to_be_visible()
            await expect(page.get_by_text('↑ 1 · ↓ 1 vs origin/main', exact=True)).to_be_visible()
            await expect(page.get_by_text('1 local commit not on origin/main', exact=True)).to_be_visible()
            await expect(page.get_by_text('1 remote commit not local', exact=True)).to_be_visible()
            await expect(page.get_by_text('local-only.txt', exact=True)).to_be_visible()
            await expect(page.get_by_text('remote-only.txt', exact=True)).to_be_visible()
            await expect(page.get_by_text('2 project files dirty', exact=True)).to_be_visible()
            await expect(page.get_by_text('dirty.txt', exact=True)).to_be_visible()
            await expect(page.get_by_text('staged.txt', exact=True)).to_be_visible()
            await expect(page.get_by_text('Target branch looks protected (main).', exact=False)).to_be_visible()

            # Branch checkout rejects dirty working trees. Clean the fixture,
            # remount so the dialog reads a fresh status, and exercise the real
            # local Git switch through the intercepted checkout API.
            git(repo, 'reset', '--hard', 'HEAD')
            git(repo, 'clean', '-fd')
            await page.evaluate('mountDialog()')
            await expect(page.get_by_role('button', name='+ NEW BRANCH', exact=True)).to_be_visible()
            await page.get_by_role('button', name='+ NEW BRANCH', exact=True).click()
            await page.get_by_placeholder('new-branch-name').fill('feature/dialog-check')
            await page.get_by_role('button', name='CONTINUE', exact=True).click()
            # The intercepted checkout and subsequent dispatch can take longer
            # than a fixed delay on loaded CI runners. Dispatch is emitted only
            # after the checkout response has been handled.
            await page.wait_for_function('window.dispatches.length === 1')
            assert git(repo, 'branch', '--show-current') == 'feature/dialog-check', {
                'checkouts': checkouts, 'dispatches': await page.evaluate('window.dispatches'),
                'body': (await page.locator('body').inner_text())[-1800:],
            }
            assert checkouts == [{'path': str(repo), 'branch': 'feature/dialog-check', 'create': {'fromBranch': 'main'}}], checkouts
            dispatches = await page.evaluate('window.dispatches')
            same = dispatches[0]
            assert same['kind'] == 'same-tab', same
            assert '**Branch:** `feature/dialog-check`' in same['prompt'], same['prompt']
            assert '**Branch context:** Just created from `main`: fresh branch, no upstream yet.' in same['prompt'], same['prompt']
            assert '**Action:** commit + push' in same['prompt'], same['prompt']
            assert 'git push -u origin feature/dialog-check' in same['prompt'], same['prompt']
            assert 'Push to `origin/main`' not in same['prompt'], same['prompt']
            assert '**Process:**' in same['prompt'] and 'git status' in same['prompt'], same['prompt']

            # Selecting a different provider dispatches the same structured
            # prompt to a new tab, leaving the current primary unchanged.
            await page.evaluate('mountDialog()')
            await page.get_by_role('button', name='CODEX', exact=True).click()
            await expect(page.get_by_role('button', name='CONTINUE (NEW TAB)', exact=True)).to_be_visible()
            await page.get_by_role('button', name='CONTINUE (NEW TAB)', exact=True).click()
            await page.wait_for_function('window.dispatches.length === 2')
            dispatches = await page.evaluate('window.dispatches')
            spawned = dispatches[1]
            assert spawned['kind'] == 'new-tab', spawned
            assert spawned['newConfig']['primaryProvider'] == 'codex', spawned
            assert spawned['includePlan'] is False, spawned
            assert '**Branch:** `feature/dialog-check`' in spawned['prompt'], spawned['prompt']
            assert '**Branch context:** No upstream tracking branch yet.' in spawned['prompt'], spawned['prompt']

            # A dialog closed without sending reopens as it was: notes, action,
            # SHOW OTHER WORK and scroll position, until a request is sent.
            before_cancel_count = await page.evaluate('window.cancelCount')
            await page.evaluate('testRoot.render(null)')
            await expect(page.get_by_role('button', name='CANCEL', exact=True)).to_have_count(0)
            await page.evaluate('mountDialog()')
            await expect(page.get_by_role('button', name='SHOW OTHER WORK', exact=True)).to_be_visible()
            await page.get_by_placeholder('e.g. fix categoryId race in transaction insert').fill('Keep this subject')
            await page.get_by_placeholder('e.g. exclude lockfile changes; only commit the auth/ directory').fill('Only src/')
            await page.get_by_role('button', name='SHOW OTHER WORK', exact=True).click()
            await expect(page.get_by_role('button', name='HIDE OTHER WORK', exact=True)).to_have_attribute('aria-expanded', 'true')
            await page.locator('[data-help="composer.git"]').evaluate('(el) => { el.scrollTop = 40; }')
            await page.wait_for_timeout(100)
            await page.get_by_role('button', name='CANCEL', exact=True).last.click()
            await expect(page.get_by_role('button', name='CANCEL', exact=True)).to_have_count(0)
            await page.evaluate('mountDialog()')
            await expect(page.get_by_placeholder('e.g. fix categoryId race in transaction insert')).to_have_value('Keep this subject')
            await expect(page.get_by_placeholder('e.g. exclude lockfile changes; only commit the auth/ directory')).to_have_value('Only src/')
            await expect(page.get_by_role('button', name='HIDE OTHER WORK', exact=True)).to_have_attribute('aria-expanded', 'true')
            assert await page.locator('[data-help="composer.git"]').evaluate('(el) => el.scrollHeight <= el.clientHeight || el.scrollTop > 0')
            await page.get_by_role('button', name='CONTINUE (NEW TAB)', exact=True).or_(page.get_by_role('button', name='CONTINUE', exact=True)).first.click()
            await page.wait_for_function('window.dispatches.length === 3')
            await page.evaluate('testRoot.render(null)')
            await page.evaluate('mountDialog()')
            await expect(page.get_by_placeholder('e.g. fix categoryId race in transaction insert')).to_have_value('')
            await expect(page.get_by_role('button', name='SHOW OTHER WORK', exact=True)).to_have_attribute('aria-expanded', 'false')
            await page.get_by_role('button', name='CANCEL', exact=True).last.click()
            await page.wait_for_function(f'cancelCount === {before_cancel_count + 2}')
            dispatches = await page.evaluate('window.dispatches')
            before_dispatches = len(dispatches)

            # Explicit cancel and backdrop click close without dispatching or
            # invoking checkout.
            before_dispatches, before_checkouts = len(dispatches), len(checkouts)
            await page.evaluate('mountDialog()')
            await page.get_by_role('button', name='CANCEL', exact=True).last.click()
            await page.wait_for_function(f'cancelCount === {before_cancel_count + 3}')
            await expect(page.get_by_role('button', name='CANCEL', exact=True)).to_have_count(0)
            assert len(dispatches) == before_dispatches and len(checkouts) == before_checkouts
            await page.evaluate('mountDialog()')
            await expect(page.get_by_role('button', name='CANCEL', exact=True)).to_have_count(1)
            await page.locator('[data-help="composer.git"]').evaluate('(el) => el.click()')
            await page.wait_for_function(f'cancelCount === {before_cancel_count + 4}')
            assert len(dispatches) == before_dispatches and len(checkouts) == before_checkouts
            assert not errors, errors
            await context.close()
            await browser.close()
            print('PASS: real ahead/behind and dirty status, protected main warning, new branch checkout, same-tab and RUN AS dispatch, Cancel/backdrop safety')


asyncio.run(main())
