import { randomUUID } from 'node:crypto';
import { schema } from '@orchestrator/db';
import {
  NeedsYouResponse,
  QueueResponse,
  TicketMachineFailures,
  type DodReport,
  type RunStop,
  type TicketDetail,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import { HEAD, RunHarness, SESSION, TOKEN, eventually, state } from './run-harness.js';

// Reconciliation after a disconnection (05, section 6; owner's answer 10, lot 4 step G), with the
// real application and scripted daemons: a machine back before **Runs of an offline machine fail
// after**, one back after it (the run failed, not counted, its session stopped at the reconnection
// and its end push and branch report kept), a daemon that no longer has a run at its `hello`, a
// review run on a machine lost, and the runs that keep waiting. The application's clock is set by
// each test; the scheduler's tick (`tick()`) is where the runs of an offline machine fail.

const h = new RunHarness();
let at = new Date('2026-11-02T10:00:00Z');
const clock = () => at;
const later = (minutes: number) => {
  at = new Date(at.getTime() + minutes * 60_000);
};

afterEach(async () => {
  await h.stop();
});

const REPORT: DodReport = {
  criteria: [
    { index: 0, status: 'met', justification: 'ContactForm renders the form' },
    { index: 1, status: 'met', justification: 'Tested in contact.test.ts' },
  ],
  tests: { paths: ['src/contact.test.ts'], justification: null },
  docs: { paths: ['docs/user/contact.md'], justification: null },
  adrs: [],
  summary: 'Adds the contact form.',
};

/** The runs the latest tick started, in order. */
let started: string[] = [];

async function tick(): Promise<string[]> {
  const result = await h.t.schedulerTick();
  expect(result.locked).toBe(true);
  started = result.started.map((start) => start.runId);
  return result.started.map((start) => `${start.kind} ${start.ticket} on ${start.machine}`);
}

/** The run the latest tick started (the clock is fixed: creation times can be equal). */
function startedRun(): string {
  const [runId] = started;
  if (runId === undefined) throw new Error('the tick started nothing');
  return runId;
}

function comments(detail: TicketDetail): string[] {
  return detail.timeline.flatMap((entry) => (entry.type === 'comment' ? [entry.comment.body] : []));
}

async function machineRow(id: string) {
  const [row] = await h.t.db.select().from(schema.machines).where(eq(schema.machines.id, id));
  if (!row) throw new Error('no machine');
  return row;
}

/** The daemon closes its connection; the server marks the machine offline at `at`. */
async function disconnect(daemon: ScriptedDaemon, machineId: string) {
  await daemon.close();
  await eventually('the machine offline', async () => {
    expect((await machineRow(machineId)).status).toBe('offline');
  });
  expect((await machineRow(machineId)).offlineSince).toEqual(at);
}

async function machineFailures(number = 1) {
  const [row] = await h.t.db
    .select({ failures: schema.tickets.machineFailures })
    .from(schema.tickets)
    .where(eq(schema.tickets.number, number));
  return TicketMachineFailures.parse(row?.failures);
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

async function items() {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items;
}

const stops = (daemon: ScriptedDaemon, runId: string) =>
  daemon.received.filter(
    (message): message is RunStop => message.type === 'run.stop' && message.payload.runId === runId,
  );

async function pushCredential(daemon: ScriptedDaemon, runId: string) {
  const answer = await daemon.request({
    type: 'git.credential_request',
    id: randomUUID(),
    payload: { runId, repository: { owner: 'octo-owner', name: 'bakery' }, command: 'push' },
  });
  if (answer.type !== 'git.credential') throw new Error(`unexpected ${answer.type}`);
  return answer.payload;
}

describe('a machine offline during a run (05, section 6)', () => {
  it('back before Runs of an offline machine fail after: the run goes on', async () => {
    await h.start({ now: clock });
    await h.createTicket();
    const laptop = await h.machine();
    const { runId } = await h.running(laptop.daemon);
    await disconnect(laptop.daemon, laptop.id);

    later(9);
    expect(await tick()).toEqual([]);
    expect((await h.run(runId)).status).toBe('running');

    const again = await h.connect(laptop.token, {
      runs: [{ runId, state: 'working', claudeSessionId: SESSION }],
    });
    expect(await machineRow(laptop.id)).toMatchObject({ status: 'online', offlineSince: null });
    later(5);
    expect(await tick()).toEqual([]);
    expect(await h.run(runId)).toMatchObject({ status: 'running', failureReason: null });
    expect(stops(again, runId)).toEqual([]);
    expect(await h.ticket()).toMatchObject({ status: 'in_progress', attemptCount: 0 });
    expect(await machineFailures()).toEqual([]);
  });

  it('back after it: failed, not counted, held to its machine, the session stopped and its end kept; a second time in a row asks you', async () => {
    await h.start({ now: clock });
    await h.createTicket();
    const laptop = await h.machine();
    // A first run left commits only on Laptop (its end report: none on GitHub).
    const first = await h.running(laptop.daemon);
    await h.report(laptop.daemon, state(first.runId, { state: 'ended', reason: 'crashed' }));
    const desk = await h.machine('Desk');
    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    const runId = startedRun();
    await h.working(laptop.daemon, runId);
    await disconnect(laptop.daemon, laptop.id);
    const offlineSince = at.toISOString();

    // Ten minutes offline (the default): failed at the scheduler's next check, not counted.
    later(10);
    expect(await tick()).toEqual([]);
    expect(await h.run(runId)).toMatchObject({
      status: 'failed',
      failureReason: 'machine_offline',
      endDetail: 'offline for more than 10 minutes',
    });
    const detail = await h.ticket();
    expect(detail).toMatchObject({ status: 'todo', attemptCount: 1 });
    expect(comments(detail).at(-1)).toBe(
      'The run failed as "machine offline": machine Laptop was offline for 10 minutes (Runs of an offline machine fail after: 10 minutes). It does not count as a failed attempt. The branch t/1-contact-form is kept on machine Laptop: when its commits are not all on GitHub, the next run waits for that machine.',
    );
    // Its commits are only on Laptop: Desk does not take it, and the queue says since when.
    expect(await reasonOf()).toMatchObject({
      reason: 'machine_unavailable',
      machine: { name: 'Laptop' },
      commits: 1,
      unavailable: { why: 'offline', since: offlineSince },
    });
    expect(desk.daemon.received.some((message) => message.type === 'run.start')).toBe(false);
    expect(await machineFailures()).toMatchObject([
      { machineId: laptop.id, failures: [{ cause: 'machine_offline', runId }], asked: null },
    ]);

    // Laptop is back with the session: stopped as not active, its end push and branch kept.
    later(1);
    const again = await h.connect(laptop.token, {
      runs: [{ runId, state: 'working', claudeSessionId: SESSION }],
    });
    await again.find(
      (message) =>
        message.type === 'run.stop' &&
        message.payload.runId === runId &&
        message.payload.reason === 'not_active',
      'run.stop at hello',
    );
    expect(await pushCredential(again, runId)).toEqual({
      ok: true,
      username: 'x-access-token',
      password: TOKEN,
    });
    await h.report(again, state(runId, { state: 'ended', reason: 'stopped' }));
    expect(await h.run(runId)).toMatchObject({
      status: 'failed',
      failureReason: 'machine_offline',
      branch: { head: HEAD },
    });
    // Counted once only, and Laptop is released by its reconnection: the ticket starts there.
    expect((await machineFailures())[0]?.failures).toHaveLength(1);
    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    const next = startedRun();
    await h.working(again, next);

    // Lost the same way again (Machine failures before asking you, 2): the item, and no start.
    await disconnect(again, laptop.id);
    later(10);
    expect(await tick()).toEqual([]);
    expect((await h.run(next)).failureReason).toBe('machine_offline');
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 1 });
    expect(await items()).toContainEqual(
      expect.objectContaining({
        type: 'machine_failures',
        ticket: expect.objectContaining({ number: 1 }) as unknown,
        machine: { id: laptop.id, name: 'Laptop' },
        limit: 2,
      }),
    );
    const third = await h.connect(laptop.token);
    expect(await tick()).toEqual([]);
    expect(await reasonOf()).toMatchObject({ reason: 'needs_you', item: 'machine_failures' });
    expect(stops(third, next)).toEqual([]);
  });

  it('refuses the end push once MCP call timeout plus Longest push have passed since the stop', async () => {
    await h.start({ now: clock });
    await h.createTicket();
    const laptop = await h.machine();
    const { runId } = await h.running(laptop.daemon);
    await disconnect(laptop.daemon, laptop.id);
    later(10);
    await tick();
    const again = await h.connect(laptop.token, {
      runs: [{ runId, state: 'working', claudeSessionId: SESSION }],
    });
    await again.find(
      (message) => message.type === 'run.stop' && message.payload.runId === runId,
      'run.stop at hello',
    );
    // 30 seconds plus 60 seconds by default: a slow stop closes the window first.
    at = new Date(at.getTime() + 91_000);
    expect(await pushCredential(again, runId)).toEqual({
      ok: false,
      message: 'the run was stopped more than 90 seconds ago (MCP call timeout plus Longest push)',
    });
    await h.report(again, state(runId, { state: 'ended', reason: 'stopped' }));
    expect(await h.run(runId)).toMatchObject({ status: 'failed', branch: { head: HEAD } });
  });

  it('keeps waiting a run waiting for you or paused; fails a run waiting for CI', async () => {
    await h.start({ now: clock, ci: 'queued' });
    for (const title of ['Question', 'Paused', 'CI']) await h.createTicket({ title });
    const laptop = await h.machine('Laptop', 3);
    const asking = await h.running(laptop.daemon, 1);
    await h.ok(laptop.daemon, asking.runToken, 'ticket_ask', { question: 'Which e-mail address?' });
    await h.report(laptop.daemon, state(asking.runId, { state: 'waiting_human' }));
    expect((await h.run(asking.runId)).status).toBe('waiting_human');
    const paused = await h.running(laptop.daemon, 2);
    const limited = await laptop.daemon.request({
      type: 'run.quota_limited',
      id: randomUUID(),
      payload: {
        runId: paused.runId,
        kind: 'suspected',
        evidence: {
          signal: 'stop_failure',
          error: 'overloaded',
          message: 'API Error: Overloaded',
          statusLine: null,
        },
      },
    });
    expect(limited).toMatchObject({ payload: { ok: true } });
    const ci = await h.running(laptop.daemon, 3);
    await h.ok(laptop.daemon, ci.runToken, 'ticket_submit', REPORT);
    await h.report(laptop.daemon, state(ci.runId, { state: 'waiting_ci' }));
    await eventually('the wait for CI begun', async () => {
      expect((await h.run(ci.runId)).ci?.since).toBeTruthy();
    });
    await disconnect(laptop.daemon, laptop.id);

    later(60);
    await tick();
    expect((await h.run(asking.runId)).status).toBe('waiting_human');
    expect((await h.run(paused.runId)).status).toBe('paused_quota');
    expect(await h.run(ci.runId)).toMatchObject({
      status: 'failed',
      failureReason: 'machine_offline',
    });
    expect(await h.ticket(3)).toMatchObject({ status: 'todo', attemptCount: 0 });
  });
});

describe('a run the daemon no longer has at its hello (05, section 6)', () => {
  it('fails it, not counted, and the machine can take the ticket again at once', async () => {
    await h.start({ now: clock });
    await h.createTicket();
    const laptop = await h.machine();
    const { runId } = await h.running(laptop.daemon);
    await disconnect(laptop.daemon, laptop.id);

    // The machine restarted: its daemon reports no run, two minutes later.
    later(2);
    await h.connect(laptop.token);
    expect(await h.run(runId)).toMatchObject({
      status: 'failed',
      failureReason: 'machine_offline',
      endDetail: 'not on the machine when it connected again',
    });
    const detail = await h.ticket();
    expect(detail).toMatchObject({ status: 'todo', attemptCount: 0 });
    expect(comments(detail).at(-1)).toBe(
      'The run on machine Laptop failed as "machine offline": machine Laptop no longer had it when it connected again (its daemon or the machine was restarted without it). It does not count as a failed attempt.',
    );
    // Lost before this connection: counted in a row, but Laptop is not left out.
    expect(await machineFailures()).toMatchObject([
      { failures: [{ cause: 'machine_offline', runId }] },
    ]);
    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
  });

  it('a review run lost: the ticket stays in review, "Review did not finish"', async () => {
    await h.start({ now: clock });
    await h.createTicket();
    const laptop = await h.machine();
    const built = await h.running(laptop.daemon);
    await h.ok(laptop.daemon, built.runToken, 'ticket_submit', REPORT);
    await h.ciPasses(laptop.daemon, built.runId);
    expect(await tick()).toEqual(['review WEB-1 on Laptop']);
    const review = startedRun();
    await h.working(laptop.daemon, review);
    await disconnect(laptop.daemon, laptop.id);

    later(3);
    await h.connect(laptop.token);
    expect(await h.run(review)).toMatchObject({
      status: 'failed',
      failureReason: 'machine_offline',
    });
    const detail = await h.ticket();
    expect(detail).toMatchObject({ status: 'in_review', attemptCount: 0 });
    expect(comments(detail).at(-1)).toBe(
      'The review run on machine Laptop ended without a decision: machine Laptop no longer had the review run when it connected again. It does not count as a failed attempt.',
    );
    expect(await items()).toContainEqual(expect.objectContaining({ type: 'review_not_finished' }));
    expect(await tick()).toEqual([]);
    expect(await machineFailures()).toEqual([]);
  });

  it('a review run on a machine offline too long: the same, with how long it was offline', async () => {
    await h.start({ now: clock, settings: { offlineRunFailMinutes: 5 } });
    await h.createTicket();
    const laptop = await h.machine();
    const built = await h.running(laptop.daemon);
    await h.ok(laptop.daemon, built.runToken, 'ticket_submit', REPORT);
    await h.ciPasses(laptop.daemon, built.runId);
    const review = await h.reviewing(laptop.daemon);
    await disconnect(laptop.daemon, laptop.id);

    later(4);
    await tick();
    expect((await h.run(review.runId)).status).toBe('running');
    later(3);
    await tick();
    expect(await h.run(review.runId)).toMatchObject({
      status: 'failed',
      failureReason: 'machine_offline',
      endDetail: 'offline for more than 5 minutes',
    });
    const detail = await h.ticket();
    expect(detail.status).toBe('in_review');
    expect(comments(detail).at(-1)).toBe(
      'The review run on machine Laptop ended without a decision: machine Laptop was offline for 7 minutes (Runs of an offline machine fail after: 5 minutes). It does not count as a failed attempt.',
    );
    expect(await items()).toContainEqual(expect.objectContaining({ type: 'review_not_finished' }));
  });
});
