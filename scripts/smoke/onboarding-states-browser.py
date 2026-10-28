"""Fresh-install vs returning-operator startup acceptance in a real browser.

Starts the Arco server from this checkout against throwaway HOME/project
directories (provider CLIs replaced by denying stubs and the whole run inside an empty network namespace - see host_isolation.py; no credentials, no model calls), then
loads the built client (client/dist; run `npm run build` first) in Chromium:

  fresh      empty installation, no provider        -> first-run setup screen
  registered project registered AND used before,
             all tabs closed, no provider           -> workspace + outage banner
             Retry after a provider connects        -> banner removed
             reload after the provider disconnects  -> banner restored, no setup
  scanned    project found by the scan folder AND
             used before, all tabs closed           -> workspace + outage banner

A returning operator must never be locked behind first-run setup because a
provider is signed out. Env: ARCO_TEST_CHROME (optional browser binary).
"""
import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright, expect

sys.path.insert(0, str(Path(__file__).resolve().parent))
import host_isolation  # noqa: E402

host_isolation.enter_isolated_network()

REPO = Path(__file__).resolve().parents[2]
SETUP_TEXT = 'Welcome to Arco'
BANNER_TEXT = 'No AI provider is connected.'


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class IsolatedServer:
    def __init__(self, seed):
        self.root = Path(tempfile.mkdtemp(prefix='arco-onboarding-'))
        self.home = self.root / 'home'
        self.tmp = self.root / 'tmp'
        self.projects = self.root / 'projects'
        for d in (self.home / '.arco', self.tmp, self.projects):
            d.mkdir(parents=True)
        seed(self)
        self.port = free_port()
        self.base = f'http://127.0.0.1:{self.port}'
        env = {
            'HOME': str(self.home), 'TMPDIR': str(self.tmp),
            'PATH': f'{Path(sys.executable).parent}:{os.path.dirname(shutil.which("node"))}:/usr/bin:/bin',
            'ARCO_PORT': str(self.port), 'ARCO_HOST': '127.0.0.1',
            'ARCO_UPLOADS_DIR': str(self.root / 'uploads'),
        }
        env = host_isolation.harden(env, self.root)
        env['ARCO_SERVE_CLIENT'] = '1'
        self.proc = subprocess.Popen(
            ['node', '--conditions', 'development', '--import', 'tsx', 'server/src/index.ts'],
            cwd=REPO, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def wait_ready(self):
        deadline = time.time() + 90
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError('isolated server exited early')
            try:
                with urllib.request.urlopen(f'{self.base}/readyz', timeout=2) as r:
                    if r.status == 200:
                        return
            except Exception:
                time.sleep(0.3)
        raise RuntimeError('isolated server never became ready')

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        shutil.rmtree(self.root, ignore_errors=True)


def write_json(path, value):
    path.write_text(json.dumps(value))


def base_settings(server, **extra):
    # The server probes localhost for local runtimes (Ollama, llama.cpp). Point
    # them at a closed port / disable them so a runtime on the machine running
    # this test cannot count as a connected provider.
    dead = f'http://127.0.0.1:{free_port()}'
    settings = {'ollama': {'baseUrl': dead}, 'enabledProviders': {'llamacpp': False}}
    settings.update(extra)
    write_json(server.home / '.arco' / 'settings.json', settings)


def seed_fresh(server):
    base_settings(server)


def seed_registered(server):
    project = server.projects / 'registered-app'
    project.mkdir()
    base_settings(server, projects=[str(project)])
    # A workflow ran here before; its tab was closed.
    write_json(server.home / '.arco' / 'known-cwds.json', [str(project)])


def seed_scanned(server):
    project = server.projects / 'scanned-app'
    project.mkdir()
    base_settings(server, defaultWorkingDirectory=str(server.projects))
    write_json(server.home / '.arco' / 'known-cwds.json', [str(project)])


async def visit(server, expect_setup, label):
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        context = await browser.new_context()
        base_host = urlparse(server.base).netloc

        async def local_only(route):
            if urlparse(route.request.url).netloc == base_host:
                await route.continue_()
            else:
                await route.abort()
        await context.route('http**://**/*', local_only)
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(server.base)
        # Release checks stay offline, including an explicit CHECK NOW request.
        release_status = await page.evaluate("async () => (await fetch('/api/update-check')).json()")
        assert release_status['enabled'] is False and release_status['checkedAt'] is None
        forced = await page.evaluate("async () => (await fetch('/api/update-check', {method: 'POST'})).json()")
        assert forced == release_status
        try:
            if expect_setup:
                await page.get_by_text(SETUP_TEXT, exact=True).wait_for(timeout=20000)
                assert await page.get_by_text(BANNER_TEXT, exact=True).count() == 0
            else:
                await page.get_by_text(BANNER_TEXT, exact=True).wait_for(timeout=20000)
                # Give a late projects response a chance to flip the gate wrongly.
                await page.wait_for_timeout(1500)
                assert await page.get_by_text(SETUP_TEXT, exact=True).count() == 0, 'returning operator was shown first-run setup'
                if label == 'registered':
                    # Retry must apply a newly connected provider, and a later
                    # outage must restore the warning without reopening setup.
                    status = await (await context.request.get(server.base + '/api/auth-status')).json()
                    status['ollama']['loggedIn'] = True

                    async def provider_status(route):
                        await route.fulfill(json=status)

                    await context.route('**/api/auth-status', provider_status)
                    await page.get_by_role('button', name='RETRY', exact=True).click()
                    await expect(page.get_by_text(BANNER_TEXT, exact=True)).to_have_count(0)
                    status['ollama']['loggedIn'] = False
                    await page.reload()
                    await page.get_by_text(BANNER_TEXT, exact=True).wait_for(timeout=20000)
                    assert await page.get_by_text(SETUP_TEXT, exact=True).count() == 0
        except Exception:
            Path('.audit').mkdir(exist_ok=True)
            Path(f'.audit/onboarding-states-{label}.json').write_text(json.dumps({
                'body': (await page.locator('body').inner_text())[:4000], 'errors': errors,
                'projects': await page.evaluate("fetch('/api/projects').then(r=>r.status)"),
            }, indent=2))
            raise
        assert not errors, errors
        await browser.close()


async def main():
    if not (REPO / 'client' / 'dist' / 'index.html').exists():
        sys.exit('client/dist is missing; run npm run build first')
    failures = []
    for label, seed, expect_setup in (
        ('fresh', seed_fresh, True),
        ('registered', seed_registered, False),
        ('scanned', seed_scanned, False),
    ):
        server = IsolatedServer(seed)
        try:
            server.wait_ready()
            await visit(server, expect_setup, label)
            print(f'PASS: {label}')
        except Exception as error:
            failures.append(label)
            print(f'FAIL: {label}: {str(error)[:300]}')
        finally:
            server.close()
    if failures:
        sys.exit(f'onboarding states failed: {", ".join(failures)}')
    print('PASS: fresh install shows setup; returning registered/scanned projects keep the workspace')


asyncio.run(main())
