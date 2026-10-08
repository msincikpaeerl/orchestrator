import type { Page } from '@playwright/test';
import {
  BRANCH_HEAD,
  COMMITS,
  callTool,
  completeSetup,
  createReadyProject,
  daemonRequest,
  expect,
  expectFitsScreen,
  readyForRuns,
  reportState,
  runNow,
  runSent,
  sendLog,
  startRun,
  test,
} from './fixtures';

// Runs on the ticket page and the run page, live (lot 2 step L1; 02, sections 1, 6.3, 6.4 and 7),
// with the scripted daemon of apps/server/test/e2e-server.ts playing the machine.

/** Marks the page, so a test can prove it was never reloaded. */
async function markPage(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { notReloaded: boolean }).notReloaded = true;
  });
}

async function expectNotReloaded(page: Page) {
  expect(
    await page.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded),
  ).toBe(true);
}

function runStatus(page: Page) {
  return page.getByLabel('Run status');
}

/** The ticket page's active run, running. */
function runningOnLaptop(page: Page) {
  return page.getByText(/^Running · attempt 1 on Laptop/);
}

test('Run now shows why a run cannot start', async ({ page }) => {
  await completeSetup(page);
  await createReadyProject(page, { key: 'WEB', name: 'Bakery website', repository: 'bakery' });
  const created = await page.request.post('/api/projects/WEB/tickets', {
    data: { type: 'feature', title: 'Contact form' },
  });
  expect(created.status()).toBe(201);
  await page.goto('/projects/WEB/tickets/1');

  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Choose an assignee first: the agent that should do this ticket.',
  );
  await expectFitsScreen(page);

  // With an assignee, the next reason: no machine yet.
  const edited = await page.request.patch('/api/projects/WEB/tickets/1', {
    data: { assignee: 'web_dev' },
  });
  expect(edited.status()).toBe(200);
  await page.reload();
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'No machine can take the run: add a machine in Machines first.',
  );
  await expect(page).toHaveURL(/\/tickets\/1$/);
});

test('a run shows its log lines and progress as they come, without reloading', async ({ page }) => {
  await page.goto(await readyForRuns(page));
  const runId = await runNow(page);
  await markPage(page);
  await expect(runStatus(page)).toHaveText('Sent to its machine');

  const runToken = await startRun(page, runId);
  await expect(runStatus(page)).toHaveText('Running');
  await sendLog(page, runId, 0, ['Reading CLAUDE.md', 'Writing the contact form']);
  const log = page.getByRole('list', { name: 'Log' });
  await expect(log.getByRole('listitem')).toHaveCount(2);
  await expect(log).toContainText('Reading CLAUDE.md');
  await expect(log).toContainText('Writing the contact form');
  await expect(page.getByText('$0.42 (estimated by Claude Code)')).toBeVisible();

  await sendLog(page, runId, 2, ['Running the tests']);
  await expect(log.getByRole('listitem')).toHaveCount(3);
  await callTool(page, runToken, 'ticket_progress', { text: 'Form written, testing it' });
  await expect(page.getByLabel('Progress')).toContainText('Form written, testing it');
  await expectNotReloaded(page);
  await expectFitsScreen(page);

  // The board card shows the active run with its progress line.
  await page.goto('/projects/WEB');
  const card = page.getByRole('list', { name: 'In progress' }).getByRole('listitem');
  await expect(card.getByLabel('Active run')).toContainText('Running on Laptop');
  await expect(card.getByLabel('Active run')).toContainText('Form written, testing it');
  await expectFitsScreen(page);
});

test("the agent's question is answered on the ticket page", async ({ page }) => {
  const ticketPage = await readyForRuns(page);
  await page.goto(ticketPage);
  const runId = await runNow(page);
  const runToken = await startRun(page, runId);
  await page.goto(ticketPage);
  // Loaded first: what follows can only reach the page through the stream.
  await expect(runningOnLaptop(page)).toBeVisible();
  await markPage(page);

  await callTool(page, runToken, 'ticket_ask', {
    question: 'Should the form also ask for a **phone number**?',
  });
  const question = page.getByRole('region', { name: 'Question from the agent' });
  await expect(question).toContainText('Should the form also ask for a phone number?');
  await expect(page.getByText('Waiting for you').first()).toBeVisible();
  await expectFitsScreen(page);

  await question.getByLabel('Your answer').fill('No, the e-mail address is enough.');
  await question.getByRole('button', { name: 'Send answer' }).click();
  await expect(question).toBeHidden();
  await expect(page.getByRole('list', { name: 'Timeline' })).toContainText(
    'No, the e-mail address is enough.',
  );
  await expect(page.getByText('In progress').first()).toBeVisible();
  await expectNotReloaded(page);
});

test("an agent's proposed ticket is accepted", async ({ page }) => {
  await page.goto(await readyForRuns(page));
  const runId = await runNow(page);
  const runToken = await startRun(page, runId);
  await page.goto('/projects/WEB');
  await expect(page.getByRole('list', { name: 'In progress' })).toContainText('Contact form');
  await expect(page.getByRole('heading', { name: /^Proposed/ })).toBeHidden();

  await callTool(page, runToken, 'ticket_create', {
    type: 'bug',
    title: 'Menu overlaps the logo on phones',
    description: 'Seen while testing the contact form.',
    acceptance_criteria: ['The menu never covers the logo'],
    priority: 'normal',
  });
  const proposed = page.getByRole('list', { name: 'Proposed' });
  await expect(proposed.getByRole('listitem')).toContainText('Menu overlaps the logo on phones');
  await expect(proposed.getByText('created by agent')).toBeVisible();
  await expectFitsScreen(page);

  await proposed.getByRole('link', { name: /WEB-2/ }).click();
  await expect(page.getByText(/by agent Web Developer/)).toBeVisible();
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('To do', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run now' })).toBeVisible();

  await page.goto('/projects/WEB');
  await expect(page.getByRole('list', { name: 'To do' })).toContainText(
    'Menu overlaps the logo on phones',
  );
  await expect(page.getByRole('heading', { name: /^Proposed/ })).toBeHidden();
});

test('a finished run shows the branch and its commits on the ticket page', async ({ page }) => {
  const ticketPage = await readyForRuns(page);
  await page.goto(ticketPage);
  const runId = await runNow(page);
  const runToken = await startRun(page, runId);
  await page.goto(ticketPage);
  // Loaded first: what follows can only reach the page through the stream.
  await expect(runningOnLaptop(page)).toBeVisible();
  await markPage(page);

  await callTool(
    page,
    runToken,
    'ticket_submit',
    {
      criteria: [
        { index: 0, status: 'met', justification: 'The contact page shows the form.' },
        { index: 1, status: 'met', justification: 'An invalid address is refused.' },
      ],
      tests: { paths: ['src/contact.test.ts'], justification: null },
      docs: { paths: [], justification: 'No user documentation in this project yet.' },
      adrs: [],
      summary: 'Adds the contact form with its checks.',
    },
    {
      clean: true,
      branch: { name: 't/1-contact-form', head: BRANCH_HEAD, commitsAhead: COMMITS },
    },
  );
  await reportState(page, runId, 'ended');

  await expect(page.getByText('In review').first()).toBeVisible();
  await expect(page.getByLabel('Branch')).toHaveText(
    't/1-contact-form on machine Laptop, not on GitHub yet',
  );
  const commits = page.getByRole('list', { name: 'Commits' });
  await expect(commits.getByRole('listitem')).toHaveText([
    'ccccccc Add the contact form',
    'bbbbbbb Check the e-mail address',
  ]);
  const report = page.getByRole('heading', { name: "Agent's report" }).locator('..');
  await expect(report).toContainText('Adds the contact form with its checks.');
  await expect(report.getByRole('list', { name: 'Criteria in the report' })).toContainText(
    'Met: The contact page has a form',
  );
  const runs = page.getByRole('list', { name: 'Runs' });
  await expect(runs).toContainText('Attempt 1 · Implement the ticket');
  await expect(runs).toContainText('Finished');
  await expectNotReloaded(page);
  await expectFitsScreen(page);

  await runs.getByRole('link', { name: /Attempt 1/ }).click();
  await expect(runStatus(page)).toHaveText('Finished');
  await expect(page.getByRole('list', { name: 'Commits' }).getByRole('listitem')).toHaveCount(2);
  await expectFitsScreen(page);
});

test('the ticket page says where the branch is: on the machine, pushed, both, or diverged', async ({
  page,
}) => {
  // Lot 3 step D3: each wording of the Branch card, from the pushes the daemon reports.
  const ticketPage = await readyForRuns(page);
  const branch = page.getByLabel('Branch', { exact: true });
  const hash = (digit: string) => digit.repeat(40);
  const commit = (digit: string, subject: string) => ({ hash: hash(digit), subject });
  const D = commit('d', 'Show a thank-you message');
  const E = commit('e', 'Fix the button colour');
  const F = commit('f', 'Translate the form');
  // As a protocol 2 machine reports it: its commits on no branch fetched from GitHub.
  const told = (hashes: string[]) => ({ listed: hashes, count: hashes.length });
  const ended = (runId: string, extra: Record<string, unknown>) =>
    reportState(page, runId, 'ended', { reason: 'crashed', detail: null, ...extra });
  async function nextRun(): Promise<{ runId: string; runToken: string }> {
    await page.goto(ticketPage);
    const runId = await runNow(page);
    return { runId, runToken: await startRun(page, runId) };
  }

  // No commits reported yet.
  const first = await nextRun();
  await page.goto(ticketPage);
  await expect(branch).toHaveText('t/1-contact-form: no commits reported yet');
  await expectFitsScreen(page);

  // On the machine only, its push failed.
  await ended(first.runId, {
    branch: {
      name: 't/1-contact-form',
      head: BRANCH_HEAD,
      commitsAhead: COMMITS,
      notOnGitHub: told(COMMITS.map((each) => each.hash)),
    },
    push: {
      status: 'failed',
      reason: 'unreachable',
      message: 'Could not resolve host: github.com',
    },
  });
  await page.goto(ticketPage);
  await expect(branch).toHaveText('t/1-contact-form on machine Laptop, not on GitHub yet');
  await expect(page.getByLabel('Failed push')).toContainText(
    'from machine Laptop failed: Could not resolve host: github.com',
  );
  await expect(page.getByLabel('Last push')).toBeHidden();
  await expectFitsScreen(page);

  // Pushed: every commit, with the date of the push and the branch's page on GitHub.
  const second = await nextRun();
  await ended(second.runId, {
    branch: {
      name: 't/1-contact-form',
      head: BRANCH_HEAD,
      commitsAhead: COMMITS,
      notOnGitHub: told([]),
    },
    push: { status: 'pushed', head: BRANCH_HEAD },
  });
  await expect(page.getByLabel('Push')).toContainText('This run pushed it to GitHub on');
  await page.goto(ticketPage);
  await expect(branch).toHaveText(
    't/1-contact-form: every commit reported was on GitHub when machine Laptop last pushed or downloaded the branch',
  );
  const lastPush = page.getByLabel('Last push');
  await expect(lastPush).toContainText(
    /^Last pushed to GitHub on .+ from machine Laptop \(latest commit aaaaaaa\)\./,
  );
  await expect(lastPush.getByRole('link', { name: 'Branch on GitHub' })).toHaveAttribute(
    'href',
    /^https:\/\/github\.com\/[^/]+\/bakery\/tree\/t\/1-contact-form$/,
  );
  await expect(page.getByLabel('Failed push')).toBeHidden();
  await expectFitsScreen(page);

  // Both: a commit made after an accepted submission stays on the machine.
  const third = await nextRun();
  await callTool(
    page,
    third.runToken,
    'ticket_submit',
    {
      criteria: [
        { index: 0, status: 'met', justification: 'The contact page shows the form.' },
        { index: 1, status: 'met', justification: 'An invalid address is refused.' },
      ],
      tests: { paths: ['src/contact.test.ts'], justification: null },
      docs: { paths: [], justification: 'No user documentation in this project yet.' },
      adrs: [],
      summary: 'Adds the thank-you message.',
    },
    {
      clean: true,
      branch: {
        name: 't/1-contact-form',
        head: D.hash,
        commitsAhead: [D, ...COMMITS],
        notOnGitHub: told([D.hash]),
      },
      push: { status: 'pushed', head: D.hash },
    },
  );
  await reportState(page, third.runId, 'ended', {
    branch: {
      name: 't/1-contact-form',
      head: E.hash,
      commitsAhead: [E, D, ...COMMITS],
      notOnGitHub: told([E.hash]),
    },
  });
  await page.goto(ticketPage);
  await expect(branch).toHaveText(
    't/1-contact-form: 1 newer commit on machine Laptop, not on GitHub yet',
  );
  await expect(
    page.getByRole('list', { name: 'Commits not on GitHub' }).getByRole('listitem'),
  ).toHaveText(['eeeeeee Fix the button colour']);
  await expect(
    page.getByRole('list', { name: 'Commits on GitHub' }).getByRole('listitem'),
  ).toHaveText([
    'ddddddd Show a thank-you message',
    'ccccccc Add the contact form',
    'bbbbbbb Check the e-mail address',
  ]);
  await expect(page.getByLabel('Last push')).toContainText('(latest commit ddddddd)');
  await expectFitsScreen(page);

  // Diverged: the next push is refused, GitHub's branch having commits the machine lacks.
  const changes = await page.request.post('/api/projects/WEB/tickets/1/request-changes', {
    data: { comment: 'Translate the form too' },
  });
  expect(changes.status()).toBe(200);
  const fourth = await nextRun();
  await ended(fourth.runId, {
    branch: {
      name: 't/1-contact-form',
      head: F.hash,
      commitsAhead: [F, E, D, ...COMMITS],
      notOnGitHub: told([F.hash, E.hash]),
    },
    push: { status: 'failed', reason: 'diverged', message: 'Updates were rejected (fetch first)' },
  });
  await page.goto(ticketPage);
  await expect(branch).toHaveText(
    "t/1-contact-form on machine Laptop, not on GitHub yet: GitHub's branch has commits this machine does not have, so the push was refused. The Orchestrator never overwrites GitHub's branch.",
  );
  await expect(
    page.getByRole('list', { name: 'Commits not on GitHub' }).getByRole('listitem'),
  ).toHaveText(['fffffff Translate the form', 'eeeeeee Fix the button colour']);
  await expect(page.getByLabel('Failed push')).toContainText('Updates were rejected (fetch first)');
  await expectFitsScreen(page);
});

test('a run whose download was stopped by Longest push says so on its page', async ({ page }) => {
  const ticketPage = await readyForRuns(page);
  await page.goto(ticketPage);
  const runId = await runNow(page);
  await runSent(page, runId);
  await reportState(page, runId, 'preparing');
  const detail =
    'The workspace could not be prepared: Downloading the project from GitHub took longer than Longest push (60 seconds, in Settings > Limits) and was stopped. The first download on a new machine takes the longest.';
  await reportState(page, runId, 'ended', { reason: 'crashed', detail, branch: null });

  await expect(runStatus(page)).toHaveText(
    'Failed: its Claude Code session stopped unexpectedly or never started',
  );
  await expect(page.getByLabel('Why the run ended')).toHaveText(detail);
  await expectFitsScreen(page);
});

test('a run paused on a suspected usage limit is resumed', async ({ page }) => {
  const ticketPage = await readyForRuns(page);
  await page.goto(ticketPage);
  const runId = await runNow(page);
  await startRun(page, runId);
  await page.goto(ticketPage);
  // Loaded first: what follows can only reach the page through the stream.
  await expect(runningOnLaptop(page)).toBeVisible();
  await markPage(page);

  const answer = await daemonRequest(page, 'run.quota_limited', {
    runId,
    kind: 'suspected',
    evidence: {
      signal: 'stop_failure',
      error: 'overloaded',
      message: 'API Error: 529 Overloaded',
      statusLine: null,
    },
  });
  expect(answer).toMatchObject({ type: 'ack', payload: { ok: true } });
  await expect(
    page.getByText(
      'Run paused: possible Claude usage limit. You can resume it now; the run may pause again if it was the limit.',
    ),
  ).toBeVisible();
  await expectFitsScreen(page);

  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeHidden();
  expect((await runSent(page, runId)).type).toBe('run.resume');
  await reportState(page, runId, 'working');
  await expect(runningOnLaptop(page)).toBeVisible();
  await expectNotReloaded(page);
});
