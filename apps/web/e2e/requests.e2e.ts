import type { Page } from '@playwright/test';
import {
  callTool,
  completeSetup,
  connectDaemon,
  createMachine,
  createReadyProject,
  expect,
  expectFitsScreen,
  openSection,
  reportState,
  screenshot,
  startPlanningRun,
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

// Questions on a request (lot 5 step D2b; 02, sections 4 and 5.3): the planning run is D2a's test
// helper, through the test server's control, until step E2's scheduler starts them.

/** Request 1 for TESTB, its planning run on Laptop asking its question; the run's id. */
async function asked(page: Page): Promise<string> {
  await completeSetup(page);
  await createReadyProject(page, { key: 'TESTB', name: 'Test B', repository: 'test-b' });
  const { id, code } = await createMachine(page, { name: 'Laptop', account: 'Personal' });
  expect(await connectDaemon(page, code)).toBe(204);
  const created = await page.request.post('/api/requests', {
    data: { body: 'A contact form\n\nOn the home page.', project: 'TESTB' },
  });
  expect(created.status()).toBe(201);
  const { runId, runToken } = await startPlanningRun(page, 1, id);
  await reportState(page, runId, 'working');
  await callTool(page, runToken, 'request_ask', {
    question: 'Should the form also ask for a **phone number**?',
  });
  await reportState(page, runId, 'waiting_human');
  return runId;
}

test("the Project Manager's question is answered from Needs you", async ({ page }, testInfo) => {
  await asked(page);
  await page.goto('/');
  const heading = page.getByRole('link', {
    name: 'Question on request 1 (TESTB): A contact form',
  });
  await expect(heading).toBeVisible();
  const question = page.getByRole('region', { name: 'Question from the agent' });
  await expect(question).toContainText('Should the form also ask for a phone number?');
  await expect(question.getByRole('heading')).toHaveText('Question from agent Project Manager');
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'request-question-needs-you');

  await question.getByLabel('Your answer').fill('No, the e-mail address is enough.');
  await question.getByRole('button', { name: 'Send answer' }).click();
  await expect(question).toBeHidden();
  await expect(page.getByText('Nothing needs you right now.')).toBeVisible();

  // The request page: the question and the answer in the conversation, no answer box.
  await openSection(page, 'Requests');
  await page.getByRole('link', { name: /Request 1 · A contact form/ }).click();
  await expect(page.getByText('Planning: the Project Manager is working on it.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Question from the agent' })).toBeHidden();
  const conversation = page.getByRole('list', { name: 'Conversation' }).getByRole('listitem');
  await expect(conversation).toHaveCount(2);
  await expect(conversation.nth(0)).toContainText('Question from agent Project Manager ·');
  await expect(conversation.nth(0)).toContainText('phone number');
  await expect(conversation.nth(1)).toContainText('Your answer ·');
  await expect(conversation.nth(1)).toContainText('No, the e-mail address is enough.');
  await expectFitsScreen(page);
});

test("the Project Manager's question is answered on the request page", async ({
  page,
}, testInfo) => {
  await asked(page);
  await page.goto('/requests/1');
  await expect(
    page.getByText('Planning: the Project Manager waits for your answer.'),
  ).toBeVisible();
  await expect(page.getByText('Planning', { exact: true })).toBeVisible();
  const question = page.getByRole('region', { name: 'Question from the agent' });
  await expect(question).toContainText('Should the form also ask for a phone number?');
  await expect(question.getByRole('link', { name: 'About questions' })).toHaveAttribute(
    'href',
    /requests#questions$/,
  );
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'request-question');

  await question.getByRole('button', { name: 'Send answer' }).click();
  await expect(question.getByText('Write your answer first.')).toBeVisible();
  await question.getByLabel('Your answer').fill('Yes, but make it optional.');
  await question.getByRole('button', { name: 'Send answer' }).click();
  await expect(question).toBeHidden();
  await expect(page.getByText('Planning: the Project Manager is working on it.')).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Conversation' }).getByRole('listitem').nth(1),
  ).toContainText('Yes, but make it optional.');

  await page.goto('/');
  await expect(page.getByText('Nothing needs you right now.')).toBeVisible();
});
