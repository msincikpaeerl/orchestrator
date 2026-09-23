import { TOKEN_FULL, expect, expectFitsScreen, inDays, test } from './fixtures';

test('first launch: account, GitHub token, Done, then the getting started guide', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Help' })).toHaveAttribute(
    'href',
    '/help/getting-started',
  );
  await expectFitsScreen(page);

  // Step 1: the password rules are explained before anything is sent.
  await page.getByLabel('Username').fill('owner');
  await page.getByLabel('Password', { exact: true }).fill('too short');
  await page.getByLabel('Repeat the password').fill('too short');
  await page.getByRole('button', { name: 'Create the account' }).click();
  await expect(page.getByRole('alert')).toHaveText('The password needs at least 12 characters.');
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery');
  await page.getByLabel('Repeat the password').fill('correct horse batteries');
  await page.getByRole('button', { name: 'Create the account' }).click();
  await expect(page.getByRole('alert')).toHaveText('The two passwords are different.');
  await page.getByLabel('Repeat the password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create the account' }).click();

  // Step 2: the pre-filled link, and the one setting it cannot fill in.
  await expect(page.getByRole('heading', { name: 'Connect GitHub' })).toBeVisible();
  const create = page.getByRole('link', { name: 'Create the token on GitHub' });
  await expect(create).toHaveAttribute('target', '_blank');
  const url = new URL((await create.getAttribute('href')) ?? '');
  expect(url.origin + url.pathname).toBe('https://github.com/settings/personal-access-tokens/new');
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    name: 'Orchestrator',
    expires_in: '365',
    administration: 'write',
    contents: 'write',
    pull_requests: 'write',
    workflows: 'write',
    statuses: 'read',
    actions: 'read',
    metadata: 'read',
  });
  await expect(
    page.getByText('Under "Repository access", choose "All repositories".'),
  ).toBeVisible();
  await expect(
    page.getByText('This is the only setting the button cannot fill in for you.', {
      exact: false,
    }),
  ).toBeVisible();
  await expectFitsScreen(page);

  await page.getByLabel('GitHub token').fill('ghp_classicToken');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toContainText('This is not a fine-grained token');

  await page.getByLabel('GitHub token').fill(TOKEN_FULL);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('GitHub account: octo-owner')).toBeVisible();
  // Pre-filled from GitHub's expiration header.
  await expect(page.getByLabel('Expiry date', { exact: true })).toHaveValue(inDays(300));
  await page.getByRole('button', { name: 'Save and check' }).click();

  const permissions = page.getByRole('list', { name: 'Permissions' }).getByRole('listitem');
  await expect(permissions).toHaveCount(7);
  for (const item of await permissions.all()) await expect(item).toContainText('OK');
  expect(await page.content()).not.toContain(TOKEN_FULL);
  await expectFitsScreen(page);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Setup done' })).toBeVisible();
  await expectFitsScreen(page);
  await page.getByRole('link', { name: 'Open Help' }).click();
  await expect(page.getByRole('heading', { name: 'Orchestrator Help', level: 1 })).toBeVisible();
  await page.getByRole('article').getByRole('link', { name: 'Getting started' }).click();
  await expect(page).toHaveURL(/\/help\/getting-started$/);
  await expect(page.getByRole('heading', { name: 'Getting started', level: 1 })).toBeVisible();
  await expectFitsScreen(page);

  // The wizard is over: the home page is "Needs you".
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();
  await expect(page.getByText('Nothing needs you right now.')).toBeVisible();
});

test('a token without expiry date, and one with a missing permission', async ({ page }) => {
  await page.goto('/setup');
  await page.getByLabel('Username').fill('owner');
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery');
  await page.getByLabel('Repeat the password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create the account' }).click();

  await page.getByLabel('GitHub token').fill('github_pat_e2e_no_workflows_0123456789');
  await page.getByRole('button', { name: 'Continue' }).click();
  // GitHub gave no expiry date: the owner enters one or chooses "No expiry date".
  await expect(page.getByLabel('Expiry date', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Save and check' })).toBeDisabled();
  await page.getByLabel('No expiry date').check();
  await page.getByRole('button', { name: 'Save and check' }).click();

  const workflows = page
    .getByRole('list', { name: 'Permissions' })
    .getByRole('listitem')
    .filter({ hasText: 'Workflows' });
  await expect(workflows).toContainText('Missing');
  await expect(page.getByText('Some permissions are not confirmed.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Setup done' })).toBeVisible();
});

test('logging in again resumes the wizard at the GitHub step', async ({ page }) => {
  await page.request.post('/api/setup/owner', {
    data: { username: 'owner', password: 'correct horse battery' },
  });
  await page.request.post('/api/auth/logout');
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Username').fill('owner');
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Connect GitHub' })).toBeVisible();
});
