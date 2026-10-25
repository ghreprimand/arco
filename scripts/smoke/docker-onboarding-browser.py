"""Connections sign-in against an isolated container and provider CLI fixture."""
import asyncio
import os
from playwright.async_api import async_playwright
from urllib.parse import urlparse

async def main():
    base = os.environ['ARCO_SMOKE_BASE_URL']
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        context = await browser.new_context(permissions=['clipboard-read', 'clipboard-write'])
        async def local_only(route):
            if urlparse(route.request.url).netloc == urlparse(base).netloc:
                await route.continue_()
            else:
                await route.abort()
        await context.route('http**://**/*', local_only)
        page = await context.new_page()
        await page.goto(base)
        await page.get_by_text('ONLINE', exact=True).wait_for(timeout=30000)
        original = await (await context.request.get(base + '/api/settings')).json()
        try:
            enabled = {key: False for key in original['enabledProviders']}
            enabled['codex'] = True
            assert (await context.request.post(base + '/api/settings', data={'enabledProviders': enabled})).status == 200
            await page.reload()
            banner = page.get_by_role('region', name='Provider connection status')
            await banner.wait_for(timeout=30000)
            assert await page.get_by_text('NO PROVIDER CONNECTED YET', exact=True).count() == 0
            await page.get_by_text('CONTAINER FIXTURE').first.wait_for()
            await banner.get_by_role('button', name='CONNECT A PROVIDER', exact=True).click()
            dialog = page.get_by_role('dialog', name='Connections', exact=True)
            await dialog.get_by_role('navigation', name='Connections').get_by_role('button', name='Codex', exact=False).click()
            region = dialog.get_by_role('region', name='Codex connection')
            await region.get_by_role('button', name='Sign in to Codex', exact=True).click()
            await region.get_by_text('ARCO-FIXTURE-CODE', exact=True).wait_for(timeout=15000)
            assert await region.get_by_role('link', name='OPEN SIGN-IN PAGE', exact=False).get_attribute('href') == 'https://auth.example.test/codex/device'
            await region.get_by_role('button', name='COPY CODE', exact=True).click()
            assert await page.evaluate('navigator.clipboard.readText()') == 'ARCO-FIXTURE-CODE'
            await region.get_by_role('button', name='PREFER A TERMINAL?', exact=True).click()
            await region.get_by_text('docker compose exec arco codex login --device-auth', exact=True).wait_for()
            await region.get_by_text('Signed in to Codex.', exact=False).wait_for(timeout=30000)
            print('PASS: container saved workspace remains available; Connections relays device link/code and Docker terminal fallback')
        finally:
            await context.request.post(base + '/api/settings', data={'enabledProviders': original['enabledProviders']})
            await browser.close()

if __name__ == '__main__':
    asyncio.run(main())
