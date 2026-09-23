import { completeSetup, expect, expectFitsScreen, test } from './fixtures';

test('Help is readable without logging in, with navigation between pages', async ({ page }) => {
  await page.goto('/help');
  await expect(page.getByRole('heading', { name: 'Orchestrator Help', level: 1 })).toBeVisible();
  await expectFitsScreen(page);

  const pages = page.getByRole('navigation', { name: 'Help pages' });
  const allPages = page.getByText('All Help pages');
  if (await allPages.isVisible()) await allPages.click();
  await pages.getByRole('link', { name: 'Connect GitHub' }).click();
  await expect(page).toHaveURL(/\/help\/github-token$/);
  await expect(page.getByRole('heading', { name: 'Connect GitHub', level: 1 })).toBeVisible();
  // Tables stay inside the screen on a phone.
  await expect(page.getByRole('cell', { name: 'All repositories' }).first()).toBeAttached();
  await expectFitsScreen(page);

  // Links to other pages stay in the application.
  await page.getByRole('article').getByRole('link', { name: 'Back up your secret key' }).click();
  await expect(page).toHaveURL(/\/help\/secret-key$/);
});

test('search lists the pages containing every word', async ({ page }) => {
  await page.goto('/help');
  await page.getByLabel('Search Help').fill('expiry date');
  const results = page.getByRole('region', { name: 'Search results' });
  await expect(results.getByRole('link', { name: 'Connect GitHub' })).toBeVisible();
  await expectFitsScreen(page);
  await results.getByRole('link', { name: 'Connect GitHub' }).click();
  await expect(page.getByRole('heading', { name: 'Connect GitHub', level: 1 })).toBeVisible();

  await page.getByLabel('Search Help').fill('zzzz nothing');
  await expect(page.getByText('No page contains all these words.')).toBeVisible();
});

test('contextual help links lead to the matching page and heading', async ({ page }) => {
  await completeSetup(page);
  await page.goto('/settings/github');
  await page.getByRole('main').getByRole('link', { name: 'Help', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect GitHub', level: 1 })).toBeVisible();

  await page.goto('/help/github-token#required-permissions');
  await expect(page.getByRole('heading', { name: 'Required permissions' })).toBeInViewport();

  await page.goto('/help/no-such-page');
  await expect(page.getByText('This Help page does not exist.')).toBeVisible();
});
