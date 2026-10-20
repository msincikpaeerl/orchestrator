import { schema } from '@orchestrator/db';
import {
  NeedsYouResponse,
  Run,
  type DodReport,
  type NeedsYouItem,
  type RunStart,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import { RunHarness, eventually, state } from './run-harness.js';

// What the screens show of reviews (02, sections 4, 6.4 and 7; owner's answers 2 to 5, lot 3
// steps H and H4): "Ready for review" and "Review did not finish" in "Needs you", the ticket
// page's latest review (with the work in review and whether that review is about an earlier
// submission), and the run page's review card. Facts only: the UI words them.

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
const SUMMARY = 'The form checks the e-mail address.';
const POINTS = [
  { body: 'Test an empty e-mail address too.', file: 'src/contact.test.ts', line: 12 },
];

/** Implemented, submitted, CI passed: the ticket in review, and the commit CI checked. */
async function submitted(daemon: ScriptedDaemon) {
  const { runId, runToken } = await h.running(daemon);
  const answer = await h.tool(daemon, runToken, 'ticket_submit', REPORT);
  if (!answer.ok) throw new Error(JSON.stringify(answer.error));
  await h.ciPasses(daemon, runId);
  await eventually('the ticket in review', async () => {
    expect((await h.ticket()).status).toBe('in_review');
  });
  return h.lastPushed ?? '';
}

async function inReview() {
  await h.start();
  await h.createTicket();
  const machine = await h.machine();
  const commit = await submitted(machine.daemon);
  return { ...machine, commit };
}

async function items(): Promise<NeedsYouItem[]> {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items;
}

async function reviewItems() {
  return (await items()).filter(
    (item) =>
      item.type === 'ready_for_review' ||
      item.type === 'review_not_finished' ||
      item.type === 'work_to_check',
  );
}

async function ended(
  daemon: ScriptedDaemon,
  runId: string,
  reason: 'submitted' | 'stopped' | 'gave_up' | 'max_duration',
  headMoved?: boolean,
) {
  await h.report(daemon, state(runId, { state: 'ended', reason, headMoved }));
}

describe('"Ready for review"', () => {
  it('lists a ticket in review with its pull request, the commit CI checked and the CI line', async () => {
    const { commit } = await inReview();
    const ticket = await h.ticket();
    expect(await reviewItems()).toEqual([
      {
        type: 'ready_for_review',
        ticket: { projectKey: 'WEB', number: 1, title: 'Contact form' },
        pullRequest: { number: 1, url: ticket.pullRequest.opened?.url },
        commit,
        ci: 'passed',
        checkedAgainAt: null,
        workflowFlag: null,
        start: 'by_itself',
        since: expect.any(String) as string,
      },
    ]);
    expect(ticket.review).toEqual({
      latest: null,
      current: { commit, earlier: false },
      offered: true,
      start: 'by_itself',
    });
  });

  it('keeps "Work finished: check it" for a ticket left in review by 0.3.0, without a pull request', async () => {
    await inReview();
    await h.t.db.update(schema.tickets).set({ pullRequestNumber: null, pullRequestUrl: null });
    expect((await reviewItems()).map((item) => item.type)).toEqual(['work_to_check']);
    expect((await h.ticket()).review.offered).toBe(false);
  });

  it('is gone while the review runs: the ticket page says it is in progress, the run has its card', async () => {
    const { daemon, commit, id } = await inReview();
    const review = await h.reviewing(daemon);
    expect(await reviewItems()).toEqual([]);
    expect((await h.ticket()).review).toEqual({
      latest: { kind: 'in_progress', runId: review.runId, machine: { id, name: 'Laptop' } },
      current: { commit, earlier: false },
      offered: false,
      start: null,
    });
    expect((await h.run(review.runId)).review).toEqual({
      commit,
      pullRequest: 1,
      decision: null,
      applied: false,
      notApplied: null,
      post: null,
    });
    // Other runs have no review card.
    const implement = (await h.t.db.select().from(schema.runs)).find(
      (row) => row.purpose === 'implement',
    );
    expect((await h.run(implement?.id ?? '')).review).toBeNull();
  });
});

describe('a decision applied', () => {
  it('an approval: the ticket page shows it with its post, the run card too', async () => {
    const { daemon, commit } = await inReview();
    const review = await h.reviewing(daemon);
    await h.ok(daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    await ended(daemon, review.runId, 'submitted');
    await eventually('the review posted', async () => {
      expect((await h.run(review.runId)).review?.post?.state).toBe('posted');
    });
    const ticket = await h.ticket();
    expect(ticket.status).toBe('awaiting_merge');
    expect(ticket.review).toMatchObject({
      latest: {
        kind: 'decision',
        runId: review.runId,
        decision: { kind: 'approved', commit, summary: SUMMARY, headChecked: true },
        post: { state: 'posted', pullRequest: 1 },
      },
      current: null,
      offered: false,
    });
    expect((await h.run(review.runId)).review).toMatchObject({
      commit,
      pullRequest: 1,
      decision: { kind: 'approved' },
      applied: true,
      notApplied: null,
    });
    expect(await reviewItems()).toEqual([]);
  });

  it('a request for changes, then the fix back in review: about an earlier submission', async () => {
    const { daemon, commit } = await inReview();
    const review = await h.reviewing(daemon);
    await h.ok(daemon, review.runToken, 'review_request_changes', { points: POINTS });
    await ended(daemon, review.runId, 'submitted');
    expect((await h.ticket()).review).toMatchObject({
      latest: { kind: 'decision', decision: { kind: 'changes_requested', commit } },
      current: null,
      offered: false,
    });

    // The agent fixes it: a new commit nobody reviewed (owner's change to answer 4).
    const fixed = await submitted(daemon);
    expect(fixed).not.toBe(commit);
    const ticket = await h.ticket();
    expect(ticket.review).toMatchObject({
      latest: { kind: 'decision', decision: { kind: 'changes_requested', commit } },
      current: { commit: fixed, earlier: true },
      offered: true,
    });
    expect(await reviewItems()).toMatchObject([{ type: 'ready_for_review', commit: fixed }]);
  });

  it('a skip made out of date by new work: about an earlier submission', async () => {
    const { daemon } = await inReview();
    const skipped = await h.call('POST', '/api/projects/WEB/tickets/1/skip-review');
    expect(skipped.statusCode, skipped.body).toBe(200);
    const at = (await h.ticket()).review.latest;
    expect(at).toMatchObject({ kind: 'skipped' });
    // Until step I, Request changes is not offered on Awaiting merge: the ticket is put back to
    // To do as it will then leave it.
    await h.t.db.update(schema.tickets).set({ status: 'todo' });
    const fixed = await submitted(daemon);
    expect((await h.ticket()).review).toEqual({
      latest: at,
      current: { commit: fixed, earlier: true },
      offered: true,
      start: 'by_itself',
    });
  });
});

describe('"Review did not finish"', () => {
  it('a decision thrown away by Stop run: which decision, and why', async () => {
    const { daemon, commit, id } = await inReview();
    const review = await h.reviewing(daemon);
    await h.ok(daemon, review.runToken, 'review_request_changes', { points: POINTS });
    const stopped = await h.call('POST', `/api/runs/${review.runId}/stop`);
    expect(stopped.statusCode, stopped.body).toBe(200);
    const [item] = await reviewItems();
    expect(item).toMatchObject({
      type: 'review_not_finished',
      runId: review.runId,
      machine: { id, name: 'Laptop' },
      decision: { kind: 'changes_requested', commit, points: [{ body: POINTS[0]?.body }] },
      end: { why: 'stopped' },
    });
    expect((await h.ticket()).review).toMatchObject({
      latest: { kind: 'not_finished', runId: review.runId, end: { why: 'stopped' } },
      current: { commit, earlier: false },
      offered: true,
      start: 'held',
    });
    expect((await h.run(review.runId)).review).toMatchObject({
      decision: { kind: 'changes_requested' },
      applied: false,
      notApplied: { why: 'stopped' },
      post: null,
    });
  });

  it('Stop run without a decision: plain "Ready for review" again', async () => {
    const { daemon } = await inReview();
    const review = await h.reviewing(daemon);
    const stopped = await h.call('POST', `/api/runs/${review.runId}/stop`);
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect((await reviewItems()).map((item) => item.type)).toEqual(['ready_for_review']);
    expect((await h.ticket()).review.latest).toBeNull();
    expect((await h.run(review.runId)).review?.notApplied).toEqual({ why: 'stopped' });
  });

  it('Quality gave up, with its reason', async () => {
    const { daemon } = await inReview();
    const review = await h.reviewing(daemon);
    await h.ok(daemon, review.runToken, 'ticket_give_up', {
      reason: 'The diff is empty.',
      tried: 'git diff',
    });
    await ended(daemon, review.runId, 'gave_up');
    expect(await reviewItems()).toMatchObject([
      { type: 'review_not_finished', decision: null, end: { why: 'gave_up' } },
    ]);
    const [item] = await reviewItems();
    expect(item?.type === 'review_not_finished' && item.end).toEqual({
      why: 'gave_up',
      reason: expect.stringContaining('The diff is empty.') as string,
    });
  });

  it('a timeout after a decision', async () => {
    const { daemon } = await inReview();
    const review = await h.reviewing(daemon);
    await h.ok(daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    await ended(daemon, review.runId, 'max_duration');
    expect(await reviewItems()).toMatchObject([
      {
        type: 'review_not_finished',
        decision: { kind: 'approved' },
        end: { why: 'failed', failureReason: 'timeout' },
      },
    ]);
  });

  it('the branch moved on the machine', async () => {
    const { daemon } = await inReview();
    const review = await h.reviewing(daemon);
    await h.ok(daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    await ended(daemon, review.runId, 'submitted', true);
    expect(await reviewItems()).toMatchObject([
      { type: 'review_not_finished', end: { why: 'moved_on_machine' } },
    ]);
  });

  it('the pull request moved on GitHub at the decision, with its head then', async () => {
    const { daemon } = await inReview();
    const review = await h.reviewing(daemon);
    const head = h.github.commit(
      h.github.repository('octo-owner', 'bakery'),
      't/1-contact-form',
      { 'src/by-hand.ts': 'export {};\n' },
      'By hand',
    );
    const answer = await h.tool(daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    expect(answer.ok).toBe(false);
    await eventually('the review failed', async () => {
      expect((await h.run(review.runId)).status).toBe('failed');
    });
    expect(await reviewItems()).toMatchObject([
      { type: 'review_not_finished', decision: null, end: { why: 'moved_on_github', head } },
    ]);
  });

  it('the pull request moved on GitHub before the review started (owner answer 3)', async () => {
    const { daemon, commit } = await inReview();
    const response = await h.call('POST', '/api/projects/WEB/tickets/1/review');
    expect(response.statusCode, response.body).toBe(201);
    const runId = Run.parse(response.json()).id;
    const start = await daemon.find<RunStart>(
      (message) => message.type === 'run.start' && message.payload.runId === runId,
      'run.start of the review',
    );
    daemon.send({ type: 'ack', id: start.id, payload: { ok: true } });
    await h.report(daemon, state(runId, { state: 'preparing' }));
    const moved = 'd'.repeat(40);
    await h.report(
      daemon,
      state(runId, {
        state: 'ended',
        reason: 'review_branch_moved',
        movedHead: moved,
        detail: `The ticket branch on GitHub moved since the review was started: it is now ddddddd, not ${commit.slice(0, 7)}.`,
      }),
    );
    expect(await reviewItems()).toMatchObject([
      {
        type: 'review_not_finished',
        decision: null,
        end: { why: 'moved_before_start', head: moved },
      },
    ]);
    const ticket = await h.ticket();
    const comment = ticket.timeline.flatMap((entry) =>
      entry.type === 'comment' ? [entry.comment.body] : [],
    );
    expect(comment.at(-1)).toBe(
      'The review run on machine Laptop ended without a decision: the pull request changed on GitHub before the review started (now ddddddd). It does not count as a failed attempt.',
    );
  });

  it('only about the work in review: an older review run that did not finish is passed over', async () => {
    const { daemon } = await inReview();
    const review = await h.reviewing(daemon);
    await ended(daemon, review.runId, 'gave_up');
    await h.t.db
      .update(schema.runs)
      .set({ reviewCommit: 'e'.repeat(40) })
      .where(eq(schema.runs.id, review.runId));
    expect((await reviewItems()).map((item) => item.type)).toEqual(['ready_for_review']);
    expect((await h.ticket()).review.latest).toBeNull();
  });
});
