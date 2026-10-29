"""Shared explicit UI navigation for saving an individual project from Home."""
async def open_saved_project_form(page):
    dialog = page.get_by_role('dialog', name='Open another folder', exact=True)
    if not await dialog.count():
        await page.get_by_role('button', name='Open another folder', exact=True).click()
    if not await page.locator('#home-add').is_visible():
        await dialog.locator('details.home-save-project > summary').click()
