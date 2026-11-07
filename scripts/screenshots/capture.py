#!/usr/bin/env python3
"""Capture README images from synthetic state. Run after npm run build.

Requires Python Playwright, Chromium, the cwebp tool, and Linux unprivileged network
namespaces. No provider calls or operator state are used.
"""
import asyncio
import hashlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]


def parse_version():
    # --version X.Y.Z sets the version the fixture reports; default is package.json.
    args = sys.argv[1:]
    if '--version' in args:
        index = args.index('--version')
        if index + 1 >= len(args):
            raise SystemExit('--version needs a value, for example --version 0.1.3')
        return args[index + 1]
    return json.loads((ROOT / 'package.json').read_text())['version']


VERSION = parse_version()
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'scripts' / 'smoke'))
import host_isolation  # noqa: E402

os.environ['ARCO_TEST_REQUIRE_NETNS'] = '1'
os.environ.pop('ARCO_TEST_NETNS', None)
host_isolation.enter_isolated_network()


def free_port():
    while True:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        if port != 3002:
            return port


def job(wid, name, text):
    return {'id': wid, 'currentSessionId': wid,
            'config': {'name': name, 'workingDirectory': '/projects/harbor', 'primaryProvider': 'claude', 'primaryModel': 'sonnet', 'primaryEffort': 'high'},
            'messages': [{'id': wid + '-user', 'role': 'user', 'content': 'Please coordinate the next release.', 'timestamp': 1793400000000, 'isStreaming': False},
                         {'id': wid + '-reply', 'role': 'assistant', 'content': text, 'timestamp': 1793400060000, 'isStreaming': False}],
            'workers': {}, 'reviews': [], 'research': [], 'handoffs': [], 'activity': [], 'sessionChat': [],
            'totalCost': 0, 'totalTokens': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheCreate': 0},
            'totalWorkers': 0, 'snapshotReceived': True}


def fixture_state(cluster_view):
    names = ['Director', 'Builder', 'Tester', 'Researcher']
    replies = ['The release plan is ready. Builder and Tester have the next tasks; I will review their results.',
               'The workspace changes are complete. The focused checks pass and the patch is ready for review.',
               'The browser checks cover the project list and the empty-state path. Both scenarios pass.',
               'The existing documentation identifies two setup steps that need clearer guidance.']
    jobs = {f'worker-{i}': job(f'worker-{i}', name, replies[i]) for i, name in enumerate(names)}
    jobs['worker-0']['messages'].insert(1, {'id': 'peer-msg', 'role': 'peer-received', 'content': 'The focused checks are green. Please review the patch.', 'senderWorkflowId': 'worker-1', 'senderDisplayName': 'Builder', 'timestamp': 1793400030000, 'isStreaming': False})
    members = [{'workflowId': f'worker-{i}', 'displayName': name, 'status': 'idle', 'role': name} for i, name in enumerate(names)]
    cluster = {'clusterId': 'demo-cluster', 'name': 'Release readiness', 'cwd': '/projects/harbor', 'createdAt': '2026-10-31T12:00:00Z', 'members': members, 'mailboxDepth': {}, 'taskBoardMode': 'cluster', 'taskBoardAttached': True, 'taskBoardKey': 'demo', 'progressTracking': 'both', 'efficiencyLevel': 'balanced'}
    return {'state': {'jobs': jobs, 'clusters': {'demo-cluster': cluster}, 'activeClusterId': 'demo-cluster' if cluster_view else None, 'activeJobId': None, 'showHome': not cluster_view, 'showCreator': False, 'clusterCardLayout': 'rows', 'clusterFocusedMember': {'demo-cluster': 'worker-0'}}, 'version': 0}


def api_data(path):
    roots = [{'name': 'Projects', 'path': '/projects', 'exists': True}]
    projects = [{'id': f'00000000-0000-4000-8000-{i:012}', 'name': name, 'path': f'/projects/{slug}', 'source': 'registered', 'exists': True, 'rootPath': '/projects', 'pinned': i == 1} for i, (name, slug) in enumerate([('Harbor', 'harbor'), ('Field notes', 'field-notes'), ('Studio', 'studio')], 1)]
    if path == '/api/settings':
        return {'themeId': 'phosphor:arco:electric', 'fontPackOverride': 'victor-mono-uniform', 'textBrightness': 30, 'uiScale': 1.1, 'projectRoots': roots, 'onboardingComplete': True, 'enabledProviders': {'claude': True, 'codex': False}, 'updateCheck': False}
    if path == '/api/auth-status':
        return {key: {'loggedIn': key == 'claude'} for key in ['claude', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'github']}
    if path == '/api/installation-history': return {'used': True}
    if path == '/api/projects': return {'roots': roots, 'projects': projects, 'organization': True, 'homeFolder': '/projects'}
    if path == '/api/sessions': return {'sessions': [{'sessionId': 'demo-session', 'name': 'Plan the next release', 'provider': 'claude', 'cwd': '/projects/harbor', 'startedAt': 1793400000000}]}
    if path == '/api/app/version': return {'version': VERSION}
    if path == '/api/update-check': return {'current': VERSION, 'latest': None, 'url': None, 'publishedAt': None, 'checkedAt': None, 'enabled': False, 'updateAvailable': False}
    if path.endswith('/catalog'): return {'models': []}
    if path == '/api/capabilities': return {'efforts': ['low', 'medium', 'high'], 'models': ['sonnet'], 'cliVersion': 'fixture'}
    return {'files': [], 'workflows': [], 'projects': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'sessions': [], 'chats': [], 'tasks': []}


def encode_webp(png_bytes, target):
    # Pillow cannot request full-resolution chroma, so encode with cwebp: lossy
    # quality 85 with sharp YUV keeps small coloured text and glows clean.
    cwebp = shutil.which('cwebp')
    if not cwebp:
        raise SystemExit('cwebp (libwebp tools) is required to encode README images.')
    with tempfile.TemporaryDirectory(prefix='arco-shot-') as tmp:
        source = Path(tmp) / 'shot.png'
        source.write_bytes(png_bytes)
        subprocess.run([cwebp, '-quiet', '-q', '85', '-sharp_yuv', '-m', '6', str(source), '-o', str(target)], check=True)


async def capture(base):
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        try:
            for name in ['home', 'cluster']:
                context = await browser.new_context(viewport={'width': 1920, 'height': 1080}, device_scale_factor=2)
                state = json.dumps(fixture_state(name == 'cluster'))
                tasks = [{'id': f'task-{i}', 'title': title, 'status': status, 'links': [], 'notes': '', 'priority': 50, 'parentIds': [], 'blockedReason': '', 'reviewRequired': False, 'goalMode': False, 'createdAt': 1793400000000, 'updatedAt': 1793400000000} for i, (title, status) in enumerate([('Review the release checklist', 'review'), ('Verify the project list', 'in_progress'), ('Update setup guidance', 'todo')], 1)]
                snapshot = json.dumps({'type': 'task_ledger_snapshot', 'workflowId': 'worker-0', 'cwd': '/projects/harbor', 'boardKey': 'demo', 'tasks': tasks})
                await context.add_init_script(f"""localStorage.setItem('arco-jobs', {json.dumps(state)}); localStorage.setItem('arco_ui_scale', '1.1');
                  localStorage.setItem('arco.clusterSidePanelTab.byCluster', JSON.stringify({{'demo-cluster':'board'}}));
                  class FixtureSocket {{
                    static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3;
                    constructor() {{ this.readyState=0; setTimeout(()=>{{ this.readyState=1; this.onopen?.(new Event('open')); this.onmessage?.({{data:JSON.stringify({{type:'connected',sessionId:'demo'}})}}); setTimeout(()=>{{ for (let i=0;i<4;i++) this.onmessage?.({{data:JSON.stringify({{type:'workflow_state_snapshot',workflowId:'worker-'+i,workers:{{}},busy:false,transcriptTail:[]}})}}); this.onmessage?.({{data:{json.dumps(snapshot)}}}); }}, 250); }}, 20); }}
                    send() {{}} close() {{this.readyState=3;}}
                  }}
                  window.WebSocket=FixtureSocket;
                """)
                async def route_request(route):
                    u = urlparse(route.request.url)
                    if u.netloc != urlparse(base).netloc:
                        await route.abort(); return
                    if u.path.startswith('/api/'):
                        await route.fulfill(json=api_data(u.path)); return
                    await route.continue_()
                await context.route('**/*', route_request)
                page = await context.new_page()
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e.stack)))
                await page.goto(base, wait_until='domcontentloaded')
                if name == 'home':
                    await page.locator('#home-title').wait_for(timeout=30000)
                else:
                    await page.get_by_text('Release readiness', exact=False).first.wait_for(timeout=30000)
                    await page.get_by_text('The release plan is ready.', exact=False).first.wait_for(timeout=30000)
                    await page.get_by_text('Update setup guidance', exact=False).first.wait_for(timeout=30000)
                    older = page.get_by_text('1 older', exact=False).first
                    if await older.is_visible():
                        await older.click()
                    await page.get_by_text('Review the release checklist', exact=False).first.wait_for(timeout=30000)
                try:
                    # Healthy connection is a light with aria-label Online (no ONLINE text label).
                    await page.get_by_label('Online', exact=True).first.wait_for(timeout=5000)
                except Exception as exc:
                    raise RuntimeError(f'Fixture failed to reach online state: {errors}; {await page.locator("body").inner_text()}') from exc
                await page.evaluate('document.fonts.ready')
                await page.wait_for_timeout(1200)
                if errors: raise RuntimeError('Browser errors: ' + '; '.join(errors))
                target = ROOT / 'docs' / 'images' / f'{name}.webp'
                screenshot = await page.screenshot(animations='disabled')
                encode_webp(screenshot, target)
                print(f'{target.name}: {target.stat().st_size} bytes; sha256 {hashlib.sha256(target.read_bytes()).hexdigest()}')
                await context.close()
        finally:
            await browser.close()


def main():
    if not (ROOT / 'client' / 'dist' / 'index.html').exists():
        raise SystemExit('Run npm run build first.')
    with tempfile.TemporaryDirectory(prefix='arco-readme-') as tmp:
        root = Path(tmp)
        home = root / 'home'; home.mkdir()
        for folder in ['harbor', 'field-notes', 'studio']:
            (root / 'projects' / folder).mkdir(parents=True)
        port = free_port()
        env = host_isolation.harden({'HOME': str(home), 'ARCO_HOME': str(home / '.arco'), 'TMPDIR': str(root), 'ARCO_PORT': str(port), 'ARCO_HOST': '127.0.0.1'}, root)
        env['ARCO_SERVE_CLIENT'] = '1'
        proc = subprocess.Popen(['node', 'scripts/start.mjs'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            base = f'http://127.0.0.1:{port}'
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                if proc.poll() is not None: raise RuntimeError('Capture server exited early.')
                try:
                    with urllib.request.urlopen(base + '/readyz', timeout=2) as response:
                        if response.status == 200: break
                except OSError: time.sleep(0.25)
            else: raise RuntimeError('Capture server did not become ready.')
            asyncio.run(capture(base))
        finally:
            try: os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: proc.wait(timeout=10)
            except subprocess.TimeoutExpired: os.killpg(proc.pid, signal.SIGKILL); proc.wait()
    print('Visually inspect each image for private content before updating its reviewed digest in scripts/public-audit.mjs.')


if __name__ == '__main__':
    main()
