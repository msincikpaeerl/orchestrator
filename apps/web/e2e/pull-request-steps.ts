import type { Page } from '@playwright/test';
import {
  COMMITS,
  callTool,
  ciPasses,
  controlUrl,
  expect,
  readyForRuns,
  reportState,
  runNow,
  startRun,
} from './fixtures';

// The steps the end-to-end tests of a ticket's pull request share (lot 3 steps J4a and J4b): the
// work accepted with pull request #1, Quality's approval or the owner's skip, the end-to-end
// server's controls. Not a test file itself (Playwright runs `*.e2e.ts` only).

export const BRANCH = 't/1-contact-form';
export const REPORT = {
  criteria: [
    { number: 1, status: 'met', justification: 'The contact page shows the form.' },
    { number: 2, status: 'met', justification: 'An invalid address is refused.' },
  ],
  tests: { paths: ['src/contact.test.ts'], justification: null },
  docs: { paths: ['docs/user/contact.md'], justification: null },
  adrs: [],
  summary: 'Adds the contact form with its checks.',
};
export const CHANGED = ['docs/user/contact.md', 'src/contact.test.ts', 'src/contact.ts'];
export const SUMMARY =
  'The form checks the e-mail address, the tests cover both criteria and the user documentation describes the page.';
export const CONFLICT_REQUEST =
  'Pull request #1 conflicts with main. Merge main into the branch with `git merge origin/main`, resolve the conflicts keeping the approved work, then hand it in again.';

export type GitHubCommit = (commit: {
  repository: string;
  branch: string;
  files: Record<string, string | null>;
  message: string;
  from?: string;
}) => Promise<string>;

export const short = (commit: string) => commit.slice(0, 7);

export async function control(page: Page, path: string, data: Record<string, unknown> = {}) {
  const response = await page.request.post(`${controlUrl}${path}`, { data });
  expect(response.ok(), path).toBe(true);
}

/** `WEB-1` implemented, its work accepted and CI passed: in review, with pull request #1. */
export async function inReview(page: Page, gitHubCommit: GitHubCommit): Promise<string> {
  const ticketPage = await readyForRuns(page);
  await page.goto(ticketPage);
  const runId = await runNow(page);
  const runToken = await startRun(page, runId);
  const head = await gitHubCommit({
    repository: 'bakery',
    branch: BRANCH,
    files: { 'src/contact.ts': 'export {};\n' },
    message: 'Add the contact form',
    from: 'main',
  });
  const answer = await callTool(page, runToken, 'ticket_submit', REPORT, {
    clean: true,
    branch: { name: BRANCH, head, commitsAhead: COMMITS },
    push: { status: 'pushed', head },
    changedFiles: { listed: CHANGED, count: CHANGED.length },
  });
  expect(answer).toMatchObject({ result: 'pending_ci' });
  await ciPasses(page, runId);
  await page.goto(ticketPage);
  await expect(page.getByText('In review', { exact: true }).first()).toBeVisible();
  return head;
}

/** Quality's review approving the work from the ticket page: the ticket on Awaiting merge. */
export async function approved(page: Page) {
  await page.getByRole('button', { name: 'Start review' }).first().click();
  await expect(page).toHaveURL(/\/activity\/runs\/[0-9a-f-]{36}$/);
  const runId = page.url().split('/').at(-1) ?? '';
  const runToken = await startRun(page, runId);
  await callTool(page, runToken, 'review_approve', { summary: SUMMARY });
  await reportState(page, runId, 'ended');
}

/** **Skip review** from the ticket page: the ticket on Awaiting merge. */
export async function skipped(page: Page) {
  await page.getByRole('button', { name: 'Skip review' }).click();
  await page
    .getByRole('dialog', { name: 'Skip the review of WEB-1?' })
    .getByRole('button', { name: 'Skip review' })
    .click();
  await expect(page.getByText('Awaiting merge', { exact: true }).first()).toBeVisible();
}

export function item(page: Page, title: string) {
  return page.getByRole('listitem').filter({ hasText: title });
}
