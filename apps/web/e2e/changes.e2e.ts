import type { Page } from '@playwright/test';
import {
  COMMITS,
  callTool,
  ciPasses,
  daemonRequest,
  expect,
  expectFitsScreen,
  openSection,
  readyForRuns,
  reportState,
  runNow,
  screenshot,
  startRun,
  test,
} from './fixtures';

// Changes after a review on the screens (02, sections 4 and 6.4; owner's answers 2, 6 and 7, lot
// 3 step I, and 2 to 4, step I2): Request changes on Awaiting merge leading to a fix_review run,
// the ticket page in To do while a request stands, the same commit refused, and a ticket stopped
// after too many review rounds with Try again from Needs you. Each test saves pictures of the
// screen for the owner (apps/web/e2e-screenshots/).

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
const POINTS = [
  {
    body: 'Test an empty e-mail address too: only a malformed one is tested.',
    file: 'src/contact.test.ts',
    line: 12,
  },
];
const BRANCH = 't/1-contact-form';
const TICKET = '/projects/WEB/tickets/1';

type GitHubCommit = (commit: {
  repository: string;
  branch: string;
  files: Record<string, string | null>;
  message: string;
  from?: string;
}) => Promise<string>;

const short = (commit: string) => commit.slice(0, 7);

/** The workspace facts of a submission of `head`, pushed. */
const workspace = (head: string) => ({
  clean: true,
  branch: { name: BRANCH, head, commitsAhead: COMMITS },
  push: { status: 'pushed', head },
  changedFiles: { listed: CHANGED, count: CHANGED.length },
});

/** A builder run already working hands in a new commit on GitHub; CI passes: in review. */
async function handIn(
  page: Page,
  gitHubCommit: GitHubCommit,
  run: { runId: string; runToken: string },
  file: string,
  first = false,
): Promise<string> {
  const head = await gitHubCommit({
    repository: 'bakery',
    branch: BRANCH,
    files: { [file]: `export const version = '${file}';\n` },
    message: `Change ${file}`,
    ...(first ? { from: 'main' } : {}),
  });
  const answer = await callTool(page, run.runToken, 'ticket_submit', REPORT, workspace(head));
  expect(answer).toMatchObject({ result: 'pending_ci' });
  await ciPasses(page, run.runId);
  await page.goto(TICKET);
  await expect(page.getByText('In review', { exact: true }).first()).toBeVisible();
  return head;
}

/** `WEB-1` implemented, its work accepted and CI passed: in review, with pull request #1. */
async function inReview(page: Page, gitHubCommit: GitHubCommit): Promise<string> {
  await page.goto(await readyForRuns(page));
  const runId = await runNow(page);
  const runToken = await startRun(page, runId);
  return handIn(page, gitHubCommit, { runId, runToken }, 'src/contact.ts', true);
}

/** **Start review** from the ticket page; Quality approves or asks for changes; the run ends. */
async function review(page: Page, decision: 'approve' | 'changes') {
  await page.goto(TICKET);
  await page.getByRole('button', { name: 'Start review' }).click();
  await expect(page).toHaveURL(/\/activity\/runs\/[0-9a-f-]{36}$/);
  const runId = page.url().split('/').at(-1) ?? '';
  const runToken = await startRun(page, runId);
  if (decision === 'approve') {
    await callTool(page, runToken, 'review_approve', { summary: 'The work is right.' });
  } else {
    await callTool(page, runToken, 'review_request_changes', { points: POINTS });
  }
  await reportState(page, runId, 'ended');
}

/** On the run page Run now opened: a fix_review run, played until it works. */
async function fixRun(page: Page): Promise<{ runId: string; runToken: string }> {
  await expect(page).toHaveURL(/\/activity\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Fix after review').first()).toBeVisible();
  const runId = page.url().split('/').at(-1) ?? '';
  return { runId, runToken: await startRun(page, runId) };
}

test('Request changes on Awaiting merge: the request stands in To do, then a fix_review run', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const head = await inReview(page, gitHubCommit);
  await review(page, 'approve');
  await page.goto(TICKET);
  await expect(page.getByText('Awaiting merge', { exact: true }).first()).toBeVisible();

  // The dialog names the approval (owner's answer 7).
  await page.getByRole('button', { name: 'Request changes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Request changes on WEB-1?' });
  await expect(dialog).toContainText(
    `Quality approved commit ${short(head)}. The ticket goes back to To do with your comment, and its next run addresses it; the pull request stays open.`,
  );
  await dialog.getByLabel('What should change? (required)').fill('Also add a link to the map.');
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'request-changes-awaiting-merge-dialog');
  await dialog.getByRole('button', { name: 'Request changes' }).click();
  const offer = page.getByRole('dialog', { name: 'Changes requested on WEB-1' });
  await offer.getByRole('button', { name: 'Later' }).click();

  // In To do with the request standing (owner's answers 6 and 7).
  await expect(page.getByText('To do', { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel('Next run')).toHaveText(
    'Run now starts a run that addresses your request.',
  );
  const latest = page.getByLabel('Latest review');
  await expect(latest).toContainText(`Approved by Quality · commit ${short(head)}`);
  await expect(latest).toContainText(/You requested changes after this approval, at .+\./);
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'ticket-todo-owner-request');

  // Run now starts a fix_review run; the same commit is refused (owner's answer 1, step I).
  await page.getByRole('button', { name: 'Run now' }).click();
  const fix = await fixRun(page);
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'run-fix-review');
  const refused = await daemonRequest(page, 'mcp.call', {
    tool: 'ticket_submit',
    runToken: fix.runToken,
    input: REPORT,
    workspace: workspace(head),
  });
  expect(refused.payload).toMatchObject({ ok: false, error: { code: 'DOD_FAILED' } });
  await page.goto(`/activity/runs/${fix.runId}`);
  const card = page
    .getByRole('main')
    .locator('div', { has: page.getByRole('heading', { name: 'Latest refused submission' }) })
    .last();
  await expect(card).toContainText(`Same commit as the one you asked changes on (${short(head)})`);
  await expectFitsScreen(page);
  await screenshot(card, testInfo, 'run-same-commit-refused');

  // A new commit: in review again, the approval about an earlier submission (H4's words).
  const fixed = await handIn(page, gitHubCommit, fix, 'src/map.ts');
  await expect(page.getByLabel('Latest review')).toContainText(
    `Approved by Quality · commit ${short(head)}`,
  );
  await expect(page.getByLabel('Latest review')).toContainText(', on an earlier submission.');
  await expect(page.getByLabel('Latest review')).toContainText(
    `The work now in review is commit ${short(fixed)} and has not been reviewed yet.`,
  );
  await expect(page.getByText('You requested changes after this approval')).toBeHidden();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'ticket-review-earlier-after-request');
});

test("Quality's request in To do, then a ticket stopped after too many review rounds, Try again from Needs you", async ({
  page,
  gitHubCommit,
}, testInfo) => {
  await inReview(page, gitHubCommit);
  const limit = await page.request.put('/api/settings/maxReviewRounds', { data: { value: 1 } });
  expect(limit.status()).toBe(200);

  // Round 1: the line in To do (owner's answer 7).
  await review(page, 'changes');
  await page.goto(TICKET);
  await expect(page.getByLabel('Next run')).toHaveText(
    "Run now starts a run that addresses Quality's points (round 1 of at most 1).",
  );
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'ticket-todo-quality-request');
  await page.getByRole('button', { name: 'Run now' }).click();
  const fix = await fixRun(page);
  await handIn(page, gitHubCommit, fix, 'src/empty-address.ts');

  // Round 2, past the limit: the ticket stops (owner's answer 2, step I).
  await review(page, 'changes');
  await page.goto('/projects/WEB');
  const card = page.getByRole('listitem').filter({ hasText: 'WEB-1 · Contact form' });
  await expect(card).toContainText('Stopped');
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'board-stopped');

  await page.goto(TICKET);
  const stop = page.getByLabel('Stopped');
  await expect(stop).toContainText('Stopped after too many review rounds');
  await expect(stop).toContainText(
    'Quality requested changes 2 times, more than Most review rounds per ticket allows (1). Use Try again to let it continue, or Cancel it, or Mark it as done manually.',
  );
  await expect(stop).toContainText(
    'Try again starts no session: the review rounds and failed attempts count from 0 again, and Run now can start the next run.',
  );
  await expect(stop.getByRole('button', { name: 'Cancel the ticket' })).toBeVisible();
  await expect(stop.getByRole('button', { name: 'Mark as done manually' })).toBeVisible();
  await expect(page.getByLabel('Next run')).toBeHidden();
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(
    page.getByText(
      'This ticket is stopped after 2 requests for changes by Quality (Most review rounds per ticket: 1): use Try again, Cancel or Mark as done manually.',
    ),
  ).toBeVisible();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'ticket-stopped');

  // Needs you: Try again, then Run now offered at once (owner's answer 3, step I2).
  await openSection(page, 'Needs you');
  const item = page
    .getByRole('listitem')
    .filter({ hasText: 'Stopped after too many review rounds' });
  await expect(item).toContainText('WEB-1 · Contact form');
  await expect(item.getByRole('button', { name: 'Cancel the ticket' })).toBeVisible();
  await expect(item.getByRole('button', { name: 'Mark as done manually' })).toBeVisible();
  await expectFitsScreen(page);
  await screenshot(item, testInfo, 'needs-you-stopped');
  await item.getByRole('button', { name: 'Try again' }).click();
  const offer = page.getByRole('dialog', { name: 'WEB-1 can continue' });
  await expect(offer).toContainText(
    'The review rounds and failed attempts count from 0 again. Start the next run now, or later from the ticket page.',
  );
  await expect(item).toBeHidden();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'needs-you-try-again-run-now');
  await offer.getByRole('button', { name: 'Run now' }).click();
  await fixRun(page);
});
