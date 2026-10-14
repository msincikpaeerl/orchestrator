import type { Page } from '@playwright/test';
import { expect, expectFitsScreen, openSection, screenshot, test } from './fixtures';
import {
  CONFLICT_REQUEST,
  approved,
  control,
  inReview,
  item,
  short,
  skipped,
} from './pull-request-steps';

// The ticket page's lines on the pull request as GitHub has it (02, section 6.4; owner's answers
// 1, 3 and 4 of step J, lot 3 step J4b): the moved head, the conflict with Request changes filled
// in, the watch's failure, the closed state with Reopen pull request, a refused reopen, Start
// review refused on a closed pull request, and Cancel's close failing then done. Each test saves
// pictures of the screen for the owner (apps/web/e2e-screenshots/).

const TICKET = '/projects/WEB/tickets/1';

function pullRequestSection(page: Page) {
  return page
    .getByRole('main')
    .locator('section, div')
    .filter({ has: page.getByRole('heading', { name: 'Pull request', exact: true }) })
    .last();
}

test('the ticket page: the head moved after the approval, with the commits added', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const head = await inReview(page, gitHubCommit);
  await approved(page);
  await gitHubCommit({
    repository: 'bakery',
    branch: 'main',
    files: { 'docs/opening-hours.md': 'Monday to Friday.\n' },
    message: 'Add the opening hours',
  });
  await control(page, '/github/update-branch', { repository: 'bakery', pullRequest: 1 });
  await control(page, '/github/check');

  await page.goto(TICKET);
  const section = pullRequestSection(page);
  const moved = section.getByLabel('Head moved');
  await expect(moved).toContainText(
    new RegExp(
      `Pull request #1's head on GitHub is now [0-9a-f]{7}, not ${short(head)}, which Quality approved: it changed on GitHub since Quality's review\\.`,
    ),
  );
  await expect(moved.getByRole('listitem')).toHaveText([
    "Merge branch 'main' into t/1-contact-form",
    'Add the opening hours',
  ]);
  await expect(
    section.getByRole('link', { name: 'When GitHub changes the pull request' }),
  ).toBeVisible();
  await expectFitsScreen(page);
  await screenshot(section, testInfo, 'ticket-head-moved');
});

test('the ticket page: a conflict and the watch failing, Request changes filled in and edited', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  await inReview(page, gitHubCommit);
  await skipped(page);
  await gitHubCommit({
    repository: 'bakery',
    branch: 'main',
    files: { 'src/contact.ts': 'export const other = 1;\n' },
    message: 'Other work',
  });
  // GitHub computes the conflict at one check and says it at the next; then a read fails.
  await control(page, '/github/check');
  await control(page, '/github/check');
  await control(page, '/github/fail-next', { method: 'GET', path: '/pulls/1', status: 403 });
  await control(page, '/github/check');

  await page.goto(TICKET);
  const section = pullRequestSection(page);
  await expect(section.getByLabel('Conflict')).toHaveText(
    'Conflicts with main: GitHub cannot merge it as it is. Request changes comes with a comment asking the agent to merge main and resolve the conflicts.',
  );
  await expect(section.getByLabel('Not checked on GitHub')).toContainText(
    /^GitHub could not be checked for this pull request at .+: .+\. A merge is not found while this lasts; the Orchestrator asks again at each GitHub check\.$/,
  );
  await expectFitsScreen(page);
  await screenshot(section, testInfo, 'ticket-conflict');

  // The page's own Request changes, filled in from the API; the owner edits the comment.
  await page.getByRole('button', { name: 'Request changes' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Request changes on WEB-1?' });
  const comment = dialog.getByRole('textbox', { name: 'What should change? (required)' });
  await expect(comment).toHaveValue(CONFLICT_REQUEST);
  await comment.fill('Keep the footer as it is.');
  await dialog.getByRole('button', { name: 'Request changes' }).click();
  await page
    .getByRole('dialog', { name: 'Changes requested on WEB-1' })
    .getByRole('button', { name: 'Later' })
    .click();

  // The conflict mark comes from GitHub's stored fact, not from the edited words.
  const ticket = (await (await page.request.get('/api/projects/WEB/tickets/1')).json()) as {
    status: string;
    changeRequest: { request: { conflict: { base: string } | null; text: string } } | null;
  };
  expect(ticket.status).toBe('todo');
  expect(ticket.changeRequest?.request.conflict).toEqual({ base: 'main' });
});

test('the ticket page: closed on GitHub, Start review refused, a refused reopen, then reopened', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  await inReview(page, gitHubCommit);
  await control(page, '/github/close', { repository: 'bakery', pullRequest: 1 });
  await control(page, '/github/check');

  // Start review on the ticket page: refused, saying to reopen it first.
  await page.goto(TICKET);
  const reopenFirst =
    'Pull request #1 is closed on GitHub, so there is nothing to review. Reopen it first, with Reopen pull request on the ticket page or in Needs you.';
  await page.getByRole('button', { name: 'Start review' }).first().click();
  await expect(page.getByText(reopenFirst)).toBeVisible();

  // The same on "Ready for review" in Needs you.
  await openSection(page, 'Needs you');
  const ready = item(page, 'Ready for review: WEB-1 Contact form');
  await ready.getByRole('button', { name: 'Start review' }).click();
  await expect(ready.getByText(reopenFirst)).toBeVisible();
  await expectFitsScreen(page);
  await screenshot(ready, testInfo, 'needs-you-start-review-reopen-first');

  await page.goto(TICKET);
  const section = pullRequestSection(page);
  await expect(section.getByLabel('Pull request', { exact: true })).toContainText(
    'Pull request #1 · Closed without merging',
  );
  const closed = section.getByLabel('Closed', { exact: true });
  await expect(closed).toContainText(
    /Pull request #1 was closed on GitHub at .+ without merging\. The ticket is unchanged \(In review\)\. Reopen it to go on with this pull request, or cancel the ticket\./,
  );

  // GitHub refuses the first try: its words on the page.
  await control(page, '/github/fail-next', { method: 'PATCH', path: '/pulls/1', status: 422 });
  await closed.getByRole('button', { name: 'Reopen pull request' }).click();
  await expect(closed.getByLabel('Reopen refused')).toHaveText(
    'GitHub refused to reopen it: Failure requested by the test.',
  );
  await expectFitsScreen(page);
  await screenshot(section, testInfo, 'ticket-pull-request-closed');

  await closed.getByRole('button', { name: 'Reopen pull request' }).click();
  await expect(section.getByLabel('Pull request', { exact: true })).toContainText(
    'Pull request #1 · Open',
  );
  await expect(closed).toBeHidden();
});

test("the ticket page: Cancel's close failing, then done, and kept closed after Reopen", async ({
  page,
  gitHubCommit,
}, testInfo) => {
  await inReview(page, gitHubCommit);
  await control(page, '/github/fail-next', { method: 'PATCH', path: '/pulls/1', status: 422 });
  await page.getByRole('button', { name: 'Cancel the ticket' }).click();
  await page
    .getByRole('dialog', { name: 'Cancel WEB-1?' })
    .getByRole('button', { name: 'Cancel the ticket' })
    .click();
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();

  const section = pullRequestSection(page);
  const close = section.getByLabel('Close', { exact: true });
  await expect(close).toContainText(
    /^Pull request #1 not closed on GitHub yet, though WEB-1 was cancelled at .+: at .+, GitHub refused it: Failure requested by the test\. The Orchestrator tries again at each GitHub check\.$/,
  );
  await expectFitsScreen(page);
  await screenshot(section, testInfo, 'ticket-cancel-close-failed');

  // The next check closes it.
  await control(page, '/github/check');
  await expect(close).toBeHidden();
  const closed = section.getByLabel('Closed', { exact: true });
  await expect(closed).toHaveText(
    /^Pull request #1 was closed on GitHub at .+ without merging, since WEB-1 was cancelled\.$/,
  );
  await expect(closed.getByRole('button', { name: 'Reopen pull request' })).toBeHidden();

  // Reopen the ticket: the pull request stays closed until the next accepted submission.
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(page.getByText('To do', { exact: true }).first()).toBeVisible();
  await expect(closed).toContainText(
    'WEB-1 was reopened since: the pull request stays closed until the next accepted submission, which reopens it.',
  );
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'ticket-cancel-closed-reopened');
});

test('Help: the pull request on GitHub, opened from the ticket page', async ({
  page,
  gitHubCommit,
}) => {
  await inReview(page, gitHubCommit);
  await control(page, '/github/close', { repository: 'bakery', pullRequest: 1 });
  await control(page, '/github/check');
  await page.goto(TICKET);
  await page.getByRole('link', { name: 'When GitHub changes the pull request' }).click();
  await expect(
    page.getByRole('heading', { name: 'When GitHub changes the pull request' }),
  ).toBeInViewport();
  const article = page.getByRole('article');
  for (const words of [
    'Closed without merging',
    'Conflicts with main',
    'The head moved',
    'GitHub could not be checked',
    'Closed at Cancel',
  ]) {
    await expect(article.getByText(words, { exact: false }).first()).toBeVisible();
  }
  await expectFitsScreen(page);
});
