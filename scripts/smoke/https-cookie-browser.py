#!/usr/bin/env python3
"""L04 HTTPS-cookie acceptance with an inert TLS reverse proxy and temporary home."""
import asyncio
import http.client
import importlib.util
import ssl
import subprocess
import threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from playwright.async_api import async_playwright
from host_isolation import chrome_executable

spec=importlib.util.spec_from_file_location('connections_fixture',Path(__file__).with_name('connections-browser.py'))
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)

async def main():
    model=fixture.FakeModel();server=None;proxy=None;browser=None
    try:
        server=fixture.IsolatedServer(model.url)
        cert=server.root/'certificate.pem';key=server.root/'key.pem'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-keyout',str(key),'-out',str(cert)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        key.chmod(0o600)
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                if self.path=='/cookie-test':
                    body=b'<!doctype html><title>HTTPS cookie fixture</title>'
                    self.send_response(200);self.send_header('Content-Type','text/html');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
                else:self.send_error(404)
            def do_POST(self):
                conn=http.client.HTTPConnection('127.0.0.1',server.port,timeout=5)
                headers=dict(self.headers);headers['X-Forwarded-Proto']='https'
                body=self.rfile.read(int(self.headers.get('Content-Length') or 0))
                try:
                    conn.request('POST',self.path,body,headers);response=conn.getresponse();data=response.read()
                    self.send_response(response.status)
                    for name,value in response.getheaders():
                        if name.lower() not in ['connection','transfer-encoding','content-length']:self.send_header(name,value)
                    self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
                finally:conn.close()
        proxy=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.load_cert_chain(cert,key)
        proxy.socket=tls.wrap_socket(proxy.socket,server_side=True)
        threading.Thread(target=proxy.serve_forever,daemon=True).start()
        async with async_playwright() as p:
            browser=await p.chromium.launch(executable_path=chrome_executable())
            secure=await browser.new_context(ignore_https_errors=True)
            page=await secure.new_page();await page.goto(f'https://127.0.0.1:{proxy.server_port}/cookie-test')
            assert await page.evaluate("async()=> (await fetch('/api/session',{method:'POST',credentials:'include'})).status")==204
            cookies=[c for c in await secure.cookies() if c['name']==f'arco_session_{server.port}']
            assert len(cookies)==1 and cookies[0]['secure'] and cookies[0]['httpOnly'] and cookies[0]['sameSite']=='Strict' and cookies[0]['expires']==-1,cookies and {k:v for k,v in cookies[0].items() if k!='value'}
            await secure.close()
            plain=await browser.new_context();page=await plain.new_page();await page.goto(server.base)
            await page.get_by_title('ONLINE',exact=True).wait_for(timeout=30000)
            assert await page.evaluate("async()=> (await fetch('/api/session',{method:'POST',headers:{'X-Forwarded-Proto':'https'}})).status")==204
            cookies=[c for c in await plain.cookies() if c['name']==f'arco_session_{server.port}']
            assert len(cookies)==1 and not cookies[0]['secure'] and cookies[0]['httpOnly']
            assert model.chats==0
            await plain.close();await browser.close();browser=None
            print('PASS: real HTTPS reverse proxy sets Secure/HttpOnly/Strict session cookie; HTTP and protocol-only spoof stay HTTP; no provider call')
    finally:
        if browser:await browser.close()
        if proxy:proxy.shutdown();proxy.server_close()
        if server:server.close()
        model.close()

if __name__=='__main__':asyncio.run(main())
