#!/usr/bin/env python3
"""L01: exact browser origins, remote configuration and credentialed upgrades.
Synthetic pages, temporary server/home, no provider requests or terminal attach.
"""
import asyncio
import importlib.util
import threading
import os
import subprocess
import time
import urllib.request
import host_isolation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.async_api import async_playwright
from host_isolation import chrome_executable

spec = importlib.util.spec_from_file_location('connections_fixture', Path(__file__).with_name('connections-browser.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

class Server(fixture.IsolatedServer):
    def extra_env(self):
        return {'ARCO_ALLOWED_HOSTS':'workbench.tail-example.ts.net', 'ARCO_ALLOWED_ORIGINS':'https://workbench.example:8443'}

class Page(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        body=b'<!doctype html><title>Unrelated local page</title><p>Origin fixture</p>'
        self.send_response(200);self.send_header('Content-Type','text/html');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)

async def main():
    model=fixture.FakeModel(); server=None; browser=None; frontend=None; frontend_log=None
    other=ThreadingHTTPServer(('127.0.0.1',0),Page)
    threading.Thread(target=other.serve_forever,daemon=True).start()
    try:
        server=Server(model.url)
        client_port=host_isolation.closed_port()
        frontend_env={**server.env,'ARCO_CLIENT_PORT':str(client_port)}
        frontend_log=(server.root/'frontend.log').open('w')
        frontend=subprocess.Popen(['npm','run','dev','-w','client','--','--port',str(client_port)],cwd=fixture.REPO,env=frontend_env,stdout=frontend_log,stderr=frontend_log,start_new_session=True)
        front=f'http://127.0.0.1:{client_port}'
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            try:
                with urllib.request.urlopen(front,timeout=1) as response:
                    if response.status==200:break
            except Exception:time.sleep(.1)
        else:raise RuntimeError('development frontend not ready')
        async with async_playwright() as p:
            browser=await p.chromium.launch(executable_path=chrome_executable())
            context=await browser.new_context()
            page=await context.new_page()
            await page.goto(server.base)
            await page.get_by_title('ONLINE',exact=True).wait_for(timeout=30000)
            # The real Vite proxy must keep the browser's served Host. This
            # also preserves single-port SSH access without extra origins.
            await page.goto(front)
            await page.get_by_title('ONLINE',exact=True).wait_for(timeout=30000)
            assert any(c['name'].startswith('arco_session_') for c in await context.cookies()),'workbench has its own browser session'
            for host,origin in [('workbench.tail-example.ts.net','https://workbench.tail-example.ts.net'),('workbench.example:8443','https://workbench.example:8443')]:
                response=await context.request.get(server.base+'/healthz',headers={'Host':host,'Origin':origin})
                assert response.status==200,(host,response.status)
                assert response.headers.get('access-control-allow-origin')==origin
            await page.goto(f'http://127.0.0.1:{other.server_port}')
            foreign=f'http://127.0.0.1:{other.server_port}'
            for method in ['POST','OPTIONS']:
                response=await context.request.fetch(server.base+'/api/fixture-only',method=method,headers={'Origin':foreign})
                assert response.status==403,(method,response.status)
                assert 'access-control-allow-origin' not in response.headers
            result=await page.evaluate("""async base => {
                const request=async headers=>{try {const r=await fetch(base+'/api/fixture-only',{method:'POST',credentials:'include',headers,body:'fixture'});return 'readable:'+r.status;}catch{return 'refused';}};
                const socket=path=>new Promise(resolve=>{const ws=new WebSocket(base.replace(/^http/,'ws')+path);const timer=setTimeout(()=>{ws.close();resolve('timeout');},3000);ws.onopen=()=>{clearTimeout(timer);ws.close();resolve('accepted');};ws.onerror=()=>{clearTimeout(timer);resolve('refused');};});
                return {post:await request({'Content-Type':'text/plain'}),preflight:await request({'Content-Type':'application/json'}),control:await socket('/ws'),terminal:await socket('/terminal')};
            }""",server.base)
            assert result=={'post':'refused','preflight':'refused','control':'refused','terminal':'refused'},result
            assert model.chats==0
            await browser.close();browser=None
            print('PASS: exact configured remote origins, existing session, unrelated-port POST/preflight/control/terminal refusal; no provider call or terminal attach')
    finally:
        if browser: await browser.close()
        if frontend:
            import signal
            os.killpg(frontend.pid,signal.SIGTERM)
            try:frontend.wait(timeout=10)
            except subprocess.TimeoutExpired:os.killpg(frontend.pid,signal.SIGKILL);frontend.wait()
        if frontend_log:frontend_log.close()
        other.shutdown();other.server_close()
        if server: server.close()
        model.close()

if __name__=='__main__':asyncio.run(main())
