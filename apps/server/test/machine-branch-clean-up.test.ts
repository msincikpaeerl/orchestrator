import { schema } from '@orchestrator/db';
import {
  type BranchDelete,
  type BranchDeleteAnswer,
  type DodReport,
  type MachineBranchCleanUp,
  type RunStop,
} from '@orchestrator/protocol';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ScriptedDaemon } from './daemon-client.js';
import { RunHarness, eventually, state } from './run-harness.js';

// The clean-up after a merge on the machines (05, section 4.11; lot 3 step J2b), with the fake
// GitHub and scripted daemons: `branch.delete` goes to each machine whose runs had the branch,
// once its runs of the ticket reported their end and while it is connected; the same message (the
// same id) again until it answers; each answer stored once on the machine's row, with its event.

const h = new RunHarness();
/** How far the application's clock is ahead of the real one. */
let ahead = 0;

afterEach(async () => {
  ahead = 0;
  await h.stop();
});

const BRANCH = 't/1-contact-form';
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

const repo = () => h.github.repository('octo-owner', 'bakery');

/** Ticket 1 implemented on Laptop, its run ended, CI passed: in review with #1 open. */
async function inReview() {
  await h.start({ now: () => new Date(Date.now() + ahead) });
  await h.createTicket();
  const machine = await h.machine();
  const run = await h.running(machine.daemon);
  const answer = await h.tool(machine.daemon, run.runToken, 'ticket_submit', REPORT);
  if (!answer.ok) throw new Error(JSON.stringify(answer.error));
  await h.ciPasses(machine.daemon, run.runId);
  await eventually('the ticket in review', async () => {
    expect((await h.ticket()).status).toBe('in_review');
  });
  return { ...machine, run, head: h.lastPushed ?? '' };
}

const deletes = (daemon: ScriptedDaemon) =>
  daemon.received.filter((message): message is BranchDelete => message.type === 'branch.delete');

function deleteOf(daemon: ScriptedDaemon): Promise<BranchDelete> {
  return daemon.find<BranchDelete>((message) => message.type === 'branch.delete', 'branch.delete');
}

async function machines(): Promise<MachineBranchCleanUp[]> {
  return (await h.ticket()).branchCleanUp?.machines ?? [];
}

async function answered(daemon: ScriptedDaemon, id: string, answer: BranchDeleteAnswer) {
  daemon.send({ type: 'branch.delete_result', id, payload: answer });
  await eventually('the answer stored', async () => {
    expect((await machines())[0]?.state).not.toBe('wanted');
  });
}

async function events() {
  return (await h.events('ticket.machine_branch_')).map((event) => ({
    type: event.type,
    payload: event.payload,
  }));
}

async function offline(id: string, daemon: ScriptedDaemon) {
  await daemon.close();
  await eventually('the machine offline', async () => {
    const [row] = await h.t.db.select().from(schema.machines).where(eq(schema.machines.id, id));
    expect(row?.status).toBe('offline');
  });
}

describe('the local branch deleted on the machines after a merge', () => {
  it('sends branch.delete at the check that found the merge, with the facts the daemon checks', async () => {
    const { daemon, head } = await inReview();
    h.github.mergePullRequest(repo(), 1, 'squash');
    await h.t.ciTick();
    const message = await deleteOf(daemon);
    expect(message.payload).toEqual({
      repository: { owner: 'octo-owner', name: 'bakery' },
      ticket: 'WEB-1',
      branch: BRANCH,
      mergedHead: head,
    });
    expect(await machines()).toMatchObject([
      { machine: { name: 'Laptop' }, state: 'wanted', waiting: 'answer', reason: null },
    ]);
    await answered(daemon, message.id, { outcome: 'deleted' });
    const [row] = await machines();
    expect(row).toMatchObject({ state: 'deleted', waiting: null, reason: null });
    expect(row?.decidedAt).not.toBeNull();
    expect(await events()).toEqual([
      {
        type: 'ticket.machine_branch_deleted',
        payload: {
          project: 'WEB',
          ticket: 'WEB-1',
          branch: BRANCH,
          pullRequest: 1,
          head,
          machine: 'Laptop',
          notFound: null,
        },
      },
    ]);
  });

  const answers: [string, BranchDeleteAnswer, Partial<MachineBranchCleanUp>][] = [
    [
      'not found',
      { outcome: 'not_found', what: 'branch' },
      { state: 'already_gone', reason: null },
    ],
    [
      'kept with its head',
      { outcome: 'kept', head: 'c'.repeat(40) },
      { state: 'kept', reason: { kind: 'local_head_differs', head: 'c'.repeat(40) } },
    ],
    [
      'in use by a worktree',
      { outcome: 'in_use', by: 'worktree' },
      { state: 'kept', reason: { kind: 'in_use', by: 'worktree' } },
    ],
    [
      'not a ticket branch',
      { outcome: 'not_a_ticket_branch' },
      { state: 'kept', reason: { kind: 'not_a_ticket_branch' } },
    ],
  ];

  it.each(answers)('stores the answer %s on the row, with its event', async (_, answer, row) => {
    const { daemon } = await inReview();
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    const message = await deleteOf(daemon);
    await answered(daemon, message.id, answer);
    expect(await machines()).toMatchObject([{ ...row, waiting: null }]);
    const [event] = await events();
    if (answer.outcome === 'not_found') {
      expect(event).toMatchObject({
        type: 'ticket.machine_branch_deleted',
        payload: { machine: 'Laptop', notFound: 'branch' },
      });
    } else {
      expect(event).toMatchObject({
        type: 'ticket.machine_branch_kept',
        payload: { machine: 'Laptop', reason: row.reason },
      });
    }
  });

  it('sends the same message again after Machine answer timeout, and applies its answer once', async () => {
    const { daemon } = await inReview();
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    const first = await deleteOf(daemon);
    await h.t.ciTick();
    expect(deletes(daemon)).toHaveLength(1);
    // Machine answer timeout (60 seconds by default) passed without an answer.
    ahead = 61_000;
    await h.t.ciTick();
    expect(deletes(daemon).map((message) => message.id)).toEqual([first.id, first.id]);
    expect(deletes(daemon)[1]).toEqual(first);

    // An answer to a message never sent changes nothing; two answers to it, one decision.
    daemon.send({
      type: 'branch.delete_result',
      id: randomUUID(),
      payload: { outcome: 'deleted' },
    });
    await answered(daemon, first.id, { outcome: 'deleted' });
    daemon.send({
      type: 'branch.delete_result',
      id: first.id,
      payload: { outcome: 'kept', head: 'c'.repeat(40) },
    });
    ahead = 200_000;
    await h.t.ciTick();
    expect(await events()).toHaveLength(1);
    expect(await machines()).toMatchObject([{ state: 'deleted' }]);
    expect(deletes(daemon)).toHaveLength(2);
  });

  it('waits for the end of the run the merge stopped, then sends at its end report', async () => {
    const { daemon } = await inReview();
    const skipped = await h.call('POST', '/api/projects/WEB/tickets/1/skip-review');
    expect(skipped.statusCode, skipped.body).toBe(200);
    const asked = await h.call('POST', '/api/projects/WEB/tickets/1/request-changes', {
      comment: 'Add the opening hours.',
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const fix = await h.running(daemon);
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    await daemon.find<RunStop>(
      (message) => message.type === 'run.stop' && message.payload.runId === fix.runId,
      'run.stop',
    );
    await h.t.ciTick();
    expect(deletes(daemon)).toEqual([]);
    expect(await machines()).toMatchObject([{ state: 'wanted', waiting: 'runs_ending' }]);
    // The end report sends it, without waiting for the next check.
    await h.report(daemon, state(fix.runId, { state: 'ended', reason: 'stopped' }));
    const message = await deleteOf(daemon);
    expect(message.payload.branch).toBe(BRANCH);
  });

  it('sends to an offline machine at its reconnection, and the same message again after a lost connection', async () => {
    const { daemon, id, token } = await inReview();
    await offline(id, daemon);
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    await h.t.ciTick();
    const [waiting] = await machines();
    expect(waiting).toMatchObject({ state: 'wanted', waiting: 'offline', sentAt: null });
    expect(waiting?.offlineSince).not.toBeNull();

    const back = await h.connect(token);
    const first = await deleteOf(back);
    // Lost with the connection before any answer: at the next reconnection, at once, the same.
    await offline(id, back);
    const again = await h.connect(token);
    expect(await deleteOf(again)).toEqual(first);
    await answered(again, first.id, { outcome: 'deleted' });
    expect(await events()).toMatchObject([{ type: 'ticket.machine_branch_deleted' }]);
  });

  it('gives a revoked machine nothing, and its row says so', async () => {
    const { daemon, id } = await inReview();
    await offline(id, daemon);
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    const revoked = await h.call('POST', `/api/machines/${id}/revoke`);
    expect(revoked.statusCode, revoked.body).toBe(200);
    await h.t.ciTick();
    expect(await machines()).toMatchObject([
      { state: 'kept', reason: { kind: 'machine_revoked' }, waiting: null, sentAt: null },
    ]);
    expect(await events()).toMatchObject([
      {
        type: 'ticket.machine_branch_kept',
        payload: { machine: 'Laptop', reason: { kind: 'machine_revoked' } },
      },
    ]);
    expect(deletes(daemon)).toEqual([]);
  });

  it('never sends it to a daemon of protocol 1 (0.3.0), which waits for its update', async () => {
    const { daemon, id, token } = await inReview();
    await offline(id, daemon);
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    const old = await ScriptedDaemon.connect(h.t.url, token);
    expect((await old.hello({ protocolVersion: 1, daemonVersion: '0.3.0' })).accepted).toBe(true);
    await h.t.ciTick();
    expect(await machines()).toMatchObject([{ state: 'wanted', waiting: 'daemon_outdated' }]);
    expect(deletes(old)).toEqual([]);
    await offline(id, old);
    await old.close();
    const updated = await h.connect(token);
    expect((await deleteOf(updated)).payload.branch).toBe(BRANCH);
  });

  it('asks only the machines whose runs had the branch', async () => {
    const { daemon } = await inReview();
    const other = await h.machine('Desktop');
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    await deleteOf(daemon);
    expect(deletes(other.daemon)).toEqual([]);
    expect((await machines()).map((row) => row.machine.name)).toEqual(['Laptop']);
  });

  it('asks nothing after a cancellation', async () => {
    const { daemon } = await inReview();
    const cancelled = await h.call('POST', '/api/projects/WEB/tickets/1/cancel');
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    await h.t.ciTick();
    expect((await h.ticket()).status).toBe('cancelled');
    expect(deletes(daemon)).toEqual([]);
    expect(await h.t.db.select().from(schema.branchCleanUps)).toEqual([]);
  });
});
