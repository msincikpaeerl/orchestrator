import { schema } from '@orchestrator/db';
import {
  ApiError,
  NeedsYouResponse,
  TicketListResponse,
  type NeedsYouItem,
  type TicketDetail,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import { RunHarness, eventually, state } from './run-harness.js';

// The stop after failed attempts (04, section 5; owner's answer 3, lot 3 step K): a counted
// failure that brings the ticket's failed attempts to **Failed attempts before asking you** stops
// it, as step I's stop after review rounds; **Try again** lets it continue.

const h = new RunHarness();

afterEach(async () => {
  await h.stop();
});

function comments(ticket: TicketDetail) {
  return ticket.timeline.flatMap((entry) => (entry.type === 'comment' ? [entry.comment] : []));
}

async function items(): Promise<NeedsYouItem[]> {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items;
}

/** Run now, then the run ends by itself with the idle timeout: a counted failure. */
async function timedOut(daemon: ScriptedDaemon) {
  const run = await h.running(daemon);
  await h.report(daemon, state(run.runId, { state: 'ended', reason: 'idle_timeout' }));
  await eventually('the run failed', async () => {
    expect((await h.run(run.runId)).status).toBe('failed');
  });
  return run;
}

const STOPPED =
  'It counts as a failed attempt: 2 failed attempts, as many as Failed attempts before asking you allows (2), so the ticket is stopped. Use Try again to let it continue, or Cancel it, or Mark it as done manually.';

describe('Failed attempts before asking you', () => {
  it('stops the ticket at the limit, refuses Run now, lists it; Try again lets it continue', async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();

    await timedOut(daemon);
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 1, stop: null });
    expect(comments(await h.ticket()).at(-1)?.body).toContain('It counts as a failed attempt. ');

    const second = await timedOut(daemon);
    const ticket = await h.ticket();
    expect(ticket).toMatchObject({
      status: 'todo',
      attemptCount: 2,
      stop: { cause: 'failed_attempts', count: 2, limit: 2 },
    });
    // One comment: the failure's, saying it stopped the ticket.
    expect(comments(ticket).at(-1)).toMatchObject({
      author: 'system',
      kind: 'status_change',
      body: `Attempt 2 failed on machine Laptop: it ran out of time. ${STOPPED} The branch t/1-contact-form is kept on that machine.`,
    });
    expect((await h.events('ticket.stopped')).at(-1)?.payload).toMatchObject({
      ticket: 'WEB-1',
      cause: 'failed_attempts',
      count: 2,
      limit: 2,
      runId: second.runId,
    });
    const board = await h.call('GET', '/api/projects/WEB/tickets');
    expect(TicketListResponse.parse(board.json()).tickets[0]?.stop).toMatchObject({
      cause: 'failed_attempts',
      count: 2,
      limit: 2,
    });

    // Run now refuses, naming the setting's value; "Needs you" lists it.
    const refused = await h.call('POST', '/api/projects/WEB/tickets/1/run');
    expect(refused.statusCode).toBe(409);
    expect(ApiError.parse(refused.json()).error).toMatchObject({
      code: 'run_not_possible',
      runRefusal: { reason: 'ticket_stopped', cause: 'failed_attempts', count: 2, limit: 2 },
    });
    expect((await items()).filter((item) => item.type === 'ticket_stopped')).toEqual([
      {
        type: 'ticket_stopped',
        ticket: { projectKey: 'WEB', number: 1, title: 'Contact form' },
        cause: 'failed_attempts',
        count: 2,
        limit: 2,
        since: expect.any(String) as string,
      },
    ]);

    // Try again: the counts start again, with the owner's comment; Run now starts a run.
    const tried = await h.call('POST', '/api/projects/WEB/tickets/1/try-again');
    expect(tried.statusCode, tried.body).toBe(200);
    const after = await h.ticket();
    expect(after).toMatchObject({ status: 'todo', attemptCount: 0, reviewRounds: 0, stop: null });
    expect(comments(after).at(-1)).toMatchObject({
      author: 'owner',
      kind: 'status_change',
      body: 'The owner used Try again: the ticket was stopped after 2 failed attempts (Failed attempts before asking you: 2). Its failed attempts and review rounds count from 0 again.',
    });
    expect((await items()).some((item) => item.type === 'ticket_stopped')).toBe(false);
    expect(await h.events('ticket.tried_again')).toHaveLength(1);
    await timedOut(daemon);
    expect(await h.ticket()).toMatchObject({ attemptCount: 1, stop: null });
  });

  it('never stops for a failure that is not counted', async () => {
    await h.start({ settings: { maxFailedAttempts: 1 } });
    await h.createTicket();
    const { daemon } = await h.machine();
    const run = await h.running(daemon);
    const stopped = await h.call('POST', `/api/runs/${run.runId}/stop`);
    expect(stopped.statusCode, stopped.body).toBe(200);
    await eventually('the run cancelled', async () => {
      expect((await h.run(run.runId)).status).toBe('cancelled');
    });
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 0, stop: null });
    expect(await h.events('ticket.stopped')).toEqual([]);
  });

  it('reads the setting at the failure: a ticket left over it by 0.3.0 stops at its next counted failure', async () => {
    await h.start();
    const created = await h.createTicket();
    // 0.3.0 counted failed attempts without stopping: no migration stops such a ticket.
    await h.t.db
      .update(schema.tickets)
      .set({ attemptCount: 3 })
      .where(eq(schema.tickets.id, created.id));
    const { daemon } = await h.machine();
    await timedOut(daemon);
    expect((await h.ticket()).stop).toMatchObject({
      cause: 'failed_attempts',
      count: 4,
      limit: 2,
    });
    expect(comments(await h.ticket()).at(-1)?.body).toContain(
      'It counts as a failed attempt: 4 failed attempts, more than Failed attempts before asking you allows (2), so the ticket is stopped.',
    );
  });
});
