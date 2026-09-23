import { expect, test as base, type Page } from '@playwright/test';

// Tokens accepted by the fake GitHub of apps/server/test/e2e-server.ts.
export const TOKEN_FULL = 'github_pat_e2e_full_0123456789';
export const TOKEN_NO_WORKFLOWS = 'github_pat_e2e_no_workflows_0123456789';
export const OWNER = { username: 'owner', password: 'correct horse battery' };

/** Every test starts from the first launch: the server's database is emptied. */
export const test = base.extend<{ fresh: undefined }>({
  fresh: [
    async ({ playwright }, use) => {
      const control = await playwright.request.newContext();
      const port = Number(process.env.E2E_PORT ?? 8095) + 1;
      const response = await control.post(`http://127.0.0.1:${String(port)}/reset`);
      expect(response.status()).toBe(204);
      await control.dispose();
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect };

export function inDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Creates the owner and connects GitHub through the API, as the wizard would. Logs in. */
export async function completeSetup(
  page: Page,
  github: { token: string; expiresOn: string | null } = {
    token: TOKEN_FULL,
    expiresOn: inDays(300),
  },
) {
  expect((await page.request.post('/api/setup/owner', { data: OWNER })).status()).toBe(201);
  expect((await page.request.put('/api/github/token', { data: github })).status()).toBe(200);
}

/** Opens a section from the main navigation, through "Menu" on a phone. */
export async function openSection(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Menu' });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: new RegExp(`^${name}`) })
    .click();
}

/** The page fits the screen's width: nothing to scroll sideways, on a phone in particular. */
export async function expectFitsScreen(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'horizontal scrolling').toBeLessThanOrEqual(0);
}
