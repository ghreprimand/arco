"""Consistent navigation defaults for browser smoke suites."""
import os
import sys
from typing import Any

from playwright.async_api import Page


WINDOWS_NAVIGATION_TIMEOUT_MS = 60_000
DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000


def navigation_timeout_ms() -> int:
    return WINDOWS_NAVIGATION_TIMEOUT_MS if os.name == "nt" else DEFAULT_NAVIGATION_TIMEOUT_MS


def install_navigation_defaults() -> None:
    """Use DOMContentLoaded for navigation and leave app readiness to each suite."""
    if getattr(Page, "_arco_navigation_defaults_installed", False):
        return

    original_goto = Page.goto
    original_reload = Page.reload

    async def goto(self: Page, url: str, *, timeout: float | None = None, wait_until: str | None = None, referer: str | None = None) -> Any:
        response = await original_goto(
            self,
            url,
            timeout=navigation_timeout_ms() if timeout is None else timeout,
            wait_until="domcontentloaded" if wait_until is None else wait_until,
            referer=referer,
        )
        return response

    async def reload(self: Page, *, timeout: float | None = None, wait_until: str | None = None) -> Any:
        response = await original_reload(
            self,
            timeout=navigation_timeout_ms() if timeout is None else timeout,
            wait_until="domcontentloaded" if wait_until is None else wait_until,
        )
        return response

    Page.goto = goto
    Page.reload = reload
    Page._arco_navigation_defaults_installed = True
