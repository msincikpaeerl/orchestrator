import type { Page } from '@playwright/test';
import {
  createMachine,
  expect,
  expectFitsScreen,
  limited,
  openSection,
  readyForRuns,
  runNow,
  screenshot,
  startRun,
  test,
} from './fixtures';

// Activity > Queue (02, section 7; 07, section 7; lot 4 step H): each account's line, then each
// candidate in the scheduler's order with why it is not running, updated live; Run now from a line.
// The test server runs no scheduler by itself: nothing here starts but the owner's Run now.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Gives the account a window in two days only (in UTC, the time zone until one is saved): it is
 * outside its window now, and the scheduler starts nothing on it before.
 */
async function windowLater(page: Page, label: string) {
  const { accounts } = (await (await page.request.get('/api/accounts')).json()) as {
    accounts: { id: string; label: string }[];
  };
  const account = accounts.find((entry) => entry.label === label);
  if (!account) throw new Error(`no account ${label}`);
  const day = WEEKDAYS[new Date(Date.now() + 2 * 24 * 3_600_000).getUTCDay()];
  const response = await page.request.patch(`/api/accounts/${account.id}`, {
    data: { schedule: [{ days: [day], start: '00:00', end: '01:00' }] },
  });
  expect(response.status()).toBe(200);
}

async function createTicket(page: Page, title: string, blockedBy: number[] = []) {
  const response = await page.request.post('/api/projects/WEB/tickets', {
    data: { type: 'feature', title, assignee: 'web_dev', blockedBy },
  });
  expect(response.status()).toBe(201);
}

function line(page: Page, ticket: string) {
  return page
    .getByRole('list', { name: 'Queue', exact: true })
    .getByRole('listitem')
    .filter({ hasText: `${ticket} ·` });
}

test('the queue says why each ticket waits, follows changes live, and starts one with Run now', async ({
  page,
}, testInfo) => {
  // WEB-1 Contact form; WEB-2 held after its run was stopped; WEB-3 waits for WEB-1.
  await page.goto(await readyForRuns(page));
  await createTicket(page, 'Newsletter sign-up');
  await createTicket(page, 'Opening hours page', [1]);
  await page.goto('/projects/WEB/tickets/2');
  const stopped = await runNow(page);
  await startRun(page, stopped);
  expect((await page.request.post(`/api/runs/${stopped}/stop`)).status()).toBe(200);
  await windowLater(page, 'Personal');

  await page.goto('/');
  await openSection(page, 'Activity');
  const queue = page.getByRole('region', { name: 'Queue' });
  await expect(queue).toContainText('looking at it starts nothing');
  const account = queue.getByRole('list', { name: 'Claude accounts in the queue' });
  await expect(account).toContainText('Personal: Available · 0 of 1 run at a time');
  await expect(account).toContainText(/Starts no run by itself until its window opens at .+\./);
  // In the scheduler's order: WEB-1 first, as WEB-3 waits for it.
  await expect(
    page.getByRole('list', { name: 'Queue', exact: true }).getByRole('listitem'),
  ).toHaveCount(3);
  await expect(
    page.getByRole('list', { name: 'Queue', exact: true }).getByRole('listitem').first(),
  ).toContainText('1. WEB-1 · Contact form');
  await expect(line(page, 'WEB-1')).toContainText('Implement · 1 ticket waits for it');
  await expect(line(page, 'WEB-1').getByLabel('Why it is not running')).toHaveText(
    /^No machine can take the run: Laptop: its Claude account Personal is outside its window until .+\.$/,
  );
  await expect(line(page, 'WEB-2').getByLabel('Why it is not running')).toHaveText(
    'Held: you stopped its run. Run now releases it and starts it.',
  );
  await expect(line(page, 'WEB-3').getByLabel('Why it is not running')).toHaveText(
    'This ticket waits for WEB-1, which is not done yet.',
  );
  // Run now where it goes past the window or releases the hold; none where only WEB-1's end can.
  await expect(line(page, 'WEB-1').getByRole('button', { name: 'Run now' })).toBeVisible();
  await expect(line(page, 'WEB-2').getByRole('button', { name: 'Run now' })).toBeVisible();
  await expect(line(page, 'WEB-3').getByRole('button')).toHaveCount(0);
  await expectFitsScreen(page);
  await screenshot(queue, testInfo, 'queue-waiting');

  // Run now from WEB-1's line ignores the window: the run page opens.
  await line(page, 'WEB-1').getByRole('button', { name: 'Run now' }).click();
  await expect(page).toHaveURL(/\/activity\/runs\/[0-9a-f-]{36}$/);
  const runId = page.url().split('/').at(-1) ?? '';
  await startRun(page, runId);

  await openSection(page, 'Activity');
  await expect(line(page, 'WEB-1')).toHaveCount(0);
  await expect(account).toContainText('1 of 1 run at a time');

  // The usage limit reached while the page stays open: the queue follows without a reload. A
  // paused run no longer counts against the account's maximum (07, section 3).
  const resetsAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
  await limited(page, runId, 'detected', resetsAt);
  await expect(line(page, 'WEB-1')).toContainText('Resume its paused run');
  await expect(line(page, 'WEB-1').getByLabel('Why it is not running')).toHaveText(
    /^The Claude account Personal reached its usage limit\. You can resume after .+\.$/,
  );
  await expect(account).toContainText(/Personal: Limited until .+ · 0 of 1 run at a time/);
  await expect(account).toContainText('Starts no run until its usage limit resets.');
  // Resume would be refused until the reset: the line offers no button (review of step H).
  await expect(line(page, 'WEB-1').getByRole('button')).toHaveCount(0);
  // The paused run's time waits for the usage limit (07, section 7).
  await expect(page.getByRole('list', { name: 'Live runs' })).toContainText(
    /waiting \d+ s \(for the usage limit \d+ s\)/,
  );
  await expectFitsScreen(page);
  await screenshot(queue, testInfo, 'queue-limited');

  // A refused Run now says why, in the line, in the queue's words.
  await line(page, 'WEB-2').getByRole('button', { name: 'Run now' }).click();
  await expect(line(page, 'WEB-2').getByRole('alert')).toHaveText(
    /^No machine can take the run: Laptop: its Claude account Personal reached its usage limit, until .+\.$/,
  );
  await expect(page).toHaveURL(/\/activity$/);
});

test('a long queue with long reasons reads on the phone', async ({ page }, testInfo) => {
  await page.goto(await readyForRuns(page));
  // A second machine not enrolled yet: every reason names both machines.
  await createMachine(page, { name: 'Desktop in the back office', account: 'Personal' });
  for (let index = 2; index <= 12; index += 1) {
    await createTicket(
      page,
      `Page ${String(index)}: show the opening hours, the address and a map of the bakery`,
      index % 3 === 0 ? [index - 1] : [],
    );
  }
  await windowLater(page, 'Personal');

  await page.goto('/activity');
  await expect(
    page.getByRole('list', { name: 'Queue', exact: true }).getByRole('listitem'),
  ).toHaveCount(12);
  await expect(line(page, 'WEB-2').getByLabel('Why it is not running')).toHaveText(
    /^No machine can take the run: Desktop in the back office: it is not enrolled yet; Laptop: its Claude account Personal is outside its window until .+\.$/,
  );
  await expectFitsScreen(page);
  await screenshot(page.getByRole('region', { name: 'Queue' }), testInfo, 'queue-long');
});

test("a request's planning waits in the queue, linked to the request, with no button", async ({
  page,
}, testInfo) => {
  // Lot 5 step E2b (owner's answer 10 of step E2): "Plan" and its request's line, after the
  // review and fix candidates, before the implement ones; the scheduler alone starts it.
  await page.goto(await readyForRuns(page));
  const created = await page.request.post('/api/requests', {
    data: { body: 'A contact form on the home page.\nVisitors leave a message.', project: 'WEB' },
  });
  expect(created.status()).toBe(201);
  await windowLater(page, 'Personal');

  await page.goto('/activity');
  const items = page.getByRole('list', { name: 'Queue', exact: true }).getByRole('listitem');
  await expect(items).toHaveCount(2);
  const plan = items.first();
  await expect(plan).toContainText('1. Request 1 (WEB) · A contact form on the home page.');
  await expect(plan).toContainText('Plan');
  await expect(plan.getByLabel('Why it is not running')).toHaveText(
    /^No machine can take the run: Laptop: its Claude account Personal is outside its window until .+\.$/,
  );
  await expect(plan.getByRole('button')).toHaveCount(0);
  await expect(items.nth(1)).toContainText('2. WEB-1 · Contact form');
  await expectFitsScreen(page);
  await screenshot(page.getByRole('region', { name: 'Queue' }), testInfo, 'queue-plan');

  await plan
    .getByRole('link', { name: 'Request 1 (WEB) · A contact form on the home page.' })
    .click();
  await expect(page).toHaveURL(/\/requests\/1$/);
  await expect(page.getByText('Open: the request waits for the Project Manager.')).toContainText(
    'Activity > Queue says why it waits.',
  );
});
