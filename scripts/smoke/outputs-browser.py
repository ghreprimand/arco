"""Workspace Outputs with synthetic events/files and existing viewers; no providers."""
import asyncio
import base64
import io
import json
import os
import wave
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright, expect
URL = 'http://127.0.0.1:' + os.environ.get('ARCO_CLIENT_PORT', '5201') + '/'
ART = Path(os.environ.get('ARCO_OUTPUT_VISUAL_ARTIFACTS', '/tmp/arco-outputs-browser'))
A, B = '11111111-2222-4333-8444-555555555555', '22222222-3333-4444-8555-666666666666'
CWD = '/projects/harbor'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jubkAAAAASUVORK5CYII=')

def output(id, name, category, title=None, **extra):
    return {'id': id * 32, 'name': name, 'title': title or name, 'path': CWD + '/' + name, 'originPath': CWD + '/' + name, 'category': category, 'workflowId': A, 'cwd': CWD, 'producer': 'Producer A', 'createdAt': 1793210000000, 'updatedAt': 1793210000000, 'size': 32, 'missing': False, 'source': 'artifact event', **extra}

async def main():
    ART.mkdir(parents=True, exist_ok=True)
    wav = io.BytesIO()
    with wave.open(wav, 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(8000); f.writeframes(b'\x00\x00' * 800)
    state = {'outputs': [output('a', 'generated.png', 'images', 'Generated illustration'), output('b', 'report.md', 'documents'), output('c', 'sound.wav', 'audio'), output('d', 'clip.mp4', 'video'), output('e', 'archive.bin', 'other'), output('f', 'missing.txt', 'documents', missing=True)], 'writes': [], 'requests': [], 'frames': [], 'text': '# Synthetic report\nDurable content.'}
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        context = await browser.new_context(viewport={'width': 1280, 'height': 720})
        async def api(route):
            req = route.request; path = urlparse(req.url).path; query = parse_qs(urlparse(req.url).query)
            state['requests'].append((path, query))
            if req.method not in ['GET', 'HEAD']: state['writes'].append((path, req.post_data_json if req.post_data else None))
            data = {'files': [], 'projects': [], 'workflows': [], 'clusters': [], 'skills': [], 'sessions': [], 'tasks': [], 'items': []}
            if path == '/api/settings': data = {'themeId': 'phosphor:arco:electric', 'uiScale': 1.1, 'onboardingComplete': True, 'enabledProviders': {'claude': True}, 'projectRoots': []}
            elif path == '/api/auth-status': data = {name: {'loggedIn': name == 'claude'} for name in ['claude','codex','ollama','cursor','strata','deepseek','llamacpp','lmstudio','github']}
            elif path == '/api/installation-history': data = {'used': True}
            elif path == '/api/projects': data = {'projects': [], 'roots': [], 'organization': True}
            elif path == '/api/outputs': data = {'outputs': [o for o in state['outputs'] if o['workflowId'] in ([A,B] if query.get('clusterId') else query.get('workflowId',[]))]}
            elif path in ['/api/file-content', '/api/outputs/content']:
                data = {'type': 'text', 'content': state['text'], 'size': len(state['text'])} if query.get('id') in [['b'*32],['7'*32]] else {'type':'image', 'dataUrl':'data:image/png;base64,'+base64.b64encode(PNG).decode(), 'size':len(PNG)}
            elif path == '/api/outputs/file':
                await route.fulfill(body=PNG, content_type='image/png'); return
            elif path == '/api/media/raw':
                await route.fulfill(body=wav.getvalue(), content_type='audio/wav'); return
            elif path == '/api/outputs/transfer':
                body = req.post_data_json
                if body['destination'].endswith('collision.png'):
                    await route.fulfill(status=409, json={'error':'A file already exists at the destination. Choose another name.'}); return
                original = next(o for o in state['outputs'] if o['id'] == body['id'])
                if body['action'] == 'move': original['path'] = body['destination']
                else: state['outputs'].append({**original, 'id':'9'*32, 'path':body['destination'], 'name':body['destination'].split('/')[-1], 'title':body['destination'].split('/')[-1], 'derivedFrom':original['id']})
                data = {'ok':True}
            elif path == '/api/outputs/text': state['text'] = req.post_data_json['content']; data = {'ok':True}
            elif path == '/api/list-dirs': data = {'parent':query.get('path',['/projects'])[0] or '/projects', 'dirs':[]}
            elif path == '/api/update-check': data = {'current':'0.1.0','latest':None,'enabled':False,'updateAvailable':False}
            elif path == '/api/app/version': data = {'version':'0.1.0'}
            elif path.endswith('/catalog'): data = {'models':[]}
            await route.fulfill(json=data)
        await context.route('**/api/**', api)
        await context.route('https://**/*', lambda route: route.abort())
        await context.route('**/healthz', lambda route: route.fulfill(json={'status':'live'}))
        await context.route_web_socket('**/*', lambda ws: ws.on_message(lambda msg: state['frames'].append(json.loads(msg))))
        page = await context.new_page(); errors = []
        page.on('pageerror', lambda err: errors.append(str(err)))
        await page.goto(URL); await page.locator('#home-title').wait_for()
        await page.evaluate('''async ({a,b,cwd}) => {
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          const config = {primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',skipPermissions:false};
          s.getState().createJob(a,{...config,name:'Producer A',workingDirectory:cwd},undefined,undefined,true);
          s.getState().createJob(b,{...config,name:'Other active tab',workingDirectory:'/work/other'},undefined,undefined,true);
          s.setState({connected:true,connectionState:'online'}); s.getState().setActiveJob(b);
          s.getState().enqueueArtifact({workflowId:a,artifactId:'generated-fixture',kind:'image',title:'Generated illustration',path:'generated.png',openInEditor:true});
        }''', {'a':A,'b':B,'cwd':CWD})
        await page.get_by_role('button', name='View in Outputs', exact=True).wait_for()
        await page.keyboard.press('Escape')
        await expect(page.get_by_role('button', name='View in Outputs', exact=True)).to_have_count(0)
        await page.evaluate('''async a => { const {useAppStore:s} = await import('/src/stores/appStore.ts'); s.getState().enqueueArtifact({workflowId:a,artifactId:'generated-fixture',kind:'image',title:'Generated illustration',path:'generated.png',openInEditor:true}); }''', A)
        await page.get_by_role('button', name='View in Outputs', exact=True).click()
        panel = page.get_by_role('region', name='Workspace Outputs', exact=True)
        await expect(panel.get_by_text('Generated illustration', exact=True)).to_be_visible()
        assert await page.evaluate("async () => (await import('/src/stores/appStore.ts')).useAppStore.getState().activeJobId") == A
        await page.reload(); await page.wait_for_timeout(600)
        # Narrow standalone mount keeps the global existing media host while a
        # different job is active. Every row still carries the producing context.
        await page.evaluate('''async ({a,b,cwd}) => {
          const React = (await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot} = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {OutputsPanel} = await import('/src/components/RightPanel/OutputsPanel.tsx');
          const {useAppStore:s} = await import('/src/stores/appStore.ts');
          if (!s.getState().jobs[b]) s.getState().createJob(b,{name:'Other active tab',workingDirectory:'/work/other',primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',skipPermissions:false},undefined,undefined,true);
          s.getState().setActiveJob(b); document.getElementById('root').style.display='none';
          const host = document.createElement('div'); host.id='outputs-fixture'; host.style.cssText='position:fixed;left:8px;top:8px;width:310px;height:calc(96vh / var(--ui-scale,1));background:var(--color-bg-panel)'; document.body.append(host);
          window.__outputsRoot=createRoot(host); window.__outputsRoot.render(React.createElement(OutputsPanel,{cwd,workflowId:a}));
        }''', {'a':A,'b':B,'cwd':CWD})
        panel = page.get_by_role('region', name='Workspace Outputs', exact=True)
        await expect(panel.get_by_text('Generated illustration', exact=True)).to_be_visible()
        await panel.get_by_label('Output type', exact=True).select_option('audio')
        await expect(panel.get_by_text('sound.wav', exact=True).first).to_be_visible()
        await expect(panel.get_by_text('Generated illustration', exact=True)).to_have_count(0)
        await panel.get_by_label('Output type', exact=True).select_option('all')
        await panel.get_by_label('Search outputs', exact=True).fill('report')
        await expect(panel.get_by_role('listitem')).to_have_count(1)
        await panel.get_by_role('button', name='Open in editor', exact=True).click()
        await page.locator('.cm-content').fill('Edited synthetic report')
        await page.get_by_role('button', name='SAVE', exact=True).click()
        await expect(page.get_by_role('button', name='EDIT', exact=True)).to_be_visible()
        assert state['writes'][-1][0] == '/api/outputs/text' and state['writes'][-1][1]['workflowId'] == A
        await page.keyboard.press('Escape')
        await panel.get_by_label('Search outputs', exact=True).fill('')
        image = panel.get_by_role('listitem').filter(has=page.get_by_text('Generated illustration', exact=True))
        await image.get_by_role('button', name='Preview', exact=True).click()
        assert await page.evaluate("async () => (await import('/src/stores/appStore.ts')).useAppStore.getState().mediaStudio.context.workflowId") == A
        await page.keyboard.press('Escape')
        async def destination(action, name):
            await image.get_by_role('button', name=action, exact=True).click()
            dialog = page.get_by_role('dialog', name='Save a copy' if action == 'Save a copy' else 'Move output', exact=True)
            await dialog.get_by_label('Browse folder path', exact=True).fill('/exports')
            await dialog.get_by_label('Browse folder path', exact=True).press('Enter')
            await dialog.get_by_placeholder('filename (blank = auto; the op sets the extension)', exact=True).fill(name)
            await dialog.get_by_role('button', name='Review destination', exact=True).click()
            await expect(dialog).to_contain_text('/exports/' + name)
            return dialog
        dialog = await destination('Save a copy', 'copy.png'); await dialog.get_by_role('button', name='Save copy', exact=True).click()
        await expect(dialog).to_have_count(0)
        assert next(o for o in state['outputs'] if o['id'] == 'a'*32)['path'] == CWD + '/generated.png'
        dialog = await destination('Move', 'collision.png'); await dialog.get_by_role('button', name='Move output', exact=True).click()
        await expect(dialog.get_by_role('alert')).to_contain_text('already exists')
        await dialog.get_by_role('button', name='Cancel', exact=True).click()
        dialog = await destination('Move', 'moved.png'); await dialog.get_by_role('button', name='Move output', exact=True).click()
        await expect(dialog).to_have_count(0)
        await expect(image).to_contain_text('/exports/moved.png')
        for scale in [1.1,1.5]:
            await page.evaluate('value => {document.documentElement.style.zoom=String(value);document.documentElement.style.setProperty("--ui-scale",String(value));}',scale)
            await panel.get_by_label('Search outputs', exact=True).focus()
            await expect(panel.get_by_label('Search outputs', exact=True)).to_be_focused()
            assert await panel.evaluate('el=>el.scrollWidth<=el.clientWidth+1')
            await panel.get_by_role('list',name='Outputs',exact=True).evaluate('el=>el.parentElement.scrollTop=0')
            await page.screenshot(path=str(ART/f'outputs-narrow-{round(scale*100)}.png'))
        dialog = await destination('Save a copy', 'review-only.png')
        assert await dialog.evaluate('el=>el.getBoundingClientRect().top>=0 && el.getBoundingClientRect().bottom<=innerHeight+1')
        await page.keyboard.press('Escape'); await expect(dialog).to_have_count(0)
        state['outputs'].append(output('7','member-notes.txt','documents', workflowId=B, cwd='/work/other', producer='Member B', path='/work/other/member-notes.txt', originPath='/work/other/member-notes.txt'))
        state['outputs'].append(output('8','unrelated.txt','documents', workflowId='unrelated-workflow', producer='Unrelated workflow'))
        await page.evaluate('''async ({a,b,cwd}) => {
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {ClusterFilesTabBody}=await import('/src/components/RightPanel/FilesTab.tsx');
          window.__outputsRoot.render(React.createElement(ClusterFilesTabBody,{cluster:{clusterId:'fixture-cluster',cwd,members:[{workflowId:a,displayName:'Producer A'},{workflowId:b,displayName:'Member B'}]},subTab:'outputs',onSubTab:()=>{}}));
        }''', {'a':A,'b':B,'cwd':CWD})
        panel=page.get_by_role('region',name='Workspace Outputs',exact=True)
        member=panel.get_by_role('listitem').filter(has=page.get_by_text('member-notes.txt',exact=True))
        await expect(member).to_contain_text('Member B')
        await expect(panel.get_by_text('unrelated.txt',exact=True)).to_have_count(0)
        await member.get_by_role('button',name='Preview',exact=True).click()
        request=next(q for path,q in reversed(state['requests']) if path=='/api/outputs/content')
        assert request['workflowId']==[B] and request['cwd']==['/work/other']
        await page.keyboard.press('Escape')
        await page.screenshot(path=str(ART/'outputs-cluster-150.png'))
        assert not any(f.get('type') in ['create_workflow','send_prompt','create_cluster'] for f in state['frames'])
        assert not errors, errors
        await context.close(); await browser.close()
        print('PASS: modal close/reopen, View in Outputs, reload, filters/search, wrong-active-tab context, existing text/image viewers, copy/move/collision, keyboard and narrow110/150%, cluster attribution/exclusion; no provider calls')

asyncio.run(main())
