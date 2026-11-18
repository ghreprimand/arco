"""Same-origin attachment upload on a non-3001 Vite origin.

Covers TerminalInput attach / paste / drop and ChatModeView failure alert.
The page origin is ARCO_CLIENT_PORT (default 5227), never :3001; /upload is a
fixture route that records every request URL. No real Arco server, providers
or network beyond the Vite origin.
"""
import asyncio
import base64
import json
import os
import time
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults
from fs_url import fs_path
from host_isolation import chrome_executable

install_navigation_defaults()

PORT = os.environ.get('ARCO_CLIENT_PORT', '5227')
ORIGIN = 'http://127.0.0.1:' + PORT
PHONE_ORIGIN = 'http://192.0.2.10:3019'
ROOT = Path(__file__).resolve().parents[2]
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jubkAAAAASUVORK5CYII=')
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"></head><body><div id="fixture"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>'''

MOUNT = '''async (mode) => {
  const React = (await import('/node_modules/.vite/deps/react.js')).default;
  const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
  const {useAppStore:s} = await import('/src/stores/appStore.ts');
  const {uploadAttachment} = await import('/src/utils/uploadAttachment.ts');
  const outer = document.getElementById('fixture');
  if (window.__uploadRoot) {
    window.__uploadRoot.unmount();
    window.__uploadRoot = null;
  }
  outer.replaceChildren();
  const host = document.createElement('div');
  outer.append(host);
  const id = mode === 'chat' ? 'upload-chat' : 'upload-agent';
  if (!s.getState().jobs[id]) {
    s.getState().createJob(id, {
      kind: mode === 'chat' ? 'chat' : 'workflow',
      name: 'Upload fixture',
      workingDirectory: '/projects/fixture',
      primaryProvider: 'claude',
      primaryModel: 'sonnet',
      primaryEffort: 'low',
      skipPermissions: false,
    });
  } else {
    s.getState().clearAttachments(id);
  }
  s.setState({connected: true, connectionState: 'online', activeJobId: id});
  if (mode === 'chat') s.getState().addMessage(id,{id:'edit-fixture',role:'user',content:'Original text only',timestamp:1});
  const job = s.getState().jobs[id];
  const onUpload = (file) => uploadAttachment(file);
  const noop = () => {};
  let element;
  if (mode === 'chat') {
    const {ChatModeView} = await import('/src/components/ChatModeView.tsx');
    element = React.createElement(ChatModeView, {job, onSend: noop, onCancel: noop, onUpload});
  } else {
    const {TerminalInput} = await import('/src/components/TerminalInput.tsx');
    element = React.createElement(TerminalInput, {
      job, onSend: noop, onCancel: noop, onCancelQueued: noop, onUpload,
    });
  }
  window.__uploadRoot = createRoot(host);
  window.__uploadRoot.render(element);
  window.__uploadStore = s;
  window.__uploadJobId = id;
}'''


async def main():
    assert PORT != '3001', 'fixture origin must not be port 3001'
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chrome_executable() or None)
        page = await browser.new_page(viewport={'width': 1000, 'height': 800})
        state = {'mode': 'ok', 'uploads': [], 'blocked': []}
        errors = []

        async def isolate(route):
            url = urlparse(route.request.url)
            if url.port == 3001 or url.netloc.endswith(':3001'):
                state['blocked'].append(route.request.url)
                await route.abort()
                return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT:
                if url.path == '/fixture':
                    await route.fulfill(content_type='text/html', body=HTML)
                    return
                if url.path == '/upload':
                    state['uploads'].append({
                        'url': route.request.url,
                        'method': route.request.method,
                        'filename': route.request.headers.get('x-filename'),
                    })
                    if state['mode'] == 'fail':
                        await route.fulfill(status=400, json={'error': 'Empty upload body'})
                        return
                    name = route.request.headers.get('x-filename') or 'upload.bin'
                    await route.fulfill(json={
                        'fileId': 'ab12',
                        'filename': name,
                        'path': '/tmp/arco-uploads/ab12-' + name,
                    })
                    return
                if url.path.startswith('/api/phone-upload'):
                    # Synthetic documentation address; no real listener exists.
                    if route.request.method == 'POST':
                        await route.fulfill(status=201, json={
                            'id': 'phone-fixture', 'url': PHONE_ORIGIN + '/phone-upload#fixture',
                            'expiresAt': int(time.time() * 1000) + 300_000,
                        })
                    else:
                        await route.fulfill(json={'files': [], 'closed': False})
                    return
                local = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if route.request.method == 'GET' and (local or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/'))):
                    await route.continue_()
                    return
            state['blocked'].append(url.path)
            await route.abort()

        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true')

        # --- TerminalInput: attach button ---
        await page.evaluate(MOUNT, 'agent')
        await expect(page.get_by_title('Attach file')).to_be_visible()
        tmp = Path(os.environ.get('TMPDIR') or '/tmp') / 'arco-upload-attach.png'
        tmp.write_bytes(PNG)
        await page.locator('input[type="file"]').set_input_files(str(tmp))
        await page.wait_for_function(
            "() => window.__uploadStore.getState().attachments[window.__uploadJobId]?.some(a => a.filename === 'arco-upload-attach.png')",
            timeout=10000,
        )
        await expect(page.get_by_alt_text('arco-upload-attach.png')).to_be_visible()
        assert state['uploads'], 'attach did not POST /upload'
        assert all(u['url'].startswith(ORIGIN + '/upload') for u in state['uploads']), state['uploads']
        assert all(':3001' not in u['url'] for u in state['uploads'])
        assert not state['blocked']

        # --- UPLOAD FROM PHONE at the 110% interface scale ---
        # The expanded window must stay inside the viewport with its title
        # visible; its height limit once ignored the interface scale.
        await page.set_viewport_size({'width': 1000, 'height': 700})
        await page.evaluate('''async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {PhoneUploadWindow} = await import('/src/components/PhoneUpload.tsx');
          const {applyUiScale} = await import('/src/themes/bootstrap.ts');
          applyUiScale(1.1);
          const host = document.createElement('div');
          document.body.append(host);
          window.__phoneRoot = createRoot(host);
          window.__phoneRoot.render(React.createElement(PhoneUploadWindow));
        }''')
        await page.get_by_role('button', name='Upload from phone').click()
        phone = page.get_by_test_id('phone-upload-window')
        await expect(phone.get_by_alt_text('Scan to upload from your phone')).to_be_visible()
        await expect(phone.locator('.phone-upload-route')).to_have_text(PHONE_ORIGIN + ' UNVERIFIED')
        await phone.locator('details.phone-upload-info summary').click()
        await expect(phone.locator('details.phone-upload-info p').first).to_be_visible()
        box = await page.evaluate('''() => {
          const w = document.querySelector('[data-testid=phone-upload-window]');
          const r = w.getBoundingClientRect(), t = w.querySelector('h2').getBoundingClientRect();
          return {top: r.top, bottom: r.bottom, title: t.top, height: innerHeight};
        }''')
        assert box['top'] >= 0 and box['title'] >= 0 and box['bottom'] <= box['height'] + 1, box
        await phone.get_by_role('button', name='Close', exact=True).click()
        await expect(phone).to_have_count(0)
        await page.evaluate('''async () => {
          window.__phoneRoot.unmount();
          (await import('/src/themes/bootstrap.ts')).applyUiScale(1);
        }''')
        await page.set_viewport_size({'width': 1000, 'height': 800})

        # --- paste image ---
        before = len(state['uploads'])
        await page.evaluate('''() => {
          const area = document.querySelector('textarea');
          const dt = new DataTransfer();
          dt.items.add(new File([new Uint8Array([9,9,9])], 'pasted-shot.png', {type: 'image/png'}));
          area.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
        }''')
        await page.wait_for_function(
            "() => window.__uploadStore.getState().attachments[window.__uploadJobId]?.some(a => a.filename === 'pasted-shot.png')",
            timeout=10000,
        )
        await expect(page.get_by_alt_text('pasted-shot.png')).to_be_visible()
        assert len(state['uploads']) == before + 1
        assert state['uploads'][-1]['url'] == ORIGIN + '/upload'
        assert state['uploads'][-1]['filename'] == 'pasted-shot.png'

        # --- drop via arco:attach-files ---
        before = len(state['uploads'])
        await page.evaluate('''() => {
          const file = new File([new Uint8Array([7,7])], 'dropped.txt', {type: 'text/plain'});
          window.dispatchEvent(new CustomEvent('arco:attach-files', {detail: {files: [file]}}));
        }''')
        await page.wait_for_function(
            "() => window.__uploadStore.getState().attachments[window.__uploadJobId]?.some(a => a.filename === 'dropped.txt')",
            timeout=10000,
        )
        assert len(state['uploads']) == before + 1
        assert state['uploads'][-1]['url'] == ORIGIN + '/upload'

        # --- failing upload shows alert on TerminalInput ---
        state['mode'] = 'fail'
        await page.evaluate('''() => {
          const file = new File([new Uint8Array([1])], 'bad.png', {type: 'image/png'});
          window.dispatchEvent(new CustomEvent('arco:attach-files', {detail: {files: [file]}}));
        }''')
        alert = page.get_by_role('alert')
        await expect(alert).to_contain_text('bad.png')
        await expect(alert).to_contain_text('empty file')

        # --- ChatModeView failure path ---
        state['mode'] = 'fail'
        await page.evaluate(MOUNT, 'chat')
        await page.evaluate('''() => {
          const file = new File([new Uint8Array([1])], 'chat-bad.png', {type: 'image/png'});
          window.dispatchEvent(new CustomEvent('arco:attach-files', {detail: {files: [file]}}));
        }''')
        chat_alert = page.get_by_role('alert')
        await expect(chat_alert).to_contain_text('chat-bad.png')
        await expect(chat_alert).to_contain_text('empty file')
        # B142: EDIT replaces the entire draft, including an empty attachment list.
        await page.evaluate("__uploadStore.getState().addAttachment('upload-chat',{filename:'unrelated.txt',path:'/projects/fixture/unrelated.txt',isImage:false})")
        await page.get_by_role('button', name='EDIT', exact=True).click()
        assert await page.evaluate("__uploadStore.getState().attachments['upload-chat']?.length ?? 0") == 0
        await expect(page.locator('textarea')).to_have_value('Original text only')
        assert all(':3001' not in u['url'] for u in state['uploads'])
        assert not any(':3001' in b for b in state['blocked'])

        assert not errors, errors
        await browser.close()
        print('upload-attach-browser: pass')
        print(json.dumps({'uploads': len(state['uploads']), 'origin': ORIGIN}))


if __name__ == '__main__':
    asyncio.run(main())
