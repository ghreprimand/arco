"""Guided Connections against the REAL server routes (no route fixtures for status, check or settings).

Isolated server (throwaway HOME and folders, provider-CLI stubs, empty network namespace where available),
an in-process Ollama-protocol fixture as the only model endpoint, no credentials, no real model. Reuses the
isolated fixtures in connections-browser.py; needs Playwright and a built client/dist.

Scenarios:
  1  Test connection on a local runtime goes through POST /api/connections/check and reports the fixture
     runtime; the secrets in the server environment never reach the page
  2  an endpoint saved in Connections is persisted by the real settings route (survives a reload) and a
     dead address is reported as needing attention without losing the draft or other settings
  3  Disable / Enable provider persist through the real settings route and a disabled provider cannot be
     checked (no check request is sent), while its card stays discoverable
  4  a deep link opens the named connection; closing returns focus and clears the address
"""
import asyncio
import importlib.util
import json
import re
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('workbench_harness', HERE / 'connections-browser.py')
h = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(h)

SECRET = 'SYNTHETIC-CONNECTIONS-DO-NOT-DISPLAY-0001'


class Server(h.IsolatedServer):
    def extra_env(self):
        return {'OPENAI_API_KEY': SECRET}


async def open_connections(playwright, server, provider):
    b = h.Browser(playwright, server)
    page = await b.open()
    await page.evaluate(f"location.hash = '#connections/{provider}'")
    dialog = page.get_by_role('dialog', name=re.compile('Connections'))
    await dialog.wait_for(timeout=15000)
    return b, page, dialog


async def checks(page):
    return await page.evaluate("() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/connections/check')).length")


def settings(server):
    return json.loads((server.home / '.arco' / 'settings.json').read_text())


async def scenario_real_check(playwright, server):
    b, page, dialog = await open_connections(playwright, server, 'ollama')
    try:
        detail = dialog.get_by_role('region', name='Ollama connection')
        await detail.wait_for()
        await detail.get_by_role('button', name='Test connection').click()
        await page.wait_for_function("() => document.body.innerText.includes('Status refreshed')", timeout=20000)
        assert 'Runtime detected' in await detail.inner_text(), await detail.inner_text()
        assert await checks(page) >= 1, 'the explicit check did not use the check route'
        assert SECRET not in await page.content(), 'a server environment secret reached the page'
        await dialog.get_by_role('button', name=re.compile('^Codex')).click()
        note = await dialog.get_by_role('region', name='Codex connection').inner_text()
        assert 'OPENAI_API_KEY is present' in note, 'the presence of the key is not reported'
        assert SECRET not in await page.content()
    finally:
        await b.close()


async def scenario_endpoint_persist(playwright, server):
    b, page, dialog = await open_connections(playwright, server, 'ollama')
    try:
        before = settings(server)
        field = dialog.get_by_label('Model server address')
        original = await field.input_value()
        dead = 'http://127.0.0.1:9'
        await field.fill(dead)
        await dialog.get_by_role('button', name='Save endpoint').click()
        await dialog.get_by_text('Endpoint saved').wait_for(timeout=10000)
        saved = settings(server)
        assert saved['ollama']['baseUrl'] == dead, saved.get('ollama')
        # The settings route normalises the file (it fills in provider defaults); nothing previously set may change.
        lost = {k: v for k, v in before.items() if k not in ('ollama', 'enabledProviders') and saved.get(k) != v}
        flipped = {k: v for k, v in before.get('enabledProviders', {}).items() if saved['enabledProviders'].get(k) != v}
        assert not lost and not flipped, f'saving an endpoint changed other settings: {lost} {flipped}'
        await dialog.get_by_role('region', name='Ollama connection').get_by_role('button', name='Test connection').click()
        await page.wait_for_function("() => document.body.innerText.includes('Status refreshed')", timeout=30000)
        state = await dialog.get_by_role('region', name='Ollama connection').locator('p[role="status"]').first.inner_text()
        assert state in ('Needs attention', 'Status unknown'), state
        # Credential-bearing and indirect addresses are refused in the guided editor and kept untouched.
        await field.fill('http://user:pw@127.0.0.1:9')
        await dialog.get_by_role('button', name='Save endpoint').click()
        await dialog.get_by_text('without credentials').wait_for(timeout=5000)
        assert settings(server)['ollama']['baseUrl'] == dead, 'a refused address changed the stored endpoint'
        assert await field.input_value() == 'http://user:pw@127.0.0.1:9', 'the draft was lost'
        await field.fill(original)
        await dialog.get_by_role('button', name='Save endpoint').click()
        await dialog.get_by_text('Endpoint saved').wait_for(timeout=10000)
        await page.reload()
        await page.get_by_text('ONLINE', exact=True).wait_for(timeout=30000)
        assert settings(server)['ollama']['baseUrl'] == original
    finally:
        await b.close()


async def scenario_enable_disable(playwright, server):
    b, page, dialog = await open_connections(playwright, server, 'lmstudio')
    try:
        detail = dialog.get_by_role('region', name='LM Studio connection')
        await detail.get_by_role('button', name='Disable provider').click()
        await dialog.get_by_text('Provider disabled for new work').wait_for(timeout=10000)
        assert settings(server)['enabledProviders']['lmstudio'] is False
        assert await detail.get_by_role('button', name='Test connection').is_disabled(), 'a disabled provider can be checked'
        assert 'Disabled' in await dialog.get_by_role('button', name=re.compile('^LM Studio')).inner_text()
        sent = await checks(page)
        await detail.get_by_role('button', name='Enable provider').click()
        await dialog.get_by_text('Provider enabled').wait_for(timeout=10000)
        assert settings(server)['enabledProviders']['lmstudio'] is True
        assert await checks(page) == sent, 'toggling availability probed the provider'
    finally:
        await b.close()


async def scenario_deep_link_close(playwright, server):
    b = h.Browser(playwright, server)
    page = await b.open()
    try:
        opener = page.locator('[data-help="header.settings"]')
        await opener.focus()
        await page.evaluate("location.hash = '#connections/github'")
        dialog = page.get_by_role('dialog', name=re.compile('Connections'))
        await dialog.wait_for(timeout=15000)
        await dialog.get_by_role('region', name='GitHub CLI connection').wait_for()
        await page.keyboard.press('Escape')
        await page.wait_for_timeout(400)
        assert await page.get_by_role('dialog', name=re.compile('Connections')).count() == 0, 'Escape did not close Connections'
        assert not (await page.evaluate('location.hash')).startswith('#connections'), 'the address kept #connections'
        await page.reload()
        await page.get_by_text('ONLINE', exact=True).wait_for(timeout=30000)
        await page.wait_for_timeout(1000)
        assert await page.get_by_role('dialog', name=re.compile('Connections')).count() == 0, 'Connections reopened after reload'
    finally:
        await b.close()


async def main():
    if not (h.REPO / 'client' / 'dist' / 'index.html').exists():
        sys.exit('client/dist is missing; run npm run build first')
    model = h.FakeModel()
    server = Server(model.url)
    failures = []
    try:
        async with h.async_playwright() as playwright:
            for label, run in (
                ('Test connection uses the check route; environment secrets never reach the page', lambda: scenario_real_check(playwright, server)),
                ('an endpoint saved in Connections persists; refused addresses keep the draft', lambda: scenario_endpoint_persist(playwright, server)),
                ('Disable and Enable persist and a disabled provider is never checked', lambda: scenario_enable_disable(playwright, server)),
                ('a deep link opens the named connection and closing clears the address', lambda: scenario_deep_link_close(playwright, server)),
            ):
                if len(sys.argv) > 1 and sys.argv[1].lower() not in label.lower():
                    continue
                try:
                    await asyncio.wait_for(run(), 150)
                    print(f'PASS: {label}')
                except BaseException as error:
                    failures.append(label)
                    where = traceback.extract_tb(error.__traceback__)[-1] if error.__traceback__ else None
                    print(f'FAIL: {label}: {type(error).__name__}: {str(error)[:600]}' + (f' (connections-real-routes-browser.py:{where.lineno})' if where else ''))
    finally:
        server.close()
        model.close()
    if failures:
        sys.exit(f'connections real-route acceptance failed: {len(failures)}')
    print('PASS: connections real-route acceptance')


asyncio.run(main())
