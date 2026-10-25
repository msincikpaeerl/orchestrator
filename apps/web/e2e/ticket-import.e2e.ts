import type { Page } from '@playwright/test';
import {
  completeSetup,
  createReadyProject,
  expect,
  expectFitsScreen,
  screenshot,
  test,
} from './fixtures';

// Import tickets from a file (02, section 6.3; 06, section 4.6; lot 5bis step A), on a project
// created through the API with the fake GitHub of apps/server/test/e2e-server.ts.

async function readyProject(page: Page) {
  await completeSetup(page);
  await createReadyProject(page, { key: 'WEB', name: 'Web shop', repository: 'web-shop' });
  const existing = await page.request.post('/api/projects/WEB/tickets', {
    data: { type: 'chore', title: 'Hosting' },
  });
  expect(existing.status(), await existing.text()).toBe(201);
}

/** The file as Claude would write it; `assignee` lets the test write a mistake. */
function ticketFile(assignee: string): string {
  return JSON.stringify(
    {
      format: 'orchestrator-tickets/1',
      tickets: [
        {
          key: 'layout',
          type: 'chore',
          title: 'Page layout',
          acceptance_criteria: ['Header and footer on every page'],
          blocked_by: ['WEB-1'],
        },
        {
          key: 'contact',
          type: 'feature',
          title: 'Contact form',
          description: 'A form that sends the message by email.',
          acceptance_criteria: ['Sends the message', 'Shows a confirmation'],
          priority: 'high',
          assignee,
          blocked_by: ['layout'],
        },
      ],
    },
    null,
    2,
  );
}

test('importing tickets: paste, a problem, the fix, the import and its links', async ({
  page,
}, testInfo) => {
  await readyProject(page);
  await page.goto('/projects/WEB');
  await page.getByRole('button', { name: 'Import tickets' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import tickets' });
  await expect(dialog).toBeVisible();

  // A file with a mistake: nothing can be imported, and the problem says where it is.
  await dialog.getByLabel('Text of the file').fill(ticketFile('writer'));
  await dialog.getByRole('button', { name: 'Preview' }).click();
  const problems = dialog.getByRole('list', { name: 'Problems' });
  await expect(problems.getByRole('listitem')).toHaveText([
    'Ticket 2 “contact”, field assignee: No agent profile with the key writer. The agents you can assign are architect (Architect), web_dev (Web Developer).',
  ]);
  await expect(dialog.getByRole('button', { name: /^Import/ })).toHaveCount(0);
  await expectFitsScreen(page);
  await screenshot(dialog, testInfo, 'ticket-import-problem');

  // Fixed: the preview lists the tickets with their dependencies and warns about the assignee.
  await dialog.getByLabel('Text of the file').fill(ticketFile('web_dev'));
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(problems).toHaveCount(0);
  await expect(
    dialog.getByText('Assigned tickets can be started by the scheduler right away.', {
      exact: false,
    }),
  ).toBeVisible();
  const planned = dialog.getByRole('list', { name: 'Tickets to create' }).getByRole('listitem');
  await expect(planned).toHaveCount(2);
  await expect(planned.nth(0)).toContainText('layout · Page layout');
  await expect(planned.nth(0)).toContainText('Waits for WEB-1 (Hosting, to do)');
  await expect(planned.nth(1)).toContainText('Feature · High priority · Web Developer');
  await expect(planned.nth(1)).toContainText('Waits for “layout” (Page layout)');
  await expectFitsScreen(page);
  await screenshot(dialog, testInfo, 'ticket-import-preview');

  // Imported: the new numbers, each a link.
  await dialog.getByRole('button', { name: 'Import 2 tickets' }).click();
  const imported = dialog.getByRole('list', { name: 'Imported tickets' });
  await expect(imported.getByRole('link')).toHaveText([
    'WEB-2 · Page layout',
    'WEB-3 · Contact form',
  ]);
  await screenshot(dialog, testInfo, 'ticket-import-done');
  await imported.getByRole('link', { name: 'WEB-3 · Contact form' }).click();
  await expect(page.getByRole('heading', { name: 'WEB-3 · Contact form', level: 1 })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // On the board, in To do.
  await page.goto('/projects/WEB');
  await expect(page.getByRole('list', { name: 'To do', exact: true })).toContainText(
    'WEB-3 · Contact form',
  );
});

test('importing tickets from a .json file', async ({ page }) => {
  await readyProject(page);
  await page.goto('/projects/WEB');
  await page.getByRole('button', { name: 'Import tickets' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import tickets' });
  await dialog.getByLabel('Choose a .json file').setInputFiles({
    name: 'tickets.json',
    mimeType: 'application/json',
    buffer: Buffer.from(ticketFile('web_dev')),
  });
  await expect(dialog.getByLabel('Text of the file')).toHaveValue(/"key": "contact"/);
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await dialog.getByRole('button', { name: 'Import 2 tickets' }).click();
  await expect(
    dialog.getByRole('list', { name: 'Imported tickets' }).getByRole('link'),
  ).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'To do', exact: true })).toContainText(
    'WEB-2 · Page layout',
  );
});

test('no import on an archived project', async ({ page }) => {
  await readyProject(page);
  expect((await page.request.post('/api/projects/WEB/archive')).status()).toBe(200);
  await page.goto('/projects/WEB');
  await expect(page.getByRole('link', { name: 'WEB-1 · Hosting' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import tickets' })).toHaveCount(0);
});
