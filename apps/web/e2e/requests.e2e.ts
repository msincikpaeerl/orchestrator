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

// A planning run on screen, stopped, and the request's Try again (lot 5 step E2a; 02, sections
// 4, 5.3, 7 and 9.2): the run is D2a's test helper's until step E2b's scheduler starts them.
test('a planning run in Activity and on its machine, stopped, then Try again', async ({
  page,
}, testInfo) => {
  await completeSetup(page);
  await createReadyProject(page, { key: 'TESTB', name: 'Test B', repository: 'test-b' });
  const { id, code } = await createMachine(page, { name: 'Laptop', account: 'Personal' });
  expect(await connectDaemon(page, code)).toBe(204);
  const created = await page.request.post('/api/requests', {
    data: { body: 'A contact form\n\nOn the home page.', project: 'TESTB' },
  });
  expect(created.status()).toBe(201);
  const { runId } = await startPlanningRun(page, 1, id);
  await reportState(page, runId, 'working');

  await page.goto('/');
  await openSection(page, 'Activity');
  const live = page.getByRole('list', { name: 'Live runs' });
  await expect(live).toContainText('Request 1: A contact form · Project Manager on Laptop');
  await expect(live.getByRole('link', { name: 'Request 1: A contact form' })).toHaveAttribute(
    'href',
    '/requests/1',
  );
  await expectFitsScreen(page);

  await page.goto(`/machines/${id}`);
  const active = page.getByRole('list', { name: 'Active runs' });
  await expect(active).toContainText('Request 1: A contact form · Project Manager on Laptop');

  await active.getByRole('link', { name: 'Open the run and its full log' }).click();
  await expect(
    page.getByRole('heading', { name: 'Planning run for request 1 · attempt 1' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to request 1' })).toHaveAttribute(
    'href',
    '/requests/1',
  );
  await expect(page.getByRole('heading', { name: 'Branch' })).toBeHidden();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'planning-run');

  await page.getByRole('button', { name: 'Stop run' }).click();
  const dialog = page.getByRole('dialog', { name: 'Stop this run?' });
  await expect(dialog).toContainText('The Project Manager stops now and the request is stopped');
  await dialog.getByRole('button', { name: 'Stop run' }).click();
  await expect(page.getByLabel('Run status')).toHaveText('Cancelled: it was cancelled');

  await page.goto('/');
  const stopped = page.getByRole('link', {
    name: 'Planning stopped for request 1 (TESTB): A contact form',
  });
  await expect(stopped).toBeVisible();
  await expect(page.getByText(/^You stopped its planning run at .+\. Use Try again/)).toBeVisible();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'planning-stopped');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(stopped).toBeHidden();
  await expect(page.getByText('Nothing needs you right now.')).toBeVisible();

  await page.goto('/requests/1');
  await expect(page.getByRole('region', { name: 'Planning stopped' })).toBeHidden();
  await expect(page.getByRole('list', { name: 'Conversation' })).toContainText(
    'The owner used Try again',
  );
});

// The plan review (lot 5 step F2; 02, sections 4 and 5.3): the planning run is D2a's test helper,
// whose scripted daemon calls `plan_propose`, as the Project Manager does.

const home = {
  key: 'home',
  type: 'feature',
  title: 'Home page',
  acceptance_criteria: ['The home page shows the bakery name'],
  assignee: 'web_dev',
};
const contact = {
  key: 'contact',
  type: 'feature',
  title: 'Contact form',
  description: 'Messages saved in a file.',
  acceptance_criteria: ['A message is saved'],
  assignee: 'web_dev',
  blocked_by: ['home'],
};
const docs = {
  key: 'docs',
  type: 'docs',
  title: 'User guide',
  acceptance_criteria: ['The guide explains the form'],
  assignee: 'web_dev',
  blocked_by: ['home'],
};

/** Request 1 for TESTB and a planning run on Laptop; its id and token. */
async function planning(page: Page): Promise<{ machineId: string }> {
  await completeSetup(page);
  await createReadyProject(page, { key: 'TESTB', name: 'Test B', repository: 'test-b' });
  const { id, code } = await createMachine(page, { name: 'Laptop', account: 'Personal' });
  expect(await connectDaemon(page, code)).toBe(204);
  const created = await page.request.post('/api/requests', {
    data: { body: 'A contact form\n\nOn the home page.', project: 'TESTB' },
  });
  expect(created.status()).toBe(201);
  return { machineId: id };
}

/** A planning run of request 1 proposes `tickets`; it ends unless `keepRunning`. */
async function propose(
  page: Page,
  machineId: string,
  tickets: object[],
  keepRunning = false,
): Promise<void> {
  const { runId, runToken } = await startPlanningRun(page, 1, machineId);
  await reportState(page, runId, 'working');
  await callTool(page, runToken, 'plan_propose', {
    summary: 'A home page, then the **contact form** and its guide.',
    tickets,
  });
  if (!keepRunning) {
    await reportState(page, runId, 'ended', { reason: 'submitted', detail: null, branch: null });
  }
}

test('a plan reviewed, edited, a ticket removed, rejected with feedback, then approved', async ({
  page,
}, testInfo) => {
  const { machineId } = await planning(page);
  await propose(page, machineId, [home, contact, docs]);

  // Needs you links to the request.
  await page.goto('/');
  await expect(
    page.getByText('Plan to review for request 1 (TESTB): A contact form'),
  ).toBeVisible();
  await expect(page.getByText(/^The Project Manager proposed 3 tickets at .+\.$/)).toBeVisible();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'plan-to-review');
  await page.getByRole('link', { name: 'Review the plan' }).click();

  await expect(page.getByText('Plan to review', { exact: true })).toBeVisible();
  const plan = page.getByRole('region', { name: 'Plan', exact: true });
  await expect(plan.locator('strong')).toHaveText('contact form');
  const tickets = plan.getByRole('list', { name: 'Tickets of the plan' }).locator(':scope > li');
  await expect(tickets).toHaveCount(3);
  const contactItem = plan
    .getByRole('list', { name: 'Tickets of the plan' })
    .getByRole('listitem', { name: 'contact · Contact form' });
  await expect(contactItem).toContainText('Feature · Normal priority · Web Developer');
  await expect(contactItem).toContainText('Messages saved in a file.');
  await expect(contactItem).toContainText('A message is saved');
  await expect(contactItem).toContainText('Waits for home (Home page).');
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'plan-review');

  // An edit in the ticket's card.
  await contactItem.getByRole('button', { name: 'Edit contact' }).click();
  const form = plan.getByRole('form', { name: 'Edit contact' });
  await form.getByLabel('Title').fill('');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByText('Enter a title.')).toBeVisible();
  await form.getByLabel('Title').fill('Contact form with a phone field');
  await form.getByLabel('Priority').selectOption('high');
  await form.getByRole('button', { name: 'Remove home from what it waits for' }).click();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'plan-ticket-edit');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();
  const edited = plan
    .getByRole('list', { name: 'Tickets of the plan' })
    .getByRole('listitem', { name: 'contact · Contact form with a phone field' });
  await expect(edited).toContainText('Feature · High priority · Web Developer');
  await expect(edited).toContainText('Waits for nothing.');

  // Remove: the confirmation names the tickets waiting for it.
  await plan
    .getByRole('list', { name: 'Tickets of the plan' })
    .getByRole('listitem', { name: 'home · Home page' })
    .getByRole('button', { name: 'Remove home' })
    .click();
  const removeHome = page.getByRole('dialog', { name: 'Remove home (Home page) from the plan?' });
  await expect(removeHome).toContainText('docs waits for it: it will no longer.');
  await removeHome.getByRole('button', { name: 'Keep it' }).click();
  await expect(removeHome).toBeHidden();
  await plan
    .getByRole('list', { name: 'Tickets of the plan' })
    .getByRole('listitem', { name: 'docs · User guide' })
    .getByRole('button', { name: 'Remove docs' })
    .click();
  const removeDocs = page.getByRole('dialog', { name: 'Remove docs (User guide) from the plan?' });
  await expect(removeDocs).toContainText('A removed ticket cannot be added back');
  await removeDocs.getByRole('button', { name: 'Remove' }).click();
  await expect(removeDocs).toBeHidden();
  await expect(tickets).toHaveCount(2);

  // Reject with feedback: the box under the actions.
  await plan.getByRole('button', { name: 'Reject with feedback' }).click();
  const reject = plan.getByRole('form', { name: 'Reject with feedback' });
  await expect(reject).toContainText('A new planning run starts: one Claude Code session.');
  await reject.getByRole('button', { name: 'Reject with feedback' }).click();
  await expect(reject.getByText('Write your feedback first.')).toBeVisible();
  await reject.getByLabel('What should change?').fill('Keep the **user guide**.');
  await expectFitsScreen(page);
  await reject.getByRole('button', { name: 'Reject with feedback' }).click();
  await expect(plan.getByText('No plan yet.')).toBeVisible();
  await expect(page.getByText('Open', { exact: true })).toBeVisible();
  const earlier = page.getByRole('region', { name: 'Earlier plans' });
  await expect(earlier.getByRole('heading', { name: 'Earlier plans (1)' })).toBeVisible();
  await earlier.getByText(/^Proposed at .+, rejected with your feedback at .+$/).click();
  await expect(earlier.locator('strong').first()).toHaveText('user guide');
  await expect(
    earlier
      .getByRole('list', { name: 'Tickets of the plan' })
      .getByRole('listitem', { name: /^contact · / }),
  ).toBeVisible();
  await expect(earlier.getByRole('button', { name: 'Edit contact' })).toBeHidden();

  // The next plan, approved.
  await propose(page, machineId, [home, contact, docs]);
  await expect(tickets).toHaveCount(3);
  await plan.getByRole('button', { name: 'Approve' }).click();
  const approve = page.getByRole('dialog', { name: 'Approve this plan?' });
  await expect(approve).toContainText(
    'It creates 3 tickets in TESTB, in To do. The scheduler starts them by themselves as machines are free: each one uses Claude Code sessions.',
  );
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'plan-approve');
  await approve.getByRole('button', { name: 'Approve' }).click();
  await expect(approve).toBeHidden();
  await expect(plan.getByRole('heading', { name: /^Plan, approved by you at / })).toBeVisible();
  await expect(page.getByText('Closed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close request' })).toBeHidden();
  await expect(plan.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  await expectFitsScreen(page);
  const created = plan
    .getByRole('list', { name: 'Tickets of the plan' })
    .getByRole('listitem', { name: 'contact · Contact form' });
  await created.getByRole('link', { name: /^TESTB-\d+$/ }).click();
  await expect(page.getByRole('heading', { name: /^TESTB-\d+ · Contact form$/ })).toBeVisible();
  await expect(page.getByText("From request 1's plan, approved by you")).toBeVisible();
  await page.getByRole('link', { name: 'request 1' }).click();
  await expect(page.getByRole('heading', { name: 'Request 1 · A contact form' })).toBeVisible();

  await page.goto('/');
  await expect(page.getByText('Plan to review for request 1', { exact: false })).toBeHidden();
});

test('a request closed while its planning run works and its plan is proposed', async ({
  page,
}, testInfo) => {
  const { machineId } = await planning(page);
  await propose(page, machineId, [home, contact], true);

  await page.goto('/requests/1');
  await page.getByRole('button', { name: 'Close request' }).click();
  const close = page.getByRole('dialog', { name: 'Close request 1?' });
  await expect(close).toContainText(
    'It is final: the request cannot be reopened. Submit a new request to ask again.',
  );
  await expect(close).toContainText(
    'Its planning run stops now; this does not count as a failed attempt.',
  );
  await expect(close).toContainText('Its proposed plan is rejected: no ticket is created.');
  await expect(close).toContainText('You can still add comments.');
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'request-close');
  await close.getByRole('button', { name: 'Keep it open' }).click();
  await expect(close).toBeHidden();
  await page.getByRole('button', { name: 'Close request' }).click();
  await close.getByRole('button', { name: 'Close request' }).click();
  await expect(close).toBeHidden();

  await expect(page.getByText('Closed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close request' })).toBeHidden();
  await expect(page.getByRole('region', { name: 'Plan', exact: true })).toContainText(
    'No plan yet.',
  );
  const earlier = page.getByRole('region', { name: 'Earlier plans' });
  await earlier.getByText(/^Proposed at .+, rejected at .+$/).click();
  await expect(earlier).toContainText('Rejected: you closed the request.');
  await expect(page.getByRole('list', { name: 'Conversation' })).toContainText(
    'The owner closed the request.',
  );
  await expect(page.getByLabel('Add a comment')).toBeVisible();
  await expectFitsScreen(page);

  await page.goto('/');
  await expect(page.getByText('Nothing needs you right now.')).toBeVisible();
});

// A new project from a plan (lot 5 step G; 02, section 5.3): the approval form creates the
// project, its repository on the fake GitHub and the tickets.
test('a plan creating a project approved with its form', async ({ page }, testInfo) => {
  await completeSetup(page);
  const { id: machineId, code } = await createMachine(page, {
    name: 'Laptop',
    account: 'Personal',
  });
  expect(await connectDaemon(page, code)).toBe(204);
  const created = await page.request.post('/api/requests', {
    data: { body: 'A bakery website\n\nWith a contact form.', project: null },
  });
  expect(created.status()).toBe(201);
  const { runId, runToken } = await startPlanningRun(page, 1, machineId);
  await reportState(page, runId, 'working');
  await callTool(page, runToken, 'plan_propose', {
    summary: 'A bakery website with a contact form.',
    new_project: { name: 'Bakery shop', kind: 'website', description: 'The bakery online.' },
    tickets: [
      {
        key: 'setup',
        type: 'chore',
        title: 'Set up the project',
        assignee: 'architect',
        bootstrap: true,
      },
      { ...contact, blocked_by: [] },
    ],
  });
  await reportState(page, runId, 'ended', { reason: 'submitted', detail: null, branch: null });

  await page.goto('/requests/1');
  const plan = page.getByRole('region', { name: 'Plan', exact: true });
  const form = plan.getByRole('form', { name: 'The new project' });
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Bakery shop');
  await expect(form.getByLabel('Key')).toHaveValue('BS');
  await expect(form.getByLabel('Repository name')).toHaveValue('bakery-shop');
  await expect(form.getByLabel('Private')).toBeChecked();
  await expect(form).toContainText('Website');
  await expect(form).toContainText('The bakery online.');
  await expect(form.getByText('This name is free.')).toBeVisible();

  // The key checked as it is typed.
  await form.getByLabel('Key').fill('S');
  await expect(form.getByText('Use 2 to 6 capital letters, for example WEB.')).toBeVisible();
  await form.getByLabel('Key').fill('SHOP');
  await expect(form.getByText('Use 2 to 6 capital letters, for example WEB.')).toBeHidden();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'plan-new-project-form');

  await form.getByRole('button', { name: 'Approve' }).click();
  const approve = page.getByRole('dialog', { name: 'Approve this plan?' });
  await expect(approve).toContainText(
    "It creates the project Bakery shop (SHOP) and its private repository octo-owner/bakery-shop on GitHub with the starting files, then 2 tickets in SHOP, in To do. They wait for the project's setup; then the scheduler starts them by themselves as machines are free: each one uses Claude Code sessions.",
  );
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'plan-new-project-approve');
  await approve.getByRole('button', { name: 'Approve' }).click();
  await expect(approve).toBeHidden();

  await expect(plan.getByRole('heading', { name: /^Plan, approved by you at / })).toBeVisible();
  await expect(page.getByText('Closed', { exact: true })).toBeVisible();
  await expect(
    plan
      .getByRole('list', { name: 'Tickets of the plan' })
      .getByRole('listitem', { name: 'setup · Set up the project' })
      .getByRole('link', {
        name: 'SHOP-1',
      }),
  ).toBeVisible();
  await expect(plan).toContainText('Project SHOP was created:');
  await expectFitsScreen(page);
  await plan.getByRole('link', { name: 'its setup is shown on its page' }).click();
  await expect(page.getByRole('heading', { name: 'Bakery shop' })).toBeVisible();
  await expect(page.getByText('bakery-shop', { exact: false }).first()).toBeVisible();
});
