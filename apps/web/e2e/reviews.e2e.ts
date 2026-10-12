import type { Page } from '@playwright/test';
import {
  COMMITS,
  callTool,
  ciPasses,
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

// Quality's reviews on the screens (02, sections 4, 6.4 and 7; owner's answers 2 to 5, lot 3
// steps H and H4): "Ready for review" and "Review did not finish" in Needs you, Start review and
// Skip review, the ticket page's review section and the run page's review card. Each test saves
// pictures of the screen for the owner (apps/web/e2e-screenshots/).

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
const SUMMARY =
  'The form checks the e-mail address, the tests cover both criteria and the user documentation describes the page.';
const POINTS = [
  {
    body: 'Test an empty e-mail address too: only a malformed one is tested.',
    file: 'src/contact.test.ts',
    line: 12,
  },
  { body: 'Say in the user documentation where the messages go.', file: 'docs/user/contact.md' },
];

type GitHubCommit = (commit: {
  repository: string;
  branch: string;
  files: Record<string, string | null>;
  message: string;
  from?: string;
}) => Promise<string>;

/** `WEB-1` implemented, its work accepted and CI passed: in review, with pull request #1. */
async function inReview(page: Page, gitHubCommit: GitHubCommit): Promise<string> {
  const ticketPage = await readyForRuns(page);
  await page.goto(ticketPage);
  const runId = await runNow(page);
  const runToken = await startRun(page, runId);
  const head = await gitHubCommit({
    repository: 'bakery',
    branch: 't/1-contact-form',
    files: { 'src/contact.ts': 'export {};\n' },
    message: 'Add the contact form',
    from: 'main',
  });
  const answer = await callTool(page, runToken, 'ticket_submit', REPORT, {
    clean: true,
    branch: { name: 't/1-contact-form', head, commitsAhead: COMMITS },
    push: { status: 'pushed', head },
    changedFiles: { listed: CHANGED, count: CHANGED.length },
  });
  expect(answer).toMatchObject({ result: 'pending_ci' });
  await ciPasses(page, runId);
  await page.goto(ticketPage);
  await expect(page.getByText('In review', { exact: true }).first()).toBeVisible();
  return head;
}

/** **Start review** from the page shown; the review run playing until Quality may decide. */
async function startReview(page: Page): Promise<{ runId: string; runToken: string }> {
  await page.getByRole('button', { name: 'Start review' }).first().click();
  await expect(page).toHaveURL(/\/activity\/runs\/[0-9a-f-]{36}$/);
  const runId = page.url().split('/').at(-1) ?? '';
  return { runId, runToken: await startRun(page, runId) };
}

const short = (commit: string) => commit.slice(0, 7);

test('Ready for review in Needs you, Start review, then an approval on the ticket and run pages', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const head = await inReview(page, gitHubCommit);
  await openSection(page, 'Needs you');
  const item = page
    .getByRole('listitem')
    .filter({ hasText: 'Ready for review: WEB-1 Contact form' });
  await expect(item).toContainText(`CI passed on GitHub for commit ${short(head)}`);
  await expect(item).toContainText(
    'A review by Quality uses one Claude Code session; Skip review uses none.',
  );
  await expect(item.getByRole('link', { name: 'Pull request #1' })).toHaveAttribute(
    'href',
    /\/pull\/1$/,
  );
  await expect(page.getByText('Work finished: check it')).toBeHidden();
  await expectFitsScreen(page);
  await screenshot(item, testInfo, 'needs-you-ready-for-review');

  const review = await startReview(page);
  await expect(page.getByLabel('Review card')).toContainText(
    `Reviewed commit ${short(head)} (pull request #1)`,
  );
  await expect(page.getByLabel('Review card')).toContainText('Decision: none yet');
  await callTool(page, review.runToken, 'review_approve', { summary: SUMMARY });
  await reportState(page, review.runId, 'ended');

  await page.goto('/projects/WEB/tickets/1');
  const latest = page.getByLabel('Latest review');
  await expect(latest).toContainText(`Approved by Quality · commit ${short(head)}`);
  await expect(latest).toContainText(SUMMARY);
  await expect(latest.getByRole('link', { name: 'Posted on GitHub' })).toHaveAttribute(
    'href',
    /\/pull\/1#pullrequestreview-\d+$/,
  );
  await expect(page.getByLabel('Merge')).toHaveText(
    'Merge pull request #1 on GitHub. The Orchestrator checks GitHub every 60 seconds (GitHub check interval, in Settings > Limits) and moves the ticket to Done when it finds the merge.',
  );
  await expect(page.getByRole('button', { name: 'Start review' })).toBeHidden();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'ticket-review-approved');

  await page.goto(`/activity/runs/${review.runId}`);
  const card = page.getByLabel('Review card');
  await expect(card).toContainText('Decision: approved');
  await expect(card.getByRole('link', { name: 'Posted on GitHub' })).toBeVisible();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'run-review');
});

test('a request for changes: its points on the ticket page', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const head = await inReview(page, gitHubCommit);
  const review = await startReview(page);
  await callTool(page, review.runToken, 'review_request_changes', { points: POINTS });
  await reportState(page, review.runId, 'ended');
  await page.goto('/projects/WEB/tickets/1');
  const latest = page.getByLabel('Latest review');
  await expect(latest).toContainText(
    `Changes requested by Quality · commit ${short(head)} · 2 points`,
  );
  await expect(latest.getByRole('list', { name: 'Points to address' }).locator('li')).toHaveText([
    `src/contact.test.ts:12 — ${POINTS[0]?.body ?? ''}`,
    `docs/user/contact.md — ${POINTS[1]?.body ?? ''}`,
  ]);
  await expect(latest.getByRole('link', { name: 'Posted on GitHub' })).toBeVisible();
  await expect(page.getByText('To do', { exact: true }).first()).toBeVisible();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'ticket-review-changes');
});

test('a post GitHub refused: the decision stands, with the note', async ({
  page,
  gitHubCommit,
  failNextGitHubRequest,
}, testInfo) => {
  const head = await inReview(page, gitHubCommit);
  const review = await startReview(page);
  await callTool(page, review.runToken, 'review_approve', { summary: SUMMARY });
  await failNextGitHubRequest('POST', '/pulls/1/reviews', 403);
  await reportState(page, review.runId, 'ended');
  await page.goto('/projects/WEB/tickets/1');
  const latest = page.getByLabel('Latest review');
  await expect(latest).toContainText(`Approved by Quality · commit ${short(head)}`);
  const note = latest.getByLabel('Review on GitHub');
  await expect(note).toContainText('Not posted on GitHub:');
  await expect(note).toContainText('The decision stands in the Orchestrator.');
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'ticket-review-not-posted');
});

test('Skip review: confirmed, the ticket moves to Awaiting merge without a session', async ({
  page,
  gitHubCommit,
}) => {
  await inReview(page, gitHubCommit);
  await page.getByRole('button', { name: 'Skip review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Skip the review of WEB-1?' });
  await expect(dialog).toContainText(
    "It moves to Awaiting merge without Quality's review: check the pull request yourself before merging it on GitHub.",
  );
  await dialog.getByRole('button', { name: 'Keep it in review' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Skip review' }).click();
  await page
    .getByRole('dialog', { name: 'Skip the review of WEB-1?' })
    .getByRole('button', { name: 'Skip review' })
    .click();
  await expect(page.getByLabel('Latest review')).toContainText('Review skipped by you on');
  await expect(page.getByText('Awaiting merge', { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel('Merge')).toContainText('Merge pull request #1 on GitHub');
  await expect(page.getByText('The owner skipped the review.')).toBeVisible();
  await expectFitsScreen(page);
});

test('Review did not finish: a decision thrown away by Stop run, which and why', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const head = await inReview(page, gitHubCommit);
  const review = await startReview(page);
  await callTool(page, review.runToken, 'review_approve', { summary: SUMMARY });
  await page.getByRole('button', { name: 'Stop run' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop run' }).click();
  await expect(page.getByLabel('Review card')).toContainText(
    'Decision not applied: you stopped the run before it ended.',
  );

  await openSection(page, 'Needs you');
  const item = page
    .getByRole('listitem')
    .filter({ hasText: 'Review did not finish for WEB-1: Contact form' });
  await expect(item).toContainText(
    new RegExp(
      `Quality approved commit ${short(head)} at .+, but the approval was not applied: you stopped the run before it ended\\. It does not count as a failed attempt\\.`,
    ),
  );
  await expect(item.getByRole('button', { name: 'Start review' })).toBeVisible();
  await expect(item.getByRole('button', { name: 'Skip review' })).toBeVisible();
  await expectFitsScreen(page);
  await screenshot(item, testInfo, 'needs-you-review-not-finished');

  await page.goto('/projects/WEB/tickets/1');
  await expect(page.getByLabel('Latest review')).toContainText(
    'Review did not finish: Quality approved commit',
  );
  await expectFitsScreen(page);
});
