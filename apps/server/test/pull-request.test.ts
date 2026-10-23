import { schema } from '@orchestrator/db';
import {
  NeedsYouResponse,
  PullRequestFailure,
  PullRequestTryAgainResponse,
  type DodReport,
} from '@orchestrator/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeRepository } from './fake-github.js';
import type { FakeReply, RecordedRequest } from './fake-github/common.js';
import { RunHarness, TOKEN, eventually, state } from './run-harness.js';
import type { ScriptedDaemon } from './daemon-client.js';

// The ticket's pull request (04, section 3.1; lot 3 step F3), opened by the server after an
// accepted submission, against the fake GitHub: found by its branch, opened, reopened or updated,
// each failure kept with "Needs you" and **Try again**, tried again at each start.

const h = new RunHarness();
const ZWSP = '​';

afterEach(async () => {
  h.github.override = undefined;
  h.github.alter = undefined;
  await h.stop();
});

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

/** A ready project whose repository holds the ticket's branch, and `WEB-1` running. */
async function working(ticket: object = {}) {
  await h.start();
  const repo = h.github.repository('octo-owner', 'bakery');
  await h.createTicket(ticket);
  const machine = await h.machine();
  const run = await h.running(machine.daemon);
  // The harness puts each push the scripted daemon reports on this branch of the fake (`tool`).
  const branch = (await ticketRow()).branchName ?? '';
  return { ...machine, ...run, repo, branch };
}

async function ticketRow() {
  const [row] = await h.t.db.select().from(schema.tickets);
  if (!row) throw new Error('no ticket');
  return row;
}

/** Waits until the background attempt has recorded something (an opened pull request or a failure). */
async function settled() {
  await eventually('the pull request attempt', async () => {
    const row = await ticketRow();
    expect(row.pullRequestWantedSince === null || row.pullRequestFailure !== null).toBe(true);
  });
}

function pulls(repo: FakeRepository) {
  const found = [];
  for (let number = 1; ; number++) {
    try {
      found.push(h.github.pullRequest(repo, number));
    } catch {
      return found;
    }
  }
}

async function needsYou() {
  const response = await h.call('GET', '/api/needs-you');
  return NeedsYouResponse.parse(response.json()).items.filter(
    (item) => item.type === 'pull_request_not_opened',
  );
}

async function tryAgain() {
  const response = await h.call('POST', '/api/projects/WEB/tickets/1/pull-request/try-again');
  expect(response.statusCode, response.body).toBe(200);
  return PullRequestTryAgainResponse.parse(response.json());
}

/** CI passes and the run ends, the ticket goes back with Request changes, the next run starts. */
async function nextRun(daemon: ScriptedDaemon, runId: string) {
  await h.ciPasses(daemon, runId);
  const changes = await h.call('POST', '/api/projects/WEB/tickets/1/request-changes', {
    comment: 'One more thing',
  });
  expect(changes.statusCode, changes.body).toBe(200);
  return h.running(daemon);
}

/** A reply whose body is missing `html_url` everywhere: a shape the layer cannot read. */
function withoutHtmlUrl(reply: FakeReply): FakeReply {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (typeof value !== 'object' || value === null) return value;
    const rest = { ...(value as Record<string, unknown>) };
    delete rest.html_url;
    return rest;
  };
  return { ...reply, body: strip(reply.body) };
}

const isList = (request: RecordedRequest) =>
  request.method === 'GET' && /\/pulls\?/.test(request.path);
const isCreate = (request: RecordedRequest) =>
  request.method === 'POST' && /\/pulls$/.test(request.path);
const isEdit = (request: RecordedRequest, field: 'state' | 'title') =>
  request.method === 'PATCH' &&
  typeof request.body === 'object' &&
  request.body !== null &&
  field in request.body;

describe('the pull request (04, section 3.1)', () => {
  it('is opened after the answer to the agent, then updated at the next submission', async () => {
    const { daemon, runId, runToken, repo, branch } = await working({
      title: 'Contact form for @bob, fixes #3',
    });
    const accepted = await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    expect(accepted).toMatchObject({ result: 'pending_ci' });
    await settled();

    const [pull] = pulls(repo);
    expect((await ticketRow()).pullRequestFailure).toBeNull();
    expect(pulls(repo)).toHaveLength(1);
    expect(pull).toMatchObject({ state: 'open', draft: false, head: branch, base: 'main' });
    expect(pull?.title).toBe(`WEB-1: Contact form for @${ZWSP}bob, fixes #${ZWSP}3`);
    expect(pull?.body).toContain('Adds the contact form.');
    expect(pull?.body).toContain('- [x] ');
    expect(pull?.body).toContain(
      'Ticket WEB-1 in the Orchestrator: http://localhost:8080/projects/WEB/tickets/1',
    );
    expect(pull?.body).toContain('(opens only on the computer running the Orchestrator)');
    const row = await ticketRow();
    expect(row).toMatchObject({
      pullRequestNumber: 1,
      pullRequestState: 'open',
      pullRequestHead: pull?.headSha,
      pullRequestWantedSince: null,
      pullRequestFailure: null,
    });
    expect(row.pullRequestUrl).toMatch(/\/octo-owner\/bakery\/pull\/1$/);
    expect((await h.events('ticket.pull_request_opened'))[0]).toMatchObject({
      actor: 'system',
      payload: { ticket: 'WEB-1', number: 1 },
    });

    const next = await nextRun(daemon, runId);
    await h.ok(daemon, next.runToken, 'ticket_submit', { ...REPORT, summary: 'Second round.' });
    await eventually('the update', () => {
      expect(h.github.pullRequest(repo, 1).body).toContain('Second round.');
    });
    await settled();
    expect(pulls(repo)).toHaveLength(1);
    expect(await h.events('ticket.pull_request_updated')).toHaveLength(1);
  });

  it('reopens one closed without merging, then updates it', async () => {
    const { daemon, runId, runToken, repo } = await working();
    await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    await settled();
    h.github.closePullRequest(repo, 1);
    const next = await nextRun(daemon, runId);
    await h.ok(daemon, next.runToken, 'ticket_submit', { ...REPORT, summary: 'After the close.' });
    await eventually('the reopen', () => {
      expect(h.github.pullRequest(repo, 1)).toMatchObject({ state: 'open' });
      expect(h.github.pullRequest(repo, 1).body).toContain('After the close.');
    });
    await settled();
    expect(pulls(repo)).toHaveLength(1);
    expect((await h.events('ticket.pull_request_reopened'))[0]).toMatchObject({
      payload: { number: 1 },
    });
  });

  it('opens a new one when the newest was merged and the ticket went on (owner answer 1)', async () => {
    const { daemon, runId, runToken, repo } = await working();
    await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    await settled();
    // Its base changed by hand on GitHub, then merged there: the merge is recorded, the ticket
    // goes on (lot 3 step J1), so its next accepted submission needs a new pull request.
    h.github.commit(repo, 'release', { 'RELEASE.md': 'Next\n' }, 'Release branch', 'main');
    const moved = await fetch(`${h.github.url}/repos/octo-owner/bakery/pulls/1`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ base: 'release' }),
    });
    expect(moved.status).toBe(200);
    h.github.mergePullRequest(repo, 1);
    const next = await nextRun(daemon, runId);
    expect(await ticketRow()).toMatchObject({ pullRequestMergedInto: 'release' });
    await h.ok(daemon, next.runToken, 'ticket_submit', REPORT);
    await eventually('the second pull request', () => {
      expect(pulls(repo)).toHaveLength(2);
    });
    await settled();
    expect(h.github.pullRequest(repo, 1)).toMatchObject({ merged: true });
    expect(h.github.pullRequest(repo, 2)).toMatchObject({ state: 'open', base: 'main' });
    expect(await ticketRow()).toMatchObject({
      pullRequestNumber: 2,
      pullRequestState: 'open',
      pullRequestMergedAt: null,
    });
    expect(await h.events('ticket.pull_request_opened')).toHaveLength(2);
    // The new pull request's own merge into main is recorded: the ticket is done.
    h.github.mergePullRequest(repo, 2);
    await h.t.ciTick();
    expect(await ticketRow()).toMatchObject({ status: 'done', pullRequestMergedInto: 'main' });
  });

  it('opens a new one when GitHub refuses to reopen the closed one (owner answer 2)', async () => {
    const { daemon, runId, runToken, repo } = await working();
    await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    await settled();
    h.github.closePullRequest(repo, 1);
    h.github.override = (request) =>
      isEdit(request, 'state')
        ? {
            status: 422,
            body: {
              message: 'Validation Failed',
              errors: [
                { resource: 'PullRequest', code: 'custom', message: 'state cannot be changed.' },
              ],
              documentation_url: 'https://docs.github.com/rest/pulls/pulls#update-a-pull-request',
              status: '422',
            },
          }
        : undefined;
    const next = await nextRun(daemon, runId);
    await h.ok(daemon, next.runToken, 'ticket_submit', REPORT);
    await eventually('the new pull request', () => {
      expect(pulls(repo)).toHaveLength(2);
    });
    await settled();
    expect(h.github.pullRequest(repo, 1)).toMatchObject({ state: 'closed' });
    expect((await h.events('ticket.pull_request_opened'))[1]).toMatchObject({
      payload: { number: 2, notReopened: 1 },
    });
  });
});

describe('a pull request not opened (04, section 3.1)', () => {
  it('an update that failed names the open pull request it could not update (step F4)', async () => {
    const { daemon, runId, runToken } = await working();
    await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    await settled();
    const next = await nextRun(daemon, runId);
    h.github.override = (request) => (isList(request) ? { status: 502 } : undefined);
    await h.ok(daemon, next.runToken, 'ticket_submit', { ...REPORT, summary: 'Second round.' });
    await settled();
    expect(await needsYou()).toMatchObject([
      { failure: { reason: 'unreachable' }, openPullRequest: 1 },
    ]);
    expect((await h.events('ticket.pull_request_not_opened'))[0]).toMatchObject({
      payload: { reason: 'unreachable', openPullRequest: 1 },
    });
    // Closed on GitHub meanwhile: nothing open to update, so the pull request is "not opened".
    await h.t.db.update(schema.tickets).set({ pullRequestState: 'closed' });
    expect(await needsYou()).toMatchObject([{ openPullRequest: null }]);
  });

  it('GitHub unreachable: kept with "Needs you", then Try again opens it', async () => {
    const { daemon, runToken, repo } = await working();
    h.github.override = (request) => (isList(request) ? { status: 502 } : undefined);
    // The agent's answer never depends on GitHub.
    expect(await h.ok(daemon, runToken, 'ticket_submit', REPORT)).toMatchObject({
      result: 'pending_ci',
    });
    await settled();
    expect(pulls(repo)).toHaveLength(0);
    const [item] = await needsYou();
    expect(item).toMatchObject({
      ticket: { projectKey: 'WEB', number: 1 },
      failure: { reason: 'unreachable', permission: null },
      openPullRequest: null,
    });
    expect((await h.events('ticket.pull_request_not_opened'))[0]).toMatchObject({
      payload: { reason: 'unreachable', openPullRequest: null },
    });
    // Still failing: Try again says so.
    expect((await tryAgain()).failure).toMatchObject({ reason: 'unreachable' });

    h.github.override = undefined;
    const done = await tryAgain();
    expect(done.failure).toBeNull();
    expect(done.url).toMatch(/\/pull\/1$/);
    expect(pulls(repo)).toHaveLength(1);
    expect(await needsYou()).toEqual([]);
    // Nothing more to try.
    const again = await h.call('POST', '/api/projects/WEB/tickets/1/pull-request/try-again');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'no_pull_request_wanted' } });
  });

  it('repeated failures are quiet: one event when it starts failing or its reason changes, "Since" kept', async () => {
    const { daemon, runId, runToken } = await working();
    h.github.override = (request) => (isList(request) ? { status: 502 } : undefined);
    await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    await settled();
    const [first] = await needsYou();
    const since = first?.since;
    expect(since).toBeTruthy();
    // Tried again by the owner and by the CI checks, failing the same way: no new event.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await tryAgain()).failure).toMatchObject({ reason: 'unreachable' });
    await h.report(daemon, state(runId, { state: 'waiting_ci' }));
    await h.t.ciTick();
    await h.t.ciTick();
    const reasons = async () =>
      (await h.events('ticket.pull_request_not_opened')).map(
        (event) => (event.payload as { reason: string }).reason,
      );
    expect(await reasons()).toEqual(['unreachable']);
    const [same] = await needsYou();
    expect(same?.since).toBe(since);
    // Its reason changes: one more event, the item keeps its first date.
    h.github.override = (request) =>
      isList(request)
        ? {
            status: 403,
            body: { message: 'API rate limit exceeded' },
            headers: { 'x-ratelimit-remaining': '0' },
          }
        : undefined;
    expect((await tryAgain()).failure).toMatchObject({ reason: 'rate_limited' });
    expect(await reasons()).toEqual(['unreachable', 'rate_limited']);
    expect((await needsYou())[0]?.since).toBe(since);
    // Opened at last: its own event.
    h.github.override = undefined;
    expect((await tryAgain()).failure).toBeNull();
    expect(await h.events('ticket.pull_request_opened')).toHaveLength(1);
    expect(await reasons()).toEqual(['unreachable', 'rate_limited']);
  });

  it('a permission missing: named in the token page words, then Try again', async () => {
    const { daemon, runToken, repo } = await working();
    const account = h.github.accounts.get(TOKEN);
    if (!account) throw new Error('no account');
    delete account.permissions.pull_requests;
    await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    await settled();
    const [item] = await needsYou();
    expect(item?.failure).toMatchObject({
      reason: 'permission_missing',
      permission: 'pull_requests',
    });
    account.permissions.pull_requests = 'write';
    expect((await tryAgain()).failure).toBeNull();
    expect(pulls(repo)).toHaveLength(1);
    expect(await needsYou()).toEqual([]);
  });

  it('an answer that cannot be read (the creation): its fields named, then Try again', async () => {
    const { daemon, runToken, repo } = await working();
    h.github.alter = (request, reply) => (isCreate(request) ? withoutHtmlUrl(reply) : reply);
    await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    await settled();
    const [item] = await needsYou();
    expect(item?.failure).toMatchObject({
      reason: 'unreadable',
      fields: ['html_url: expected string, received nothing'],
    });
    h.github.alter = undefined;
    expect((await tryAgain()).failure).toBeNull();
    // The pull request GitHub created but the server could not read is found again: still one.
    expect(pulls(repo)).toHaveLength(1);
    expect(await h.events('ticket.pull_request_updated')).toHaveLength(1);
  });

  it("a refusal: GitHub's words with its details, then Try again", async () => {
    const { daemon, runToken, repo, branch } = await working();
    // The branch is gone from GitHub: the creation is refused.
    h.github.override = (request) =>
      isCreate(request)
        ? {
            status: 422,
            body: {
              message: 'Validation Failed',
              errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
              documentation_url: 'https://docs.github.com/rest/pulls/pulls#create-a-pull-request',
              status: '422',
            },
          }
        : undefined;
    await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    await settled();
    const [item] = await needsYou();
    expect(item?.failure).toMatchObject({
      reason: 'refused',
      message: 'Validation Failed: head invalid',
    });
    h.github.override = undefined;
    expect((await tryAgain()).failure).toBeNull();
    expect(pulls(repo)).toMatchObject([{ head: branch }]);
  });

  for (const [what, field] of [
    ['the search by branch', 'list'],
    ['the update', 'title'],
    ['the reopen', 'state'],
  ] as const) {
    it(`an answer that cannot be read (${what}): its fields named, then Try again`, async () => {
      const { daemon, runId, runToken, repo } = await working();
      await h.ok(daemon, runToken, 'ticket_submit', REPORT);
      await settled();
      if (field === 'state') h.github.closePullRequest(repo, 1);
      h.github.alter = (request, reply) =>
        (field === 'list' ? isList(request) : isEdit(request, field))
          ? withoutHtmlUrl(reply)
          : reply;
      const next = await nextRun(daemon, runId);
      await h.ok(daemon, next.runToken, 'ticket_submit', { ...REPORT, summary: 'Round two.' });
      await settled();
      const [item] = await needsYou();
      expect(item?.failure).toMatchObject({
        reason: 'unreadable',
        fields: [
          field === 'list'
            ? '0.html_url: expected string, received nothing'
            : 'html_url: expected string, received nothing',
        ],
      });
      h.github.alter = undefined;
      expect((await tryAgain()).failure).toBeNull();
      expect(pulls(repo)).toHaveLength(1);
      expect(h.github.pullRequest(repo, 1)).toMatchObject({ state: 'open' });
      expect(h.github.pullRequest(repo, 1).body).toContain('Round two.');
    });
  }

  it('a repository GitHub does not find: named, with what to check', async () => {
    const { daemon, runToken } = await working();
    h.github.override = (request) =>
      isList(request)
        ? {
            status: 404,
            body: {
              message: 'Not Found',
              documentation_url: 'https://docs.github.com/rest/pulls/pulls#list-pull-requests',
              status: '404',
            },
          }
        : undefined;
    await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    await settled();
    const [item] = await needsYou();
    expect(item?.failure).toMatchObject({
      reason: 'refused',
      message:
        'GitHub answered "Not Found" for the repository octo-owner/bakery: it was deleted or renamed, or the saved token cannot see it',
    });
  });

  it('a stop between GitHub creating it and the record opens no second one', async () => {
    const { daemon, runToken, repo } = await working();
    // GitHub created it, but its answer never arrived.
    h.github.alter = (request, reply) => (isCreate(request) ? { status: 502 } : reply);
    await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    await settled();
    expect(pulls(repo)).toHaveLength(1);
    expect(PullRequestFailure.parse((await ticketRow()).pullRequestFailure).reason).toBe(
      'unreachable',
    );
    h.github.alter = undefined;
    // Tried again at the next start, by itself.
    await h.t.restart();
    await eventually('the attempt at start', async () => {
      expect(await ticketRow()).toMatchObject({
        pullRequestNumber: 1,
        pullRequestWantedSince: null,
        pullRequestFailure: null,
      });
    });
    expect(pulls(repo)).toHaveLength(1);
    expect(await h.events('ticket.pull_request_updated')).toHaveLength(1);
    expect(await needsYou()).toEqual([]);
  });

  it('a ticket cancelled no longer wants it: no item, no attempt at start', async () => {
    const { daemon, runToken, repo } = await working();
    h.github.override = (request) => (isList(request) ? { status: 502 } : undefined);
    await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    await settled();
    expect(await needsYou()).toHaveLength(1);
    const cancelled = await h.call('POST', '/api/projects/WEB/tickets/1/cancel');
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(await needsYou()).toEqual([]);
    expect(await ticketRow()).toMatchObject({
      pullRequestWantedSince: null,
      pullRequestFailure: null,
    });
    h.github.override = undefined;
    await h.t.restart();
    const requests = h.github.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.github.requests.slice(requests).filter(isList)).toEqual([]);
    expect(pulls(repo)).toHaveLength(0);
  });
});

describe('the pull request text', () => {
  it('stays harmless and within the limits, in the title and the description', async () => {
    const secret = `ghp_${'c'.repeat(36)}`;
    const { daemon, runToken, repo } = await working({
      title: `${'T'.repeat(150)} <b>@carol</b> closes #7 ${'&'.repeat(20)}`,
      acceptanceCriteria: ['Fixes GH-2 for @dave', 'Second'],
    });
    await h.ok(daemon, runToken, 'ticket_submit', {
      ...REPORT,
      summary: `Closes https://github.com/o/r/issues/9 ${secret} <img src=x> ${'s'.repeat(9_000)}`,
      tests: { paths: ['src/contact.test.ts'], justification: null },
    });
    await settled();
    const pull = h.github.pullRequest(repo, 1);
    expect(pull.title.length).toBeLessThanOrEqual(256);
    expect(pull.title).not.toMatch(/<|@[a-z]|#\d/);
    expect(pull.body).not.toContain(secret);
    expect(pull.body).toContain('[hidden]');
    expect(pull.body).not.toMatch(/<|@[a-z]|#\d|GH-\d|\/issues\/\d/i);
    expect(pull.body).toContain(`GH-${ZWSP}2 for @${ZWSP}dave`);
    expect(pull.body?.length ?? 0).toBeLessThanOrEqual(65_536);
    expect((await ticketRow()).pullRequestNumber).toBe(1);
  });
});
