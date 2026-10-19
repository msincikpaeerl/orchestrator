import { ApiError, QueueResponse, type QueueReason } from '@orchestrator/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { RunHarness } from './run-harness.js';

// The queue and **Run now** give the same reason in the same words for the same ticket (07,
// section 3; lot 4 step D1): both go through the checks of `scheduler/checks.ts`. With the real
// application, a scripted daemon and the fake GitHub.

const h = new RunHarness();

afterEach(async () => {
  await h.stop();
});

async function queue(): Promise<QueueResponse> {
  const response = await h.call('GET', '/api/queue');
  expect(response.statusCode, response.body).toBe(200);
  return QueueResponse.parse(response.json());
}

async function queueReason(number: number): Promise<QueueReason | null> {
  const found = (await queue()).candidates.find(
    (candidate) => candidate.ticket.projectKey === 'WEB' && candidate.ticket.number === number,
  );
  if (!found) throw new Error(`WEB-${String(number)} is not in the queue`);
  return found.reason;
}

/** Run now's refusal, which the queue must give too. */
async function sameReason(number: number): Promise<QueueReason> {
  const response = await h.call('POST', `/api/projects/WEB/tickets/${String(number)}/run`);
  expect(response.statusCode, response.body).toBe(409);
  const refusal = ApiError.parse(response.json()).error.runRefusal;
  if (!refusal) throw new Error('no runRefusal');
  expect(await queueReason(number)).toEqual(refusal);
  return refusal;
}

describe('the queue and Run now (07, section 3)', () => {
  it('refuse for the same reasons, and the queue starts nothing', async () => {
    await h.start();
    const { account, daemon } = await h.machine('Laptop', 1);
    await h.createTicket({ title: 'First', assignee: null });
    await h.createTicket({ title: 'Second', blockedBy: [1] });
    await h.createTicket({ title: 'Third' });
    await h.createTicket({ title: 'Fourth' });

    expect((await sameReason(1)).reason).toBe('no_assignee');
    expect(await sameReason(2)).toEqual({ reason: 'blocked', tickets: ['WEB-1'] });
    // Ticket 3 is next and can start; reading the queue twice started nothing.
    expect(await queueReason(3)).toBeNull();
    expect((await queue()).candidates.find((c) => c.ticket.number === 3)?.machine?.name).toBe(
      'Laptop',
    );
    expect((await h.ticket(3)).status).toBe('todo');

    // Stop new runs: both name the paused account on the machine.
    const paused = await h.call('POST', `/api/accounts/${account.id}/stop-new-runs`);
    expect(paused.statusCode, paused.body).toBe(200);
    expect(await sameReason(3)).toMatchObject({
      reason: 'no_machine',
      machines: [{ unavailable: { why: 'account_paused' } }],
    });
    expect((await queue()).accounts[0]?.unavailable).toMatchObject({ why: 'account_paused' });
    const resumed = await h.call('POST', `/api/accounts/${account.id}/resume`);
    expect(resumed.statusCode, resumed.body).toBe(200);

    // The account's one place taken: both say it runs its maximum.
    await h.running(daemon, 3);
    expect(await sameReason(4)).toMatchObject({
      reason: 'no_machine',
      machines: [{ unavailable: { why: 'account_busy', maxConcurrentRuns: 1 } }],
    });

    // The machine gone: both say it is offline.
    await daemon.close();
    await expect
      .poll(async () => (await queue()).candidates.find((c) => c.ticket.number === 4)?.reason)
      .toMatchObject({ machines: [{ unavailable: { why: 'offline' } }] });
    expect(await sameReason(4)).toMatchObject({
      reason: 'no_machine',
      machines: [{ unavailable: { why: 'offline' } }],
    });
  });

  it('is read only by the owner', async () => {
    await h.start();
    const response = await h.t.app.inject({ method: 'GET', url: '/api/queue' });
    expect(response.statusCode).toBe(401);
  });
});
