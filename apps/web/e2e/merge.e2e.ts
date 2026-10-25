import { expect, expectFitsScreen, openSection, screenshot, test } from './fixtures';
import {
  CONFLICT_REQUEST,
  SUMMARY,
  approved,
  control,
  inReview,
  item,
  short,
  skipped,
} from './pull-request-steps';

// "Needs you" pull requests to merge and closed pull requests (02, section 4; owner's answers 1,
// 3 and 4 of step J, lot 3 step J4a): the item, its conflict flag with Request changes filled
// in, the moved head, the watch's failure, the merge found without reloading the page, and the
// closed item with its buttons. Each test saves pictures of the screen for the owner
// (apps/web/e2e-screenshots/).

const TICKET = '/projects/WEB/tickets/1';

test('a pull request to merge: the approval, the moved head, then done after the merge without reload', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const head = await inReview(page, gitHubCommit);
  await approved(page);
  // Someone uses Update branch on GitHub after the approval: the head moves.
  await gitHubCommit({
    repository: 'bakery',
    branch: 'main',
    files: { 'docs/opening-hours.md': 'Monday to Friday.\n' },
    message: 'Add the opening hours',
  });
  await control(page, '/github/update-branch', { repository: 'bakery', pullRequest: 1 });
  await control(page, '/github/check');

  await openSection(page, 'Needs you');
  const toMerge = item(page, 'Pull request to merge: WEB-1 Contact form');
  await expect(toMerge.getByRole('link', { name: 'Pull request #1' })).toHaveAttribute(
    'href',
    /\/pull\/1$/,
  );
  await expect(toMerge).toContainText(
    new RegExp(`Quality approved commit ${short(head)} at .+\\.`),
  );
  await expect(toMerge.getByLabel("Quality's summary")).toContainText(SUMMARY);
  await expect(toMerge).toContainText(`CI passed on GitHub for commit ${short(head)}`);
  const moved = toMerge.getByLabel('Head moved');
  await expect(moved).toContainText(
    new RegExp(
      `Pull request #1's head on GitHub is now [0-9a-f]{7}, not ${short(head)}, which Quality approved: it changed on GitHub since Quality's review\\.`,
    ),
  );
  await expect(moved.getByRole('listitem')).toHaveText([
    "Merge branch 'main' into t/1-contact-form",
    'Add the opening hours',
  ]);
  await expect(toMerge).toContainText(
    'Merge it on GitHub: WEB-1 moves to Done by itself when the Orchestrator finds the merge, at its next GitHub check.',
  );
  await expect(toMerge.getByRole('button', { name: 'Request changes' })).toBeVisible();
  await expectFitsScreen(page);
  await screenshot(toMerge, testInfo, 'needs-you-to-merge');

  // Merged on GitHub: the next check finds it, and the page updates by itself.
  await control(page, '/github/merge', { repository: 'bakery', pullRequest: 1, method: 'squash' });
  await control(page, '/github/check');
  await expect(toMerge).toBeHidden();
  await expect(page.getByText('Nothing needs you right now.')).toBeVisible();
  await expectFitsScreen(page);

  await page.goto('/projects/WEB/tickets/1');
  await expect(page.getByText('Done', { exact: true }).first()).toBeVisible();
});

test('a pull request to merge in conflict, not checked on GitHub, sent back from the item with the comment edited', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const head = await inReview(page, gitHubCommit);
  await skipped(page);
  // Other work on main changes the same file: GitHub computes it at one check, says it the next.
  await gitHubCommit({
    repository: 'bakery',
    branch: 'main',
    files: { 'src/contact.ts': 'export const other = 1;\n' },
    message: 'Other work',
  });
  await control(page, '/github/check');
  await control(page, '/github/check');
  // Then the pull request cannot be read at one check.
  await control(page, '/github/fail-next', { method: 'GET', path: '/pulls/1', status: 403 });
  await control(page, '/github/check');

  await openSection(page, 'Needs you');
  const toMerge = item(page, 'Pull request to merge: WEB-1 Contact form');
  await expect(toMerge).toContainText(
    /Review skipped: you skipped Quality's review at .+\. Check the pull request yourself before merging it\./,
  );
  await expect(toMerge).toContainText(`CI passed on GitHub for commit ${short(head)}`);
  await expect(toMerge.getByLabel('Conflict')).toHaveText(
    'Conflicts with main: GitHub cannot merge it as it is.',
  );
  await expect(toMerge.getByLabel('Not checked on GitHub')).toContainText(
    /^GitHub could not be checked for this pull request at .+: .+\. A merge is not found while this lasts; the Orchestrator asks again at each GitHub check\.$/,
  );
  await expectFitsScreen(page);
  await screenshot(toMerge, testInfo, 'needs-you-to-merge-conflict');

  // Request changes, filled in with GitHub's conflict; the owner edits it.
  await toMerge.getByRole('button', { name: 'Request changes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Request changes on WEB-1?' });
  await expect(dialog).toContainText('You skipped the review.');
  const comment = dialog.getByRole('textbox', { name: 'What should change? (required)' });
  await expect(comment).toHaveValue(CONFLICT_REQUEST);
  await expectFitsScreen(page);
  await screenshot(dialog, testInfo, 'needs-you-to-merge-request-changes');
  await comment.fill('Keep the footer as it is, and merge main.');
  await dialog.getByRole('button', { name: 'Request changes' }).click();
  const offer = page.getByRole('dialog', { name: 'Changes requested on WEB-1' });
  await offer.getByRole('button', { name: 'Later' }).click();
  await expect(toMerge).toBeHidden();

  // The mark comes from GitHub's stored fact, not from the words.
  const ticket = (await (await page.request.get('/api/projects/WEB/tickets/1')).json()) as {
    status: string;
    changeRequest: { request: { by: string; conflict: { base: string } | null } } | null;
  };
  expect(ticket.status).toBe('todo');
  expect(ticket.changeRequest?.request).toMatchObject({ by: 'owner', conflict: { base: 'main' } });
});

test('a pull request closed on GitHub: Reopen pull request refused, then reopened', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  await inReview(page, gitHubCommit);
  await skipped(page);
  await control(page, '/github/close', { repository: 'bakery', pullRequest: 1 });
  await control(page, '/github/check');

  await openSection(page, 'Needs you');
  const closed = item(page, 'Pull request closed without merging for WEB-1: Contact form');
  await expect(closed).toContainText(
    /Pull request #1 was closed on GitHub at .+ without merging\. The ticket is unchanged \(Awaiting merge\)\./,
  );
  await expect(closed.getByRole('button', { name: 'Cancel the ticket' })).toBeVisible();
  await expect(closed.getByRole('button', { name: 'Mark as done manually' })).toBeHidden();
  await expect(item(page, 'Pull request to merge')).toBeHidden();

  // GitHub refuses the first try: its words on the item.
  await control(page, '/github/fail-next', { method: 'PATCH', path: '/pulls/1', status: 422 });
  await closed.getByRole('button', { name: 'Reopen pull request' }).click();
  await expect(closed.getByLabel('Reopen refused')).toHaveText(
    'GitHub refused to reopen it: Failure requested by the test.',
  );
  await expectFitsScreen(page);
  await screenshot(closed, testInfo, 'needs-you-pull-request-closed');

  await closed.getByRole('button', { name: 'Reopen pull request' }).click();
  await expect(closed).toBeHidden();
  await expect(item(page, 'Pull request to merge: WEB-1 Contact form')).toBeVisible();
});

test('a pull request merged into another base: Cancel the ticket or Mark as done manually', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  await inReview(page, gitHubCommit);
  await skipped(page);
  await gitHubCommit({
    repository: 'bakery',
    branch: 'release',
    files: { 'RELEASE.md': 'Next\n' },
    message: 'Release branch',
    from: 'main',
  });
  await control(page, '/github/change-base', {
    repository: 'bakery',
    pullRequest: 1,
    base: 'release',
  });
  await control(page, '/github/merge', { repository: 'bakery', pullRequest: 1, method: 'merge' });
  await control(page, '/github/check');

  await openSection(page, 'Needs you');
  const merged = item(page, 'Pull request merged into release for WEB-1: Contact form');
  await expect(merged).toContainText(
    /Pull request #1 was merged into release on GitHub at .+, not into the project's default branch, so the work is not done\. The ticket is unchanged \(Awaiting merge\)\./,
  );
  await expect(merged).toContainText(
    'the next accepted submission opens a new pull request into the default branch',
  );
  await expect(merged.getByRole('button', { name: 'Reopen pull request' })).toBeHidden();
  await expect(merged.getByRole('button', { name: 'Cancel the ticket' })).toBeVisible();
  await expect(merged.getByRole('button', { name: 'Mark as done manually' })).toBeVisible();
  await expectFitsScreen(page);
  await screenshot(merged, testInfo, 'needs-you-pull-request-merged-elsewhere');

  // The ticket page says where it was merged, in the item's words (lot 3 step J4c).
  await page.goto(TICKET);
  const pullRequest = page.getByLabel('Pull request', { exact: true });
  await expect(pullRequest).toContainText('Pull request #1 · Merged');
  const elsewhere = page.getByLabel('Merged elsewhere');
  await expect(elsewhere).toHaveText(
    /^Pull request #1 was merged into release on GitHub at .+, not into the project's default branch, so the work is not done\. The ticket is unchanged \(Awaiting merge\)\. GitHub never reopens a merged pull request: the next accepted submission opens a new pull request into the default branch\. If the work is done this way, mark the ticket as done; if not, cancel it\.$/,
  );
  await expect(
    page.getByRole('link', { name: 'When GitHub changes the pull request' }),
  ).toBeVisible();
  await expectFitsScreen(page);
  const section = page
    .getByRole('main')
    .locator('section, div')
    .filter({ has: page.getByRole('heading', { name: 'Pull request', exact: true }) })
    .last();
  await screenshot(section, testInfo, 'ticket-merged-elsewhere');

  await openSection(page, 'Needs you');
  await merged.getByRole('button', { name: 'Mark as done manually' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark WEB-1 as done?' });
  await dialog
    .getByRole('textbox', { name: 'Why is it done? (required)' })
    .fill('Released from the release branch.');
  await dialog.getByRole('button', { name: 'Mark as done' }).click();
  await expect(merged).toBeHidden();

  // Done: only where it was merged stays on the ticket page.
  await page.goto(TICKET);
  await expect(page.getByLabel('Merged elsewhere')).toHaveText(
    /^Pull request #1 was merged into release on GitHub at .+, not into the project's default branch\.$/,
  );
});

test('Merge automatically: turned on in Project settings, then the approved pull request merged without you', async ({
  page,
  gitHubCommit,
}, testInfo) => {
  const head = await inReview(page, gitHubCommit);

  // The switch, off by default, with what it does and its risk.
  await page.goto('/projects/WEB/settings');
  const box = page.getByRole('checkbox', { name: /Merge approved pull requests automatically/ });
  await expect(box).not.toBeChecked();
  await expect(
    page.getByText('Nobody but Quality reads the change before it is merged.', { exact: false }),
  ).toBeVisible();
  await box.check();
  await expect(page.getByRole('status')).toHaveText(
    'Saved: approved pull requests are merged automatically.',
  );
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'project-settings-merge-automatically');

  // Quality approves: the Orchestrator reads CI on the approved commit again (green on GitHub),
  // merges, and the ticket is done, without the owner.
  await control(page, '/github/status', {
    repository: 'bakery',
    ref: head,
    context: 'ci',
    state: 'success',
  });
  await page.goto(TICKET);
  await approved(page);
  await page.goto(TICKET);
  await expect(page.getByLabel('Automatic merge')).toContainText(
    `Merged automatically by the Orchestrator at`,
  );
  await expect(page.getByLabel('Automatic merge')).toContainText(`(commit ${short(head)},`);
  await expect(page.getByText('Done', { exact: true }).first()).toBeVisible();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'ticket-merged-automatically');
  await openSection(page, 'Needs you');
  await expect(item(page, 'Pull request to merge: WEB-1')).toHaveCount(0);

  // Off again, saved.
  await page.goto('/projects/WEB/settings');
  await box.uncheck();
  await expect(page.getByRole('status')).toHaveText(
    'Saved: you merge pull requests on GitHub. A merge already sent to GitHub goes on.',
  );
});
