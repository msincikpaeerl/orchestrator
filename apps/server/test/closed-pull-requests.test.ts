import { schema } from '@orchestrator/db';
import {
  ApiError,
  NeedsYouResponse,
  PullRequestReopenResponse,
  type DodReport,
  type NeedsYouItem,
  type TicketDetail,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import { RunHarness, TOKEN, eventually, state } from './run-harness.js';

// Pull requests closed without merging, Cancel closing one, and the watch that cannot read GitHub
// (04, section 2; owner's answers 1, 2 and 4 of step J, lot 3 step J3a), against the fake GitHub:
// each check of GitHub is one tick the test starts.

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

const MINUTE = 60_000;
let clock = new Date('2026-10-14T10:00:00.000Z');
const advance = (minutes: number) => {
  clock = new Date(clock.getTime() + minutes * MINUTE);
};

const repo = () => h.github.repository('octo-owner', 'bakery');

/** Ticket `number`: implemented, submitted, CI passed, in review with its pull request open. */
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

async function inReview(options: { ci?: 'success' | 'queued' | 'none' } = {}) {
  clock = new Date('2026-10-14T10:00:00.000Z');
  await h.start({ now: () => clock, ...options });
  await h.createTicket();
  const machine = await h.machine();
  const first = await submitted(machine.daemon);
  return { ...machine, first };
}

async function items(): Promise<NeedsYouItem[]> {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items;
}

async function closedItems() {
  return (await items()).filter(
    (item): item is Extract<NeedsYouItem, { type: 'pull_request_closed' }> =>
      item.type === 'pull_request_closed',
  );
}

async function ticketRow(number = 1) {
  const [row] = await h.t.db.select().from(schema.tickets).where(eq(schema.tickets.number, number));
  if (!row) throw new Error('no ticket');
  return row;
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

/** The ticket branch deleted on GitHub, as its **Delete branch** button does. */
async function deleteBranchOnGitHub(branch: string) {
  const response = await fetch(`${h.github.url}/repos/octo-owner/bakery/git/refs/heads/${branch}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(response.status, await response.clone().text()).toBe(204);
}

async function reopen(number = 1) {
  const response = await h.call(
    'POST',
    `/api/projects/WEB/tickets/${String(number)}/pull-request/reopen`,
  );
  expect(response.statusCode, response.body).toBe(200);
  return PullRequestReopenResponse.parse(response.json()).failure;
}

async function cancel(number = 1) {
  const response = await h.call('POST', `/api/projects/WEB/tickets/${String(number)}/cancel`);
  expect(response.statusCode, response.body).toBe(200);
}

const pullRequestOf = async (number = 1): Promise<TicketDetail['pullRequest']> =>
  (await h.ticket(number)).pullRequest;

describe('a pull request closed without merging', () => {
  it('is an item with its facts, until it is reopened by the owner', async () => {
    await inReview();
    h.github.closePullRequest(repo(), 1);
    const closedAt = new Date(h.github.pullRequest(repo(), 1).closedAt ?? '').toISOString();
    advance(1);
    await h.t.ciTick();

    expect(await pullRequestOf()).toMatchObject({
      opened: { number: 1, state: 'closed' },
      closed: { at: closedAt, by: 'github' },
      close: null,
      reopenFailure: null,
    });
    // GitHub's time of the close, never the time the server found it.
    expect(await closedItems()).toEqual([
      {
        type: 'pull_request_closed',
        ticket: { projectKey: 'WEB', number: 1, title: expect.any(String) as string },
        status: 'in_review',
        pullRequest: { number: 1, url: expect.any(String) as string },
        mergedInto: null,
        reopenFailure: null,
        since: closedAt,
      },
    ]);
    expect((await h.ticket()).status).toBe('in_review');

    expect(await reopen()).toBeNull();
    expect(h.github.pullRequest(repo(), 1).state).toBe('open');
    expect(await pullRequestOf()).toMatchObject({ opened: { state: 'open' }, closed: null });
    expect(await closedItems()).toEqual([]);
    expect((await h.events('ticket.pull_request_reopened')).map((e) => e.actor)).toEqual(['owner']);
    expect((await h.events('ticket.pull_request_reopened')).at(-1)?.payload).toMatchObject({
      number: 1,
      owner: true,
    });
    // Open again: **Check CI again**'s "No CI found" counts from the reopening.
    expect((await ticketRow()).pullRequestOpenedAt).toEqual(clock);
  });

  it('goes from Needs you once reopened on GitHub', async () => {
    await inReview();
    h.github.closePullRequest(repo(), 1);
    await h.t.ciTick();
    expect(await closedItems()).toHaveLength(1);
    await onGitHub(1, { state: 'open' });
    await h.t.ciTick();
    expect(await closedItems()).toEqual([]);
    expect((await pullRequestOf()).closed).toBeNull();
  });

  it('keeps a refused reopen with its branch gone, then GitHub’s words for another refusal', async () => {
    await inReview();
    const branch = (await ticketRow()).branchName ?? '';
    h.github.closePullRequest(repo(), 1);
    await h.t.ciTick();
    await deleteBranchOnGitHub(branch);

    const gone = await reopen();
    expect(gone).toMatchObject({ reason: 'refused', branchGone: true });
    expect(gone?.message).toContain('State cannot be changed');
    expect(h.github.pullRequest(repo(), 1).state).toBe('closed');
    expect((await closedItems())[0]?.reopenFailure).toEqual(gone);
    expect((await pullRequestOf()).reopenFailure).toEqual(gone);
    expect((await h.events('ticket.pull_request_not_reopened')).at(-1)).toMatchObject({
      actor: 'owner',
      payload: { number: 1, reason: 'refused', branchGone: true },
    });

    // Another refusal: GitHub's words, the branch not said gone.
    h.github.commit(repo(), branch, { 'NOTE.md': 'Back\n' }, 'Branch back', 'main');
    h.github.override = (request) =>
      request.method === 'PATCH'
        ? { status: 403, body: { message: 'Resource not accessible by personal access token' } }
        : undefined;
    const refused = await reopen();
    expect(refused).toMatchObject({ reason: 'permission_missing', branchGone: false });
    expect((await closedItems())[0]?.reopenFailure).toEqual(refused);
  });

  it('refuses Start review while it is closed', async () => {
    await inReview();
    h.github.closePullRequest(repo(), 1);
    await h.t.ciTick();
    const refused = await h.call('POST', '/api/projects/WEB/tickets/1/review');
    expect(refused.statusCode).toBe(409);
    expect(ApiError.parse(refused.json()).error.runRefusal).toEqual({
      reason: 'pull_request_not_open',
      pullRequest: 1,
      merged: false,
    });
  });

  it('is refused by Reopen pull request when it is open, or the ticket cancelled', async () => {
    await inReview();
    const open = await h.call('POST', '/api/projects/WEB/tickets/1/pull-request/reopen');
    expect(open.statusCode).toBe(409);
    expect(ApiError.parse(open.json()).error.code).toBe('pull_request_not_closed');
    h.github.closePullRequest(repo(), 1);
    await h.t.ciTick();
    await cancel();
    const cancelled = await h.call('POST', '/api/projects/WEB/tickets/1/pull-request/reopen');
    expect(cancelled.statusCode).toBe(409);
    expect(ApiError.parse(cancelled.json()).error.code).toBe('pull_request_not_closed');
    // Closed on GitHub before the cancel: nothing to close, and no item on a cancelled ticket.
    expect((await pullRequestOf()).close).toBeNull();
    expect(await closedItems()).toEqual([]);
  });

  it('merged into another base: an item naming the base, at GitHub’s time of the merge', async () => {
    const { daemon } = await inReview();
    h.github.commit(repo(), 'release', { 'RELEASE.md': 'Next\n' }, 'Release branch', 'main');
    await onGitHub(1, { base: 'release' });
    h.github.mergePullRequest(repo(), 1);
    const mergedAt = new Date(h.github.pullRequest(repo(), 1).mergedAt ?? '').toISOString();
    await h.t.ciTick();
    expect(await closedItems()).toEqual([
      expect.objectContaining({
        status: 'in_review',
        pullRequest: { number: 1, url: expect.any(String) as string },
        mergedInto: 'release',
        since: mergedAt,
      }),
    ]);
    // Merged into the default branch, a ticket's pull request is no item: the ticket is done.
    await h.createTicket({ title: 'Map page' });
    await submitted(daemon, 2);
    h.github.mergePullRequest(repo(), 2);
    await h.t.ciTick();
    expect((await h.ticket(2)).status).toBe('done');
    expect((await closedItems()).map((item) => item.ticket.number)).toEqual([1]);
  });
});

describe('Cancel', () => {
  it('closes the pull request after the cancel, with no item', async () => {
    await inReview();
    await cancel();
    await eventually('the pull request closed', async () => {
      expect(h.github.pullRequest(repo(), 1).state).toBe('closed');
      expect((await pullRequestOf()).closed).toMatchObject({ by: 'orchestrator' });
    });
    expect(await pullRequestOf()).toMatchObject({ opened: { state: 'closed' }, close: null });
    expect((await h.events('ticket.pull_request_closed')).at(-1)?.payload).toMatchObject({
      number: 1,
      by: 'orchestrator',
    });
    expect(await closedItems()).toEqual([]);
    // Closed and cancelled: no longer read.
    const from = h.github.requests.length;
    await h.t.ciTick();
    expect(pullRequests(from)).toEqual([]);
  });

  it('tries a failed close again at the next check, with one event per reason', async () => {
    await inReview();
    h.github.override = (request) => (request.method === 'PATCH' ? { status: 502 } : undefined);
    await cancel();
    await eventually('the close failed', async () => {
      expect((await pullRequestOf()).close?.failure).toMatchObject({ reason: 'unreachable' });
    });
    const since = (await pullRequestOf()).close?.since;
    expect(since).toBe(clock.toISOString());
    advance(1);
    await h.t.ciTick();
    expect((await pullRequestOf()).close?.failure?.since).toBe(since);
    expect(await h.events('ticket.pull_request_not_closed')).toHaveLength(1);
    // Another reason: one more event.
    h.github.override = (request) =>
      request.method === 'PATCH'
        ? { status: 422, body: { message: 'Validation Failed' } }
        : undefined;
    advance(1);
    await h.t.ciTick();
    expect((await pullRequestOf()).close?.failure).toMatchObject({ reason: 'refused' });
    expect(
      (await h.events('ticket.pull_request_not_closed')).map(
        (event) => (event.payload as { reason: string }).reason,
      ),
    ).toEqual(['unreachable', 'refused']);

    h.github.override = undefined;
    advance(1);
    await h.t.ciTick();
    expect(h.github.pullRequest(repo(), 1).state).toBe('closed');
    expect(await pullRequestOf()).toMatchObject({
      opened: { state: 'closed' },
      closed: { by: 'orchestrator' },
      close: null,
    });
  });

  it('stops trying when the pull request is found merged: the cancel race', async () => {
    await inReview();
    h.github.override = (request) => (request.method === 'PATCH' ? { status: 502 } : undefined);
    await cancel();
    await eventually('the close failed', async () => {
      expect((await pullRequestOf()).close?.failure).not.toBeUndefined();
      expect((await pullRequestOf()).close?.failure).not.toBeNull();
    });
    h.github.mergePullRequest(repo(), 1);
    let from = h.github.requests.length;
    await h.t.ciTick();
    // Read first: found merged, never closed.
    expect(pullRequests(from).filter((line) => line.startsWith('PATCH'))).toEqual([]);
    expect(await h.ticket()).toMatchObject({
      status: 'cancelled',
      pullRequest: { opened: { state: 'merged' }, close: null },
    });
    expect((await h.events('ticket.pull_request_merged')).at(-1)?.payload).toMatchObject({
      outcome: 'cancelled',
    });
    from = h.github.requests.length;
    await h.t.ciTick();
    expect(pullRequests(from)).toEqual([]);
  });

  it('a ticket reopened keeps its pull request closed until its next accepted submission', async () => {
    const { daemon } = await inReview();
    await cancel();
    await eventually('the pull request closed', async () => {
      expect((await pullRequestOf()).closed?.by).toBe('orchestrator');
    });
    const reopened = await h.call('POST', '/api/projects/WEB/tickets/1/reopen');
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect((await h.ticket()).status).toBe('todo');
    // Still watched (a reopen on GitHub would be seen), never reopened by the check, no item.
    const from = h.github.requests.length;
    await h.t.ciTick();
    expect(pullRequests(from)).toEqual(['GET /pulls/1']);
    expect(h.github.pullRequest(repo(), 1).state).toBe('closed');
    expect(await closedItems()).toEqual([]);

    await submitted(daemon);
    expect(h.github.pullRequest(repo(), 1).state).toBe('open');
    expect(await pullRequestOf()).toMatchObject({
      opened: { number: 1, state: 'open' },
      closed: null,
      close: null,
    });
  });

  it('a ticket reopened before the close was done: no close tried any more', async () => {
    await inReview();
    h.github.override = (request) => (request.method === 'PATCH' ? { status: 502 } : undefined);
    await cancel();
    await eventually('the close failed', async () => {
      expect((await pullRequestOf()).close?.failure).toMatchObject({ reason: 'unreachable' });
    });
    const reopened = await h.call('POST', '/api/projects/WEB/tickets/1/reopen');
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect((await pullRequestOf()).close).toBeNull();
    h.github.override = undefined;
    const from = h.github.requests.length;
    await h.t.ciTick();
    expect(pullRequests(from).filter((line) => line.startsWith('PATCH'))).toEqual([]);
    expect(h.github.pullRequest(repo(), 1).state).toBe('open');
  });
});

describe('"No CI found" while the pull request is closed', () => {
  it('never accepts the work: the wait goes on until CI wait at submission', async () => {
    clock = new Date('2026-10-14T10:00:00.000Z');
    await h.start({ now: () => clock, ci: 'none' });
    await h.createTicket();
    const { daemon } = await h.machine();
    const { runId, runToken } = await h.running(daemon);
    expect((await h.ok(daemon, runToken, 'ticket_submit', REPORT)).result).toBe('pending_ci');
    await h.report(daemon, state(runId, { state: 'waiting_ci' }));
    await eventually('the pull request opened', async () => {
      expect((await pullRequestOf()).opened?.state).toBe('open');
    });
    h.github.closePullRequest(repo(), 1);
    // Wait for CI to start (5 minutes) over, no CI run or status: "No CI found" if it were open.
    advance(6);
    await h.t.ciTick();
    let run = await h.run(runId);
    expect(run.status).toBe('running');
    expect(run.ci?.result).toMatchObject({ state: 'pending', checks: [] });
    expect(run.ci?.pullRequest).toMatchObject({ number: 1, state: 'closed' });
    expect((await h.ticket()).status).toBe('in_progress');

    // CI wait at submission (20 minutes) reached: the run ends `ci_timeout`, saying why.
    advance(15);
    await h.t.ciTick();
    run = await h.run(runId);
    expect(run).toMatchObject({ status: 'failed', failureReason: 'ci_timeout' });
    expect(run.endDetail).toContain(
      'no CI run or status appeared, and pull request #1 is closed on GitHub',
    );
  });

  it('accepts it once the pull request is open again', async () => {
    clock = new Date('2026-10-14T10:00:00.000Z');
    await h.start({ now: () => clock, ci: 'none' });
    await h.createTicket();
    const { daemon } = await h.machine();
    const { runId, runToken } = await h.running(daemon);
    await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    await h.report(daemon, state(runId, { state: 'waiting_ci' }));
    await eventually('the pull request opened', async () => {
      expect((await pullRequestOf()).opened?.state).toBe('open');
    });
    h.github.closePullRequest(repo(), 1);
    advance(6);
    await h.t.ciTick();
    expect((await h.run(runId)).status).toBe('running');
    await onGitHub(1, { state: 'open' });
    advance(1);
    await h.t.ciTick();
    const run = await h.run(runId);
    expect(run.status).toBe('succeeded');
    expect(run.ci?.result?.state).toBe('no_ci');
  });
});

describe('a watch that cannot read GitHub', () => {
  /** The project's pull requests as their watch failed to read them, or null. */
  const watchOf = async () => {
    const [project] = await h.t.db.select().from(schema.projects);
    return project?.pullRequestWatchFailure ?? null;
  };

  it('keeps the failure on the project, one event when it starts, changes and works again', async () => {
    await inReview();
    h.github.alter = (request, reply) =>
      request.path.includes('/pulls?state=open')
        ? { status: 404, body: { message: 'Not Found' } }
        : reply;
    advance(1);
    await h.t.ciTick();
    const first = clock.toISOString();
    expect(await watchOf()).toEqual({
      reason: 'refused',
      message: 'Not Found',
      fields: [],
      pullRequests: [1],
      since: first,
      at: first,
      retryAt: null,
    });
    expect((await pullRequestOf()).watchFailure).toMatchObject({ reason: 'refused', since: first });
    // Again: the latest time only, no second event.
    advance(1);
    await h.t.ciTick();
    expect(await watchOf()).toMatchObject({ since: first, at: clock.toISOString() });
    expect(await h.events('project.pull_request_watch')).toHaveLength(1);

    // An answer the Orchestrator cannot read: another reason, a second event.
    h.github.alter = (request, reply) =>
      request.path.includes('/pulls?state=open') ? { ...reply, body: [{ number: 'one' }] } : reply;
    advance(1);
    await h.t.ciTick();
    expect(await watchOf()).toMatchObject({ reason: 'unreadable', since: clock.toISOString() });

    h.github.alter = undefined;
    advance(1);
    await h.t.ciTick();
    expect(await watchOf()).toBeNull();
    expect((await pullRequestOf()).watchFailure).toBeNull();
    expect((await h.events('project.pull_request_watch')).map((event) => event.type)).toEqual([
      'project.pull_request_watch_failed',
      'project.pull_request_watch_failed',
      'project.pull_request_watch_recovered',
    ]);
    expect((await h.events('project.pull_request_watch_failed'))[0]?.payload).toEqual({
      key: 'WEB',
      reason: 'refused',
      message: 'Not Found',
      pullRequests: [1],
    });
  });

  it('names only the pull request whose own read failed, and GitHub unreachable', async () => {
    const { daemon } = await inReview();
    await h.createTicket({ title: 'Map page' });
    await submitted(daemon, 2);
    h.github.closePullRequest(repo(), 1);
    await h.t.ciTick();
    // #1, closed, is read by itself: its read fails, #2 in the open list is read.
    h.github.alter = (request, reply) =>
      request.path.endsWith('/pulls/1') ? { status: 404, body: { message: 'Not Found' } } : reply;
    advance(1);
    await h.t.ciTick();
    expect(await watchOf()).toMatchObject({ reason: 'refused', pullRequests: [1] });
    expect((await pullRequestOf(1)).watchFailure).not.toBeNull();
    expect((await pullRequestOf(2)).watchFailure).toBeNull();

    h.github.alter = undefined;
    await h.github.setReachable(false);
    try {
      advance(1);
      await h.t.ciTick();
    } finally {
      await h.github.setReachable(true);
    }
    expect(await watchOf()).toMatchObject({ reason: 'unreachable', pullRequests: [1, 2] });
    expect((await pullRequestOf(2)).watchFailure).toMatchObject({ reason: 'unreachable' });
  });
});
