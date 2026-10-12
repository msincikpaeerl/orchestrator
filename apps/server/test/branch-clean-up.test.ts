import { schema } from '@orchestrator/db';
import {
  CLAUDE_CODE_VALIDATED_VERSION,
  EnrollmentResponse,
  type DodReport,
  type RunState,
  type RunStop,
  type TicketBranchCleanUp,
} from '@orchestrator/protocol';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitHubClient } from '../src/github/client.js';
import { deleteMergedTicketBranch } from '../src/tickets/branch-delete.js';
import { enrollToken, ScriptedDaemon, type Closed } from './daemon-client.js';
import type { RecordedRequest } from './fake-github/common.js';
import { RunHarness, TOKEN, eventually, state } from './run-harness.js';

// The clean-up after a merge on GitHub (04, section 4; owner's answer 5 of lot 3 step J and the
// answers of step J2, step J2a), against the fake GitHub: the CI loop's tick that records a
// merge into the default branch tries the clean-up after the CI waits; every condition is read
// again at each try, and any doubt keeps the branch.

const h = new RunHarness();

afterEach(async () => {
  h.github.alter = undefined;
  h.github.override = undefined;
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
const branches = () => h.github.branches(repo());

/** Ticket 1 implemented, submitted, CI passed: in review with pull request #1 open. */
async function inReview() {
  await h.start();
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

async function ticketRow(number = 1) {
  const [row] = await h.t.db.select().from(schema.tickets).where(eq(schema.tickets.number, number));
  if (!row) throw new Error('no ticket');
  return row;
}

async function cleanUp(): Promise<TicketBranchCleanUp | null> {
  return (await h.ticket()).branchCleanUp;
}

/** The fake's requests since `from`, as `METHOD path`, for the branch and the delete. */
function branchRequests(from: number) {
  return h.github.requests
    .slice(from)
    .filter((request) => request.path.includes('/git/ref'))
    .map((request) => `${request.method} ${request.path.replace('/repos/octo-owner/bakery', '')}`);
}

const deletes = (from = 0) => branchRequests(from).filter((line) => line.startsWith('DELETE'));

/** The owner's request on GitHub's API, as on GitHub's site. */
async function onGitHub(method: string, path: string, body?: object) {
  const response = await fetch(`${h.github.url}/repos/octo-owner/bakery${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return response.status === 204 ? null : ((await response.json()) as { number: number });
}

/** A pull request opened on GitHub by hand. */
async function openOnGitHub(head: string, base: string) {
  const opened = await onGitHub('POST', '/pulls', { head, base, title: 'By hand', body: '' });
  return opened?.number ?? 0;
}

/** Changes the fake's answer to the requests `match` selects, until the test ends or clears it. */
function alter(match: (request: RecordedRequest) => boolean, change: (body: unknown) => void) {
  h.github.alter = (request, reply) => {
    if (!match(request) || reply.status >= 300) return reply;
    const body = structuredClone(reply.body);
    change(body);
    return { ...reply, body };
  };
}

/** Every request `match` selects answered `status` with GitHub's error shape. */
function refuse(match: (request: RecordedRequest) => boolean, status: number, message: string) {
  h.github.alter = (request, reply) =>
    match(request)
      ? { status, body: { message, documentation_url: 'https://docs.github.com' } }
      : reply;
}

const pullRead = (request: RecordedRequest) =>
  request.method === 'GET' && request.path === '/repos/octo-owner/bakery/pulls/1';
const refRead = (request: RecordedRequest) =>
  request.method === 'GET' && request.path.includes('/git/ref/heads/');

async function events() {
  return (await h.events('ticket.branch_')).map((event) => ({
    type: event.type,
    payload: event.payload,
  }));
}

describe('the branch deleted on GitHub after a merge into the default branch', () => {
  it.each(['merge', 'squash', 'rebase'] as const)(
    'deletes it at the check that found the merge (%s), once, with its event',
    async (method) => {
      const { head } = await inReview();
      h.github.mergePullRequest(repo(), 1, method);
      const from = h.github.requests.length;
      await h.t.ciTick();
      expect((await h.ticket()).status).toBe('done');
      expect(branches().has(BRANCH)).toBe(false);
      expect(deletes(from)).toEqual([`DELETE /git/refs/heads/${BRANCH}`]);
      const done = await cleanUp();
      expect(done).toMatchObject({
        branch: BRANCH,
        pullRequest: 1,
        mergedHead: head,
        state: 'deleted',
        reason: null,
        waitingFor: [],
        failure: null,
        pushedAgain: null,
      });
      expect(done?.decidedAt).not.toBeNull();
      expect(await events()).toEqual([
        {
          type: 'ticket.branch_deleted',
          payload: {
            project: 'WEB',
            ticket: 'WEB-1',
            branch: BRANCH,
            pullRequest: 1,
            head,
            alreadyGone: false,
          },
        },
      ]);
      // Decided: the next checks read nothing more for it.
      const after = h.github.requests.length;
      await h.t.ciTick();
      expect(branchRequests(after)).toEqual([]);
      expect(await events()).toHaveLength(1);
    },
  );

  it('accepts a branch GitHub already deleted, and never touches a longer name', async () => {
    const { head } = await inReview();
    // A branch whose name starts with the ticket's, at the same commit.
    h.github.commit(repo(), `${BRANCH}-2`, {}, 'Same commit', BRANCH);
    const longer = branches().get(`${BRANCH}-2`);
    h.github.mergePullRequest(repo(), 1);
    await onGitHub('DELETE', `/git/refs/heads/${BRANCH}`);
    const from = h.github.requests.length;
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({ state: 'already_gone', reason: null });
    expect(deletes(from)).toEqual([]);
    expect(branches().get(`${BRANCH}-2`)).toBe(longer);
    const found = await events();
    expect(found).toHaveLength(1);
    expect(found).toMatchObject([
      { type: 'ticket.branch_deleted', payload: { alreadyGone: true, head } },
    ]);
  });

  it('keeps a branch whose head on GitHub is not the merged head: commits pushed after the merge', async () => {
    const { head } = await inReview();
    h.github.mergePullRequest(repo(), 1, 'squash');
    const later = h.github.commit(repo(), BRANCH, { 'later.ts': 'x\n' }, 'After the merge');
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({
      state: 'kept',
      mergedHead: head,
      reason: { kind: 'moved', head: later },
    });
    expect(branches().get(BRANCH)).toBe(later);
    expect(deletes()).toEqual([]);
    expect(await events()).toEqual([
      {
        type: 'ticket.branch_kept',
        payload: {
          project: 'WEB',
          ticket: 'WEB-1',
          branch: BRANCH,
          pullRequest: 1,
          head,
          reason: { kind: 'moved', head: later },
        },
      },
    ]);
  });
});

describe('a branch kept on GitHub', () => {
  it('keeps a branch another open pull request uses as its head', async () => {
    await inReview();
    h.github.commit(repo(), 'release', { 'RELEASE.md': 'Next\n' }, 'Release branch', 'main');
    const other = await openOnGitHub(BRANCH, 'release');
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    expect((await h.ticket()).status).toBe('done');
    expect(await cleanUp()).toMatchObject({
      state: 'kept',
      reason: { kind: 'used_as_head', pullRequest: other },
    });
    expect(branches().has(BRANCH)).toBe(true);
    expect(deletes()).toEqual([]);
  });

  it('keeps a branch another open pull request is based on', async () => {
    await inReview();
    h.github.commit(repo(), 'feature', { 'more.ts': 'x\n' }, 'More work', BRANCH);
    const other = await openOnGitHub('feature', BRANCH);
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({
      state: 'kept',
      reason: { kind: 'used_as_base', pullRequest: other },
    });
    expect(branches().has(BRANCH)).toBe(true);
  });

  it("checks each listed pull request's head and base itself: an unfiltered list keeps nothing back", async () => {
    await inReview();
    h.github.commit(repo(), 'release', { 'RELEASE.md': 'Next\n' }, 'Release branch', 'main');
    h.github.commit(repo(), 'feature', { 'more.ts': 'x\n' }, 'More work', 'main');
    const unrelated = await openOnGitHub('feature', 'release');
    h.github.mergePullRequest(repo(), 1);
    const listed = await fetch(`${h.github.url}/repos/octo-owner/bakery/pulls?state=open`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const every = (await listed.json()) as { number: number }[];
    expect(every.map((pull) => pull.number)).toContain(unrelated);
    // GitHub ignores a malformed filter and returns every open pull request.
    h.github.alter = (request, reply) =>
      request.method === 'GET' && /\/pulls\?state=open&(head|base)=/.test(request.path)
        ? { ...reply, body: every }
        : reply;
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({ state: 'deleted' });
  });

  it('runs no clean-up for a pull request merged into another base', async () => {
    await inReview();
    h.github.commit(repo(), 'release', { 'RELEASE.md': 'Next\n' }, 'Release branch', 'main');
    await onGitHub('PATCH', '/pulls/1', { base: 'release' });
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    expect((await h.ticket()).status).toBe('in_review');
    expect(await cleanUp()).toBeNull();
    await h.t.ciTick();
    expect(branches().has(BRANCH)).toBe(true);
    expect(deletes()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it('keeps a branch whose pull request comes from a fork', async () => {
    await inReview();
    alter(pullRead, (body) => {
      (body as { head: { repo: { full_name: string } } }).head.repo.full_name = 'someone/bakery';
    });
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    expect((await h.ticket()).status).toBe('done');
    expect(await cleanUp()).toMatchObject({
      state: 'kept',
      reason: { kind: 'fork', headRepository: 'someone/bakery' },
    });
    expect(branchRequests(0)).toEqual([]);
  });

  it("keeps the branch when GitHub's default branch is no longer the project's", async () => {
    await inReview();
    alter(pullRead, (body) => {
      (body as { base: { repo: { default_branch: string } } }).base.repo.default_branch = 'trunk';
    });
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({
      state: 'kept',
      reason: { kind: 'default_branch_changed', github: 'trunk', stored: 'main' },
    });
    expect(deletes()).toEqual([]);
  });

  it('keeps the branch when GitHub answers for another reference than exactly the branch', async () => {
    await inReview();
    alter(refRead, (body) => {
      (body as { ref: string }).ref = `refs/heads/${BRANCH}-2`;
    });
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({
      state: 'kept',
      reason: { kind: 'ref_differs', ref: `refs/heads/${BRANCH}-2` },
    });
    expect(deletes()).toEqual([]);
  });

  it('never tries a deletion GitHub refused again (a protected branch)', async () => {
    await inReview();
    h.github.override = (request) =>
      request.method === 'DELETE'
        ? { status: 422, body: { message: 'Cannot delete this protected branch' } }
        : undefined;
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({
      state: 'kept',
      reason: { kind: 'refused', message: 'Cannot delete this protected branch' },
    });
    h.github.override = undefined;
    const from = h.github.requests.length;
    await h.t.ciTick();
    expect(branchRequests(from)).toEqual([]);
    expect(branches().has(BRANCH)).toBe(true);
    expect((await events()).map((event) => event.type)).toEqual(['ticket.branch_kept']);
  });

  it.each(['head', 'base'] as const)(
    'keeps the branch when the list of pull requests by %s cannot be read',
    async (side) => {
      await inReview();
      const list = (request: RecordedRequest) =>
        request.method === 'GET' && request.path.includes(`/pulls?state=open&${side}=`);
      refuse(list, 422, 'Validation Failed');
      h.github.mergePullRequest(repo(), 1);
      await h.t.ciTick();
      expect(await cleanUp()).toMatchObject({
        state: 'kept',
        reason: { kind: 'read_failed', what: 'open_pull_requests', message: 'Validation Failed' },
      });
      expect(branchRequests(0)).toEqual([]);
      expect(branches().has(BRANCH)).toBe(true);
    },
  );

  it("tries again at the next check after GitHub's server error, the branch kept meanwhile", async () => {
    await inReview();
    refuse(
      (request) => request.method === 'GET' && request.path.includes('/pulls?state=open&base='),
      502,
      'Server Error',
    );
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({
      state: 'wanted',
      failure: { reason: 'unreachable' },
    });
    expect((await cleanUp())?.failure?.message).toContain('GitHub answered HTTP 502');
    expect(branches().has(BRANCH)).toBe(true);
    expect(await events()).toEqual([]);
    h.github.alter = undefined;
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({ state: 'deleted', failure: null });
  });

  it('a ticket no longer done keeps its branch', async () => {
    await inReview();
    refuse(refRead, 502, 'Server Error');
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({ state: 'wanted' });
    h.github.alter = undefined;
    // No owner action leaves `done` in this version (Reopen is only from `cancelled`): the
    // guard of the owner's answer 3 is checked with the status set directly.
    await h.t.db.update(schema.tickets).set({ status: 'todo' }).where(eq(schema.tickets.number, 1));
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({ state: 'kept', reason: { kind: 'ticket_reopened' } });
    expect(branches().has(BRANCH)).toBe(true);
    expect(deletes()).toEqual([]);
  });

  it('keeps the branch when the ticket has another pull request now', async () => {
    await inReview();
    refuse(refRead, 502, 'Server Error');
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    h.github.alter = undefined;
    // As the opener records a new pull request (after Reopen and a new submission, then Mark as
    // done manually): the stored merge facts go, the clean-up row stays (owner's answer 4).
    await h.t.db
      .update(schema.tickets)
      .set({
        pullRequestNumber: 2,
        pullRequestMergedAt: null,
        pullRequestMergedHead: null,
        pullRequestMergedInto: null,
      })
      .where(eq(schema.tickets.number, 1));
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({
      pullRequest: 1,
      state: 'kept',
      reason: { kind: 'another_pull_request', number: 2 },
    });
    expect(deletes()).toEqual([]);
  });
});

describe('the clean-up stored', () => {
  it('survives a restart between the merge and the clean-up', async () => {
    await inReview();
    refuse(refRead, 502, 'Server Error');
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({ state: 'wanted' });
    h.github.alter = undefined;
    await h.t.restart();
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({ state: 'deleted' });
    expect(deletes()).toHaveLength(1);
    expect((await events()).map((event) => event.type)).toEqual(['ticket.branch_deleted']);
  });

  it('one recorded merge never makes a second GitHub row, nor a second row for one machine', async () => {
    const { id: machineId } = await inReview();
    const ticket = await ticketRow();
    const row = {
      ticketId: ticket.id,
      pullRequestNumber: 1,
      branch: BRANCH,
      mergedHead: 'a'.repeat(40),
      mergedInto: 'main',
      defaultBranch: 'main',
    };
    await h.t.db.insert(schema.branchCleanUps).values({ ...row, target: 'github' });
    await expect(
      h.t.db.insert(schema.branchCleanUps).values({ ...row, target: 'github' }),
    ).rejects.toMatchObject({ cause: { code: '23505', constraint: 'branch_clean_ups_github' } });
    await h.t.db.insert(schema.branchCleanUps).values({ ...row, target: 'machine', machineId });
    await expect(
      h.t.db.insert(schema.branchCleanUps).values({ ...row, target: 'machine', machineId }),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'branch_clean_ups_machine_once' },
    });
    // Another pull request of the ticket is another recorded merge.
    await h.t.db
      .insert(schema.branchCleanUps)
      .values({ ...row, pullRequestNumber: 2, target: 'github' });
    // A machine row names its machine, a GitHub row none.
    await expect(
      h.t.db
        .insert(schema.branchCleanUps)
        .values({ ...row, pullRequestNumber: 3, target: 'machine' }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});

describe('after a cancellation', () => {
  it('deletes nothing; Reopen then Mark as done manually starts the clean-up', async () => {
    await inReview();
    const cancelled = await h.call('POST', '/api/projects/WEB/tickets/1/cancel');
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    await h.t.ciTick();
    expect((await h.ticket()).status).toBe('cancelled');
    expect(await cleanUp()).toBeNull();
    expect(branches().has(BRANCH)).toBe(true);
    expect(deletes()).toEqual([]);

    expect((await h.call('POST', '/api/projects/WEB/tickets/1/reopen')).statusCode).toBe(200);
    await h.t.ciTick();
    expect(await cleanUp()).toBeNull();
    const done = await h.call('POST', '/api/projects/WEB/tickets/1/mark-done', {
      comment: 'Merged on GitHub.',
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(await cleanUp()).toMatchObject({ state: 'wanted', pullRequest: 1 });
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({ state: 'deleted' });
    expect(branches().has(BRANCH)).toBe(false);
  });
});

describe('the end of a stopped run waited for (owner’s answer 1)', () => {
  /** Your request for changes on Quality's... skipped review: a fix run working. */
  async function fixing() {
    const machine = await inReview();
    const skipped = await h.call('POST', '/api/projects/WEB/tickets/1/skip-review');
    expect(skipped.statusCode, skipped.body).toBe(200);
    const asked = await h.call('POST', '/api/projects/WEB/tickets/1/request-changes', {
      comment: 'Add the opening hours.',
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const fix = await h.running(machine.daemon);
    return { ...machine, fix };
  }

  function stopOf(daemon: ScriptedDaemon, runId: string) {
    return daemon.find<RunStop>(
      (message) => message.type === 'run.stop' && message.payload.runId === runId,
      'run.stop',
    );
  }

  /** The daemon's end report after the stop; with `push`, the end push it made. */
  function ended(runId: string, push?: string): RunState {
    const message = state(runId, { state: 'ended', reason: 'stopped' });
    if (message.payload.state !== 'ended' || push === undefined) return message;
    return {
      ...message,
      payload: {
        ...message.payload,
        branch: { name: BRANCH, head: push, commitsAhead: [], notOnGitHub: null },
        push: { status: 'pushed', head: push },
      },
    };
  }

  /** The machine back with its `hello` listing `runs`. */
  async function reconnect(token: string, runs: string[]) {
    const daemon = await ScriptedDaemon.connect(h.t.url, token);
    const welcome = await daemon.hello({
      runs: runs.map((runId) => ({ runId, state: 'working', claudeSessionId: null })),
    });
    expect(welcome.accepted).toBe(true);
    return daemon;
  }

  async function offline(id: string, daemon: ScriptedDaemon): Promise<Closed> {
    const closed = await daemon.close();
    await eventually('the machine offline', async () => {
      const [row] = await h.t.db.select().from(schema.machines).where(eq(schema.machines.id, id));
      expect(row?.status).toBe('offline');
    });
    return closed;
  }

  it('waits for the end report of the run the merge stopped, without a request, then deletes', async () => {
    const { daemon, fix, id } = await fixing();
    h.github.mergePullRequest(repo(), 1);
    const from = h.github.requests.length;
    await h.t.ciTick();
    expect((await h.ticket()).status).toBe('done');
    await stopOf(daemon, fix.runId);
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({
      state: 'wanted',
      waitingFor: [{ runId: fix.runId, machine: { id, name: 'Laptop' }, offlineSince: null }],
      failure: null,
    });
    expect(branchRequests(from)).toEqual([]);
    expect(
      h.github.requests.slice(from).filter((request) => request.path.endsWith('/pulls/1')),
    ).toHaveLength(1); // the watcher's read that found the merge, none by the clean-up
    await h.report(daemon, ended(fix.runId));
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({ state: 'deleted', waitingFor: [] });
  });

  it('waits for an offline machine, which reports the end at its reconnection', async () => {
    const { daemon, fix, id, token } = await fixing();
    await offline(id, daemon);
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    await h.t.ciTick();
    const waiting = await cleanUp();
    expect(waiting).toMatchObject({ state: 'wanted', waitingFor: [{ runId: fix.runId }] });
    expect(waiting?.waitingFor[0]?.offlineSince).not.toBeNull();
    expect(branches().has(BRANCH)).toBe(true);
    // Back with the run: the stop again, then its end.
    const back = await reconnect(token, [fix.runId]);
    await stopOf(back, fix.runId);
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({ state: 'wanted' });
    await h.report(back, ended(fix.runId));
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({ state: 'deleted' });
    await back.close();
  });

  it('stops waiting for a run its machine no longer has at reconnection; a push recorded after the deletion keeps the branch for good', async () => {
    const { daemon, fix, id, token } = await fixing();
    await offline(id, daemon);
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({ state: 'wanted' });
    const back = await reconnect(token, []);
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({ state: 'deleted' });
    const [run] = await h.t.db.select().from(schema.runs).where(eq(schema.runs.id, fix.runId));
    expect(run?.endMissingAt).not.toBeNull();

    // Its end report, still on its way, says an end push recreated the branch (owner's answer 2).
    const pushed = h.github.commit(repo(), BRANCH, { 'late.ts': 'x\n' }, 'Late', 'main');
    await h.report(back, ended(fix.runId, pushed));
    const after = await cleanUp();
    expect(after).toMatchObject({
      state: 'deleted',
      pushedAgain: { machine: 'Laptop', head: pushed },
    });
    expect((await events()).at(-1)).toEqual({
      type: 'ticket.branch_pushed_again',
      payload: {
        project: 'WEB',
        ticket: 'WEB-1',
        branch: BRANCH,
        pullRequest: 1,
        machine: 'Laptop',
        head: pushed,
      },
    });
    // Never deleted a second time.
    const from = h.github.requests.length;
    await h.t.ciTick();
    expect(branchRequests(from)).toEqual([]);
    expect(branches().get(BRANCH)).toBe(pushed);
    await back.close();
  });

  it('stops waiting for a revoked machine, whose run never gets a push credential again once enrolled again', async () => {
    const { daemon, fix, id } = await fixing();
    await offline(id, daemon);
    h.github.mergePullRequest(repo(), 1);
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({ state: 'wanted' });
    const revoked = await h.call('POST', `/api/machines/${id}/revoke`);
    expect(revoked.statusCode, revoked.body).toBe(200);
    await h.t.ciTick();
    expect(await cleanUp()).toMatchObject({ state: 'deleted', waitingFor: [] });

    // Enrolled again, the daemon still holding the old run: the stop again, but no push.
    const code = await h.call('POST', `/api/machines/${id}/enrollment-code`);
    expect(code.statusCode, code.body).toBe(200);
    const token = await enrollToken(h.t.url, EnrollmentResponse.parse(code.json()).enrollment.code);
    const back = await ScriptedDaemon.connect(h.t.url, token);
    await back.hello({
      runs: [{ runId: fix.runId, state: 'working', claudeSessionId: null }],
      claudeCodeVersion: CLAUDE_CODE_VALIDATED_VERSION,
    });
    await stopOf(back, fix.runId);
    const answer = await back.request({
      type: 'git.credential_request',
      id: randomUUID(),
      payload: {
        runId: fix.runId,
        repository: { owner: 'octo-owner', name: 'bakery' },
        command: 'push',
      },
    });
    expect(answer).toMatchObject({
      type: 'git.credential',
      payload: { ok: false, message: 'the run started before this machine was enrolled again' },
    });
    await back.close();
  });
});

describe('the one function that deletes a branch on GitHub', () => {
  it('refuses by itself the default branch, the base, a name not the ticket’s and a merge not recorded', async () => {
    await inReview();
    const ticket = await ticketRow();
    const client = createGitHubClient({ apiUrl: h.github.url, token: TOKEN, timeoutSeconds: 10 });
    const remove = (branch: string, base = 'main') =>
      deleteMergedTicketBranch(h.t.db, client, { ticketId: ticket.id, branch, base });
    // Not merged yet: refused whatever the name.
    expect(await remove(BRANCH)).toEqual({ ok: false, own: 'merge_not_recorded' });
    await h.t.db
      .update(schema.tickets)
      .set({
        pullRequestMergedAt: new Date(),
        pullRequestMergedHead: ticket.pullRequestHead,
        pullRequestMergedInto: 'main',
      })
      .where(eq(schema.tickets.id, ticket.id));
    expect(await remove('main')).toEqual({ ok: false, own: 'default_branch' });
    expect(await remove('Main')).toEqual({ ok: false, own: 'default_branch' });
    expect(await remove(BRANCH, BRANCH)).toEqual({ ok: false, own: 'base' });
    expect(await remove('feature/contact')).toEqual({ ok: false, own: 'not_a_ticket_branch' });
    expect(await remove('t/12-contact-form')).toEqual({ ok: false, own: 'not_a_ticket_branch' });
    expect(await remove('t/1-Contact')).toEqual({ ok: false, own: 'not_a_ticket_branch' });
    // Merged into another base: refused.
    await h.t.db
      .update(schema.tickets)
      .set({ pullRequestMergedInto: 'release' })
      .where(eq(schema.tickets.id, ticket.id));
    expect(await remove(BRANCH, 'release')).toEqual({ ok: false, own: 'merge_not_recorded' });
    expect(deletes()).toEqual([]);
    expect(branches().has(BRANCH)).toBe(true);
  });
});
