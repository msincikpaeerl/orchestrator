import {
  expect,
  expectFitsScreen,
  openSection,
  readyForRuns,
  runNow,
  screenshot,
  sendLog,
  startRun,
  test,
} from './fixtures';

// A Claude account's time zone, window, daily budget and Stop new runs (lot 4 step C; 02,
// sections 4, 9.1 and 10). The browser is in Paris, so its time zone is the one filled in.

test.use({ timezoneId: 'Europe/Paris' });

/** `HH:MM` in Paris, `hours` from now. */
function parisTime(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toLocaleTimeString('en-GB', {
    timeZone: 'Europe/Paris',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

test('sets a window, a budget and a pause on an account, and sees them on Needs you', async ({
  page,
}, testInfo) => {
  await page.goto(await readyForRuns(page));

  // Settings: no time zone saved yet, the browser's filled in.
  await openSection(page, 'Settings');
  const zone = page.getByRole('form', { name: 'Time zone' });
  await expect(zone).toContainText('Not saved yet: until you save one, the Orchestrator uses UTC.');
  await expect(zone.getByLabel('Time zone')).toHaveValue('Europe/Paris');
  await zone.getByRole('button', { name: 'Save the time zone' }).click();
  await expect(zone).toContainText('Saved: Europe/Paris.');
  await expect(zone.getByRole('button', { name: 'Save the time zone' })).toBeDisabled();

  // The account's page, from Machines.
  await openSection(page, 'Machines');
  await page.getByRole('link', { name: 'Windows, budget and history of Personal' }).click();
  await expect(page.getByRole('heading', { name: 'Personal', level: 1 })).toBeVisible();
  await expect(page.getByText('Any time (no window)')).toBeVisible();
  await expect(
    page.getByText("Windows and days are read in the Orchestrator's time zone, Europe/Paris"),
  ).toBeVisible();

  // A window every day, opening in two hours: outside it now.
  const windows = page.getByRole('form', { name: 'Schedule windows' });
  await windows.getByRole('button', { name: 'Add a window' }).click();
  for (const day of ['Saturday', 'Sunday']) await windows.getByLabel(day).check();
  const opens = parisTime(2);
  await windows.getByLabel('Window 1: from').fill(opens);
  await windows.getByLabel('Window 1: until').fill(parisTime(3));
  await windows.getByRole('button', { name: 'Save windows' }).click();
  await expect(page.getByText(`Every day, ${opens} to`)).toBeVisible();
  await expect(page.getByText('Outside its windows: the next one opens at')).toBeVisible();

  // A budget of one cent of estimated usage.
  const budget = page.getByRole('form', { name: 'Daily budget' });
  await budget.getByLabel('Estimated usage').check();
  await budget.getByLabel('US dollars of estimated usage a day').fill('0.001');
  await budget.getByRole('button', { name: 'Save the budget' }).click();
  await expect(budget.getByText('Enter an amount in dollars and cents')).toBeVisible();
  await budget.getByLabel('US dollars of estimated usage a day').fill('0.01');
  await budget.getByRole('button', { name: 'Save the budget' }).click();
  await expect(page.getByText('$0.01 of estimated usage a day')).toBeVisible();
  await expect(
    page.getByText('Today: working 0 s · estimated usage $0.00 of $0.01 · 0 runs'),
  ).toBeVisible();
  await expectFitsScreen(page);

  // Run now ignores the window: the run starts, and its estimate uses the budget.
  await page.goto('/projects/WEB/tickets/1');
  const runId = await runNow(page);
  await startRun(page, runId);
  await sendLog(page, runId, 0, ['Reading CLAUDE.md']);
  await page.goto('/projects/WEB/tickets/1');
  await expect(
    page.getByText('Estimated usage: $0.42 over 1 run (estimated by Claude Code).'),
  ).toBeVisible();

  // Stop new runs: paused, the run goes on.
  await openSection(page, 'Machines');
  await page.getByRole('link', { name: 'Windows, budget and history of Personal' }).click();
  await expect(page.getByText(/^Daily budget used: no new run starts by itself/)).toBeVisible();
  await page.getByRole('button', { name: 'Stop new runs on Personal' }).click();
  await expect(page.getByText('Paused: you stopped new runs on it.')).toBeVisible();
  await expect(page.getByText('State: Paused')).toBeVisible();
  await screenshot(page, testInfo, 'account-page');

  // Needs you: Paused, the next window and the budget used, with Resume.
  await openSection(page, 'Needs you');
  const line = page.getByRole('list', { name: 'Claude accounts' }).getByRole('listitem');
  await expect(line).toContainText(
    /^Personal: Paused · next window at .+ · daily budget used until /,
  );
  await expect(line.getByRole('button', { name: 'Resume Personal' })).toBeVisible();
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'account-needs-you');

  // Run now on another ticket is refused while paused, in the screen's words.
  const second = await page.request.post('/api/projects/WEB/tickets', {
    data: {
      type: 'feature',
      title: 'Opening hours',
      description: 'Show when the bakery is open.',
      acceptanceCriteria: ['The hours are on the home page'],
      assignee: 'web_dev',
    },
  });
  expect(second.status()).toBe(201);
  await page.goto('/projects/WEB/tickets/2');
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(
    page.getByText(/its Claude account Personal is paused: you stopped new runs on it/),
  ).toBeVisible();

  // Resume from Needs you.
  await openSection(page, 'Needs you');
  await line.getByRole('button', { name: 'Resume Personal' }).click();
  await expect(line.getByRole('button', { name: 'Stop new runs on Personal' })).toBeVisible();
  await expect(line).toContainText(/^Personal: Available · next window at /);
});
