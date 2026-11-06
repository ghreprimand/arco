"""Chat timeline order: a question card and its answer split the turn's text.

Real handleServerMessage and ChatMessage under Vite, fixture events only, no
server or provider. One Codex turn: text, a question, more text, the answer
(a steer), more text. Live delivery and a replay batch (what a reload or a new
browser receives) must give the same rows in event order, and each assistant
row shows the time of its own first event, not the turn start.
"""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright
from browser_navigation import install_navigation_defaults

install_navigation_defaults()
from fs_url import fs_path

PORT = os.environ.get('ARCO_CLIENT_PORT', '5262')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"><link rel="stylesheet" href="/src/styles/matrix.css"></head><body><div id="fixture"></div>
<script type="module">import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
window.fixtureReady = true;</script></body></html>'''

T0 = 1793400000000
MIN = 60_000
QUESTION = {'requestId': 'q1', 'provider': 'codex', 'threadId': 'th1', 'turnId': 'tu1', 'itemId': 'it1', 'mode': 'blocking',
            'questions': [{'id': 'src', 'header': 'Source', 'question': 'Which source should the summary use?', 'options': [{'label': 'First', 'description': 'The first source'}, {'label': 'Second', 'description': 'The second source'}], 'allowOther': True, 'secret': False}],
            'status': 'pending', 'createdAt': T0 + 2 * MIN}


def events(w):
    return [
        {'type': 'user_message_echo', 'workflowId': w, 'content': 'Summarize the release notes.', 'clientMessageId': 'u1', 'timestamp': T0, 'seq': 1, 'eventTs': T0},
        {'type': 'primary_turn_started', 'workflowId': w, 'startedAt': T0, 'seq': 2, 'eventTs': T0},
        {'type': 'primary_text', 'workflowId': w, 'phase': 'passthrough', 'text': 'Reading the notes. ', 'seq': 3, 'eventTs': T0 + 1000},
        {'type': 'primary_text', 'workflowId': w, 'phase': 'passthrough', 'text': 'Two sources disagree on the date.', 'seq': 4, 'eventTs': T0 + 2000},
        {'type': 'operator_question', 'workflowId': w, 'question': QUESTION, 'seq': 5, 'eventTs': T0 + 2 * MIN},
        {'type': 'primary_text', 'workflowId': w, 'phase': 'passthrough', 'text': 'Waiting for the choice.', 'seq': 6, 'eventTs': T0 + 3 * MIN},
        {'type': 'user_message_echo', 'workflowId': w, 'kind': 'steer', 'content': 'Use the second source.', 'clientMessageId': 'u2', 'timestamp': T0 + 8 * MIN, 'seq': 7, 'eventTs': T0 + 8 * MIN},
        {'type': 'operator_question', 'workflowId': w, 'question': {**QUESTION, 'status': 'answered'}, 'seq': 8, 'eventTs': T0 + 8 * MIN},
        {'type': 'primary_text', 'workflowId': w, 'phase': 'passthrough', 'text': 'The summary uses the second source.', 'seq': 9, 'eventTs': T0 + 9 * MIN},
        {'type': 'primary_complete', 'workflowId': w, 'phase': 'passthrough', 'seq': 10, 'eventTs': T0 + 10 * MIN},
        {'type': 'primary_turn_ended', 'workflowId': w, 'endedAt': T0 + 10 * MIN, 'seq': 11, 'eventTs': T0 + 10 * MIN},
    ]


EXPECTED = [
    ['user', 'Summarize the release notes.', T0],
    ['assistant', 'Reading the notes. Two sources disagree on the date.', T0 + 1000],
    ['question', 'Which source should the summary use?', T0 + 2 * MIN],
    ['assistant', 'Waiting for the choice.', T0 + 3 * MIN],
    ['user', 'Use the second source.', T0 + 8 * MIN],
    ['assistant', 'The summary uses the second source.', T0 + 9 * MIN],
    ['system', '[TURN · 10m 0.0s]', T0 + 10 * MIN],
]


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1200, 'height': 1400})
        blocked, errors = [], []

        async def isolate(route):
            url = urlparse(route.request.url)
            if url.scheme == 'https' and url.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(status=200, content_type='text/css', body=''); return
            if url.scheme == 'http' and url.netloc == '127.0.0.1:' + PORT and route.request.method == 'GET':
                if url.path.startswith('/api/'):
                    await route.fulfill(json={}); return
                if url.path == '/fixture':
                    await route.fulfill(status=200, content_type='text/html', body=HTML); return
                is_local_fs = url.path.startswith('/@fs/') and fs_path(url.path).resolve().is_relative_to(ROOT)
                if is_local_fs or url.path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/', '/themes/victor-mono/')):
                    await route.continue_(); return
            blocked.append(url.path)
            await route.abort()
        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady === true', timeout=10000)
        await page.evaluate("""async () => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {ChatMessage} = await import('/src/components/ChatMessage.tsx');
          const {applyTheme} = await import('/src/themes/apply.ts');
          const {getTheme} = await import('/src/themes/registry.ts');
          applyTheme(getTheme('matrix'));
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          const {handleServerMessage:receive} = await import('/src/ws/handleServerMessage.ts');
          window.s = s;
          window.send = m => receive(m, {wsRef:{current:null}, scheduleReconnect:()=>{}});
          for (const w of ['wf-live', 'wf-replay']) s.getState().createJob(w, {name:w, workingDirectory:'/projects/fixture', primaryProvider:'codex', primaryModel:'gpt-5.5', primaryEffort:'medium', skipPermissions:false});
          const root = createRoot(document.getElementById('fixture'));
          window.render = w => root.render(React.createElement('div', {id:'col', style:{width:'1000px'}},
            s.getState().jobs[w].messages.map(m => React.createElement('div', {key:m.id, 'data-row':m.role}, React.createElement(ChatMessage, {jobId:w, message:m})))));
          window.rows = w => s.getState().jobs[w].messages.map(m => [m.operatorQuestion ? 'question' : m.role, m.operatorQuestion ? m.operatorQuestion.questions[0].question : m.content, m.timestamp, m.operatorQuestion?.status ?? null]);
        }""")

        async def check(w, how):
            # createJob's own "Workflow ... active" row comes first.
            rows = [r for r in await page.evaluate('w => rows(w)', w) if not r[1].startswith('Workflow "')]
            got = [r[:3] for r in rows]
            assert got == EXPECTED, f'{how}: rows in the wrong order or with the wrong times:\n' + json.dumps(got, indent=1)
            assert rows[2][3] == 'answered', (how, rows[2])
            await page.evaluate('w => render(w)', w)
            text = await page.locator('#col').inner_text()
            at = [text.find(part) for part in ['Reading the notes.', 'Which source should the summary use?', 'Waiting for the choice.', 'Use the second source.', 'The summary uses the second source.']]
            assert -1 not in at and at == sorted(at), f'{how}: on-screen order {at}'

        # Live: one event at a time, each its own task, as from the socket.
        for ev in events('wf-live'):
            await page.evaluate('m => send(m)', ev)
        await check('wf-live', 'live')
        # Reload: the same log as one replay batch.
        await page.evaluate('evs => send({type: "replay_batch", workflowId: "wf-replay", events: evs})', events('wf-replay'))
        await check('wf-replay', 'replay')
        assert not errors, errors
        assert not blocked, blocked
        await browser.close()
        print('PASS: question card and answer split the turn text in event order; each row shows its own first-event time; live and replay match')


asyncio.run(main())
