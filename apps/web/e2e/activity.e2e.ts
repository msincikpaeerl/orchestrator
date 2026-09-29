import {
  completeSetup,
  createReadyProject,
  expect,
  expectFitsScreen,
  openSection,
  readyForRuns,
  runNow,
  sendLog,
  startRun,
  test,
} from './fixtures';

// Activity > Live runs, History and Event log (02, section 7), and the project list's last
// activity (02, section 6.1).

const TITLE = '<b>Checkout</b> **fails** on phones';

test('reading the event log and filtering it by project and ticket', async ({ page }) => {
  await completeSetup(page);
  await createReadyProject(page, { key: 'WEB', name: 'Web shop', repository: 'web-shop' });
  await createReadyProject(page, { key: 'APP', name: 'Phone app', repository: 'phone-app' });
  for (const title of [TITLE, 'Second ticket']) {
    const created = await page.request.post('/api/projects/WEB/tickets', {
      data: { type: 'bug', title },
    });
    expect(created.status()).toBe(201);
  }
  const done = await page.request.post('/api/projects/WEB/tickets/1/mark-done', {
    data: { comment: `Fixed by hand. ${'More words. '.repeat(20)}` },
  });
  expect(done.status()).toBe(200);

  await page.goto('/');
  await openSection(page, 'Activity');
  await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
  await expect(
    page.getByRole('main').getByRole('link', { name: 'Help', exact: true }),
  ).toHaveAttribute('href', '/help/activity');
  // The queue comes with a later version; the event log fields are those of its own section.
  await expect(page.getByText(/^Coming in a later version: the tickets waiting/)).toBeVisible();
  const log = page.getByRole('region', { name: 'Event log' });

  const events = page.getByRole('list', { name: 'Events' });
  // Events about no project are shown without a project filter.
  await expect(events.getByText(/^GitHub token saved for the account/)).toBeVisible();
  await expect(events.getByText(/^APP created/)).toBeVisible();

  // A quoted title is plain text, shortened, and links to the ticket.
  const quote = events.getByRole('link', { name: `“${TITLE}”` });
  await expect(quote).toHaveAttribute('href', '/projects/WEB/tickets/1');
  const markedDone = events.getByRole('listitem').filter({ hasText: 'marked as done manually' });
  await expect(markedDone).toContainText(
    'WEB-1 marked as done manually: “Fixed by hand. More words.',
  );
  await expect(markedDone).toContainText('…”');
  await expect(markedDone).toContainText('You');

  await log.getByLabel('Project', { exact: true }).selectOption('WEB');
  await expect(page).toHaveURL(/\?project=WEB$/);
  await expect(events.getByText(/^APP created/)).toBeHidden();
  await expect(events.getByText(/^GitHub token saved/)).toBeHidden();
  await expect(events.getByText(/^WEB created/)).toBeVisible();
  await expect(events.getByText(/^WEB-2 created/)).toBeVisible();
  await expectFitsScreen(page);

  await log.getByLabel('Ticket number').fill('1');
  await expect(events.getByText(/^WEB-2 created/)).toBeHidden();
  await expect(events.getByRole('listitem')).toHaveCount(2);

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(events.getByText(/^APP created/)).toBeVisible();

  await quote.click();
  await expect(page.getByRole('heading', { name: /WEB-1/ })).toBeVisible();
});

test('opening a project’s event log from its last activity', async ({ page }) => {
  await completeSetup(page);
  await createReadyProject(page, { key: 'WEB', name: 'Web shop', repository: 'web-shop' });
  await page.goto('/projects');
  await page.getByRole('link', { name: /^Last activity/ }).click();
  await expect(page).toHaveURL(/\/activity\?project=WEB$/);
  await expect(
    page.getByRole('region', { name: 'Event log' }).getByLabel('Project', { exact: true }),
  ).toHaveValue('WEB');
  await expect(page.getByRole('list', { name: 'Events' }).getByText(/^WEB is ready/)).toBeVisible();
});

test('Live runs shows what the agent does now, then History keeps the ended run', async ({
  page,
}) => {
  await page.goto(await readyForRuns(page));
  const runId = await runNow(page);
  await startRun(page, runId);
  await sendLog(page, runId, 0, ['Reading CLAUDE.md', 'Writing the contact form']);

  await openSection(page, 'Activity');
  const live = page.getByRole('list', { name: 'Live runs' });
  await expect(live).toContainText('WEB-1 · Web Developer on Laptop');
  await expect(live.getByLabel('Run status')).toHaveText('Running');
  const latest = live.getByRole('list', { name: 'Latest log entry' });
  await expect(latest).toContainText('Writing the contact form');
  await expect(latest).not.toContainText('Reading CLAUDE.md');
  // The next entry replaces it, without a reload.
  await sendLog(page, runId, 2, ['Running the tests']);
  await expect(latest).toContainText('Running the tests');
  await live.getByText('Watch it in a terminal').click();
  await expect(live.getByLabel('Attach command')).toHaveText(`orchestrator-daemon attach ${runId}`);
  await expect(
    page.getByText('Coming in a later version: the tickets waiting to run'),
  ).toBeVisible();
  await expectFitsScreen(page);

  await live.getByRole('button', { name: 'Stop run' }).click();
  await page
    .getByRole('dialog', { name: 'Stop this run?' })
    .getByRole('button', { name: 'Stop run' })
    .click();
  await expect(page.getByText('No run is active.')).toBeVisible();
  const history = page.getByRole('list', { name: 'Ended runs' });
  await expect(history).toContainText('WEB-1 · attempt 1');
  await expect(history).toContainText('Cancelled: it was cancelled');

  await page.getByLabel('Outcome').selectOption('Finished');
  await expect(page.getByText('No run matches these filters.')).toBeVisible();
  await page.getByLabel('Outcome').selectOption('Cancelled');
  await expect(history).toContainText('WEB-1 · attempt 1');
  await expectFitsScreen(page);

  await history.getByRole('link', { name: 'WEB-1 · attempt 1' }).click();
  await expect(page.getByLabel('Run status')).toHaveText('Cancelled: it was cancelled');
});
