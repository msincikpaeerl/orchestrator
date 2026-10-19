import { randomUUID } from 'node:crypto';
import { schema } from '@orchestrator/db';
import {
  AccountDetailResponse,
  AccountListResponse,
  ApiError,
  ClaudeAccount,
  NeedsYouResponse,
  Run,
  TimeZoneResponse,
  type RunStart,
} from '@orchestrator/protocol';
import { asc, eq, like } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { RunHarness, state } from './run-harness.js';

// Claude accounts in lot 4 step C (01, section 3.9; 07, sections 5.3 to 5.5 and 7): the time
// zone, the schedule windows, the daily budget and Stop new runs. Nothing starts by itself yet:
// Run now reads them (owner's answer 5). The application's clock is the test's (`clock`), moved
// by each case: no case waits for a real window or a real day.

let clock = new Date('2026-10-19T10:00:00Z');
const h = new RunHarness();

afterEach(async () => {
  await h.stop();
});

async function start() {
  clock = new Date('2026-10-19T10:00:00Z');
  await h.start({ now: () => clock });
}

async function accounts(): Promise<AccountListResponse> {
  const response = await h.call('GET', '/api/accounts');
  expect(response.statusCode, response.body).toBe(200);
  return AccountListResponse.parse(response.json());
}

async function account(): Promise<ClaudeAccount> {
  const [first] = (await accounts()).accounts;
  if (!first) throw new Error('no account');
  return first;
}

async function patch(id: string, body: object) {
  return h.call('PATCH', `/api/accounts/${id}`, body);
}

async function saveTimeZone(timeZone: string) {
  const response = await h.call('PUT', '/api/time-zone', { timeZone });
  expect(response.statusCode, response.body).toBe(200);
}

async function events(type: string) {
  return h.t.db
    .select()
    .from(schema.events)
    .where(like(schema.events.type, type))
    .orderBy(asc(schema.events.id));
}

/** A run of the account started at `startedAt`, as a run row: `workingMs` and its estimate. */
async function pastRun(
  accountId: string,
  machineId: string,
  startedAt: string,
  fields: { workingMs?: number; estimatedUsageUsd?: number | null } = {},
) {
  const ticket = await h.createTicket({ title: `Run at ${startedAt}` });
  const [ticketRow] = await h.t.db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.number, ticket.number));
  const [profile] = await h.t.db.select().from(schema.agentProfiles).limit(1);
  if (!ticketRow || !profile) throw new Error('no ticket or profile');
  await h.t.db.insert(schema.runs).values({
    ticketId: ticketRow.id,
    projectId: ticketRow.projectId,
    profileId: profile.id,
    profileVersion: profile.version,
    purpose: 'implement',
    machineId,
    accountId,
    attempt: 1,
    runTokenHash: randomUUID(),
    branchName: `t/${String(ticket.number)}-run`,
    baseBranch: 'main',
    status: 'succeeded',
    decision: 'submitted',
    startedAt: new Date(startedAt),
    endedAt: new Date(startedAt),
    statusSince: new Date(startedAt),
    workingMs: fields.workingMs ?? 0,
    estimatedUsageUsd: fields.estimatedUsageUsd === undefined ? 0.5 : fields.estimatedUsageUsd,
  });
}

/** **Run now** on ticket `number`: the run created, or the refusal. */
async function runNow(number: number) {
  return h.call('POST', `/api/projects/WEB/tickets/${String(number)}/run`);
}

describe('the time zone (02, section 10)', () => {
  it('is UTC until the owner saves one, which writes its event once', async () => {
    await start();
    const read = async () => TimeZoneResponse.parse((await h.call('GET', '/api/time-zone')).json());
    expect(await read()).toEqual({ timeZone: 'UTC', saved: false });
    expect((await accounts()).timeZone).toEqual({ timeZone: 'UTC', saved: false });

    const refused = await h.call('PUT', '/api/time-zone', { timeZone: 'Mars/Olympus' });
    expect(refused.statusCode).toBe(400);
    expect(ApiError.parse(refused.json()).error.message).toContain('not a time zone name');

    await saveTimeZone('Europe/Paris');
    await saveTimeZone('Europe/Paris');
    expect(await read()).toEqual({ timeZone: 'Europe/Paris', saved: true });
    await saveTimeZone('America/New_York');
    expect((await events('setting.time_zone_saved')).map((event) => event.payload)).toEqual([
      { timeZone: 'Europe/Paris', previous: null },
      { timeZone: 'America/New_York', previous: 'Europe/Paris' },
    ]);
  });
});

describe('schedule windows (07, section 5.3)', () => {
  it('are saved with their event, refused when invalid, and read in the time zone', async () => {
    await start();
    const { account: created } = await h.machine();
    expect(created).toMatchObject({ schedule: [], dailyBudget: null });
    expect(created.today.window).toEqual({ state: 'always' });

    const invalid = await patch(created.id, {
      schedule: [{ days: [], start: '22:00', end: '22:00' }],
    });
    expect(invalid.statusCode).toBe(400);
    const message = ApiError.parse(invalid.json()).error.message;
    expect(message).toContain('choose at least one day');
    expect(message).toContain('the start and the end must differ');

    // Monday to Friday, 22:00 to 06:00 the next morning, in Paris (UTC+2 in October).
    const schedule = [
      {
        days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        start: '22:00',
        end: '06:00',
      },
    ];
    await saveTimeZone('Europe/Paris');
    const saved = await patch(created.id, { schedule });
    expect(saved.statusCode, saved.body).toBe(200);
    // Monday 12:00 in Paris: outside until 22:00.
    expect(ClaudeAccount.parse(saved.json()).today.window).toEqual({
      state: 'outside',
      next: '2026-10-19T20:00:00.000Z',
    });
    expect((await events('account.updated')).at(-1)?.payload).toEqual({
      label: 'Laptop account',
      fields: ['schedule'],
      schedule,
    });
    // Saving the same windows again changes nothing and writes nothing.
    await patch(created.id, { schedule });
    expect(await events('account.updated')).toHaveLength(1);

    // Tuesday 01:30 in Paris: inside the window that crossed midnight, until 06:00.
    clock = new Date('2026-10-19T23:30:00Z');
    expect((await account()).today.window).toEqual({
      state: 'inside',
      until: '2026-10-20T04:00:00.000Z',
    });
    // Saturday 01:00 in Paris: Friday's window, until 06:00; then nothing before Monday 22:00.
    clock = new Date('2026-10-23T23:00:00Z');
    expect((await account()).today.window).toEqual({
      state: 'inside',
      until: '2026-10-24T04:00:00.000Z',
    });
    clock = new Date('2026-10-24T10:00:00Z');
    expect((await account()).today.window).toEqual({
      state: 'outside',
      // The clocks went back on Sunday: Monday 22:00 is 21:00 UTC.
      next: '2026-10-26T21:00:00.000Z',
    });
    // No window again: always.
    await patch(created.id, { schedule: [] });
    expect((await account()).today.window).toEqual({ state: 'always' });
  });

  it('opens a window from 02:00 at 03:00 on the night the clocks go forward', async () => {
    await start();
    const { account: created } = await h.machine();
    await saveTimeZone('Europe/Paris');
    await patch(created.id, { schedule: [{ days: ['sunday'], start: '02:00', end: '06:00' }] });
    // Sunday 2026-03-29 01:30 in Paris (00:30 UTC): the window opens at the change, 01:00 UTC.
    clock = new Date('2026-03-29T00:30:00Z');
    expect((await account()).today.window).toEqual({
      state: 'outside',
      next: '2026-03-29T01:00:00.000Z',
    });
    clock = new Date('2026-03-29T01:00:00Z');
    expect((await account()).today.window).toEqual({
      state: 'inside',
      until: '2026-03-29T04:00:00.000Z',
    });
  });

  it("never stop Run now, which ignores them (owner's answer 5)", async () => {
    await start();
    const { account: created, daemon } = await h.machine();
    await patch(created.id, { schedule: [{ days: ['sunday'], start: '02:00', end: '03:00' }] });
    expect((await account()).today.window.state).toBe('outside');
    await h.createTicket();
    const response = await runNow(1);
    expect(response.statusCode, response.body).toBe(201);
    await daemon.find<RunStart>((message) => message.type === 'run.start', 'run.start');
  });
});

describe('the daily budget (07, section 5.4)', () => {
  it("counts the runs started today in the time zone, each kind at the day's start and end", async () => {
    await start();
    const { account: created, id: machineId } = await h.machine();
    await saveTimeZone('Europe/Paris');
    const minutes = await patch(created.id, {
      dailyBudget: { kind: 'working_time', minutes: 60 },
    });
    expect(minutes.statusCode, minutes.body).toBe(200);
    expect((await events('account.updated')).at(-1)?.payload).toEqual({
      label: 'Laptop account',
      fields: ['dailyBudget'],
      dailyBudget: { kind: 'working_time', minutes: 60 },
    });

    // Monday 2026-10-19 in Paris runs from 2026-10-18T22:00Z to 2026-10-19T22:00Z.
    await pastRun(created.id, machineId, '2026-10-18T21:59:00Z', { workingMs: 90 * 60_000 });
    await pastRun(created.id, machineId, '2026-10-18T22:00:30Z', { workingMs: 40 * 60_000 });
    // At the day's start, the run of 23:59 the day before is not counted.
    clock = new Date('2026-10-18T22:01:00Z');
    let today = (await account()).today;
    expect(today.usage).toEqual({
      runs: 1,
      workingMs: 40 * 60_000,
      estimatedUsageUsd: 0.5,
      runsWithoutEstimate: 0,
    });
    expect(today.budgetUsed).toBe(false);
    expect(today.dayEndsAt).toBe('2026-10-19T22:00:00.000Z');

    // At its end, a run started at 23:59 makes 60 minutes: used. Claude Code gave it no
    // estimate, which counts as nothing.
    clock = new Date('2026-10-19T21:59:30Z');
    await pastRun(created.id, machineId, '2026-10-19T21:59:00Z', {
      workingMs: 20 * 60_000,
      estimatedUsageUsd: null,
    });
    today = (await account()).today;
    expect(today.usage).toEqual({
      runs: 2,
      workingMs: 60 * 60_000,
      estimatedUsageUsd: 0.5,
      runsWithoutEstimate: 1,
    });
    expect(today.budgetUsed).toBe(true);

    // Estimated usage: $0.50 is under $0.60; at the next midnight, nothing is counted.
    await patch(created.id, { dailyBudget: { kind: 'estimated_usage', usd: 0.6 } });
    expect((await account()).today.budgetUsed).toBe(false);
    await patch(created.id, { dailyBudget: { kind: 'estimated_usage', usd: 0.5 } });
    expect((await account()).today.budgetUsed).toBe(true);
    clock = new Date('2026-10-19T22:00:00Z');
    today = (await account()).today;
    expect(today.usage.runs).toBe(0);
    expect(today.budgetUsed).toBe(false);

    const invalid = await patch(created.id, {
      dailyBudget: { kind: 'estimated_usage', usd: 0.001 },
    });
    expect(invalid.statusCode).toBe(400);
    await patch(created.id, { dailyBudget: null });
    expect((await account()).dailyBudget).toBeNull();
  });

  it('counts a run in progress with its time so far and its latest estimate', async () => {
    await start();
    const { account: created, daemon } = await h.machine();
    await h.createTicket();
    const { runId } = await h.running(daemon);
    clock = new Date(clock.getTime() + 25 * 60_000);
    expect((await account()).today.usage).toEqual({
      runs: 1,
      workingMs: 25 * 60_000,
      estimatedUsageUsd: 0,
      runsWithoutEstimate: 1,
    });
    const answer = await daemon.request({
      type: 'run.events',
      id: randomUUID(),
      payload: {
        runId,
        events: [{ seq: 0, at: clock.toISOString(), kind: 'agent_text', tool: null, text: 'Hi' }],
        estimatedUsageUsd: 1.25,
      },
    });
    expect(answer).toMatchObject({ payload: { ok: true } });
    await patch(created.id, { dailyBudget: { kind: 'estimated_usage', usd: 1.25 } });
    const today = (await account()).today;
    expect(today.usage).toMatchObject({ estimatedUsageUsd: 1.25, runsWithoutEstimate: 0 });
    expect(today.budgetUsed).toBe(true);

    // Run now ignores the budget (07, section 5.4): a second ticket starts.
    await h.call('PATCH', `/api/accounts/${created.id}`, { maxConcurrentRuns: 2 });
    await h.createTicket({ title: 'Second' });
    const second = await runNow(2);
    expect(second.statusCode, second.body).toBe(201);
  });

  it('lists the last days and the limits reached on the account page', async () => {
    await start();
    const { account: created, id: machineId } = await h.machine();
    await pastRun(created.id, machineId, '2026-10-18T09:00:00Z', {
      workingMs: 600_000,
      estimatedUsageUsd: 0.25,
    });
    await pastRun(created.id, machineId, '2026-10-19T09:00:00Z', { estimatedUsageUsd: 0.75 });
    await h.t.db.insert(schema.events).values({
      actor: 'system',
      entityType: 'claude_account',
      entityId: created.id,
      type: 'account.limited',
      payload: { label: 'Laptop account', until: '2026-10-19T12:00:00.000Z', source: 'reset_time' },
      createdAt: new Date('2026-10-19T09:30:00Z'),
    });
    const response = await h.call('GET', `/api/accounts/${created.id}`);
    expect(response.statusCode, response.body).toBe(200);
    const detail = AccountDetailResponse.parse(response.json());
    expect(detail.days).toHaveLength(14);
    expect(detail.days.slice(0, 3)).toEqual([
      {
        date: '2026-10-19',
        runs: 1,
        workingMs: 0,
        estimatedUsageUsd: 0.75,
        runsWithoutEstimate: 0,
      },
      {
        date: '2026-10-18',
        runs: 1,
        workingMs: 600_000,
        estimatedUsageUsd: 0.25,
        runsWithoutEstimate: 0,
      },
      { date: '2026-10-17', runs: 0, workingMs: 0, estimatedUsageUsd: 0, runsWithoutEstimate: 0 },
    ]);
    expect(detail.limits).toEqual([
      { at: '2026-10-19T09:30:00.000Z', until: '2026-10-19T12:00:00.000Z', source: 'reset_time' },
    ]);
    expect(detail.limitCount).toBe(1);
    expect((await h.call('GET', `/api/accounts/${randomUUID()}`)).statusCode).toBe(404);
  });
});

describe('Stop new runs and Resume (07, section 5.5)', () => {
  it('pause the account with their events, refuse Run now and Resume, and let active runs go on', async () => {
    await start();
    const { account: created, id: machineId, daemon } = await h.machine('Laptop', 2);
    await h.createTicket();
    const { runId } = await h.running(daemon);

    const paused = await h.call('POST', `/api/accounts/${created.id}/stop-new-runs`);
    expect(paused.statusCode, paused.body).toBe(200);
    expect(ClaudeAccount.parse(paused.json()).state).toBe('paused_manual');
    // A second click changes nothing.
    await h.call('POST', `/api/accounts/${created.id}/stop-new-runs`);
    expect((await events('account.paused')).map((event) => event.payload)).toEqual([
      { label: 'Laptop account', activeRuns: 1 },
    ]);
    // The active run goes on.
    expect((await h.run(runId)).status).toBe('running');
    const needsYou = NeedsYouResponse.parse((await h.call('GET', '/api/needs-you')).json());
    expect(needsYou.accounts[0]).toMatchObject({ state: 'paused_manual' });

    await h.createTicket({ title: 'Second' });
    const refused = await runNow(2);
    expect(refused.statusCode).toBe(409);
    expect(ApiError.parse(refused.json()).error.runRefusal).toEqual({
      reason: 'no_machine',
      machines: [
        {
          machine: { id: machineId, name: 'Laptop' },
          unavailable: {
            why: 'account_paused',
            account: { id: created.id, label: 'Laptop account' },
          },
        },
      ],
    });

    // A run paused on a suspected limit is not resumed on a paused account.
    await h.report(daemon, state(runId, { state: 'quota_paused' }));
    const suspected = await daemon.request({
      type: 'run.quota_limited',
      id: randomUUID(),
      payload: {
        runId,
        kind: 'suspected',
        evidence: { signal: 'stop_failure', error: 'overloaded', message: null, statusLine: null },
      },
    } as const);
    expect(suspected).toMatchObject({ payload: { ok: true } });
    const resume = await h.call('POST', `/api/runs/${runId}/resume`);
    expect(resume.statusCode, resume.body).toBe(409);
    expect(ApiError.parse(resume.json()).error.runRefusal).toEqual({
      reason: 'account_paused',
      account: { id: created.id, label: 'Laptop account' },
    });

    const resumed = await h.call('POST', `/api/accounts/${created.id}/resume`);
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(ClaudeAccount.parse(resumed.json()).state).toBe('available');
    await h.call('POST', `/api/accounts/${created.id}/resume`);
    expect((await events('account.resumed')).map((event) => event.payload)).toEqual([
      { label: 'Laptop account' },
    ]);
    const started = await runNow(2);
    expect(started.statusCode, started.body).toBe(201);
    Run.parse(started.json());
  });

  it('keep a usage limit reached while paused, which Resume goes back to', async () => {
    await start();
    const { account: created, daemon } = await h.machine();
    await h.createTicket();
    const { runId } = await h.running(daemon);
    await h.call('POST', `/api/accounts/${created.id}/stop-new-runs`);
    const until = new Date(clock.getTime() + 3_600_000).toISOString();
    const limited = await daemon.request({
      type: 'run.quota_limited',
      id: randomUUID(),
      payload: {
        runId,
        kind: 'detected',
        resetsAt: until,
        evidence: {
          signal: 'stop_failure',
          error: 'rate_limit',
          message: "You've hit your session limit",
          statusLine: null,
        },
      },
    } as const);
    expect(limited).toMatchObject({ payload: { ok: true } });
    expect(await account()).toMatchObject({ state: 'paused_manual', limitedUntil: until });
    expect(await events('account.limited')).toHaveLength(1);

    await h.call('POST', `/api/accounts/${created.id}/resume`);
    expect(await account()).toMatchObject({ state: 'limited', limitedUntil: until });
    expect((await events('account.resumed')).map((event) => event.payload)).toEqual([
      { label: 'Laptop account', limitedUntil: until },
    ]);

    // Paused again after the limit time: the passed limit is dropped.
    clock = new Date(clock.getTime() + 2 * 3_600_000);
    await h.call('POST', `/api/accounts/${created.id}/stop-new-runs`);
    expect(await account()).toMatchObject({ state: 'paused_manual', limitedUntil: null });
    await h.call('POST', `/api/accounts/${created.id}/resume`);
    expect(await account()).toMatchObject({ state: 'available', limitedUntil: null });
  });
});
