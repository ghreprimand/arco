"""Guided Connections acceptance on an isolated server and synthetic provider states.

Real UI/catalog/settings routes, temporary HOME/projects, denying CLI stubs and
required empty network namespace. Login/status failures are browser fixtures;
no provider login, credentials, endpoint discovery, inference or model download.
"""
import asyncio
import importlib.util
import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE=Path(__file__).resolve().parent
# Local acceptance fixtures. Kept here so the approved Connections suites do
# not depend on the abandoned workbench/voice acceptance architecture.
import os
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from playwright.async_api import async_playwright
import host_isolation

host_isolation.enter_isolated_network()
REPO = Path(__file__).resolve().parents[2]
INSTRUMENT = """(() => {window.__sent=[];const send=WebSocket.prototype.send;WebSocket.prototype.send=function(data){window.__sent.push(String(data));return send.call(this,data);};})();"""

class FakeModel:
    def __init__(self):
        self.chats = 0
        outer = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def reply(self, value):
                data=json.dumps(value).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            def do_GET(self):
                if self.path == '/api/version': return self.reply({'version':'0.0.0-fixture'})
                if self.path == '/api/tags': return self.reply({'models':[{'name':'fixture-model:latest','model':'fixture-model:latest','details':{'family':'fixture'},'size':0}]})
                if self.path == '/api/ps': return self.reply({'models':[]})
                self.send_error(404)
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length') or 0))
                if self.path == '/api/chat': outer.chats += 1
                if self.path == '/api/show': return self.reply({'capabilities':['completion','tools'],'parameters':'num_ctx 8192'})
                self.send_error(400)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.url=f'http://127.0.0.1:{self.server.server_port}'
    def close(self): self.server.shutdown();self.server.server_close()

class IsolatedServer:
    def extra_env(self): return {}
    def extra_settings(self): return {}
    def __init__(self, model_url):
        self.root=Path(tempfile.mkdtemp(prefix='arco-connections-'));self.home=self.root/'home';self.projects=self.root/'projects';self.tmp=self.root/'tmp'
        for directory in (self.home/'.arco',self.projects/'app',self.tmp): directory.mkdir(parents=True)
        (self.home/'.arco/settings.json').write_text(json.dumps({'ollama':{'baseUrl':model_url},'enabledProviders':{'llamacpp':False},'defaultWorkingDirectory':str(self.projects/'app'),**self.extra_settings()}))
        (self.home/'.arco/known-cwds.json').write_text(json.dumps([str(self.projects/'app')]))
        self.port=host_isolation.closed_port();self.base=f'http://127.0.0.1:{self.port}'
        self.env=host_isolation.harden({'HOME':str(self.home),'ARCO_HOME':str(self.home/'.arco'),'TMPDIR':str(self.tmp),'ARCO_PORT':str(self.port),'ARCO_HOST':'127.0.0.1','ARCO_UPLOADS_DIR':str(self.root/'uploads'),**self.extra_env()},self.root)
        self.env['ARCO_SERVE_CLIENT']='1'
        self.log=(self.root/'server.log').open('w')
        self.proc=subprocess.Popen(['node','--conditions','development','--import','tsx','server/src/index.ts'],cwd=REPO,env=self.env,stdout=self.log,stderr=self.log)
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            if self.proc.poll() is not None: raise RuntimeError('isolated Connections server exited')
            try:
                with urllib.request.urlopen(self.base+'/readyz',timeout=1) as response:
                    if response.status==200: return
            except Exception: time.sleep(.15)
        raise RuntimeError('isolated Connections server not ready')
    def close(self):
        self.proc.terminate()
        try: self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired: self.proc.kill();self.proc.wait(timeout=5)
        self.log.close();shutil.rmtree(self.root)

class Browser:
    def __init__(self, playwright, server): self.playwright=playwright;self.server=server
    async def open(self):
        self.browser=await self.playwright.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        self.context=await self.browser.new_context()
        async def local_only(route):
            if urlparse(route.request.url).netloc==urlparse(self.server.base).netloc: await route.continue_()
            else: await route.abort()
        await self.context.route('http**://**/*',local_only);await self.context.add_init_script(INSTRUMENT)
        if getattr(self,'on_context',None): await self.on_context(self.context)
        self.page=await self.context.new_page();self.errors=[]
        self.page.on('pageerror',lambda error:self.errors.append(str(error)))
        await self.page.goto(self.server.base);await self.page.get_by_text('ONLINE',exact=True).wait_for(timeout=30000)
        await self.page.wait_for_timeout(900)
        return self.page
    async def close(self): await self.browser.close()

h=SimpleNamespace(IsolatedServer=IsolatedServer,FakeModel=FakeModel,Browser=Browser,INSTRUMENT=INSTRUMENT,REPO=REPO,async_playwright=async_playwright)

IDS=['claude','codex','gemini','cursor','ollama','lmstudio','strata','llamacpp','deepseek','antigravity','github']

class Server(h.IsolatedServer):
    def extra_env(self):
        return {'ARCO_DEPLOYMENT':'docker'}

async def browser(playwright,server,ready=True,fresh=False):
    b=h.Browser(playwright,server)
    state={'status':{p:{'loggedIn':False} for p in IDS},'checks':[],'logins':[],'fail_check':False}
    if ready:
        state['status']['codex']={'loggedIn':True,'apiProvider':'openai-api-key','email':'operator@example.invalid'}
    async def setup(context):
        await context.route('**/api/auth-status',lambda route:route.fulfill(status=200,json=state['status']))
        if fresh:
            await context.route('**/api/installation-history',lambda route:route.fulfill(status=200,json={'used':False}))
        async def check(route):
            provider=parse_qs(urlparse(route.request.url).query)['provider'][0]
            state['checks'].append(provider)
            if state['fail_check']:
                return await route.fulfill(status=503,json={'error':'synthetic unavailable'})
            await route.fulfill(status=200,json={'provider':provider,'status':state['status'][provider]})
        await context.route('**/api/connections/check?*',check)
        async def login(route):
            provider=parse_qs(urlparse(route.request.url).query)['provider'][0]
            state['logins'].append(provider)
            await route.fulfill(status=503,json={'error':'synthetic start failure'})
        await context.route('**/api/auth-login?*',login)
    b.on_context=setup
    if fresh:
        b.browser=await playwright.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        b.context=await b.browser.new_context()
        host=urlparse(server.base).netloc
        async def local_only(route):
            if urlparse(route.request.url).netloc==host:await route.continue_()
            else:await route.abort()
        await b.context.route('http**://**/*',local_only)
        await b.context.add_init_script(h.INSTRUMENT)
        await setup(b.context)
        b.page=await b.context.new_page()
        await b.page.goto(server.base)
        page=b.page
    else:
        page=await b.open()
    return b,page,state

async def open_connections(page):
    await page.get_by_role('button',name='CONNECTIONS',exact=False).click()
    dialog=page.get_by_role('dialog',name='Connections',exact=True)
    await dialog.get_by_role('navigation',name='Connections').get_by_role('button',name=re.compile('^Codex')).wait_for()
    return dialog

async def choose(dialog,label):
    await dialog.get_by_role('navigation',name='Connections').get_by_role('button',name=re.compile('^'+re.escape(label)+r'\b')).click()
    return dialog.get_by_role('region',name=label+' connection')

async def no_launch(page):
    assert await page.evaluate("window.__sent.filter(s=>/create_workflow|create_cluster|send_prompt/.test(s)).length")==0

async def first_run(playwright,server):
    b,page,state=await browser(playwright,server,ready=False,fresh=True)
    try:
        await page.get_by_text('Welcome to Arco',exact=True).wait_for(timeout=20000)
        await page.get_by_role('button',name='Skip setup',exact=True).click()
        await page.get_by_text('ONLINE',exact=True).wait_for()
        await page.reload()
        await page.get_by_text('ONLINE',exact=True).wait_for(timeout=20000)
        assert await page.get_by_text('NO PROVIDER CONNECTED YET',exact=True).count()==0
        assert await page.get_by_role('region',name='Provider connection status').count()==1
        await no_launch(page)
        assert not state['checks'] and not state['logins'],'browsing/skip never starts provider actions'
    finally: await b.close()

async def categories(playwright,server):
    b,page,state=await browser(playwright,server)
    try:
        dialog=await open_connections(page)
        for label in ['Provider sign-in','Local models','Desktop integrations','Tool accounts']:
            assert await dialog.get_by_role('navigation').get_by_role('heading',name=label,exact=True).count()==1
        codex=await choose(dialog,'Codex')
        await codex.get_by_text('OpenAI API key reported active; API usage is billed separately.',exact=True).wait_for()
        await codex.get_by_text('Reported account: operator@example.invalid',exact=True).wait_for()
        desktop=await choose(dialog,'Antigravity')
        await desktop.get_by_role('status').filter(has_text='Unavailable here').wait_for()
        assert await desktop.get_by_role('button',name='Check connection',exact=True).is_disabled()
        llama=await choose(dialog,'llama.cpp')
        await llama.get_by_role('status').filter(has_text='Disabled').wait_for()
        await llama.get_by_role('button',name='Enable provider',exact=True).click()
        await llama.get_by_role('button',name='Disable provider',exact=True).wait_for()
        await llama.get_by_role('button',name='Disable provider',exact=True).click()
        await llama.get_by_role('button',name='Enable provider',exact=True).wait_for()
        tool=await choose(dialog,'GitHub CLI')
        assert 'not an AI provider' in await tool.inner_text()
        assert not state['checks'] and not state['logins'],'selecting provider cards is read-only'
        await no_launch(page)
    finally: await b.close()

async def checks_and_endpoints(playwright,server):
    b,page,state=await browser(playwright,server)
    try:
        dialog=await open_connections(page)
        local=await choose(dialog,'Ollama')
        await local.get_by_label('Model server address').fill('http://host.docker.internal:11434')
        assert 'localhost means the container' in await local.inner_text()
        await local.get_by_role('button',name='Save endpoint',exact=True).click()
        await local.get_by_text('Endpoint saved.',exact=False).wait_for()
        assert not state['checks'],'saving does not implicitly test the endpoint'
        state['status']['ollama']={'loggedIn':False,'apiProvider':'ollama:http://host.docker.internal:11434','installedModels':[]}
        await local.get_by_role('button',name='Test connection',exact=True).click()
        await local.get_by_text('Configured address: http://host.docker.internal:11434 (not reachable)',exact=True).wait_for()
        state['checks'].clear()
        state['status']['ollama']={'loggedIn':True,'apiProvider':'ollama:http://host.docker.internal:11434','installedModels':['fixture-a','fixture-b']}
        await local.get_by_role('button',name='Test connection',exact=True).click()
        await local.get_by_text('2 models reported',exact=False).wait_for()
        await local.get_by_text('Configured address: http://host.docker.internal:11434 (reachable, 2 models)',exact=True).wait_for()
        assert state['checks']==['ollama'],'only the selected service is checked'
        state['fail_check']=True
        await local.get_by_role('button',name='Test connection',exact=True).click()
        await dialog.get_by_role('status').filter(has_text='Status could not be checked.').wait_for()
        assert await local.get_by_text('Runtime detected',exact=True).count()==1,'last known status is retained with a failure notice'
        await b.context.route('**/api/settings',lambda route:route.fulfill(status=503,json={'error':'synthetic failure'}) if route.request.method=='POST' else route.continue_())
        await local.get_by_label('Model server address').fill('http://model-service.invalid:11434')
        await local.get_by_role('button',name='Save endpoint',exact=True).click()
        await local.get_by_text('Endpoint was not saved.',exact=False).wait_for()
        assert await local.get_by_label('Model server address').input_value()=='http://model-service.invalid:11434'
        saved=json.loads((server.home/'.arco'/'settings.json').read_text())
        assert saved['ollama']['baseUrl']=='http://host.docker.internal:11434','failed save did not mutate settings'
        await no_launch(page)
    finally: await b.close()

async def login_and_deep_links(playwright,server):
    b,page,state=await browser(playwright,server)
    try:
        dialog=await open_connections(page)
        claude=await choose(dialog,'Claude Code')
        await claude.get_by_role('button',name='Sign in to Claude Code',exact=True).click()
        await dialog.get_by_text('Sign-in could not be started.',exact=False).wait_for()
        assert state['logins']==['claude']
        async def command(route):
            await route.fulfill(status=200,json={'started':False,'command':'gemini','hostCommand':'docker compose exec arco gemini','manual':'Synthetic terminal fallback'})
        await b.context.route('**/api/auth-login?provider=gemini&inApp=1',command)
        gemini=await choose(dialog,'Gemini CLI')
        if await gemini.get_by_role('button',name='Enable provider',exact=True).count():
            await gemini.get_by_role('button',name='Enable provider',exact=True).click()
            await gemini.get_by_role('button',name='Disable provider',exact=True).wait_for()
        await gemini.get_by_role('button',name='Sign in to Gemini CLI',exact=True).click()
        await gemini.get_by_text('docker compose exec arco gemini',exact=True).wait_for()
        await gemini.get_by_role('button',name='Advanced provider settings',exact=True).click()
        await page.get_by_role('dialog',name='Settings',exact=True).wait_for()
        await page.get_by_role('button',name='Close settings',exact=True).click()
        dialog=page.get_by_role('dialog',name='Connections',exact=True)
        await dialog.get_by_role('button',name='CLOSE',exact=True).click()
        await page.evaluate("location.hash='#connections/codex'")
        dialog=page.get_by_role('dialog',name='Connections',exact=True)
        await dialog.get_by_role('region',name='Codex connection').wait_for()
        await page.keyboard.press('Escape')
        assert await page.get_by_role('dialog',name='Connections',exact=True).count()==0
        assert not (await page.evaluate('location.hash')).startswith('#connections')
        await no_launch(page)
    finally: await b.close()

async def scoped_login(playwright,server):
    b,page,state=await browser(playwright,server)
    try:
        dialog=await open_connections(page)
        claude=await choose(dialog,'Claude Code')
        session={'provider':'claude','status':'pending','needsCode':True,'awaitingCode':True,'url':'https://login.example.invalid/fixture','startedAt':1}
        async def sign_in(route):
            await route.fulfill(status=200,json={'started':True,'command':'claude auth login --claudeai','session':session})
        await b.context.route('**/api/auth-login?provider=claude&inApp=1',sign_in)
        await b.context.route('**/api/auth-login/session?provider=claude',lambda route:route.fulfill(status=200,json={'session':session}))
        async def code(route):
            body=route.request.post_data_json
            assert body=={'provider':'claude','code':'SYNTHETIC-CODE'}
            session['status']='completed'
            state['status']['claude']={'loggedIn':True,'email':'fixture@example.invalid'}
            await route.fulfill(status=200,json={'session':session})
        await b.context.route('**/api/auth-login/code',code)
        await claude.get_by_role('button',name='Sign in to Claude Code',exact=True).click()
        await claude.get_by_label('Sign-in code',exact=True).fill('SYNTHETIC-CODE')
        await claude.get_by_role('button',name='SUBMIT CODE',exact=True).click()
        await claude.get_by_text('Signed in to Claude.',exact=False).wait_for()
        await claude.get_by_role('button',name='Check connection',exact=True).click()
        await claude.get_by_text('Reported account: fixture@example.invalid',exact=True).wait_for()
        assert await dialog.count()==1,'a successful provider does not close a manually opened Connections screen'
        state['status']['codex']={'loggedIn':True,'accountStatuses':[{'id':'fixture','label':'Fixture account','email':'profile@example.invalid','loggedIn':True}]}
        codex=await choose(dialog,'Codex')
        await codex.get_by_role('button',name='Check connection',exact=True).click()
        await codex.get_by_role('list',name='Configured account statuses').get_by_text('Fixture account',exact=False).wait_for()
        assert await codex.get_by_role('button',name='Sign in again',exact=True).count()==0,'profile status does not masquerade as the default-account login'
        await codex.get_by_role('button',name='Accounts and profiles',exact=True).click()
        settings=page.get_by_role('dialog',name='Settings',exact=True)
        await settings.locator('[data-help="settings.codex-profiles"]').wait_for()
        await no_launch(page)
    finally:await b.close()

async def main():
    model=h.FakeModel()
    server=Server(model.url)
    failed=[]
    try:
        async with h.async_playwright() as playwright:
            for label,run in [('first-run skip and returning continuity',first_run),('categories, source, disabled and unavailable states',categories),('explicit selected checks and failed endpoint saves',checks_and_endpoints),('login recovery, fallback and deep links',login_and_deep_links),('provider-owned code flow and account profiles',scoped_login)]:
                if len(sys.argv)>1 and sys.argv[1] not in label:continue
                try:
                    await asyncio.wait_for(run(playwright,server),120)
                    print('PASS: '+label,flush=True)
                except BaseException as error:
                    failed.append(label)
                    print(f'FAIL: {label}: {type(error).__name__}: {str(error)[:650]}',flush=True)
        assert model.chats==0,'setup and connection checks must not send inference requests'
    finally:
        server.close();model.close()
    if failed:sys.exit(f'Connections acceptance failed: {len(failed)}')
    print('PASS: Connections acceptance')

if __name__ == '__main__':
    asyncio.run(main())
