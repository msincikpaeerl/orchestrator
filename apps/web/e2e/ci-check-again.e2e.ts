import type { Page } from '@playwright/test';
import {
  BRANCH_HEAD,
  COMMITS,
  callTool,
  ciCheck,
  ciPasses,
  expect,
  expectFitsScreen,
  readyForRuns,
  reportState,
  runNow,
  screenshot,
  startRun,
  test,
} from './fixtures';

// What a run's CI came to, on the screens (02, sections 4, 6.4 and 7; owner's answers, lot 3 step
// G2c): the ticket page's CI line while waiting and once in review, the ended run's CI card with
// its rounds after one failure too many, and "CI did not finish" in "Needs you" with Check CI
// again. Each test saves pictures of the screen for the owner (apps/web/e2e-screenshots/).

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

type GitHubCommit = (commit: {
  repository: string;
  branch: string;
  files: Record<string, string | null>;
  message: string;
  from?: string;
}) => Promise<string>;

/** The agent hands in `head`; the session then waits for CI. */
async function handIn(page: Page, runId: string, runToken: string, head: string) {
  const answer = await callTool(page, runToken, 'ticket_submit', REPORT, {
    clean: true,
    branch: { name: 't/1-contact-form', head, commitsAhead: COMMITS },
    push: { status: 'pushed', head },
    changedFiles: { listed: CHANGED, count: CHANGED.length },
  });
  expect(answer).toMatchObject({ result: 'pending_ci' });
  await reportState(page, runId, 'waiting_ci');
}

/**
 * `WEB-1`'s run started, its branch on GitHub; `head` is the commit handed in: by default the
 * branch's real commit on the fake GitHub, so Check CI again reads it as GitHub has it.
 */
async function started(page: Page, gitHubCommit: GitHubCommit) {
  const ticketPage = await readyForRuns(page);
  await page.goto(ticketPage);
  const runId = await runNow(page);
  const runToken = await startRun(page, runId);
  const sha = await gitHubCommit({
    repository: 'bakery',
    branch: 't/1-contact-form',
    files: { 'src/contact.ts': 'export {};\n' },
    message: 'Add the contact form',
    from: 'main',
  });
  return { ticketPage, runId, runToken, sha };
}

const ciLine = (page: Page) => page.getByRole('region', { name: 'CI' });

test('the ticket page shows CI while waiting, then the result once in review', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const { ticketPage, runId, runToken } = await started(page, gitHubCommit);
  await handIn(page, runId, runToken, BRANCH_HEAD);
  await ciCheck(page, runId, { runs: [{ name: 'CI', status: 'in_progress', conclusion: null }] });
  await page.goto(ticketPage);
  await expect(ciLine(page)).toContainText(
    /^CI: waiting on GitHub for commit aaaaaaa since .+\. See the run for each check\./,
  );
  await expect(ciLine(page).getByRole('button', { name: 'Check CI again' })).toBeHidden();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'ticket-waiting-for-ci');

  await ciPasses(page, runId);
  await page.goto(ticketPage);
  await expect(page.getByText('In review', { exact: true }).first()).toBeVisible();
  await expect(ciLine(page)).toContainText(
    /^CI passed on GitHub for commit aaaaaaa \(checked at .+\)\./,
  );
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'ticket-in-review-ci');
});

test('one CI failure too many: the run page lists each round and the failure that ended it', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const { ticketPage, runId, runToken } = await started(page, gitHubCommit);
  const failed = { runs: [{ name: 'CI', status: 'completed', conclusion: 'failure' }] };
  const heads = [BRANCH_HEAD, 'd'.repeat(40), 'e'.repeat(40)];
  for (const [index, head] of heads.entries()) {
    await handIn(page, runId, runToken, head);
    await ciCheck(page, runId, failed);
    if (index < heads.length - 1) {
      // The round goes back to the agent; the machine confirms it at once, the agent works.
      await expect
        .poll(async () => {
          const run = (await (await page.request.get(`/api/runs/${runId}`)).json()) as {
            ciHistory: { rounds: { confirmedAt: string | null }[] } | null;
          };
          return run.ciHistory?.rounds.filter((round) => round.confirmedAt !== null).length;
        })
        .toBe(index + 1);
      await reportState(page, runId, 'working');
    }
  }
  await page.goto(`/activity/runs/${runId}`);
  await expect(page.getByLabel('Run status')).toContainText('Failed');
  const rounds = page.getByRole('list', { name: 'CI rounds' }).locator(':scope > li');
  await expect(rounds).toHaveCount(3);
  await expect(rounds.nth(0)).toContainText(
    /^Round 1 · commit aaaaaaa · Failed at .+ · sent back to the agent/,
  );
  await expect(rounds.nth(1)).toContainText(
    /^Round 2 · commit ddddddd · Failed at .+ · sent back to the agent/,
  );
  await expect(rounds.nth(2)).toContainText(
    /^Not sent back · commit eeeeeee · Failed at .+ · the run ended: one failure more than Most CI failures per run \(2\)/,
  );
  // The latest line's checks are open, the earlier ones folded.
  await expect(rounds.nth(2).getByRole('list')).toBeVisible();
  await expect(rounds.nth(0).getByRole('list')).toBeHidden();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'run-ci-failed-too-many');

  // The ticket page says it in one line, with Check CI again for a re-run made on GitHub.
  await page.goto(ticketPage);
  await expect(ciLine(page)).toContainText(
    'CI failed on GitHub for commit eeeeeee: CI · workflow. The run ended after 3 CI failures (Most CI failures per run: 2).',
  );
  await expect(ciLine(page)).toContainText(
    'If you re-ran the failed jobs on GitHub, Check CI again reads the result again.',
  );
  await expect(ciLine(page).getByRole('button', { name: 'Check CI again' })).toBeVisible();
});

test('CI did not finish: "Needs you" offers Check CI again, which accepts the work once CI passed', async ({
  page,
  gitHubCommit,
  playwright,
}, testInfo) => {
  const { runId, runToken, sha } = await started(page, gitHubCommit);
  await handIn(page, runId, runToken, sha);
  // A status of another service on the commit, still running when CI wait at submission passed.
  const control = await playwright.request.newContext();
  const status = (state: string) =>
    control.post(
      `http://127.0.0.1:${String(Number(process.env.E2E_PORT ?? 8095) + 1)}/github/status`,
      { data: { repository: 'bakery', ref: sha, context: 'deploy', state } },
    );
  expect((await status('pending')).status()).toBeLessThan(300);
  await ciCheck(page, runId, {
    statuses: [{ context: 'deploy', state: 'pending' }],
    startedMinutesAgo: 25,
  });

  await page.goto('/');
  const item = page.getByRole('listitem').filter({ hasText: 'CI did not finish for WEB-1' });
  await expect(item.getByRole('heading')).toHaveText('CI did not finish for WEB-1: Contact form');
  await expect(item).toContainText(
    `(commit ${sha.slice(0, 7)}, pull request #1), but CI on GitHub had not finished when CI wait at submission (20 minutes) was reached.`,
  );
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'needs-you-ci-did-not-finish');

  // Still running on GitHub: nothing changes.
  await item.getByRole('button', { name: 'Check CI again' }).click();
  await expect(item.getByRole('status')).toContainText(
    /^CI has still not finished on GitHub \(0 of 1 checks finished, checked at .+\)\. Try again later\.$/,
  );
  // Finished since: the work is accepted, the item goes, the page says so.
  expect((await status('success')).status()).toBeLessThan(300);
  await item.getByRole('button', { name: 'Check CI again' }).click();
  // The item goes first: until then its own status line says the same words as the page's.
  await expect(
    page.getByRole('listitem').filter({ hasText: 'CI did not finish for WEB-1' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: 'CI passed: WEB-1 moved to In review.' }),
  ).toBeVisible();
  await control.dispose();

  await page.goto('/projects/WEB/tickets/1');
  await expect(ciLine(page)).toContainText(
    new RegExp(
      `^CI passed on GitHub for commit ${sha.slice(0, 7)} \\(checked again by you at .+\\): the work was accepted without a session\\.`,
    ),
  );
});
