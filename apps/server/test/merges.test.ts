import { schema } from '@orchestrator/db';
import {
  ApiError,
  NeedsYouResponse,
  type DodReport,
  type NeedsYouItem,
  type RunStop,
  type TicketDetail,
} from '@orchestrator/protocol';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { timestamp } from '../src/agents/messages.js';
import type { ScriptedDaemon } from './daemon-client.js';
import { RunHarness, TOKEN, cleanWorkspace, eventually, state } from './run-harness.js';

// Merge detection (04, section 2; owner's answers 1 to 3, lot 3 step J1), against the fake GitHub:
// the CI loop's tick looks at every watched pull request before the CI waits; a merge into the
// default branch moves the ticket to `done` exactly once, stopping an active run, with a `system`
// comment naming the merged head, CI and the review.

const h = new RunHarness();

afterEach(async () => {
  h.github.alter = undefined;
  h.github.override = undefined;
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
const SUMMARY = 'The form checks the e-mail address and the tests cover both criteria.';
const POINTS = [
  { body: 'Test an empty e-mail address too.', file: 'src/contact.test.ts', line: 12 },
];

const repo = () => h.github.repository('octo-owner', 'bakery');
const short = (commit: string) => commit.slice(0, 7);

/** Ticket `number`: implemented, submitted, CI passed, in review with its pull request. */
async function submitted(daemon: ScriptedDaemon, number = 1) {
  const run = await h.running(daemon, number);
  const answer = await h.tool(daemon, run.runToken, 'ticket_submit', REPORT);
  if (!answer.ok) throw new Error(JSON.stringify(answer.error));
  await h.ciPasses(daemon, run.runId);
  await eventually('the ticket in review', async () => {
    expect((await h.ticket(number)).status).toBe('in_review');
  });
  return { ...run, commit: h.lastPushed ?? '' };
}

/** A review run that ends with its decision applied. */
async function reviewed(daemon: ScriptedDaemon, decision: 'approve' | 'changes', number = 1) {
  const review = await h.reviewing(daemon, number);
  if (decision === 'approve') {
    await h.ok(daemon, review.runToken, 'review_approve', { summary: SUMMARY });
  } else {
    await h.ok(daemon, review.runToken, 'review_request_changes', { points: POINTS });
  }
  await h.report(daemon, state(review.runId, { state: 'ended', reason: 'submitted' }));
  return review;
}

async function inReview(settings: { maxReviewRounds?: number } = {}) {
  await h.start({ settings });
  await h.createTicket();
  const machine = await h.machine();
  const first = await submitted(machine.daemon);
  return { ...machine, first };
}

async function ticketRow(number = 1) {
  const [row] = await h.t.db.select().from(schema.tickets).where(eq(schema.tickets.number, number));
  if (!row) throw new Error('no ticket');
  return row;
}

function comments(ticket: TicketDetail) {
  return ticket.timeline.flatMap((entry) => (entry.type === 'comment' ? [entry.comment] : []));
}

const lastBody = async (number = 1) => comments(await h.ticket(number)).at(-1)?.body;

/** The owner merges on GitHub; GitHub's time of the merge. */
function merge(number = 1, method: 'merge' | 'squash' | 'rebase' = 'merge') {
  h.github.mergePullRequest(repo(), number, method);
  return new Date(h.github.pullRequest(repo(), number).mergedAt ?? '');
}

/** "Pull request #1 was merged on GitHub at … (head abc1234)." */
const opening = (mergedAt: Date, head: string, number = 1) =>
  `Pull request #${String(number)} was merged on GitHub at ${timestamp(mergedAt)} (head ${short(head)}).`;

async function items(): Promise<NeedsYouItem[]> {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items;
}

function stops(daemon: ScriptedDaemon, runId: string) {
  return daemon.received.filter(
    (message): message is RunStop => message.type === 'run.stop' && message.payload.runId === runId,
  );
}

/** The requests the fake received for pull requests since `from`, as `METHOD path`. */
function pullRequests(from: number) {
  return h.github.requests
    .slice(from)
    .filter((request) => request.path.includes('/pulls'))
    .map((request) => `${request.method} ${request.path.replace('/repos/octo-owner/bakery', '')}`);
}

/** The owner's request on GitHub's API (as on GitHub's site): reopen, change the base. */
async function onGitHub(number: number, body: object) {
  const response = await fetch(`${h.github.url}/repos/octo-owner/bakery/pulls/${String(number)}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

describe('a merge into the default branch', () => {
  it.each(['merge', 'squash', 'rebase'] as const)(
    'moves a ticket on Awaiting merge to done (%s), once, and unblocks its dependents',
    async (method) => {
      const { daemon, first } = await inReview();
      await h.createTicket({ title: 'Map page', blockedBy: [1] });
      expect((await h.ticket(2)).blocked).toBe(true);
      await reviewed(daemon, 'approve');
      expect((await h.ticket()).status).toBe('awaiting_merge');

      const mergedAt = merge(1, method);
      await h.t.ciTick();
      const ticket = await h.ticket();
      expect(ticket.status).toBe('done');
      expect(ticket.pullRequest.opened).toMatchObject({ number: 1, state: 'merged' });
      // Lot 3 step J4c: where it was merged, on the ticket's API.
      expect(ticket.pullRequest.merged).toEqual({
        into: 'main',
        at: mergedAt.toISOString(),
        intoDefaultBranch: true,
      });
      expect(comments(ticket).at(-1)).toMatchObject({
        author: 'system',
        kind: 'status_change',
        body: `${opening(mergedAt, first.commit)} CI passed for this commit. Quality approved this commit.`,
      });
      expect((await h.ticket(2)).blocked).toBe(false);
      // What step J2's clean-up needs: the merged head (never the merge commit), GitHub's time.
      expect(await ticketRow()).toMatchObject({
        pullRequestState: 'merged',
        pullRequestHead: first.commit,
        pullRequestMergedHead: first.commit,
        pullRequestMergedAt: mergedAt,
        pullRequestMergedInto: 'main',
      });
      expect((await h.events('ticket.pull_request_merged')).map((e) => e.payload)).toEqual([
        {
          project: 'WEB',
          ticket: 'WEB-1',
          number: 1,
          url: expect.any(String) as string,
          mergedAt: mergedAt.toISOString(),
          head: first.commit,
          into: 'main',
          outcome: 'done',
          commentId: null,
        },
      ]);
      expect((await h.events('ticket.status_changed')).at(-1)?.payload).toMatchObject({
        from: 'awaiting_merge',
        to: 'done',
        action: 'pull_request_merged',
      });

      // Exactly once: the next ticks find nothing new, and Mark as done manually is refused.
      await h.t.ciTick();
      expect(await h.events('ticket.pull_request_merged')).toHaveLength(1);
      const refused = await h.call('POST', '/api/projects/WEB/tickets/1/mark-done', {
        comment: 'Merged it myself.',
      });
      expect(refused.statusCode).toBe(409);
      expect(ApiError.parse(refused.json()).error.message).toBe(
        'WEB-1 is already done: pull request #1 was merged on GitHub.',
      );
    },
  );

  it('stops a run waiting for CI: not counted, CI not finished, before the review', async () => {
    await h.start({ ci: 'queued' });
    await h.createTicket();
    const { daemon } = await h.machine();
    const { runId, runToken } = await h.running(daemon);
    expect((await h.ok(daemon, runToken, 'ticket_submit', REPORT)).result).toBe('pending_ci');
    await h.report(daemon, state(runId, { state: 'waiting_ci' }));
    await eventually('the pull request opened', async () => {
      expect((await h.ticket()).pullRequest.opened?.state).toBe('open');
    });
    const commit = h.lastPushed ?? '';
    await h.t.ciTick();

    const mergedAt = merge();
    await h.t.ciTick();
    // Merges before the CI waits: the run ends as merged, not with a CI result.
    expect(await h.run(runId)).toMatchObject({ status: 'cancelled', failureReason: 'cancelled' });
    expect((await h.events('run.status_changed')).at(-1)?.payload).toMatchObject({
      to: 'cancelled',
      cause: 'pull_request_merged',
    });
    expect(stops(daemon, runId).map((stop) => stop.payload.reason)).toEqual(['not_active']);
    expect(await h.ticket()).toMatchObject({ status: 'done', attemptCount: 0 });
    expect(await lastBody()).toBe(
      `${opening(mergedAt, commit)} The run on Laptop was stopped. CI had not passed for this work: CI was still being checked for ${short(commit)}. It was merged before Quality's review.`,
    );
    expect((await h.events('ticket.status_changed')).at(-1)?.payload).toMatchObject({
      to: 'done',
      action: 'pull_request_merged',
      runId,
    });
  });

  it('stops a review run whose decision was not applied, and names it', async () => {
    const { daemon, first } = await inReview();
    const review = await h.reviewing(daemon);
    await h.ok(daemon, review.runToken, 'review_request_changes', { points: POINTS });
    const mergedAt = merge();
    await h.t.ciTick();
    expect((await h.ticket()).status).toBe('done');
    expect((await h.run(review.runId)).status).toBe('cancelled');
    expect(await lastBody()).toBe(
      `${opening(mergedAt, first.commit)} The run on Laptop was stopped. CI passed for this commit. Quality had asked for changes on ${short(first.commit)} just before the merge; that decision was not applied.`,
    );
    expect((await h.events('run.review_discarded')).at(-1)?.payload).toMatchObject({
      decision: 'changes_requested',
      failureReason: 'cancelled',
    });
  });

  it('stops a review run with no decision: merged before the review', async () => {
    const { daemon, first } = await inReview();
    const review = await h.reviewing(daemon);
    const mergedAt = merge();
    await h.t.ciTick();
    expect((await h.run(review.runId)).status).toBe('cancelled');
    expect(await lastBody()).toBe(
      `${opening(mergedAt, first.commit)} The run on Laptop was stopped. CI passed for this commit. It was merged before Quality's review.`,
    );
  });

  it('moves a ticket in review, never reviewed, to done', async () => {
    const { first } = await inReview();
    const mergedAt = merge();
    await h.t.ciTick();
    expect((await h.ticket()).status).toBe('done');
    expect(await lastBody()).toBe(
      `${opening(mergedAt, first.commit)} CI passed for this commit. It was merged before Quality's review.`,
    );
  });

  it("moves a ticket in To do with Quality's request standing, which was not addressed", async () => {
    const { daemon, first } = await inReview();
    await reviewed(daemon, 'changes');
    expect((await h.ticket()).status).toBe('todo');
    const mergedAt = merge();
    await h.t.ciTick();
    expect((await h.ticket()).status).toBe('done');
    expect(await lastBody()).toBe(
      `${opening(mergedAt, first.commit)} CI passed for this commit. Quality's request for changes on ${short(first.commit)} was not addressed.`,
    );
  });

  it('moves a stopped ticket to done: the stop and its item go', async () => {
    const { daemon } = await inReview({ maxReviewRounds: 1 });
    await reviewed(daemon, 'changes');
    const fix = await submitted(daemon);
    await reviewed(daemon, 'changes');
    expect((await h.ticket()).stop).not.toBeNull();
    expect((await items()).some((item) => item.type === 'ticket_stopped')).toBe(true);

    const mergedAt = merge();
    await h.t.ciTick();
    const ticket = await h.ticket();
    expect(ticket).toMatchObject({ status: 'done', stop: null });
    expect(await lastBody()).toBe(
      `${opening(mergedAt, fix.commit)} CI passed for this commit. Quality's request for changes on ${short(fix.commit)} was not addressed.`,
    );
    expect((await items()).some((item) => item.type === 'ticket_stopped')).toBe(false);
  });

  it('moves a ticket whose CI did not finish (CI wait at submission) to done', async () => {
    let clock = new Date('2026-10-11T10:00:00.000Z');
    await h.start({ ci: 'queued', now: () => clock });
    await h.createTicket();
    const { daemon } = await h.machine();
    const { runId, runToken } = await h.running(daemon);
    await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    await h.report(daemon, state(runId, { state: 'waiting_ci' }));
    await eventually('the pull request opened', async () => {
      expect((await h.ticket()).pullRequest.opened?.state).toBe('open');
    });
    const commit = h.lastPushed ?? '';
    clock = new Date(clock.getTime() + 25 * 60_000);
    await h.t.ciTick();
    expect((await h.run(runId)).failureReason).toBe('ci_timeout');
    expect((await h.ticket()).status).toBe('todo');

    const mergedAt = merge();
    await h.t.ciTick();
    expect((await h.ticket()).status).toBe('done');
    expect(await lastBody()).toBe(
      `${opening(mergedAt, commit)} CI had not passed for this work: CI had not finished for ${short(commit)} when CI wait at submission was reached. It was merged before Quality's review.`,
    );
    expect((await items()).some((item) => item.type === 'ci_timeout')).toBe(false);
  });
});

describe('exactly once, with the owner and with a stopped server', () => {
  it('Mark as done manually first: the merge is only recorded, with its comment', async () => {
    const { first } = await inReview();
    const marked = await h.call('POST', '/api/projects/WEB/tickets/1/mark-done', {
      comment: 'Good enough.',
    });
    expect(marked.statusCode, marked.body).toBe(200);
    const mergedAt = merge();
    await h.t.ciTick();
    expect((await h.ticket()).status).toBe('done');
    expect(await lastBody()).toBe(
      `Pull request #1 was merged on GitHub at ${timestamp(mergedAt)} (head ${short(first.commit)}), after you marked WEB-1 as done.`,
    );
    expect((await ticketRow()).pullRequestState).toBe('merged');
    expect((await h.events('ticket.pull_request_merged')).at(-1)?.payload).toMatchObject({
      outcome: 'already_done',
      commentId: expect.any(String) as string,
    });
    // No status change by the merge: the owner's is the only one to done.
    const changes = (await h.events('ticket.status_changed')).filter(
      (event) => (event.payload as { to: string }).to === 'done',
    );
    expect(changes.map((event) => (event.payload as { action: string }).action)).toEqual([
      'mark_done',
    ]);
  });

  it('a merge found first refuses Mark as done manually', async () => {
    await inReview();
    merge();
    await h.t.ciTick();
    const refused = await h.call('POST', '/api/projects/WEB/tickets/1/mark-done', {
      comment: 'Done.',
    });
    expect(refused.statusCode).toBe(409);
    expect(ApiError.parse(refused.json()).error.message).toBe(
      'WEB-1 is already done: pull request #1 was merged on GitHub.',
    );
  });

  it('the cancel race: a cancelled ticket stays cancelled, with a comment saying how to record it', async () => {
    const { first } = await inReview();
    const cancelled = await h.call('POST', '/api/projects/WEB/tickets/1/cancel');
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const mergedAt = merge();
    await h.t.ciTick();
    expect((await h.ticket()).status).toBe('cancelled');
    expect(await lastBody()).toBe(
      `Pull request #1 was merged on GitHub at ${timestamp(mergedAt)} (head ${short(first.commit)}), after WEB-1 was cancelled. The ticket stays cancelled: to record it as done, use Reopen, then Mark as done manually.`,
    );
    expect((await h.events('ticket.pull_request_merged')).at(-1)?.payload).toMatchObject({
      outcome: 'cancelled',
    });
    // Reopen, then Mark as done manually, records it.
    expect((await h.call('POST', '/api/projects/WEB/tickets/1/reopen')).statusCode).toBe(200);
    const marked = await h.call('POST', '/api/projects/WEB/tickets/1/mark-done', {
      comment: 'Merged on GitHub.',
    });
    expect(marked.statusCode, marked.body).toBe(200);
  });

  it('a server stopped while the merge happened: found at the first tick, with GitHub’s time', async () => {
    let clock = new Date('2026-10-11T10:00:00.000Z');
    await h.start({ now: () => clock });
    await h.createTicket();
    const { daemon, token } = await h.machine();
    const { commit } = await submitted(daemon);
    await h.t.restart();
    const mergedAt = merge();
    // A day later, the server starts again.
    clock = new Date(clock.getTime() + 24 * 3_600_000);
    await h.connect(token);
    await h.t.ciTick();
    expect((await h.ticket()).status).toBe('done');
    expect(await lastBody()).toContain(opening(mergedAt, commit));
    const [event] = await h.events('ticket.pull_request_merged');
    // The event has the time the server found it; the comment GitHub's.
    expect(event?.createdAt).toEqual(clock);
    expect(event?.payload).toMatchObject({ mergedAt: mergedAt.toISOString() });
  });
});

describe('the same result whoever reads the merge first', () => {
  /** Your request for changes, then the fix run working: its id and token. */
  async function fixing(daemon: ScriptedDaemon) {
    const asked = await h.call('POST', '/api/projects/WEB/tickets/1/request-changes', {
      comment: 'Add the opening hours.',
    });
    expect(asked.statusCode, asked.body).toBe(200);
    return h.running(daemon);
  }

  it('merged after the last check, then a submission accepted before the next one: done once, no second pull request', async () => {
    const { daemon, first } = await inReview();
    const fix = await fixing(daemon);
    const mergedAt = merge();
    // The submission's pull request attempt finds #1 merged first: the watcher records it.
    expect((await h.ok(daemon, fix.runToken, 'ticket_submit', REPORT)).result).toBe('pending_ci');
    await eventually('the ticket done', async () => {
      expect((await ticketRow()).status).toBe('done');
    });
    expect((await h.run(fix.runId)).status).toBe('cancelled');
    expect(stops(daemon, fix.runId).map((stop) => stop.payload.reason)).toEqual(['not_active']);
    expect(() => h.github.pullRequest(repo(), 2)).toThrow();
    expect(await ticketRow()).toMatchObject({
      pullRequestNumber: 1,
      pullRequestWantedSince: null,
      pullRequestMergedAt: mergedAt,
      pullRequestMergedHead: first.commit,
    });
    // CI of the merged head, not of the commit the fix pushed after the merge.
    expect(await lastBody()).toBe(
      `${opening(mergedAt, first.commit)} The run on Laptop was stopped. CI passed for this commit. Your request for changes on ${short(first.commit)} was not addressed.`,
    );
    await h.t.ciTick();
    expect(await h.events('ticket.pull_request_merged')).toHaveLength(1);
    expect(await h.events('ticket.pull_request_opened')).toHaveLength(1);
  });

  it("merged between the opener's find and its update: done once, the merge's facts stored", async () => {
    const { daemon } = await inReview();
    const fix = await fixing(daemon);
    let mergedAt: Date | null = null;
    // The owner merges just as the Orchestrator updates the pull request's description.
    h.github.override = (request) => {
      if (mergedAt === null && request.method === 'PATCH' && request.path.endsWith('/pulls/1')) {
        mergedAt = merge();
      }
      return undefined;
    };
    await h.ok(daemon, fix.runToken, 'ticket_submit', REPORT);
    await eventually('the ticket done', async () => {
      expect((await ticketRow()).status).toBe('done');
    });
    expect(mergedAt).not.toBeNull();
    expect(await ticketRow()).toMatchObject({
      pullRequestState: 'merged',
      pullRequestMergedAt: mergedAt,
      // The fix's push was in the pull request when it was merged.
      pullRequestMergedHead: h.lastPushed,
      pullRequestMergedInto: 'main',
    });
    expect((await h.run(fix.runId)).status).toBe('cancelled');
    await h.t.ciTick();
    expect(await h.events('ticket.pull_request_merged')).toHaveLength(1);
    expect(await h.events('ticket.pull_request_updated')).toHaveLength(0);
  });
});

describe('one ticket or one run never blocks the others', () => {
  /** Submitted with CI started (the project's CI queued): its run and commit. */
  async function handedIn(daemon: ScriptedDaemon, number: number) {
    const run = await h.running(daemon, number);
    await h.ok(daemon, run.runToken, 'ticket_submit', REPORT);
    await h.report(daemon, state(run.runId, { state: 'waiting_ci' }));
    await eventually('the pull request opened', async () => {
      expect((await ticketRow(number)).pullRequestState).toBe('open');
    });
    return { ...run, commit: h.lastPushed ?? '' };
  }

  const passes = (commit: string) => {
    for (const run of h.github.runs(repo(), commit)) h.github.completeRun(run, []);
  };

  it('a ticket whose handling throws: another merge is found and a CI wait decided in the same tick', async () => {
    await h.start({ ci: 'queued' });
    const { daemon } = await h.machine('Laptop', 3);
    for (const title of ['Contact form', 'Map page', 'Opening hours']) {
      await h.createTicket({ title });
    }
    for (const number of [1, 2]) {
      const { runId, commit } = await handedIn(daemon, number);
      passes(commit);
      await h.t.ciTick();
      await h.report(daemon, state(runId, { state: 'ended', reason: 'submitted' }));
    }
    const waiting = await handedIn(daemon, 3);
    // WEB-1 holds a value an older build wrote, which no longer reads.
    await h.t.db
      .update(schema.tickets)
      .set({ changeRequest: { by: 'nobody' } })
      .where(eq(schema.tickets.number, 1));
    merge(1);
    merge(2);
    passes(waiting.commit);

    await h.t.ciTick();
    expect((await ticketRow(1)).status).toBe('in_review');
    expect((await ticketRow(2)).status).toBe('done');
    expect((await h.run(waiting.runId)).status).toBe('succeeded');
    expect((await ticketRow(3)).status).toBe('in_review');
    expect(h.t.logs.text).toMatch(/"ticket":"WEB-1".*"msg":"pull request not checked"/);
  });

  it('a run whose CI check throws: the runs after it are still checked', async () => {
    await h.start({ ci: 'queued' });
    const { daemon } = await h.machine('Laptop', 2);
    for (const title of ['Contact form', 'Map page']) await h.createTicket({ title });
    const broken = await handedIn(daemon, 1);
    const next = await handedIn(daemon, 2);
    // WEB-1's run holds rounds an older build wrote, which no longer read.
    await h.t.db
      .update(schema.runs)
      .set({ ciRoundMessageId: randomUUID(), ciRounds: [{ round: 'one' }] })
      .where(eq(schema.runs.id, broken.runId));
    passes(next.commit);
    await h.t.ciTick();
    expect((await h.run(next.runId)).status).toBe('succeeded');
    expect((await ticketRow(2)).status).toBe('in_review');
    expect(h.t.logs.text).toMatch(/"ticket":"WEB-1".*"msg":"CI check of a run failed"/);
  });
});

describe('what is not a merge into the default branch', () => {
  it('a merge into another base leaves the ticket unchanged, and is not read again', async () => {
    const { daemon } = await inReview();
    await reviewed(daemon, 'approve');
    h.github.commit(repo(), 'release', { 'RELEASE.md': 'Next\n' }, 'Release branch', 'main');
    await onGitHub(1, { base: 'release' });
    const mergedAt = merge();
    await h.t.ciTick();
    const ticket = await h.ticket();
    expect(ticket.status).toBe('awaiting_merge');
    // Lot 3 step J4c: the ticket page reads where it was merged from the ticket's API.
    expect(ticket.pullRequest.merged).toEqual({
      into: 'release',
      at: mergedAt.toISOString(),
      intoDefaultBranch: false,
    });
    expect(await ticketRow()).toMatchObject({
      pullRequestState: 'merged',
      pullRequestMergedInto: 'release',
    });
    expect((await h.events('ticket.pull_request_merged')).at(-1)?.payload).toMatchObject({
      into: 'release',
      outcome: 'other_base',
      commentId: null,
    });
    const from = h.github.requests.length;
    await h.t.ciTick();
    expect(pullRequests(from)).toEqual([]);
  });

  it('a page of the list that fails decides nothing for the project', async () => {
    const { daemon } = await inReview();
    await h.createTicket({ title: 'Map page' });
    await submitted(daemon, 2);
    merge(1);
    // The first page full (as if 99 more were open: copies of #2), the second one failing.
    h.github.alter = (request, reply) => {
      if (!request.path.includes('/pulls?state=open')) return reply;
      if (!request.path.includes('page=1')) return { status: 500, body: { message: 'Error' } };
      const [open] = reply.body as object[];
      const fill = Array.from({ length: 99 }, (_, index) => ({ ...open, number: 1000 + index }));
      return { ...reply, body: [open, ...fill] };
    };
    const from = h.github.requests.length;
    await h.t.ciTick();
    expect(pullRequests(from)).toContain('GET /pulls?state=open&per_page=100&page=2');
    expect((await h.ticket()).status).toBe('in_review');
    // Missing from a partial list: never read by itself, so never decided.
    expect(pullRequests(from).filter((line) => line.startsWith('GET /pulls/'))).toEqual([]);
    h.github.alter = undefined;
    await h.t.ciTick();
    expect((await h.ticket()).status).toBe('done');
  });

  it('closed, then reopened and merged on GitHub between two checks: done', async () => {
    const { daemon, first } = await inReview();
    await reviewed(daemon, 'approve');
    h.github.closePullRequest(repo(), 1);
    await h.t.ciTick();
    expect(await h.ticket()).toMatchObject({
      status: 'awaiting_merge',
      pullRequest: { opened: { state: 'closed' } },
    });
    expect((await h.events('ticket.pull_request_closed')).map((e) => e.payload)).toEqual([
      {
        project: 'WEB',
        ticket: 'WEB-1',
        number: 1,
        url: expect.any(String) as string,
        by: 'github',
      },
    ]);
    // Still watched while closed: read by itself at each check.
    let from = h.github.requests.length;
    await h.t.ciTick();
    expect(pullRequests(from)).toEqual(['GET /pulls/1']);

    await onGitHub(1, { state: 'open' });
    const mergedAt = merge();
    from = h.github.requests.length;
    await h.t.ciTick();
    expect(pullRequests(from)).toEqual([
      'GET /pulls/1',
      // Then the clean-up after the merge, in the same tick (lot 3 step J2a).
      'GET /pulls/1',
      'GET /pulls?state=open&head=octo-owner%3At%2F1-contact-form&per_page=100&page=1',
      'GET /pulls?state=open&base=t%2F1-contact-form&per_page=100&page=1',
    ]);
    expect((await h.ticket()).status).toBe('done');
    expect(await lastBody()).toBe(
      `${opening(mergedAt, first.commit)} CI passed for this commit. Quality approved this commit.`,
    );
  });

  it('closed then reopened on GitHub: open again, found in the list', async () => {
    await inReview();
    h.github.closePullRequest(repo(), 1);
    await h.t.ciTick();
    await onGitHub(1, { state: 'open' });
    await h.t.ciTick();
    expect((await h.ticket()).pullRequest.opened?.state).toBe('open');
    expect((await h.events('ticket.pull_request_reopened')).at(-1)?.payload).toMatchObject({
      number: 1,
      seen: true,
    });
  });
});

describe('the requests per GitHub check interval', () => {
  it('one list per project, plus one read per closed pull request and per one that left the list', async () => {
    await h.start();
    const { daemon } = await h.machine('Laptop', 3);
    for (const title of ['Contact form', 'Map page', 'Opening hours']) {
      await h.createTicket({ title });
    }
    for (const number of [1, 2, 3]) await submitted(daemon, number);
    h.github.closePullRequest(repo(), 3);
    await h.t.ciTick();

    // P + C: the project's list, and the closed #3 by itself.
    let from = h.github.requests.length;
    await h.t.ciTick();
    expect(pullRequests(from)).toEqual([
      'GET /pulls?state=open&per_page=100&page=1',
      'GET /pulls/3',
    ]);
    // A merged one left the list: read once by itself, then no longer watched.
    merge(1);
    from = h.github.requests.length;
    await h.t.ciTick();
    expect(pullRequests(from)).toEqual([
      'GET /pulls?state=open&per_page=100&page=1',
      'GET /pulls/1',
      'GET /pulls/3',
      // Then the clean-up after the merge, once (lot 3 step J2a): not a cost of each interval.
      'GET /pulls/1',
      'GET /pulls?state=open&head=octo-owner%3At%2F1-contact-form&per_page=100&page=1',
      'GET /pulls?state=open&base=t%2F1-contact-form&per_page=100&page=1',
    ]);
    from = h.github.requests.length;
    await h.t.ciTick();
    expect(pullRequests(from)).toEqual([
      'GET /pulls?state=open&per_page=100&page=1',
      'GET /pulls/3',
    ]);
    // A closed pull request of a done or cancelled ticket is not read.
    expect((await h.call('POST', '/api/projects/WEB/tickets/3/cancel')).statusCode).toBe(200);
    from = h.github.requests.length;
    await h.t.ciTick();
    expect(pullRequests(from)).toEqual(['GET /pulls?state=open&per_page=100&page=1']);
    // Nothing watched: nothing asked.
    merge(2);
    await h.t.ciTick();
    from = h.github.requests.length;
    await h.t.ciTick();
    expect(pullRequests(from)).toEqual([]);
  });
});

describe('the stored pull request', () => {
  it('has its head refreshed at each read', async () => {
    const { first } = await inReview();
    expect((await ticketRow()).pullRequestHead).toBe(first.commit);
    const moved = h.github.commit(
      repo(),
      't/1-contact-form',
      { 'src/by-hand.ts': 'export {};\n' },
      'By hand',
    );
    await h.t.ciTick();
    expect(await ticketRow()).toMatchObject({ pullRequestHead: moved, pullRequestState: 'open' });
  });
});

describe("the D3 exception: a pull request's head a machine reported", () => {
  it("makes that report's commits count as on GitHub, so Run now takes any machine", async () => {
    const { daemon, first } = await inReview();
    const asked = await h.call('POST', '/api/projects/WEB/tickets/1/request-changes', {
      comment: 'Add the opening hours.',
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const fix = await h.running(daemon);
    // The run's push reached GitHub, but the server never heard of it (the push not reported):
    // the end report lists the new head as on no branch fetched from GitHub.
    const pushed = h.github.commit(
      repo(),
      't/1-contact-form',
      { 'src/hours.ts': 'export {};\n' },
      'Opening hours',
    );
    expect((await h.call('POST', `/api/runs/${fix.runId}/stop`)).statusCode).toBe(200);
    const end = state(fix.runId, { state: 'ended', reason: 'stopped' });
    if (end.payload.state !== 'ended') throw new Error('not an end');
    await h.report(daemon, {
      ...end,
      payload: {
        ...end.payload,
        branch: {
          name: 't/1-contact-form',
          head: pushed,
          commitsAhead: [
            { hash: pushed, subject: 'Opening hours' },
            { hash: first.commit, subject: 'Work of the agent' },
          ],
          notOnGitHub: { listed: [pushed], count: 1 },
        },
      },
    });
    expect((await h.ticket()).branch).toMatchObject({
      where: 'machine_ahead',
      notOnGitHubCount: 1,
    });
    // Only Laptop holds that commit, as far as the server knows: offline, Run now is refused.
    await daemon.close();
    const desk = await h.machine('Desk');
    expect((await h.call('POST', '/api/projects/WEB/tickets/1/run')).statusCode).toBe(409);

    // The next check reads the pull request's head on GitHub: exactly the reported head.
    await h.t.ciTick();
    expect((await ticketRow()).pullRequestHead).toBe(pushed);
    expect((await h.ticket()).branch).toMatchObject({ where: 'github', notOnGitHubCount: 0 });
    const run = await h.running(desk.daemon);
    expect((await h.run(run.runId)).machine.name).toBe('Desk');
  });
});

describe('Needs you after a merge', () => {
  it('leaves no item of the ticket, whatever its kind', async () => {
    // Every kind tied to a ticket, from the schema: a new kind fails this test until it is here.
    const kinds = NeedsYouResponse.shape.items.element.options
      .filter((option) => 'ticket' in option.shape || 'tickets' in option.shape)
      .map((option) => option.shape.type.value);
    // Never on a ticket with a pull request: a proposed ticket, and work 0.3.0 left in review.
    const without = ['ticket_proposed', 'work_to_check'];

    let clock = new Date('2026-10-11T10:00:00.000Z');
    await h.start({ ci: 'queued', now: () => clock });
    const { daemon } = await h.machine('Laptop', 10);
    const titles = [
      'Question',
      'Not finished',
      'Paused',
      'Push',
      'Pull request',
      'Stopped',
      'CI',
      'Closed',
      'To merge',
      'Download',
    ];
    for (const title of titles) await h.createTicket({ title });
    /** Submitted, CI started: its pull request open. */
    const handedIn = async (number: number) => {
      const run = await h.running(daemon, number);
      await h.ok(daemon, run.runToken, 'ticket_submit', REPORT);
      await h.report(daemon, state(run.runId, { state: 'waiting_ci' }));
      await eventually('the pull request opened', async () => {
        expect((await h.ticket(number)).pullRequest.opened?.state).toBe('open');
      });
      return { ...run, commit: h.lastPushed ?? '' };
    };
    for (const number of [1, 2, 3, 4, 5, 6, 10]) {
      const { runId, commit } = await handedIn(number);
      for (const run of h.github.runs(repo(), commit)) h.github.completeRun(run, []);
      await h.t.ciTick();
      await h.report(daemon, state(runId, { state: 'ended', reason: 'submitted' }));
    }
    // 7: CI did not finish before CI wait at submission.
    await handedIn(7);
    clock = new Date(clock.getTime() + 25 * 60_000);
    await h.t.ciTick();
    // 8: its pull request closed on GitHub without merging (lot 3 step J3a).
    {
      const { runId, commit } = await handedIn(8);
      for (const run of h.github.runs(repo(), commit)) h.github.completeRun(run, []);
      await h.t.ciTick();
      await h.report(daemon, state(runId, { state: 'ended', reason: 'submitted' }));
      h.github.closePullRequest(repo(), 8);
      await h.t.ciTick();
    }
    // 9: its review skipped, its pull request to merge (lot 3 step J4a).
    {
      const { runId, commit } = await handedIn(9);
      for (const run of h.github.runs(repo(), commit)) h.github.completeRun(run, []);
      await h.t.ciTick();
      await h.report(daemon, state(runId, { state: 'ended', reason: 'submitted' }));
      const skipped = await h.call('POST', '/api/projects/WEB/tickets/9/skip-review');
      expect(skipped.statusCode, skipped.body).toBe(200);
    }
    // 4: your request for changes, then a run whose push failed at its submission.
    const asked = await h.call('POST', '/api/projects/WEB/tickets/4/request-changes', {
      comment: 'Add the opening hours.',
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const fix = await h.running(daemon, 4);
    const facts = cleanWorkspace({
      push: { status: 'failed', reason: 'unreachable', message: 'GitHub could not be reached' },
    });
    const refused = await h.tool(daemon, fix.runToken, 'ticket_submit', REPORT, {
      ...facts,
      branch: { ...facts.branch, name: (await ticketRow(4)).branchName ?? '' },
    });
    expect(refused.ok).toBe(false);
    await h.report(daemon, state(fix.runId, { state: 'ended', reason: 'push_failed' }));
    // 10: your request for changes, then a run whose download failed at its start (step K2).
    const again = await h.call('POST', '/api/projects/WEB/tickets/10/request-changes', {
      comment: 'Add the address.',
    });
    expect(again.statusCode, again.body).toBe(200);
    const download = await h.running(daemon, 10);
    await h.report(
      daemon,
      state(download.runId, {
        state: 'ended',
        reason: 'download_failed',
        download: { reason: 'unreachable', message: 'Could not resolve host: github.com' },
      }),
    );
    // 1: Quality asks a question.
    const asking = await h.reviewing(daemon, 1);
    await h.ok(daemon, asking.runToken, 'ticket_ask', { question: 'Phone number too?' });
    // 2: a review run that ended without a decision.
    const gaveUp = await h.reviewing(daemon, 2);
    await h.report(daemon, state(gaveUp.runId, { state: 'ended', reason: 'max_duration' }));
    // 3: a review run paused on a usage limit.
    const paused = await h.reviewing(daemon, 3);
    const limited = await daemon.request({
      type: 'run.quota_limited',
      id: randomUUID(),
      payload: {
        runId: paused.runId,
        kind: 'detected',
        resetsAt: null,
        evidence: {
          signal: 'stop_failure',
          error: 'rate_limit',
          message: "You've hit your session limit",
          statusLine: null,
        },
      },
    });
    expect(limited).toMatchObject({ type: 'ack', payload: { ok: true } });
    // 5 and 6: a pull request not updated and the retry policy's stop, as the server keeps them
    // (each is built by runs in its own tests: pull-request.test.ts, and the stop above).
    const at = clock.toISOString();
    await h.t.db
      .update(schema.tickets)
      .set({
        pullRequestWantedSince: clock,
        pullRequestFailure: {
          reason: 'unreachable',
          message: 'down',
          permission: null,
          fields: [],
          at,
          since: at,
        },
      })
      .where(eq(schema.tickets.number, 5));
    await h.t.db
      .update(schema.tickets)
      .set({ status: 'todo', stopped: { cause: 'review_rounds', count: 2, limit: 1, at } })
      .where(eq(schema.tickets.number, 6));
    // The machine goes offline with the runs of 1 and 3 active.
    await daemon.close();

    await eventually('every kind shown', async () => {
      const shown = new Set((await items()).map((item) => item.type));
      for (const kind of kinds.filter((each) => !without.includes(each))) {
        expect(shown, kind).toContain(kind);
      }
    });

    // GitHub merges only an open pull request: 8 is reopened there first.
    await onGitHub(8, { state: 'open' });
    for (let number = 1; number <= titles.length; number++) merge(number);
    await h.t.ciTick();
    for (let number = 1; number <= titles.length; number++) {
      expect((await h.ticket(number)).status, `WEB-${String(number)}`).toBe('done');
    }
    const tied = (await items()).filter((item) => 'ticket' in item || 'tickets' in item);
    expect(tied).toEqual([]);
    // Ten tickets through their runs: about 5 seconds on an idle machine.
  }, 30_000);
});
