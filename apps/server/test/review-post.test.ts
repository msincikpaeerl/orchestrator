import { schema } from '@orchestrator/db';
import { ReviewPost, type DodReport } from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import type { FakeReview, FakeReply } from './fake-github/common.js';
import { unprocessable } from './fake-github/common.js';
import type { RecordedRequest } from './fake-github.js';
import { RunHarness, TOKEN, eventually, state } from './run-harness.js';

// Quality's comment review on GitHub (06, section 4.5; owner's answers 1 to 4, lot 3 step H3),
// against the fake GitHub: one comment review per decision on the reviewed commit, posted at most
// once after the decision is applied; the agent's text made harmless; a refused post keeping the
// decision with the note and the event; an answer lost after the request left, and a server
// restart during the post, settled by reading the pull request's reviews, never by posting twice.

const h = new RunHarness();

afterEach(async () => {
  h.github.override = undefined;
  h.github.alter = undefined;
  await h.github.setReachable(true);
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

const repo = () => h.github.repository('octo-owner', 'bakery');
const pull = () => h.github.pullRequest(repo(), 1);
const ours = () => pull().reviews.filter((review) => review.user === 'octo-owner');

const isPost = (request: RecordedRequest) =>
  request.method === 'POST' && /\/pulls\/1\/reviews$/.test(request.path);
const isList = (request: RecordedRequest) =>
  request.method === 'GET' && /\/pulls\/1\/reviews\?/.test(request.path);
const posts = () => h.github.requests.filter(isPost).length;
const lists = () => h.github.requests.filter(isList).length;

/** A ticket in review: implemented, submitted, CI passed; then a review run working on it. */
async function reviewing() {
  await h.start();
  await h.createTicket();
  const { daemon } = await h.machine();
  const { runId, runToken } = await h.running(daemon);
  const answer = await h.tool(daemon, runToken, 'ticket_submit', REPORT);
  if (!answer.ok) throw new Error(JSON.stringify(answer.error));
  await h.ciPasses(daemon, runId);
  await eventually('the ticket in review', async () => {
    expect((await h.ticket()).status).toBe('in_review');
  });
  const commit = h.lastPushed ?? '';
  const review = await h.reviewing(daemon);
  return { daemon, commit, ...review };
}

async function ended(daemon: ScriptedDaemon, runId: string) {
  await h.report(daemon, state(runId, { state: 'ended', reason: 'submitted' }));
}

async function runRow(id: string) {
  const [row] = await h.t.db.select().from(schema.runs).where(eq(schema.runs.id, id));
  if (!row) throw new Error('no run');
  return row;
}

/** What became of the run's post, once recorded. */
async function outcome(runId: string): Promise<ReviewPost> {
  let post: ReviewPost | undefined;
  await eventually('the post recorded', async () => {
    const row = await runRow(runId);
    expect(row.reviewPost).not.toBeNull();
    expect(row.reviewPostWantedAt).toBeNull();
    post = ReviewPost.parse(row.reviewPost);
  });
  if (!post) throw new Error('no post');
  return post;
}

/** An approval of the reviewed commit, applied at the run's end; then its post's outcome. */
async function approved(summary = SUMMARY) {
  const review = await reviewing();
  await h.ok(review.daemon, review.runToken, 'review_approve', { summary });
  await ended(review.daemon, review.runId);
  expect((await h.ticket()).status).toBe('awaiting_merge');
  return { ...review, post: await outcome(review.runId) };
}

const notPostedEvents = async () =>
  (await h.events('ticket.review_not_posted')).map((event) => event.payload);

describe('the comment review', () => {
  it('an approval: one comment review on the reviewed commit, with its event', async () => {
    const { commit, runId, post } = await approved();
    expect(post).toMatchObject({ state: 'posted', pullRequest: 1 });
    const [review] = ours();
    expect(ours()).toHaveLength(1);
    expect(review).toMatchObject({ state: 'COMMENTED', commitId: commit });
    expect(review?.body).toBe(
      [
        `**Quality review: approved** · commit ${commit.slice(0, 7)}`,
        '',
        SUMMARY,
        '',
        '— Posted by the Orchestrator for WEB-1 (http://localhost:8080/projects/WEB/tickets/1, which opens only on the computer running the Orchestrator). The owner merges this pull request.',
        '',
        `<!-- orchestrator-review run=${runId} -->`,
      ].join('\n'),
    );
    expect(post.state === 'posted' && post.url).toContain(
      `#pullrequestreview-${String(review?.id)}`,
    );
    expect((await h.events('ticket.review_posted')).map((event) => event.payload)).toEqual([
      expect.objectContaining({ ticket: 'WEB-1', runId, commit, pullRequest: 1 }),
    ]);
    // Nothing read before a first post.
    expect(posts()).toBe(1);
    expect(lists()).toBe(0);
  });

  it('a request for changes: the points numbered, with their files', async () => {
    const review = await reviewing();
    await h.ok(review.daemon, review.runToken, 'review_request_changes', {
      points: [
        { body: 'Test an empty e-mail address too.', file: 'src/contact.test.ts', line: 12 },
        { body: 'Describe the form in the user documentation.' },
      ],
    });
    await ended(review.daemon, review.runId);
    expect((await h.ticket()).status).toBe('todo');
    expect(await outcome(review.runId)).toMatchObject({ state: 'posted' });
    const body = ours()[0]?.body ?? '';
    expect(ours()[0]?.commitId).toBe(review.commit);
    expect(body).toContain(
      `**Quality review: changes requested** · commit ${review.commit.slice(0, 7)} · 2 points\n\n1. \`src/contact.test.ts:12\`: Test an empty e-mail address too.\n2. Describe the form in the user documentation.\n\n— Posted by the Orchestrator for WEB-1`,
    );
    expect(body).toContain('The agent that implemented it addresses these points in its next run.');
  });

  it('a decision "head not checked" is posted too, on the reviewed commit (answer 3)', async () => {
    const review = await reviewing();
    h.github.override = (request) =>
      request.method === 'GET' && /\/pulls\/1$/.test(request.path) ? { status: 502 } : undefined;
    const answer = await h.ok(review.daemon, review.runToken, 'review_approve', {
      summary: SUMMARY,
    });
    expect(answer).toMatchObject({ head_checked: false });
    h.github.override = undefined;
    await ended(review.daemon, review.runId);
    expect(await outcome(review.runId)).toMatchObject({ state: 'posted' });
    expect(ours().map((each) => each.commitId)).toEqual([review.commit]);
  });
});

describe('the agent text, made harmless', () => {
  it('no working mention or issue reference; no token or local path', async () => {
    const review = await reviewing();
    const github = `ghp_${'a'.repeat(36)}`;
    const summary = [
      'Thanks @octocat: fixes #3 and closes GH-4.',
      `Tokens: ${github} ${review.runToken}`,
      `Read /home/ana/.orchestrator/worktrees/${review.runId}/src/contact.ts and /mnt/c/Users/ana/notes.md`,
    ].join('\n');
    await h.ok(review.daemon, review.runToken, 'review_approve', { summary });
    await ended(review.daemon, review.runId);
    expect(await outcome(review.runId)).toMatchObject({ state: 'posted' });
    const body = ours()[0]?.body ?? '';
    expect(body).toContain('Thanks @\u200boctocat: fixes #\u200b3 and closes GH-\u200b4.');
    expect(body).toContain('Tokens: [hidden] [hidden]');
    // A path elsewhere stays as written (answer 4b, narrowed on 2026-10-10).
    expect(body).toContain('Read src/contact.ts and /mnt/c/Users/ana/notes.md');
    for (const leak of [github, review.runToken, TOKEN, '/home/', '.orchestrator']) {
      expect(body).not.toContain(leak);
    }
    // The ticket keeps the agent's own text: paths are made harmless only on GitHub (answer 4b).
    const [comment] = (await h.ticket()).timeline.flatMap((entry) =>
      entry.type === 'comment' && entry.comment.kind === 'review' ? [entry.comment] : [],
    );
    expect(comment?.body).toContain('/home/ana/.orchestrator/worktrees/');
  });

  it('a review too long: points kept whole in order, then how many more', async () => {
    const review = await reviewing();
    const points = Array.from({ length: 30 }, (_, index) => ({
      body: `Point ${String(index + 1)}: ${'x'.repeat(5_000)}`,
    }));
    await h.ok(review.daemon, review.runToken, 'review_request_changes', { points });
    await ended(review.daemon, review.runId);
    expect(await outcome(review.runId)).toMatchObject({ state: 'posted' });
    const body = ours()[0]?.body ?? '';
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain('· 30 points');
    expect(body).toMatch(
      /\n12\. Point 12: x+\n… and 18 more points: see the ticket page\n\n— Posted/,
    );
  });
});

describe('a refused post: the decision stands, with the note and the event', () => {
  it('a permission missing (403)', async () => {
    const review = await reviewing();
    const account = h.github.accounts.get(TOKEN);
    if (!account) throw new Error('no account');
    await h.ok(review.daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    account.permissions.pull_requests = 'read';
    await ended(review.daemon, review.runId);
    expect(await outcome(review.runId)).toMatchObject({
      state: 'not_posted',
      reason: 'permission_missing',
      permission: 'pull_requests',
    });
    expect((await h.ticket()).status).toBe('awaiting_merge');
    expect(ours()).toEqual([]);
    expect(await notPostedEvents()).toEqual([
      expect.objectContaining({ outcome: 'not_posted', reason: 'permission_missing' }),
    ]);
    // No retry: the next start leaves it.
    account.permissions.pull_requests = 'write';
    await h.t.restart();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(posts()).toBe(1);
  });

  it('GitHub not reached at all: "Not posted", nothing on GitHub', async () => {
    const review = await reviewing();
    await h.ok(review.daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    await h.github.setReachable(false);
    await ended(review.daemon, review.runId);
    expect(await outcome(review.runId)).toMatchObject({
      state: 'not_posted',
      reason: 'unreachable',
    });
    await h.github.setReachable(true);
    expect(ours()).toEqual([]);
    expect((await h.ticket()).status).toBe('awaiting_merge');
    expect(await notPostedEvents()).toEqual([
      expect.objectContaining({ outcome: 'not_posted', reason: 'unreachable' }),
    ]);
  });

  it('a 422 explained by the pull request: its head moved', async () => {
    const review = await reviewing();
    await h.ok(review.daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    const head = h.github.commit(repo(), 't/1-contact-form', { 'src/x.ts': '' }, 'By hand');
    h.github.override = (request) =>
      isPost(request)
        ? unprocessable('Unprocessable Entity', ['commit_id is not part of the pull request'])
        : undefined;
    await ended(review.daemon, review.runId);
    expect(await outcome(review.runId)).toMatchObject({
      state: 'not_posted',
      reason: 'head_moved',
      head,
      message: expect.stringContaining('commit_id is not part of the pull request') as string,
    });
  });

  it.each([
    ['closed', false, 'pull_request_closed'],
    ['merged', true, 'pull_request_merged'],
  ] as const)('a 422 explained by the pull request: %s', async (_name, merged, reason) => {
    const review = await reviewing();
    await h.ok(review.daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    h.github.override = (request) => {
      if (!isPost(request)) return undefined;
      Object.assign(pull(), { state: 'closed', merged });
      return unprocessable('Unprocessable Entity', ['Pull request is closed']);
    };
    await ended(review.daemon, review.runId);
    expect(await outcome(review.runId)).toMatchObject({ state: 'not_posted', reason });
  });

  it("GitHub's 422 for posting too fast reads as its request limit", async () => {
    const review = await reviewing();
    await h.ok(review.daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    h.github.override = (request) =>
      isPost(request)
        ? unprocessable('Validation Failed', ['was submitted too quickly'])
        : undefined;
    await ended(review.daemon, review.runId);
    expect(await outcome(review.runId)).toMatchObject({
      state: 'not_posted',
      reason: 'rate_limited',
    });
  });
});

describe('an answer lost after the request left: the reviews read, never a second post', () => {
  const cut: FakeReply = { status: 200, cut: true };

  it('GitHub holds it: posted', async () => {
    const review = await reviewing();
    await h.ok(review.daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    h.github.alter = (request, reply) => (isPost(request) ? cut : reply);
    await ended(review.daemon, review.runId);
    expect(await outcome(review.runId)).toMatchObject({ state: 'posted' });
    expect(ours()).toHaveLength(1);
    expect(posts()).toBe(1);
    expect(await notPostedEvents()).toEqual([]);
  });

  it('a server error after GitHub did it: posted', async () => {
    const review = await reviewing();
    await h.ok(review.daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    h.github.alter = (request, reply) => (isPost(request) ? { status: 502 } : reply);
    await ended(review.daemon, review.runId);
    expect(await outcome(review.runId)).toMatchObject({ state: 'posted' });
    expect(ours()).toHaveLength(1);
  });

  it('more than 100 reviews: every page read until ours (answer 1)', async () => {
    const review = await reviewing();
    await h.ok(review.daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    const others: FakeReview[] = Array.from({ length: 230 }, (_, index) => ({
      id: 900_000 + index,
      user: 'someone',
      body: `Review ${String(index)}`,
      state: 'COMMENTED',
      commitId: review.commit,
      submittedAt: '2026-10-10T10:00:00Z',
    }));
    pull().reviews.push(...others);
    h.github.alter = (request, reply) => (isPost(request) ? cut : reply);
    await ended(review.daemon, review.runId);
    expect(await outcome(review.runId)).toMatchObject({ state: 'posted' });
    expect(ours()).toHaveLength(1);
    expect(lists()).toBe(3);
  });

  it('not there when checked: never "Not posted", the time of the check', async () => {
    const review = await reviewing();
    await h.ok(review.daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    h.github.override = (request) => (isPost(request) ? cut : undefined);
    await ended(review.daemon, review.runId);
    const post = await outcome(review.runId);
    expect(post).toMatchObject({ state: 'not_found', pullRequest: 1 });
    expect(await notPostedEvents()).toEqual([
      expect.objectContaining({ outcome: 'not_found', reason: null, message: null }),
    ]);
    expect(posts()).toBe(1);
  });

  it('the check fails too: not checked, with why', async () => {
    const review = await reviewing();
    await h.ok(review.daemon, review.runToken, 'review_approve', { summary: SUMMARY });
    h.github.override = (request) =>
      isPost(request) ? cut : isList(request) ? { status: 502 } : undefined;
    await ended(review.daemon, review.runId);
    expect(await outcome(review.runId)).toMatchObject({
      state: 'not_checked',
      afterRestart: false,
      reason: 'unreachable',
    });
    expect(await notPostedEvents()).toEqual([
      expect.objectContaining({ outcome: 'not_checked', reason: 'unreachable' }),
    ]);
  });
});

describe('a server restart during the post', () => {
  /** The run as the server left it when it stopped: the post wanted, started or not. */
  async function stoppedAt(runId: string, started: boolean) {
    const row = await runRow(runId);
    await h.t.db
      .update(schema.runs)
      .set({
        reviewPost: null,
        reviewPostWantedAt: row.reviewAppliedAt,
        reviewPostStartedAt: started ? row.reviewAppliedAt : null,
      })
      .where(eq(schema.runs.id, runId));
    await h.t.db.delete(schema.events).where(eq(schema.events.type, 'ticket.review_posted'));
  }

  it('GitHub accepted it before the server recorded it: found, never posted twice', async () => {
    const { runId } = await approved();
    expect(ours()).toHaveLength(1);
    await stoppedAt(runId, true);
    await h.t.restart();
    expect(await outcome(runId)).toMatchObject({ state: 'posted' });
    expect(ours()).toHaveLength(1);
    expect(posts()).toBe(1);
    expect(lists()).toBe(1);
    expect(await h.events('ticket.review_posted')).toHaveLength(1);
  });

  it('started, but GitHub never got it: posted at the start, once', async () => {
    const { runId } = await approved();
    pull().reviews.length = 0;
    await stoppedAt(runId, true);
    await h.t.restart();
    expect(await outcome(runId)).toMatchObject({ state: 'posted' });
    expect(ours()).toHaveLength(1);
    expect(posts()).toBe(2);
    expect(lists()).toBe(1);
  });

  it("applied but never started (owner's change to answer 1): posted at the start", async () => {
    const { runId } = await approved();
    pull().reviews.length = 0;
    await stoppedAt(runId, false);
    await h.t.restart();
    expect(await outcome(runId)).toMatchObject({ state: 'posted' });
    expect(ours()).toHaveLength(1);
    // Never started: nothing to look for first.
    expect(lists()).toBe(0);
  });

  it('started, and the check fails at the start: said so, never posted blindly', async () => {
    const { runId } = await approved();
    await stoppedAt(runId, true);
    h.github.override = (request) => (isList(request) ? { status: 502 } : undefined);
    await h.t.restart();
    expect(await outcome(runId)).toMatchObject({
      state: 'not_checked',
      afterRestart: true,
      reason: 'unreachable',
    });
    expect(posts()).toBe(1);
  });
});
