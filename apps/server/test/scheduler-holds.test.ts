import { randomUUID } from 'node:crypto';
import { schema } from '@orchestrator/db';
import {
  NeedsYouResponse,
  QueueResponse,
  Run,
  TicketListResponse,
  TicketMachineFailures,
  type DodReport,
  type QueueCandidate,
  type RunStart,
} from '@orchestrator/protocol';
import { and, desc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import { RunHarness, cleanWorkspace, eventually, state } from './run-harness.js';

// The held ticket and the failures a machine caused (07, sections 1 and 4; lot 4 step D2b), with
// the real application, scripted daemons and the fake GitHub: what the scheduler never starts
// again in a loop, what releases it, and the "Needs you" item after repeated machine failures.
// The application's clock runs ahead of the real one when a test moves it (`later`), so a
// reconnection always comes after the failure it releases.

const h = new RunHarness();
let ahead = 0;

afterEach(async () => {
  await h.stop();
  ahead = 0;
});

const clock = () => new Date(Date.now() + ahead);
/** A minute passes on the application's clock. */
const later = () => {
  ahead += 60_000;
};

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

async function reasonOf(number = 1) {
  const response = await h.call('GET', '/api/queue');
  expect(response.statusCode, response.body).toBe(200);
  const found = QueueResponse.parse(response.json()).candidates.find(
    (candidate: QueueCandidate) => candidate.ticket.number === number,
  );
  if (!found) throw new Error(`WEB-${String(number)} is not in the queue`);
  return found.reason;
}

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

async function ticketRow(number = 1) {
  const [row] = await h.t.db.select().from(schema.tickets).where(eq(schema.tickets.number, number));
  if (!row) throw new Error(`no WEB-${String(number)}`);
  return row;
}

async function failuresOf(number = 1) {
  return TicketMachineFailures.parse((await ticketRow(number)).machineFailures);
}

function startOf(daemon: ScriptedDaemon, runId: string): Promise<RunStart> {
  return daemon.find<RunStart>(
    (message) => message.type === 'run.start' && message.payload.runId === runId,
    'run.start',
  );
}

function starts(daemon: ScriptedDaemon): RunStart[] {
  return daemon.received.filter((message): message is RunStart => message.type === 'run.start');
}

async function ended(runId: string, status: 'cancelled' | 'failed') {
  await eventually(`the run ${status}`, async () => {
    expect((await h.run(runId)).status).toBe(status);
  });
}

/** The machine connects again (`hello`) a minute later: a new connection with its token. */
async function reconnect(daemon: ScriptedDaemon, token: string, machineId: string) {
  await daemon.close();
  await eventually('the machine offline', async () => {
    const [row] = await h.t.db
      .select({ status: schema.machines.status })
      .from(schema.machines)
      .where(eq(schema.machines.id, machineId));
    expect(row?.status).toBe('offline');
  });
  later();
  return h.connect(token);
}

async function needsYou() {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items;
}

async function owners(path: string, payload?: object) {
  const response = await h.call('POST', `/api/projects/WEB/tickets/1/${path}`, payload);
  expect(response.statusCode, response.body).toBeLessThan(300);
  return response;
}

describe('the held ticket (07, section 1)', () => {
  it('Stop run holds it, with its event and badge; the loop never starts it; Run now releases it', async () => {
    await h.start({ now: clock });
    await h.createTicket();
    const { daemon } = await h.machine();

    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    const first = await latestRun();
    await h.working(daemon, first.id);
    const stopped = await h.call('POST', `/api/runs/${first.id}/stop`);
    expect(stopped.statusCode, stopped.body).toBe(200);

    const held = await h.ticket();
    expect(held).toMatchObject({
      status: 'todo',
      held: { cause: 'stop_run', runId: first.id, commit: null },
    });
    const board = TicketListResponse.parse(
      (await h.call('GET', '/api/projects/WEB/tickets')).json(),
    );
    expect(board.tickets[0]?.held).toMatchObject({ cause: 'stop_run' });
    expect(await h.events('ticket.held')).toMatchObject([
      { actor: 'owner', payload: { ticket: 'WEB-1', cause: 'stop_run', runId: first.id } },
    ]);

    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    expect(await reasonOf()).toEqual({ reason: 'held', cause: 'stop_run' });
    expect(starts(daemon)).toHaveLength(1);

    const ran = Run.parse((await owners('run')).json());
    expect((await h.ticket()).held).toBeNull();
    expect(await h.events('ticket.released')).toMatchObject([
      { actor: 'owner', payload: { ticket: 'WEB-1', cause: 'stop_run', action: 'run_now' } },
    ]);
    await h.working(daemon, ran.id);
    await h.report(daemon, state(ran.id, { state: 'ended', reason: 'idle_timeout' }));
    await ended(ran.id, 'failed');
    // Released: its next run is the loop's again.
    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
  });

  it('Request changes with its hold box holds the fix until Run now; without it, the loop starts the fix', async () => {
    await h.start({ now: clock });
    await h.createTicket();
    const { daemon } = await h.machine('Laptop', 2);

    async function inReview(number: number) {
      expect(await tick()).toEqual([`implement WEB-${String(number)} on Laptop`]);
      const run = await latestRun(number);
      const { runToken } = await h.working(daemon, run.id, number);
      const answer = await h.tool(daemon, runToken, 'ticket_submit', REPORT, cleanWorkspace());
      expect(answer.ok, JSON.stringify(answer)).toBe(true);
      await h.ciPasses(daemon, run.id);
      await eventually('the ticket in review', async () => {
        expect((await h.ticket(number)).status).toBe('in_review');
      });
    }

    // Checked: held, and the loop leaves it.
    await inReview(1);
    const requested = await h.call('POST', '/api/projects/WEB/tickets/1/request-changes', {
      comment: 'Ask for a phone number too.',
      hold: true,
    });
    expect(requested.statusCode, requested.body).toBe(200);
    expect(await h.ticket()).toMatchObject({
      status: 'todo',
      held: { cause: 'request_changes', runId: null },
    });
    expect(await h.events('ticket.held')).toMatchObject([
      { payload: { cause: 'request_changes', runId: null } },
    ]);

    // Unchecked (the default): the loop starts the fix by itself.
    await h.createTicket({ title: 'Opening hours' });
    await inReview(2);
    const unheld = await h.call('POST', '/api/projects/WEB/tickets/2/request-changes', {
      comment: 'Show Sunday too.',
    });
    expect(unheld.statusCode, unheld.body).toBe(200);
    expect((await h.ticket(2)).held).toBeNull();
    expect(await tick()).toEqual(['fix_review WEB-2 on Laptop']);
    expect(await tick()).toEqual([]);
    expect(await reasonOf(1)).toEqual({ reason: 'held', cause: 'request_changes' });

    // Run now releases it and starts the fix.
    const ran = Run.parse((await owners('run')).json());
    expect(ran.purpose).toBe('fix_review');
    expect((await h.ticket()).held).toBeNull();
    expect(await h.events('ticket.released')).toMatchObject([
      { payload: { ticket: 'WEB-1', cause: 'request_changes', action: 'run_now' } },
    ]);
  });
});

describe('failures the machine caused (07, section 4)', () => {
  it('a start not confirmed: left out until it connects again, then the item after a second one', async () => {
    // One second of Machine answer timeout lasts 10 ms: 5 seconds, the least, in 50 ms.
    await h.start({
      now: clock,
      daemonSecondMs: 10,
      settings: { dispatchAckTimeoutSeconds: 5 },
    });
    await h.createTicket();
    const laptop = await h.machine();

    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    await ended((await latestRun()).id, 'cancelled');
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });

    // Left out: the loop starts nothing, however often it runs.
    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    expect(await reasonOf()).toMatchObject({
      reason: 'no_machine',
      machines: [{ unavailable: { why: 'left_out', cause: 'dispatch_timeout' } }],
    });
    expect(starts(laptop.daemon)).toHaveLength(1);
    expect((await needsYou()).some((item) => item.type === 'machine_failures')).toBe(false);

    // It connects again: released, so the loop tries it once more.
    const again = await reconnect(laptop.daemon, laptop.token, laptop.id);
    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    await ended((await latestRun()).id, 'cancelled');

    // Two in a row (Machine failures before asking you, 2 by default): the blocking item.
    const items = await needsYou();
    expect(items.find((item) => item.type === 'machine_failures')).toMatchObject({
      ticket: { projectKey: 'WEB', number: 1 },
      machine: { name: 'Laptop' },
      failures: [{ cause: 'dispatch_timeout' }, { cause: 'dispatch_timeout' }],
      limit: 2,
    });
    expect(await h.events('ticket.could_not_start')).toMatchObject([
      {
        actor: 'system',
        payload: { ticket: 'WEB-1', machine: 'Laptop', count: 2, limit: 2 },
      },
    ]);
    expect(await reasonOf()).toMatchObject({
      reason: 'needs_you',
      item: 'machine_failures',
      machine: { name: 'Laptop' },
    });
    // A reconnection releases the machine but not the item.
    const third = await reconnect(again, laptop.token, laptop.id);
    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    expect(starts(third)).toHaveLength(0);

    // The owner's Run now: the item gone, every failure forgotten.
    await owners('run');
    expect(await failuresOf()).toEqual([]);
    expect((await needsYou()).some((item) => item.type === 'machine_failures')).toBe(false);
  });

  it('a start refused, with Machine failures before asking you at 1: the item at once', async () => {
    await h.start({ now: clock, settings: { maxMachineFailures: 1 } });
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
    await ended(refused.id, 'cancelled');
    expect((await needsYou()).find((item) => item.type === 'machine_failures')).toMatchObject({
      failures: [{ cause: 'dispatch_refused' }],
      limit: 1,
    });
    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    expect(starts(daemon)).toHaveLength(1);
  });

  it('machine_offline: its answer could not reach it; left out until it connects again', async () => {
    await h.start({ now: clock });
    await h.createTicket();
    const laptop = await h.machine();

    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    const asking = await latestRun();
    const { runToken } = await h.working(laptop.daemon, asking.id);
    await h.ok(laptop.daemon, runToken, 'ticket_ask', { question: 'Which address?' });
    await h.report(laptop.daemon, state(asking.id, { state: 'waiting_human' }));
    await laptop.daemon.close();
    await eventually('the machine offline', async () => {
      const [row] = await h.t.db
        .select({ status: schema.machines.status })
        .from(schema.machines)
        .where(eq(schema.machines.id, laptop.id));
      expect(row?.status).toBe('offline');
    });
    // The answer finds its machine offline: the run fails, not counted (04, section 6).
    await owners('answer', { body: 'hello@bakery.example' });
    await ended(asking.id, 'failed');
    expect((await h.run(asking.id)).failureReason).toBe('machine_offline');
    expect(await failuresOf()).toMatchObject([
      { machineId: laptop.id, failures: [{ cause: 'machine_offline' }], asked: null },
    ]);

    later();
    const back = await h.connect(laptop.token);
    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    expect(starts(back)).toHaveLength(1);
  });

  it('machine_revoked: never on that machine again, the item after Machine failures before asking you', async () => {
    await h.start({ now: clock, settings: { maxMachineFailures: 1 } });
    await h.createTicket();
    const laptop = await h.machine();

    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    const run = await latestRun();
    await h.working(laptop.daemon, run.id);
    const revoked = await h.call('POST', `/api/machines/${laptop.id}/revoke`);
    expect(revoked.statusCode, revoked.body).toBe(200);
    await ended(run.id, 'failed');
    expect((await h.run(run.id)).failureReason).toBe('machine_revoked');
    expect(await failuresOf()).toMatchObject([
      { machineId: laptop.id, failures: [{ cause: 'machine_revoked' }] },
    ]);
    expect((await needsYou()).find((item) => item.type === 'machine_failures')).toMatchObject({
      machine: { name: 'Laptop' },
      failures: [{ cause: 'machine_revoked' }],
    });
    expect(await tick()).toEqual([]);
  });

  it('claude_code_unsupported: unusable, then released by a hello with a supported version', async () => {
    await h.start({ now: clock });
    await h.createTicket();
    const laptop = await h.machine();

    async function tooOld(daemon: ScriptedDaemon) {
      expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
      const run = await latestRun();
      const start = await startOf(daemon, run.id);
      daemon.send({ type: 'ack', id: start.id, payload: { ok: true } });
      await h.report(daemon, state(run.id, { state: 'preparing' }));
      await h.report(daemon, state(run.id, { state: 'starting', claudeCodeVersion: '2.1.100' }));
      await ended(run.id, 'failed');
      expect((await h.run(run.id)).failureReason).toBe('claude_code_unsupported');
    }

    await tooOld(laptop.daemon);
    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    expect(await reasonOf()).toMatchObject({
      machines: [{ unavailable: { why: 'unusable' } }],
    });

    // Updated, it connects again: released; the same failure again gives the item.
    const updated = await reconnect(laptop.daemon, laptop.token, laptop.id);
    await tooOld(updated);
    expect(await failuresOf()).toMatchObject([
      {
        failures: [{ cause: 'claude_code_unsupported' }, { cause: 'claude_code_unsupported' }],
        asked: { limit: 2 },
      },
    ]);
    const again = await reconnect(updated, laptop.token, laptop.id);
    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    expect(starts(again)).toHaveLength(0);
  });

  it('launch_failed: never counted, the machine left out, two in a row give the item (lot 5 step 5bis C)', async () => {
    await h.start({ now: clock });
    await h.createTicket();
    const laptop = await h.machine();

    async function notLaunched(daemon: ScriptedDaemon) {
      expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
      const run = await latestRun();
      const start = await startOf(daemon, run.id);
      daemon.send({ type: 'ack', id: start.id, payload: { ok: true } });
      await h.report(daemon, state(run.id, { state: 'preparing' }));
      await h.report(
        daemon,
        state(run.id, {
          state: 'ended',
          reason: 'launch_failed',
          detail:
            "Claude Code could not be started on this machine (tmux new-session failed: no server running). Running it again on this machine will not help until that is fixed, and it is not the ticket's fault.",
        }),
      );
      await ended(run.id, 'failed');
      expect((await h.run(run.id)).failureReason).toBe('machine_problem');
    }

    await notLaunched(laptop.daemon);
    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    expect(await reasonOf()).toMatchObject({
      reason: 'machine_unavailable',
      machine: { name: 'Laptop' },
      unavailable: { why: 'left_out', cause: 'machine_problem' },
    });
    expect(await failuresOf()).toMatchObject([
      { machineId: laptop.id, failures: [{ cause: 'machine_problem' }], asked: null },
    ]);

    // Connected again, it takes the ticket; the same failure again gives the item.
    const again = await reconnect(laptop.daemon, laptop.token, laptop.id);
    await notLaunched(again);
    expect(await failuresOf()).toMatchObject([
      {
        failures: [{ cause: 'machine_problem' }, { cause: 'machine_problem' }],
        asked: { limit: 2 },
      },
    ]);
    expect((await needsYou()).find((item) => item.type === 'machine_failures')).toMatchObject({
      machine: { name: 'Laptop' },
    });
    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    expect((await ticketRow()).attemptCount).toBe(0);
  });

  it('machine_problem: a start sent before its doctor report is refused and does not loop', async () => {
    await h.start({ now: clock });
    await h.createTicket();
    const laptop = await h.machine();

    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    const first = await latestRun();
    await h.working(laptop.daemon, first.id);
    await h.report(
      laptop.daemon,
      state(first.id, {
        state: 'ended',
        reason: 'process_scope_failed',
        detail: "Claude Code could not be started in the run's process scope (Access denied)",
      }),
    );
    await ended(first.id, 'failed');
    expect((await h.run(first.id)).failureReason).toBe('machine_problem');
    // The ticket's commits are on Laptop only: it waits for Laptop, saying why.
    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    expect(await reasonOf()).toMatchObject({
      reason: 'machine_unavailable',
      machine: { name: 'Laptop' },
      unavailable: { why: 'left_out', cause: 'machine_problem' },
    });

    // The owner's Run now before the daemon's doctor report: the daemon refuses the start, as it
    // refuses every start while the error stands, and the loop does not send it again.
    const ran = Run.parse((await owners('run')).json());
    const start = await startOf(laptop.daemon, ran.id);
    laptop.daemon.send({
      type: 'ack',
      id: start.id,
      payload: { ok: false, message: 'process scopes cannot be created on this machine' },
    });
    await ended(ran.id, 'cancelled');
    for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
    expect(starts(laptop.daemon)).toHaveLength(2);
    expect(await failuresOf()).toMatchObject([
      { failures: [{ cause: 'dispatch_refused' }], asked: null },
    ]);

    // The doctor report makes it unusable until the daemon restarts.
    const answer = await laptop.daemon.request({
      type: 'machine.doctor',
      id: randomUUID(),
      payload: {
        doctor: [
          {
            name: 'Process scopes',
            status: 'error',
            message: 'Process scopes cannot be created (Access denied)',
            link: null,
          },
        ],
      },
    });
    expect(answer).toMatchObject({ type: 'ack' });
    expect(await reasonOf()).toMatchObject({ unavailable: { why: 'unusable' } });

    // Restarted with the error fixed: released, and the loop starts it on Laptop.
    const restarted = await reconnect(laptop.daemon, laptop.token, laptop.id);
    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    expect(starts(restarted)).toHaveLength(1);
    const runs = await h.t.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(eq(schema.runs.machineId, laptop.id)));
    expect(runs).toHaveLength(3);
  });
});

describe('a run ending otherwise starts the counts again', () => {
  it('a counted failure between two machine failures: no item', async () => {
    await h.start({
      now: clock,
      daemonSecondMs: 10,
      settings: { dispatchAckTimeoutSeconds: 5, maxFailedAttempts: 5 },
    });
    await h.createTicket();
    const laptop = await h.machine();

    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    await ended((await latestRun()).id, 'cancelled');
    expect(await failuresOf()).toHaveLength(1);

    // Released by a reconnection, a run that starts and ends on its idle timeout; starts are
    // acknowledged in time meanwhile (600 seconds last 6 s).
    const longer = await h.call('PUT', '/api/settings/dispatchAckTimeoutSeconds', { value: 600 });
    expect(longer.statusCode, longer.body).toBe(200);
    const back = await reconnect(laptop.daemon, laptop.token, laptop.id);
    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    const counted = await latestRun();
    await h.working(back, counted.id);
    await h.report(back, state(counted.id, { state: 'ended', reason: 'idle_timeout' }));
    await ended(counted.id, 'failed');
    expect(await failuresOf()).toEqual([]);

    // The next start not confirmed is the first of a new row: left out, no item.
    const shorter = await h.call('PUT', '/api/settings/dispatchAckTimeoutSeconds', { value: 5 });
    expect(shorter.statusCode, shorter.body).toBe(200);
    expect(await tick()).toEqual(['implement WEB-1 on Laptop']);
    await ended((await latestRun()).id, 'cancelled');
    expect(await failuresOf()).toMatchObject([{ failures: [{ cause: 'dispatch_timeout' }] }]);
    expect((await needsYou()).some((item) => item.type === 'machine_failures')).toBe(false);
  });
});
