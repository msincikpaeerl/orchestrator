import type { Page } from '@playwright/test';
import {
  expect,
  expectFitsScreen,
  openSection,
  readyForRuns,
  reportState,
  runNow,
  runSent,
  screenshot,
  startRun,
  test,
} from './fixtures';

// A ticket stopped after its failed attempts (04, section 5; owner's answer 3, lot 3 step K):
// two runs that run out of time stop it at Failed attempts before asking you (2), Run now is
// refused naming the setting, and Try again from Needs you lets it continue. A project download
// that fails at a run's start is not counted: its item has Run now (lot 3 step K2). Each test saves
// pictures of the screen for the owner (apps/web/e2e-screenshots/).

/** Run now from the ticket page, then the run runs out of time: a counted failure. */
async function timedOut(page: Page, ticketPage: string) {
  await page.goto(ticketPage);
  const runId = await runNow(page);
  await startRun(page, runId);
  await reportState(page, runId, 'ended', { reason: 'idle_timeout', detail: null, branch: null });
}

test('a ticket stopped after repeated failures, then Try again from Needs you', async ({
  page,
}, testInfo) => {
  const ticketPage = await readyForRuns(page);
  await timedOut(page, ticketPage);
  await timedOut(page, ticketPage);

  await page.goto(ticketPage);
  await expect(
    page
      .getByText(
        /^Attempt 2 failed on machine Laptop: it ran out of time\. It counts as a failed attempt: 2 failed attempts, as many as Failed attempts before asking you allows \(2\), so the ticket is stopped\./,
      )
      .first(),
  ).toBeVisible();
  const stop = page.getByLabel('Stopped');
  await expect(stop).toContainText('Stopped after repeated failures');
  await expect(stop).toContainText(
    'It failed 2 times, as many as Failed attempts before asking you allows (2). Use Try again to let it continue, or Cancel it, or Mark it as done manually.',
  );
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(
    page.getByText(
      'This ticket is stopped after 2 failed attempts (Failed attempts before asking you: 2): use Try again, Cancel or Mark as done manually.',
    ),
  ).toBeVisible();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'ticket-stopped-failures');

  await openSection(page, 'Needs you');
  const item = page.getByRole('listitem').filter({ hasText: 'Stopped after repeated failures' });
  await expect(item).toContainText('WEB-1 · Contact form');
  await expect(item).toContainText(
    'It failed 2 times, as many as Failed attempts before asking you allows (2).',
  );
  await expect(item.getByRole('button', { name: 'Cancel the ticket' })).toBeVisible();
  await expect(item.getByRole('button', { name: 'Mark as done manually' })).toBeVisible();
  await expectFitsScreen(page);
  await screenshot(item, testInfo, 'needs-you-stopped-failures');
  await item.getByRole('button', { name: 'Try again' }).click();
  const offer = page.getByRole('dialog', { name: 'WEB-1 can continue' });
  await expect(item).toBeHidden();
  await offer.getByRole('button', { name: 'Run now' }).click();
  await expect(page).toHaveURL(/\/activity\/runs\/[0-9a-f-]{36}$/);

  // The counts start again: the ticket's comment says so, and it is no longer stopped.
  await page.goto(ticketPage);
  await expect(page.getByLabel('Stopped')).toBeHidden();
  await expect(
    page.getByText(
      'The owner used Try again: the ticket was stopped after 2 failed attempts (Failed attempts before asking you: 2). Its failed attempts and review rounds count from 0 again.',
    ),
  ).toBeVisible();
});

test('a project that could not be downloaded from GitHub, then Run now from Needs you', async ({
  page,
}, testInfo) => {
  const ticketPage = await readyForRuns(page);
  await page.goto(ticketPage);
  const runId = await runNow(page);
  await runSent(page, runId);
  await reportState(page, runId, 'preparing');
  // GitHub's words for a repository the token cannot see (lot 3 step K2).
  const message =
    "remote: Repository not found.\nfatal: repository 'https://github.com/o/bakery.git/' not found";
  await reportState(page, runId, 'ended', {
    reason: 'download_failed',
    detail: `The project could not be downloaded from GitHub: ${message}`,
    branch: null,
    download: { reason: 'refused', message },
  });

  // The run page says why, and what to do.
  await page.goto(`/activity/runs/${runId}`);
  await expect(page.getByLabel('Run status')).toHaveText(
    'Failed: the project could not be downloaded from GitHub',
  );
  await expect(page.getByLabel('What to do')).toContainText(
    "Machine Laptop could not download the project from GitHub when the run started, so the agent never started: GitHub refused the token, which needs Contents (Read and write) on the project's repository. It does not count as a failed attempt.",
  );
  // No branch was made: never "as this run left it", and no commit list (lot 3 step L).
  await expect(page.getByLabel('Branch', { exact: true })).toHaveText(
    'No branch was made on machine Laptop: the run ended before the project was downloaded.',
  );
  await expect(page.getByText('No commits yet.')).toBeHidden();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'run-download-failed');

  // The ticket is not stopped or counted; its comment says the same.
  await page.goto(ticketPage);
  await expect(
    page
      .getByText(
        /^The run on machine Laptop ended: the project could not be downloaded from GitHub at its start, because GitHub refused the token: it needs access to \S+ with the permission Contents \(Read and write\)\. It does not count as a failed attempt\./,
      )
      .first(),
  ).toBeVisible();
  await expect(page.getByLabel('Stopped')).toBeHidden();

  await openSection(page, 'Needs you');
  const item = page
    .getByRole('main')
    .getByRole('listitem')
    .filter({ hasText: 'could not be downloaded from GitHub on Laptop' });
  await expect(item.getByRole('heading')).toHaveText(
    'WEB-1 could not be downloaded from GitHub on Laptop: Contact form',
  );
  await expect(item.getByRole('link', { name: 'Open your tokens on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/settings/personal-access-tokens',
  );
  await expect(item.getByRole('link', { name: 'What to do' })).toHaveAttribute(
    'href',
    '/help/machines#when-the-project-cannot-be-downloaded-from-github',
  );
  await expectFitsScreen(page);
  await screenshot(item, testInfo, 'needs-you-download-failed');

  // Run now starts a new run, and the item goes.
  await item.getByRole('button', { name: 'Run now' }).click();
  await expect(page).toHaveURL(/\/activity\/runs\/[0-9a-f-]{36}$/);
  const next = page.url().split('/').at(-1) ?? '';
  expect(next).not.toBe(runId);
  expect((await runSent(page, next)).type).toBe('run.start');
  await openSection(page, 'Needs you');
  await expect(
    page.getByRole('main').getByText('could not be downloaded from GitHub on Laptop'),
  ).toBeHidden();
});
