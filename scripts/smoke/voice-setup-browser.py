"""Settings -> VOICE SETUP against an isolated server and a fixture voice home.

The server reads a synthetic voice home (venv, package metadata, model markers,
NOTICES.md), so the status rows and notices are real. Install, cancel and the
test-phrase recognition are intercepted in the browser: nothing is downloaded,
no recognizer starts and no provider is called. Chromium's fake microphone
drives the level meter and the recorded phrase. Requires a built client
(npm run build), Python Playwright and ARCO_TEST_CHROME when its default
browser is unavailable.
"""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

from playwright.async_api import async_playwright
from host_isolation import closed_port, enter_isolated_network, harden

REPO = Path(__file__).resolve().parents[2]
MODELS = {
    'sherpa-onnx-moonshine-tiny-en-int8': ['tokens.txt', 'preprocess.onnx', 'encode.int8.onnx', 'uncached_decode.int8.onnx', 'cached_decode.int8.onnx'],
    'kokoro-multi-lang-v1_0': ['model.onnx'],
    'vosk-model-small-en-us-0.15': ['am/final.mdl'],
    'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8': ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
}


def voice_fixture(root: Path) -> None:
    windows = os.name == 'nt'
    python = root / 'venv' / ('Scripts/python.exe' if windows else 'bin/python')
    python.parent.mkdir(parents=True, exist_ok=True)
    python.write_text('')
    (root / 'venv' / 'pyvenv.cfg').write_text('version_info = 3.12.9\n')
    site = root / 'venv' / ('Lib/site-packages' if windows else 'lib/python3.12/site-packages')
    for name in ('sherpa_onnx-1.13.3', 'numpy-2.2.6', 'vosk-0.3.45'):
        (site / f'{name}.dist-info').mkdir(parents=True, exist_ok=True)
    for model, files in MODELS.items():
        if windows and 'parakeet' in model:
            continue
        for f in files:
            (root / model / f).parent.mkdir(parents=True, exist_ok=True)
            (root / model / f).write_text('')
    (root / 'NOTICES.md').write_text('# Voice components installed by npm run voice:setup\n\n| Component | License |\n|---|---|\n| fixture-model | MIT |\n')


async def check_browser(base, voice_home):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None,
                                          args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        try:
            context = await browser.new_context(viewport={'width': 1400, 'height': 1000})
            await context.grant_permissions(['microphone'], origin=base)
            state = {'installs': 0, 'polls': 0, 'cancel': 0, 'docker': False, 'phrase': None}

            async def local_only(route):
                if route.request.url.startswith(base + '/'):
                    await route.continue_()
                else:
                    await route.abort()
            await context.route('**/*', local_only)

            async def status(route):
                real = await route.fetch()
                data = await real.json()
                if state['installs'] and state['polls'] < 3:
                    state['polls'] += 1
                    data['install'] = {'running': True, 'exitCode': None, 'startedAt': 1, 'finishedAt': None,
                                       'log': '$ npm run voice:setup\n' + 'Downloading local English speech model (~108 MB).\n' * state['polls']}
                elif state['installs']:
                    data['install'] = {'running': False, 'exitCode': 0, 'startedAt': 1, 'finishedAt': 2,
                                       'log': '$ npm run voice:setup\nLocal speech is installed.\n[voice setup finished]\n'}
                if state['docker']:
                    data['deployment'] = 'docker'
                await route.fulfill(status=200, content_type='application/json', body=json.dumps(data))
            await context.route(base + '/api/voice/setup', status)

            async def install(route):
                state['installs'] += 1
                await route.fulfill(status=202, content_type='application/json', body='{"ok":true}')
            await context.route(base + '/api/voice/setup/install', install)

            async def transcribe(route):
                body = route.request.post_data_buffer or b''
                state['phrase'] = len(body)
                await route.fulfill(status=200, content_type='application/json', body=json.dumps({'text': 'fixture phrase heard', 'ms': 640, 'recognizer': 'Parakeet v3'}))
            await context.route(base + '/api/voice/setup/transcribe', transcribe)

            page = await context.new_page()
            await page.add_init_script("""
              window.__micTracks = [];
              const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
              navigator.mediaDevices.getUserMedia = async (c) => { const s = await original(c); window.__micTracks.push(...s.getTracks()); return s; };
            """)
            await page.goto(base)
            await page.locator('[data-help="header.settings"]').click(timeout=30000)
            voice_page = page.get_by_role('navigation', name='Settings categories').get_by_role('button', name='Voice', exact=True)
            await voice_page.click()
            section = page.locator('section[data-help="settings.voice-setup"]')
            await section.wait_for()
            await section.locator('[data-voice-setup-state="ready"]').wait_for()
            rows = section.get_by_label('Voice components')
            text = await rows.inner_text()
            for expected in (str(voice_home), 'from ARCO_VOICE_HOME', 'Python 3.12.9', '1.13.3', '2.2.6', '0.3.45', 'installed (kokoro-multi-lang-v1_0)'):
                assert expected in text, f'{expected!r} missing from the status rows'

            await section.get_by_role('button', name='MODEL NOTICES', exact=True).click()
            assert 'fixture-model' in await section.get_by_label('Voice model notices').inner_text()
            await section.get_by_role('button', name='HIDE NOTICES', exact=True).click()

            await section.get_by_role('button', name='REINSTALL / REPAIR', exact=True).click()
            await section.locator('[data-voice-setup-state="installing"]').wait_for()
            await section.get_by_role('button', name='CANCEL INSTALL', exact=True).wait_for()
            assert await section.get_by_role('button', name='SAY A PHRASE', exact=True).is_disabled()
            log = section.get_by_label('Voice setup log')
            await page.wait_for_function("document.querySelector('[aria-label=\"Voice setup log\"]')?.textContent.includes('[voice setup finished]')", timeout=15000)
            await section.locator('[data-voice-setup-state="ready"]').wait_for()
            assert state['installs'] == 1 and state['polls'] == 3

            await section.get_by_role('button', name='TEST MICROPHONE', exact=True).click()
            meter = section.get_by_role('meter', name='Microphone level')
            await meter.wait_for()
            await page.wait_for_function("Number(document.querySelector('[aria-label=\"Microphone level\"]')?.getAttribute('aria-valuenow')) > 0", timeout=10000)
            await section.get_by_role('button', name='STOP MICROPHONE', exact=True).click()
            await meter.wait_for(state='detached')
            assert await page.evaluate("window.__micTracks.length > 0 && window.__micTracks.every(t => t.readyState === 'ended')"), 'meter tracks released'

            await section.get_by_role('button', name='SAY A PHRASE', exact=True).click()
            await section.get_by_role('button', name='STOP AND RECOGNIZE', exact=True).wait_for()
            await page.wait_for_timeout(1200)
            await section.get_by_role('button', name='STOP AND RECOGNIZE', exact=True).click()
            heard = section.get_by_label('Recognized phrase')
            await heard.wait_for()
            assert 'fixture phrase heard' in await heard.inner_text() and 'Parakeet v3' in await heard.inner_text()
            size = state['phrase']
            assert size and size % 2 == 0 and 16000 * 2 * 0.8 <= size <= 16000 * 2 * 3, f'phrase is ~1 s of 16 kHz PCM16, got {size} bytes'
            assert await page.evaluate("window.__micTracks.every(t => t.readyState === 'ended')"), 'phrase tracks released'

            state['docker'] = True
            # The address kept #settings/voice, so the reload reopens Settings on Voice.
            assert page.url.endswith('#settings/voice'), page.url
            await page.reload()
            await section.locator('[data-voice-setup-state="docker"]').wait_for()
            assert 'native run' in await section.inner_text()
            assert await section.locator('button').count() == 0, 'Docker shows no voice actions'
            print('PASS: voice setup status rows from a fixture voice home, notices, install with live log, microphone level meter with track release, test phrase as 16 kHz PCM16, Docker explanation.')
        finally:
            await browser.close()


def main():
    enter_isolated_network()
    with tempfile.TemporaryDirectory(prefix='arco-voice-setup-browser-') as temporary:
        root = Path(temporary)
        home, project, voice = root / 'home', root / 'project', root / 'voice'
        for directory in (home / '.arco', project, voice, root / 'tmp', root / 'uploads'):
            directory.mkdir(parents=True, exist_ok=True)
        voice_fixture(voice)
        (home / '.arco/settings.json').write_text(json.dumps({'defaultWorkingDirectory': str(project)}))
        port = closed_port()
        base = f'http://127.0.0.1:{port}'
        env = harden({
            'HOME': str(home), 'ARCO_HOME': str(home / '.arco'), 'ARCO_VOICE_HOME': str(voice), 'TMPDIR': str(root / 'tmp'),
            'ARCO_PORT': str(port), 'ARCO_HOST': '127.0.0.1',
            'ARCO_UPLOADS_DIR': str(root / 'uploads'),
        }, root)
        env['ARCO_SERVE_CLIENT'] = '1'
        with (root / 'server.log').open('w') as log:
            server = subprocess.Popen(['node', '--conditions', 'development', '--import', 'tsx', 'server/src/index.ts'], cwd=REPO, env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    if server.poll() is not None:
                        raise RuntimeError('isolated server exited before readiness')
                    try:
                        with urllib.request.urlopen(base + '/readyz', timeout=1) as response:
                            if response.status == 200:
                                break
                    except Exception:
                        time.sleep(0.1)
                else:
                    raise RuntimeError('isolated server readiness timed out')
                asyncio.run(check_browser(base, voice))
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)


if __name__ == '__main__':
    main()
