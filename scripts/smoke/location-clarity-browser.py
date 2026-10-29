"""Location duplicate/rename feedback and clarity against an isolated real server."""
import asyncio
import importlib.util
import os
import json
import re
from pathlib import Path
from playwright.async_api import async_playwright, expect
spec=importlib.util.spec_from_file_location('clarity_harness',Path(__file__).with_name('connections-browser.py'))
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
ART=Path(os.environ.get('ARCO_LOCATION_VISUAL_ARTIFACTS','/tmp/arco-location-clarity-settings'))
class Server(h.IsolatedServer):
    def extra_settings(self):
        work=self.root/'work'; personal=self.root/'personal'
        work.mkdir(); personal.mkdir()
        (work/'alpha').mkdir(); (personal/'notes').mkdir()
        alias=self.root/'work-alias'; alias.symlink_to(work,target_is_directory=True)
        return {'defaultWorkingDirectory':'','projectRoots':[{'name':'Work','path':str(work)},{'name':'Personal','path':str(personal)}],'projects':[],'onboardingComplete':True}

async def main():
    ART.mkdir(parents=True,exist_ok=True)
    server=Server(f'http://127.0.0.1:{h.host_isolation.closed_port()}'); b=None
    try:
        async with async_playwright() as p:
            b=h.Browser(p,server); page=await b.open()
            await page.goto(server.base+'/#settings/projects/projects')
            for scale in [1.1,1.5]:
                await page.request.post(server.base+'/api/settings',data={'uiScale':scale})
                await page.reload()
                await page.get_by_role('button',name='Add location',exact=True).wait_for()
                assert await page.get_by_label('Location name',exact=True).count()==0
                assert not await page.locator('.saved-project-management').evaluate('el=>el.open')
                assert not await page.locator('.advanced-folder-options').evaluate('el=>el.open')
                await page.screenshot(path=str(ART/f'locations-settings-{round(scale*100)}.png'))
                bookmarks=page.locator('.saved-project-management')
                await bookmarks.locator('summary').first.click()
                await expect(bookmarks.locator('summary').first).to_have_text('Bookmarked folders (0)')
                await expect(bookmarks.get_by_text('SAVED PROJECT FOLDERS',exact=True)).to_have_count(0)
                await expect(bookmarks).to_contain_text('Bookmarks are optional.')
                await expect(bookmarks).to_contain_text('already appear automatically')
                await expect(bookmarks).to_contain_text('do not control saved chats or files')
                await expect(bookmarks.get_by_role('button',name='Bookmark folder',exact=True).first).to_be_visible()
                await bookmarks.scroll_into_view_if_needed()
                await page.screenshot(path=str(ART/f'bookmarked-settings-{round(scale*100)}.png'))
                await bookmarks.locator('summary').first.click()
            add=page.get_by_role('button',name='Add location',exact=True)
            if await add.count(): await add.click()
            name=page.get_by_label(re.compile('^(Root|Location) name$'))
            path=page.get_by_label(re.compile('^(Root|Location) folder path$'))
            await name.fill('Main'); await path.fill(str(server.root/'work'))
            await page.get_by_role('button',name=re.compile('^Add (root|location)$')).click()
            await expect(page.get_by_role('alert')).to_contain_text('Work')
            await expect(name).to_have_value('Main')
            await page.screenshot(path=str(ART/'duplicate-location-150.png'))
            await page.get_by_role('button',name='Rename Work to Main',exact=True).click()
            await expect(page.get_by_role('status').filter(has_text='Renamed location')).to_contain_text('Main')
            await expect(page.get_by_role('button',name='Edit location Main',exact=True)).to_be_visible()
            await page.screenshot(path=str(ART/'renamed-location-150.png'))
            await page.get_by_role('button',name='Close settings',exact=True).click()
            await expect(page.locator('section[aria-labelledby="home-group-root-0"]').get_by_role('heading')).to_contain_text('Main')
            await page.get_by_role('button',name=re.compile('SETTINGS')).click()
            await page.get_by_role('button',name='Projects',exact=True).click()
            await page.reload()
            await expect(page.get_by_role('button',name='Edit location Main',exact=True)).to_be_visible()
            assert await page.get_by_label('Location name',exact=True).count()==0
            await page.get_by_role('button',name='Add location',exact=True).click()
            name=page.get_by_label('Location name',exact=True); path=page.get_by_label('Location folder path',exact=True)
            await name.fill('Main alias'); await path.fill(str(server.root/'work-alias'))
            await page.get_by_role('button',name='Add location',exact=True).click()
            await expect(page.get_by_role('alert')).to_contain_text('Main')
            await expect(name).to_have_value('Main alias')
            await page.get_by_role('button',name='Rename Main to Main alias',exact=True).click()
            await expect(page.get_by_role('button',name='Edit location Main alias',exact=True)).to_be_visible()
            await page.get_by_role('button',name='Edit location Main alias',exact=True).click()
            await page.get_by_label('Location folder path',exact=True).fill(str(server.root/'personal'))
            await page.get_by_role('button',name='Save location',exact=True).click()
            await expect(page.get_by_role('alert')).to_contain_text('both locations are unchanged')
            await expect(page.get_by_label('Location name',exact=True)).to_have_value('Main alias')
            roots=(await (await page.request.get(server.base+'/api/settings')).json())['projectRoots']
            assert roots==[{'name':'Main alias','path':str(server.root/'work')},{'name':'Personal','path':str(server.root/'personal')}]
            await page.get_by_role('button',name='Cancel',exact=True).click()
            print('PASS: duplicate and alias adds preserve drafts, explicit rename survives reload, edit collision preserves both locations')
            await page.get_by_role('button',name='Run setup again',exact=True).click()
            await page.get_by_role('button',name='Get started',exact=True).click()
            for scale in [1.1,1.5]:
                await page.evaluate('value=>{document.documentElement.style.zoom=String(value);document.documentElement.style.setProperty("--ui-scale",String(value));}',scale)
                await page.locator('.first-run-dialog').evaluate('el=>el.scrollTop=0')
                await page.screenshot(path=str(ART/f'locations-setup-{round(scale*100)}.png'))
                assert await page.locator('.first-run-dialog').evaluate('el=>el.getBoundingClientRect().bottom<=innerHeight+1 && el.getBoundingClientRect().top>=0')
                assert await page.get_by_role('button',name='Continue',exact=True).evaluate('el=>el.getBoundingClientRect().bottom<=innerHeight+1 && el.getBoundingClientRect().top>=0')
            await page.get_by_label('Location name',exact=True).fill('Setup Main')
            await page.get_by_label('Location folder path',exact=True).fill(str(server.root/'work-alias'))
            await page.get_by_role('button',name='Add location',exact=True).click()
            await expect(page.get_by_role('alert')).to_contain_text('Main alias')
            await expect(page.get_by_label('Location name',exact=True)).to_have_value('Setup Main')
            await page.get_by_role('button',name='Rename Main alias to Setup Main',exact=True).click()
            await expect(page.get_by_label('Setup folder choices',exact=True).get_by_text('Setup Main',exact=True)).to_be_visible()
            await page.get_by_role('button',name='Continue',exact=True).click()
            await page.get_by_role('button',name='SKIP FOR NOW',exact=True).click()
            await page.get_by_role('button',name='Go to Home',exact=True).click()
            roots=(await (await page.request.get(server.base+'/api/settings')).json())['projectRoots']
            assert len(roots)==2 and roots[0]['name']=='Setup Main'
            await page.get_by_role('button',name='Add project location',exact=True).click()
            dialog=page.get_by_role('dialog',name='Add project location',exact=True)
            await dialog.get_by_label('Location name',exact=True).fill('Draft')
            await dialog.get_by_label('Location folder path',exact=True).fill('relative-location')
            await dialog.get_by_role('button',name='Add location',exact=True).click()
            await expect(dialog.get_by_role('alert')).to_be_visible()
            await page.keyboard.press('Tab')
            assert await dialog.evaluate('el=>el.contains(document.activeElement)')
            await page.keyboard.press('Escape')
            await expect(dialog).to_have_count(0)
            assert not any(__import__('json').loads(frame).get('type') in ['create_workflow','create_cluster','send_prompt'] for frame in await page.evaluate('window.__sent'))
            assert not b.errors,b.errors
            print('PASS: setup uses identical duplicate feedback and explicit rename without launching work')

    finally:
        if b: await b.close()
        server.close()

asyncio.run(main())
