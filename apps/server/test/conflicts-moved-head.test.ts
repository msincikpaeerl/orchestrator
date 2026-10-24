import { schema } from '@orchestrator/db';
import {
  MOVED_HEAD_TITLE_MAX_CHARS,
  Run,
  type DodReport,
  type RunInput,
  type RunResume,
  type RunStart,
  type TicketDetail,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import type { FakeRepository } from './fake-github.js';
import { RunHarness, TOKEN, eventually, state } from './run-harness.js';

// Conflicts and the moved head (04, sections 2 and 3.1; owner's answers 1, 3, 4 and 6 of step J,
// lot 3 step J3b), against the fake GitHub with a clock the test controls: each check of GitHub
// is one tick the test starts. The fake answers `mergeable` null at the first read after a
// change of the head or the base, as GitHub does while it computes it, then the value.

const h = new RunHarness();

afterEach(async () => {
  h.github.override = undefined;
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
const SUMMARY = 'The form works and is tested.';

const MINUTE = 60_000;
let clock = new Date('2026-10-14T10:00:00.000Z');
const advance = (minutes: number) => {
  clock = new Date(clock.getTime() + minutes * MINUTE);
};

const repo = () => h.github.repository('octo-owner', 'bakery');

/** A commit on the default branch changing the file the agent's first push added. */
function conflictOnMain(on: FakeRepository) {
  h.github.commit(on, 'main', { 'src/work-1.ts': 'export const other = 1;\n' }, 'Other work');
}

/** Ticket `number` implemented, submitted, CI passed: in review with its pull request open. */
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

/** Quality's review approving the work: the ticket on **Awaiting merge**. */
async function approved(daemon: ScriptedDaemon, number = 1) {
  const review = await h.reviewing(daemon, number);
  await h.ok(daemon, review.runToken, 'review_approve', { summary: SUMMARY });
  await h.report(daemon, state(review.runId, { state: 'ended', reason: 'submitted' }));
  await eventually('the ticket awaiting merge', async () => {
    expect((await h.ticket(number)).status).toBe('awaiting_merge');
  });
}

async function awaitingMerge() {
  clock = new Date('2026-10-14T10:00:00.000Z');
  await h.start({ now: () => clock });
  await h.createTicket();
  const machine = await h.machine();
  const first = await submitted(machine.daemon);
  await approved(machine.daemon);
  return { ...machine, first };
}

async function ticketRow(number = 1) {
  const [row] = await h.t.db.select().from(schema.tickets).where(eq(schema.tickets.number, number));
  if (!row) throw new Error('no ticket');
  return row;
}

const pullRequestOf = async (number = 1): Promise<TicketDetail['pullRequest']> =>
  (await h.ticket(number)).pullRequest;

/** The requests the fake received since `from`, as `METHOD path`, the repository left out. */
function requests(from: number) {
  return h.github.requests
    .slice(from)
    .map((request) => `${request.method} ${request.path.replace('/repos/octo-owner/bakery', '')}`);
}

function startOf(daemon: ScriptedDaemon, runId: string): RunStart {
  const start = daemon.received.find(
    (message): message is RunStart =>
      message.type === 'run.start' && message.payload.runId === runId,
  );
  if (!start) throw new Error('no run.start');
  return start;
}

const requestChanges = (comment: string) =>
  h.call('POST', '/api/projects/WEB/tickets/1/request-changes', { comment });

const CONFLICT_PART =
  'The pull request conflicts with main: run `git merge origin/main` and resolve the conflicts before anything else.';

describe('a conflict on Awaiting merge', () => {
  it('is read once per interval, stored with its filled-in request, and leads to a fix_review run told to merge, the comment edited', async () => {
    const { daemon, first } = await awaitingMerge();
    // A second ticket in review in the same project: in the project's list, no read of its own.
    await h.createTicket({ title: 'Map page' });
    await submitted(daemon, 2);
    conflictOnMain(repo());

    // First read after the base moved: GitHub still computing (`mergeable` null), nothing known.
    let from = h.github.requests.length;
    advance(1);
    await h.t.ciTick();
    // P + M: one list for the project, one read for the pull request on Awaiting merge.
    expect(requests(from)).toEqual(['GET /pulls?state=open&per_page=100&page=1', 'GET /pulls/1']);
    expect((await pullRequestOf()).conflict).toBeNull();

    from = h.github.requests.length;
    advance(1);
    await h.t.ciTick();
    expect(requests(from)).toEqual(['GET /pulls?state=open&per_page=100&page=1', 'GET /pulls/1']);
    const since = clock.toISOString();
    expect((await pullRequestOf()).conflict).toEqual({
      head: first.commit,
      base: 'main',
      since,
      request:
        'Pull request #1 conflicts with main. Merge main into the branch with `git merge origin/main`, resolve the conflicts keeping the approved work, then hand it in again.',
    });
    // The ticket in review is not read for it.
    expect((await pullRequestOf(2)).conflict).toBeNull();
    advance(1);
    await h.t.ciTick();
    // Once per head: no second event, the same `since`.
    expect((await pullRequestOf()).conflict?.since).toBe(since);
    expect((await h.events('ticket.pull_request_conflict')).map((e) => e.payload)).toEqual([
      expect.objectContaining({ ticket: 'WEB-1', number: 1, head: first.commit, base: 'main' }),
    ]);

    // The owner edits the filled-in text: the mark comes from GitHub's fact, not from the words.
    const edited = 'Please also keep the footer as it is.';
    expect((await requestChanges(edited)).statusCode).toBe(200);
    const ticket = await h.ticket();
    expect(ticket.changeRequest?.request).toMatchObject({
      by: 'owner',
      conflict: { base: 'main' },
    });

    const response = await h.call('POST', '/api/projects/WEB/tickets/1/run');
    expect(response.statusCode, response.body).toBe(201);
    const runId = Run.parse(response.json()).id;
    const start = await daemon.find<RunStart>(
      (message) => message.type === 'run.start' && message.payload.runId === runId,
      'run.start of the fix',
    );
    expect(start.payload.purpose).toBe('fix_review');
    expect(start.payload.initialPrompt).toContain(CONFLICT_PART);
    expect(start.payload.initialPrompt).toContain(edited);
  });

  it('goes when GitHub says it is mergeable again; a request then is not a conflict', async () => {
    const { daemon, first } = await awaitingMerge();
    conflictOnMain(repo());
    await h.t.ciTick();
    await h.t.ciTick();
    expect((await pullRequestOf()).conflict).not.toBeNull();

    // The other work reverted on main: mergeable again.
    h.github.commit(repo(), 'main', { 'src/work-1.ts': null }, 'Revert the other work');
    await h.t.ciTick();
    // Still computing: the fact stays for this head.
    expect((await pullRequestOf()).conflict).not.toBeNull();
    await h.t.ciTick();
    expect((await pullRequestOf()).conflict).toBeNull();
    expect((await h.events('ticket.pull_request_conflict_gone')).map((e) => e.payload)).toEqual([
      expect.objectContaining({ head: first.commit, base: 'main', headMoved: false }),
    ]);

    // Even a comment that speaks of a conflict is not marked as one.
    expect((await requestChanges('Merge main, there is a conflict.')).statusCode).toBe(200);
    expect((await h.ticket()).changeRequest?.request).toMatchObject({ conflict: null });
    const response = await h.call('POST', '/api/projects/WEB/tickets/1/run');
    expect(response.statusCode, response.body).toBe(201);
    const runId = Run.parse(response.json()).id;
    await eventually('the fix run started', () => {
      expect(() => startOf(daemon, runId)).not.toThrow();
    });
    expect(startOf(daemon, runId).payload.initialPrompt).not.toContain(CONFLICT_PART);
  });

  it('decides nothing while GitHub cannot be read for it', async () => {
    await awaitingMerge();
    conflictOnMain(repo());
    h.github.override = (request) =>
      request.method === 'GET' && request.path.endsWith('/pulls/1')
        ? { status: 500, body: { message: 'Server Error' } }
        : undefined;
    await h.t.ciTick();
    await h.t.ciTick();
    expect((await pullRequestOf()).conflict).toBeNull();
    expect((await pullRequestOf()).watchFailure).toMatchObject({ pullRequests: [1] });
  });
});

/** The round messages the machine received for the run: `run.input` and `run.resume`. */
function rounds(daemon: ScriptedDaemon, runId: string) {
  return daemon.received.filter(
    (message): message is RunInput | RunResume =>
      (message.type === 'run.input' || message.type === 'run.resume') &&
      message.payload.runId === runId,
  );
}

/** A run on a project without workflows, its work submitted and waiting for CI. */
async function waitingForCi() {
  clock = new Date('2026-10-14T10:00:00.000Z');
  await h.start({ now: () => clock, ci: 'none' });
  await h.createTicket();
  const machine = await h.machine();
  const run = await h.running(machine.daemon);
  const answer = await h.ok(machine.daemon, run.runToken, 'ticket_submit', REPORT);
  expect(answer.result).toBe('pending_ci');
  await h.report(machine.daemon, state(run.runId, { state: 'waiting_ci' }));
  const commit = h.lastPushed ?? '';
  // The pull request is opened after the answer: the wait begins then.
  await eventually('the wait begun', async () => {
    const ci = (await h.run(run.runId)).ci;
    expect(ci?.commit).toBe(commit);
    expect(ci?.since).toBeTruthy();
  });
  return { ...machine, ...run, commit };
}

async function ciResult(runId: string) {
  const [row] = await h.t.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  return row?.ciResult as { state: string } | null;
}

describe('the conflict hidden by a green status from another service (answer 6)', () => {
  it('becomes a conflict round once GitHub says the pull request conflicts', async () => {
    const { daemon, runId, commit } = await waitingForCi();
    h.github.setStatus(repo(), commit, { context: 'deploy/preview', state: 'success' });
    conflictOnMain(repo());
    // `mergeable` null: nothing decided until the next check.
    await h.t.ciTick();
    expect(await ciResult(runId)).toMatchObject({ state: 'pending' });
    expect(rounds(daemon, runId)).toEqual([]);
    expect((await h.run(runId)).status).toBe('running');

    advance(1);
    await h.t.ciTick();
    await eventually('the conflict round', () => {
      expect(rounds(daemon, runId)).toHaveLength(1);
    });
    const [message] = rounds(daemon, runId);
    expect(message).toMatchObject({ type: 'run.input', payload: { fetchBase: true } });
    expect(await ciResult(runId)).toMatchObject({ state: 'conflict' });
    expect((await h.ticket()).status).toBe('in_progress');
  });

  it('passes on the status when GitHub says it is mergeable', async () => {
    const { daemon, runId, commit } = await waitingForCi();
    h.github.setStatus(repo(), commit, { context: 'deploy/preview', state: 'success' });
    await h.t.ciTick();
    await h.t.ciTick();
    await daemon.find(
      (message) => message.type === 'run.stop' && message.payload.runId === runId,
      'run.stop completed',
    );
    expect(await ciResult(runId)).toMatchObject({ state: 'passed' });
  });

  it('decides nothing while the pull request cannot be read', async () => {
    const { daemon, runId, commit } = await waitingForCi();
    h.github.setStatus(repo(), commit, { context: 'deploy/preview', state: 'success' });
    conflictOnMain(repo());
    h.github.override = (request) =>
      request.method === 'GET' && request.path.endsWith('/pulls/1')
        ? { status: 403, body: { message: 'Resource not accessible by personal access token' } }
        : undefined;
    await h.t.ciTick();
    await h.t.ciTick();
    expect(rounds(daemon, runId)).toEqual([]);
    expect((await h.run(runId)).ci?.checkFailure).toMatchObject({ reason: 'permission_missing' });
    h.github.override = undefined;
    await h.t.ciTick();
    await h.t.ciTick();
    await eventually('the conflict round', () => {
      expect(rounds(daemon, runId)).toHaveLength(1);
    });
  });

  it('never decides a workflow run that passed: it still wins', async () => {
    clock = new Date('2026-10-14T10:00:00.000Z');
    await h.start({ now: () => clock, ci: 'success' });
    await h.createTicket();
    const { daemon } = await h.machine();
    const run = await h.running(daemon);
    await h.ok(daemon, run.runToken, 'ticket_submit', REPORT);
    await h.report(daemon, state(run.runId, { state: 'waiting_ci' }));
    await eventually('the workflow run passed on GitHub', async () => {
      expect((await h.run(run.runId)).ci?.since).toBeTruthy();
      expect(h.github.runs(repo(), h.lastPushed ?? '').map((each) => each.conclusion)).toEqual([
        'success',
      ]);
    });
    // Then a conflict, and a status: the workflow run that passed decides, `mergeable` unread.
    h.github.setStatus(repo(), h.lastPushed ?? '', { context: 'deploy/preview', state: 'success' });
    conflictOnMain(repo());
    const from = h.github.requests.length;
    await h.t.ciTick();
    await daemon.find(
      (message) => message.type === 'run.stop' && message.payload.runId === run.runId,
      'run.stop completed',
    );
    expect(await ciResult(run.runId)).toMatchObject({ state: 'passed' });
    expect(rounds(daemon, run.runId)).toEqual([]);
    expect(requests(from).filter((each) => each.startsWith('GET /pulls/1'))).toHaveLength(1);
  });
});

describe('a conflict while the pull request is closed (lot 3 step J3b)', () => {
  it('sends no round with nothing on GitHub: the wait ends at CI wait at submission', async () => {
    const { daemon, runId } = await waitingForCi();
    conflictOnMain(repo());
    h.github.closePullRequest(repo(), 1);
    advance(6);
    await h.t.ciTick();
    await h.t.ciTick();
    expect(rounds(daemon, runId)).toEqual([]);
    expect(await ciResult(runId)).toMatchObject({ state: 'pending' });
    advance(15);
    await h.t.ciTick();
    await eventually('the run ended', async () => {
      expect(await h.run(runId)).toMatchObject({ failureReason: 'ci_timeout' });
    });
    expect((await h.run(runId)).endDetail).toContain(
      'no CI run or status appeared, and pull request #1 is closed on GitHub',
    );
    expect(rounds(daemon, runId)).toEqual([]);
  });

  it('sends no round on green statuses either, and says why at CI wait at submission', async () => {
    const { daemon, runId, commit } = await waitingForCi();
    h.github.setStatus(repo(), commit, { context: 'deploy/preview', state: 'success' });
    conflictOnMain(repo());
    // Read once while open (null), then closed: GitHub keeps the value it computed.
    await h.t.ciTick();
    h.github.closePullRequest(repo(), 1);
    await h.t.ciTick();
    await h.t.ciTick();
    expect(rounds(daemon, runId)).toEqual([]);
    advance(21);
    await h.t.ciTick();
    await eventually('the run ended', async () => {
      expect(await h.run(runId)).toMatchObject({ failureReason: 'ci_timeout' });
    });
    expect((await h.run(runId)).endDetail).toContain(
      'only statuses from other services passed, and pull request #1 conflicts with main while it is closed on GitHub',
    );
  });
});

/** **Update branch** on GitHub after `count` commits on main, each titled `titles[i]`. */
function updatedOnGitHub(titles: string[]): string {
  titles.forEach((title, index) => {
    h.github.commit(repo(), 'main', { [`main-${String(index)}.md`]: `${title}\n` }, title);
  });
  return h.github.updatePullRequestBranch(repo(), 1);
}

function compares(from: number) {
  return requests(from).filter((request) => request.includes('/compare/'));
}

describe('the head moved after the approval (answer 3)', () => {
  it('compares once: the newest titles as plain text, cut, then how many more', async () => {
    const { first } = await awaitingMerge();
    const long = `Change ${'x'.repeat(100)}`;
    const head = updatedOnGitHub([
      'One',
      'Two',
      'Three',
      'Four',
      `Five with token ghp_${'a'.repeat(36)}`,
      `Six\u0007 with a bell`,
      long,
    ]);
    const from = h.github.requests.length;
    await h.t.ciTick();
    expect(compares(from)).toEqual([`GET /compare/${first.commit}...${head}`]);
    const moved = (await pullRequestOf()).headMoved;
    expect(moved).toMatchObject({ after: 'approved', commit: first.commit, head });
    const comparison = moved?.comparison;
    if (comparison?.kind !== 'ahead') throw new Error(`not ahead: ${JSON.stringify(comparison)}`);
    expect(comparison.titles[0]).toBe("Merge branch 'main' into t/1-contact-form");
    expect(comparison.titles[1]).toHaveLength(MOVED_HEAD_TITLE_MAX_CHARS);
    expect(comparison.titles[1]?.endsWith('…')).toBe(true);
    expect(comparison.titles[2]).toBe('Six  with a bell');
    expect(comparison.titles[3]).not.toContain('ghp_aaaa');
    expect(comparison.titles).toHaveLength(5);
    // 7 commits on main and the merge commit: 8 after the approved one.
    expect(comparison.more).toBe(3);

    // Never again for the same two commits.
    const later = h.github.requests.length;
    await h.t.ciTick();
    await h.t.ciTick();
    expect(compares(later)).toEqual([]);
    expect((await ticketRow()).pullRequestComparison).toMatchObject({ head });
  });

  it('says the approved commit is no longer part of it for another status', async () => {
    const { first } = await awaitingMerge();
    const branch = (await ticketRow()).branchName ?? '';
    // The branch rewritten on GitHub (a force push): the approved commit left out.
    const rewritten = await forcePush(branch);
    await h.t.ciTick();
    expect((await pullRequestOf()).headMoved).toEqual({
      after: 'approved',
      commit: first.commit,
      head: rewritten,
      comparison: { kind: 'not_part', status: 'diverged' },
    });
  });

  it('keeps a failed comparison without the list, not tried again; a new head is compared', async () => {
    const { first } = await awaitingMerge();
    const head = updatedOnGitHub(['Other']);
    h.github.override = (request) =>
      request.path.includes('/compare/')
        ? { status: 500, body: { message: 'Server Error' } }
        : undefined;
    let from = h.github.requests.length;
    await h.t.ciTick();
    expect(compares(from)).toHaveLength(1);
    expect((await pullRequestOf()).headMoved).toEqual({
      after: 'approved',
      commit: first.commit,
      head,
      comparison: {
        kind: 'failed',
        reason: 'unreachable',
        message: 'GitHub could not be reached, or answered with a server error',
      },
    });
    from = h.github.requests.length;
    await h.t.ciTick();
    expect(compares(from)).toEqual([]);

    h.github.override = undefined;
    const newer = updatedOnGitHub(['Another']);
    from = h.github.requests.length;
    await h.t.ciTick();
    expect(compares(from)).toEqual([`GET /compare/${first.commit}...${newer}`]);
    expect((await pullRequestOf()).headMoved?.comparison).toMatchObject({ kind: 'ahead', more: 0 });
  });

  it('names the commit whose review was skipped', async () => {
    clock = new Date('2026-10-14T10:00:00.000Z');
    await h.start({ now: () => clock });
    await h.createTicket();
    const { daemon } = await h.machine();
    const first = await submitted(daemon);
    expect((await h.call('POST', '/api/projects/WEB/tickets/1/skip-review')).statusCode).toBe(200);
    const head = updatedOnGitHub(['Other']);
    await h.t.ciTick();
    expect((await pullRequestOf()).headMoved).toEqual({
      after: 'skipped',
      commit: first.commit,
      head,
      comparison: {
        kind: 'ahead',
        titles: ["Merge branch 'main' into t/1-contact-form", 'Other'],
        more: 0,
      },
    });
  });

  it('is not shown, nor compared, when the head is the approved commit', async () => {
    await awaitingMerge();
    const from = h.github.requests.length;
    await h.t.ciTick();
    expect(compares(from)).toEqual([]);
    expect((await pullRequestOf()).headMoved).toBeNull();
  });
});

/** A commit on main's head replacing the ticket branch on GitHub, as a force push does. */
async function forcePush(branch: string): Promise<string> {
  const main = h.github.branches(repo()).get('main') ?? '';
  const tree = await gitApi('GET', `/git/commits/${main}`);
  const commit = await gitApi('POST', '/git/commits', {
    message: 'Rewritten',
    tree: (tree.tree as { sha: string }).sha,
    parents: [main],
  });
  const sha = commit.sha as string;
  await gitApi('PATCH', `/git/refs/heads/${branch}`, { sha, force: true });
  return sha;
}

async function gitApi(method: string, path: string, body?: object) {
  const response = await fetch(`${h.github.url}/repos/octo-owner/bakery${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return (await response.json()) as Record<string, unknown>;
}
