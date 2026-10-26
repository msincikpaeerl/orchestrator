import { OWNER, completeSetup, expect, expectFitsScreen, openSection, test } from './fixtures';

test('log out, fail to log in, then log in', async ({ page }) => {
  await completeSetup(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();

  const menu = page.getByRole('button', { name: 'Menu' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await expectFitsScreen(page);

  await page.getByLabel('Username').fill(OWNER.username);
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong username or password.');

  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();
});

test('an address opened while logged out is shown after logging in', async ({ page }) => {
  await completeSetup(page);
  await page.request.post('/api/auth/logout');
  await page.goto('/settings/github');
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel('Username').fill(OWNER.username);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'GitHub connection' })).toBeVisible();
});

test('the login page links to the password reset help, in a new tab', async ({ page }) => {
  await completeSetup(page);
  await page.request.post('/api/auth/logout');
  await page.goto('/login');
  const forgot = page.getByRole('link', { name: 'Forgot your password?' });
  await expect(forgot).toHaveAttribute('target', '_blank');
  const [help] = await Promise.all([page.context().waitForEvent('page'), forgot.click()]);
  await expect(help.getByRole('heading', { name: 'Reset a forgotten password' })).toBeVisible();
});

test('every section of the navigation opens, later ones say so', async ({ page }) => {
  await completeSetup(page);
  await page.goto('/');
  // Agents come with lot 7; Requests are here from lot 5 step D1.
  await openSection(page, 'Agents');
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
  await expect(page.getByText('Coming in a later version.')).toBeVisible();
  await expectFitsScreen(page);
  await openSection(page, 'Requests');
  await expect(page.getByRole('heading', { name: 'Requests', level: 1 })).toBeVisible();
  await expect(page.getByText('Coming in a later version.')).toHaveCount(0);
  await expectFitsScreen(page);
  await openSection(page, 'Activity');
  await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
  await expectFitsScreen(page);
  await openSection(page, 'Projects');
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
  await expectFitsScreen(page);
  await openSection(page, 'Machines');
  await expect(page.getByRole('heading', { name: 'Machines', level: 1 })).toBeVisible();
  await expectFitsScreen(page);
  await openSection(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expectFitsScreen(page);
  await openSection(page, 'Help');
  await expect(page.getByRole('heading', { name: 'Orchestrator Help', level: 1 })).toBeVisible();
  await openSection(page, 'Needs you');
  await expect(page.getByRole('heading', { name: 'Needs you', level: 1 })).toBeVisible();
});
