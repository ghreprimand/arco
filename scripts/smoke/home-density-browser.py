"""Home density bounds: open-work rows and project-group limits. Synthetic fixtures only; no server or provider access."""
import asyncio
import json
import os
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect

URL = 'http://127.0.0.1:' + os.environ.get('ARCO_CLIENT_PORT', '5207') + '/'
IDS = ['claude', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'github']
LONG = ('An unusually long open work title that must truncate instead of growing its card ' * 3).strip()
ROOTS = [{'name': 'Work', 'path': '/projects', 'exists': True}]
STORE = "const{useAppStore:s}=await import('/src/stores/appStore.ts');"


def folder(name, path, index, **extra):
    return {'id': f'00000000-0000-4000-8000-{index:012}', 'name': name, 'path': path, 'source': 'registered', 'exists': True, **extra}


PROJECTS = (
    [folder(f'pinned-{i:02}', f'/projects/pinned-{i:02}', i, pinned=True, rootPath='/projects') for i in range(12)]
    + [folder(f'bookmark-{i:02}', f'/elsewhere/bookmark-{i:02}', 100 + i) for i in range(15)]
    + [{'name': f'scan-{i:02}', 'path': f'/projects/scan-{i:02}', 'source': 'scanned', 'exists': True, 'rootPath': '/projects'} for i in range(9)]
)


async def set_work(page, count):
    await page.evaluate("async ([count, long]) => {" + STORE + """
      for (const id of Object.keys(s.getState().jobs)) s.getState().removeJob(id);
      const base = Date.now() - 1000000;
      for (let i = 0; i < count; i++) {
        const id = `work-${i}`;
        s.getState().createJob(id, {name: i === 1 ? long : `Work item ${String(i).padStart(2, '0')}`, primaryProvider:'claude', primaryModel:'sonnet', primaryEffort:'low', workingDirectory: `/projects/pinned-0${i % 3}`, skipPermissions:false}, undefined, undefined, true);
        s.setState(st => ({ jobs: { ...st.jobs, [id]: { ...st.jobs[id], messages: [{ id: `m-${i}`, role: 'user', content: 'x', timestamp: base + i * 1000 }] } } }));
      }
      s.getState().showHomeView();
    }""", [count, LONG])


async def check(browser, scale, width):
    context = await browser.new_context(viewport={'width': width, 'height': 800})
    await context.add_init_script(f"localStorage.setItem('arco_ui_scale', '{scale}');")
    errors, writes, messages = [], [], []

    async def api(route):
        request = route.request
        path = urlparse(request.url).path
        if request.method != 'GET':
            writes.append(path)
        data = {'files': [], 'workflows': [], 'projects': [], 'clusters': [], 'skills': [], 'plans': [], 'items': [], 'sessions': [], 'chats': [], 'tasks': []}
        if path == '/api/settings':
            data = {'themeId': 'phosphor:arco:electric', 'fontPackId': 'victor-mono', 'textBrightness': 30, 'uiScale': scale, 'projectRoots': ROOTS, 'onboardingComplete': True, 'enabledProviders': {'claude': True}}
        elif path == '/api/auth-status':
            data = {provider: {'loggedIn': provider == 'claude'} for provider in IDS}
        elif path == '/api/installation-history':
            data = {'used': True}
        elif path == '/api/projects':
            data = {'roots': ROOTS, 'projects': PROJECTS, 'organization': True, 'scanFolder': None, 'homeFolder': '/projects'}
        elif path == '/api/app/version':
            data = {'version': '0.1.0'}
        elif path == '/api/update-check':
            data = {'current': '0.1.0', 'latest': None, 'url': None, 'publishedAt': None, 'checkedAt': None, 'enabled': False, 'updateAvailable': False}
        elif path.endswith('/catalog'):
            data = {'models': []}
        elif path == '/api/capabilities':
            data = {'efforts': ['low'], 'models': ['sonnet'], 'cliVersion': 'fixture'}
        await route.fulfill(json=data)

    await context.route('**/api/**', api)
    await context.route('**/healthz', lambda route: route.fulfill(json={'status': 'live'}))
    await context.route('https://**/*', lambda route: route.abort())
    await context.route_web_socket('**/*', lambda ws: ws.on_message(lambda message: messages.append(json.loads(message))))
    page = await context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    await page.goto(URL)
    await page.locator('#home-title').wait_for()
    await page.evaluate("async () => {" + STORE + "s.setState({connected:true,connectionState:'online'}); }")
    await expect(page.locator('.home-project-group h3', has_text='Pinned')).to_be_visible()
    label = f'{round(scale * 100)}% {width}px'
    section = page.locator('section[aria-labelledby="home-open"]')

    columns = None
    for count in [1, 2, 5, 20]:
        await set_work(page, count)
        await expect(page.locator('#home-open .home-count')).to_have_text(f'({count})')
        columns = await page.locator('.home-work-probe').evaluate("el => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length")
        if width < 650:
            assert columns == 1, (label, columns)
        limit = 2 * columns
        cards = page.locator('.home-work-grid > li')
        await expect(cards).to_have_count(min(count, limit))
        rows = await cards.evaluate_all('els => els.map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.left), Math.round(r.width), Math.round(r.height)]; })')
        assert len({r[0] for r in rows}) <= 2, (label, count, rows)
        assert len({r[3] for r in rows}) == 1, (label, count, 'a long field changed a card height', rows)
        grid = await page.locator('.home-work-grid').evaluate('e => e.getBoundingClientRect().width')
        if count == 1:
            assert abs(rows[0][2] - grid) <= 2, (label, 'one card spans the row', rows, grid)
        if count == 2 and columns >= 2:
            assert rows[0][0] == rows[1][0] and abs(rows[0][2] - rows[1][2]) <= 2 and abs(rows[0][2] * 2 - grid) <= 30, (label, 'two cards split the row', rows, grid)
        names = await page.locator('.home-work-details strong').evaluate_all('els => els.map(e => e.textContent)')
        expected_first = LONG if count == 2 else f'Work item {count - 1:02}'
        assert names[0] == expected_first, (label, 'most recent first', names)
        if count == 2:
            long = page.locator('.home-work-details strong', has_text='An unusually long')
            assert await long.get_attribute('title') == LONG
            assert await long.evaluate('e => e.scrollWidth > e.clientWidth'), (label, 'long name truncates')
        toggle = section.locator('.home-show-all')
        if count <= limit:
            await expect(toggle).to_have_count(0)
            continue
        await expect(toggle).to_have_text(f'Show all {count}')
        await expect(toggle).to_have_attribute('aria-expanded', 'false')
        projects_top = await page.locator('#home-projects').evaluate('e => e.getBoundingClientRect().top')
        open_bottom = await page.locator('#home-open-list').evaluate('e => e.getBoundingClientRect().bottom')
        assert projects_top - open_bottom < 260, (label, 'Project locations stays close below two rows', projects_top, open_bottom)
        await toggle.focus()
        await page.keyboard.press('Enter')
        await expect(toggle).to_have_text('Show fewer')
        await expect(toggle).to_have_attribute('aria-expanded', 'true')
        await expect(toggle).to_be_focused()
        await expect(cards).to_have_count(count)
        box = await page.locator('#home-open-list').evaluate('e => ({client: e.clientHeight, scroll: e.scrollHeight, rect: e.getBoundingClientRect().height, view: innerHeight, cls: e.className, mh: getComputedStyle(e).maxHeight, ov: getComputedStyle(e).overflowY, ul: e.firstElementChild.getBoundingClientRect().height, n: e.querySelectorAll("li").length, cols: ' + str(columns) + '})')
        assert box['rect'] <= box['view'] * 0.6 + 2 and (count < 20 or box['scroll'] > box['client']), (label, 'expanded open work stays inside a bound and scrolls when longer', box)
        reach = await page.locator('#home-open-list').evaluate("e => { e.scrollTop = e.scrollHeight; const last = e.querySelector('li:last-child'); const a = e.getBoundingClientRect(), b = last.getBoundingClientRect(); return [last.textContent.includes('Work item 00'), b.bottom <= a.bottom + 1, b.top >= a.top - 1]; }")
        assert all(reach), (label, 'the oldest item is reachable inside the bounded list', reach)
        await toggle.focus()
        await page.keyboard.press('Enter')
        await expect(toggle).to_have_text(f'Show all {count}')
        await expect(toggle).to_be_focused()
        await expect(cards).to_have_count(limit)

    for title, total in [('Pinned', 12), ('Other projects', 15)]:
        group = page.locator('.home-project-group').filter(has=page.locator('h3', has_text=title))
        await expect(group.locator('h3 .home-count')).to_have_text(str(total))
        await expect(group.locator('.home-project-card')).to_have_count(6)
        show = group.locator('.home-show-all')
        await expect(show).to_have_text(f'Show all {total} folders')
        await expect(show).to_have_attribute('aria-expanded', 'false')
        await show.click()
        await expect(show).to_have_text('Show fewer')
        await expect(show).to_be_focused()
        await expect(group.locator('.home-project-card')).to_have_count(total)
        box = await group.locator('.home-location-folders').evaluate('e => ({rect: e.getBoundingClientRect().height, view: innerHeight, cls: e.className})')
        assert 'expanded' in box['cls'] and box['rect'] <= box['view'] * 0.6 + 2, (label, title, box)
        await show.click()
        await expect(group.locator('.home-project-card')).to_have_count(6)
    work_group = page.locator('.home-project-group').filter(has=page.locator('.home-location-kicker'))
    await expect(work_group.locator('.home-folder-list li')).to_have_count(6)
    await expect(work_group.locator('.home-show-all')).to_have_text('Show all 9 folders')

    await page.locator('#home-search').fill('bookmark-')
    others = page.locator('.home-project-group').filter(has=page.locator('h3', has_text='Other projects'))
    await expect(others.locator('.home-project-card')).to_have_count(15)
    await expect(others.locator('.home-show-all')).to_have_count(0)
    await page.locator('#home-search').fill('')
    pinned = page.locator('.home-project-group').filter(has=page.locator('h3', has_text='Pinned'))
    pinned_names = await pinned.locator('.home-project-card h4 > span:first-child').evaluate_all('els => els.map(e => e.textContent)')
    assert pinned_names == [f'pinned-{i:02}' for i in range(6)], (label, 'pinned ordering kept', pinned_names)

    assert not errors, errors
    assert [path for path in writes if path != '/api/session'] == [], writes
    assert not [m for m in messages if m.get('type') in ['user_message', 'create_workflow']], messages
    print(f'PASS: Home density at {label}; {columns} columns, two-row open work, six-entry groups, bounded Show all, focus kept, truncation, search shows all')
    await context.close()


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        for scale in [1.0, 1.1, 1.5]:
            await check(browser, scale, 1280)
        await check(browser, 1.1, 600)
        await browser.close()


asyncio.run(main())
