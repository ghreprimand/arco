"""Fail when visible Settings text has no theme color of its own.

Real App and SettingsPanel against Vite, fixture-only network. Every Settings
page is opened in a Classic and a Phosphor theme, with the local-model panels
(Ollama, llama.cpp, LM Studio, DeepSeek, Strata), built-in skills and the
notification settings filled from fixtures. Text that only inherits the page
default color is found by giving <body> a sentinel color: any visible text that
takes it on has no color from the theme. Where the page default is not one of
the theme's accent or muted colors (Phosphor's plain text color, near white in
most palettes), text set to that default color explicitly is reported too.
"""
import asyncio, os
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from browser_navigation import install_navigation_defaults

install_navigation_defaults()

PORT = os.environ.get('ARCO_CLIENT_PORT', '5255')
PAGES = ['Appearance', 'Projects', 'Providers and models', 'Agents and clusters', 'Voice', 'Notifications', 'Files and media', 'Advanced']
PROVIDERS = ['claude', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'github']

PROBE = r'''() => {
  const body = document.body;
  const SENTINEL = 'rgb(1, 2, 3)';
  const pageDefault = getComputedStyle(body).color;
  const token = (name) => { const t = document.createElement('span'); t.style.color = `var(${name})`; body.append(t); const c = getComputedStyle(t).color; t.remove(); return c; };
  const themed = ['--color-accent-primary', '--color-accent-primary-dim', '--color-accent-secondary', '--color-accent-secondary-dim', '--color-fg-muted'].map(token);
  const plainDefault = themed.includes(pageDefault) ? null : pageDefault;
  body.style.setProperty('color', SENTINEL, 'important');
  try {
    const dialog = document.querySelector('.settings-dialog');
    if (!dialog) return ['no settings dialog'];
    const out = [];
    for (const el of dialog.querySelectorAll('*')) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
      if (!own || !el.getClientRects().length) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') continue;
      if (st.color !== SENTINEL && st.color !== plainDefault) continue;
      const where = el.closest('[data-settings-section]')?.getAttribute('data-settings-section') || el.closest('[data-help]')?.getAttribute('data-help') || '';
      out.push(`${where}: <${el.tagName.toLowerCase()}> ${own.slice(0, 70)}`);
    }
    return out;
  } finally { body.style.removeProperty('color'); }
}'''


async def main():
    assert PORT != '3001'
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000})
        settings = {'themeId': 'matrix', 'enabledProviders': {name: True for name in PROVIDERS if name != 'github'}, 'onboardingComplete': True, 'projectRoots': []}
        errors = []

        async def api(route):
            nonlocal settings
            req = route.request; path = urlparse(req.url).path
            if req.method != 'GET':
                if path == '/api/settings': settings = {**settings, **(req.post_data_json or {})}
                await route.fulfill(json=settings if path == '/api/settings' else {'ok': True}); return
            data = {'files': [], 'entries': [], 'workflows': [], 'projects': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'tasks': [], 'sessions': [], 'messages': []}
            if path == '/api/settings': data = settings
            elif path == '/api/auth-status': data = {name: {'loggedIn': True, 'installed': True, 'cliInstalled': True} for name in PROVIDERS}
            elif path == '/api/capabilities': data = {'efforts': ['low', 'medium', 'high'], 'models': ['fixture-model'], 'cliVersion': 'fixture'}
            elif path == '/api/usage': data = {'available': False}
            elif path.endswith('/catalog'): data = {'models': []}
            elif path == '/api/project-trust': data = {'entries': [], 'defaultProjectTrust': 'ask'}
            elif path == '/api/skills': data = {'project': [], 'global': [
                {'scope': 'global', 'slug': 'fixture-skill', 'name': 'Fixture skill', 'description': 'A user skill.', 'operatorOnly': False}],
                'builtin': [
                {'slug': 'architecture-review', 'name': 'Architecture review', 'description': 'Operator-run review.', 'scope': 'builtin', 'operatorOnly': True},
                {'slug': 'tdd', 'name': 'tdd', 'description': 'Model-invoked test-first work.', 'scope': 'builtin', 'operatorOnly': False, 'off': True},
                {'slug': 'grill-me', 'name': 'grill-me', 'description': 'Replaced by a copy.', 'scope': 'builtin', 'operatorOnly': True, 'replaced': True}]}
            elif path == '/api/deepseek': data = {'managed': False, 'baseUrl': 'http://127.0.0.1:8150/v1', 'profiles': [
                {'id': 'exact', 'label': 'Exact', 'model': 'deepseek-fixture', 'serviceState': 'active', 'loaded': True, 'capabilities': {'vision': False}},
                {'id': 'light', 'label': 'Light', 'model': 'deepseek-fixture', 'serviceState': 'inactive', 'loaded': False}], 'live': None}
            elif path == '/api/notification-channels': data = {'desktop': {'finished': True, 'failed': False, 'waiting': False}, 'phone': {'finished': False, 'failed': False, 'waiting': False}, 'phoneText': False, 'clusterFinished': 'director', 'ntfy': {'server': 'https://ntfy.example', 'topic': 'fixture', 'tokenSet': False}, 'ntfyFromEnvironment': False}
            elif path == '/api/list-dirs': data = {'dirs': [], 'path': '/demo', 'parent': '/'}
            elif path == '/api/handoff-prompts':
                modes = ['original-worker', 'fresh-summarizer', 'ollama-compaction']
                data = {'defaults': {m: 'Fixture handoff prompt' for m in modes}, 'global': {m: None for m in modes}, 'project': {m: None for m in modes}, 'effective': {m: {'source': 'default', 'sourcePath': None} for m in modes}}
            await route.fulfill(json=data)

        await context.route('**/api/**', api)
        await context.route('**/healthz', lambda r: r.fulfill(json={'status': 'live'}))
        await context.route('https://**/*', lambda r: r.abort())
        await context.route_web_socket('**/*', lambda ws: None)
        page = await context.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(f'http://127.0.0.1:{PORT}/')
        await page.wait_for_timeout(800)
        await page.evaluate("async () => { window.testStore = (await import('/src/stores/appStore.ts')).useAppStore; }")
        await page.evaluate("testStore.setState({connected: true, connectionState: 'connected'})")
        await page.wait_for_function('() => testStore.getState().settings !== null')

        found = []
        for theme in ['matrix', 'phosphor:arco:electric']:
            await page.evaluate('(id) => testStore.getState().setThemeId(id)', theme)
            await page.evaluate('testStore.getState().setShowSettings(true)')
            dialog = page.get_by_role('dialog', name='Settings')
            await expect(dialog).to_be_visible()
            nav = dialog.get_by_role('navigation', name='Settings categories')
            for label in PAGES:
                await nav.get_by_role('button', name=label, exact=False).first.click()
                await page.wait_for_timeout(250)
                if label == 'Agents and clusters':
                    await expect(dialog.get_by_test_id('builtin-skill-row').first).to_be_visible()
                if label == 'Providers and models':
                    await expect(dialog.get_by_text('XOLOTL · DEEPSEEK')).to_be_visible()
                if label == 'Notifications':
                    await expect(dialog.get_by_text('PHONE (NTFY)')).to_be_visible()
                found += [f'{theme} / {label} / {row}' for row in await page.evaluate(PROBE)]
            await dialog.get_by_role('button', name='Close settings', exact=True).click()

        assert not found, 'Settings text without a theme color:\n' + '\n'.join(found)
        assert not errors, errors
        await browser.close()
        print('PASS: every Settings page, Classic and Phosphor, local-model panels, built-in skills and notifications: all visible text has a theme color')


if __name__ == '__main__':
    asyncio.run(main())
