import type { Page } from '@playwright/test';
import {
  BRANCH_HEAD,
  COMMITS,
  callTool,
  ciPasses,
  daemonRequest,
  expect,
  expectFitsScreen,
  readyForRuns,
  reportState,
  runNow,
  screenshot,
  startRun,
  test,
} from './fixtures';

// A submission on the ticket page and the run page (02, sections 6.4 and 7; lot 3 step F4): the
// pull request, each check's result in the owner's words, the workflow warning, "Pull request not
// opened" with Try again, and a run's latest refused submission. Each test saves pictures of the
// screens for the owner (apps/web/e2e-screenshots/).

const REPORT = {
  criteria: [
    { index: 0, status: 'met', justification: 'The contact page shows the form.' },
    { index: 1, status: 'met', justification: 'An invalid address is refused.' },
  ],
  tests: { paths: ['src/contact.test.ts'], justification: null },
  docs: { paths: ['docs/user/contact.md'], justification: null },
  adrs: [],
  summary: 'Adds the contact form with its checks.',
};

const CHANGED = ['docs/user/contact.md', 'src/contact.test.ts', 'src/contact.ts'];

function workspace(changedFiles: { listed: string[]; count: number }) {
  return {
    clean: true,
    branch: { name: 't/1-contact-form', head: BRANCH_HEAD, commitsAhead: COMMITS },
    push: { status: 'pushed', head: BRANCH_HEAD },
    changedFiles,
  };
}

/** `WEB-1` with its run working, and the ticket's branch pushed on the fake GitHub. */
async function working(
  page: Page,
  gitHubCommit: (commit: {
    repository: string;
    branch: string;
    files: Record<string, string | null>;
    message: string;
    from?: string;
  }) => Promise<unknown>,
) {
  const ticketPage = await readyForRuns(page);
  await page.goto(ticketPage);
  const runId = await runNow(page);
  const runToken = await startRun(page, runId);
  await gitHubCommit({
    repository: 'bakery',
    branch: 't/1-contact-form',
    files: { 'src/contact.ts': 'export {};\n' },
    message: 'Add the contact form',
    from: 'main',
  });
  return { ticketPage, runId, runToken };
}

const pullRequestCard = (page: Page) =>
  page
    .getByRole('main')
    .locator('div', { has: page.getByRole('heading', { name: 'Pull request' }) })
    .last();

test('a submitted ticket shows its pull request link and every check passed', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const { ticketPage, runId, runToken } = await working(page, gitHubCommit);
  const answer = await callTool(
    page,
    runToken,
    'ticket_submit',
    REPORT,
    workspace({ listed: CHANGED, count: CHANGED.length }),
  );
  expect(answer).toMatchObject({ result: 'pending_ci' });
  await ciPasses(page, runId);
  await reportState(page, runId, 'ended');

  await page.goto(ticketPage);
  const link = page.getByRole('link', { name: 'Pull request #1' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', /\/bakery\/pull\/1$/);
  await expect(page.getByLabel('Pull request', { exact: true })).toHaveText(
    'Pull request #1 · Open',
  );
  await expect(page.getByText('Opening the pull request on GitHub…')).toBeHidden();
  await expect(page.getByLabel('Workflow warning')).toBeHidden();

  const checks = page.getByRole('list', { name: 'Checks' }).locator(':scope > li');
  await expect(checks).toHaveText([
    /^Acceptance criteria metPassed/,
    /^All work committedPassed/,
    /^Commits on the branchPassed/,
    /^Branch pushed to GitHubPassed/,
    /^Rules of the ticket typePassed/,
    /^Listed files changed on the branchPassed/,
  ]);
  await expect(page.getByRole('list', { name: 'Tests' })).toHaveText('src/contact.test.ts');
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'ticket-pull-request-checks-passed');
});

test('a check that could not be fully done says why, and workflow files raise a warning', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const { ticketPage, runId, runToken } = await working(page, gitHubCommit);
  // The machine could send only 2 of 1,500 changed files; one is a workflow.
  const answer = await callTool(
    page,
    runToken,
    'ticket_submit',
    REPORT,
    workspace({ listed: ['.github/workflows/ci.yml', 'src/contact.ts'], count: 1500 }),
  );
  expect(answer).toMatchObject({ result: 'pending_ci' });
  await ciPasses(page, runId);
  await reportState(page, runId, 'ended');

  await page.goto(ticketPage);
  await expect(page.getByRole('link', { name: 'Pull request #1' })).toBeVisible();
  const paths = page
    .getByRole('list', { name: 'Checks' })
    .locator(':scope > li')
    .filter({ hasText: 'Listed files changed on the branch' });
  await expect(paths).toContainText('Could not be fully done');
  await expect(
    paths.getByRole('list', { name: 'Why: Listed files changed on the branch' }),
  ).toHaveText(
    'The machine could send only 2 of the 1,500 files the branch changed, so 2 files the agent listed could not be compared. This never refuses the work.',
  );
  // The agent's own words are folded, and never shown as the owner's.
  const told = paths.getByText('What the agent was told');
  await expect(paths.getByText(/^Could not be fully done: this machine listed/)).toBeHidden();
  await told.click();
  await expect(paths.getByText(/^Could not be fully done: this machine listed/)).toBeVisible();

  const warning = page.getByLabel('Workflow warning');
  await expect(warning).toContainText('Workflow files changed');
  await expect(warning).toContainText(
    'Before merging, look at the changed files on the pull request',
  );
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'ticket-check-not-fully-done');
  await screenshot(pullRequestCard(page), testInfo, 'ticket-workflow-flag');
});

test('"Pull request not opened" on the ticket page, then Try again opens it', async ({
  page,
  gitHubCommit,
  failNextGitHubRequest,
}, testInfo) => {
  const { ticketPage, runId, runToken } = await working(page, gitHubCommit);
  await failNextGitHubRequest('GET', '/pulls', 502);
  const answer = await callTool(
    page,
    runToken,
    'ticket_submit',
    REPORT,
    workspace({ listed: CHANGED, count: CHANGED.length }),
  );
  expect(answer).toMatchObject({ result: 'pending_ci' });
  await ciPasses(page, runId);
  await reportState(page, runId, 'ended');

  await page.goto(ticketPage);
  const notOpened = page.getByLabel('Pull request not opened');
  await expect(notOpened).toContainText('Pull request not opened: GitHub could not be reached');
  await expect(notOpened).toContainText('The work of WEB-1 is on GitHub');
  await expect(notOpened.getByRole('link', { name: 'Open the ticket' })).toHaveCount(0);
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'ticket-pull-request-not-opened');

  await notOpened.getByRole('button', { name: 'Try again' }).click();
  await expect(notOpened).toBeHidden();
  await expect(page.getByRole('link', { name: 'Pull request #1' })).toBeVisible();
});

test("a run page shows its latest refused submission, why in plain words and the agent's words folded", async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const { runId, runToken } = await working(page, gitHubCommit);
  const longPath =
    'docs/user/guides/getting-started/contact-form/accessibility-and-keyboard-navigation-of-the-contact-form-on-small-screens.md';
  const answer = await daemonRequest(page, 'mcp.call', {
    tool: 'ticket_submit',
    runToken,
    input: {
      ...REPORT,
      criteria: [
        { index: 0, status: 'not_met', justification: 'The phone field is missing.' },
        { index: 1, status: 'met', justification: 'An invalid address is refused.' },
      ],
      docs: { paths: [longPath, 'docs/user'], justification: null },
    },
    workspace: workspace({ listed: CHANGED, count: CHANGED.length }),
  });
  expect(answer.payload).toMatchObject({ ok: false, error: { code: 'DOD_FAILED' } });

  await page.goto(`/activity/runs/${runId}`);
  const refused = page
    .getByRole('main')
    .locator('div', { has: page.getByRole('heading', { name: 'Latest refused submission' }) })
    .last();
  await expect(refused).toBeVisible();
  const checks = refused.getByRole('list', { name: 'Checks' }).locator(':scope > li');
  await expect(checks.filter({ hasText: 'Acceptance criteria met' })).toContainText(
    'The agent reported criterion 1 as not met: “The contact page has a form”.',
  );
  const paths = checks.filter({ hasText: 'Listed files changed on the branch' });
  await expect(paths).toContainText('Failed');
  await expect(
    paths
      .getByRole('list', { name: 'Why: Listed files changed on the branch' })
      .getByRole('listitem'),
  ).toHaveText([
    `Documentation listed: “${longPath}” is not a file the ticket's branch changed.`,
    'Documentation listed: “docs/user” is a folder. Only files are accepted.',
  ]);
  // No name from the agent's texts in the owner's lines.
  await expect(
    refused.getByText(/docs\.paths|not_met|ticket_ask|origin\//).filter({ visible: true }),
  ).toHaveCount(0);
  await paths.getByText('What the agent was told').click();
  await expect(paths.getByText(/^docs\.paths: "docs\/user" is a folder/)).toBeVisible();
  await refused.getByText('Files the agent listed').click();
  await expect(refused.getByRole('list', { name: 'Documentation' })).toContainText(longPath);
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'run-refused-submission');
});

test('a refused submission followed by an accepted one says the work was accepted afterwards', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const { runId, runToken } = await working(page, gitHubCommit);
  const refusedAnswer = await daemonRequest(page, 'mcp.call', {
    tool: 'ticket_submit',
    runToken,
    input: {
      ...REPORT,
      criteria: [{ index: 0, status: 'not_met', justification: 'The phone field is missing.' }],
    },
    workspace: workspace({ listed: CHANGED, count: CHANGED.length }),
  });
  expect(refusedAnswer.payload).toMatchObject({ ok: false });
  const answer = await callTool(
    page,
    runToken,
    'ticket_submit',
    REPORT,
    workspace({ listed: CHANGED, count: CHANGED.length }),
  );
  expect(answer).toMatchObject({ result: 'pending_ci' });
  await ciPasses(page, runId);
  await reportState(page, runId, 'ended');

  await page.goto(`/activity/runs/${runId}`);
  await expect(page.getByLabel('Run status')).toHaveText('Finished');
  await expect(page.getByLabel('Accepted afterwards')).toHaveText(
    /^The agent then handed its work in again, and it was accepted on .+\. The results below are those of the earlier, refused submission\.$/,
  );
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'run-refused-then-accepted');
});

test('an open pull request a later submission could not update says "Pull request not updated"', async ({
  page,
  gitHubCommit,
  failNextGitHubRequest,
}, testInfo) => {
  const { ticketPage, runId, runToken } = await working(page, gitHubCommit);
  const facts = workspace({ listed: CHANGED, count: CHANGED.length });
  expect(await callTool(page, runToken, 'ticket_submit', REPORT, facts)).toMatchObject({
    result: 'pending_ci',
  });
  await ciPasses(page, runId);
  await reportState(page, runId, 'ended');
  await page.goto(ticketPage);
  await expect(page.getByRole('link', { name: 'Pull request #1' })).toBeVisible();

  // Sent back, a second run, and GitHub unreachable when the server updates the pull request.
  const changes = await page.request.post('/api/projects/WEB/tickets/1/request-changes', {
    data: { comment: 'Also ask for a phone number.' },
  });
  expect(changes.status()).toBe(200);
  await page.reload();
  const next = await runNow(page);
  const nextToken = await startRun(page, next);
  await failNextGitHubRequest('GET', '/pulls', 502);
  expect(
    await callTool(
      page,
      nextToken,
      'ticket_submit',
      { ...REPORT, summary: 'Adds the phone number too.' },
      facts,
    ),
  ).toMatchObject({ result: 'pending_ci' });
  await ciPasses(page, next);
  await reportState(page, next, 'ended');

  await page.goto(ticketPage);
  await expect(page.getByLabel('Pull request', { exact: true })).toHaveText(
    'Pull request #1 · Open',
  );
  const notUpdated = page.getByLabel('Pull request not updated');
  await expect(notUpdated).toContainText('Pull request not updated: GitHub could not be reached');
  await expect(notUpdated).toContainText(
    'could not update its pull request #1: its description still shows the report of the earlier submission. The new commits are on GitHub, in the pull request.',
  );
  await expect(page.getByLabel('Pull request not opened')).toHaveCount(0);
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'ticket-pull-request-not-updated');

  await page.goto('/');
  await expect(
    page.getByRole('heading', {
      name: 'Pull request not updated for WEB-1: GitHub could not be reached',
    }),
  ).toBeVisible();
  await page.goto(ticketPage);
  await notUpdated.getByRole('button', { name: 'Try again' }).click();
  await expect(notUpdated).toBeHidden();
});
