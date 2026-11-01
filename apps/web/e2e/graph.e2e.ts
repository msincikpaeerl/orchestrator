import type { Locator, Page } from '@playwright/test';
import {
  callTool,
  completeSetup,
  connectDaemon,
  createMachine,
  createReadyProject,
  expect,
  expectFitsScreen,
  reportState,
  screenshot,
  startPlanningRun,
  test,
} from './fixtures';

// The dependency graph (lot 5 step H; 02, sections 5.3 and 6.3): one component, on the board
// behind **Dependency graph** and in the plan review under **Dependencies**; columns by depth
// with arrows on a computer, a list by depth on a phone.

async function createTicket(page: Page, title: string, blockedBy: number[] = []) {
  const response = await page.request.post('/api/projects/WEB/tickets', {
    data: { type: 'feature', title, blockedBy },
  });
  expect(response.status()).toBe(201);
}

/** The titles of one column's cards, in order. */
function cards(graph: Locator, heading: string): Locator {
  return graph.getByRole('list', { name: heading, exact: true }).locator(':scope > li');
}

/** On a computer the columns sit side by side; on a phone one below the other. */
async function expectLayout(first: Locator, second: Locator, phone: boolean) {
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  if (!a || !b) throw new Error('a column is not shown');
  if (phone) {
    expect(b.y).toBeGreaterThan(a.y + a.height - 1);
    expect(Math.abs(b.x - a.x)).toBeLessThan(2);
  } else {
    expect(b.x).toBeGreaterThan(a.x + a.width - 1);
  }
}

test("the board's dependency graph, its filters and the phone's list", async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === 'phone';
  await completeSetup(page);
  await createReadyProject(page, { key: 'WEB', name: 'Web shop', repository: 'web-shop' });
  await createTicket(page, 'Setup'); // 1, done
  await createTicket(page, 'Home page', [1]); // 2
  await createTicket(page, 'Contact form', [2]); // 3
  await createTicket(page, 'User guide', [2]); // 4
  await createTicket(page, 'Release', [3, 4]); // 5: a diamond
  await createTicket(page, 'Old logo'); // 6, cancelled, still waited for
  await createTicket(page, 'Footer', [6]); // 7
  await createTicket(page, 'Dropped idea'); // 8, cancelled, waited for by nothing
  const done = await page.request.post('/api/projects/WEB/tickets/1/mark-done', {
    data: { comment: 'Done by hand.' },
  });
  expect(done.status()).toBe(200);
  for (const number of [6, 8]) {
    const cancelled = await page.request.post(`/api/projects/WEB/tickets/${String(number)}/cancel`);
    expect(cancelled.status()).toBe(200);
  }

  await page.goto('/projects/WEB');
  await expect(page.getByRole('heading', { name: 'To do (5)' })).toBeVisible();
  await page.getByRole('button', { name: 'Dependency graph' }).click();
  await expect(page).toHaveURL(/[?&]view=graph/);
  await expect(page.getByRole('button', { name: 'Dependency graph' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const graph = page.getByRole('region', { name: 'Dependency graph' });
  const step1 = cards(graph, 'Step 1 · waits for nothing');
  const step2 = cards(graph, 'Step 2');
  const step3 = cards(graph, 'Step 3');
  await expect(step1).toHaveCount(2);
  await expect(step1.nth(0)).toHaveAccessibleName('WEB-2 · Home page');
  await expect(step1.nth(1)).toHaveAccessibleName('WEB-6 · Old logo');
  await expect(step1.nth(1)).toContainText('Cancelled');
  await expect(step2).toHaveCount(3);
  await expect(graph.getByRole('listitem', { name: 'WEB-3 · Contact form' })).toContainText(
    'Waits for WEB-2.',
  );
  const footer = graph.getByRole('listitem', { name: 'WEB-7 · Footer' });
  await expect(footer).toContainText('Blocked');
  await expect(footer).toContainText('To do');
  await expect(footer).toContainText('Waits for WEB-6.');
  await expect(step3).toHaveCount(1);
  await expect(step3.first()).toHaveAccessibleName('WEB-5 · Release');
  await expect(step3.first()).toContainText('Waits for WEB-3, WEB-4.');
  // Done tickets, and cancelled ones nothing waits for, are left out.
  await expect(graph.getByText('Setup')).toHaveCount(0);
  await expect(graph.getByText('Dropped idea')).toHaveCount(0);

  const column1 = graph.getByRole('region', { name: 'Step 1 · waits for nothing' });
  const column2 = graph.getByRole('region', { name: 'Step 2', exact: true });
  await expectLayout(column1, column2, phone);
  const arrows = graph.locator('svg > path');
  if (phone) {
    await expect(graph.locator('svg')).toBeHidden();
  } else {
    // 2→3, 2→4, 3→5, 4→5 and 6→7.
    await expect(arrows).toHaveCount(5);
  }
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'board-graph');

  // The filters hide cards; every ticket keeps its column.
  await page.getByLabel('Search').fill('Release');
  await expect(step3).toHaveCount(1);
  await expect(graph.getByRole('region', { name: 'Step 2', exact: true })).toContainText(
    'No tickets shown',
  );
  await expect(step3.first()).toContainText('Waits for WEB-3, WEB-4.');
  if (!phone) await expect(arrows).toHaveCount(0);
  await page.getByLabel('Search').fill('');

  // Kept in the address, then back to the columns.
  await page.reload();
  await expect(step3).toHaveCount(1);
  await page.getByRole('button', { name: 'Columns' }).click();
  await expect(page).not.toHaveURL(/view=graph/);
  await expect(graph).toBeHidden();
  await expect(page.getByRole('heading', { name: 'To do (5)' })).toBeVisible();
});

const home = {
  key: 'home',
  type: 'feature',
  title: 'Home page',
  acceptance_criteria: ['The home page shows the bakery name'],
  assignee: 'web_dev',
  blocked_by: ['TESTB-1'],
};
const contact = {
  key: 'contact',
  type: 'feature',
  title: 'Contact form',
  acceptance_criteria: ['A message is saved'],
  assignee: 'web_dev',
  blocked_by: ['home'],
};
const docs = {
  key: 'docs',
  type: 'docs',
  title: 'User guide',
  acceptance_criteria: ['The guide explains the form'],
  assignee: 'web_dev',
  blocked_by: ['home'],
};
const release = {
  key: 'release',
  type: 'chore',
  title: 'Release',
  acceptance_criteria: ['The site is published'],
  blocked_by: ['contact', 'docs'],
};

test("a plan's dependency graph, with a ticket of the project, follows its edits", async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === 'phone';
  await completeSetup(page);
  await createReadyProject(page, { key: 'TESTB', name: 'Test B', repository: 'test-b' });
  const login = await page.request.post('/api/projects/TESTB/tickets', {
    data: { type: 'feature', title: 'Login' },
  });
  expect(login.status()).toBe(201);
  const { id: machineId, code } = await createMachine(page, {
    name: 'Laptop',
    account: 'Personal',
  });
  expect(await connectDaemon(page, code)).toBe(204);
  const created = await page.request.post('/api/requests', {
    data: { body: 'A bakery site', project: 'TESTB' },
  });
  expect(created.status()).toBe(201);
  const { runId, runToken } = await startPlanningRun(page, 1, machineId);
  await reportState(page, runId, 'working');
  await callTool(page, runToken, 'plan_propose', {
    summary: 'The home page after the login, then the form and its guide, then the release.',
    tickets: [home, contact, docs, release],
  });
  await reportState(page, runId, 'ended', { reason: 'submitted', detail: null, branch: null });

  await page.goto('/requests/1');
  const plan = page.getByRole('region', { name: 'Plan', exact: true });
  const graph = plan.getByRole('region', { name: 'Dependencies' });
  await expect(cards(graph, 'Step 1 · waits for nothing')).toHaveCount(1);
  const existing = graph.getByRole('listitem', { name: 'TESTB-1 · Login' });
  await expect(existing).toContainText('Already in TESTB');
  await expect(existing).toContainText('To do');
  await expect(cards(graph, 'Step 2')).toHaveCount(1);
  await expect(graph.getByRole('listitem', { name: 'home · Home page' })).toContainText(
    'Waits for TESTB-1.',
  );
  await expect(cards(graph, 'Step 3')).toHaveCount(2);
  const last = graph.getByRole('listitem', { name: 'release · Release' });
  await expect(last).toContainText('Waits for contact, docs.');
  await expect(cards(graph, 'Step 4')).toHaveCount(1);
  const column1 = graph.getByRole('region', { name: 'Step 1 · waits for nothing' });
  await expectLayout(column1, graph.getByRole('region', { name: 'Step 2', exact: true }), phone);
  if (!phone) await expect(graph.locator('svg > path')).toHaveCount(5);
  await expectFitsScreen(page);
  await screenshot(page, testInfo, 'plan-graph');

  // A removal changes the graph at once.
  const ticketCards = plan.getByRole('list', { name: 'Tickets of the plan' });
  await ticketCards
    .getByRole('listitem', { name: 'docs · User guide' })
    .getByRole('button', { name: 'Remove docs' })
    .click();
  const remove = page.getByRole('dialog', { name: 'Remove docs (User guide) from the plan?' });
  await remove.getByRole('button', { name: 'Remove' }).click();
  await expect(remove).toBeHidden();
  await expect(cards(graph, 'Step 3')).toHaveCount(1);
  await expect(last).toContainText('Waits for contact.');

  // The existing ticket links to its page.
  await existing.getByRole('link', { name: 'TESTB-1 · Login' }).click();
  await expect(page.getByRole('heading', { name: 'TESTB-1 · Login' })).toBeVisible();
});
