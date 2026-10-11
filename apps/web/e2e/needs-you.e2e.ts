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
  runSent,
  startRun,
  test,
} from './fixtures';

// "Needs you" with agents' work (lot 2 step L2; 02, section 4): questions, proposed tickets,
// finished work and paused runs, with the scripted daemon of apps/server/test/e2e-server.ts.

/** A run of WEB-1 started from its ticket page and working; its id and run token. */
async function working(page: Page): Promise<{ runId: string; runToken: string }> {
  await page.goto(await readyForRuns(page));
  const runId = await runNow(page);
  return { runId, runToken: await startRun(page, runId) };
}

/** The item of "Needs you" whose text matches. */
function item(page: Page, text: string | RegExp) {
  return page.getByRole('main').getByRole('listitem').filter({ hasText: text });
}

async function limited(
  page: Page,
  runId: string,
  kind: 'detected' | 'suspected',
  resetsAt?: string,
) {
  const answer = await daemonRequest(page, 'run.quota_limited', {
    runId,
    kind,
    ...(kind === 'detected' ? { resetsAt: resetsAt ?? null } : {}),
    evidence: {
      signal: 'stop_failure',
      error: kind === 'detected' ? 'rate_limit' : 'overloaded',
      message: kind === 'detected' ? "You've hit your session limit" : 'API Error: 529 Overloaded',
      statusLine: null,
    },
  });
  expect(answer).toMatchObject({ type: 'ack', payload: { ok: true } });
}

test("the agent's question is answered from Needs you", async ({ page }) => {
  const { runToken } = await working(page);
  await callTool(page, runToken, 'ticket_ask', {
    question: 'Should the form also ask for a **phone number**?',
  });
  await page.goto('/');
  const question = page.getByRole('region', { name: 'Question from the agent' });
  await expect(question).toContainText('Should the form also ask for a phone number?');
  await expect(page.getByRole('link', { name: 'WEB-1 · Contact form' })).toBeVisible();
  await expectFitsScreen(page);

  await question.getByLabel('Your answer').fill('No, the e-mail address is enough.');
  await question.getByRole('button', { name: 'Send answer' }).click();
  await expect(question).toBeHidden();
  await expect(page.getByText('Nothing needs you right now.')).toBeVisible();
});

test("an agent's proposed ticket is accepted from Needs you", async ({ page }) => {
  const { runToken } = await working(page);
  await callTool(page, runToken, 'ticket_create', {
    type: 'bug',
    title: 'Menu overlaps the logo on phones',
    description: 'Seen while testing the contact form.',
    acceptance_criteria: ['The menu never covers the logo'],
    priority: 'normal',
  });
  await page.goto('/');
  const proposed = item(page, 'Ticket proposed by agent Web Developer');
  await expect(proposed.getByRole('link')).toHaveText('WEB-2 · Menu overlaps the logo on phones');
  await expectFitsScreen(page);

  await proposed.getByRole('button', { name: 'Accept' }).click();
  await expect(proposed).toBeHidden();
  await page.goto('/projects/WEB/tickets/2');
  await expect(page.getByRole('button', { name: 'Run now' })).toBeVisible();
});

test('a run paused on a suspected usage limit is resumed from Needs you', async ({ page }) => {
  const { runId } = await working(page);
  await page.goto('/');
  await expect(page.getByText('Nothing needs you right now.')).toBeVisible();
  await limited(page, runId, 'suspected');

  const paused = item(page, 'Run paused: possible Claude usage limit');
  await expect(paused).toContainText('the run may pause again if it was the limit');
  await expect(page.getByRole('list', { name: 'Claude accounts' })).toHaveText(
    'Personal: Available',
  );
  await expectFitsScreen(page);

  await paused.getByRole('button', { name: 'Resume' }).click();
  await expect(paused).toBeHidden();
  expect((await runSent(page, runId)).type).toBe('run.resume');
});

test('a limited account shows as limited, then available once its time has passed', async ({
  page,
}) => {
  const { runId } = await working(page);
  await page.goto('/');
  const accounts = page.getByRole('list', { name: 'Claude accounts' });
  await expect(accounts).toHaveText('Personal: Available');
  // The limit resets in a few seconds: the screen follows the clock, without a reload.
  await limited(page, runId, 'detected', new Date(Date.now() + 4000).toISOString());

  const paused = item(page, 'Run paused: Claude usage limit reached');
  await expect(accounts).toHaveText(/^Personal: Limited until .+$/);
  await expect(paused).toContainText('you can resume after');
  await expect(paused.getByRole('button', { name: 'Resume' })).toBeDisabled();
  await expectFitsScreen(page);

  await expect(accounts).toHaveText('Personal: Available', { timeout: 15_000 });
  await expect(paused).toContainText('Its time has passed: you can resume the run now.');
  await paused.getByRole('button', { name: 'Resume' }).click();
  await expect(paused).toBeHidden();
  expect((await runSent(page, runId)).type).toBe('run.resume');
});

test('a limit without a reset time shows an estimated time', async ({ page }) => {
  const { runId } = await working(page);
  await page.goto('/');
  await expect(page.getByText('Nothing needs you right now.')).toBeVisible();
  await limited(page, runId, 'detected');
  await expect(page.getByRole('list', { name: 'Claude accounts' })).toHaveText(
    /^Personal: Limited until .+ \(estimated\)$/,
  );
  const paused = item(page, 'Run paused: Claude usage limit reached');
  await expect(paused).toContainText(/you can resume after .+ \(estimated\)\./);
  await expect(paused.getByRole('button', { name: 'Resume' })).toBeDisabled();
});

test('finished work is sent back with Request changes, then Run now starts the next run', async ({
  page,
}) => {
  const { runId, runToken } = await working(page);
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
      push: { status: 'pushed', head: BRANCH_HEAD },
    },
  );
  await ciPasses(page, runId);
  await reportState(page, runId, 'ended');

  await page.goto('/');
  const work = item(page, 'Work finished: check it');
  await expect(work).toContainText('Adds the contact form with its checks.');
  await expect(work.getByRole('button', { name: 'Mark as done manually' })).toBeVisible();
  await expectFitsScreen(page);

  await work.getByRole('button', { name: 'Request changes' }).click();
  const request = page.getByRole('dialog', { name: 'Request changes on WEB-1?' });
  await request.getByRole('button', { name: 'Request changes' }).click();
  await expect(request.getByText('this comment is required')).toBeVisible();
  await request.getByLabel('What should change? (required)').fill('Also ask for a phone number.');
  await request.getByRole('button', { name: 'Request changes' }).click();

  const offer = page.getByRole('dialog', { name: 'Changes requested on WEB-1' });
  await expect(offer).toContainText('The ticket is back in To do.');
  await expect(work).toBeHidden();
  await offer.getByRole('button', { name: 'Run now' }).click();
  await expect(page).toHaveURL(/\/activity\/runs\/[0-9a-f-]{36}$/);
  const next = page.url().split('/').at(-1) ?? '';
  expect(next).not.toBe(runId);
  expect((await runSent(page, next)).type).toBe('run.start');
});

test("a push GitHub refused names the token's permission, then Run now goes on", async ({
  page,
}) => {
  const { runId, runToken } = await working(page);
  // GitHub's own words without Contents write (the owner's smoke run, lot 3 step E3).
  const answer = await daemonRequest(page, 'mcp.call', {
    tool: 'ticket_submit',
    runToken,
    input: {
      criteria: [
        { index: 0, status: 'met', justification: 'The contact page shows the form.' },
        { index: 1, status: 'met', justification: 'An invalid address is refused.' },
      ],
      tests: { paths: ['src/contact.test.ts'], justification: null },
      docs: { paths: [], justification: 'No user documentation in this project yet.' },
      adrs: [],
      summary: 'Adds the contact form with its checks.',
    },
    workspace: {
      clean: true,
      branch: { name: 't/1-contact-form', head: BRANCH_HEAD, commitsAhead: COMMITS },
      push: {
        status: 'failed',
        reason: 'refused',
        message:
          "Write access to repository not granted.\nfatal: unable to access 'https://github.com/o/bakery.git/': The requested URL returned error: 403",
      },
    },
  });
  expect(answer.payload).toMatchObject({ ok: false, error: { code: 'DOD_FAILED' } });
  await reportState(page, runId, 'ended', { reason: 'push_failed' });

  await page.goto('/');
  const refused = item(page, 'GitHub refused the push of WEB-1');
  await expect(refused.getByRole('heading')).toHaveText(
    'GitHub refused the push of WEB-1: the token needs Contents (Read and write)',
  );
  await expect(refused).toContainText('The work is committed on machine Laptop');
  await expect(refused.getByRole('link', { name: 'Open your tokens on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/settings/personal-access-tokens',
  );
  await expect(refused.getByRole('link', { name: 'What to do' })).toHaveAttribute(
    'href',
    '/help/tickets#when-the-work-cannot-be-pushed-to-github',
  );
  await expectFitsScreen(page);

  await refused.getByRole('link', { name: 'Open the ticket' }).click();
  const next = await runNow(page);
  expect(next).not.toBe(runId);
  expect((await runSent(page, next)).type).toBe('run.start');
});

test('a pull request GitHub could not open is opened with Try again', async ({
  page,
  failNextGitHubRequest,
  gitHubCommit,
}) => {
  const { runId, runToken } = await working(page);
  // The push the scripted daemon reports, on the fake GitHub; then GitHub fails the first search
  // for the ticket's pull request.
  await gitHubCommit({
    repository: 'bakery',
    branch: 't/1-contact-form',
    files: { 'src/contact.ts': 'export {};\n' },
    message: 'Add the contact form',
    from: 'main',
  });
  await failNextGitHubRequest('GET', '/pulls', 502);
  const answer = await callTool(
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
      push: { status: 'pushed', head: BRANCH_HEAD },
    },
  );
  expect(answer).toMatchObject({ result: 'pending_ci' });
  await ciPasses(page, runId);
  await reportState(page, runId, 'ended');

  await page.goto('/');
  const notOpened = item(page, 'Pull request not opened for WEB-1');
  await expect(notOpened.getByRole('heading')).toHaveText(
    'Pull request not opened for WEB-1: GitHub could not be reached',
  );
  await expect(notOpened).toContainText('The work of WEB-1 is on GitHub');
  await expect(notOpened.getByRole('link', { name: 'What to do' })).toHaveAttribute(
    'href',
    '/help/needs-you#pull-request-not-opened',
  );
  await expectFitsScreen(page);

  await notOpened.getByRole('button', { name: 'Try again' }).click();
  await expect(notOpened).toBeHidden();
  // With its pull request, the work is ready for review (owner's answer 6f, lot 3 step H).
  await expect(item(page, 'Ready for review: WEB-1 Contact form')).toBeVisible();
});
