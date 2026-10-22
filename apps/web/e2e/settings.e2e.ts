import type { Page } from '@playwright/test';
import {
  completeSetup,
  createReadyProject,
  expect,
  expectFitsScreen,
  openSection,
  test,
} from './fixtures';

// Settings > Limits and the limits of project settings (02, sections 6.5 and 10; 04, section 8).

/** One setting on the page: a section named after it. */
function setting(page: Page, label: string) {
  return page.getByRole('region', { name: label, exact: true });
}

async function openLimits(page: Page) {
  await openSection(page, 'Settings');
  await page.getByRole('link', { name: 'Limits' }).click();
  await expect(page.getByRole('heading', { name: 'Limits', level: 1 })).toBeVisible();
}

test('changing a global limit, which applies at once, then resetting it', async ({ page }) => {
  await completeSetup(page);
  await createReadyProject(page, { key: 'WEB', name: 'Web shop', repository: 'web-shop' });
  await page.goto('/');
  await openLimits(page);
  await expect(
    page.getByRole('main').getByRole('link', { name: 'Help', exact: true }),
  ).toHaveAttribute('href', '/help/settings#change-a-limit');

  const title = setting(page, 'Longest ticket title');
  await expect(title).toContainText('Default: 200 characters (in use).');
  await expect(title.getByRole('button', { name: 'Reset to default' })).toBeDisabled();
  // A setting of a later version says so; one used from this version does not.
  await expect(setting(page, 'Most tickets per plan')).toContainText(
    'Used from version 0.6.0: it changes nothing in this version.',
  );
  await expect(setting(page, 'Scheduler check interval')).not.toContainText('Used from version');
  await expect(setting(page, 'Longest run')).not.toContainText('Used from version');

  // A value outside the allowed range is refused with the range.
  await title.getByLabel('Value (characters)').fill('0');
  await title.getByRole('button', { name: 'Save' }).click();
  await expect(title.getByText('Enter a whole number from 1 to 1,000 characters.')).toBeVisible();

  await title.getByLabel('Value (characters)').fill('10');
  await title.getByRole('button', { name: 'Save' }).click();
  await expect(title.getByText('Saved.')).toBeVisible();
  await expect(title).toContainText('Default: 200 characters.');
  await expect(title.getByRole('button', { name: 'Reset to default' })).toBeEnabled();
  await expectFitsScreen(page);

  // The next ticket follows the new limit, without any restart.
  await page.goto('/projects/WEB/tickets/new');
  await page.getByLabel('Title').fill('A title longer than ten characters');
  await page.getByRole('button', { name: 'Create the ticket' }).click();
  await expect(page.getByText('The title can have at most 10 characters.')).toBeVisible();

  // Back to the default: kept after reloading the page.
  await page.goto('/settings/limits');
  await setting(page, 'Longest ticket title')
    .getByRole('button', { name: 'Reset to default' })
    .click();
  await expect(setting(page, 'Longest ticket title')).toContainText(
    'Default: 200 characters (in use).',
  );
  await page.reload();
  await expect(setting(page, 'Longest ticket title').getByLabel('Value (characters)')).toHaveValue(
    '200',
  );
});

test('overriding a limit for one project, then resetting it', async ({ page }) => {
  await completeSetup(page);
  await createReadyProject(page, { key: 'WEB', name: 'Web shop', repository: 'web-shop' });
  await page.goto('/projects/WEB');
  await page.getByRole('link', { name: 'Project settings' }).click();
  await expect(page.getByRole('heading', { name: 'Limits for this project' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Help' }).last()).toHaveAttribute(
    'href',
    '/help/settings#override-a-limit-for-one-project',
  );

  // Only the settings a project can override are listed, a later version's marked as such: CI
  // wait at submission is used from 0.4.0 on, Most tickets per plan from 0.6.0.
  await expect(setting(page, 'Longest ticket title')).toHaveCount(0);
  await expect(setting(page, 'Most tickets per plan')).toContainText(
    'Used from version 0.6.0: it changes nothing in this version.',
  );
  const ciWait = setting(page, 'CI wait at submission');
  await expect(ciWait).toContainText('This project uses the global value (20 minutes).');
  await expect(ciWait).not.toContainText('Used from version');
  await ciWait.getByLabel('Value (minutes)').fill('45');
  await ciWait.getByRole('button', { name: 'Save' }).click();
  await expect(ciWait.getByText('Saved.')).toBeVisible();
  await expect(ciWait).toContainText('This project uses its own value. Global value: 20 minutes.');
  await expectFitsScreen(page);

  // A new global value does not replace the project's own value.
  await openLimits(page);
  await expect(setting(page, 'CI wait at submission')).toContainText(
    'A project can use its own value, in its project settings.',
  );
  await setting(page, 'CI wait at submission').getByLabel('Value (minutes)').fill('30');
  await setting(page, 'CI wait at submission').getByRole('button', { name: 'Save' }).click();
  await expect(setting(page, 'CI wait at submission').getByText('Saved.')).toBeVisible();

  await page.goto('/projects/WEB/settings');
  await expect(ciWait).toContainText('This project uses its own value. Global value: 30 minutes.');
  await expect(ciWait.getByLabel('Value (minutes)')).toHaveValue('45');

  // Reset to default: the project uses the global value again.
  await ciWait.getByRole('button', { name: 'Reset to default' }).click();
  await expect(ciWait).toContainText('This project uses the global value (30 minutes).');
  await expect(ciWait.getByLabel('Value (minutes)')).toHaveValue('30');
  await expect(ciWait.getByRole('button', { name: 'Reset to default' })).toBeDisabled();
  await page.reload();
  await expect(ciWait).toContainText('This project uses the global value (30 minutes).');
});
