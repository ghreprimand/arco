"""Built-in cluster templates and their review step on the real creator, in Claude-only, Codex-only, both and Ollama-only homes. Synthetic APIs, no provider calls."""
import asyncio
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from playwright.async_api import async_playwright, expect

PORT = os.environ.get('ARCO_CLIENT_PORT', '5210')
ORIGIN = 'http://127.0.0.1:' + PORT
ROOT = Path(__file__).resolve().parents[2]
HTML = '''<!doctype html><html><body><div id="fixture" style="width:1000px"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; window.fixtureReady=true;</script></body></html>'''
TEMPLATES = {
    'PAIR': ['Builder', 'Reviewer'],
    'SMALL TEAM': ['Director', 'Builder', 'Tester'],
    'FULL TEAM': ['Director', 'Builder', 'Tester', 'Documenter'],
    'PARALLEL BUILD': ['Director', 'Builder 1', 'Builder 2', 'Tester', 'Documenter'],
    'RESEARCH': ['Director', 'Researcher 1', 'Researcher 2'],
}
ROLE_TIER = {'Director': 'heavy', 'Builder': 'heavy', 'Reviewer': 'standard', 'Tester': 'standard', 'Documenter': 'light', 'Researcher': 'light'}
ROLE_EFFORT = {'Director': 'high', 'Builder': 'high', 'Reviewer': 'high', 'Tester': 'medium', 'Documenter': 'low', 'Researcher': 'medium'}
HOMES = {
    'claude-only': {'claude': True},
    'codex-only': {'codex': True},
    'both': {'claude': True, 'codex': True},
    'ollama-only': {'ollama': True},
}
TITLE = {'PAIR': 'Pair', 'SMALL TEAM': 'Small team', 'FULL TEAM': 'Full team', 'PARALLEL BUILD': 'Parallel build', 'RESEARCH': 'Research'}
RANK = {'none': 0, 'minimal': 0, 'low': 1, 'medium': 2, 'high': 3, 'xhigh': 4, 'max': 5}


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('ARCO_TEST_CHROME') or None)
        page = await browser.new_page(viewport={'width': 1300, 'height': 1000})
        errors, blocked, writes = [], [], []

        async def isolate(route):
            u = urlparse(route.request.url)
            if u.netloc in ('fonts.googleapis.com', 'fonts.gstatic.com'):
                await route.fulfill(content_type='text/css', body=''); return
            if u.scheme == 'http' and u.netloc == '127.0.0.1:' + PORT:
                if u.path == '/fixture':
                    await route.fulfill(content_type='text/html', body=HTML); return
                if u.path.startswith('/api/'):
                    if route.request.method != 'GET':
                        writes.append(u.path)
                    await route.fulfill(json={'items': [], 'projects': [], 'roots': [], 'sessions': [], 'presets': [], 'templates': [], 'skills': [], 'models': [], 'clusters': []}); return
                path = unquote(u.path)
                local = path.startswith('/@fs/') and Path(path[4:]).resolve().is_relative_to(ROOT)
                if local or path.startswith(('/@react-refresh', '/@vite/', '/@id/', '/node_modules/.vite/deps/', '/src/')):
                    await route.continue_(); return
            blocked.append(route.request.url); await route.abort()

        await page.route('**/*', isolate)
        await page.route_web_socket('**/*', lambda ws: None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(ORIGIN + '/fixture')
        await page.wait_for_function('window.fixtureReady')
        await page.evaluate('''async () => {
          await import('/src/styles/global.css');
          const React=(await import('/node_modules/.vite/deps/react.js')).default;
          const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
          const {WorkflowCreator}=await import('/src/components/WorkflowCreator/index.tsx');
          const {useAppStore:s}=await import('/src/stores/appStore.ts');
          window.s=s; window.clusters=[];
          const root=createRoot(document.getElementById('fixture')); let gen=0;
          window.show=(connected,capacity)=>{
            const auth={claude:{loggedIn:!!connected.claude},codex:{loggedIn:!!connected.codex},cursor:{loggedIn:false},llamacpp:{loggedIn:false},
              ollama:{loggedIn:!!connected.ollama,installedModels:connected.ollama?['local-small','local-large']:[]}};
            // Cursor is connected but disabled in Settings, so it must never be offered.
            auth.cursor={loggedIn:true};
            s.setState({connected:true,creatorPrefill:{mode:'cluster',workDir:'/projects/fixture'},
              settings:{enabledProviders:{claude:true,codex:true,ollama:true,cursor:false,llamacpp:true},projectRoots:[],...(capacity?{localClusterCapacity:capacity}:{})},authStatus:auth});
            root.render(React.createElement(WorkflowCreator,{key:++gen,onCreate:()=>{},onCreateCluster:c=>clusters.push(c)}));
          };
        }''')

        created = 0
        for home, connected in HOMES.items():
            await page.evaluate('(c)=>show(c)', connected)
            picker = page.locator('[data-help="creator.cluster-templates"]')
            await expect(picker.get_by_role('button', name='BUILD MY OWN', exact=True)).to_have_attribute('aria-pressed', 'true')
            member_rows = page.locator('[data-help="creator.cluster-members"] > div[style*="border"]')
            await expect(member_rows).to_have_count(2)
            for name, members in TEMPLATES.items():
                before = await member_rows.all_inner_texts()
                await picker.get_by_role('button', name=name, exact=True).click()
                review = picker.get_by_role('region', name=f'Review {TITLE[name]} template')
                await expect(review).to_be_visible()
                await expect(review).to_contain_text('Arco does not choose models for you')
                rows = review.locator('[data-template-member]')
                assert await rows.evaluate_all('els => els.map(e => e.dataset.templateMember)') == members, (home, name)
                use = review.get_by_role('button', name='USE THESE MEMBERS', exact=True)
                await expect(use).to_be_disabled()
                for label in members:
                    role = label.split(' ')[0]
                    row = review.locator(f'[data-template-member="{label}"]')
                    await expect(row).to_contain_text('Recommended:')
                    provider = row.get_by_label(f'Provider for {label}', exact=True)
                    offered = [o for o in await provider.evaluate('e => [...e.options].map(o => o.value)') if o]
                    assert offered == [k for k in ['claude', 'codex', 'ollama'] if k in connected], (home, offered)
                    model = row.get_by_label(f'Model for {label}', exact=True)
                    if len(offered) == 1:
                        assert await provider.input_value() == offered[0], (home, 'single provider is filled in')
                    else:
                        assert await provider.input_value() == '', (home, 'no provider is chosen for the operator')
                        await provider.select_option(offered[-1])
                    assert await model.input_value() == '', (home, 'no model is chosen for the operator')
                    options = [o for o in await model.evaluate('e => [...e.options].map(o => o.value)') if o]
                    assert options, (home, label)
                    await model.select_option(options[-1])
                    efforts = row.get_by_role('group', name=f'Effort for {label}')
                    if await efforts.count():
                        chosen = await efforts.locator('button[aria-pressed="true"]').inner_text()
                        assert RANK[chosen.lower()] <= RANK['high'] and RANK[chosen.lower()] <= RANK[ROLE_EFFORT[role]], (home, label, chosen)
                if home == 'ollama-only':
                    # Default capacity is 1: the shared capacity check names Connections; USE stays enabled.
                    await expect(review.get_by_test_id('template-local-capacity')).to_contain_text('Connections > Ollama')
                    await expect(use).to_be_enabled()
                    await review.get_by_role('button', name='CANCEL', exact=True).click()
                    assert await member_rows.all_inner_texts() == before, ('cancel keeps the members unchanged', home, name)
                    continue
                await expect(use).to_be_enabled()
                await use.click()
                await expect(picker.get_by_role('status')).to_contain_text(f'{TITLE[name]} members are in the list below')
                rows_now = page.locator('[data-help="creator.cluster-members"] > div[style*="border"]')
                await expect(rows_now).to_have_count(len(members))
                await page.get_by_role('button', name='CREATE CLUSTER', exact=True).click()
                created += 1
                await page.wait_for_function(f'clusters.length==={created}')
                payload = await page.evaluate(f'clusters[{created - 1}]')
                got = [(m['displayName'], m['tier'], m['provider'], m['effort']) for m in payload['members']]
                for (display, tier, provider, effort), label in zip(got, members):
                    role = label.split(' ')[0]
                    assert tier == ROLE_TIER[role] and provider in connected and RANK[effort] <= RANK['high'], (home, name, got)
                    assert display.startswith(role), (home, name, display)
                assert all(m.get('outputStyle') == 'lite' and m.get('efficiencyToolFilter') == 'conservative' for m in payload['members']), ('template members use the new-home tuning defaults', payload)
            print(f'{home}: templates offer only {sorted(connected)}, models chosen by the operator, effort at most HIGH', flush=True)

        assert created == 15, created

        # Ollama capacity raised to 3: Research (3 members) shows no capacity warning and creates 3 Ollama members.
        await page.evaluate("show({ollama: true}, {ollama: 3})")
        picker = page.locator('[data-help="creator.cluster-templates"]')
        await picker.get_by_role('button', name='RESEARCH', exact=True).click()
        review = picker.get_by_role('region', name='Review Research template')
        for label in TEMPLATES['RESEARCH']:
            row = review.locator(f'[data-template-member="{label}"]')
            model = row.get_by_label(f'Model for {label}', exact=True)
            options = [o for o in await model.evaluate('e => [...e.options].map(o => o.value)') if o]
            await model.select_option(options[-1])
        await expect(review.get_by_test_id('template-local-capacity')).to_have_count(0)
        await review.get_by_role('button', name='USE THESE MEMBERS', exact=True).click()
        await expect(page.get_by_role('status').filter(has_text='Local capacity: Ollama 3 of 3')).to_be_visible()
        await page.get_by_role('button', name='CREATE CLUSTER', exact=True).click()
        await page.wait_for_function('clusters.length===16')
        payload = await page.evaluate('clusters[15]')
        assert [m['provider'] for m in payload['members']] == ['ollama'] * 3, payload['members']
        print('ollama capacity 3: Research creates three Ollama members without a capacity warning', flush=True)
        assert writes == [], writes
        assert not blocked, blocked
        assert not errors, errors
        await browser.close()
        print('PASS creator templates: five built-in shapes in four provider homes; guidance in words, connected providers only, no automatic model choice, effort capped, review before replacing members, local capacity from Connections')

asyncio.run(main())
