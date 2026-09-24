import type { Page } from '@playwright/test';
import {
  completeSetup,
  createReadyProject,
  expect,
  expectFitsScreen,
  openSection,
  test,
} from './fixtures';

// Tickets (02, sections 6.3 and 6.4; 04, section 2), on a project created through the API with
// the fake GitHub of apps/server/test/e2e-server.ts.

/** A ready project `WEB`, created as the new project form would. */
async function readyProject(page: Page) {
  await completeSetup(page);
  await createReadyProject(page, { key: 'WEB', name: 'Web shop', repository: 'web-shop' });
}

async function createTicket(page: Page, body: Record<string, unknown>) {
  const response = await page.request.post('/api/projects/WEB/tickets', {
    data: { type: 'feature', ...body },
  });
  expect(response.status(), await response.text()).toBe(201);
}

function column(page: Page, state: string) {
  return page.getByRole('list', { name: state, exact: true });
}

function timeline(page: Page) {
  return page.getByRole('list', { name: 'Timeline' });
}

test('creating tickets with a dependency, from the board', async ({ page }) => {
  await readyProject(page);
  await page.goto('/');
  await openSection(page, 'Projects');
  await expect(page.getByRole('list', { name: 'Projects' })).toContainText('No tickets yet');
  await page.getByRole('link', { name: 'WEB · Web shop' }).click();
  await expect(page.getByText('No tickets yet.', { exact: false })).toBeVisible();

  // First ticket, with ordered acceptance criteria.
  await page.getByRole('link', { name: 'New ticket' }).click();
  await expect(page.getByRole('heading', { name: 'New ticket', level: 1 })).toBeVisible();
  await page.getByLabel('Title').fill('Product list');
  await page.getByLabel('Description').fill('Show **every** product.');
  await page.getByRole('button', { name: 'Add a criterion' }).click();
  await page.getByLabel('Acceptance criterion 1').fill('Shows the prices');
  await page.getByRole('button', { name: 'Add a criterion' }).click();
  await page.getByLabel('Acceptance criterion 2').fill('Shows the names');
  await page.getByRole('button', { name: 'Move criterion 2 up' }).click();
  await page.getByRole('button', { name: 'Add a criterion' }).click();
  await expectFitsScreen(page);
  await page.getByRole('button', { name: 'Create the ticket' }).click();

  await expect(page.getByRole('heading', { name: 'WEB-1 · Product list', level: 1 })).toBeVisible();
  await expect(page.getByRole('main').getByText('every', { exact: true })).toHaveJSProperty(
    'tagName',
    'STRONG',
  );
  // The empty criterion is left out; the order is kept.
  await expect(
    page.getByRole('list', { name: 'Acceptance criteria' }).getByRole('listitem'),
  ).toHaveText(['Shows the names', 'Shows the prices']);
  await expectFitsScreen(page);

  // A title over the limit is refused, naming the field and the limit.
  await page.getByRole('link', { name: 'Back to WEB · Web shop' }).click();
  await page.getByRole('link', { name: 'New ticket' }).click();
  // The board also has a "Type" filter: wait for the form.
  await expect(page.getByRole('heading', { name: 'New ticket', level: 1 })).toBeVisible();
  await page.getByLabel('Type').selectOption({ label: 'Bug' });
  await page.getByLabel('Title').fill('x'.repeat(201));
  await page.getByRole('button', { name: 'Create the ticket' }).click();
  await expect(page.getByText('The title can have at most 200 characters.')).toBeVisible();

  // Second ticket, waiting for the first.
  await page.getByLabel('Title').fill('Checkout page is broken');
  await page.getByLabel('Priority').selectOption({ label: 'High' });
  await page
    .getByLabel('Add a ticket it waits for')
    .selectOption({ label: 'WEB-1 · Product list (To do)' });
  await expect(page.getByRole('list', { name: 'Blocked by' })).toContainText(
    'WEB-1 · Product list',
  );
  await page.getByRole('button', { name: 'Create the ticket' }).click();
  await expect(
    page.getByRole('heading', { name: 'WEB-2 · Checkout page is broken', level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('Blocked.', { exact: true })).toBeVisible();
  await expect(
    page.getByText('It waits for WEB-1, which is not done yet.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Blocked by' })).toContainText(
    'WEB-1 · Product list (To do)',
  );

  // The first ticket lists it under "Blocks".
  await page.getByRole('link', { name: 'WEB-1 · Product list' }).click();
  await expect(page.getByRole('list', { name: 'Blocks' })).toContainText(
    'WEB-2 · Checkout page is broken',
  );

  // The board: high priority first, the blocked badge, filters.
  await page.getByRole('link', { name: 'Back to WEB · Web shop' }).click();
  const todo = column(page, 'To do');
  await expect(todo.getByRole('listitem')).toHaveText([
    /WEB-2 · Checkout page is broken\s*Bug\s*Blocked/,
    /WEB-1 · Product list\s*Feature/,
  ]);
  await expect(todo.getByRole('listitem').nth(1)).not.toContainText('Blocked');
  await expect(page.getByRole('heading', { name: 'To do (2)' })).toBeVisible();
  await expect(page.getByText('Done (0)')).toBeVisible();
  await expectFitsScreen(page);
  await page.getByLabel('Type').selectOption({ label: 'Bug' });
  await expect(todo.getByRole('listitem')).toHaveCount(1);
  await page.getByLabel('Type').selectOption({ label: 'All types' });
  await page.getByLabel('Search').fill('WEB-1');
  await expect(todo.getByRole('listitem')).toHaveText([/WEB-1 · Product list/]);
  await page.getByLabel('Search').fill('checkout');
  await expect(todo.getByRole('listitem')).toHaveText([/WEB-2/]);

  await openSection(page, 'Projects');
  await expect(page.getByRole('list', { name: 'Projects' })).toContainText('Tickets: 2 To do');
  await expectFitsScreen(page);
});

test('commenting, cancelling and reopening; a ticket waiting for a cancelled one stays blocked', async ({
  page,
}) => {
  await readyProject(page);
  await createTicket(page, { title: 'Design the logo' });
  await createTicket(page, { title: 'Print the flyers', blockedBy: [1] });
  await page.goto('/projects/WEB/tickets/1');

  // A comment, in the timeline.
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(page.getByText('Write a comment first.')).toBeVisible();
  await page.getByLabel('Add a comment').fill('Blue and *green*, please.');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(timeline(page).getByRole('listitem')).toHaveText([
    /You ·.*Blue and green, please\./,
  ]);
  await expect(page.getByLabel('Add a comment')).toHaveValue('');
  await expectFitsScreen(page);

  // Cancel, after a confirmation that can be dismissed.
  await page.getByRole('button', { name: 'Cancel the ticket' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel WEB-1?' });
  await expect(dialog).toContainText('Tickets waiting for it stay blocked');
  await expectFitsScreen(page);
  await dialog.getByRole('button', { name: 'Keep it' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Cancel the ticket' }).click();
  await dialog.getByRole('button', { name: 'Cancel the ticket' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(timeline(page)).toContainText('You cancelled it (it was To do).');
  // No edit or dependency change once cancelled; comments are still possible.
  await expect(page.getByRole('link', { name: 'Edit' })).toBeHidden();
  await expect(page.getByLabel('Add a ticket it waits for')).toBeHidden();
  await expect(page.getByLabel('Add a comment')).toBeVisible();

  // The waiting ticket says what the owner can do.
  await page.getByRole('link', { name: 'WEB-2 · Print the flyers' }).click();
  await expect(
    page.getByText(
      'WEB-1 is cancelled, so this ticket stays blocked. Remove the dependency below if this ticket no longer needs it, or reopen WEB-1.',
    ),
  ).toBeVisible();
  await expectFitsScreen(page);

  // The board shows the cancelled ticket once its column is opened.
  await page.getByRole('link', { name: 'Back to WEB · Web shop' }).click();
  await expect(column(page, 'Cancelled')).toBeHidden();
  await page.getByText('Cancelled (1)').click();
  await expect(column(page, 'Cancelled').getByRole('listitem')).toHaveText([
    /WEB-1 · Design the logo/,
  ]);
  await expect(column(page, 'To do').getByRole('listitem')).toHaveText([/WEB-2.*Blocked/]);

  // Reopen: back to To do; the waiting ticket is blocked by a ticket to do, no longer cancelled.
  await column(page, 'Cancelled').getByRole('link', { name: 'WEB-1 · Design the logo' }).click();
  await page.getByRole('button', { name: 'Reopen' }).click();
  await expect(page.getByText('To do', { exact: true })).toBeVisible();
  await expect(timeline(page)).toContainText('You reopened it.');
  await page.getByRole('link', { name: 'WEB-2 · Print the flyers' }).click();
  await expect(page.getByText('It waits for WEB-1', { exact: false })).toBeVisible();
  await expect(page.getByText('is cancelled', { exact: false })).toBeHidden();

  // Removing the dependency unblocks it.
  await page.getByRole('button', { name: 'Remove the dependency on WEB-1' }).click();
  await expect(page.getByText('Blocked.', { exact: true })).toBeHidden();
  await expect(page.getByRole('list', { name: 'Blocked by' })).toBeHidden();
});

test('mark as done manually is refused without a comment', async ({ page }) => {
  await readyProject(page);
  await createTicket(page, { title: 'Set up the domain name' });
  await createTicket(page, { title: 'Send the newsletter', blockedBy: [1] });

  // Refused by the API without a comment.
  for (const data of [{}, { comment: '   ' }]) {
    const refused = await page.request.post('/api/projects/WEB/tickets/1/mark-done', { data });
    expect(refused.status()).toBe(400);
  }

  // Refused by the screen without a comment.
  await page.goto('/projects/WEB/tickets/1');
  await page.getByRole('button', { name: 'Mark as done manually' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark WEB-1 as done?' });
  await dialog.getByRole('button', { name: 'Mark as done' }).click();
  await expect(
    dialog.getByText('Write why the ticket is done: this comment is required.'),
  ).toBeVisible();
  await expect(dialog).toBeVisible();
  await expectFitsScreen(page);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('To do', { exact: true })).toBeVisible();

  // With a comment: done, the comment in the timeline, the waiting ticket unblocked.
  await page.getByRole('button', { name: 'Mark as done manually' }).click();
  await dialog.getByLabel('Why is it done? (required)').fill('I bought it myself on **Monday**.');
  await dialog.getByRole('button', { name: 'Mark as done' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Done', { exact: true })).toBeVisible();
  await expect(timeline(page).getByRole('listitem')).toHaveText([
    /You marked it as done manually \(it was To do\)\.\s*I bought it myself on Monday\./,
  ]);
  await expect(page.getByRole('button', { name: 'Mark as done manually' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Cancel the ticket' })).toBeHidden();
  await page.getByRole('link', { name: 'WEB-2 · Send the newsletter' }).click();
  await expect(page.getByText('Blocked.', { exact: true })).toBeHidden();
  await expect(page.getByRole('list', { name: 'Blocked by' })).toContainText('(Done)');
});

test('mark as done manually warns when the ticket still waits for tickets not done', async ({
  page,
}) => {
  await readyProject(page);
  await createTicket(page, { title: 'Buy the domain' });
  await createTicket(page, { title: 'Write the texts' });
  await createTicket(page, { title: 'Take the photos' });
  await createTicket(page, { title: 'Publish the site', blockedBy: [1, 2, 3] });
  const done = await page.request.post('/api/projects/WEB/tickets/1/mark-done', {
    data: { comment: 'Bought.' },
  });
  expect(done.status()).toBe(200);
  const cancelled = await page.request.post('/api/projects/WEB/tickets/2/cancel');
  expect(cancelled.status()).toBe(200);

  // A ticket waiting for nothing: no warning.
  await page.goto('/projects/WEB/tickets/3');
  await page.getByRole('button', { name: 'Mark as done manually' }).click();
  const plain = page.getByRole('dialog', { name: 'Mark WEB-3 as done?' });
  await expect(plain.getByText(/still waits for/)).toBeHidden();
  await expect(plain.getByRole('button', { name: 'Mark as done', exact: true })).toBeVisible();
  await plain.getByRole('button', { name: 'Cancel' }).click();

  // A blocked ticket: the tickets not done are named with their states, done ones are not.
  await page.goto('/projects/WEB/tickets/4');
  await page.getByRole('button', { name: 'Mark as done manually' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark WEB-4 as done?' });
  await expect(dialog.getByRole('alert')).toHaveText(
    'WEB-4 still waits for WEB-2 (Cancelled) and WEB-3 (To do), which are not done. Mark it as done anyway only if its work no longer needs them.',
  );
  await expectFitsScreen(page);
  await dialog.getByLabel('Why is it done? (required)').fill('Published by hand.');
  await dialog.getByRole('button', { name: 'Mark as done anyway' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Done', { exact: true })).toBeVisible();
});

test('editing a ticket, and a dependency cycle refused in plain words', async ({ page }) => {
  await readyProject(page);
  await createTicket(page, { title: 'Database' });
  await createTicket(page, { title: 'API', blockedBy: [1] });
  await createTicket(page, { title: 'Screens', blockedBy: [2] });

  await page.goto('/projects/WEB/tickets/1');
  await page
    .getByLabel('Add a ticket it waits for')
    .selectOption({ label: 'WEB-3 · Screens (To do)' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(
    page.getByText(
      'Refused: this would make a loop in which each ticket waits for the next, so none of them could ever start: WEB-1 → WEB-3 → WEB-2 → WEB-1.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Blocked by' })).toBeHidden();
  await expectFitsScreen(page);

  await page.getByRole('link', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { name: 'Edit WEB-1', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Add a ticket it waits for')).toBeHidden();
  await page.getByLabel('Title').fill('Database tables');
  await page.getByLabel('Type').selectOption({ label: 'Chore' });
  await expectFitsScreen(page);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByRole('heading', { name: 'WEB-1 · Database tables', level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('Chore', { exact: true })).toBeVisible();
});

test('Markdown in tickets runs nothing and loads nothing', async ({ page, baseURL }) => {
  await readyProject(page);
  const hostile = [
    'Hello <script>window.pwned = 1</script>',
    '<img src="https://tracker.example/pixel.png" onerror="window.pwned = 2">',
    '[click me](javascript:window.pwned=3)',
    '[data link](data:text/html,<script>alert(1)</script>)',
    '![Screenshot](https://images.example/shot.png)',
    '[Specs](https://example.com/specs)',
  ].join('\n\n');
  await createTicket(page, { title: 'Hostile text', description: hostile });
  expect(
    (
      await page.request.post('/api/projects/WEB/tickets/1/comments', {
        data: { body: '<svg onload="window.pwned = 4"></svg> and <b onclick="alert(1)">bold</b>' },
      })
    ).status(),
  ).toBe(201);

  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  const outside: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(baseURL ?? '')) outside.push(request.url());
  });

  await page.goto('/projects/WEB/tickets/1');
  const main = page.getByRole('main');
  await expect(main.getByText('Hello <script>window.pwned = 1</script>')).toBeVisible();
  await expect(main.getByText('click me')).toBeVisible();
  await expect(main.getByRole('link', { name: 'click me' })).toHaveCount(0);
  await expect(main.getByRole('link', { name: 'data link' })).toHaveCount(0);
  const image = main.getByRole('link', { name: 'Image: Screenshot' });
  await expect(image).toHaveAttribute('href', 'https://images.example/shot.png');
  await expect(image).toHaveAttribute('rel', 'noopener noreferrer');
  const specs = main.getByRole('link', { name: 'Specs' });
  await expect(specs).toHaveAttribute('target', '_blank');
  await expect(specs).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(timeline(page)).toContainText('<svg onload="window.pwned = 4"></svg> and');
  await expect(main.locator('img, script, svg, iframe')).toHaveCount(0);
  await main.getByText('<b onclick="alert(1)">', { exact: false }).click();
  await expectFitsScreen(page);

  expect(await page.evaluate(() => (window as { pwned?: number }).pwned)).toBeUndefined();
  expect(dialogs).toEqual([]);
  expect(outside).toEqual([]);
});
