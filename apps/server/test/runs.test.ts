import { randomUUID } from 'node:crypto';
import { schema } from '@orchestrator/db';
import {
  AccountListResponse,
  ApiError,
  BRANCH_REPORT_MAX_COMMITS,
  CLAUDE_CODE_VALIDATED_VERSION,
  ClaudeAccount,
  EnrollmentResponse,
  NeedsYouResponse,
  Run,
  RunListResponse,
  RunLogResponse,
  TicketDetail,
  type McpResult,
  type NotOnGitHub,
  type PushResult,
  type RunRefusal,
  type RunStart,
  type RunState,
  type ServerMessage,
  type SettingValues,
} from '@orchestrator/protocol';
import { and, asc, desc, eq, like } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { enrollToken, ScriptedDaemon } from './daemon-client.js';
import { fullAccount, startFakeGitHub, type FakeGitHub } from './fake-github.js';
import { createOwner, startTestApp, type TestApp } from './helpers.js';

const TOKEN = 'github_pat_11AAAAAAA0secretTokenValue1234567890';
const HEAD = 'a'.repeat(40);
const COMMITS = [
  { hash: 'b'.repeat(40), subject: 'Add the contact form' },
  { hash: 'c'.repeat(40), subject: 'Test the e-mail check' },
];

let t: TestApp;
let github: FakeGitHub;
let cookie: string;
const daemons: ScriptedDaemon[] = [];
const heartbeats: NodeJS.Timeout[] = [];

afterEach(async () => {
  for (const timer of heartbeats.splice(0)) clearInterval(timer);
  for (const daemon of daemons.splice(0)) await daemon.close();
  await t.close();
  await github.close();
});

/**
 * The application with the fake GitHub, the owner, the GitHub token, a ready project `WEB` and
 * its ticket `WEB-1` assigned to the Web Developer. `daemonSecondMs` shortens the dispatch
 * acknowledgement timeout (and the heartbeat settings: daemons then send heartbeats).
 */
async function start(
  options: { settings?: Partial<SettingValues>; daemonSecondMs?: number; token?: boolean } = {},
) {
  github = await startFakeGitHub();
  github.accounts.set(TOKEN, fullAccount());
  t = await startTestApp({
    githubApiUrl: github.url,
    listen: true,
    settings: options.settings,
    daemonSecondMs: options.daemonSecondMs,
  });
  cookie = await createOwner(t.app);
  if (options.token !== false) {
    const saved = await call('PUT', '/api/github/token', { token: TOKEN, expiresOn: null });
    expect(saved.statusCode, saved.body).toBe(200);
  }
  await t.db.insert(schema.projects).values({
    key: 'WEB',
    name: 'Bakery website',
    slug: 'bakery',
    description: '',
    kind: 'website',
    repoOwner: 'octo-owner',
    repoName: 'bakery',
    repoOrigin: 'created',
    repoPrivate: true,
    defaultBranch: 'main',
    setupStatus: 'ready',
    branchProtection: 'applied',
  });
  await createTicket();
}

function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  return t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
}

async function createTicket(body: object = {}): Promise<TicketDetail> {
  const response = await call('POST', '/api/projects/WEB/tickets', {
    type: 'feature',
    title: 'Contact form',
    description: 'Visitors write to the bakery.',
    acceptanceCriteria: ['The contact page has a form'],
    assignee: 'web_dev',
    ...body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return TicketDetail.parse(response.json());
}

async function ticket(number = 1): Promise<TicketDetail> {
  const response = await call('GET', `/api/projects/WEB/tickets/${String(number)}`);
  expect(response.statusCode, response.body).toBe(200);
  return TicketDetail.parse(response.json());
}

async function runs(number = 1): Promise<Run[]> {
  const response = await call('GET', `/api/projects/WEB/tickets/${String(number)}/runs`);
  expect(response.statusCode, response.body).toBe(200);
  return RunListResponse.parse(response.json()).runs;
}

async function run(id: string): Promise<Run> {
  const response = await call('GET', `/api/runs/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return Run.parse(response.json());
}

async function createAccount(label = 'Personal', maxConcurrentRuns = 1): Promise<ClaudeAccount> {
  const response = await call('POST', '/api/accounts', { label, plan: 'pro', maxConcurrentRuns });
  expect(response.statusCode, response.body).toBe(201);
  return ClaudeAccount.parse(response.json());
}

/** A machine enrolled and connected, sending heartbeats when the settings are shortened. */
async function connectedMachine(
  name: string,
  accountId: string,
  hello: Parameters<ScriptedDaemon['hello']>[0] = {},
) {
  const response = await call('POST', '/api/machines', { name, accountId });
  expect(response.statusCode, response.body).toBe(201);
  const created = EnrollmentResponse.parse(response.json());
  const token = await enrollToken(t.url, created.enrollment.code);
  const daemon = await connect(token, hello);
  return { id: created.machine.id, token, daemon };
}

async function connect(token: string, hello: Parameters<ScriptedDaemon['hello']>[0] = {}) {
  const daemon = await ScriptedDaemon.connect(t.url, token);
  daemons.push(daemon);
  expect((await daemon.hello(hello)).accepted).toBe(true);
  heartbeats.push(
    setInterval(() => {
      if (daemon.isOpen) daemon.heartbeat();
    }, 50),
  );
  return daemon;
}

/** The usual setup: one account and the machine `Laptop` connected. */
async function laptop() {
  const account = await createAccount();
  return { account, ...(await connectedMachine('Laptop', account.id)) };
}

async function runNow(number = 1) {
  return call('POST', `/api/projects/WEB/tickets/${String(number)}/run`);
}

async function refusal(number = 1): Promise<RunRefusal> {
  const response = await runNow(number);
  expect(response.statusCode, response.body).toBe(409);
  const { error } = ApiError.parse(response.json());
  expect(error.code).toBe('run_not_possible');
  if (!error.runRefusal) throw new Error('no runRefusal');
  return error.runRefusal;
}

/** **Run now**, then the daemon acknowledges `run.start`: the run and the message. */
async function started(daemon: ScriptedDaemon, number = 1): Promise<{ run: Run; start: RunStart }> {
  const response = await runNow(number);
  expect(response.statusCode, response.body).toBe(201);
  const created = Run.parse(response.json());
  const start = await daemon.find<RunStart>(
    (message) => message.type === 'run.start' && message.payload.runId === created.id,
    'run.start',
  );
  daemon.send({ type: 'ack', id: start.id, payload: { ok: true } });
  return { run: created, start };
}

function state(
  runId: string,
  payload:
    | { state: 'preparing' | 'working' | 'idle' | 'waiting_human' | 'quota_paused' }
    | { state: 'starting'; claudeCodeVersion: string | null }
    | {
        state: 'ended';
        reason: Extract<RunState['payload'], { state: 'ended' }>['reason'];
        detail?: string | null;
        branch?: Reported | null;
        push?: PushResult | null;
        gitConfigRestored?: string | null;
      },
): RunState {
  const base = {
    runId,
    at: new Date().toISOString(),
    claudeSessionId: SESSION,
    sessionAlive: payload.state !== 'ended',
  };
  if (payload.state === 'ended') {
    return {
      type: 'run.state',
      id: randomUUID(),
      payload: {
        ...base,
        state: 'ended',
        reason: payload.reason,
        detail: payload.detail ?? null,
        branch: payload.branch ? { notOnGitHub: null, ...payload.branch } : null,
        push: payload.push ?? null,
        headMoved: null,
        gitConfigRestored: payload.gitConfigRestored ?? null,
      },
    };
  }
  return { type: 'run.state', id: randomUUID(), payload: { ...base, ...payload } };
}

const SESSION = '0f7a3c52-9d7e-4e8f-a4b1-111111111111';

/** A branch report; without `notOnGitHub`, as a protocol 1 daemon sends it. */
interface Reported {
  name: string;
  head: string;
  commitsAhead: typeof COMMITS;
  notOnGitHub?: NotOnGitHub | null;
}

async function report(daemon: ScriptedDaemon, message: Parameters<ScriptedDaemon['request']>[0]) {
  const answer = await daemon.request(message);
  expect(answer.type).toBe('ack');
  return answer.type === 'ack' ? answer.payload : null;
}

/** A run through `starting` to `running`. */
async function working(daemon: ScriptedDaemon, runId: string) {
  expect(await report(daemon, state(runId, { state: 'preparing' }))).toEqual({ ok: true });
  expect(
    await report(
      daemon,
      state(runId, { state: 'starting', claudeCodeVersion: CLAUDE_CODE_VALIDATED_VERSION }),
    ),
  ).toEqual({ ok: true });
  expect(await report(daemon, state(runId, { state: 'working' }))).toEqual({ ok: true });
}

const branch = (commitsAhead = COMMITS) => ({ name: 't/1-contact-form', head: HEAD, commitsAhead });

/** Waits until `check` passes, for what the server does on its own (a timer). */
async function eventually(what: string, check: () => Promise<void>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (failure) {
      if (Date.now() > deadline)
        throw new Error(`${what} not seen within ${String(timeoutMs)} ms`, { cause: failure });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function eventTypes(prefix: string) {
  const rows = await t.db
    .select({ type: schema.events.type, payload: schema.events.payload })
    .from(schema.events)
    .where(like(schema.events.type, `${prefix}%`))
    .orderBy(asc(schema.events.id));
  return rows;
}

function comments(detail: TicketDetail): string[] {
  return detail.timeline.flatMap((entry) => (entry.type === 'comment' ? [entry.comment.body] : []));
}

describe('Run now', () => {
  it('starts a run: queued, then dispatched, the ticket in progress, with run.start built by the server', async () => {
    await start({ settings: { maxRunDurationMinutes: 45, maxNudgesPerRun: 3 } });
    const { id: machineId, daemon } = await laptop();
    const { run: created, start: message } = await started(daemon);

    expect(created).toMatchObject({
      ticket: 'WEB-1',
      status: 'dispatched',
      attempt: 1,
      machine: { id: machineId, name: 'Laptop', online: true },
      profile: { key: 'web_dev', name: 'Web Developer' },
      branch: { name: 't/1-contact-form', head: null, commits: [] },
    });
    const { payload } = message;
    expect(payload.repository).toEqual({
      owner: 'octo-owner',
      name: 'bakery',
      cloneUrl: 'https://github.com/octo-owner/bakery.git',
      baseBranch: 'main',
      ticketBranch: 't/1-contact-form',
    });
    // The owner's noreply address, from the id and login read with the token (04, section 4).
    expect(payload.commitAuthor).toEqual({
      name: 'Web Developer (Orchestrator)',
      email: '5550123+octo-owner@users.noreply.github.com',
    });
    expect(payload.profile.instructions).toContain('# How you work in the Orchestrator');
    expect(payload.profile.instructions).toContain('# Your role: Web Developer');
    expect(payload.profile.allowedTools).toContain('Bash(pnpm *)');
    expect(payload.initialPrompt).toContain('Implement ticket WEB-1 of the project Bakery website');
    expect(payload.initialPrompt).toContain('This is attempt 1 at this ticket.');
    expect(payload.initialPrompt).not.toContain('earlier attempt');
    expect(payload.nudgeMessage).toContain('Your turn ended without');
    expect(payload.limits).toMatchObject({ maxRunDurationMinutes: 45, maxNudgesPerRun: 3 });
    expect(payload.resumeSessionId).toBeNull();
    expect(payload.runToken).toMatch(/^ort_/);

    const detail = await ticket();
    expect(detail.status).toBe('in_progress');
    expect(detail.branch).toEqual({
      name: 't/1-contact-form',
      where: 'no_commits',
      machine: null,
      head: null,
      commits: [],
      notOnGitHub: [],
      notOnGitHubCount: 0,
      pushed: null,
      pushFailure: null,
    });
    const statuses = (await eventTypes('run.status_changed')).map(({ payload: p }) => p);
    expect(statuses).toEqual([
      expect.objectContaining({ from: 'queued', to: 'dispatched', cause: 'run_now' }),
    ]);
    expect((await eventTypes('run.created')).length).toBe(1);
    // The run token is sent once and never logged; only its hash is stored.
    expect(t.logs.text).not.toContain(payload.runToken);
    const [row] = await t.db.select().from(schema.runs);
    expect(JSON.stringify(row)).not.toContain(payload.runToken);
  });

  it('refuses a ticket not in todo, without assignee, or blocked, naming the tickets', async () => {
    await start();
    await laptop();
    const blocker = await createTicket({ title: 'Bootstrap' });
    await createTicket({ title: 'Unassigned', assignee: null });
    const waiting = await createTicket({ title: 'Waiting' });
    expect(
      (
        await call('POST', `/api/projects/WEB/tickets/${String(waiting.number)}/dependencies`, {
          blockedBy: blocker.number,
        })
      ).statusCode,
    ).toBe(200);

    expect(await refusal(3)).toEqual({ reason: 'no_assignee' });
    expect(await refusal(waiting.number)).toEqual({ reason: 'blocked', tickets: ['WEB-2'] });
    await call('POST', '/api/projects/WEB/tickets/1/cancel');
    expect(await refusal(1)).toEqual({ reason: 'ticket_not_todo', status: 'cancelled' });
  });

  it('refuses an archived or not ready project', async () => {
    await start();
    await laptop();
    await t.db.update(schema.projects).set({ setupStatus: 'in_progress' });
    expect(await refusal()).toEqual({ reason: 'project_not_ready' });
    await t.db.update(schema.projects).set({ setupStatus: 'ready', status: 'archived' });
    expect(await refusal()).toEqual({ reason: 'project_archived' });
  });

  it('refuses without a usable GitHub token, and reads the account id at the first run', async () => {
    await start({ token: false });
    await laptop();
    expect(await refusal()).toEqual({ reason: 'github_not_connected' });

    const saved = await call('PUT', '/api/github/token', { token: TOKEN, expiresOn: null });
    expect(saved.statusCode).toBe(200);
    await t.db.update(schema.githubConnection).set({ invalidSince: new Date() });
    expect(await refusal()).toEqual({ reason: 'github_token_invalid' });
    await t.db
      .update(schema.githubConnection)
      .set({ invalidSince: null, unreadableSince: new Date() });
    expect(await refusal()).toEqual({ reason: 'github_token_unreadable' });

    // A token saved before 0.3.0: its account id is read at the first run (02, section 3.2).
    await t.db.update(schema.githubConnection).set({ unreadableSince: null, accountId: null });
    github.override = (request) =>
      request.path === '/user' ? { status: 503, body: { message: 'unavailable' } } : undefined;
    expect(await refusal()).toEqual({ reason: 'github_account_unknown' });
    github.override = undefined;
    expect((await runNow()).statusCode).toBe(201);
    const [connection] = await t.db.select().from(schema.githubConnection);
    expect(connection?.accountId).toBe(5_550_123);
  });

  it('refuses a ticket whose first message cannot be built, in plain words', async () => {
    await start();
    await laptop();
    // 120 dependencies, done, with long titles: more than the first message's 100,000 bytes.
    const [project] = await t.db.select().from(schema.projects);
    const [first] = await t.db.select().from(schema.tickets);
    if (!project || !first) throw new Error('no project');
    const done = await t.db
      .insert(schema.tickets)
      .values(
        Array.from({ length: 120 }, (_, index) => ({
          projectId: project.id,
          number: index + 10,
          type: 'feature',
          title: `Dependency ${String(index)} ${'é'.repeat(450)}`,
          description: '',
          priority: 'normal',
          status: 'done',
          createdBy: 'owner',
        })),
      )
      .returning({ id: schema.tickets.id });
    await t.db.update(schema.projects).set({ lastTicketNumber: 200 });
    await t.db
      .insert(schema.ticketDependencies)
      .values(
        done.map((row) => ({ projectId: project.id, ticketId: first.id, blockedById: row.id })),
      );
    expect(await refusal()).toEqual({ reason: 'first_message_too_large', maxBytes: 100_000 });
    expect((await ticket()).status).toBe('todo');
    expect(await runs()).toEqual([]);
  });

  it('lists every machine with why it cannot take the run', async () => {
    await start();
    expect(await refusal()).toEqual({ reason: 'no_machine', machines: [] });

    const account = await createAccount();
    const offline = await connectedMachine('Desk', account.id);
    await offline.daemon.close();
    const old = await connectedMachine('Old', account.id, { claudeCodeVersion: '2.1.100' });
    const disabled = await connectedMachine('Spare', account.id);
    expect((await call('POST', `/api/machines/${disabled.id}/disable`)).statusCode).toBe(200);
    await eventually('Desk offline', async () => {
      const [row] = await t.db
        .select()
        .from(schema.machines)
        .where(eq(schema.machines.id, offline.id));
      expect(row?.status).toBe('offline');
    });

    const refused = await refusal();
    expect(refused).toEqual({
      reason: 'no_machine',
      machines: [
        { machine: { id: offline.id, name: 'Desk' }, unavailable: { why: 'offline' } },
        {
          machine: { id: old.id, name: 'Old' },
          unavailable: {
            why: 'unusable',
            reasons: [{ type: 'claude_code_unsupported', version: '2.1.100', minimum: '2.1.280' }],
          },
        },
        { machine: { id: disabled.id, name: 'Spare' }, unavailable: { why: 'disabled' } },
      ],
    });
  });

  it("refuses when the account is limited (until when) or runs its maximum (with the account's value)", async () => {
    await start();
    const { id, account, daemon } = await laptop();
    await createTicket({ title: 'Second' });
    await started(daemon, 1);
    expect(await refusal(2)).toEqual({
      reason: 'no_machine',
      machines: [
        {
          machine: { id, name: 'Laptop' },
          unavailable: {
            why: 'account_busy',
            account: { id: account.id, label: 'Personal' },
            maxConcurrentRuns: 1,
          },
        },
      ],
    });
    const until = new Date(Date.now() + 3_600_000);
    await t.db
      .update(schema.claudeAccounts)
      .set({ state: 'limited', limitedUntil: until, maxConcurrentRuns: 2 });
    expect(await refusal(2)).toEqual({
      reason: 'no_machine',
      machines: [
        {
          machine: { id, name: 'Laptop' },
          unavailable: {
            why: 'account_limited',
            account: { id: account.id, label: 'Personal' },
            until: until.toISOString(),
          },
        },
      ],
    });
  });

  it('treats an account whose limit time has passed as available, then writes the change', async () => {
    await start();
    const { daemon } = await laptop();
    await t.db
      .update(schema.claudeAccounts)
      .set({ state: 'limited', limitedUntil: new Date(Date.now() - 1000) });
    const listed = AccountListResponse.parse((await call('GET', '/api/accounts')).json());
    expect(listed.accounts[0]).toMatchObject({ state: 'available', limitedUntil: null });
    expect(await eventTypes('account.available')).toEqual([]);

    await started(daemon);
    const [account] = await t.db.select().from(schema.claudeAccounts);
    expect(account).toMatchObject({ state: 'available', limitedUntil: null });
    expect((await eventTypes('account.available')).map(({ payload }) => payload)).toEqual([
      { label: 'Personal' },
    ]);
  });
});

describe('the criteria budget of the first message (04, section 8)', () => {
  it('refuses settings whose criteria would not fit, naming both settings and the budget', async () => {
    await start();
    const refused = await call('PUT', '/api/settings/ticketMaxAcceptanceCriteria', { value: 41 });
    expect(refused.statusCode).toBe(409);
    const { error } = ApiError.parse(refused.json());
    expect(error.code).toBe('setting_product_invalid');
    expect(error.settingProduct).toEqual({
      first: 'ticketMaxAcceptanceCriteria',
      second: 'acceptanceCriterionMaxLength',
      firstValue: 41,
      secondValue: 500,
      max: 20_000,
      unit: 'characters',
    });
    expect(error.message).toContain('20500');
    expect(error.message).toContain('20000');
    expect(
      (await call('PUT', '/api/settings/acceptanceCriterionMaxLength', { value: 1001 })).statusCode,
    ).toBe(409);

    // At the budget is allowed; a change or a reset that breaks it is refused too.
    const put = async (name: string, value: number) =>
      (await call('PUT', `/api/settings/${name}`, { value })).statusCode;
    expect(await put('ticketMaxAcceptanceCriteria', 40)).toBe(200);
    expect(await put('acceptanceCriterionMaxLength', 501)).toBe(409);
    expect(await put('ticketMaxAcceptanceCriteria', 10)).toBe(200);
    expect(await put('acceptanceCriterionMaxLength', 2000)).toBe(200);
    const reset = await call('DELETE', '/api/settings/ticketMaxAcceptanceCriteria');
    expect(reset.statusCode, reset.body).toBe(409);
    expect(ApiError.parse(reset.json()).error.settingProduct).toMatchObject({
      firstValue: 20,
      secondValue: 2000,
    });
    const [stored] = await t.db
      .select()
      .from(schema.settingValues)
      .where(eq(schema.settingValues.name, 'ticketMaxAcceptanceCriteria'));
    expect(stored?.value).toBe(10);
  });
});

describe('the dispatch acknowledgement (07, section 2)', () => {
  // 5 seconds of "Machine answer timeout" last 100 ms.
  const fast = { settings: { dispatchAckTimeoutSeconds: 5 }, daemonSecondMs: 20 };

  it('cancels a run not acknowledged in time, without counting an attempt', async () => {
    await start(fast);
    const { daemon } = await laptop();
    const response = await runNow();
    expect(response.statusCode).toBe(201);
    const { id } = Run.parse(response.json());
    await daemon.find((message) => message.type === 'run.start', 'run.start');

    await eventually('the run cancelled', async () => {
      expect((await run(id)).status).toBe('cancelled');
    });
    expect(await run(id)).toMatchObject({ failureReason: 'cancelled' });
    const detail = await ticket();
    expect(detail).toMatchObject({ status: 'todo', attemptCount: 0 });
    expect(comments(detail)).toEqual([
      'The run was cancelled: machine Laptop did not confirm the start in time. It does not count as a failed attempt.',
    ]);
    const change = (await eventTypes('run.status_changed')).at(-1);
    expect(change?.payload).toMatchObject({ to: 'cancelled', cause: 'dispatch_timeout' });
    // A late start on the daemon is stopped.
    await daemon.find(
      (message) => message.type === 'run.stop' && message.payload.runId === id,
      'run.stop',
    );
  });

  it('keeps the deadline across a server restart', async () => {
    await start(fast);
    const { daemon } = await laptop();
    const { id } = Run.parse((await runNow()).json());
    await daemon.find((message) => message.type === 'run.start', 'run.start');
    await t.restart();
    await eventually('the run cancelled after the restart', async () => {
      expect((await run(id)).status).toBe('cancelled');
    });
    expect((await ticket()).status).toBe('todo');
  });

  it('puts a resume not acknowledged in time back to paused, without counting an attempt', async () => {
    await start(fast);
    const { daemon } = await laptop();
    const { run: created } = await started(daemon);
    await working(daemon, created.id);
    await report(daemon, suspected(created.id));
    const resumed = await call('POST', `/api/runs/${created.id}/resume`);
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(Run.parse(resumed.json()).status).toBe('dispatched');
    await eventually('the run paused again', async () => {
      expect((await run(created.id)).status).toBe('paused_quota');
    });
    expect(await run(created.id)).toMatchObject({ pauseReason: 'suspected_usage_limit' });
    expect(await ticket()).toMatchObject({ status: 'in_progress', attemptCount: 0 });
  });
});

function suspected(runId: string) {
  return {
    type: 'run.quota_limited' as const,
    id: randomUUID(),
    payload: {
      runId,
      kind: 'suspected' as const,
      evidence: {
        signal: 'stop_failure' as const,
        error: 'overloaded' as const,
        message: 'API Error: overloaded',
        statusLine: null,
      },
    },
  };
}

function detected(runId: string, resetsAt: string | null) {
  return {
    type: 'run.quota_limited' as const,
    id: randomUUID(),
    payload: {
      runId,
      kind: 'detected' as const,
      resetsAt,
      evidence: {
        signal: 'stop_failure' as const,
        error: 'rate_limit' as const,
        message: "You've hit your session limit · resets 3:45pm",
        statusLine: null,
      },
    },
  };
}

describe('the run reported by the daemon (05, section 4.7)', () => {
  it('goes through to succeeded, with the branch and commits on the ticket, and handles a duplicate once', async () => {
    await start();
    const { id: machineId, daemon } = await laptop();
    const { run: created } = await started(daemon);
    await working(daemon, created.id);
    expect(await run(created.id)).toMatchObject({ status: 'running', sessionAlive: true });
    expect(await report(daemon, state(created.id, { state: 'idle' }))).toEqual({ ok: true });

    const end = state(created.id, { state: 'ended', reason: 'submitted', branch: branch() });
    expect(await report(daemon, end)).toEqual({ ok: true });
    const events = (await eventTypes('run.status_changed')).length;
    // The same report again: acknowledged, and nothing changes (05, section 3.3).
    expect(await report(daemon, end)).toEqual({ ok: true });
    expect((await eventTypes('run.status_changed')).length).toBe(events);

    expect(await run(created.id)).toMatchObject({
      status: 'succeeded',
      endReason: 'submitted',
      failureReason: null,
      branch: { name: 't/1-contact-form', head: HEAD, commits: COMMITS },
    });
    expect(await ticket()).toMatchObject({
      status: 'in_review',
      attemptCount: 0,
      branch: {
        name: 't/1-contact-form',
        machine: { id: machineId, name: 'Laptop' },
        head: HEAD,
        commits: COMMITS,
      },
    });
    expect(
      (await eventTypes('run.status_changed')).map(({ payload }) => [
        (payload as { from: string }).from,
        (payload as { to: string }).to,
      ]),
    ).toEqual([
      ['queued', 'dispatched'],
      ['dispatched', 'starting'],
      ['starting', 'running'],
      ['running', 'succeeded'],
    ]);
  });

  it('fails a run with a counted attempt and its comment; the next attempt continues the earlier commits', async () => {
    await start();
    const { daemon } = await laptop();
    const { run: first } = await started(daemon);
    await working(daemon, first.id);
    await report(
      daemon,
      state(first.id, { state: 'ended', reason: 'idle_timeout', branch: branch() }),
    );
    expect(await run(first.id)).toMatchObject({ status: 'failed', failureReason: 'timeout' });
    const detail = await ticket();
    expect(detail).toMatchObject({ status: 'todo', attemptCount: 1 });
    expect(comments(detail)).toEqual([
      'Attempt 1 failed on machine Laptop: it ran out of time. It counts as a failed attempt. The branch t/1-contact-form is kept on that machine.',
    ]);

    const { start: second } = await started(daemon);
    expect(second.payload.initialPrompt).toContain('This is attempt 2 at this ticket.');
    expect(second.payload.initialPrompt).toContain(
      "The ticket's branch already has commits from an earlier attempt.",
    );
    expect(second.payload.initialPrompt).toContain('`git log origin/main..HEAD`');
    // The failure's comment is part of the ticket the agent reads.
    expect(second.payload.initialPrompt).toContain('Attempt 1 failed on machine Laptop');
  });

  it("fails the start when the daemon's Claude Code is too old, marking the machine unusable, not counted", async () => {
    await start();
    const { id: machineId, daemon } = await laptop();
    const { run: created } = await started(daemon);
    await report(daemon, state(created.id, { state: 'preparing' }));
    await report(daemon, state(created.id, { state: 'starting', claudeCodeVersion: '2.1.100' }));
    expect(await run(created.id)).toMatchObject({
      status: 'failed',
      failureReason: 'claude_code_unsupported',
    });
    expect(await ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });
    await daemon.find((message) => message.type === 'run.stop', 'run.stop');
    const [machine] = await t.db
      .select()
      .from(schema.machines)
      .where(eq(schema.machines.id, machineId));
    expect(machine).toMatchObject({ claudeCodeVersion: '2.1.100' });
    expect(machine?.claudeCodeUnsupportedSince).not.toBeNull();
    expect(
      (await eventTypes('machine.claude_code_unsupported')).map(({ payload }) => payload),
    ).toEqual([{ name: 'Laptop', version: '2.1.100', minimum: '2.1.280' }]);
    const refused = await refusal();
    expect(refused.reason).toBe('no_machine');
    // Its own end report adds nothing more.
    expect(
      await report(
        daemon,
        state(created.id, { state: 'ended', reason: 'claude_code_unsupported' }),
      ),
    ).toEqual({ ok: true });
    expect((await ticket()).attemptCount).toBe(0);
  });

  it('fails a run whose process scope was refused with machine_problem, not counted', async () => {
    await start();
    const { daemon } = await laptop();
    const { run: created } = await started(daemon);
    await working(daemon, created.id);
    expect(
      await report(
        daemon,
        state(created.id, {
          state: 'ended',
          reason: 'process_scope_failed',
          detail: "Claude Code could not be started in the run's process scope (Access denied)",
        }),
      ),
    ).toEqual({ ok: true });
    expect(await run(created.id)).toMatchObject({
      status: 'failed',
      failureReason: 'machine_problem',
    });
    const detail = await ticket();
    expect(detail).toMatchObject({ status: 'todo', attemptCount: 0 });
    expect(comments(detail)).toEqual([
      "The run on machine Laptop ended: its machine could not start Claude Code in a process scope (Claude Code could not be started in the run's process scope (Access denied)). It does not count as a failed attempt.",
    ]);
  });

  it('fails a run whose push at its submission failed with push_failed, not counted (lot 3 step F)', async () => {
    await start();
    const { daemon } = await laptop();
    const { run: created } = await started(daemon);
    await working(daemon, created.id);
    expect(
      await report(daemon, state(created.id, { state: 'ended', reason: 'push_failed' })),
    ).toEqual({ ok: true });
    expect(await run(created.id)).toMatchObject({
      status: 'failed',
      failureReason: 'push_failed',
    });
    const detail = await ticket();
    expect(detail).toMatchObject({ status: 'todo', attemptCount: 0 });
    expect(comments(detail)).toEqual([
      'The run on machine Laptop ended: its branch could not be pushed to GitHub. It does not count as a failed attempt.',
    ]);
  });
});

describe('Stop run (04, section 2)', () => {
  it('cancels at once without counting, revokes the run token, then stops the session', async () => {
    await start();
    const { daemon, token } = await laptop();
    const { run: created, start: message } = await started(daemon);
    await working(daemon, created.id);
    // Valid while the run is active (step K answers the tools), refused once it is stopped.
    const call1 = await mcp(daemon, message.payload.runToken);
    expect(call1.ok).toBe(true);

    const stopped = await call('POST', `/api/runs/${created.id}/stop`);
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(Run.parse(stopped.json())).toMatchObject({
      status: 'cancelled',
      failureReason: 'cancelled',
    });
    const detail = await ticket();
    expect(detail).toMatchObject({ status: 'todo', attemptCount: 0 });
    expect(comments(detail)).toEqual([
      'Run stopped by the owner. The branch t/1-contact-form is kept on machine Laptop. It does not count as a failed attempt.',
    ]);
    await daemon.find(
      (received) =>
        received.type === 'run.stop' &&
        received.payload.runId === created.id &&
        received.payload.reason === 'owner_stopped',
      'run.stop',
    );

    // An MCP call from that session after Stop run is refused (06, section 2).
    const after = await mcp(daemon, message.payload.runToken);
    expect(after.ok ? null : after.error.code).toBe('FORBIDDEN');
    expect((await call('POST', `/api/runs/${created.id}/stop`)).statusCode).toBe(409);

    // The daemon's later end report only adds the branch.
    await report(
      daemon,
      state(created.id, { state: 'ended', reason: 'stopped', branch: branch() }),
    );
    expect(await run(created.id)).toMatchObject({
      status: 'cancelled',
      branch: { head: HEAD, commits: COMMITS },
    });

    // A session whose end was never reported is stopped at the next hello (05, section 6).
    await daemon.close();
    const again = await connect(token, {
      runs: [{ runId: created.id, state: 'working', claudeSessionId: SESSION }],
    });
    await again.find(
      (received) =>
        received.type === 'run.stop' &&
        received.payload.runId === created.id &&
        received.payload.reason === 'not_active',
      'run.stop at hello',
    );
  });

  it('fails the run with machine_offline when its machine is offline, not counted', async () => {
    await start();
    const { id: machineId, daemon } = await laptop();
    const { run: created } = await started(daemon);
    await working(daemon, created.id);
    await daemon.close();
    await eventually('machine offline with its run in Needs you', async () => {
      const items = NeedsYouResponse.parse((await call('GET', '/api/needs-you')).json()).items;
      expect(items).toContainEqual(
        expect.objectContaining({
          type: 'machine_offline_with_runs',
          machine: { id: machineId, name: 'Laptop' },
          tickets: ['WEB-1'],
        }),
      );
    });
    expect((await run(created.id)).machine.online).toBe(false);

    const stopped = await call('POST', `/api/runs/${created.id}/stop`);
    expect(Run.parse(stopped.json())).toMatchObject({
      status: 'failed',
      failureReason: 'machine_offline',
    });
    expect(await ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });
    const items = NeedsYouResponse.parse((await call('GET', '/api/needs-you')).json()).items;
    expect(items.some((item) => item.type === 'machine_offline_with_runs')).toBe(false);
  });

  it('cancels the active run when the ticket is cancelled or marked as done', async () => {
    await start();
    const { daemon } = await laptop();
    const { run: first } = await started(daemon);
    expect((await call('POST', '/api/projects/WEB/tickets/1/cancel')).statusCode).toBe(200);
    expect(await run(first.id)).toMatchObject({ status: 'cancelled', failureReason: 'cancelled' });
    await daemon.find(
      (message) => message.type === 'run.stop' && message.payload.reason === 'ticket_cancelled',
      'run.stop',
    );

    await createTicket({ title: 'Second' });
    const { run: second } = await started(daemon, 2);
    const done = await call('POST', '/api/projects/WEB/tickets/2/mark-done', {
      comment: 'Done by hand',
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(await run(second.id)).toMatchObject({ status: 'cancelled' });
    expect((await ticket(2)).status).toBe('done');
  });
});

describe('revoking a machine (01, section 3.8)', () => {
  it('fails its active runs with machine_revoked, not counted', async () => {
    await start();
    const { id, daemon } = await laptop();
    const { run: created } = await started(daemon);
    await working(daemon, created.id);
    expect((await call('POST', `/api/machines/${id}/revoke`)).statusCode).toBe(200);
    expect(await run(created.id)).toMatchObject({
      status: 'failed',
      failureReason: 'machine_revoked',
    });
    const detail = await ticket();
    expect(detail).toMatchObject({ status: 'todo', attemptCount: 0 });
    expect(comments(detail).at(-1)).toBe(
      'The run on machine Laptop ended: its machine was revoked. It does not count as a failed attempt.',
    );
  });

  it('runs on the machine holding the commits, and says the work is lost when that machine was revoked', async () => {
    await start();
    const { id, account, daemon } = await laptop();
    const { run: first } = await started(daemon);
    const other = await connectedMachine('Desk', account.id);
    await working(daemon, first.id);
    await report(daemon, state(first.id, { state: 'ended', reason: 'crashed', branch: branch() }));

    // The commits are on Laptop: only Laptop can continue.
    expect((await call('POST', `/api/machines/${id}/disable`)).statusCode).toBe(200);
    expect(await refusal()).toEqual({
      reason: 'machine_unavailable',
      machine: { id, name: 'Laptop' },
      commits: 2,
      unavailable: { why: 'disabled' },
    });

    expect((await call('POST', `/api/machines/${id}/revoke`)).statusCode).toBe(200);
    const { run: second, start: message } = await started(other.daemon);
    expect(second.machine.name).toBe('Desk');
    expect(message.payload.initialPrompt).not.toContain('earlier attempt.');
    const lost =
      'The earlier work on machine Laptop is no longer available: that machine was revoked, and the 2 commits of the branch t/1-contact-form on it are lost. This run starts again from the base branch on machine Desk.';
    expect(comments(await ticket())).toContain(lost);

    // Said once: a later run does not repeat it.
    await call('POST', `/api/runs/${second.id}/stop`);
    await started(other.daemon);
    expect(comments(await ticket()).filter((body) => body === lost)).toHaveLength(1);
  });
});

const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const ONE = { hash: C1, subject: 'Add the contact form' };
const TWO = { hash: C2, subject: 'Test the e-mail check' };
/** The branch with its first commit, then with a second one on top. */
const first = { name: 't/1-contact-form', head: C1, commitsAhead: [ONE] };
const second = { name: 't/1-contact-form', head: C2, commitsAhead: [TWO, ONE] };
const BRANCH_URL = 'https://github.com/octo-owner/bakery/tree/t/1-contact-form';

/** The report as a protocol 2 daemon sends it: `listed` are its commits not on GitHub. */
function told(branch: Reported, ...listed: string[]): Reported {
  return { ...branch, notOnGitHub: { listed, count: listed.length } };
}

/** A `ticket_submit` with the daemon's facts: its push made before the call (05, section 4.9). */
async function submit(
  daemon: ScriptedDaemon,
  runToken: string,
  workspace: { branch: Reported; push: PushResult | null },
  status: 'met' | 'not_met' = 'met',
): Promise<McpResult['payload']> {
  const answer: ServerMessage = await daemon.request({
    type: 'mcp.call',
    id: randomUUID(),
    payload: {
      tool: 'ticket_submit',
      runToken,
      input: {
        criteria: [{ index: 0, status, justification: 'Checked by its test' }],
        tests: { paths: ['src/contact.test.ts'], justification: null },
        docs: { paths: [], justification: 'Nothing user-facing' },
        adrs: [],
        summary: 'The contact form is done',
      },
      workspace: {
        clean: true,
        changedFiles: null,
        push: workspace.push,
        branch: { notOnGitHub: null, ...workspace.branch },
      },
    },
  });
  if (answer.type !== 'mcp.result') throw new Error(`unexpected ${answer.type}`);
  return answer.payload;
}

/** A run of the ticket on `daemon` that ends `crashed` with this branch and end push. */
async function crashed(
  daemon: ScriptedDaemon,
  reported: Reported,
  push: PushResult | null,
): Promise<Run> {
  const { run: created } = await started(daemon);
  await working(daemon, created.id);
  await report(
    daemon,
    state(created.id, { state: 'ended', reason: 'crashed', branch: reported, push }),
  );
  return run(created.id);
}

describe('where the ticket branch is (07, section 3; lot 3 step D3)', () => {
  it('no commits: nothing reported or pushed yet', async () => {
    await start();
    const { daemon } = await laptop();
    expect((await ticket()).branch).toBeNull();
    await started(daemon);
    expect((await ticket()).branch).toEqual({
      name: 't/1-contact-form',
      where: 'no_commits',
      machine: null,
      head: null,
      commits: [],
      notOnGitHub: [],
      notOnGitHubCount: 0,
      pushed: null,
      pushFailure: null,
    });
  });

  it('only on a machine, as tickets left by 0.3.0 read: Run now needs that machine', async () => {
    await start();
    const { id, account, daemon } = await laptop();
    // A protocol 1 end report has no push field: nothing was pushed.
    const { run: created } = await started(daemon);
    await connectedMachine('Desk', account.id);
    await working(daemon, created.id);
    const end = state(created.id, { state: 'ended', reason: 'crashed', branch: second });
    if (end.payload.state !== 'ended') throw new Error('not an end');
    const protocol1: Record<string, unknown> = { ...end.payload };
    delete protocol1.push;
    await report(daemon, { ...end, payload: protocol1 } as RunState);

    expect((await ticket()).branch).toMatchObject({
      where: 'machine',
      machine: { id, name: 'Laptop' },
      head: C2,
      commits: [TWO, ONE],
      notOnGitHub: [C2, C1],
      pushed: null,
      pushFailure: null,
    });
    expect((await run(created.id)).push).toBeNull();
    expect(comments(await ticket()).at(-1)).toContain(
      'The branch t/1-contact-form is kept on that machine.',
    );
    expect((await call('POST', `/api/machines/${id}/disable`)).statusCode).toBe(200);
    expect(await refusal()).toEqual({
      reason: 'machine_unavailable',
      machine: { id, name: 'Laptop' },
      commits: 2,
      unavailable: { why: 'disabled' },
    });
    expect((await call('POST', `/api/machines/${id}/enable`)).statusCode).toBe(200);
    expect((await started(daemon)).run.machine.name).toBe('Laptop');
  });

  it('only on a machine after a failed push, with the failure shown', async () => {
    await start();
    const { id, daemon } = await laptop();
    const ended = await crashed(daemon, told(second, C2, C1), {
      status: 'failed',
      reason: 'unreachable',
      message: 'Could not resolve host: github.com',
    });
    const detail = await ticket();
    expect(detail.branch).toMatchObject({
      where: 'machine',
      notOnGitHub: [C2, C1],
      pushed: null,
      pushFailure: {
        machine: { id, name: 'Laptop' },
        reason: 'unreachable',
        message: 'Could not resolve host: github.com',
      },
    });
    expect(ended.push).toMatchObject({ result: { status: 'failed', reason: 'unreachable' } });
    expect(comments(detail).at(-1)).toContain(
      'The branch t/1-contact-form is kept on that machine.',
    );
    expect((await eventTypes('run.branch_push_failed')).map(({ payload }) => payload)).toEqual([
      {
        project: 'WEB',
        ticket: 'WEB-1',
        machine: 'Laptop',
        branch: 't/1-contact-form',
        at: 'end',
        reason: 'unreachable',
        message: 'Could not resolve host: github.com',
      },
    ]);
  });

  it('pushed: shown with its date, and Run now takes the branch from GitHub on another machine', async () => {
    await start();
    const { id, account, daemon } = await laptop();
    // Read again after the push: nothing is left only on Laptop.
    const ended = await crashed(daemon, told(second), { status: 'pushed', head: C2 });
    const desk = await connectedMachine('Desk', account.id);
    const detail = await ticket();
    expect(detail.branch).toMatchObject({
      where: 'github',
      machine: { id, name: 'Laptop' },
      commits: [TWO, ONE],
      notOnGitHub: [],
      pushed: { head: C2, machine: { id, name: 'Laptop' }, url: BRANCH_URL },
      pushFailure: null,
    });
    expect(Date.parse(detail.branch?.pushed?.at ?? '')).toBeLessThanOrEqual(Date.now());
    expect(ended.push).toMatchObject({ result: { status: 'pushed', head: C2 } });
    expect(comments(detail).at(-1)).toContain(
      'Every commit of the branch t/1-contact-form was on GitHub when the run ended.',
    );
    expect((await eventTypes('run.branch_pushed')).map(({ payload }) => payload)).toEqual([
      {
        project: 'WEB',
        ticket: 'WEB-1',
        machine: 'Laptop',
        branch: 't/1-contact-form',
        at: 'end',
        head: C2,
      },
    ]);

    // Laptop cannot take the run: Desk takes it, and continues the pushed commits.
    expect((await call('POST', `/api/machines/${id}/disable`)).statusCode).toBe(200);
    const { run: next, start: message } = await started(desk.daemon);
    expect(next.machine.name).toBe('Desk');
    expect(message.payload.repository.ticketBranch).toBe('t/1-contact-form');
    expect(message.payload.initialPrompt).toContain(
      "The ticket's branch already has commits from an earlier attempt.",
    );
  });

  it('part pushed: a commit made after an accepted submission stays on the machine', async () => {
    await start();
    const { id, account, daemon } = await laptop();
    const { run: created, start: message } = await started(daemon);
    await connectedMachine('Desk', account.id);
    await working(daemon, created.id);
    const { runToken } = message.payload;
    expect(
      await submit(daemon, runToken, {
        branch: told(first, C1),
        push: { status: 'pushed', head: C1 },
      }),
    ).toMatchObject({ ok: true });
    // Known before the run's end.
    expect((await ticket()).branch).toMatchObject({
      where: 'github',
      pushed: { head: C1 },
    });
    expect((await eventTypes('run.branch_pushed')).map(({ payload }) => payload)).toMatchObject([
      { at: 'submission', head: C1 },
    ]);
    // The agent committed again in the same turn; an accepted submission has no end push.
    await report(
      daemon,
      state(created.id, { state: 'ended', reason: 'submitted', branch: told(second, C2) }),
    );
    const detail = await ticket();
    expect(detail).toMatchObject({ status: 'in_review' });
    expect(detail.branch).toMatchObject({
      where: 'machine_ahead',
      machine: { id, name: 'Laptop' },
      commits: [TWO, ONE],
      notOnGitHub: [C2],
      pushed: { head: C1, machine: { id, name: 'Laptop' } },
      pushFailure: null,
    });

    const changes = await call('POST', '/api/projects/WEB/tickets/1/request-changes', {
      comment: 'Keep the newer commit',
    });
    expect(changes.statusCode, changes.body).toBe(200);
    expect((await call('POST', `/api/machines/${id}/disable`)).statusCode).toBe(200);
    expect(await refusal()).toEqual({
      reason: 'machine_unavailable',
      machine: { id, name: 'Laptop' },
      commits: 1,
      unavailable: { why: 'disabled' },
    });
  });

  it("diverged: the push refused because GitHub's branch has other commits; Run now needs the machine", async () => {
    await start();
    const { id, account, daemon } = await laptop();
    await crashed(daemon, told(first), { status: 'pushed', head: C1 });
    await connectedMachine('Desk', account.id);
    await crashed(daemon, told(second, C2), {
      status: 'failed',
      reason: 'diverged',
      message: 'GitHub has commits this branch does not have',
    });
    expect((await ticket()).branch).toMatchObject({
      where: 'diverged',
      notOnGitHub: [C2],
      pushed: { head: C1 },
      pushFailure: { reason: 'diverged', machine: { id, name: 'Laptop' } },
    });
    expect((await call('POST', `/api/machines/${id}/disable`)).statusCode).toBe(200);
    expect(await refusal()).toEqual({
      reason: 'machine_unavailable',
      machine: { id, name: 'Laptop' },
      commits: 1,
      unavailable: { why: 'disabled' },
    });

    // A later push done clears the failure.
    expect((await call('POST', `/api/machines/${id}/enable`)).statusCode).toBe(200);
    await crashed(daemon, told(second), { status: 'pushed', head: C2 });
    expect((await ticket()).branch).toMatchObject({
      where: 'github',
      notOnGitHub: [],
      pushed: { head: C2 },
      pushFailure: null,
    });
  });

  it('records the push made before a submission the server refuses', async () => {
    await start();
    const { daemon } = await laptop();
    const { run: created, start: message } = await started(daemon);
    await working(daemon, created.id);
    const answer = await submit(
      daemon,
      message.payload.runToken,
      { branch: told(first, C1), push: { status: 'pushed', head: C1 } },
      'not_met',
    );
    expect(answer).toMatchObject({ ok: false, error: { code: 'DOD_FAILED' } });
    expect((await ticket()).branch).toMatchObject({ where: 'github', pushed: { head: C1 } });
    expect((await run(created.id)).push).toMatchObject({
      result: { status: 'pushed', head: C1 },
    });
  });

  it('a revoked machine loses only its commits not on GitHub; the run starts from GitHub', async () => {
    await start();
    const { id, account, daemon } = await laptop();
    await crashed(daemon, told(first), { status: 'pushed', head: C1 });
    const desk = await connectedMachine('Desk', account.id);
    await crashed(daemon, told(second, C2), {
      status: 'failed',
      reason: 'unreachable',
      message: 'Timed out',
    });
    expect((await call('POST', `/api/machines/${id}/revoke`)).statusCode).toBe(200);
    const { run: next, start: message } = await started(desk.daemon);
    expect(next.machine.name).toBe('Desk');
    expect(message.payload.initialPrompt).toContain('from an earlier attempt.');
    expect(comments(await ticket())).toContain(
      'The earlier work on machine Laptop is no longer available: that machine was revoked, and the 1 commit of the branch t/1-contact-form on it not on GitHub is lost. This run starts from the branch as last pushed to GitHub, on machine Desk.',
    );
  });

  // Commits that came from GitHub itself (owner's cases, review of lot 3 step D3).
  const M = { hash: 'd'.repeat(40), subject: 'Merge branch main into t/1-contact-form' };
  /** The branch after GitHub's Update branch: a merge commit on top of the pushed one. */
  const updated = { name: 't/1-contact-form', head: M.hash, commitsAhead: [M, ONE] };

  it("a. a run that only took GitHub's Update branch leaves nothing on its machine", async () => {
    await start();
    const { id, account, daemon } = await laptop();
    await crashed(daemon, told(first), { status: 'pushed', head: C1 });
    await connectedMachine('Desk', account.id);
    // Preparation fast-forwarded to GitHub's branch; no new commit, so nothing to push. The
    // merge commit M came from GitHub, and the machine says so.
    await crashed(daemon, told(updated), null);
    expect((await ticket()).branch).toMatchObject({
      where: 'github',
      machine: { id, name: 'Laptop' },
      commits: [M, ONE],
      notOnGitHub: [],
      notOnGitHubCount: 0,
      pushed: { head: C1 },
    });
    expect((await call('POST', `/api/machines/${id}/disable`)).statusCode).toBe(200);
    expect((await runNow()).statusCode).toBe(201);
  });

  it("b. a review run reporting GitHub's head after Update branch makes its machine hold nothing", async () => {
    await start();
    const { account, daemon } = await laptop();
    await crashed(daemon, told(first), { status: 'pushed', head: C1 });
    const desk = await connectedMachine('Desk', account.id);
    // Even a review report without the list (or with a wrong one) changes nothing.
    await reviewed(desk.id, desk.daemon, updated);
    expect((await ticket()).branch).toMatchObject({
      where: 'github',
      machine: { name: 'Laptop' },
      commits: [ONE],
      notOnGitHub: [],
    });
    expect((await call('POST', `/api/machines/${desk.id}/disable`)).statusCode).toBe(200);
    expect((await runNow()).statusCode).toBe(201);
  });

  it('b. a review run on another machine leaves the commits the first one holds where they are', async () => {
    await start();
    const { id, account, daemon } = await laptop();
    // C1 pushed at the submission, then C2 committed in the same turn: Laptop holds C2.
    const { run: created, start: message } = await started(daemon);
    await working(daemon, created.id);
    await submit(daemon, message.payload.runToken, {
      branch: told(first, C1),
      push: { status: 'pushed', head: C1 },
    });
    await report(
      daemon,
      state(created.id, { state: 'ended', reason: 'submitted', branch: told(second, C2) }),
    );
    const desk = await connectedMachine('Desk', account.id);
    // The review on Desk reports GitHub's head, C1, all on GitHub.
    await reviewed(desk.id, desk.daemon, told(first));
    expect((await ticket()).branch).toMatchObject({
      where: 'machine_ahead',
      machine: { id, name: 'Laptop' },
      notOnGitHub: [C2],
    });
    const changes = await call('POST', '/api/projects/WEB/tickets/1/request-changes', {
      comment: 'Keep the newer commit',
    });
    expect(changes.statusCode, changes.body).toBe(200);
    expect((await call('POST', `/api/machines/${id}/disable`)).statusCode).toBe(200);
    expect(await refusal()).toMatchObject({ reason: 'machine_unavailable', commits: 1 });
  });

  it(`counts the commits beyond the report's ceiling (${String(BRANCH_REPORT_MAX_COMMITS)}) as not on GitHub`, async () => {
    await start();
    const { id, account, daemon } = await laptop();
    const many = Array.from({ length: BRANCH_REPORT_MAX_COMMITS }, (_, index) => ({
      hash: index.toString(16).padStart(40, 'e'),
      subject: `Commit ${String(index)}`,
    }));
    const full = { name: 't/1-contact-form', head: many[0]?.hash ?? '', commitsAhead: many };
    // At the ceiling, every commit listed and on GitHub: nothing held.
    await crashed(daemon, told(full), null);
    await connectedMachine('Desk', account.id);
    expect((await ticket()).branch).toMatchObject({ where: 'github', notOnGitHubCount: 0 });
    // One more, older, beyond the ceiling and not on GitHub: the server is not told which, so
    // it counts as not on GitHub, on Laptop.
    await crashed(daemon, { ...full, notOnGitHub: { listed: [], count: 1 } }, null);
    expect((await ticket()).branch).toMatchObject({
      where: 'machine_ahead',
      machine: { id, name: 'Laptop' },
      notOnGitHub: [],
      notOnGitHubCount: 1,
    });
    expect((await call('POST', `/api/machines/${id}/disable`)).statusCode).toBe(200);
    expect(await refusal()).toMatchObject({ reason: 'machine_unavailable', commits: 1 });
  });
});

/**
 * A review run of ticket 1 on the machine, stopped by the owner, whose end report then gives the
 * branch it reviewed: GitHub's head as fetched (05, section 4.2). The server starts no review
 * before step H, so the run is written here.
 */
async function reviewed(machineId: string, daemon: ScriptedDaemon, reviewedBranch: Reported) {
  const [model] = await t.db
    .select()
    .from(schema.runs)
    .orderBy(desc(schema.runs.createdAt))
    .limit(1);
  if (!model) throw new Error('no run to copy');
  const now = new Date();
  const [review] = await t.db
    .insert(schema.runs)
    .values({
      ...model,
      id: randomUUID(),
      purpose: 'review',
      machineId,
      status: 'cancelled',
      failureReason: 'cancelled',
      runTokenHash: randomUUID(),
      dispatchMessageId: null,
      branchHead: null,
      commits: null,
      push: null,
      pushAt: null,
      stopSentAt: now,
      endReportedAt: null,
      createdAt: now,
      updatedAt: now,
      statusSince: now,
    })
    .returning();
  if (!review) throw new Error('review run not written');
  await report(
    daemon,
    state(review.id, { state: 'ended', reason: 'stopped', branch: reviewedBranch }),
  );
}

async function mcp(daemon: ScriptedDaemon, runToken: string): Promise<McpResult['payload']> {
  const answer: ServerMessage = await daemon.request({
    type: 'mcp.call',
    id: randomUUID(),
    payload: { tool: 'ticket_get', runToken, input: {} },
  });
  if (answer.type !== 'mcp.result') throw new Error(`unexpected ${answer.type}`);
  return answer.payload;
}

describe('Git credentials (05, section 7)', () => {
  it("gives the token only for a fetch of the run's own repository while the run is active", async () => {
    await start();
    const { daemon } = await laptop();
    const { run: created } = await started(daemon);
    const ask = async (runId: string, owner = 'octo-owner', name = 'bakery') => {
      const answer = await daemon.request({
        type: 'git.credential_request',
        id: randomUUID(),
        payload: { runId, repository: { owner, name }, command: 'fetch' },
      });
      if (answer.type !== 'git.credential') throw new Error(`unexpected ${answer.type}`);
      return answer.payload;
    };
    expect(await ask(created.id)).toEqual({
      ok: true,
      username: 'x-access-token',
      password: TOKEN,
    });
    expect(await ask(created.id, 'Octo-Owner', 'Bakery')).toMatchObject({ ok: true });
    expect(await ask(created.id, 'octo-owner', 'notes')).toEqual({
      ok: false,
      message: "not the run's repository",
    });
    expect(await ask(randomUUID())).toEqual({ ok: false, message: 'unknown run' });
    await call('POST', `/api/runs/${created.id}/stop`);
    expect(await ask(created.id)).toEqual({ ok: false, message: 'the run is cancelled' });
    expect(t.logs.text).not.toContain(TOKEN);
  });

  it('gives a push credential only to a running run of the asking machine, never a review', async () => {
    await start();
    const { daemon, account } = await laptop();
    const { run: created } = await started(daemon);
    // Connected once the run is on the laptop, so Run now could not choose it.
    const { daemon: other } = await connectedMachine('Desktop', account.id);
    const ask = async (
      from: ScriptedDaemon,
      runId: string,
      owner = 'octo-owner',
      name = 'bakery',
    ) => {
      const answer = await from.request({
        type: 'git.credential_request',
        id: randomUUID(),
        payload: { runId, repository: { owner, name }, command: 'push' },
      });
      if (answer.type !== 'git.credential') throw new Error(`unexpected ${answer.type}`);
      return answer.payload;
    };
    // Dispatched, not running yet: a fetch only.
    expect(await ask(daemon, created.id)).toEqual({ ok: false, message: 'the run is dispatched' });
    await working(daemon, created.id);
    expect(await ask(daemon, created.id)).toEqual({
      ok: true,
      username: 'x-access-token',
      password: TOKEN,
    });
    expect(await ask(other, created.id)).toEqual({ ok: false, message: 'unknown run' });
    expect(await ask(daemon, created.id, 'octo-owner', 'notes')).toEqual({
      ok: false,
      message: "not the run's repository",
    });
    await t.db.update(schema.runs).set({ purpose: 'review' }).where(eq(schema.runs.id, created.id));
    expect(await ask(daemon, created.id)).toEqual({
      ok: false,
      message: 'a review run never pushes',
    });
    await t.db
      .update(schema.runs)
      .set({ purpose: 'implement' })
      .where(eq(schema.runs.id, created.id));
    await report(daemon, state(created.id, { state: 'ended', reason: 'gave_up' }));
    expect(await ask(daemon, created.id)).toEqual({ ok: false, message: 'the run is failed' });
    expect(t.logs.text).not.toContain(TOKEN);
  });
});

describe('the push credential of an ending run (05, section 7; lot 3 step D2)', () => {
  const pushAsk = async (
    from: ScriptedDaemon,
    runId: string,
    owner = 'octo-owner',
    name = 'bakery',
  ) => {
    const answer = await from.request({
      type: 'git.credential_request',
      id: randomUUID(),
      payload: { runId, repository: { owner, name }, command: 'push' },
    });
    if (answer.type !== 'git.credential') throw new Error(`unexpected ${answer.type}`);
    return answer.payload;
  };
  const granted = { ok: true, username: 'x-access-token', password: TOKEN };
  const stoppedSecondsAgo = (runId: string, seconds: number) =>
    t.db
      .update(schema.runs)
      .set({ stopSentAt: new Date(Date.now() - seconds * 1000) })
      .where(eq(schema.runs.id, runId));

  it('gives it after Stop run until the end is reported, within MCP call timeout plus Longest push', async () => {
    await start({ settings: { mcpCallTimeoutSeconds: 30, pushTimeoutSeconds: 60 } });
    const { daemon, account } = await laptop();
    const { run: created } = await started(daemon);
    const { daemon: other } = await connectedMachine('Desktop', account.id);
    await working(daemon, created.id);
    expect((await call('POST', `/api/runs/${created.id}/stop`)).statusCode).toBe(200);
    await daemon.find(
      (received) => received.type === 'run.stop' && received.payload.runId === created.id,
      'run.stop',
    );
    expect(await pushAsk(daemon, created.id)).toEqual(granted);
    // Refused to another machine, for another repository, and for a review run.
    expect(await pushAsk(other, created.id)).toEqual({ ok: false, message: 'unknown run' });
    expect(await pushAsk(daemon, created.id, 'octo-owner', 'notes')).toEqual({
      ok: false,
      message: "not the run's repository",
    });
    await t.db.update(schema.runs).set({ purpose: 'review' }).where(eq(schema.runs.id, created.id));
    expect(await pushAsk(daemon, created.id)).toEqual({
      ok: false,
      message: 'a review run never pushes',
    });
    await t.db
      .update(schema.runs)
      .set({ purpose: 'implement' })
      .where(eq(schema.runs.id, created.id));
    // The bound: 30 + 60 seconds after run.stop.
    await stoppedSecondsAgo(created.id, 85);
    expect(await pushAsk(daemon, created.id)).toEqual(granted);
    await stoppedSecondsAgo(created.id, 95);
    expect(await pushAsk(daemon, created.id)).toEqual({
      ok: false,
      message: 'the run was stopped more than 90 seconds ago (MCP call timeout plus Longest push)',
    });
    // Once the end is reported, the run is no longer ending.
    await stoppedSecondsAgo(created.id, 0);
    await report(daemon, state(created.id, { state: 'ended', reason: 'stopped' }));
    expect(await pushAsk(daemon, created.id)).toEqual({
      ok: false,
      message: 'the run is cancelled',
    });
    expect(t.logs.text).not.toContain(TOKEN);
  });

  it('gives it after the ticket is cancelled, never a fetch, and never to a run ended by its daemon', async () => {
    await start();
    const { daemon } = await laptop();
    const { run: first } = await started(daemon);
    await working(daemon, first.id);
    expect((await call('POST', '/api/projects/WEB/tickets/1/cancel')).statusCode).toBe(200);
    await daemon.find(
      (received) => received.type === 'run.stop' && received.payload.reason === 'ticket_cancelled',
      'run.stop',
    );
    expect(await pushAsk(daemon, first.id)).toEqual(granted);
    const fetch = await daemon.request({
      type: 'git.credential_request',
      id: randomUUID(),
      payload: {
        runId: first.id,
        repository: { owner: 'octo-owner', name: 'bakery' },
        command: 'fetch',
      },
    });
    expect(fetch.type === 'git.credential' && fetch.payload).toEqual({
      ok: false,
      message: 'the run is cancelled',
    });

    // A run its daemon ended (gave up) was running until that report: no window after it.
    await createTicket({ title: 'Second' });
    const { run: second } = await started(daemon, 2);
    await working(daemon, second.id);
    await report(daemon, state(second.id, { state: 'ended', reason: 'gave_up' }));
    expect(await pushAsk(daemon, second.id)).toEqual({ ok: false, message: 'the run is failed' });
  });
});

describe('a Git configuration restored at a run end (05, section 7.1; lot 3 step D2)', () => {
  it('writes an event naming what changed, with any credential masked, and nothing else', async () => {
    await start();
    const { daemon } = await laptop();
    const { run: created } = await started(daemon);
    await working(daemon, created.id);
    const changes = `Found changed when the run ended (by this run or an earlier one of the project on this machine), and restored. Settings added, removed: core.hookspath, url.https://x-access-token:${TOKEN}@example.com/.insteadof.`;
    await report(
      daemon,
      state(created.id, { state: 'ended', reason: 'gave_up', gitConfigRestored: changes }),
    );
    const events = await eventTypes('run.git_config_restored');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      project: 'WEB',
      ticket: 'WEB-1',
      machine: 'Laptop',
      repository: 'octo-owner/bakery',
    });
    const written = JSON.stringify(events[0]?.payload);
    expect(written).toContain('core.hookspath');
    expect(written).not.toContain(TOKEN);
    // No "Needs you" item: information only.
    const items = NeedsYouResponse.parse((await call('GET', '/api/needs-you')).json()).items;
    expect(JSON.stringify(items)).not.toContain('hookspath');
  });
});

describe('usage limits (07, section 5.2)', () => {
  it('pauses on a detected limit, marks the account until the reset time, and gates Resume', async () => {
    await start();
    const { daemon } = await laptop();
    const { run: created } = await started(daemon);
    await working(daemon, created.id);
    const resetsAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    expect(await report(daemon, detected(created.id, resetsAt))).toEqual({ ok: true });

    expect(await run(created.id)).toMatchObject({
      status: 'paused_quota',
      pauseReason: 'usage_limit',
    });
    expect(await ticket()).toMatchObject({ status: 'in_progress', attemptCount: 0 });
    const accounts = AccountListResponse.parse((await call('GET', '/api/accounts')).json());
    expect(accounts.accounts[0]).toMatchObject({ state: 'limited', limitedUntil: resetsAt });
    expect((await eventTypes('account.limited')).map(({ payload }) => payload)).toEqual([
      { label: 'Personal', until: resetsAt, source: 'reset_time' },
    ]);

    const refused = await call('POST', `/api/runs/${created.id}/resume`);
    expect(refused.statusCode).toBe(409);
    expect(ApiError.parse(refused.json()).error.runRefusal).toMatchObject({
      reason: 'account_limited',
      until: resetsAt,
    });

    // The reset time has passed: Resume sends the "please continue" message to the same session.
    await t.db.update(schema.claudeAccounts).set({ limitedUntil: new Date(Date.now() - 1000) });
    const resumed = await call('POST', `/api/runs/${created.id}/resume`);
    expect(resumed.statusCode, resumed.body).toBe(200);
    const message = await daemon.find(
      (received) => received.type === 'run.resume' && received.payload.runId === created.id,
      'run.resume',
    );
    if (message.type !== 'run.resume') throw new Error('not run.resume');
    expect(message.payload.claudeSessionId).toBe(SESSION);
    expect(message.payload.message).toContain('Your session was paused on a Claude usage limit');
    daemon.send({ type: 'ack', id: message.id, payload: { ok: true } });
    await report(
      daemon,
      state(created.id, { state: 'starting', claudeCodeVersion: CLAUDE_CODE_VALIDATED_VERSION }),
    );
    await report(daemon, state(created.id, { state: 'working' }));
    expect(await run(created.id)).toMatchObject({ status: 'running', pauseReason: null });
    expect((await eventTypes('account.available')).length).toBe(1);
  });

  it('limits the account for the fallback delay when no reset time is known', async () => {
    await start({ settings: { quotaFallbackDelayMinutes: 90 } });
    const { daemon } = await laptop();
    const { run: created } = await started(daemon);
    await working(daemon, created.id);
    const before = Date.now();
    await report(daemon, detected(created.id, null));
    const [account] = await t.db.select().from(schema.claudeAccounts);
    const until = account?.limitedUntil?.getTime() ?? 0;
    expect(until).toBeGreaterThanOrEqual(before + 90 * 60_000);
    expect(until).toBeLessThan(Date.now() + 90 * 60_000 + 1000);
    expect((await eventTypes('account.limited'))[0]?.payload).toMatchObject({
      source: 'fallback',
      fallbackMinutes: 90,
    });
    // The estimated time gates Resume on the server too, whatever a browser's clock says.
    const refused = await call('POST', `/api/runs/${created.id}/resume`);
    expect(refused.statusCode).toBe(409);
    expect(ApiError.parse(refused.json()).error.runRefusal).toMatchObject({
      reason: 'account_limited',
      until: account?.limitedUntil?.toISOString(),
    });
    expect((await run(created.id)).status).toBe('paused_quota');
  });

  it('pauses on a suspected limit, leaving the account available and resumable at once', async () => {
    await start();
    const { daemon } = await laptop();
    const { run: created } = await started(daemon);
    await working(daemon, created.id);
    await report(daemon, suspected(created.id));
    expect(await run(created.id)).toMatchObject({
      status: 'paused_quota',
      pauseReason: 'suspected_usage_limit',
    });
    const accounts = AccountListResponse.parse((await call('GET', '/api/accounts')).json());
    expect(accounts.accounts[0]).toMatchObject({ state: 'available' });
    expect(await eventTypes('account.limited')).toEqual([]);
    const resumed = await call('POST', `/api/runs/${created.id}/resume`);
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(Run.parse(resumed.json()).status).toBe('dispatched');
  });

  it('refuses Resume when the run is not paused, or its machine cannot take it', async () => {
    await start();
    const { id, daemon } = await laptop();
    const { run: created } = await started(daemon);
    await working(daemon, created.id);
    const notPaused = await call('POST', `/api/runs/${created.id}/resume`);
    expect(ApiError.parse(notPaused.json()).error.runRefusal).toEqual({
      reason: 'run_not_paused',
      status: 'running',
    });
    await report(daemon, suspected(created.id));
    expect((await call('POST', `/api/machines/${id}/disable`)).statusCode).toBe(200);
    const refused = await call('POST', `/api/runs/${created.id}/resume`);
    expect(ApiError.parse(refused.json()).error.runRefusal).toEqual({
      reason: 'machine_unavailable',
      machine: { id, name: 'Laptop' },
      commits: null,
      unavailable: { why: 'disabled' },
    });
    expect((await run(created.id)).status).toBe('paused_quota');
  });
});

describe('the run log (02, section 7)', () => {
  it('stores each entry once, masked and cut to "Longest stored log entry", with the usage estimate', async () => {
    await start({ settings: { logEntryMaxLength: 100 } });
    const { daemon } = await laptop();
    const { run: created } = await started(daemon);
    const events = {
      type: 'run.events' as const,
      id: randomUUID(),
      payload: {
        runId: created.id,
        estimatedUsageUsd: 0.42,
        events: [
          {
            seq: 0,
            at: new Date().toISOString(),
            kind: 'tool_result' as const,
            tool: 'Bash',
            text: `export TOKEN=${TOKEN}`,
          },
          {
            seq: 1,
            at: new Date().toISOString(),
            kind: 'agent_text' as const,
            tool: null,
            text: 'x'.repeat(250),
          },
        ],
      },
    };
    expect(await report(daemon, events)).toEqual({ ok: true });
    // The same positions again (a batch resent after a reconnection) are stored once.
    expect(await report(daemon, { ...events, id: randomUUID() })).toEqual({ ok: true });

    const log = RunLogResponse.parse((await call('GET', `/api/runs/${created.id}/log`)).json());
    expect(log.more).toBe(false);
    expect(log.entries.map(({ seq, text, cut }) => ({ seq, text, cut }))).toEqual([
      { seq: 0, text: 'export TOKEN=[hidden]', cut: false },
      {
        seq: 1,
        text: `${'x'.repeat(100)}\n[… 150 more characters not kept]`,
        cut: true,
      },
    ]);
    const stored = await t.db
      .select()
      .from(schema.runLogEntries)
      .where(and(eq(schema.runLogEntries.runId, created.id)));
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect((await run(created.id)).estimatedUsageUsd).toBe(0.42);
    const after = RunLogResponse.parse(
      (await call('GET', `/api/runs/${created.id}/log?after=0`)).json(),
    );
    expect(after.entries.map((entry) => entry.seq)).toEqual([1]);
  });
});
