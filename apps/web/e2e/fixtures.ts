import { expect, test as base, type Locator, type Page, type TestInfo } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Tokens accepted by the fake GitHub of apps/server/test/e2e-server.ts.
export const TOKEN_FULL = 'github_pat_e2e_full_0123456789';
export const TOKEN_NO_WORKFLOWS = 'github_pat_e2e_no_workflows_0123456789';
export const OWNER = { username: 'owner', password: 'correct horse battery' };

/** Test-only control address of apps/server/test/e2e-server.ts. */
export const controlUrl = `http://127.0.0.1:${String(Number(process.env.E2E_PORT ?? 8095) + 1)}`;

/**
 * Every test starts from the first launch: the server's database is emptied and the fake GitHub
 * reset. `failNextGitHubRequest` makes the fake GitHub fail the next request with this method and
 * path ending, for example `('POST', '/git/trees', 503)`.
 */
export const test = base.extend<{
  fresh: undefined;
  failNextGitHubRequest: (method: string, path: string, status: number) => Promise<void>;
  /** A commit on GitHub without the Orchestrator, in a repository of `octo-owner`. */
  gitHubCommit: (commit: {
    repository: string;
    branch: string;
    files: Record<string, string | null>;
    message: string;
    from?: string;
  }) => Promise<string>;
}>({
  fresh: [
    async ({ playwright }, use) => {
      const control = await playwright.request.newContext();
      const response = await control.post(`${controlUrl}/reset`);
      expect(response.status()).toBe(204);
      await control.dispose();
      await use(undefined);
    },
    { auto: true },
  ],
  failNextGitHubRequest: async ({ playwright }, use) => {
    const control = await playwright.request.newContext();
    await use(async (method, path, status) => {
      const response = await control.post(`${controlUrl}/github/fail-next`, {
        data: { method, path, status },
      });
      expect(response.status()).toBe(204);
    });
    await control.dispose();
  },
  gitHubCommit: async ({ playwright }, use) => {
    const control = await playwright.request.newContext();
    await use(async (commit) => {
      const response = await control.post(`${controlUrl}/github/commit`, { data: commit });
      expect(response.status()).toBe(200);
      // The commit made, as GitHub names it.
      return ((await response.json()) as { sha: string }).sha;
    });
    await control.dispose();
  },
});

export { expect };

/**
 * Pictures of the screens for the owner, who judges them without building the server (lot 3 step
 * F4): `apps/web/e2e-screenshots/<name>.<desktop|phone>.png`, ignored by Git and emptied at the
 * start of each run (`e2e/screenshots-setup.ts`). The whole page, or one part of it.
 */
export const SCREENSHOTS = fileURLToPath(new URL('../e2e-screenshots/', import.meta.url));

export async function screenshot(target: Page | Locator, testInfo: TestInfo, name: string) {
  const path = `${SCREENSHOTS}${name}.${testInfo.project.name}.png`;
  await ('goto' in target
    ? target.screenshot({ path, fullPage: true })
    : target.screenshot({ path }));
}

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
  // The layout first: before it renders, "Menu" is not visible on a phone either.
  await page.getByRole('main').waitFor();
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

/**
 * Creates a project with a new private repository through the API, and waits until it is ready.
 * A new web app requires `browser-tests` (lot 5 step C2), which the scripted daemon does not
 * report: the requirement is removed, so the project's runs start on it.
 */
export async function createReadyProject(
  page: Page,
  project: { key: string; name: string; repository: string },
) {
  const created = await page.request.post('/api/projects', {
    data: {
      name: project.name,
      key: project.key,
      kind: 'web_app',
      repository: { origin: 'created', name: project.repository, private: true },
    },
  });
  expect(created.status()).toBe(201);
  const required = await page.request.put(`/api/projects/${project.key}/required-capabilities`, {
    data: { capabilities: [] },
  });
  expect(required.status()).toBe(200);
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get(`/api/projects/${project.key}`)).json()) as {
            setup: { status: string };
          }
        ).setup.status,
    )
    .toBe('ready');
}

/**
 * Enrolls and connects the scripted daemon of apps/server/test/e2e-server.ts with `code`, as
 * `orchestrator-daemon enroll` then `start` would; `hello` changes what it reports. Returns the
 * control's status: 204 when the server accepted the daemon, 409 when it refused it.
 */
export async function connectDaemon(
  page: Page,
  code: string,
  hello: Record<string, unknown> = {},
): Promise<number> {
  const response = await page.request.post(`${controlUrl}/daemon/connect`, {
    data: { code, hello },
  });
  return response.status();
}

/**
 * The owner comes back to the page, for example from the terminal: the browser tells the page it
 * is visible again, and the screens read their data again (02, section 1).
 */
export async function comeBack(page: Page) {
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
}

/** Adds a Claude account and a machine through the API; returns the machine's enrollment code. */
export async function createMachine(
  page: Page,
  machine: { name: string; account: string },
): Promise<{ id: string; code: string }> {
  const accounts = (await (await page.request.get('/api/accounts')).json()) as {
    accounts: { id: string; label: string }[];
  };
  let account = accounts.accounts.find((existing) => existing.label === machine.account);
  if (!account) {
    const created = await page.request.post('/api/accounts', {
      data: { label: machine.account, plan: 'pro' },
    });
    expect(created.status()).toBe(201);
    account = (await created.json()) as { id: string; label: string };
  }
  const response = await page.request.post('/api/machines', {
    data: { name: machine.name, accountId: account.id },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as {
    machine: { id: string };
    enrollment: { code: string };
  };
  return { id: body.machine.id, code: body.enrollment.code };
}

// Runs played by the scripted daemon (lot 2 step L), through the test server's controls: the
// daemon acknowledges the server's commands by itself; the test sends its reports and tool calls.

export const BRANCH_HEAD = 'a'.repeat(40);
export const COMMITS = [
  { hash: 'c'.repeat(40), subject: 'Add the contact form' },
  { hash: 'b'.repeat(40), subject: 'Check the e-mail address' },
];

/** Waits for the run's `run.start` (or `run.resume`) sent to the scripted daemon. */
export async function runSent(
  page: Page,
  runId: string,
): Promise<{ type: 'run.start' | 'run.resume'; runToken: string }> {
  const response = await page.request.post(`${controlUrl}/daemon/run`, { data: { runId } });
  expect(response.status()).toBe(200);
  return (await response.json()) as { type: 'run.start' | 'run.resume'; runToken: string };
}

/**
 * A planning run of the request on the machine, `starting` (lot 5 step D2b): D2a's test helper
 * through the test server's control, until step E2's scheduler starts them.
 */
export async function startPlanningRun(
  page: Page,
  request: number,
  machineId: string,
): Promise<{ runId: string; runToken: string }> {
  const response = await page.request.post(`${controlUrl}/daemon/planning-run`, {
    data: { request, machineId },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as { runId: string; runToken: string };
}

/** Sends a message of the scripted daemon; returns the server's answer. */
export async function daemonRequest(
  page: Page,
  type: string,
  payload: Record<string, unknown>,
): Promise<{ type: string; payload: Record<string, unknown> }> {
  const response = await page.request.post(`${controlUrl}/daemon/request`, {
    data: { message: { type, id: crypto.randomUUID(), payload } },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as { type: string; payload: Record<string, unknown> };
}

/**
 * CI passes for the run's submission (lot 3 step G1a): the session idle waiting for CI, then one
 * CI check that finds it passed. The run then succeeds and the ticket moves to In review.
 */
export async function ciPasses(page: Page, runId: string) {
  await reportState(page, runId, 'waiting_ci');
  const response = await page.request.post(`${controlUrl}/ci/pass`, { data: { runId } });
  expect(response.status()).toBe(204);
}

/**
 * The scripted daemon holds its answers to `run.input` and `run.resume` (`true`), as a daemon that
 * has not answered yet, or sends them (`false`). A CI round is then shown before the daemon
 * confirms it, which ends the wait (lot 3 step G2b).
 */
export async function holdDaemonInput(page: Page, hold: boolean) {
  const response = await page.request.post(`${controlUrl}/daemon/hold-input`, { data: { hold } });
  expect(response.status()).toBe(204);
}

/**
 * One CI check of the run's submission with GitHub's answers given for it (lot 3 step G1b): its
 * workflow runs and statuses, GitHub's request limit, a conflict, the start wait over.
 */
export async function ciCheck(
  page: Page,
  runId: string,
  answers: {
    runs?: { name: string; status: string; conclusion: string | null }[];
    statuses?: { context: string; state: 'error' | 'failure' | 'pending' | 'success' }[];
    rateLimitedSeconds?: number;
    mergeable?: boolean | null;
    startedMinutesAgo?: number;
  },
) {
  const response = await page.request.post(`${controlUrl}/ci/check`, {
    data: { runId, ...answers },
  });
  expect(response.status()).toBe(204);
}

/** A `run.state` report, which the server must accept. */
export async function reportState(
  page: Page,
  runId: string,
  state:
    | 'preparing'
    | 'starting'
    | 'working'
    | 'idle'
    | 'waiting_ci'
    | 'waiting_human'
    | 'quota_paused'
    | 'ended',
  extra: Record<string, unknown> = {},
) {
  const base = {
    runId,
    at: new Date().toISOString(),
    claudeSessionId: '0f7a3c52-9d7e-4e8f-a4b1-111111111111',
    sessionAlive: state !== 'ended',
    state,
  };
  const fields =
    state === 'starting'
      ? { claudeCodeVersion: '2.1.283' }
      : state === 'ended'
        ? {
            reason: 'submitted',
            detail: null,
            branch: { name: 't/1-contact-form', head: BRANCH_HEAD, commitsAhead: COMMITS },
          }
        : {};
  const answer = await daemonRequest(page, 'run.state', { ...base, ...fields, ...extra });
  expect(answer).toMatchObject({ type: 'ack', payload: { ok: true } });
}

/** The run's log entries, as the daemon reads them from the transcript. */
export async function sendLog(page: Page, runId: string, from: number, texts: string[]) {
  const answer = await daemonRequest(page, 'run.events', {
    runId,
    estimatedUsageUsd: 0.42,
    events: texts.map((text, index) => ({
      seq: from + index,
      at: new Date().toISOString(),
      kind: 'agent_text',
      tool: null,
      text,
    })),
  });
  expect(answer).toMatchObject({ type: 'ack', payload: { ok: true } });
}

/** A tool call of the agent, relayed by the daemon; returns the tool's output. */
export async function callTool(
  page: Page,
  runToken: string,
  tool: string,
  input: Record<string, unknown>,
  workspace?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const answer = await daemonRequest(page, 'mcp.call', {
    tool,
    runToken,
    input,
    ...(workspace ? { workspace } : {}),
  });
  expect(answer.type).toBe('mcp.result');
  expect(answer.payload, JSON.stringify(answer.payload)).toMatchObject({ ok: true });
  return answer.payload.output as Record<string, unknown>;
}

/**
 * A ready project `WEB`, a machine `Laptop` connected with its account, and a ticket assigned to
 * the Web Developer; returns the ticket's page address.
 */
export async function readyForRuns(page: Page): Promise<string> {
  await completeSetup(page);
  await createReadyProject(page, { key: 'WEB', name: 'Bakery website', repository: 'bakery' });
  const { code } = await createMachine(page, { name: 'Laptop', account: 'Personal' });
  expect(await connectDaemon(page, code)).toBe(204);
  const ticket = await page.request.post('/api/projects/WEB/tickets', {
    data: {
      type: 'feature',
      title: 'Contact form',
      description: 'Visitors write to the bakery.',
      acceptanceCriteria: ['The contact page has a form', 'The e-mail address is checked'],
      assignee: 'web_dev',
    },
  });
  expect(ticket.status()).toBe(201);
  return '/projects/WEB/tickets/1';
}

/** **Run now** from the ticket page; returns the run's id, from the run page it opens. */
export async function runNow(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page).toHaveURL(/\/activity\/runs\/[0-9a-f-]{36}$/);
  return page.url().split('/').at(-1) ?? '';
}

/** Plays the daemon's side of a start: preparing, starting, then working; returns the run token. */
export async function startRun(page: Page, runId: string): Promise<string> {
  const { runToken } = await runSent(page, runId);
  await reportState(page, runId, 'preparing');
  await reportState(page, runId, 'starting');
  await reportState(page, runId, 'working');
  return runToken;
}

/**
 * The scripted daemon reports a usage limit for the run (05, section 4.10): `detected`, with its
 * reset time when given, or `suspected`. The run is then paused.
 */
export async function limited(
  page: Page,
  runId: string,
  kind: 'detected' | 'suspected',
  resetsAt?: string,
) {
  const answer = await daemonRequest(page, 'run.quota_limited', {
    runId,
    kind,
    ...(kind === 'detected' ? { resetsAt: resetsAt ?? null } : {}),
    evidence: {
      signal: 'stop_failure',
      error: kind === 'detected' ? 'rate_limit' : 'overloaded',
      message: kind === 'detected' ? "You've hit your session limit" : 'API Error: 529 Overloaded',
      statusLine: null,
    },
  });
  expect(answer).toMatchObject({ type: 'ack', payload: { ok: true } });
}
