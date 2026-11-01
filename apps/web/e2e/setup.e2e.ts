import type { Page } from '@playwright/test';
import {
  TOKEN_FULL,
  comeBack,
  connectDaemon,
  expect,
  expectFitsScreen,
  inDays,
  screenshot,
  test,
} from './fixtures';

/** Steps 1 and 2 through the screens, with a token GitHub accepts in full. */
async function ownerAndGitHub(page: Page) {
  await page.goto('/setup');
  await page.getByLabel('Username').fill('owner');
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery');
  await page.getByLabel('Repeat the password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create the account' }).click();
  await page.getByLabel('GitHub token').fill(TOKEN_FULL);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Save and check' }).click();
  await expect(page.getByRole('list', { name: 'Permissions' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
}

/** Step 3 with only a label: no window, no budget. */
async function claudeAccount(page: Page) {
  await expect(page.getByRole('heading', { name: 'Add your Claude account' })).toBeVisible();
  await page.getByLabel('Label').fill('Personal');
  await page.getByRole('button', { name: 'Add the account' }).click();
  await expect(page.getByText('Account Personal added.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
}

test('first launch: account, GitHub token, Claude account, machine, Done', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await expect(page.getByText('Setup, step 1 of 4')).toBeVisible();
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
  await expect(page.getByText('Setup, step 2 of 4')).toBeVisible();
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

  // Step 3: a Claude account, then its optional windows and budget.
  await expect(page.getByRole('heading', { name: 'Add your Claude account' })).toBeVisible();
  await expect(page.getByText('Setup, step 3 of 4')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add the account' }).click();
  await expect(page.getByText('Enter a label.')).toBeVisible();
  await page.getByLabel('Label').fill('Personal');
  await page.getByLabel('Plan').selectOption({ label: 'Max 5x' });
  await page.getByRole('button', { name: 'Add the account' }).click();
  await expect(page.getByText('Account Personal added.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Schedule windows' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Daily budget' })).toBeVisible();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'wizard-account');
  // Steps 3 and 4 hold every screen until the wizard is left.
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/setup$/);
  // A reload goes on at step 4: the account exists.
  await expect(page.getByRole('heading', { name: 'Add a machine' })).toBeVisible();
  await expect(page.getByText('Setup, step 4 of 4')).toBeVisible();

  // Step 4: the machine's name (its account is the only one), the commands, the connection.
  await expect(page.getByLabel('Claude account')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
  await page.getByLabel('Name').fill('Desktop');
  await page.getByRole('button', { name: 'Show the commands' }).click();
  const enroll = page.getByLabel('Enroll command');
  await expect(enroll).toContainText(/^orchestrator-daemon enroll http:\/\/localhost:\d+ \S+$/);
  await expect(page.getByText('Waiting for the machine to enroll…')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the machine' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'wizard-machine');

  // A reload: the code is shown only once, so a new one shows the commands again.
  await page.reload();
  await page.getByRole('button', { name: 'New enrollment code' }).click();
  const code = (await enroll.textContent())?.trim().split(' ').pop() ?? '';
  expect(await connectDaemon(page, code)).toBe(204);
  // The stream shows the connection; coming back reads it again as well.
  await comeBack(page);
  await expect(page.getByText('Connected: Desktop is ready.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the machine' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 5: what is set up, and the first request.
  await expect(page.getByRole('heading', { name: 'Setup done' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Set up' }).getByRole('listitem')).toHaveText([
    'Your account is created and GitHub is connected.',
    'Claude account: Personal.',
    'Machine: Desktop is ready.',
  ]);
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'wizard-done');
  await page.getByRole('link', { name: 'Submit a first request' }).click();
  await expect(page).toHaveURL(/\/requests\/new$/);
  await page.goto('/setup/done');
  await page.getByRole('link', { name: 'Open Help' }).click();
  await expect(page.getByRole('heading', { name: 'Orchestrator Help', level: 1 })).toBeVisible();
  await page.getByRole('article').getByRole('link', { name: 'Getting started' }).click();
  await expect(page).toHaveURL(/\/help\/getting-started$/);
  await expect(page.getByRole('heading', { name: 'Getting started', level: 1 })).toBeVisible();
  await expectFitsScreen(page);

  // The wizard is over: the home page is "Needs you", with nothing left to set up.
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No Claude account yet' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No machine enrolled yet' })).toHaveCount(0);
});

test('step 4 skipped: "No machine enrolled yet" stays in Needs you', async ({ page }, testInfo) => {
  await ownerAndGitHub(page);
  await claudeAccount(page);
  await expect(page.getByRole('heading', { name: 'Add a machine' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();

  await expect(page.getByRole('heading', { name: 'Setup done' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Set up' }).getByRole('listitem')).toHaveText([
    'Your account is created and GitHub is connected.',
    'Claude account: Personal.',
    'No machine yet: "Needs you" reminds you to add one, in Machines.',
  ]);
  await screenshot(page, testInfo, 'wizard-done-skipped');
  await page.getByRole('link', { name: 'Go to Needs you' }).click();
  await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['No machine enrolled yet']);
  // The wizard is not shown again.
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Add your Claude account' })).toBeVisible();
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

test('an install from before 0.6.0 with only GitHub left: step 2 of 2, then Done', async ({
  page,
}) => {
  // The owner's wizard of 0.5.0 was finished by the update's migration.
  await page.request.post('/api/setup/owner', {
    data: { username: 'owner', password: 'correct horse battery' },
  });
  expect((await page.request.post('/api/setup/finish')).status()).toBe(204);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Connect GitHub' })).toBeVisible();
  await expect(page.getByText('Setup, step 2 of 2')).toBeVisible();
  await page.getByLabel('GitHub token').fill(TOKEN_FULL);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Save and check' }).click();
  await expect(page.getByRole('list', { name: 'Permissions' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Setup done' })).toBeVisible();
  await expect(page.getByText('Next, add your Claude account and the computer')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Submit a first request' })).toHaveCount(0);
});
