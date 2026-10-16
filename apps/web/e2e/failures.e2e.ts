import type { Page } from '@playwright/test';
import {
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

// A ticket stopped after its failed attempts (04, section 5; owner's answer 3, lot 3 step K):
// two runs that run out of time stop it at Failed attempts before asking you (2), Run now is
// refused naming the setting, and Try again from Needs you lets it continue. Each test saves
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
