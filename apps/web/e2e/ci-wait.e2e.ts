import type { Page } from '@playwright/test';
import {
  BRANCH_HEAD,
  COMMITS,
  callTool,
  ciCheck,
  expect,
  expectFitsScreen,
  holdDaemonInput,
  readyForRuns,
  reportState,
  runNow,
  screenshot,
  startRun,
  test,
} from './fixtures';

// The run page while a run waits for CI (02, section 7; lot 3 step G1b): the status "Waiting for
// CI", the CI card with each check, the line when GitHub could not be checked, and a conflict.
// Each test saves pictures of the screen for the owner (apps/web/e2e-screenshots/).

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

/** A long name, as a deployment service may give its status: shows how a check line wraps. */
const LONG_NAME =
  'Preview deployment of the bakery website on the staging environment (europe-west, Paris)';

/** `WEB-1`'s work accepted, its pull request opened, the session idle waiting for CI. */
async function waiting(
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
  const answer = await callTool(page, runToken, 'ticket_submit', REPORT, {
    clean: true,
    branch: { name: 't/1-contact-form', head: BRANCH_HEAD, commitsAhead: COMMITS },
    push: { status: 'pushed', head: BRANCH_HEAD },
    changedFiles: { listed: CHANGED, count: CHANGED.length },
  });
  expect(answer).toMatchObject({ result: 'pending_ci' });
  await reportState(page, runId, 'waiting_ci');
  await page.goto(ticketPage);
  await expect(page.getByLabel('Pull request', { exact: true })).toHaveText(
    'Pull request #1 · Open',
  );
  await page.goto(`/activity/runs/${runId}`);
  return runId;
}

const ciCard = (page: Page) => page.getByLabel('Waiting for CI');

test('a run waiting for CI shows the commit, until when it waits, and each check', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const runId = await waiting(page, gitHubCommit);
  await ciCheck(page, runId, {
    runs: [{ name: 'CI', status: 'in_progress', conclusion: null }],
    statuses: [{ context: LONG_NAME, state: 'success' }],
  });
  await expect(page.getByLabel('Run status')).toHaveText('Waiting for CI');
  await expect(ciCard(page)).toContainText(
    `Waiting for CI on GitHub for commit ${BRANCH_HEAD.slice(0, 7)} (pull request #1) since`,
  );
  await expect(ciCard(page)).toContainText('the run stops without counting as a failed attempt.');
  await expect(ciCard(page)).toContainText('Last checked at');
  const checks = page.getByRole('list', { name: 'CI checks' }).locator(':scope > li');
  await expect(checks).toHaveText([
    /^CI · workflow Not finished on GitHub$/,
    new RegExp(`^${LONG_NAME.replace(/[()]/g, '\\$&')} · status Passed on GitHub$`),
  ]);
  await expect(checks.first().getByRole('link', { name: 'on GitHub' })).toHaveAttribute(
    'href',
    /\/actions\/runs\/1$/,
  );
  await expect(page.getByLabel('GitHub problem')).toBeHidden();
  // The board's card says it too.
  await page.goto('/projects/WEB');
  await expect(page.getByText(/^Waiting for CI on /)).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('Run status')).toHaveText('Waiting for CI');
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'run-waiting-for-ci');
});

test('a run waiting for CI says when GitHub could not be checked, and until when', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const runId = await waiting(page, gitHubCommit);
  await ciCheck(page, runId, { runs: [{ name: 'CI', status: 'queued', conclusion: null }] });
  await ciCheck(page, runId, { rateLimitedSeconds: 600 });
  const problem = page.getByLabel('GitHub problem');
  await expect(problem).toContainText(
    /^GitHub could not be checked at .+ \(since .+\): GitHub's request limit was reached; it allows requests again at .+\. The run keeps waiting and the Orchestrator asks again\.$/,
  );
  // The latest result read stays shown.
  await expect(page.getByRole('list', { name: 'CI checks' })).toHaveText(
    /^CI · workflow Not finished/,
  );
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'run-waiting-for-ci-github-problem');
});

test('a run waiting for CI says when the pull request conflicts with the default branch', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const runId = await waiting(page, gitHubCommit);
  await ciCheck(page, runId, { startedMinutesAgo: 1 });
  await expect(ciCard(page)).toContainText(
    'No CI run or status has appeared on GitHub yet. If none appears by',
  );
  await expect(ciCard(page)).toContainText(
    'the work is accepted as “No CI found”, unless the pull request conflicts with main.',
  );
  // The daemon has not confirmed the round yet: the run still waits. Its confirmation ends the
  // wait (lot 3 step G2b), which came 32 ms later in a CI run that then failed here.
  await holdDaemonInput(page, true);
  await ciCheck(page, runId, { startedMinutesAgo: 6, mergeable: false });
  await expect(ciCard(page)).toContainText(
    'The pull request conflicts with main, so GitHub started no CI and the work cannot be accepted: the agent is told to merge main and resolve the conflict, then hand its work in again.',
  );
  await expect(page.getByLabel('Run status')).toHaveText('Waiting for CI');
  await expect(page.getByRole('list', { name: 'CI checks' })).toBeHidden();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'run-waiting-for-ci-conflict');
  // Confirmed: the agent works on the conflict, the run no longer waits for CI.
  await holdDaemonInput(page, false);
  await expect(page.getByLabel('Run status')).toHaveText('Running');
  await expect(ciCard(page)).toBeHidden();
});
