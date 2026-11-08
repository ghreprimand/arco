"""Real preview authority/cookie boundaries; inert apps, temporary home, no turns."""
import asyncio, base64, hashlib, importlib.util, json, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.async_api import async_playwright
from host_isolation import chrome_executable

spec=importlib.util.spec_from_file_location('connections_fixture',Path(__file__).with_name('connections-browser.py'))
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
class Server(h.IsolatedServer):
    def extra_settings(self): return {'onboardingComplete':True,'previewPorts':'4300-4301'}

async def main():
    seen=[];server=None;browser=None
    class App(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            seen.append(dict(self.headers))
            if self.headers.get('Upgrade','').lower()=='websocket':
                accept=base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
                self.send_response(101);self.send_header('Upgrade','websocket');self.send_header('Connection','Upgrade');self.send_header('Sec-WebSocket-Accept',accept);self.end_headers()
                self.wfile.write(b'\x81\x0bhmr-fixture');self.wfile.flush();return
            body=b'<!doctype html><title>Preview fixture</title><script src="/asset.js"></script>' if self.path=='/' else b'window.fixtureReady=true;'
            self.send_response(200);self.send_header('Content-Type','text/html' if self.path=='/' else 'text/javascript')
            self.send_header('Set-Cookie','arco_session_poison=blocked; Path=/');self.send_header('Set-Cookie','app_cookie=allowed; Path=/')
            self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    backend=ThreadingHTTPServer(('127.0.0.1',0),App);threading.Thread(target=backend.serve_forever,daemon=True).start()
    try:
        server=Server('http://127.0.0.1:'+str(h.host_isolation.closed_port()))
        async with async_playwright() as p:
            browser=await p.chromium.launch(executable_path=chrome_executable());context=await browser.new_context(viewport={'width':1920,'height':1080})
            await context.add_init_script("""(()=>{window.fixtureEvents=[];window.__sent=[];const Old=window.WebSocket;window.WebSocket=class extends Old{constructor(...a){super(...a);this.addEventListener('message',e=>{try{window.fixtureEvents.push(JSON.parse(e.data))}catch{}})}send(x){window.fixtureSocket=this;window.__sent.push(x);super.send(x)}}})()""")
            page=await context.new_page();await page.goto(server.base);await page.get_by_title('ONLINE',exact=True).wait_for(timeout=30000)
            await page.wait_for_function('window.fixtureSocket?.readyState===1')
            ids=[]
            for name in ['First preview','Second preview','Exhausted preview']:
                cfg={'name':name,'workingDirectory':str(server.projects/'app'),'primaryProvider':'claude','primaryModel':'sonnet','primaryEffort':'low','skipPermissions':False,'claudeTransport':'native'}
                await page.evaluate("cfg=>fixtureSocket.send(JSON.stringify({type:'create_workflow',config:cfg}))",cfg)
                await page.wait_for_function("name=>fixtureEvents.some(e=>e.type==='workflow_created'&&e.config.name===name)",arg=name,timeout=30000)
                workflow=await page.evaluate("name=>fixtureEvents.find(e=>e.type==='workflow_created'&&e.config.name===name).workflowId",name);ids.append(workflow)
                await page.evaluate("x=>fixtureSocket.send(JSON.stringify({type:'set_preview_port',workflowId:x[0],port:x[1],manual:true}))",[workflow,backend.server_port])
                await page.wait_for_function("id=>fixtureEvents.some(e=>e.type==='preview_set'&&e.workflowId===id)",arg=workflow)
            # Close rendered views so this test owns both narrow lease consumers.
            await page.locator('[data-help="rightpanel.group.memory"]').click()
            await page.locator('[data-help="rightpanel.tab.history"]').click()
            await page.wait_for_timeout(300)
            # An app-created view may own a lease; unknown workflows are rejected.
            assert await page.evaluate("async()=> (await fetch('/api/preview/lease/not-a-workflow',{method:'POST'})).status")==409
            leases=[]
            for workflow in ids[:2]:
                lease=await page.evaluate("async id=>await (await fetch('/api/preview/lease/'+id,{method:'POST'})).json()",workflow)
                assert 'capability' in lease,lease;leases.append(lease)
                await page.evaluate("x=>{const f=document.createElement('iframe');f.id=x.id;f.src='http://127.0.0.1:'+x.port+'/.arco-preview?cap='+x.capability;f.referrerPolicy='origin';document.body.appendChild(f)}",{'id':'frame-'+workflow,**lease})
            frames=[]
            for lease in leases:
                for _ in range(100):
                    frame=next((f for f in page.frames if f.url==f'http://127.0.0.1:{lease["port"]}/'),None)
                    if frame and await frame.evaluate('window.fixtureReady===true'): break
                    await page.wait_for_timeout(50)
                assert frame,lease['port'];frames.append(frame)
            first,second=frames
            assert await first.evaluate("async()=>await new Promise(r=>{const w=new WebSocket(location.origin.replace('http:','ws:')+'/hmr');w.onmessage=e=>{r(e.data);w.close()};w.onerror=()=>r('error')})")=='hmr-fixture'
            for destination in [server.base+'/api/settings',f'http://127.0.0.1:{leases[1]["port"]}/']:
                assert await first.evaluate("async url=>{try{return (await fetch(url,{credentials:'include'})).status}catch{return -1}}",destination)==-1
                assert await first.evaluate("async url=>await new Promise(r=>{const w=new WebSocket(url.replace('http:','ws:'));w.onopen=()=>{w.close();r('open')};w.onerror=()=>r('refused')})",destination.replace('/api/settings','/ws'))=='refused'
            assert await first.evaluate("async()=>{try{return parent.document.title}catch{return 'isolated'}}")=='isolated'
            assert await page.evaluate("async()=> (await fetch('/api/settings')).status")==200
            assert await page.evaluate("async()=> (await fetch('/api/preview/first/')).status")==404
            result=await page.evaluate("async id=>await (await fetch('/api/preview/lease/'+id,{method:'POST'})).json()",ids[2]);assert 'No preview port is free' in result.get('error',''),result
            assert seen and all(not any(k.lower()=='authorization' or k.lower()=='cookie' and 'arco_' in v for k,v in headers.items()) for headers in seen),seen
            assert not any(c['name']=='arco_session_poison' for c in await context.cookies())
            for workflow,lease in zip(ids,leases): await page.evaluate("async x=>await fetch('/api/preview/lease/'+x[0]+'?id='+x[1],{method:'DELETE'})",[workflow,lease['id']])
            assert not any(json.loads(x).get('type')=='user_message' for x in await page.evaluate('window.__sent||[]'))
            await browser.close();browser=None
            print('PASS real preview bootstrap/assets/HMR; no operator credential forwarding, control/sibling HTTP/WS refused, isolated parent, exhaustion and cleanup; no provider turn')
    finally:
        if browser:await browser.close()
        if server:server.close()
        backend.shutdown();backend.server_close()

asyncio.run(main())
