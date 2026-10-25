import type { Page } from '@playwright/test';
import { completeSetup, expect, expectFitsScreen, openSection, test } from './fixtures';

// Projects (02, section 6), against the fake GitHub of apps/server/test/e2e-server.ts: account
// `octo-owner` on the free plan, with the repositories `notes` (private, README only),
// `legacy-site` (public, CLAUDE.md and user documentation only) and `old-archive` (archived).

async function openNewProjectForm(page: Page) {
  await openSection(page, 'Projects');
  await page.getByRole('link', { name: 'New project' }).click();
  await expect(page.getByRole('heading', { name: 'New project', level: 1 })).toBeVisible();
}

/**
 * Requests for the project made by the page during 3 seconds: none once the setup is ready or
 * failed. The page no longer polls (lot 2 step L): it reads the project again only when the
 * realtime stream says it changed.
 */
async function projectRequestsWhileWaiting(page: Page, key: string): Promise<number> {
  let count = 0;
  const listener = (request: { url(): string }) => {
    if (new URL(request.url()).pathname === `/api/projects/${key}`) count += 1;
  };
  page.on('request', listener);
  await page.waitForTimeout(3000);
  page.off('request', listener);
  return count;
}

function setupCard(page: Page) {
  return page.getByRole('heading', { name: 'Repository setup' }).locator('..');
}

test('creating a private project with a new repository', async ({ page }) => {
  await completeSetup(page);
  await page.goto('/');
  await openNewProjectForm(page);
  await expect(
    page.getByRole('main').getByRole('link', { name: 'Help', exact: true }),
  ).toHaveAttribute('href', '/help/projects');
  await expect(page.getByRole('radio', { name: /Create a new repository/ })).toBeChecked();

  // The key and the repository name are suggested from the name; refusals are in plain words.
  await page.getByLabel('Name', { exact: true }).fill('Family recipes');
  await expect(page.getByLabel('Key')).toHaveValue('FR');
  await expect(page.getByLabel('Repository name')).toHaveValue('family-recipes');
  await expect(page.getByText('This name is free.')).toBeVisible();
  await page.getByLabel('Repository name').fill('notes');
  await expect(
    page.getByText('A repository with this name already exists on your GitHub account.', {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByLabel('Repository name').fill('family-recipes');
  await page.getByLabel('Key').fill('F1');
  await expect(page.getByText('Use 2 to 6 capital letters, for example WEB.')).toBeVisible();
  await page.getByLabel('Key').fill('FR');
  await page.getByLabel('Kind').selectOption({ label: 'Website' });
  // A website requires browser-tests (lot 5 step C2).
  await expect(
    page.getByText('This project will require the capability browser-tests', { exact: false }),
  ).toBeVisible();
  await page.getByLabel('Description').fill('Our recipes, for the whole family.');
  await expect(page.getByRole('radio', { name: /Private/ })).toBeChecked();
  await expectFitsScreen(page);
  await page.getByRole('button', { name: 'Create the project' }).click();

  // The project page follows the setup until it is ready.
  await expect(page.getByRole('heading', { name: 'FR · Family recipes', level: 1 })).toBeVisible();
  await expect(setupCard(page).getByText('Ready.')).toBeVisible();
  const steps = page.getByRole('list', { name: 'Setup steps' });
  await expect(steps.getByRole('listitem')).toHaveText([
    /Create the GitHub repository\s*Done/,
    /Add the starting files\s*Done/,
    /Protect the default branch\s*Done/,
  ]);
  await expect(page.getByText('octo-owner/family-recipes')).toBeVisible();
  await expect(page.getByText('(private, created by the Orchestrator)')).toBeVisible();
  // Information, not an error, with a help link.
  await expect(page.getByText('Not available on your GitHub plan.')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expectFitsScreen(page);
  await page.getByRole('link', { name: 'What this means' }).click();
  await expect(page.getByRole('heading', { name: 'Branch protection' })).toBeVisible();

  // A second project cannot take the same key.
  await page.goBack();
  await openNewProjectForm(page);
  await page.getByLabel('Name', { exact: true }).fill('Fun run');
  await expect(page.getByLabel('Key')).toHaveValue('FR');
  await expect(
    page.getByText('Another project already uses this key (archived projects count too).', {
      exact: false,
    }),
  ).toBeVisible();

  await openSection(page, 'Projects');
  const item = page.getByRole('list', { name: 'Projects' }).getByRole('listitem');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('FR · Family recipes');
  await expect(item).toContainText('Website');
  await expect(item).toContainText('(private)');
  await expectFitsScreen(page);
});

test('linking a repository lists its missing harness elements', async ({ page }) => {
  await completeSetup(page);
  await page.goto('/');
  await openNewProjectForm(page);
  await page.getByRole('radio', { name: /Link an existing repository/ }).check();
  const repositories = page.getByLabel('Repository', { exact: true });
  // Archived repositories cannot be linked.
  await expect(repositories.getByRole('option')).toHaveText([
    'Choose a repository',
    'legacy-site (public)',
    'notes (private)',
  ]);
  await page.getByRole('button', { name: 'Create the project' }).click();
  await expect(page.getByText('Choose a repository.')).toBeVisible();
  await repositories.selectOption('legacy-site');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('legacy-site');
  await page.getByLabel('Name', { exact: true }).fill('Legacy site');
  await expect(page.getByLabel('Key')).toHaveValue('LS');
  await expect(page.getByLabel('Repository name')).toBeHidden();
  await expectFitsScreen(page);
  await page.getByRole('button', { name: 'Create the project' }).click();

  await expect(page.getByRole('heading', { name: 'LS · Legacy site', level: 1 })).toBeVisible();
  await expect(setupCard(page).getByText('Ready.')).toBeVisible();
  await expect(page.getByText('(public, linked)')).toBeVisible();
  await expect(page.getByText('Not applied: a linked repository is never changed')).toBeVisible();
  const missing = page.getByRole('list', { name: 'Missing harness elements' });
  await expect(missing.getByRole('listitem')).toHaveText([
    /Developer documentation \(docs\/dev\/\)/,
    /Architecture decisions \(docs\/adr\/\)/,
    /CI workflow \(\.github\/workflows\/\)/,
  ]);
  await expectFitsScreen(page);
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(missing.getByRole('listitem')).toHaveCount(3);
  await missing.getByRole('link', { name: 'What is it?' }).last().click();
  await expect(page.getByRole('heading', { name: 'CI workflow' })).toBeVisible();

  // Already linked: no longer offered.
  await openNewProjectForm(page);
  await page.getByRole('radio', { name: /Link an existing repository/ }).check();
  await expect(page.getByLabel('Repository', { exact: true }).getByRole('option')).toHaveText([
    'Choose a repository',
    'notes (private)',
  ]);
});

test('a failed setup is shown in Needs you and tried again', async ({
  page,
  failNextGitHubRequest,
}) => {
  await completeSetup(page);
  await failNextGitHubRequest('POST', '/git/trees', 503);
  await page.goto('/');
  await openNewProjectForm(page);
  await page.getByLabel('Name', { exact: true }).fill('Garden planner');
  await page.getByRole('button', { name: 'Create the project' }).click();

  await expect(page.getByRole('heading', { name: 'GP · Garden planner', level: 1 })).toBeVisible();
  await expect(
    setupCard(page).getByText('The setup failed: GitHub could not be reached: try again later.'),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Setup steps' }).getByRole('listitem')).toHaveText([
    /Create the GitHub repository\s*Done/,
    /Add the starting files\s*Failed/,
    /Protect the default branch\s*Waiting/,
  ]);
  await expectFitsScreen(page);
  expect(await projectRequestsWhileWaiting(page, 'GP')).toBe(0);

  await openSection(page, 'Needs you');
  await expect(
    page.getByRole('heading', { name: 'Project setup failed: GP · Garden planner' }),
  ).toBeVisible();
  await expect(
    page.getByText('Step “Add the starting files”: GitHub could not be reached'),
  ).toBeVisible();
  const menu = page.getByRole('button', { name: 'Menu' });
  if (await menu.isVisible()) await menu.click();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByLabel('3 items')).toBeVisible();
  if (await menu.isVisible()) await menu.click();
  await expectFitsScreen(page);
  await page.getByRole('link', { name: 'Open the project' }).click();

  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(setupCard(page).getByText('Ready.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Setup steps' }).getByRole('listitem')).toHaveText([
    /Done/,
    /Done/,
    /Done/,
  ]);
  expect(await projectRequestsWhileWaiting(page, 'GP')).toBe(0);
  await openSection(page, 'Needs you');
  // Only the setup still to do is left (no Claude account and no machine in this test).
  await expect(page.getByRole('heading', { level: 2 })).toHaveText([
    'No Claude account yet',
    'No machine enrolled yet',
  ]);
});

test('archiving and unarchiving a project, with confirmation', async ({ page }) => {
  await completeSetup(page);
  const created = await page.request.post('/api/projects', {
    data: {
      name: 'Old shop',
      key: 'SHOP',
      kind: 'web_app',
      repository: { origin: 'created', name: 'old-shop', private: true },
    },
  });
  expect(created.status()).toBe(201);
  await page.goto('/projects/SHOP');
  await expect(setupCard(page).getByText('Ready.')).toBeVisible();

  // Settings: name and description, then archive.
  await page.getByRole('link', { name: 'Project settings' }).click();
  await expect(page.getByRole('heading', { name: 'Project settings', level: 1 })).toBeVisible();
  // The page has other Save buttons, one per limit: this one saves the name and description.
  const form = page.getByRole('form', { name: 'Name and description' });
  await form.getByLabel('Description').fill('The shop we closed.');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByText('Saved.')).toBeVisible();
  await expectFitsScreen(page);

  await page.getByRole('button', { name: 'Archive' }).click();
  const dialog = page.getByRole('dialog', { name: 'Archive SHOP Old shop?' });
  await expect(dialog).toContainText('The GitHub repository octo-owner/old-shop is not changed.');
  await expectFitsScreen(page);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Archive' }).click();
  await dialog.getByRole('button', { name: 'Archive' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText('This project is archived: it is read-only and no work starts on it.'),
  ).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toBeDisabled();
  // Merge automatically too (lot 5 step 5bis B).
  await expect(
    page.getByRole('checkbox', { name: /Merge approved pull requests automatically/ }),
  ).toBeDisabled();

  // Hidden from the list unless "Show archived" is ticked.
  await openSection(page, 'Projects');
  await expect(page.getByText('No project yet.', { exact: false })).toBeVisible();
  await page.getByLabel('Show archived').check();
  const item = page.getByRole('list', { name: 'Projects' }).getByRole('listitem');
  await expect(item).toContainText('SHOP · Old shop');
  await expect(item).toContainText('Archived');
  await expectFitsScreen(page);

  await item.getByRole('button', { name: 'Unarchive' }).click();
  const unarchive = page.getByRole('dialog', { name: 'Unarchive SHOP Old shop?' });
  await expect(unarchive).toContainText(
    'The GitHub repository octo-owner/old-shop is not changed.',
  );
  await unarchive.getByRole('button', { name: 'Unarchive' }).click();
  await expect(unarchive).toBeHidden();
  await expect(item).not.toContainText('Archived');
  await page.getByLabel('Show archived').uncheck();
  await expect(item).toContainText('SHOP · Old shop');
});

test("a project's required capabilities, edited in Project settings", async ({ page }) => {
  await completeSetup(page);
  await page.goto('/');
  await openNewProjectForm(page);
  // The form says what the kind requires, with the help on browser tests.
  await page.getByLabel('Kind').selectOption({ label: 'Android app' });
  await expect(page.getByText('No effect yet', { exact: false })).toBeVisible();
  await page.getByLabel('Kind').selectOption({ label: 'Web app' });
  await expect(
    page.getByText(
      'This project will require the capability browser-tests: its runs go only to machines that can run browser tests. You can remove it in Project settings.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Browser tests' })).toHaveAttribute(
    'href',
    '/help/machines#browser-tests',
  );

  const created = await page.request.post('/api/projects', {
    data: {
      name: 'Shop',
      key: 'SHOP',
      kind: 'web_app',
      repository: { origin: 'created', name: 'shop', private: true },
    },
  });
  expect(created.status()).toBe(201);
  await page.goto('/projects/SHOP/settings');
  const card = page.getByRole('heading', { name: 'Required capabilities' }).locator('..');
  const list = card.getByRole('list', { name: 'Required capabilities' });
  await expect(list.getByRole('listitem')).toHaveText([/browser-tests/]);
  await expectFitsScreen(page);

  // A wrong tag, then one already there, are refused in plain words.
  const field = card.getByLabel('Add a capability');
  await field.fill('Android SDK');
  await card.getByRole('button', { name: 'Add' }).click();
  await expect(
    card.getByText('Use lowercase letters and digits, with “-” between words: android-sdk.'),
  ).toBeVisible();
  await field.fill('browser-tests');
  await card.getByRole('button', { name: 'Add' }).click();
  await expect(card.getByText('The project already requires this capability.')).toBeVisible();
  await field.fill('android-sdk');
  await card.getByRole('button', { name: 'Add' }).click();
  await expect(list.getByRole('listitem')).toHaveText([/browser-tests/, /android-sdk/]);
  await expect(card.getByRole('status')).toHaveText(
    'Saved. A run already started goes on where it is.',
  );

  await card.getByRole('button', { name: 'Remove browser-tests' }).click();
  await card.getByRole('button', { name: 'Remove android-sdk' }).click();
  await expect(
    card.getByText('None: any machine can take the runs of this project.'),
  ).toBeVisible();
  await expectFitsScreen(page);

  // Each change in Activity.
  await page.goto('/activity');
  await expect(
    page.getByText('SHOP: required capabilities set to none (before: android-sdk)'),
  ).toBeVisible();

  // Read-only once archived.
  expect((await page.request.post('/api/projects/SHOP/archive')).status()).toBe(200);
  await page.goto('/projects/SHOP/settings');
  await expect(card.getByText('Unarchive the project to change them.')).toBeVisible();
  await expect(card.getByLabel('Add a capability')).toHaveCount(0);
});
