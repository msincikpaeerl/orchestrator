import {
  TOKEN_FULL,
  TOKEN_NO_WORKFLOWS,
  completeSetup,
  expect,
  expectFitsScreen,
  inDays,
  openSection,
  test,
} from './fixtures';

test('Needs you shows the token problems until the token is replaced', async ({ page }) => {
  await completeSetup(page, { token: TOKEN_NO_WORKFLOWS, expiresOn: inDays(5) });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Your GitHub token expires soon' })).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'The GitHub token is missing the Workflows permission',
    }),
  ).toBeVisible();
  const menu = page.getByRole('button', { name: 'Menu' });
  if (await menu.isVisible()) await menu.click();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByLabel('4 items')).toBeVisible();
  if (await menu.isVisible()) await menu.click();
  await expectFitsScreen(page);

  await page.getByRole('link', { name: 'Open GitHub connection' }).first().click();
  await expect(page.getByRole('heading', { name: 'GitHub connection' })).toBeVisible();
  await expect(page.getByText('octo-owner')).toBeVisible();
  const workflows = page
    .getByRole('list', { name: 'Permissions' })
    .getByRole('listitem')
    .filter({ hasText: 'Workflows' });
  await expect(workflows).toContainText('Missing');
  await expectFitsScreen(page);

  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(workflows).toContainText('Missing');

  await page.getByRole('button', { name: 'Replace the token' }).click();
  await expect(page.getByRole('link', { name: 'Create the token on GitHub' })).toBeVisible();
  await expectFitsScreen(page);
  await page.getByLabel('GitHub token').fill(TOKEN_FULL);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('Expiry date', { exact: true })).toHaveValue(inDays(300));
  await page.getByRole('button', { name: 'Save and check' }).click();
  await expect(workflows).toContainText('OK');
  await expect(page.getByRole('heading', { name: 'Problems' })).toBeHidden();
  expect(await page.content()).not.toContain(TOKEN_FULL);

  await openSection(page, 'Needs you');
  // Only the setup still to do is left (no Claude account and no machine in this test).
  await expect(page.getByRole('heading', { level: 2 })).toHaveText([
    'No Claude account yet',
    'No machine enrolled yet',
  ]);
});

test('a token entered without expiry date shows so in Settings', async ({ page }) => {
  await completeSetup(page, { token: TOKEN_FULL, expiresOn: null });
  await page.goto('/settings');
  await page.getByRole('link', { name: /GitHub connection/ }).click();
  await expect(page.getByText('No expiry date')).toBeVisible();
});
