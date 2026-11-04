import asyncio
import unittest
from unittest.mock import patch

import browser_navigation


class FakePage:
    _arco_navigation_defaults_installed = False

    def __init__(self):
        self.calls = []

    async def goto(self, url, *, timeout=None, wait_until=None, referer=None):
        self.calls.append(('goto', url, timeout, wait_until, referer))
        return 'goto-response'

    async def reload(self, *, timeout=None, wait_until=None):
        self.calls.append(('reload', timeout, wait_until))
        return 'reload-response'

FakePage._base_goto = FakePage.goto
FakePage._base_reload = FakePage.reload


def reset_fake_page():
    FakePage.goto = FakePage._base_goto
    FakePage.reload = FakePage._base_reload
    FakePage._arco_navigation_defaults_installed = False


class BrowserNavigationTests(unittest.TestCase):
    def test_windows_timeout_is_longer_than_posix_timeout(self):
        with patch.object(browser_navigation.os, 'name', 'nt'):
            self.assertEqual(browser_navigation.navigation_timeout_ms(), 60_000)
        with patch.object(browser_navigation.os, 'name', 'posix'):
            self.assertEqual(browser_navigation.navigation_timeout_ms(), 30_000)

    def test_navigation_uses_domcontentloaded_and_platform_timeout(self):
        reset_fake_page()
        with patch.object(browser_navigation, 'Page', FakePage):
            browser_navigation.install_navigation_defaults()
            page = FakePage()
            response = asyncio.run(page.goto('http://fixture/'))

        self.assertEqual(response, 'goto-response')
        self.assertEqual(page.calls, [('goto', 'http://fixture/', browser_navigation.navigation_timeout_ms(), 'domcontentloaded', None)])

    def test_reload_preserves_explicit_wait_and_timeout(self):
        reset_fake_page()
        with patch.object(browser_navigation, 'Page', FakePage):
            browser_navigation.install_navigation_defaults()
            page = FakePage()
            response = asyncio.run(page.reload(timeout=1_000, wait_until='networkidle'))

        self.assertEqual(response, 'reload-response')
        self.assertEqual(page.calls, [('reload', 1_000, 'networkidle')])


if __name__ == '__main__':
    unittest.main()
