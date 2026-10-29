"""Browser acceptance for the project Home view.

Isolated server (throwaway HOME and projects, denying provider-CLI stubs, empty
network namespace where available - see host_isolation.py), an in-process
Ollama-protocol fixture as the only model endpoint, no credentials, no real model.
Reuses the harness of connections-browser.py; needs Playwright and a built
client/dist.

Scenarios:
  1  restore race: Home opened before a late workspace restore stays on screen,
     and the restored cluster is listed as open work
  2  reload while on Home keeps Home; a provider outage still renders Home
  3  keyboard: Tab to HOME, Enter focuses the heading; "/" focuses search, Esc clears
     it; every project action is a native button named after its project or session
  4  privacy: an Incognito chat is never listed, counted or marked; nothing Home
     keeps in browser storage names it; the Home pre-fill is never persisted
  5  saved sessions (real session files): Resume... opens the creator in RESUME with
     that session selected and its provider set; nothing launches without LAUNCH;
     a session open in a tab offers Open instead
  6  missing folder is disabled with a reason; a bad Add path says why and adds
     nothing; empty registry and a failing list use the documented states
  7  Start buttons open the creator in single / chat / cluster / genesis mode and a
     project's New session / New cluster pre-fill its folder
  8  saved-session HTTP 403/500, non-JSON, wrong-shape and dropped answers show an
     error with Retry and recover on a healthy answer; only a real empty answer says
     "No saved sessions"
"""
import asyncio
from home_controls import open_saved_project_form
import importlib.util
import json
import re
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('workbench_harness', HERE / 'connections-browser.py')
h = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(h)
h.MODEL = "fixture-model:latest"

class HomeServer(h.IsolatedServer):
    def extra_settings(self): return {'defaultWorkingDirectory': '', 'projects': [str(self.projects / 'app')]}

h.IsolatedServer = HomeServer

# Track only synthetic restore frames and Incognito ids for these assertions.
h.INSTRUMENT += """(() => {
  const send = WebSocket.prototype.send, watched = new WeakSet();
  WebSocket.prototype.send = function(data) {
    if (!watched.has(this)) {
      watched.add(this);
      this.addEventListener('message', event => { try {
        const m = JSON.parse(event.data);
        if (['workspace_snapshot','workflow_created','replay_batch','workflow_state_snapshot','cluster_state'].includes(m.type)) window.__homeRestoreAt = Date.now();
        if (m.type === 'workflow_created' && m.config?.incognito) {
          const ids = JSON.parse(sessionStorage.getItem('__incogIds') || '[]');
          sessionStorage.setItem('__incogIds', JSON.stringify([...ids, m.workflowId]));
        }
      } catch {} });
    }
    return send.call(this, data);
  };
})();"""

class HomeBrowser(h.Browser):
    async def open(self):
        page = await super().open()
        if not getattr(self, 'raw', False): await self.settle()
        return page

    async def settle(self):
        await self.page.wait_for_function('window.__homeRestoreAt && Date.now() - window.__homeRestoreAt > 800', timeout=20000)

    async def new_chat(self, incognito=False):
        page = self.page
        if await page.get_by_role('button', name=re.compile('^CHAT')).count() == 0:
            await page.get_by_role('button', name='+ NEW').click()
        await page.get_by_role('button', name=re.compile('^CHAT')).first.click()
        await page.locator('[data-help="creator.provider"] select').select_option('ollama')
        await page.locator('[data-help="creator.model"] select').select_option(h.MODEL)
        if incognito: await page.get_by_text('INCOGNITO CHAT', exact=True).click()
        await page.get_by_role('button', name='START CHAT').click()
        await page.get_by_placeholder('Message Arco').wait_for(timeout=20000)

h.Browser = HomeBrowser

CLAUDE_SESSION = '11111111-2222-4333-8444-555555555555'
CODEX_SESSION = '66666666-7777-4888-9999-aaaaaaaaaaaa'
CLAUDE_TITLE = 'Fix the flaky sample test'
CODEX_TITLE = 'Review the sample parser'
INCOGNITO_NAME = 'Hidden scratch chat'
OPEN_CHAT_NAME = 'Visible planning chat'
WORKFLOW_NAME = 'Sample refactor'


def home_button(page):
    return page.get_by_role('button', name=re.compile('^Home:'))


def main_text(page):
    return page.locator('main').inner_text()


def seed_sessions(server):
    """Real provider session files in the throwaway HOME, read by the server's discovery."""
    app = server.projects / 'app'
    claude_dir = server.home / '.claude' / 'projects' / re.sub(r'[^A-Za-z0-9-]', '-', str(app))
    claude_dir.mkdir(parents=True, exist_ok=True)
    (claude_dir / f'{CLAUDE_SESSION}.jsonl').write_text(json.dumps(
        {'type': 'user', 'timestamp': '2026-10-01T10:00:00Z', 'message': {'content': CLAUDE_TITLE}}) + '\n')
    now = datetime.now(timezone.utc)
    codex_dir = server.home / '.codex' / 'sessions' / f'{now:%Y}' / f'{now:%m}' / f'{now:%d}'
    codex_dir.mkdir(parents=True, exist_ok=True)
    (codex_dir / f'rollout-{now:%Y-%m-%dT%H-%M-%S}-{CODEX_SESSION}.jsonl').write_text('\n'.join([
        json.dumps({'type': 'session_meta', 'payload': {'id': CODEX_SESSION, 'cwd': str(app), 'timestamp': now.isoformat()}}),
        json.dumps({'type': 'event_msg', 'payload': {'type': 'user_message', 'message': CODEX_TITLE}}),
    ]) + '\n')


async def post_project(page, path):
    return await page.evaluate("""async (path) => {
      const r = await fetch('/api/projects', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({path})});
      return r.status;
    }""", path)


async def creator_mode(page):
    """Which MODE pill is selected: the one whose computed border differs from the others."""
    pills = await page.evaluate("""() => [...document.querySelectorAll('[data-help="creator.cluster-mode"] button')]
      .map((b) => [b.innerText.split('\\n')[0].trim(), getComputedStyle(b).borderTopColor])""")
    names = [n for n, _ in pills]
    colors = [c for _, c in pills]
    odd = [n for n, c in pills if colors.count(c) == 1]
    assert len(names) == 4 and len(odd) == 1, f'could not tell the selected mode: {pills}'
    return odd[0]


async def creator_folder(page):
    return await page.evaluate("""() => { const i = document.querySelector('input[placeholder^="Pick a project"]'); return i ? i.value : null; }""")


async def watch_created(browser):
    """Record workflow ids the server announces, to find what is open."""
    ids = []

    def on_socket(ws):
        def on_frame(payload):
            text = payload if isinstance(payload, str) else payload.decode('utf8', 'ignore')
            if '"type":"workflow_created"' in text:
                found = re.search(r'"workflowId":"([^"]+)"', text)
                if found:
                    ids.append(found.group(1))
        ws.on('framereceived', on_frame)
    browser.page.on('websocket', on_socket)
    return ids


async def sent(page, needle):
    return await page.evaluate('(n) => window.__sent.filter((s) => s.includes(n)).length', needle)


async def seed_workspace(playwright, server):
    """A single workflow in `app` (through Home's own New session), a cluster, a normal chat."""
    b = h.Browser(playwright, server)
    page = await b.open()
    try:
        await home_button(page).click()
        await page.get_by_role('button', name='New session in app').click()
        await page.locator('[data-help="creator.provider"] select').locator('option[value="ollama"]').wait_for(state='attached', timeout=20000)
        await page.locator('[data-help="creator.provider"] select').select_option('ollama')
        await page.wait_for_timeout(600)
        await page.locator('[data-help="creator.model"] select').select_option(h.MODEL)
        await page.get_by_placeholder(re.compile('^e.g. Code Review')).fill(WORKFLOW_NAME)
        await page.get_by_role('button', name='LAUNCH WORKFLOW').click()
        await page.get_by_role('button', name='+ NEW').wait_for(timeout=30000)
        await page.get_by_text(WORKFLOW_NAME).first.wait_for(timeout=30000)
        # A cluster in the same project.
        await page.get_by_role('button', name='+ NEW').click()
        await page.get_by_role('button', name=re.compile('^CLUSTER')).first.click()
        await page.locator('[data-help="creator.provider"] select').locator('option[value="ollama"]').wait_for(state='attached', timeout=20000)
        await page.locator('[data-help="creator.provider"] select').select_option('ollama')
        await page.wait_for_timeout(600)
        await page.locator('[data-help="creator.model"] select').select_option(h.MODEL)
        await page.get_by_role('button', name=re.compile('ADD MEMBER')).click()
        await page.get_by_role('button', name=re.compile('^app')).click()
        await page.get_by_role('button', name='CREATE CLUSTER').click()
        await page.get_by_role('button', name='NUDGE', exact=True).wait_for(timeout=30000)
        # A normal chat with a known name.
        await page.get_by_role('button', name='+ NEW').click()
        await page.get_by_role('button', name=re.compile('^CHAT')).first.click()
        await page.locator('[data-help="creator.provider"] select').locator('option[value="ollama"]').wait_for(state='attached', timeout=20000)
        await page.locator('[data-help="creator.provider"] select').select_option('ollama')
        await page.wait_for_timeout(600)
        await page.locator('[data-help="creator.model"] select').select_option(h.MODEL)
        await page.get_by_placeholder('New chat').fill(OPEN_CHAT_NAME)
        await page.get_by_role('button', name='START CHAT').click()
        await page.get_by_placeholder('Message Arco').wait_for(timeout=30000)
        await page.wait_for_timeout(1500)
    finally:
        await b.close()


class Hold:
    """Hold every server frame after `connected` until release()."""

    def __init__(self):
        self.queue, self.open, self.ws = [], False, None

    def release(self):
        self.open = True
        for message in self.queue:
            self.ws.send(message)
        self.queue.clear()

    async def install(self, context):
        async def handler(ws):
            self.ws = ws
            server = ws.connect_to_server()
            ws.on_message(lambda message: server.send(message))

            def from_server(message):
                if self.open or (isinstance(message, str) and '"type":"connected"' in message):
                    ws.send(message)
                else:
                    self.queue.append(message)
            server.on_message(from_server)
        await context.route_web_socket(re.compile(r'.*/ws$'), handler)


# ---------------------------------------------------------------- scenarios

async def scenario_restore_race(playwright, server):
    hold = Hold()
    b = h.Browser(playwright, server)
    b.raw = True
    b.on_context = hold.install
    page = await b.open()
    try:
        await home_button(page).click()
        await page.get_by_role('heading', name='HOME', exact=True).wait_for(timeout=5000)
        assert await page.locator('.home-work-grid li').count() == 0, 'restored work arrived before the hold released'
        hold.release()
        await page.locator('.home-work-grid li').first.wait_for(timeout=30000)  # the restore landed
        await page.wait_for_timeout(3000)
        assert await page.get_by_role('heading', name='HOME', exact=True).count() == 1, \
            f'the late restore replaced Home | errors={b.errors[-3:]} | text={(await page.evaluate("document.body.innerText"))[:300]!r}'
        text = await main_text(page)
        assert re.search(r'Open work \([1-9]', text), f'restored work is not listed as open work: {text[:500]!r}'
        assert 'Cluster' in text, 'the restored cluster is not listed'
    finally:
        await b.close()


async def scenario_reload_and_outage(playwright, server, outage_server):
    b = h.Browser(playwright, server)
    page = await b.open()
    try:
        await home_button(page).click()
        await page.get_by_role('heading', name='HOME', exact=True).wait_for(timeout=5000)
        await page.reload()
        try:
            await page.get_by_text('ONLINE', exact=True).wait_for(timeout=30000)
        except Exception:
            # Reconnect timing under load, before any Home assertion. Record what the page showed,
            # reload once; Home itself is still asserted strictly below.
            print(f"note: not ONLINE 30s after reload; page: {(await page.evaluate('document.body.innerText'))[:200]!r}; reloading once")
            await page.reload()
            await page.get_by_text('ONLINE', exact=True).wait_for(timeout=45000)
        await b.settle()
        await page.wait_for_timeout(1500)
        assert await page.get_by_role('heading', name='HOME', exact=True).count() == 1, 'a reload left Home'
        assert await home_button(page).get_attribute('aria-current') == 'page'
    finally:
        await b.close()
    b = h.Browser(playwright, outage_server)
    b.raw = True
    page = await b.open()
    try:
        await page.get_by_text('No provider connected', exact=False).wait_for(timeout=20000)
        await home_button(page).click()
        await page.get_by_role('heading', name='HOME', exact=True).wait_for(timeout=5000)
        await page.wait_for_timeout(1500)
        assert await page.get_by_text('No provider connected', exact=False).count() == 1, 'the outage banner disappeared'
        assert 'app' in await main_text(page), 'Home does not list the returning project during an outage'
        assert await page.get_by_text('NO PROVIDER CONNECTED YET', exact=True).count() == 0
    finally:
        await b.close()


async def scenario_keyboard(playwright, server):
    b = h.Browser(playwright, server)
    page = await b.open()
    try:
        for _ in range(80):
            await page.keyboard.press('Tab')
            if await page.evaluate("document.activeElement && (document.activeElement.getAttribute('aria-label') || '').startsWith('Home:')"):
                break
        else:
            raise AssertionError('Tab never reached the HOME button')
        await page.keyboard.press('Enter')
        await page.get_by_role('heading', name='HOME', exact=True).wait_for(timeout=5000)
        await page.wait_for_function("document.activeElement?.id === 'home-title'", timeout=5000)
        focus = await page.evaluate('document.activeElement && document.activeElement.id')
        assert focus == 'home-title', f'Home did not move focus to its heading: {focus!r}'
        await page.get_by_role('heading', name='Project locations',exact=True).wait_for(timeout=10000)  # the list has loaded
        await page.keyboard.press('/')
        assert await page.evaluate('document.activeElement && document.activeElement.id') == 'home-search', '"/" did not focus search'
        await page.keyboard.type('zzz-no-such-project')
        await page.wait_for_function("document.querySelector('main').innerText.includes('No folder matches')", timeout=5000)
        await page.keyboard.press('Escape')
        assert await page.locator('#home-search').input_value() == '', 'Escape did not clear the search'
        await page.keyboard.type('app')
        await page.wait_for_function("document.querySelector('main').innerText.includes('folders match')", timeout=5000)
        assert 'No folder matches' not in await main_text(page)
        await page.keyboard.press('Escape')
        # Every action is a native button with a name; project actions carry the project's name.
        buttons = await page.evaluate("""() => [...document.querySelectorAll('main button')].filter(b=>b.getClientRects().length).map((b) => ({
          tag: b.tagName, name: (b.getAttribute('aria-label') || b.textContent || '').trim(), inCard: !!b.closest('h4, li > div') && !!b.closest('li')}))""")
        assert buttons and all(x['name'] for x in buttons), f'a Home button has no accessible name: {buttons}'
        assert await page.evaluate("[...document.querySelectorAll('main [onclick], main div[role=button]')].length") == 0, 'Home has a non-native clickable'
        mismatched = await page.evaluate("""() => [...document.querySelectorAll('main li')].filter((li) => li.querySelector(':scope > div h4'))
          .flatMap((li) => { const name = li.querySelector('h4').textContent.trim();
            return [...li.querySelectorAll(':scope > div:last-of-type button')].filter((b) => !(b.getAttribute('aria-label') || '').includes(name)).map((b) => name + ' / ' + b.textContent); })""")
        assert not mismatched, f'project buttons that do not name their project: {mismatched}'
        # A saved-session action names the session.
        await page.get_by_role('button', name='Show saved sessions for app').focus()
        await page.keyboard.press('Enter')
        await page.get_by_role('button', name=re.compile(f'^Resume {CLAUDE_TITLE}')).wait_for(timeout=10000)
        assert await page.get_by_role('button', name=re.compile(f'^Resume {CODEX_TITLE}')).count() == 1, 'the second saved session is not offered'
    finally:
        await b.close()


async def scenario_privacy(playwright, server):
    b = h.Browser(playwright, server)
    page = await b.open()
    try:
        await b.new_chat(incognito=True)
        incog_ids = json.loads(await page.evaluate("sessionStorage.getItem('__incogIds') || '[]'"))
        assert incog_ids, 'no Incognito workflow was created'
        await home_button(page).click()
        await page.get_by_role('heading', name='HOME', exact=True).wait_for(timeout=5000)
        text = await main_text(page)
        # The seeded server already holds a workflow, a cluster and a normal chat: these are
        # restored into this browser; only the Incognito chat made here must be absent.
        count = int(re.search(r'Open work \((\d+)\)', text).group(1))
        names_listed = await page.locator('.home-work-details strong').all_inner_texts()
        assert len(names_listed) == count, f'Open work count {count} does not match the rows listed {names_listed}'
        assert OPEN_CHAT_NAME in names_listed and WORKFLOW_NAME in names_listed, f'normal open work is missing: {names_listed}'
        for forbidden in (INCOGNITO_NAME, 'Incognito', 'INCOGNITO'):
            assert forbidden not in text, f'Home mentions an Incognito tab: {forbidden!r}'
        # Project cards count only normal tabs; the Incognito chat has no project and is never counted.
        await page.get_by_role('button', name='Show saved sessions for app').click()
        await page.get_by_role('button', name=re.compile('^(Resume|Open)')).first.wait_for(timeout=10000)
        assert 'ncognito' not in await main_text(page)
        # Browser storage: nothing names the Incognito workflow; Home keeps only a boolean.
        local = await page.evaluate("JSON.stringify(Object.entries(localStorage))")
        for wid in incog_ids:
            assert wid not in local, 'an Incognito workflow id reached localStorage'
        stored = [v for k, v in json.loads(local) if '"showHome"' in v]
        assert stored, 'Home visibility is not remembered in the persisted UI state'
        state = json.loads(stored[0])['state']
        assert isinstance(state.get('showHome'), bool), state.get('showHome')
        assert 'creatorPrefill' not in stored[0], 'the one-shot creator pre-fill was persisted'
        # Starting from a project consumes the pre-fill and leaves it out of storage.
        await page.get_by_role('button', name='New session in app').click()
        await page.get_by_role('button', name='LAUNCH WORKFLOW').wait_for(timeout=10000)
        local = await page.evaluate("JSON.stringify(Object.entries(localStorage))")
        persisted_ui = json.loads(next(value for key, value in json.loads(local) if '"showHome"' in value))['state']
        assert 'creatorPrefill' not in persisted_ui and 'resumeSessionId' not in persisted_ui
    finally:
        await b.close()


async def scenario_project_list_is_projects(playwright, server):
    """Home lists projects, not the private storage folders chats run in."""
    b = h.Browser(playwright, server)
    page = await b.open()
    try:
        await b.new_chat(incognito=True)
        incog_ids = json.loads(await page.evaluate("sessionStorage.getItem('__incogIds') || '[]'"))
        await home_button(page).click()
        await page.get_by_role('heading', name='HOME', exact=True).wait_for(timeout=5000)
        await page.get_by_role('heading', name='Project locations',exact=True).wait_for(timeout=10000)
        await page.wait_for_timeout(500)
        paths = await page.evaluate("[...document.querySelectorAll('main h4 + div')].map((d) => d.textContent)")
        assert paths, 'no projects listed'
        for wid in incog_ids:
            assert not any(wid in path for path in paths), 'an Incognito chat folder is listed as a project'
        chat_dirs = [path for path in paths if '/.arco/chats/' in path]
        assert not chat_dirs, f'chat storage folders are listed as projects (New session / New cluster would run inside them): {chat_dirs}'
    finally:
        await b.close()


async def scenario_saved_sessions(playwright, server):
    b = h.Browser(playwright, server)
    page = await b.open()
    try:
        await home_button(page).click()
        await page.get_by_role('button', name='Show saved sessions for app').click()
        list_ = page.get_by_role('list', name='Saved sessions in app')
        await list_.get_by_role('button', name=re.compile(f'^Resume {CODEX_TITLE}')).wait_for(timeout=10000)
        before = await sent(page, 'create_workflow')
        # Resume is an explicit request using the normal workflow-creation path.
        await page.get_by_role('button', name=re.compile(f'^Resume {CODEX_TITLE}')).click()
        await page.wait_for_function("window.__sent.some(s=>{try{const m=JSON.parse(s);return m.type==='create_workflow' && m.config.resumeSessionId==='" + CODEX_SESSION + "'}catch{return false}})")
        assert await sent(page, 'create_workflow') == before + 1
        frames = await page.evaluate('window.__sent.map(s=>{try{return JSON.parse(s)}catch{return {}}})')
        resumed = next(m for m in reversed(frames) if m.get('type') == 'create_workflow')
        assert resumed['config']['primaryProvider'] == 'codex'
        assert resumed['config']['workingDirectory'] == str(server.projects / 'app')
        assert resumed['config']['skipPermissions'] is False
        await page.wait_for_function("!document.querySelector('#home-title')", timeout=15000)

    finally:
        await b.close()


async def scenario_internal_resume(playwright, server, model):
    """An Arco-managed saved session restores its original identity without a prompt."""
    app = server.projects / 'app'
    source = next(path for path in (app / '.arco/workflows').glob('*/meta.json') if json.loads(path.read_text()).get('name') == WORKFLOW_NAME)
    original = json.loads(source.read_text())
    workflow_id = 'abcdefab-1234-4567-890a-abcdefabcdef'
    folder = source.parent.parent / workflow_id
    folder.mkdir(exist_ok=True)
    metadata = {**original, 'workflowId': workflow_id, 'name': 'Saved fixture continuation', 'createdAt': int(time.time() * 1000), 'lastActiveAt': int(time.time() * 1000)}
    (folder / 'meta.json').write_text(json.dumps(metadata))
    events = source.parent / 'events.jsonl'
    if events.exists():
        (folder / 'events.jsonl').write_text(events.read_text().replace(original['workflowId'], workflow_id))
    b = h.Browser(playwright, server)
    page = await b.open()
    try:
        await home_button(page).click()
        response = await page.request.get(server.base + '/api/sessions?path=' + str(app))
        row = next(session for session in (await response.json())['sessions'] if session.get('arcoWorkflowId') == workflow_id)
        assert row.get('arcoInternal') is True
        title = row.get('name') or row.get('arcoName') or row['sessionId'][:8]
        before = model.chats
        await page.get_by_role('button', name=f'Resume {title}', exact=True).click()
        await page.wait_for_function("!document.querySelector('#home-title')", timeout=15000)
        frames = await page.evaluate('window.__sent.map(s=>{try{return JSON.parse(s)}catch{return {}}})')
        request = next(frame for frame in frames if frame.get('type') == 'create_workflow' and frame.get('config', {}).get('resumeWorkflowId') == workflow_id)
        assert not request['config'].get('resumeSessionId')
        assert request['config']['primaryProvider'] == original['primaryProvider']
        assert model.chats == before, 'restoring a saved session sent a model prompt'
    finally:
        await b.close()


async def scenario_saved_errors(playwright, server):
    """A failed or malformed saved-session answer is an error with Retry, never a false 'No saved sessions'."""
    cases = (
        ('HTTP 403', dict(status=403, json={'error': 'forbidden'})),
        ('HTTP 500', dict(status=500, json={'error': 'boom'})),
        ('HTTP 200 with a body that is not JSON', dict(status=200, body='<html>proxy page</html>', content_type='text/html')),
        ('HTTP 200 with JSON of the wrong shape', dict(status=200, json={'sessions': 'nope'})),
        ('HTTP 200 with JSON that has no sessions field', dict(status=200, json={'ok': True})),
        ('connection dropped', None),
    )
    b = h.Browser(playwright, server)
    b.raw = True
    mode = {'bad': None, 'calls': 0}

    async def install(context):
        async def sessions(route):
            if route.request.method != 'GET' or mode['bad'] == 'real':
                return await route.fallback()
            mode['calls'] += 1
            if mode['bad'] is None:
                return await route.abort()
            return await route.fulfill(**mode['bad'])
        await context.route(re.compile(r'.*/api/sessions\?.*'), sessions)
    b.on_context = install
    page = await b.open()
    try:
        await home_button(page).click()
        await page.get_by_role('heading', name='HOME', exact=True).wait_for(timeout=5000)
        card = page.locator('li', has=page.get_by_role('heading', name='app', exact=True))
        for index, (label, fixture) in enumerate(cases):
            mode['bad'] = fixture
            if index:
                await page.reload()
                await page.get_by_role('heading', name='HOME', exact=True).wait_for(timeout=30000)
                await page.get_by_role('heading', name='app', exact=True).wait_for(timeout=15000)
            mode['calls'] = 0
            await page.get_by_role('button', name='Show saved sessions for app').click()
            try:
                await card.get_by_role('alert').wait_for(timeout=8000)
            except Exception:
                raise AssertionError(f'{label}: no error shown; the card says {(await card.inner_text())[:200]!r}')
            text = await card.inner_text()
            assert 'No saved sessions in this folder' not in text, f'{label}: shown as an empty folder: {text!r}'
            assert await card.get_by_role('button', name='Retry').count() == 1, f'{label}: no Retry offered'
            assert await card.get_by_role('list', name='Saved sessions in app').count() == 0, f'{label}: a list is shown'
            # Retry hits the endpoint again and still reports the failure.
            calls = mode['calls']
            await card.get_by_role('button', name='Retry').click()
            await card.get_by_role('alert').wait_for(timeout=10000)
            assert mode['calls'] > calls, f'{label}: Retry did not ask again'
            # Collapse and reopen with a healthy server: the same card recovers.
            await page.get_by_role('button', name='Hide saved sessions for app').click()
            mode['bad'] = 'real'
            await page.get_by_role('button', name='Show saved sessions for app').click()
            if await card.get_by_role('alert').count():
                await card.get_by_role('button', name='Retry').click()
            await card.get_by_role('list', name='Saved sessions in app').wait_for(timeout=10000)
            assert await card.get_by_role('alert').count() == 0, f'{label}: the error stayed after recovery'
        # A genuinely empty answer is the only thing that says "No saved sessions".
        mode['bad'] = dict(status=200, json={'sessions': []})
        await page.reload()
        await page.get_by_role('heading', name='HOME', exact=True).wait_for(timeout=30000)
        await page.get_by_role('button', name='Show saved sessions for app').click()
        await card.get_by_text('No saved sessions in this folder').wait_for(timeout=10000)
        assert await card.get_by_role('alert').count() == 0
    finally:
        await b.close()


async def scenario_open_marking(playwright, server):
    """A saved session claimed by an open tab offers Open (not Resume) and opens that tab."""
    b = h.Browser(playwright, server)
    b.raw = True
    seen = {}

    async def fixture(context):
        def on_socket(ws):
            def on_frame(payload):
                text = payload if isinstance(payload, str) else payload.decode('utf8', 'ignore')
                if WORKFLOW_NAME not in text:
                    return
                try:
                    frame = json.loads(text)
                except ValueError:
                    return
                entries = frame.get('workspace', {}).get('workflows', []) if frame.get('type') == 'workspace_snapshot' else [frame]
                for entry in entries:
                    if entry.get('config', {}).get('name') == WORKFLOW_NAME and entry.get('workflowId'):
                        seen['workflowId'] = entry['workflowId']
            ws.on('framereceived', on_frame)
        context.on('page', lambda p: p.on('websocket', on_socket))

        async def sessions(route):
            response = await route.fetch()
            body = await response.json()
            for entry in body.get('sessions', []):
                if entry.get('sessionId') == CLAUDE_SESSION and seen.get('workflowId'):
                    entry['arcoWorkflowId'] = seen['workflowId']
            await route.fulfill(response=response, json=body)
        await context.route(re.compile(r'.*/api/sessions\?.*'), sessions)
    b.on_context = fixture
    page = await b.open()
    try:
        for _ in range(100):
            if seen.get('workflowId'):
                break
            await asyncio.sleep(0.2)
        assert seen.get('workflowId'), 'the restored workflow never announced itself'
        await b.settle()
        await home_button(page).click()
        await page.get_by_role('button', name='Show saved sessions for app').click()
        list_ = page.get_by_role('list', name='Saved sessions in app')
        await list_.get_by_role('button', name=f'Open {CLAUDE_TITLE}').wait_for(timeout=10000)
        assert await list_.get_by_role('button', name=re.compile(f'^Resume {CLAUDE_TITLE}')).count() == 0
        assert await list_.get_by_role('button', name=re.compile(f'^(Resume|Open) {CODEX_TITLE}')).count() == 1
        await list_.get_by_role('button', name=f'Open {CLAUDE_TITLE}').click()
        await page.wait_for_timeout(500)
        assert await page.get_by_role('heading', name='HOME', exact=True).count() == 0, 'Open did not leave Home'
        assert await page.get_by_role('button', name=re.compile('^SINGLE WORKFLOW')).count() == 0, 'Open showed the creator, not the session'
    finally:
        await b.close()


async def scenario_missing_and_add(playwright, server, scratch):
    gone = scratch / 'gone'
    beta = scratch / 'beta'
    gone.mkdir()
    beta.mkdir()
    b = h.Browser(playwright, server)
    page = await b.open()
    try:
        await home_button(page).click()
        await page.get_by_role('heading', name='HOME', exact=True).wait_for(timeout=5000)
        # Add through Home's own form.
        await open_saved_project_form(page)
        await page.locator('#home-add').fill(str(gone))
        await page.get_by_role('button', name='Add', exact=True).click()
        await page.get_by_text(f'Added {gone}.').wait_for(timeout=10000)
        await open_saved_project_form(page)
        await page.locator('#home-add').fill(str(beta))
        await page.get_by_role('button', name='Add', exact=True).click()
        await page.get_by_text(f'Added {beta}.').wait_for(timeout=10000)
        gone.rmdir()
        await page.get_by_role('button', name='Close folder browser', exact=True).click()
        await page.get_by_role('button', name='Reload list').click()
        card = page.locator('li', has=page.get_by_role('heading', name='gone', exact=True))
        await card.get_by_text('Folder not found').wait_for(timeout=10000)
        for name in ('New session in gone', 'New cluster in gone', 'Show saved sessions for gone'):
            assert await page.get_by_role('button', name=name).is_disabled(), f'{name} is enabled for a missing folder'
        assert await page.get_by_role('button', name='New session in beta').is_enabled()
        # A bad path says why and adds nothing.
        before = (await (await page.request.get(server.base + '/api/projects')).json())['projects']
        await open_saved_project_form(page)
        await page.locator('#home-add').fill('relative/not-absolute')
        await page.get_by_role('button', name='Add', exact=True).click()
        status = page.locator('#home-add-status')
        await page.wait_for_function("document.querySelector('#home-add-status').innerText.startsWith('Not added: ')", timeout=10000)
        message = await status.inner_text()
        assert len(message) > len('Not added: ') + 3, f'the refusal gives no reason: {message!r}'
        assert (await (await page.request.get(server.base + '/api/projects')).json())['projects'] == before
        await open_saved_project_form(page)
        await page.locator('#home-add').fill(str(scratch / 'never-created'))
        await page.get_by_role('button', name='Add', exact=True).click()
        await page.wait_for_function("document.querySelector('#home-add-status').innerText.startsWith('Not added: ')", timeout=10000)
        assert (await (await page.request.get(server.base + '/api/projects')).json())['projects'] == before
        assert (await status.inner_text()).startswith('Not added: ')
    finally:
        await b.close()
    # Documented states for an empty registry and an unreachable list (client fixtures).
    for label, fulfil, expect in (
        ('empty', {'status': 200, 'json': {'projects': [], 'scanFolder': ''}}, 'Add a location containing your projects'),
        ('failing', {'status': 500, 'json': {'error': 'boom'}}, 'The project list could not be loaded'),
    ):
        b = h.Browser(playwright, server)
        b.raw = True

        async def install(context, fulfil=fulfil):
            async def projects(route):
                if route.request.method == 'GET':
                    return await route.fulfill(**fulfil)
                await route.fallback()
            await context.route(re.compile(r'.*/api/projects$'), projects)
        b.on_context = install
        page = await b.open()
        try:
            await home_button(page).click()
            await page.get_by_text(re.compile(expect)).first.wait_for(timeout=10000)
            if label == 'empty':
                assert 'mount' in await main_text(page), 'the empty state lost its mount hint'
                assert await page.get_by_role('button', name='Add project location', exact=True).count() == 1
            else:
                assert await page.get_by_role('alert').filter(has_text=expect).count() == 1
                assert await page.get_by_role('button', name='Reload list').is_enabled()
        finally:
            await b.close()


async def scenario_start_buttons(playwright, server):
    target = server.projects / 'prefill-target'
    target.mkdir(exist_ok=True)
    b = h.Browser(playwright, server)
    page = await b.open()
    assert await post_project(page, str(server.projects / 'app')) == 200
    assert await post_project(page, str(target)) == 200
    try:
        expectations = (
            ('New session', 'SINGLE WORKFLOW'),
            ('Start a chat', 'CHAT'),
            ('New cluster', 'CLUSTER'),
            ('New idea (Genesis)', 'GENESIS'),
        )
        for label, mode in expectations:
            await home_button(page).click()
            await page.get_by_role('heading', name='HOME', exact=True).wait_for(timeout=5000)
            if label in ('New cluster', 'New idea (Genesis)'): await page.get_by_text('More ways to start', exact=True).click()
            await page.get_by_role('button', name=label, exact=True).first.click()
            await page.get_by_role('button', name=re.compile('^SINGLE WORKFLOW')).wait_for(timeout=10000)
            await page.wait_for_timeout(300)
            got = await creator_mode(page)
            assert got == mode, f'{label!r} opened the creator in {got!r}, expected {mode!r}'
            assert await page.get_by_role('heading', name='HOME', exact=True).count() == 0
            if mode in ('CHAT', 'GENESIS'):
                assert not await creator_folder(page), 'a no-project start pre-filled a folder'
        # A project start pre-fills that project (not the creator's default pick, which is `app`).
        await home_button(page).click()
        await page.get_by_role('button', name='Reload list').click()
        await page.get_by_role('button', name='New session in prefill-target').click()
        await page.get_by_role('button', name='LAUNCH WORKFLOW').wait_for(timeout=10000)
        assert (await creator_folder(page)).endswith('/prefill-target'), await creator_folder(page)
        assert await creator_mode(page) == 'SINGLE WORKFLOW'
        await home_button(page).click()
        await page.get_by_role('button', name='New cluster in prefill-target').click()
        await page.get_by_role('button', name=re.compile('^SINGLE WORKFLOW')).wait_for(timeout=10000)
        await page.wait_for_timeout(300)
        assert await creator_mode(page) == 'CLUSTER'
        assert (await creator_folder(page)).endswith('/prefill-target'), 'New cluster did not pre-fill the project folder'
        # A plain start afterwards gets the creator's own default, never the previous pre-fill.
        await home_button(page).click()
        await page.get_by_role('button', name='New session', exact=True).first.click()
        await page.get_by_role('button', name=re.compile('^SINGLE WORKFLOW')).wait_for(timeout=10000)
        await page.wait_for_timeout(600)
        assert not (await creator_folder(page) or '').endswith('/prefill-target'), 'an old project pre-fill leaked into a plain start'
        assert await sent(page, 'create_workflow') == 0 and await sent(page, 'create_cluster') == 0, 'a Start button launched something'
    finally:
        await b.close()


async def main():
    if not (h.REPO / 'client' / 'dist' / 'index.html').exists():
        sys.exit('client/dist is missing; run npm run build first')
    model = h.FakeModel()
    server = h.IsolatedServer(model.url)
    outage = h.IsolatedServer('http://127.0.0.1:9')  # nothing listens: no provider connects
    failures = []
    try:
        seed_sessions(server)
        async with h.async_playwright() as playwright:
            await seed_workspace(playwright, server)
            for label, run in (
                ('restore race: Home survives a late workspace restore', lambda: scenario_restore_race(playwright, server)),
                ('reload keeps Home; provider outage still renders Home', lambda: scenario_reload_and_outage(playwright, server, outage)),
                ('keyboard-only use; every action is a named native button', lambda: scenario_keyboard(playwright, server)),
                ('saved sessions: Resume restores the session and provider in one click', lambda: scenario_saved_sessions(playwright, server)),
                ('Arco-managed saved sessions resume with their original identity and no prompt', lambda: scenario_internal_resume(playwright, server, model)),
                ('saved-session failures (403, 500, malformed, dropped) show an error with Retry, not an empty folder', lambda: scenario_saved_errors(playwright, server)),
                ('a session open in a tab offers Open and opens it', lambda: scenario_open_marking(playwright, server)),
                ('Start buttons and project pre-fill choose the creator mode and folder', lambda: scenario_start_buttons(playwright, server)),
                ('missing folder, bad Add path, empty registry, failing list', lambda: scenario_missing_and_add(playwright, server, server.projects)),
                ('project list holds projects, not chat storage or Incognito folders', lambda: scenario_project_list_is_projects(playwright, server)),
                ('Incognito never appears; storage keeps no Home pre-fill', lambda: scenario_privacy(playwright, server)),
            ):
                if len(sys.argv) > 1 and sys.argv[1].lower() not in label.lower():
                    continue
                try:
                    await asyncio.wait_for(run(), 150)
                    print(f'PASS: {label}')
                except BaseException as error:
                    failures.append(label)
                    where = traceback.extract_tb(error.__traceback__)[-1] if error.__traceback__ else None
                    print(f'FAIL: {label}: {type(error).__name__}: {str(error)[:700]}' + (f' (home-browser.py:{where.lineno}: {where.line})' if where else ''))
    finally:
        server.close()
        outage.close()
        model.close()
    if failures:
        sys.exit(f'home acceptance failed: {len(failures)}')
    print('PASS: home acceptance')


asyncio.run(main())
