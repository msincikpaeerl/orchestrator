import { schema } from '@orchestrator/db';
import {
  ApiError,
  QueueResponse,
  Run,
  type DodReport,
  type QueueCandidate,
  type RunStart,
  type TicketDetail,
} from '@orchestrator/protocol';
import { and, asc, desc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { schedulerOf } from '../src/app.js';
import { Scheduler, SCHEDULER_LOCK } from '../src/scheduler/loop.js';
import type { ScriptedDaemon } from './daemon-client.js';
import { RunHarness, cleanWorkspace, eventually, state } from './run-harness.js';

// The scheduler's loop (07, section 2; lot 4 step D2a), with the real application, scripted
// daemons and the fake GitHub: what it starts by itself, in which order, who it says started it,
// and what it never starts again in a loop (the holds and the machine rule: lot 4 step D2b, its own
// tests in `scheduler-holds.test.ts`). The tests run its ticks themselves (`schedulerTick()`),
// except those of its triggers and interval.

const h = new RunHarness();

afterEach(async () => {
  await h.stop();
});

const SCHEDULER_LINE =
  'Started by the scheduler: the Orchestrator started this run by itself, not the owner.';

const REPORT: DodReport = {
  criteria: [
    { number: 1, status: 'met', justification: 'ContactForm renders the form' },
    { number: 2, status: 'met', justification: 'Tested in contact.test.ts' },
  ],
  tests: { paths: ['src/contact.test.ts'], justification: null },
  docs: { paths: ['docs/user/contact.md'], justification: null },
  adrs: [],
  summary: 'Adds the contact form.',
};

async function tick(): Promise<string[]> {
  const result = await h.t.schedulerTick();
  expect(result.locked).toBe(true);
  return result.started.map((start) => `${start.kind} ${start.ticket} on ${start.machine}`);
}

async function queue(): Promise<QueueCandidate[]> {
  const response = await h.call('GET', '/api/queue');
  expect(response.statusCode, response.body).toBe(200);
  return QueueResponse.parse(response.json()).candidates;
}

async function reasonOf(number: number) {
  const found = (await queue()).find((candidate) => candidate.ticket.number === number);
  if (!found) throw new Error(`WEB-${String(number)} is not in the queue`);
  return found.reason;
}

/** The latest run of the ticket. */
async function latestRun(number = 1) {
  const ticket = await h.ticket(number);
  const [last] = await h.t.db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.ticketId, ticket.id))
    .orderBy(desc(schema.runs.createdAt))
    .limit(1);
  if (!last) throw new Error(`WEB-${String(number)} has no run`);
  return last;
}

function starts(daemon: ScriptedDaemon): RunStart[] {
  return daemon.received.filter((message): message is RunStart => message.type === 'run.start');
}

/** The `run.start` of a run the loop started. */
function startOf(daemon: ScriptedDaemon, runId: string): Promise<RunStart> {
  return daemon.find<RunStart>(
    (message) => message.type === 'run.start' && message.payload.runId === runId,
    'run.start',
  );
}

/** A run the loop started, acknowledged and working: its run token. */
async function working(daemon: ScriptedDaemon, runId: string, number = 1): Promise<string> {
  return (await h.working(daemon, runId, number)).runToken;
}

/** The run ends by itself on its idle timeout: a counted failure. */
async function idleTimeout(daemon: ScriptedDaemon, runId: string) {
  await h.report(daemon, state(runId, { state: 'ended', reason: 'idle_timeout' }));
  await eventually('the run failed', async () => {
    expect((await h.run(runId)).status).toBe('failed');
  });
}

function comments(ticket: TicketDetail) {
  return ticket.timeline.flatMap((entry) => (entry.type === 'comment' ? [entry.comment] : []));
}

async function runEvents(runId: string) {
  return h.t.db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.entityType, 'run'), eq(schema.events.entityId, runId)))
    .orderBy(asc(schema.events.id));
}

describe("the scheduler's loop (07, section 2)", () => {
  it('starts eligible tickets in order on an account of maximum 1, the next once the first ends', async () => {
    await h.start();
    await h.createTicket({ title: 'Contact form' });
    await h.createTicket({ title: 'Opening hours', priority: 'high' });
    const { daemon } = await h.machine('Laptop', 1);

    // High priority first; one run per account per pass, and the account is then full.
    expect(await tick()).toEqual(['implement WEB-2 on Laptop']);
    expect(await tick()).toEqual([]);
    const first = await latestRun(2);
    expect((await h.ticket(1)).status).toBe('todo');
    expect(await reasonOf(1)).toMatchObject({
      reason: 'no_machine',
      machines: [{ unavailable: { why: 'account_busy', maxConcurrentRuns: 1 } }],
    });

    // Who started it: the first message, the ticket's comment, the events' actor.
    const start = await startOf(daemon, first.id);
    expect(
      start.payload.initialPrompt.startsWith(`${SCHEDULER_LINE}\n\nImplement ticket WEB-2`),
    ).toBe(true);
    await working(daemon, first.id, 2);
    expect(comments(await h.ticket(2)).at(-1)).toMatchObject({
      author: 'system',
      kind: 'status_change',
      body: 'Started by the scheduler: attempt 1 on machine Laptop.',
    });
    const events = await runEvents(first.id);
    expect(events.find((event) => event.type === 'run.created')?.actor).toBe('system');
    expect(
      events.find(
        (event) =>
          event.type === 'run.status_changed' &&
          (event.payload as { to: string }).to === 'dispatched',
      ),
    ).toMatchObject({ actor: 'system', payload: { cause: 'scheduler' } });
    const [moved] = (await h.events('ticket.status_changed')).filter(
      (event) => (event.payload as { action: string }).action === 'scheduler_started',
    );
    expect(moved).toMatchObject({
      actor: 'system',
      payload: { ticket: 'WEB-2', to: 'in_progress' },
    });

    // Its end frees the account's place: WEB-1 starts with no owner action. WEB-2's counted
    // failure puts it behind WEB-1 (07, section 6).
    await idleTimeout(daemon, first.id);
    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    expect(starts(daemon)).toHaveLength(2);
  });

  it('retries a counted failure, then stops the ticket at Failed attempts before asking you', async () => {
    await h.start({ settings: { maxFailedAttempts: 2 } });
    await h.createTicket();
    const { daemon } = await h.machine();

    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    const first = await latestRun();
    await working(daemon, first.id);
    await idleTimeout(daemon, first.id);
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 1, stop: null });

    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    const second = await latestRun();
    expect((await startOf(daemon, second.id)).payload.initialPrompt).toContain(
      'This is attempt 2 at this ticket.',
    );
    await working(daemon, second.id);
    await idleTimeout(daemon, second.id);
    expect(await h.ticket()).toMatchObject({
      status: 'todo',
      attemptCount: 2,
      stop: { cause: 'failed_attempts', count: 2, limit: 2 },
    });

    // Stopped: it waits for the owner, and the loop starts nothing more.
    expect(await tick()).toEqual([]);
    expect(await reasonOf(1)).toMatchObject({ reason: 'ticket_stopped', count: 2, limit: 2 });
    expect(starts(daemon)).toHaveLength(2);
  });

  it('starts the review once Ready for review is offered, saying the scheduler started it', async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();
    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    const implement = await latestRun();
    const runToken = await working(daemon, implement.id);
    const answer = await h.tool(daemon, runToken, 'ticket_submit', REPORT, cleanWorkspace());
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    await h.ciPasses(daemon, implement.id);
    await eventually('the ticket in review', async () => {
      expect((await h.ticket()).status).toBe('in_review');
    });

    expect(await tick()).toEqual(['review WEB-1 on Laptop']);
    const review = await latestRun();
    expect(review.purpose).toBe('review');
    const start = await startOf(daemon, review.id);
    expect(start.payload.initialPrompt.startsWith(`${SCHEDULER_LINE}\n\nReview ticket WEB-1`)).toBe(
      true,
    );
    expect(comments(await h.ticket()).at(-1)).toMatchObject({
      author: 'system',
      kind: 'note',
      body: "Started by the scheduler: Quality's review of attempt 1 on machine Laptop.",
    });
    expect((await runEvents(review.id)).find((event) => event.type === 'run.created')?.actor).toBe(
      'system',
    );

    // A review the owner stops is not started again until Start review (07, section 1).
    await working(daemon, review.id);
    const stopped = await h.call('POST', `/api/runs/${review.id}/stop`);
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(await tick()).toEqual([]);
    expect(await reasonOf(1)).toEqual({ reason: 'held', cause: 'stop_review' });
    const again = await h.call('POST', '/api/projects/WEB/tickets/1/review');
    expect(again.statusCode, again.body).toBe(201);
  });

  it('starts nothing twice with two loops on one database, and nothing while another holds the lock', async () => {
    await h.start();
    for (const title of ['One', 'Two', 'Three']) await h.createTicket({ title });
    const { daemon } = await h.machine('Laptop', 2);

    // Another server instance's pass in progress: this one starts nothing.
    const other = await h.t.pool.connect();
    try {
      await other.query('SELECT pg_advisory_lock($1)', [SCHEDULER_LOCK]);
      expect(await h.t.schedulerTick()).toEqual({ locked: false, started: [] });
      await other.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK]);
    } finally {
      other.release();
    }
    expect(starts(daemon)).toHaveLength(0);

    // Two loops at once on the same database: the account's two places, each ticket once.
    const second = new Scheduler(schedulerOf(h.t.app).options);
    const first = schedulerOf(h.t.app);
    const ticks = await Promise.all([first.tick(), second.tick(), first.tick(), second.tick()]);
    await second.close();
    expect(ticks.flatMap((result) => result.started.map((start) => start.ticket)).sort()).toEqual([
      'WEB-1',
      'WEB-2',
    ]);
    const runs = await h.t.db.select().from(schema.runs);
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((run) => run.ticketId)).size).toBe(2);
  });
});

describe('what the loop never starts again in a loop', () => {
  it('a start the machine did not acknowledge: cancelled, not counted, never sent there again but by Run now', async () => {
    // One second of Machine answer timeout lasts 10 ms: 5 seconds, the least, in 50 ms.
    await h.start({ daemonSecondMs: 10, settings: { dispatchAckTimeoutSeconds: 5 } });
    await h.createTicket();
    const { daemon } = await h.machine();

    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    const lost = await latestRun();
    await eventually('the start cancelled', async () => {
      expect((await h.run(lost.id)).status).toBe('cancelled');
    });
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });

    // Left out for this ticket: the loop starts nothing, however often it runs.
    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    expect(await reasonOf(1)).toMatchObject({
      reason: 'no_machine',
      machines: [
        {
          machine: { name: 'Laptop' },
          unavailable: { why: 'left_out', cause: 'dispatch_timeout' },
        },
      ],
    });
    expect(starts(daemon)).toHaveLength(1);

    // Starts from here on are acknowledged in time: 600 seconds last 6 s.
    const longer = await h.call('PUT', '/api/settings/dispatchAckTimeoutSeconds', { value: 600 });
    expect(longer.statusCode, longer.body).toBe(200);

    // Another machine could take it: Laptop alone is left out.
    const desktop = await h.machine('Desktop', 1);
    const [next] = await queue();
    expect(next).toMatchObject({ reason: null, machine: { name: 'Desktop' } });
    await desktop.daemon.close();
    await eventually('Desktop offline', async () => {
      expect(await reasonOf(1)).toMatchObject({
        machines: [
          { machine: { name: 'Desktop' }, unavailable: { why: 'offline' } },
          { machine: { name: 'Laptop' }, unavailable: { why: 'left_out' } },
        ],
      });
    });

    // The owner's Run now releases Laptop for the ticket: after that run, the loop may use it.
    const ran = await h.call('POST', '/api/projects/WEB/tickets/1/run');
    expect(ran.statusCode, ran.body).toBe(201);
    const owners = Run.parse(ran.json());
    await working(daemon, owners.id);
    await idleTimeout(daemon, owners.id);
    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
  });

  it('a start the machine refused: the same', async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();

    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    const refused = await latestRun();
    const start = await startOf(daemon, refused.id);
    daemon.send({
      type: 'ack',
      id: start.id,
      payload: { ok: false, message: 'the daemon is stopping' },
    });
    await eventually('the start cancelled', async () => {
      expect((await h.run(refused.id)).status).toBe('cancelled');
    });
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });
    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    expect(await reasonOf(1)).toMatchObject({
      machines: [{ unavailable: { why: 'left_out', cause: 'dispatch_refused' } }],
    });
    expect(starts(daemon)).toHaveLength(1);
  });

  it("a stopped run's ticket: not started again until the owner's Run now", async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();

    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    const first = await latestRun();
    await working(daemon, first.id);
    const stopped = await h.call('POST', `/api/runs/${first.id}/stop`);
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect((await h.ticket()).status).toBe('todo');

    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    expect(await reasonOf(1)).toEqual({ reason: 'held', cause: 'stop_run' });
    expect(starts(daemon)).toHaveLength(1);

    // Run now starts it; once that run ends, the loop may start it again.
    const ran = await h.call('POST', '/api/projects/WEB/tickets/1/run');
    expect(ran.statusCode, ran.body).toBe(201);
    const owners = Run.parse(ran.json());
    await working(daemon, owners.id);
    await idleTimeout(daemon, owners.id);
    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
  });

  it('a ticket blocked by a cancelled ticket: never started, with what to do', async () => {
    await h.start();
    await h.createTicket({ title: 'First', assignee: null });
    await h.createTicket({ title: 'Second', blockedBy: [1] });
    await h.machine();
    const cancelled = await h.call('POST', '/api/projects/WEB/tickets/1/cancel');
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    expect(await tick()).toEqual([]);
    expect(await reasonOf(2)).toEqual({
      reason: 'blocked',
      tickets: ['WEB-1'],
      cancelled: ['WEB-1'],
    });
    const refused = await h.call('POST', '/api/projects/WEB/tickets/2/run');
    expect(refused.statusCode).toBe(409);
    expect(ApiError.parse(refused.json()).error.message).toBe(
      'Blocked by WEB-1 (cancelled): remove the dependency to let it start',
    );
  });
});

describe('when the loop runs by itself', () => {
  it('on a change: a new ticket starts with no tick from the test', async () => {
    // The interval at 30 seconds of 1,000 ms: only the change can start it within the deadline.
    await h.start({ scheduler: { timers: true, secondMs: 1000 } });
    const { daemon } = await h.machine();
    await h.createTicket();
    await eventually('the run started by the loop', () => {
      expect(starts(daemon)).toHaveLength(1);
    });
    expect((await h.ticket()).status).toBe('in_progress');
  });

  it('at its interval: a window that opens with no event starts the ticket', async () => {
    let clock = new Date('2026-10-20T21:00:00.000Z');
    // One second of Scheduler check interval lasts 10 ms: 5 seconds, the least, in 50 ms.
    await h.start({
      now: () => clock,
      settings: { schedulerTickSeconds: 5 },
      scheduler: { timers: true, secondMs: 10 },
    });
    const { daemon, account } = await h.machine();
    const saved = await h.call('PATCH', `/api/accounts/${account.id}`, {
      schedule: [{ days: ['tuesday'], start: '22:00', end: '23:00' }],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await h.createTicket();
    await eventually('the ticket waiting for the window', async () => {
      expect(await reasonOf(1)).toMatchObject({
        machines: [{ unavailable: { why: 'account_outside_window' } }],
      });
    });
    expect(starts(daemon)).toHaveLength(0);

    // The clock moves into the window: no event, the interval's tick starts it.
    clock = new Date('2026-10-20T22:00:30.000Z');
    await eventually('the run started by the loop', () => {
      expect(starts(daemon)).toHaveLength(1);
    });
  });
});
