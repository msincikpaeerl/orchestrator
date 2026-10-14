import { schema } from '@orchestrator/db';
import {
  ApiError,
  NeedsYouResponse,
  TicketListResponse,
  type DodReport,
  type NeedsYouItem,
  type RunStart,
  type TicketDetail,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import { RunHarness, cleanWorkspace, eventually, state } from './run-harness.js';

// Changes after a review (04, sections 2, 3.1 and 5; 07, section 3; owner's answers 1 to 7, lot
// 3 step I), against the fake GitHub: Run now starts a `fix_review` run while a request for
// changes stands, the same commit is refused, the next review is told of the earlier points,
// Quality's rounds are counted and stop the ticket past Most review rounds per ticket.

const h = new RunHarness();

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
const POINTS = [
  { body: 'Test an empty e-mail address too.', file: 'src/contact.test.ts', line: 12 },
  { body: 'Describe the form in the user documentation.' },
];
const SUMMARY = 'Both points are addressed and the tests cover them.';
const OWNER_COMMENT = 'Also add a link to the map.';

const repo = () => h.github.repository('octo-owner', 'bakery');

/** The run.start a daemon received for a run. */
function startOf(daemon: ScriptedDaemon, runId: string): RunStart {
  const start = daemon.received.find(
    (message): message is RunStart =>
      message.type === 'run.start' && message.payload.runId === runId,
  );
  if (!start) throw new Error('no run.start');
  return start;
}

/** A builder run (Run now) that submits and passes CI: the ticket in review, the commit pushed. */
async function submitted(daemon: ScriptedDaemon) {
  const run = await h.running(daemon);
  const answer = await h.tool(daemon, run.runToken, 'ticket_submit', REPORT);
  if (!answer.ok) throw new Error(JSON.stringify(answer.error));
  await h.ciPasses(daemon, run.runId);
  await eventually('the ticket in review', async () => {
    expect((await h.ticket()).status).toBe('in_review');
  });
  return { ...run, commit: h.lastPushed ?? '' };
}

/** A review run that ends with its decision applied. */
async function reviewed(daemon: ScriptedDaemon, decision: 'approve' | 'changes') {
  const review = await h.reviewing(daemon);
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

function comments(ticket: TicketDetail) {
  return ticket.timeline.flatMap((entry) => (entry.type === 'comment' ? [entry.comment] : []));
}

async function items(): Promise<NeedsYouItem[]> {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items;
}

const requestChanges = (comment = OWNER_COMMENT) =>
  h.call('POST', '/api/projects/WEB/tickets/1/request-changes', { comment });

async function ticketRow() {
  const [row] = await h.t.db.select().from(schema.tickets).where(eq(schema.tickets.number, 1));
  if (!row) throw new Error('no ticket');
  return row;
}

describe('a full round', () => {
  it("fixes Quality's points in a fix_review run, then the next review is told of them and approves", async () => {
    const { daemon, first } = await inReview();
    await reviewed(daemon, 'changes');
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 0, reviewRounds: 1 });

    // Run now picks fix_review: builder tools, the points first, attempt 2 (answer 3).
    const fix = await h.running(daemon);
    const start = startOf(daemon, fix.runId);
    expect(start.payload.purpose).toBe('fix_review');
    expect(start.payload.mcpTools).toContain('ticket_submit');
    expect(start.payload.mcpTools).not.toContain('review_approve');
    const prompt = start.payload.initialPrompt;
    expect(prompt).toMatch(
      /^Address the review of ticket WEB-1, then submit it again with `ticket_submit`\. This is attempt 2\.\n/,
    );
    expect(prompt).toContain(
      'The branch t/1-contact-form already holds the submitted work (pull request #1): continue on it.',
    );
    expect(prompt).toContain(`## Points to address (Quality, `);
    expect(prompt).toContain(`, commit ${first.commit})`);
    expect(prompt).toContain(
      '1. `src/contact.test.ts:12`: Test an empty e-mail address too.\n2. Describe the form in the user documentation.',
    );
    // The points are not repeated among the comments.
    expect(prompt.split('## Comments')[1]).not.toContain('Test an empty e-mail address too.');
    expect((await h.run(fix.runId)).purpose).toBe('fix_review');

    // The agent says why it left one point, then hands in a new commit.
    await h.ok(daemon, fix.runToken, 'ticket_comment', {
      body: 'Point 2: the user documentation already describes the form.',
    });
    const answer = await h.tool(daemon, fix.runToken, 'ticket_submit', REPORT);
    expect(answer.ok).toBe(true);
    const fixed = h.lastPushed ?? '';
    expect(fixed).not.toBe(first.commit);
    await h.ciPasses(daemon, fix.runId);
    await eventually('the fix in review', async () => {
      expect((await h.ticket()).status).toBe('in_review');
    });
    expect(h.github.pullRequest(repo(), 1).headSha).toBe(fixed);

    // The next review: the previous review's section (answer 4).
    const review = await h.reviewing(daemon);
    const reviewPrompt = review.start.payload.initialPrompt;
    const previous = reviewPrompt
      .split('## The previous review')[1]
      ?.split('## Earlier reviews')[0];
    expect(previous).toBeDefined();
    expect(previous).toContain(`Quality requested changes on commit ${first.commit} at `);
    expect(previous).toContain('(round 1 of at most 2)');
    expect(previous).toContain(`\`git diff ${first.commit} HEAD\``);
    expect(previous).toContain('the rest of the change');
    expect(previous).toContain('1. `src/contact.test.ts:12`: Test an empty e-mail address too.');
    expect(previous).toContain('Point 2: the user documentation already describes the form.');
    // The earlier reviews section keeps only older rounds: none here.
    expect(reviewPrompt.split('## Earlier reviews')[1]?.split('## Comments')[0]).toContain(
      '(None:',
    );

    await h.ok(daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    await h.report(daemon, state(review.runId, { state: 'ended', reason: 'submitted' }));
    expect(await h.ticket()).toMatchObject({
      status: 'awaiting_merge',
      attemptCount: 0,
      reviewRounds: 1,
    });
  });

  it('says when the agent left no comment about the points', async () => {
    const { daemon } = await inReview();
    await reviewed(daemon, 'changes');
    await submitted(daemon);
    const review = await h.reviewing(daemon);
    expect(review.start.payload.initialPrompt).toContain(
      '(The agent left no comment about these points.)',
    );
  });
});

describe("the next review's first message, cut and never refused (owner's answer 1, I2)", () => {
  it('starts the review when the previous points alone are longer than the message allows', async () => {
    const { daemon } = await inReview();
    const review = await h.reviewing(daemon);
    const long = Array.from({ length: 8 }, (_, index) => ({
      body: `Point ${String(index)} ${'p'.repeat(19_000)}`,
    }));
    await h.ok(daemon, review.runToken, 'review_request_changes', { points: long });
    await h.report(daemon, state(review.runId, { state: 'ended', reason: 'submitted' }));
    await submitted(daemon);

    const next = await h.reviewing(daemon);
    const prompt = next.start.payload.initialPrompt;
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(100_000);
    expect(prompt).toContain('Point 0 ');
    expect(prompt).not.toContain('Point 7 ');
    expect(prompt).toMatch(
      /\(\d+ more points are not shown here because this message would be too long/,
    );
  });
});

describe('a fix_review run handing in nothing new (answer 1)', () => {
  it('refuses the commit Quality asked changes on, with the approved words', async () => {
    const { daemon, first } = await inReview();
    await reviewed(daemon, 'changes');
    const fix = await h.running(daemon);
    const same = cleanWorkspace();
    const workspace = {
      ...same,
      branch: { ...same.branch, head: first.commit },
      push: { status: 'pushed' as const, head: first.commit },
    };
    const answer = await h.tool(daemon, fix.runToken, 'ticket_submit', REPORT, workspace);
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.error).toMatchObject({
      code: 'DOD_FAILED',
      details: [
        {
          check: 'commits_ahead',
          message: `Commit ${first.commit} is the one Quality reviewed and asked changes on: commit your changes for its points on the branch t/1-contact-form, then submit again. If a point should not be done, say why with \`ticket_comment\`; if none should, ask the owner with \`ticket_ask\`.`,
        },
      ],
    });
    const refused = (await h.run(fix.runId)).refusedSubmission;
    expect(refused?.checks.flatMap((check) => check.reasons)).toContainEqual({
      kind: 'same_commit_request',
      commit: first.commit,
      by: 'quality',
    });
  });

  it('refuses the commit the owner asked changes on', async () => {
    const { daemon, first } = await inReview();
    expect((await requestChanges()).statusCode).toBe(200);
    const fix = await h.running(daemon);
    const same = cleanWorkspace();
    const answer = await h.tool(daemon, fix.runToken, 'ticket_submit', REPORT, {
      ...same,
      branch: { ...same.branch, head: first.commit },
      push: { status: 'pushed', head: first.commit },
    });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(JSON.stringify(answer.error.details)).toContain(
      `Commit ${first.commit} is the one the owner asked changes on: commit your changes`,
    );
  });
});

describe('attempts', () => {
  it("never counts Quality's request; a fix_review run that fails counts, and the next run gets the same points", async () => {
    const { daemon } = await inReview();
    await reviewed(daemon, 'changes');
    expect((await h.ticket()).attemptCount).toBe(0);
    const fix = await h.running(daemon);
    await h.ok(daemon, fix.runToken, 'ticket_give_up', {
      reason: 'I cannot run the tests.',
      tried: 'npm test',
    });
    await h.report(daemon, state(fix.runId, { state: 'ended', reason: 'gave_up' }));
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 1, reviewRounds: 1 });

    const again = await h.running(daemon);
    const start = startOf(daemon, again.runId);
    expect(start.payload.purpose).toBe('fix_review');
    expect(start.payload.initialPrompt).toContain('This is attempt 3.');
    expect(start.payload.initialPrompt).toContain('1. `src/contact.test.ts:12`');
  });
});

describe('the rounds limit (answer 2)', () => {
  it('applies the request one more than the limit, stops the ticket, refuses Run now, lists it; Try again lets it continue', async () => {
    const { daemon } = await inReview({ maxReviewRounds: 1 });
    await reviewed(daemon, 'changes');
    expect((await h.ticket()).stop).toBeNull();
    await submitted(daemon);
    const second = await reviewed(daemon, 'changes');

    // Applied in full, then stopped.
    const ticket = await h.ticket();
    expect(ticket).toMatchObject({
      status: 'todo',
      reviewRounds: 2,
      stop: { cause: 'review_rounds', count: 2, limit: 1 },
    });
    expect(comments(ticket).filter((comment) => comment.kind === 'review')).toHaveLength(4);
    expect(comments(ticket).at(-1)).toMatchObject({
      author: 'system',
      body: 'Quality requested changes again (round 2), more than Most review rounds per ticket allows (1): the ticket is stopped. Use Try again to let it continue, or Cancel it, or Mark it as done manually.',
    });
    await eventually('the review posted on GitHub', () => {
      expect(
        h.github.pullRequest(repo(), 1).reviews.filter((review) => review.user === 'octo-owner'),
      ).toHaveLength(2);
    });
    expect((await h.events('ticket.stopped')).at(-1)?.payload).toMatchObject({
      ticket: 'WEB-1',
      cause: 'review_rounds',
      count: 2,
      limit: 1,
      runId: second.runId,
    });

    // The board's list carries the stop for its "Stopped" badge (owner's answer 2, step I2).
    const board = await h.call('GET', '/api/projects/WEB/tickets');
    expect(TicketListResponse.parse(board.json()).tickets[0]?.stop).toMatchObject({
      cause: 'review_rounds',
      count: 2,
      limit: 1,
    });

    const refused = await h.call('POST', '/api/projects/WEB/tickets/1/run');
    expect(refused.statusCode).toBe(409);
    expect(ApiError.parse(refused.json()).error).toMatchObject({
      code: 'run_not_possible',
      runRefusal: { reason: 'ticket_stopped', cause: 'review_rounds', count: 2, limit: 1 },
    });
    expect((await items()).filter((item) => item.type === 'ticket_stopped')).toEqual([
      {
        type: 'ticket_stopped',
        ticket: { projectKey: 'WEB', number: 1, title: 'Contact form' },
        cause: 'review_rounds',
        count: 2,
        limit: 1,
        since: expect.any(String) as string,
      },
    ]);

    // Try again: the counts start again, with a comment; Run now starts the fix.
    const tried = await h.call('POST', '/api/projects/WEB/tickets/1/try-again');
    expect(tried.statusCode, tried.body).toBe(200);
    const after = await h.ticket();
    expect(after).toMatchObject({ status: 'todo', reviewRounds: 0, attemptCount: 0, stop: null });
    expect(comments(after).at(-1)).toMatchObject({ author: 'owner', kind: 'status_change' });
    expect((await items()).some((item) => item.type === 'ticket_stopped')).toBe(false);
    expect((await h.events('ticket.tried_again')).length).toBe(1);
    const fix = await h.running(daemon);
    expect(startOf(daemon, fix.runId).payload.purpose).toBe('fix_review');

    // The next review leaves the round out of a request made before Try again (answer 4, I2).
    await h.ok(daemon, fix.runToken, 'ticket_submit', REPORT);
    await h.ciPasses(daemon, fix.runId);
    await eventually('the fix in review', async () => {
      expect((await h.ticket()).status).toBe('in_review');
    });
    const review = await h.reviewing(daemon);
    const previous =
      review.start.payload.initialPrompt
        .split('## The previous review')[1]
        ?.split('## Earlier reviews')[0] ?? '';
    expect(previous).toMatch(/Quality requested changes on commit [0-9a-f]{40} at [^.(]+ UTC\. /);
    expect(previous).not.toContain('(round');
    // Four runs through to their reviews: 1.6 seconds on an idle machine, up to 5.3 under a full
    // run with two more suites (lot 3 step J3a, measured): the default 5 seconds was too short.
  }, 15_000);

  it('refuses Try again on a ticket that is not stopped', async () => {
    await inReview();
    const response = await h.call('POST', '/api/projects/WEB/tickets/1/try-again');
    expect(response.statusCode).toBe(409);
    expect(ApiError.parse(response.json()).error.code).toBe('ticket_not_stopped');
  });

  it("never counts the owner's request, and Reopen starts the count again", async () => {
    const { daemon } = await inReview({ maxReviewRounds: 1 });
    expect((await requestChanges()).statusCode).toBe(200);
    expect((await h.ticket()).reviewRounds).toBe(0);
    await submitted(daemon);
    await reviewed(daemon, 'changes');
    await submitted(daemon);
    await reviewed(daemon, 'changes');
    expect((await h.ticket()).stop).toMatchObject({ cause: 'review_rounds' });
    expect((await h.call('POST', '/api/projects/WEB/tickets/1/cancel')).statusCode).toBe(200);
    expect((await h.call('POST', '/api/projects/WEB/tickets/1/reopen')).statusCode).toBe(200);
    expect(await h.ticket()).toMatchObject({ status: 'todo', reviewRounds: 0, stop: null });
  });
});

describe("the owner's Request changes (answer 6)", () => {
  it('is offered in review and on Awaiting merge, refused elsewhere and while a review runs', async () => {
    const { daemon } = await inReview();
    const review = await h.reviewing(daemon);
    expect((await requestChanges()).statusCode).toBe(409);
    expect(ApiError.parse((await requestChanges()).json()).error.code).toBe('review_active');
    await h.ok(daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    await h.report(daemon, state(review.runId, { state: 'ended', reason: 'submitted' }));
    expect((await h.ticket()).status).toBe('awaiting_merge');
    const reviewsBefore = h.github.pullRequest(repo(), 1).reviews.length;

    const response = await requestChanges();
    expect(response.statusCode, response.body).toBe(200);
    const ticket = await h.ticket();
    expect(ticket).toMatchObject({ status: 'todo', reviewRounds: 0, attemptCount: 0 });
    expect((await requestChanges()).statusCode).toBe(409);
    // Nothing is posted on GitHub for the owner's request.
    expect(h.github.pullRequest(repo(), 1).reviews.length).toBe(reviewsBefore);
    expect(ticket.changeRequest).toMatchObject({
      request: { by: 'owner', after: 'approved' },
      standing: true,
    });

    // Its fix_review run, then the next review is told of it.
    const fix = await h.running(daemon);
    const prompt = startOf(daemon, fix.runId).payload.initialPrompt;
    expect(startOf(daemon, fix.runId).payload.purpose).toBe('fix_review');
    expect(prompt).toContain("## Points to address (the owner's request, ");
    expect(prompt).toContain(OWNER_COMMENT);
    await h.tool(daemon, fix.runToken, 'ticket_submit', REPORT);
    await h.ciPasses(daemon, fix.runId);
    await eventually('the fix in review', async () => {
      expect((await h.ticket()).status).toBe('in_review');
    });
    expect((await h.ticket()).changeRequest?.standing).toBe(false);
    const next = await h.reviewing(daemon);
    const previous = next.start.payload.initialPrompt.split('## The previous review')[1] ?? '';
    expect(previous).toMatch(
      /The owner requested changes at [^,]+, on commit [0-9a-f]{40} \(Quality had approved it\): Also add a link to the map\./,
    );
  });

  it('after Skip review says the review was skipped', async () => {
    const { daemon } = await inReview();
    expect((await h.call('POST', '/api/projects/WEB/tickets/1/skip-review')).statusCode).toBe(200);
    expect((await requestChanges()).statusCode).toBe(200);
    expect((await h.ticket()).changeRequest?.request).toMatchObject({
      by: 'owner',
      after: 'skipped',
    });
    await submitted(daemon);
    const next = await h.reviewing(daemon);
    expect(next.start.payload.initialPrompt).toContain('(the review was skipped)');
  });
});

describe('a ticket left in review by 0.3.0, without a pull request (answer 5)', () => {
  /** In review, its commits on the machine only, as 0.3.0 left it. */
  async function legacy() {
    const machine = await inReview();
    await h.t.db.update(schema.tickets).set({
      pullRequestNumber: null,
      pullRequestUrl: null,
      pullRequestState: null,
      pullRequestHead: null,
      githubBranchHead: null,
      githubBranchPushedAt: null,
      githubBranchPushedBy: null,
      githubBranchCommits: null,
    });
    await h.t.db
      .update(schema.runs)
      .set({ notOnGitHub: null, ciCommit: null, ciResult: null, push: null, pushAt: null });
    return machine;
  }

  it('takes Request changes, then a fix_review run on the machine holding the work, which opens the pull request', async () => {
    const { daemon, first } = await legacy();
    expect((await requestChanges()).statusCode).toBe(200);
    expect((await ticketRow()).changeRequest).toMatchObject({ by: 'owner', after: null });
    const fix = await h.running(daemon);
    const prompt = startOf(daemon, fix.runId).payload.initialPrompt;
    expect(startOf(daemon, fix.runId).payload.purpose).toBe('fix_review');
    expect(prompt).toContain(
      'committed on this machine and not on GitHub yet: continue on it; `ticket_submit` pushes it and the Orchestrator opens its pull request.',
    );
    expect(first.commit).toMatch(/^[0-9a-f]{40}$/);
    const answer = await h.tool(daemon, fix.runToken, 'ticket_submit', REPORT);
    expect(answer.ok).toBe(true);
    await h.ciPasses(daemon, fix.runId);
    await eventually('the ticket in review with its pull request', async () => {
      const ticket = await h.ticket();
      expect(ticket.status).toBe('in_review');
      expect(ticket.pullRequest.opened).not.toBeNull();
    });
  });

  it('starts the fix_review run again from the base branch when the machine holding the work was revoked', async () => {
    const { id } = await legacy();
    expect((await requestChanges()).statusCode).toBe(200);
    expect((await h.call('POST', `/api/machines/${id}/revoke`)).statusCode).toBe(200);
    const other = await h.machine('Desktop');
    const fix = await h.running(other.daemon);
    const start = startOf(other.daemon, fix.runId);
    expect(start.payload.purpose).toBe('fix_review');
    expect(start.payload.initialPrompt).toContain(
      'The earlier work on this ticket is no longer available',
    );
    expect(start.payload.initialPrompt).toContain(
      'The branch t/1-contact-form starts again from origin/main: implement the ticket again, with the points below in mind.',
    );
  });
});

describe('going on without the fix (owner, step I)', () => {
  it('lets the owner merge on GitHub and use Mark as done manually from To do with a request standing', async () => {
    const { daemon } = await inReview();
    await reviewed(daemon, 'changes');
    expect((await h.ticket()).status).toBe('todo');
    h.github.mergePullRequest(repo(), 1);
    expect(h.github.pullRequest(repo(), 1).merged).toBe(true);
    const done = await h.call('POST', '/api/projects/WEB/tickets/1/mark-done', {
      comment: 'I disagree with the review: merged it as it was.',
    });
    expect(done.statusCode, done.body).toBe(200);
    expect((await h.ticket()).status).toBe('done');
  });

  it('also from a ticket stopped after too many review rounds', async () => {
    const { daemon } = await inReview({ maxReviewRounds: 1 });
    await reviewed(daemon, 'changes');
    await submitted(daemon);
    await reviewed(daemon, 'changes');
    expect((await h.ticket()).stop).not.toBeNull();
    h.github.mergePullRequest(repo(), 1);
    const done = await h.call('POST', '/api/projects/WEB/tickets/1/mark-done', {
      comment: 'Merged as it was.',
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(await h.ticket()).toMatchObject({ status: 'done' });
    expect((await items()).some((item) => item.type === 'ticket_stopped')).toBe(false);
  });
});
