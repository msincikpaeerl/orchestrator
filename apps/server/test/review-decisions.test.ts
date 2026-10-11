import { schema } from '@orchestrator/db';
import {
  ApiError,
  ReviewDecision,
  type DodReport,
  type RunStart,
  type TicketDetail,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import { RunHarness, eventually, state } from './run-harness.js';

// Quality's decisions, questions and failures, and Skip review (04, sections 2 and 3.2; 06,
// section 4.5; owner's answers 2c to 2e, 6c, 6e and 6g, lot 3 step H2), against the fake GitHub:
// a decision is checked against the pull request's head within its call, stored on the run, and
// applied only when the run ends `submitted` with no head moved on the machine. Every failure of
// a review run leaves the ticket in review, never counted.

const h = new RunHarness();

afterEach(async () => {
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
const BRANCH = 't/1-contact-form';
const SUMMARY = 'The form checks the e-mail address and the tests cover both criteria.';
const POINTS = [
  { body: 'Test an empty e-mail address too.', file: 'src/contact.test.ts', line: 12 },
  { body: 'Describe the form in the user documentation.' },
];

/** A ticket in review: implemented, submitted, CI passed. The machine and the commit reviewed. */
async function inReview() {
  await h.start();
  await h.createTicket();
  const machine = await h.machine();
  const { runId, runToken } = await h.running(machine.daemon);
  const answer = await h.tool(machine.daemon, runToken, 'ticket_submit', REPORT);
  if (!answer.ok) throw new Error(JSON.stringify(answer.error));
  await h.ciPasses(machine.daemon, runId);
  await eventually('the ticket in review', async () => {
    expect((await h.ticket()).status).toBe('in_review');
  });
  const commit = h.lastPushed ?? '';
  expect(commit).toMatch(/^[0-9a-f]{40}$/);
  return { ...machine, implementRunId: runId, commit };
}

async function runRow(id: string) {
  const [row] = await h.t.db.select().from(schema.runs).where(eq(schema.runs.id, id));
  if (!row) throw new Error('no run');
  return row;
}

async function decision(runId: string) {
  const row = await runRow(runId);
  return row.reviewDecision === null ? null : ReviewDecision.parse(row.reviewDecision);
}

function comments(ticket: TicketDetail) {
  return ticket.timeline.flatMap((entry) => (entry.type === 'comment' ? [entry.comment] : []));
}

const lastBody = async () => comments(await h.ticket()).at(-1)?.body;

async function ended(daemon: ScriptedDaemon, runId: string, reason: 'submitted' | 'stopped') {
  await h.report(daemon, state(runId, { state: 'ended', reason }));
}

const moveOnGitHub = () =>
  h.github.commit(
    h.github.repository('octo-owner', 'bakery'),
    BRANCH,
    { 'src/by-hand.ts': 'export {};\n' },
    'By hand',
  );

describe('an approval', () => {
  it('is stored at the call after the head was checked, then applied when the run ends submitted', async () => {
    const { daemon, commit } = await inReview();
    const before = await h.ticket();
    const review = await h.reviewing(daemon);

    const answer = await h.ok(daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    expect(answer).toMatchObject({ decision: 'approved', commit, head_checked: true });
    expect(answer.note).toContain(`Your approval of commit ${commit.slice(0, 7)} is recorded`);
    expect(answer.note).toContain('end your turn');
    expect(await decision(review.runId)).toMatchObject({
      kind: 'approved',
      commit,
      summary: SUMMARY,
      points: [],
      headChecked: true,
    });
    expect((await h.events('run.review_decided')).at(-1)?.payload).toMatchObject({
      ticket: 'WEB-1',
      agent: 'quality',
      decision: 'approved',
      commit,
      headChecked: true,
    });
    // Nothing applies before the run's end (answer 2d).
    expect((await h.ticket()).status).toBe('in_review');

    await ended(daemon, review.runId, 'submitted');
    const ticket = await h.ticket();
    expect(ticket.status).toBe('awaiting_merge');
    expect(ticket.attemptCount).toBe(before.attemptCount);
    expect(comments(ticket).at(-1)).toMatchObject({
      author: 'agent',
      agent: { profile: { key: 'quality' }, runId: review.runId },
      kind: 'review',
      body: SUMMARY,
    });
    expect((await runRow(review.runId)).reviewAppliedAt).not.toBeNull();
    expect(await h.run(review.runId)).toMatchObject({ status: 'succeeded' });
    expect((await h.events('ticket.status_changed')).at(-1)?.payload).toMatchObject({
      from: 'in_review',
      to: 'awaiting_merge',
      action: 'review_approved',
      agent: 'quality',
      runId: review.runId,
    });
  });

  it('is stored, marked "head not checked", when GitHub cannot be read at the call', async () => {
    const { daemon, commit } = await inReview();
    const review = await h.reviewing(daemon);
    h.github.override = (request) =>
      request.path.includes('/pulls/') ? { status: 503, body: { message: 'down' } } : undefined;
    const answer = await h.ok(daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    h.github.override = undefined;
    expect(answer).toMatchObject({ decision: 'approved', commit, head_checked: false });
    expect(answer.note).toContain('GitHub could not be read');
    expect(await decision(review.runId)).toMatchObject({ headChecked: false });

    await ended(daemon, review.runId, 'submitted');
    expect((await h.ticket()).status).toBe('awaiting_merge');
  });
});

describe('a request for changes', () => {
  it('becomes review comments and sends the ticket to todo, not counted; the next run is attempt 2', async () => {
    const { daemon, commit } = await inReview();
    const review = await h.reviewing(daemon);
    const answer = await h.ok(daemon, review.runToken, 'review_request_changes', {
      points: POINTS,
    });
    expect(answer).toMatchObject({ decision: 'changes_requested', commit, head_checked: true });
    expect(await decision(review.runId)).toMatchObject({
      kind: 'changes_requested',
      summary: null,
      points: [
        { body: POINTS[0]?.body, file: 'src/contact.test.ts', line: 12 },
        { body: POINTS[1]?.body, file: null, line: null },
      ],
    });
    await ended(daemon, review.runId, 'submitted');

    const ticket = await h.ticket();
    expect(ticket).toMatchObject({ status: 'todo', attemptCount: 0 });
    expect(
      comments(ticket)
        .slice(-2)
        .map((comment) => [comment.kind, comment.agent?.profile.key, comment.body]),
    ).toEqual([
      ['review', 'quality', 'src/contact.test.ts:12 — Test an empty e-mail address too.'],
      ['review', 'quality', 'Describe the form in the user documentation.'],
    ]);
    expect((await h.events('ticket.status_changed')).at(-1)?.payload).toMatchObject({
      to: 'todo',
      action: 'review_changes_requested',
    });

    // Run now (from step I): a fix_review run whose first message holds the points, and whose
    // attempt does not count the review run (owner's review of step H1).
    const next = await h.running(daemon);
    const start = daemon.received.find(
      (message): message is RunStart =>
        message.type === 'run.start' && message.payload.runId === next.runId,
    );
    expect(start?.payload.purpose).toBe('fix_review');
    expect(start?.payload.initialPrompt).toContain('This is attempt 2.');
    expect(start?.payload.initialPrompt).toContain('Test an empty e-mail address too.');
    expect((await h.run(next.runId)).attempt).toBe(2);
  });
});

describe("Quality's question", () => {
  it('moves the ticket to waiting_human, and the answer returns it to in_review in the same run', async () => {
    const { daemon } = await inReview();
    const review = await h.reviewing(daemon);
    await h.ok(daemon, review.runToken, 'ticket_ask', {
      question: 'Should the form also ask for a phone number?',
    });
    expect((await h.ticket()).status).toBe('waiting_human');
    await h.report(daemon, state(review.runId, { state: 'waiting_human' }));

    const answered = await h.call('POST', '/api/projects/WEB/tickets/1/answer', {
      body: 'No, the e-mail address is enough.',
    });
    expect(answered.statusCode, answered.body).toBe(200);
    expect((await h.ticket()).status).toBe('in_review');
    expect((await h.events('ticket.status_changed')).at(-1)?.payload).toMatchObject({
      from: 'waiting_human',
      to: 'in_review',
      action: 'review_answered',
    });
    await daemon.find(
      (message) => message.type === 'run.input' && message.payload.runId === review.runId,
      'the answer sent to the review run',
    );
    await h.report(daemon, state(review.runId, { state: 'working' }));
    await h.ok(daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    await ended(daemon, review.runId, 'submitted');
    expect((await h.ticket()).status).toBe('awaiting_merge');
  });

  it('Stop run while the question waits returns the ticket to in_review', async () => {
    const { daemon } = await inReview();
    const review = await h.reviewing(daemon);
    await h.ok(daemon, review.runToken, 'ticket_ask', { question: 'Phone number too?' });
    const stopped = await h.call('POST', `/api/runs/${review.runId}/stop`);
    expect(stopped.statusCode, stopped.body).toBe(200);
    const ticket = await h.ticket();
    expect(ticket).toMatchObject({ status: 'in_review', attemptCount: 0 });
    expect(comments(ticket).at(-1)?.body).toBe(
      'Review run stopped by the owner. It does not count as a failed attempt.',
    );
    expect((await h.events('ticket.status_changed')).at(-1)?.payload).toMatchObject({
      from: 'waiting_human',
      to: 'in_review',
      action: 'review_ended',
    });
  });
});

describe('a review run that ends without its decision applied', () => {
  it("gives up: the ticket stays in review, not counted, with Quality's reason", async () => {
    const { daemon } = await inReview();
    const review = await h.reviewing(daemon);
    await h.ok(daemon, review.runToken, 'ticket_give_up', {
      reason: 'The worktree has no tests to run.',
      tried: 'Reading the diff.',
    });
    await h.report(daemon, state(review.runId, { state: 'ended', reason: 'gave_up' }));
    const ticket = await h.ticket();
    expect(ticket).toMatchObject({ status: 'in_review', attemptCount: 0 });
    expect(comments(ticket).at(-1)?.body).toBe(
      'The review run on machine Laptop ended without a decision: Quality gave up: The worktree has no tests to run. It does not count as a failed attempt.',
    );
    expect(await h.run(review.runId)).toMatchObject({
      status: 'failed',
      failureReason: 'agent_gave_up',
    });
  });

  it('a head moved on the machine throws the decision away, saying which and why', async () => {
    const { daemon, commit } = await inReview();
    const review = await h.reviewing(daemon);
    await h.ok(daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    await h.report(
      daemon,
      state(review.runId, { state: 'ended', reason: 'review_branch_moved', headMoved: true }),
    );
    const ticket = await h.ticket();
    expect(ticket).toMatchObject({ status: 'in_review', attemptCount: 0 });
    expect(comments(ticket).at(-1)?.body).toBe(
      `The review run on machine Laptop ended before Quality's approval of commit ${commit.slice(0, 7)} was applied: the branch changed on the machine during the review. The approval is not applied, and the ticket stays in review. It does not count as a failed attempt.`,
    );
    const row = await runRow(review.runId);
    expect(row).toMatchObject({ failureReason: 'review_branch_moved', reviewAppliedAt: null });
    expect(await decision(review.runId)).toMatchObject({ kind: 'approved' });
    expect((await h.events('run.review_discarded')).at(-1)?.payload).toMatchObject({
      decision: 'approved',
      commit,
      failureReason: 'review_branch_moved',
    });
  });

  it('Stop run after a decision throws it away', async () => {
    const { daemon, commit } = await inReview();
    const review = await h.reviewing(daemon);
    await h.ok(daemon, review.runToken, 'review_request_changes', { points: POINTS });
    const stopped = await h.call('POST', `/api/runs/${review.runId}/stop`);
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(await h.ticket()).toMatchObject({ status: 'in_review', attemptCount: 0 });
    expect(await lastBody()).toBe(
      `Review run stopped by the owner before Quality's request for changes (2 points) on commit ${commit.slice(0, 7)} was applied: it is not applied. It does not count as a failed attempt.`,
    );
    // The daemon's late end report changes nothing.
    await ended(daemon, review.runId, 'submitted');
    expect((await h.ticket()).status).toBe('in_review');
    expect((await h.events('run.review_discarded')).at(-1)?.payload).toMatchObject({
      decision: 'changes_requested',
      failureReason: 'cancelled',
    });
  });

  it('a machine revoked leaves the ticket in review, from waiting_human too', async () => {
    const { daemon, id } = await inReview();
    const review = await h.reviewing(daemon);
    await h.ok(daemon, review.runToken, 'ticket_ask', { question: 'Phone number too?' });
    const revoked = await h.call('POST', `/api/machines/${id}/revoke`);
    expect(revoked.statusCode, revoked.body).toBe(200);
    await eventually('the review run failed', async () => {
      expect((await h.run(review.runId)).failureReason).toBe('machine_revoked');
    });
    expect(await h.ticket()).toMatchObject({ status: 'in_review', attemptCount: 0 });
    expect(await lastBody()).toBe(
      'The review run on machine Laptop ended without a decision: its machine was revoked. It does not count as a failed attempt.',
    );
  });
});

describe('a head moved on GitHub at the decision', () => {
  it('refuses the decision and stops the run with review_branch_moved, not counted', async () => {
    const { daemon, commit } = await inReview();
    const review = await h.reviewing(daemon);
    const head = moveOnGitHub();
    const answer = await h.tool(daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    expect(answer).toEqual({
      ok: false,
      error: {
        code: 'INVALID_TRANSITION',
        message: `The pull request changed on GitHub during your review, now ${head.slice(0, 7)}: your review of ${commit.slice(0, 7)} no longer applies. End your turn.`,
      },
    });
    expect(await decision(review.runId)).toBeNull();
    await daemon.find(
      (message) => message.type === 'run.stop' && message.payload.runId === review.runId,
      'run.stop of the review',
    );
    expect(await h.run(review.runId)).toMatchObject({
      status: 'failed',
      failureReason: 'review_branch_moved',
    });
    expect(await h.ticket()).toMatchObject({ status: 'in_review', attemptCount: 0 });
    expect(await lastBody()).toBe(
      `The review run on machine Laptop ended without a decision: the pull request changed on GitHub during the review (now ${head.slice(0, 7)}). It does not count as a failed attempt.`,
    );
  });
});

describe('refusals of the review tools', () => {
  it('a second decision, a question or a give-up after one', async () => {
    const { daemon } = await inReview();
    const review = await h.reviewing(daemon);
    await h.ok(daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    const again = 'You already approved this ticket in this run: end your turn.';
    for (const [tool, input] of [
      ['review_approve', { summary: SUMMARY }],
      ['review_request_changes', { points: POINTS }],
      ['ticket_ask', { question: 'Anything else?' }],
      ['ticket_give_up', { reason: 'x', tried: 'y' }],
    ] as const) {
      expect(await h.tool(daemon, review.runToken, tool, input)).toEqual({
        ok: false,
        error: { code: 'INVALID_TRANSITION', message: again },
      });
    }
    expect(await decision(review.runId)).toMatchObject({ kind: 'approved', summary: SUMMARY });
  });

  it('a decision after the run ended', async () => {
    const { daemon } = await inReview();
    const review = await h.reviewing(daemon);
    await ended(daemon, review.runId, 'stopped');
    const answer = await h.tool(daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    expect(answer).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(!answer.ok && answer.error.message).toMatch(/^This run has ended/);
  });

  it('a builder: its role does not allow the review tools', async () => {
    await h.start();
    await h.createTicket();
    const { daemon } = await h.machine();
    const { runToken } = await h.running(daemon);
    expect(await h.tool(daemon, runToken, 'review_approve', { summary: SUMMARY })).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Your role (builder) does not allow review_approve.' },
    });
  });

  it('a reviewer that implemented the ticket in an earlier run, with a custom profile (answer 6g)', async () => {
    const { daemon, implementRunId } = await inReview();
    const review = await h.reviewing(daemon);
    // A custom reviewer profile, as if it had implemented the ticket too.
    const [quality] = await h.t.db
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.key, 'quality'));
    if (!quality) throw new Error('no quality profile');
    const [custom] = await h.t.db
      .insert(schema.agentProfiles)
      .values({
        ...quality,
        id: undefined,
        key: 'strict_checker',
        name: 'Strict checker',
        isDefault: false,
      })
      .returning();
    if (!custom) throw new Error('no custom profile');
    await h.t.db
      .update(schema.runs)
      .set({ profileId: custom.id })
      .where(eq(schema.runs.id, implementRunId));
    await h.t.db
      .update(schema.runs)
      .set({ profileId: custom.id })
      .where(eq(schema.runs.id, review.runId));
    expect(await h.tool(daemon, review.runToken, 'review_approve', { summary: SUMMARY })).toEqual({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message:
          'Strict checker implemented this ticket in an earlier run, so it cannot review it: end your turn without a decision.',
      },
    });
    expect(await decision(review.runId)).toBeNull();
  });
});

describe('the owner during a review', () => {
  it('Request changes is refused while a review run is active (answer 6e)', async () => {
    const { daemon } = await inReview();
    await h.reviewing(daemon);
    const response = await h.call('POST', '/api/projects/WEB/tickets/1/request-changes', {
      comment: 'Rename the form.',
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(ApiError.parse(response.json()).error.code).toBe('review_active');
    expect((await h.ticket()).status).toBe('in_review');
  });
});

describe('Skip review', () => {
  function skip() {
    return h.call('POST', '/api/projects/WEB/tickets/1/skip-review');
  }

  it('moves the ticket to awaiting_merge with a comment, starting no session', async () => {
    const { daemon } = await inReview();
    const starts = daemon.received.filter((message) => message.type === 'run.start').length;
    const response = await skip();
    expect(response.statusCode, response.body).toBe(200);
    const ticket = await h.ticket();
    expect(ticket.status).toBe('awaiting_merge');
    expect(comments(ticket).at(-1)).toMatchObject({
      kind: 'status_change',
      body: 'The owner skipped the review.',
    });
    expect((await h.events('ticket.status_changed')).at(-1)).toMatchObject({
      actor: 'owner',
      payload: { from: 'in_review', to: 'awaiting_merge', action: 'skip_review' },
    });
    expect(daemon.received.filter((message) => message.type === 'run.start')).toHaveLength(starts);
  });

  it('is refused while a review run is active, and outside in_review', async () => {
    const { daemon } = await inReview();
    await h.reviewing(daemon);
    const during = await skip();
    expect(during.statusCode, during.body).toBe(409);
    expect(ApiError.parse(during.json()).error.code).toBe('review_active');
    expect((await h.ticket()).status).toBe('in_review');

    await h.t.db.update(schema.tickets).set({ status: 'todo' });
    await h.t.db
      .update(schema.runs)
      .set({ status: 'cancelled' })
      .where(eq(schema.runs.purpose, 'review'));
    const fromTodo = await skip();
    expect(fromTodo.statusCode, fromTodo.body).toBe(409);
    expect(ApiError.parse(fromTodo.json()).error.code).toBe('ticket_transition_not_allowed');
  });
});
