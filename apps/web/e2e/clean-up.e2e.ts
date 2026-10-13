import type { Page } from '@playwright/test';
import {
  COMMITS,
  callTool,
  ciPasses,
  controlUrl,
  expect,
  expectFitsScreen,
  readyForRuns,
  reportState,
  runNow,
  screenshot,
  startRun,
  test,
} from './fixtures';

// The clean-up after a merge on the ticket page (02, section 6.4; 04, section 4; lot 3 step J2c):
// the ticket branch on GitHub and on the machine, deleted, kept with the reason, or waiting. Each
// test saves pictures of the screen for the owner (apps/web/e2e-screenshots/).

const BRANCH = 't/1-contact-form';
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

async function control(page: Page, path: string, data: Record<string, unknown> = {}) {
  const response = await page.request.post(`${controlUrl}${path}`, { data });
  expect(response.ok(), path).toBe(true);
}

/**
 * `WEB-1`'s work handed in and accepted, its pull request #1 opened on GitHub; the run waits for
 * CI. Returns the run and the commit handed in.
 */
async function handedIn(
  page: Page,
  gitHubCommit: GitHubCommit,
): Promise<{ ticketPage: string; runId: string; head: string }> {
  const ticketPage = await readyForRuns(page);
  await page.goto(ticketPage);
  const runId = await runNow(page);
  const runToken = await startRun(page, runId);
  const head = await gitHubCommit({
    repository: 'bakery',
    branch: BRANCH,
    files: { 'src/contact.ts': 'export {};\n' },
    message: 'Add the contact form',
    from: 'main',
  });
  const answer = await callTool(page, runToken, 'ticket_submit', REPORT, {
    clean: true,
    branch: { name: BRANCH, head, commitsAhead: COMMITS },
    push: { status: 'pushed', head },
    changedFiles: { listed: CHANGED, count: CHANGED.length },
  });
  expect(answer).toMatchObject({ result: 'pending_ci' });
  await expect
    .poll(async () => {
      const ticket = (await (await page.request.get('/api/projects/WEB/tickets/1')).json()) as {
        pullRequest: { opened: { number: number } | null };
      };
      return ticket.pullRequest.opened?.number ?? null;
    })
    .toBe(1);
  return { ticketPage, runId, head };
}

/** The run's end, as its machine reports it, with the branch where the run left it. */
async function runEnded(page: Page, runId: string, head: string, reason: string) {
  await reportState(page, runId, 'ended', {
    reason,
    branch: { name: BRANCH, head, commitsAhead: COMMITS },
  });
}

test('after a merge: the GitHub branch deleted, the machine waiting for the stopped run, then deleted', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const { ticketPage, runId, head } = await handedIn(page, gitHubCommit);
  await reportState(page, runId, 'waiting_ci');

  // Merged on GitHub while the run waits for CI: the check stops the run, whose end is not
  // reported yet, so nothing is deleted.
  await control(page, '/github/merge', { repository: 'bakery', pullRequest: 1, method: 'squash' });
  await control(page, '/github/check');
  await page.goto(ticketPage);
  await expect(page.getByText('Done', { exact: true }).first()).toBeVisible();
  const cleanUp = page.getByRole('list', { name: 'Clean-up after the merge' });
  await expect(cleanUp.getByRole('listitem')).toHaveText([
    `Branch ${BRANCH} kept on GitHub for now: the run on Laptop was stopped by the merge and Laptop has not reported its end yet. The branch is deleted once Laptop reports its end, or if you revoke Laptop.`,
    `Branch ${BRANCH} not deleted on machine Laptop yet: a run stopped by the merge has not reported its end yet.`,
  ]);
  await cleanUp.scrollIntoViewIfNeeded();
  await expectFitsScreen(page);
  await screenshot(cleanUp.locator('..'), testInfo, 'ticket-clean-up-waiting');

  // The run's end reported: the machine is asked at once, GitHub at the next check.
  await runEnded(page, runId, head, 'stopped');
  await expect(cleanUp.getByRole('listitem').nth(1)).toHaveText(
    `Branch ${BRANCH} not deleted on machine Laptop yet: the machine was asked and has not answered yet.`,
  );
  await control(page, '/daemon/branch-delete', { answer: { outcome: 'deleted' } });
  await control(page, '/github/check');
  await expect(cleanUp.getByRole('listitem')).toHaveText([
    new RegExp(`^Branch ${BRANCH} deleted on GitHub at .+\\.$`),
    new RegExp(`^Branch ${BRANCH} deleted on machine Laptop at .+\\.$`),
  ]);
  await cleanUp.scrollIntoViewIfNeeded();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'ticket-clean-up-deleted');

  await page.getByRole('link', { name: 'What the Orchestrator deletes after a merge' }).click();
  await expect(
    page.getByRole('heading', { name: 'What the Orchestrator deletes after a merge' }),
  ).toBeInViewport();
  await expect(page.getByText('click Restore branch', { exact: false })).toBeVisible();
  await expectFitsScreen(page);
});

test('after a merge: branches kept on GitHub and on the machine, with the reason', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const { ticketPage, runId, head } = await handedIn(page, gitHubCommit);
  await ciPasses(page, runId);
  await runEnded(page, runId, head, 'submitted');

  // Merged, then a commit pushed to the branch on GitHub before the Orchestrator's check.
  await control(page, '/github/merge', { repository: 'bakery', pullRequest: 1, method: 'squash' });
  const later = await gitHubCommit({
    repository: 'bakery',
    branch: BRANCH,
    files: { 'src/contact.ts': 'export const later = true;\n' },
    message: 'A change after the merge',
  });
  await control(page, '/github/check');
  // The machine's copy holds a commit that was never pushed.
  const local = 'd'.repeat(40);
  await control(page, '/daemon/branch-delete', { answer: { outcome: 'kept', head: local } });

  await page.goto(ticketPage);
  const cleanUp = page.getByRole('list', { name: 'Clean-up after the merge' });
  await expect(cleanUp.getByRole('listitem')).toHaveText([
    `Branch ${BRANCH} kept on GitHub: its head on GitHub is ${later.slice(0, 7)}, not the merged head ${head.slice(0, 7)}: commits were pushed after the merge.`,
    `Branch ${BRANCH} kept on machine Laptop: its head ddddddd is not the merged head ${head.slice(0, 7)}; it may hold work that was not merged.`,
  ]);
  await cleanUp.scrollIntoViewIfNeeded();
  await expectFitsScreen(page);
  await screenshot(cleanUp.locator('..'), testInfo, 'ticket-clean-up-kept');
});
