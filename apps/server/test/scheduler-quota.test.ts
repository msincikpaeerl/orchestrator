import { randomUUID } from 'node:crypto';
import { schema } from '@orchestrator/db';
import {
  ApiError,
  CLAUDE_CODE_VALIDATED_VERSION,
  NeedsYouResponse,
  QueueResponse,
  Run,
  type RunQuotaLimited,
  type RunResume,
} from '@orchestrator/protocol';
import { desc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import { RunHarness, eventually, state } from './run-harness.js';

// The scheduler's resumes after a usage limit (07, section 5.2; lot 4 step E), with the real
// application and scripted daemons: what waits for the account's window, budget and Stop new
// runs, what the owner's Resume still does, a resume its machine does not take, and the order.
// The application's clock is set by each test (`at`); the time zone is UTC (none saved). The
// waits and their doubling with the real daemon and the fake `claude` are in
// `acceptance.test.ts` ("lot 4 step E").

const h = new RunHarness();
let at = new Date('2026-11-02T06:30:00Z');
const clock = () => at;
const set = (iso: string) => {
  at = new Date(iso);
};

afterEach(async () => {
  await h.stop();
});

const EVERY_DAY = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

async function tick(): Promise<string[]> {
  const result = await h.t.schedulerTick();
  expect(result.locked).toBe(true);
  return result.started.map((start) => `${start.kind} ${start.ticket} on ${start.machine}`);
}

async function reasonOf(number = 1) {
  const response = await h.call('GET', '/api/queue');
  expect(response.statusCode, response.body).toBe(200);
  const found = QueueResponse.parse(response.json()).candidates.find(
    (candidate) => candidate.ticket.number === number,
  );
  if (!found) throw new Error(`WEB-${String(number)} is not in the queue`);
  return found.reason;
}

/** The paused run's "Needs you" item: why the scheduler does not resume it yet. */
async function pausedItem() {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  const item = NeedsYouResponse.parse(response.json()).items.find(
    (each) => each.type === 'run_paused',
  );
  if (item?.type !== 'run_paused') throw new Error('no paused run in Needs you');
  return item;
}

async function runRow(id: string) {
  const [row] = await h.t.db.select().from(schema.runs).where(eq(schema.runs.id, id));
  if (!row) throw new Error('no run');
  return row;
}

async function latestRunId(number = 1): Promise<string> {
  const ticket = await h.ticket(number);
  const [last] = await h.t.db
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(eq(schema.runs.ticketId, ticket.id))
    .orderBy(desc(schema.runs.createdAt))
    .limit(1);
  if (!last) throw new Error(`WEB-${String(number)} has no run`);
  return last.id;
}

function quotaLimited(runId: string, kind: 'detected' | 'suspected'): RunQuotaLimited {
  const evidence = {
    signal: 'stop_failure' as const,
    error: kind === 'detected' ? ('rate_limit' as const) : ('overloaded' as const),
    message: kind === 'detected' ? "You've hit your weekly limit" : 'API Error: Overloaded',
    statusLine: null,
  };
  return {
    type: 'run.quota_limited',
    id: randomUUID(),
    payload:
      kind === 'detected' ? { runId, kind, resetsAt: null, evidence } : { runId, kind, evidence },
  };
}

/** The daemon pauses the run on a limit with no reset time, its session closed. */
async function pause(daemon: ScriptedDaemon, runId: string, kind: 'detected' | 'suspected') {
  expect(await daemon.request(quotaLimited(runId, kind))).toMatchObject({
    payload: { ok: true },
  });
  await h.report(daemon, state(runId, { state: 'quota_paused' }, false));
  expect((await h.run(runId)).status).toBe('paused_quota');
}

function resumesOf(daemon: ScriptedDaemon, runId: string): RunResume[] {
  return daemon.received.filter(
    (message): message is RunResume =>
      message.type === 'run.resume' && message.payload.runId === runId,
  );
}

/** The `count`-th `run.resume` of the run, answered `ok` (then the run works) or refused. */
async function answerResume(
  daemon: ScriptedDaemon,
  runId: string,
  count: number,
  ok: boolean,
): Promise<void> {
  await eventually('the run.resume', () => {
    expect(resumesOf(daemon, runId).length).toBeGreaterThanOrEqual(count);
  });
  const resume = resumesOf(daemon, runId)[count - 1];
  if (!resume) throw new Error('no run.resume');
  daemon.send({
    type: 'ack',
    id: resume.id,
    payload: ok ? { ok: true } : { ok: false, message: 'The run has ended.' },
  });
  if (!ok) {
    await eventually('the run paused again', async () => {
      expect((await h.run(runId)).status).toBe('paused_quota');
    });
    return;
  }
  await h.report(
    daemon,
    state(runId, { state: 'starting', claudeCodeVersion: CLAUDE_CODE_VALIDATED_VERSION }),
  );
  await h.report(daemon, state(runId, { state: 'working' }));
}

/** The run's machine reported its estimated usage: $0.50. */
async function usage(daemon: ScriptedDaemon, runId: string) {
  const answer = await daemon.request({
    type: 'run.events',
    id: randomUUID(),
    payload: {
      runId,
      events: [{ seq: 0, at: at.toISOString(), kind: 'agent_text', tool: null, text: 'Working.' }],
      estimatedUsageUsd: 0.5,
    },
  });
  expect(answer).toMatchObject({ payload: { ok: true } });
}

async function account(id: string, body: object) {
  const response = await h.call('PATCH', `/api/accounts/${id}`, body);
  expect(response.statusCode, response.body).toBe(200);
}

/** A run started by the owner's **Run now** at 06:30 on Monday, on an account with a night window. */
async function nightRun() {
  set('2026-11-02T06:30:00Z');
  await h.start({ now: clock });
  await h.createTicket();
  const laptop = await h.machine();
  await account(laptop.account.id, {
    schedule: [{ days: EVERY_DAY, start: '22:00', end: '07:00' }],
  });
  const { runId } = await h.running(laptop.daemon);
  await usage(laptop.daemon, runId);
  return { ...laptop, runId };
}

describe("a resume and the account's rules (07, section 5.2)", () => {
  it('waits for the window, the daily budget and Stop new runs, like any start', async () => {
    const { account: personal, daemon, runId } = await nightRun();
    await pause(daemon, runId, 'detected');

    // The limit ends at 07:30, after the window's end: the resume waits for 22:00.
    set('2026-11-02T07:31:00Z');
    expect(await tick()).toEqual([]);
    const outside = {
      reason: 'machine_unavailable',
      machine: { name: 'Laptop' },
      commits: null,
      unavailable: { why: 'account_outside_window', next: '2026-11-02T22:00:00.000Z' },
    };
    expect(await reasonOf()).toMatchObject(outside);
    expect((await pausedItem()).resume).toMatchObject(outside);

    // At 22:01 the day's budget is used (its run's $0.50 counts on Monday): until midnight.
    await account(personal.id, { dailyBudget: { kind: 'estimated_usage', usd: 0.01 } });
    set('2026-11-02T22:01:00Z');
    expect(await tick()).toEqual([]);
    expect(await reasonOf()).toMatchObject({
      reason: 'machine_unavailable',
      unavailable: { why: 'account_budget_used', until: '2026-11-03T00:00:00.000Z' },
    });

    // New runs stopped before midnight: still nothing on Tuesday until the owner's Resume.
    set('2026-11-02T23:59:00Z');
    expect((await h.call('POST', `/api/accounts/${personal.id}/stop-new-runs`)).statusCode).toBe(
      200,
    );
    set('2026-11-03T00:01:00Z');
    expect(await tick()).toEqual([]);
    expect(await reasonOf()).toMatchObject({ reason: 'account_paused' });
    expect((await h.call('POST', `/api/accounts/${personal.id}/resume`)).statusCode).toBe(200);
    expect(await tick()).toEqual(['resume WEB-1 on Laptop']);
    await answerResume(daemon, runId, 1, true);
    expect((await h.run(runId)).status).toBe('running');
    expect(await h.ticket()).toMatchObject({ status: 'in_progress', attemptCount: 0 });
  });

  it("leaves the owner's Resume as it was: windows and budget ignored, Stop new runs refusing it, a suspected limit at once", async () => {
    const { account: personal, daemon, runId } = await nightRun();
    await account(personal.id, { dailyBudget: { kind: 'estimated_usage', usd: 0.01 } });
    await pause(daemon, runId, 'detected');

    // Outside the window, the budget used: the owner's Resume resumes it once the limit passed.
    set('2026-11-02T07:31:00Z');
    const resumed = await h.call('POST', `/api/runs/${runId}/resume`);
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(Run.parse(resumed.json()).status).toBe('dispatched');
    await answerResume(daemon, runId, 1, true);

    // A suspected limit: the scheduler waits an hour, the owner's Resume does not.
    await pause(daemon, runId, 'suspected');
    expect(await reasonOf()).toMatchObject({ reason: 'quota_wait', minutes: 60 });
    expect((await h.call('POST', `/api/runs/${runId}/resume`)).statusCode).toBe(200);
    await answerResume(daemon, runId, 2, true);

    // New runs stopped: the owner's Resume is refused (lot 4 step C), the scheduler's too.
    await pause(daemon, runId, 'suspected');
    expect((await h.call('POST', `/api/accounts/${personal.id}/stop-new-runs`)).statusCode).toBe(
      200,
    );
    const refused = await h.call('POST', `/api/runs/${runId}/resume`);
    expect(refused.statusCode).toBe(409);
    expect(ApiError.parse(refused.json()).error.runRefusal).toMatchObject({
      reason: 'account_paused',
    });
    set('2026-11-02T23:00:00Z');
    expect(await tick()).toEqual([]);
    expect(await h.ticket()).toMatchObject({ attemptCount: 0 });
  });
});

describe('what the scheduler resumes, and how often (07, section 5.2)', () => {
  it('a resume its machine does not take is not sent again until it connects again, or Resume', async () => {
    await h.start({ now: clock });
    await h.createTicket();
    const laptop = await h.machine();
    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    const runId = await latestRunId();
    await h.working(laptop.daemon, runId);
    await pause(laptop.daemon, runId, 'suspected');

    // Refused by the machine: paused again, and left out of the scheduler's resumes.
    set(new Date(at.getTime() + 61 * 60_000).toISOString());
    expect(await tick()).toEqual(['resume WEB-1 on Laptop']);
    await answerResume(laptop.daemon, runId, 1, false);
    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    expect(resumesOf(laptop.daemon, runId)).toHaveLength(1);
    expect(await reasonOf()).toMatchObject({
      reason: 'machine_unavailable',
      machine: { name: 'Laptop' },
      unavailable: { why: 'left_out', cause: 'dispatch_refused' },
    });

    // It connects again a minute later: resumed once more, refused again, left out again.
    await laptop.daemon.close();
    await eventually('the machine offline', async () => {
      const [row] = await h.t.db
        .select({ status: schema.machines.status })
        .from(schema.machines)
        .where(eq(schema.machines.id, laptop.id));
      expect(row?.status).toBe('offline');
    });
    set(new Date(at.getTime() + 60_000).toISOString());
    const again = await h.connect(laptop.token);
    expect(await tick()).toEqual(['resume WEB-1 on Laptop']);
    await answerResume(again, runId, 1, false);
    expect(await tick()).toEqual([]);

    // The owner's Resume sends it, and takes the machine back for the scheduler.
    expect((await h.call('POST', `/api/runs/${runId}/resume`)).statusCode).toBe(200);
    expect((await runRow(runId)).resumeLeftOut).toBeNull();
    await answerResume(again, runId, 2, true);
    expect(await h.ticket()).toMatchObject({ status: 'in_progress', attemptCount: 0 });
  });

  it('a suspected limit leaves the account to other tickets; the paused run then resumes first', async () => {
    await h.start({ now: clock });
    await h.createTicket();
    const { daemon } = await h.machine();
    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    const paused = await latestRunId();
    await h.working(daemon, paused);
    await pause(daemon, paused, 'suspected');

    // The account is unchanged and the paused run takes no place: WEB-2 starts meanwhile.
    expect((await h.call('GET', '/api/accounts')).json()).toMatchObject({
      accounts: [{ state: 'available', limitedUntil: null }],
    });
    await h.createTicket({ title: 'Opening hours' });
    expect(await tick()).toEqual(['implement WEB-2 on Laptop']);
    const other = await latestRunId(2);
    await h.working(daemon, other, 2);

    // The wait is over while WEB-2 runs: the account is full, nothing more starts.
    set(new Date(at.getTime() + 61 * 60_000).toISOString());
    expect(await tick()).toEqual([]);
    expect(await reasonOf()).toMatchObject({ reason: 'account_busy' });

    // WEB-2 ends: the resume goes before new work.
    await h.createTicket({ title: 'Prices page', priority: 'high' });
    await h.report(daemon, state(other, { state: 'ended', reason: 'stopped' }));
    await eventually('WEB-2 ended', async () => {
      expect((await h.run(other)).status).not.toBe('running');
    });
    expect(await tick()).toEqual(['resume WEB-1 on Laptop']);
    expect(await reasonOf(3)).toMatchObject({
      reason: 'no_machine',
      machines: [{ unavailable: { why: 'account_busy' } }],
    });
  });
});
