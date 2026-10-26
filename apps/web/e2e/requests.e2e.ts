import {
  completeSetup,
  createReadyProject,
  expect,
  expectFitsScreen,
  openSection,
  screenshot,
  test,
} from './fixtures';

// Requests (02, section 5; lot 5 step D1): submitted for a project or a new one, listed, opened
// and commented on. Nothing starts: a request stays open until step E2's planning runs.

test('submitting requests, the list, a request page and a comment', async ({ page }, testInfo) => {
  await completeSetup(page);
  await createReadyProject(page, { key: 'WEB', name: 'Web shop', repository: 'web-shop' });

  await page.goto('/');
  await openSection(page, 'Requests');
  await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible();
  await expect(page.getByText('No request yet.', { exact: false })).toBeVisible();

  // A request for a new project, the form's default.
  await page.getByRole('link', { name: 'New request' }).click();
  await page.getByRole('button', { name: 'Submit the request' }).click();
  await expect(page.getByText('Write your request first.')).toBeVisible();
  await page
    .getByLabel('What do you want?')
    .fill(
      'A simple website with a home page and a contact form.\n\nA message sent through the form is saved on the computer running the site, and the visitor sees a confirmation. No e-mail.',
    );
  await expect(page.getByLabel('Project')).toHaveValue('');
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'request-new');
  await page.getByRole('button', { name: 'Submit the request' }).click();

  await expect(
    page.getByRole('heading', {
      name: 'Request 1 · A simple website with a home page and a contact form.',
    }),
  ).toBeVisible();
  await expect(page.getByText('For a new project')).toBeVisible();
  await expect(page.getByText('Open', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Request' })).toContainText('No e-mail.');
  await expect(page.getByText('No plan yet.')).toBeVisible();

  // A comment, shown in the conversation.
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(page.getByText('Write a comment first.')).toBeVisible();
  await page.getByLabel('Add a comment').fill('The site is in **French**.');
  await page.getByRole('button', { name: 'Add comment' }).click();
  const conversation = page.getByRole('list', { name: 'Conversation' });
  await expect(conversation.getByRole('listitem')).toHaveCount(1);
  await expect(conversation.getByRole('listitem')).toContainText('You ·');
  await expect(conversation.locator('strong')).toHaveText('French');
  await expect(page.getByLabel('Add a comment')).toHaveValue('');
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'request-detail');

  // A request for the project.
  await openSection(page, 'Requests');
  await page.getByRole('link', { name: 'New request' }).click();
  await page.getByLabel('What do you want?').fill('Add a newsletter sign-up to the footer');
  await page.getByLabel('Project').selectOption('WEB');
  await page.getByRole('button', { name: 'Submit the request' }).click();
  await expect(
    page.getByRole('heading', { name: 'Request 2 · Add a newsletter sign-up to the footer' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'WEB · Web shop' })).toBeVisible();

  // The list: newest first, with status and project.
  await openSection(page, 'Requests');
  const items = page.getByRole('list', { name: 'Requests' }).getByRole('listitem');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('Request 2 · Add a newsletter sign-up to the footer');
  await expect(items.nth(0)).toContainText('For WEB · Web shop');
  await expect(items.nth(1)).toContainText('For a new project');
  await expect(items.nth(1)).toContainText('Open');
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'requests-list');
  await items.nth(1).getByRole('link').click();
  await expect(page.getByRole('heading', { name: /^Request 1 · / })).toBeVisible();
});

test('an unknown request says so', async ({ page }) => {
  await completeSetup(page);
  await page.goto('/requests/9');
  await expect(page.getByText('This request does not exist.')).toBeVisible();
  await page.getByRole('link', { name: 'Back to the requests' }).click();
  await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible();
});
