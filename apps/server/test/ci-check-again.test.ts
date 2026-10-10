import { schema } from '@orchestrator/db';
import {
  ApiError,
  CheckCiAgainResponse,
  NeedsYouResponse,
  type DodReport,
  type NeedsYouItem,
  type RunInput,
  type RunResume,
  type TicketDetail,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import type { FakeRepository } from './fake-github.js';
import { RunHarness, eventually, state } from './run-harness.js';

// **Check CI again** (04, section 3.1; owner's answer 6 of step G2 and answers of steps G2b and
// G2c), the ticket page's CI line, the "Needs you" items of a run ended `ci_timeout` and the run
// page's rounds, against the fake GitHub with a clock the test controls. Check CI again starts no
// session: it reads the run's commit on GitHub once, also after a re-run made by hand there.

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

const MINUTE = 60_000;
let clock = new Date('2026-10-10T10:00:00.000Z');
const advance = (minutes: number) => {
  clock = new Date(clock.getTime() + minutes * MINUTE);
};
const BRANCH = 't/1-contact-form';
const utc = (at: Date) => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

async function working(
  ci: 'success' | 'queued' | 'none' = 'queued',
  settings: { maxCiFailuresPerRun?: number } = {},
) {
  clock = new Date('2026-10-10T10:00:00.000Z');
  await h.start({ now: () => clock, ci, settings });
  const repo = h.github.repository('octo-owner', 'bakery');
  await h.createTicket();
  const machine = await h.machine();
  const run = await h.running(machine.daemon);
  return { ...machine, ...run, repo };
}

async function submitted(daemon: ScriptedDaemon, runId: string, runToken: string) {
  const answer = await h.ok(daemon, runToken, 'ticket_submit', REPORT);
  expect(answer.result).toBe('pending_ci');
  await h.report(daemon, state(runId, { state: 'waiting_ci' }));
  await eventually('the pull request opened', async () => {
    expect((await h.ticket()).pullRequest.opened?.state).toBe('open');
  });
  const commit = h.lastPushed ?? '';
  await eventually('the wait begun', async () => {
    expect((await h.run(runId)).ci).toMatchObject({ commit });
  });
  return commit;
}

function failAll(repo: FakeRepository, commit: string) {
  for (const run of h.github.runs(repo, commit)) {
    h.github.completeRun(run, [
      { job: 'docs-links', step: 'Check documentation links', log: 'Broken link' },
    ]);
  }
}

function passAll(repo: FakeRepository, commit: string) {
  for (const run of h.github.runs(repo, commit)) h.github.completeRun(run);
}

function rounds(daemon: ScriptedDaemon, runId: string) {
  return daemon.received.filter(
    (message): message is RunInput | RunResume =>
      (message.type === 'run.input' || message.type === 'run.resume') &&
      message.payload.runId === runId,
  );
}

async function round(daemon: ScriptedDaemon, runId: string, count = 1) {
  await eventually(`round message ${String(count)}`, () => {
    expect(rounds(daemon, runId).length).toBeGreaterThanOrEqual(count);
  });
  const message = rounds(daemon, runId)[count - 1];
  if (!message) throw new Error('no round message');
  return message;
}

function answer(daemon: ScriptedDaemon, id: string, ok = true, message = '') {
  daemon.send({ type: 'ack', id, payload: ok ? { ok: true } : { ok: false, message } });
}

async function confirmed(daemon: ScriptedDaemon, runId: string, message: RunInput | RunResume) {
  const before = (await h.events('run.ci_round_sent')).length;
  answer(daemon, message.id);
  await eventually('the round counted', async () => {
    expect((await h.events('run.ci_round_sent')).length).toBe(before + 1);
  });
  await h.report(daemon, state(runId, { state: 'working' }));
}

/** CI wait at submission (20 minutes) reached with CI still queued: `ci_timeout`. */
async function timedOut() {
  const { daemon, runId, runToken, repo } = await working();
  const commit = await submitted(daemon, runId, runToken);
  advance(21);
  await h.t.ciTick();
  expect(await h.run(runId)).toMatchObject({ status: 'failed', failureReason: 'ci_timeout' });
  await h.report(daemon, state(runId, { state: 'ended', reason: 'stopped' }));
  return { daemon, runId, runToken, repo, commit };
}

function checkAgain(runId: string) {
  return h.call('POST', '/api/projects/WEB/tickets/1/ci/check-again', { runId });
}

async function checked(runId: string) {
  const response = await checkAgain(runId);
  expect(response.statusCode, response.body).toBe(200);
  return CheckCiAgainResponse.parse(response.json());
}

async function refused(runId: string) {
  const response = await checkAgain(runId);
  expect(response.statusCode, response.body).toBe(409);
  return ApiError.parse(response.json()).error;
}

async function ciItems(): Promise<Extract<NeedsYouItem, { type: 'ci_timeout' }>[]> {
  const response = await h.call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items.filter(
    (item): item is Extract<NeedsYouItem, { type: 'ci_timeout' }> => item.type === 'ci_timeout',
  );
}

async function checkedEvents() {
  return (await h.events('ticket.ci_checked_again')).map(
    (event) => event.payload as Record<string, unknown>,
  );
}

function lastComment(ticket: TicketDetail) {
  return ticket.timeline
    .flatMap((entry) => (entry.type === 'comment' ? [entry.comment.body] : []))
    .at(-1);
}

const runStarts = (daemon: ScriptedDaemon) =>
  daemon.received.filter((message) => message.type === 'run.start');

describe('Check CI again after CI did not finish', () => {
  it('finds CI still not finished and changes nothing, then accepts once CI passed, without a session', async () => {
    const { daemon, runId, repo, commit } = await timedOut();
    const ticket = await h.ticket();
    expect(ticket).toMatchObject({ status: 'todo', attemptCount: 0 });
    expect(ticket.ci).toMatchObject({
      runId,
      failureReason: 'ci_timeout',
      waitMinutes: 20,
      checkCiAgain: true,
      outcome: { kind: 'not_finished', commit, pullRequestOpened: true },
    });
    expect(await ciItems()).toEqual([
      expect.objectContaining({
        runId,
        machine: expect.objectContaining({ name: 'Laptop' }) as unknown,
        pullRequest: 1,
        waitMinutes: 20,
        outcome: expect.objectContaining({ kind: 'not_finished', commit }) as unknown,
      }),
    ]);

    // Still running on GitHub: nothing changes.
    const before = h.github.requests.length;
    expect(await checked(runId)).toMatchObject({ outcome: 'not_finished', finished: 0, total: 1 });
    expect(h.github.requests.length).toBeGreaterThan(before);
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });
    expect(await ciItems()).toHaveLength(1);

    // CI passed since: the stored submission is accepted, no session starts.
    passAll(repo, commit);
    advance(10);
    const starts = runStarts(daemon).length;
    expect(await checked(runId)).toEqual({
      outcome: 'accepted',
      state: 'passed',
      attemptTakenBack: false,
    });
    expect(runStarts(daemon)).toHaveLength(starts);
    const accepted = await h.ticket();
    expect(accepted).toMatchObject({ status: 'in_review', attemptCount: 0 });
    expect(accepted.ci).toMatchObject({
      checkCiAgain: false,
      outcome: {
        kind: 'not_finished',
        acceptedLater: { at: clock.toISOString(), state: 'passed', attemptTakenBack: false },
      },
    });
    const comments = accepted.timeline.flatMap((entry) =>
      entry.type === 'comment' ? [entry.comment.body] : [],
    );
    expect(comments.at(-1)).toBe(
      `CI passed on GitHub for commit ${commit.slice(0, 7)} (checked again by the owner at ${utc(clock)}): the work was accepted without a session.`,
    );
    expect(await ciItems()).toEqual([]);
    expect((await h.run(runId)).ciHistory?.outcome?.acceptedLater).toMatchObject({
      state: 'passed',
    });
    expect(await checkedEvents()).toEqual([
      expect.objectContaining({ runId, commit, outcome: 'not_finished' }),
      expect.objectContaining({ runId, commit, outcome: 'accepted', state: 'passed' }),
    ]);
    const changes = (await h.events('ticket.status_changed')).map(
      (event) => event.payload as Record<string, unknown>,
    );
    expect(changes.at(-1)).toMatchObject({
      from: 'todo',
      to: 'in_review',
      action: 'ci_checked_again',
      runId,
    });

    // Accepted: offered no more.
    expect(await refused(runId)).toMatchObject({
      code: 'ci_check_refused',
      ciRefusal: 'not_offered',
    });
  });

  it('accepts "No CI found" when nothing ran and the pull request does not conflict', async () => {
    const { daemon, runId, runToken } = await working('none');
    await submitted(daemon, runId, runToken);
    // GitHub unreachable until the deadline: nothing decided.
    h.github.override = () => ({ status: 503, body: { message: 'down' } });
    advance(21);
    await h.t.ciTick();
    expect((await h.run(runId)).failureReason).toBe('ci_timeout');
    h.github.override = undefined;
    expect(await checked(runId)).toEqual({
      outcome: 'accepted',
      state: 'no_ci',
      attemptTakenBack: false,
    });
    expect((await h.ticket()).ci?.outcome.acceptedLater).toMatchObject({ state: 'no_ci' });
  });

  it('says GitHub could not be checked, changing nothing', async () => {
    const { runId } = await timedOut();
    h.github.override = () => ({ status: 503, body: { message: 'down' } });
    const answer = await checked(runId);
    expect(answer).toMatchObject({ outcome: 'github_problem' });
    expect(answer.outcome === 'github_problem' && answer.message).toMatch(
      /GitHub could not be reached/,
    );
    expect((await h.ticket()).status).toBe('todo');
  });

  it('finds CI failed, changing nothing', async () => {
    const { runId, repo, commit } = await timedOut();
    failAll(repo, commit);
    const answer = await checked(runId);
    expect(answer).toMatchObject({ outcome: 'failed' });
    expect(answer.outcome === 'failed' && answer.checks.map((check) => check.name)).toEqual(['CI']);
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });
  });
});

describe('Check CI again refused', () => {
  it('while a run is active, and for a run that is not the latest with CI', async () => {
    const { daemon, runId } = await timedOut();
    const next = await h.running(daemon);
    expect(await refused(runId)).toMatchObject({
      ciRefusal: 'run_active',
      message: 'A run is working on WEB-1: its own submission will be checked.',
    });
    // The later run's line is hidden while it works without having handed in.
    expect((await h.ticket()).ci).toBeNull();
    expect(await ciItems()).toEqual([]);
    await h.ok(daemon, next.runToken, 'ticket_submit', REPORT);
    await h.report(daemon, state(next.runId, { state: 'waiting_ci' }));
    await eventually('the next wait', async () => {
      expect((await h.ticket()).ci).toMatchObject({
        runId: next.runId,
        outcome: { kind: 'waiting' },
      });
    });
    // That run's session stopped while it waited: its work stays newer than the first run's.
    await h.report(daemon, state(next.runId, { state: 'ended', reason: 'stopped' }));
    expect((await refused(runId)).ciRefusal).toBe('newer_work');
  });

  it('when newer work was accepted since', async () => {
    const { daemon, runId, runToken, repo } = await timedOut();
    // A later run hands in and its CI passes: the ticket is in review with newer work.
    const next = await h.running(daemon);
    const newer = await submitted(daemon, next.runId, next.runToken);
    passAll(repo, newer);
    await h.t.ciTick();
    await eventually('the newer work accepted', async () => {
      expect((await h.ticket()).status).toBe('in_review');
    });
    expect(runToken).not.toBe(next.runToken);
    const refusal = await refused(runId);
    expect(refusal.ciRefusal).toBe('newer_work');
    expect(refusal.message).toMatch(/^WEB-1 has newer work, accepted on .*: its own CI decides\.$/);
  });

  it('when the branch moved on GitHub', async () => {
    const { runId, repo, commit } = await timedOut();
    const head = h.github.commit(repo, BRANCH, { 'src/other.ts': 'export {};\n' }, 'By hand');
    const refusal = await refused(runId);
    expect(refusal).toMatchObject({
      ciRefusal: 'branch_moved',
      message: `The branch changed on GitHub after commit ${commit.slice(0, 7)} (it is now ${head.slice(0, 7)}), so this result would not be about the latest work. Run now hands the work in again.`,
    });
    expect(await checkedEvents()).toEqual([
      expect.objectContaining({ outcome: 'refused', refusal: 'branch_moved' }),
    ]);
  });

  it('when the pull request is closed or merged', async () => {
    const { runId, repo } = await timedOut();
    h.github.closePullRequest(repo, 1);
    expect(await refused(runId)).toMatchObject({
      ciRefusal: 'pull_request_closed',
      message: 'Pull request #1 is closed on GitHub, so the work cannot be accepted.',
    });
  });

  it('when the pull request was merged', async () => {
    const { runId, repo } = await timedOut();
    h.github.mergePullRequest(repo, 1);
    expect(await refused(runId)).toMatchObject({
      ciRefusal: 'pull_request_merged',
      message: 'Pull request #1 was merged on GitHub. Use Mark as done manually.',
    });
  });

  it('when the pull request was never opened, and its item says the order', async () => {
    const { daemon, runId, runToken } = await working();
    // GitHub refuses to open the pull request until the deadline.
    h.github.override = (request) =>
      request.method === 'POST' && request.path.endsWith('/pulls')
        ? { status: 503, body: { message: 'down' } }
        : undefined;
    await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    await h.report(daemon, state(runId, { state: 'waiting_ci' }));
    advance(21);
    await h.t.ciTick();
    expect((await h.run(runId)).failureReason).toBe('ci_timeout');
    expect(await ciItems()).toEqual([
      expect.objectContaining({
        pullRequest: null,
        outcome: expect.objectContaining({
          kind: 'not_finished',
          pullRequestOpened: false,
        }) as unknown,
      }),
    ]);
    expect(await refused(runId)).toMatchObject({
      ciRefusal: 'no_pull_request',
      message:
        'WEB-1 has no pull request on GitHub yet: Try again in "Pull request not opened" opens it.',
    });
  });
});

describe('after ci_failed (owner answers 3c and 3d)', () => {
  it('finds the failure again, then accepts after a re-run by hand on GitHub and takes the attempt back', async () => {
    const { daemon, runId, runToken, repo } = await working('queued', { maxCiFailuresPerRun: 1 });
    const first = await submitted(daemon, runId, runToken);
    failAll(repo, first);
    await h.t.ciTick();
    await confirmed(daemon, runId, await round(daemon, runId));
    const second = await submitted(daemon, runId, runToken);
    failAll(repo, second);
    await h.t.ciTick();
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 1 });
    await h.report(daemon, state(runId, { state: 'ended', reason: 'stopped' }));

    const ticket = await h.ticket();
    expect(ticket.ci).toMatchObject({
      runId,
      failureReason: 'ci_failed',
      maxCiFailures: 1,
      checkCiAgain: true,
      outcome: { kind: 'too_many', commit: second, failures: 2, anyConflict: false },
    });
    // ci_failed is counted: no "Needs you" item of its own.
    expect(await ciItems()).toEqual([]);

    expect(await checked(runId)).toMatchObject({ outcome: 'failed' });
    expect((await h.ticket()).attemptCount).toBe(1);

    // The owner re-runs the failed jobs on GitHub, and they pass.
    passAll(repo, second);
    expect(await checked(runId)).toEqual({
      outcome: 'accepted',
      state: 'passed',
      attemptTakenBack: true,
    });
    const accepted = await h.ticket();
    expect(accepted).toMatchObject({ status: 'in_review', attemptCount: 0 });
    const comments = accepted.timeline.flatMap((entry) =>
      entry.type === 'comment' ? [entry.comment.body] : [],
    );
    expect(comments.at(-1)).toBe(
      `CI passed on GitHub for commit ${second.slice(0, 7)} (checked again by the owner at ${utc(clock)}): the work was accepted without a session, and the failed attempt of that run no longer counts.`,
    );
    expect((await h.run(runId)).ciHistory?.outcome?.acceptedLater).toMatchObject({
      attemptTakenBack: true,
    });
  });

  it('is not offered after a conflict ended the run', async () => {
    const { daemon, runId, runToken, repo } = await working('none', { maxCiFailuresPerRun: 1 });
    const first = await submitted(daemon, runId, runToken);
    failAll(repo, first);
    h.github.setStatus(repo, first, { context: 'deploy', state: 'failure' });
    await h.t.ciTick();
    await confirmed(daemon, runId, await round(daemon, runId));
    await submitted(daemon, runId, runToken);
    h.github.commit(repo, 'main', { 'src/work-2.ts': 'export const other = 1;\n' }, 'Other');
    advance(6);
    await h.t.ciTick();
    await h.t.ciTick();
    expect((await h.run(runId)).failureReason).toBe('ci_failed');
    const ticket = await h.ticket();
    expect(ticket.ci).toMatchObject({
      checkCiAgain: false,
      outcome: { kind: 'too_many', conflict: true, failures: 2 },
    });
    expect(await refused(runId)).toMatchObject({ ciRefusal: 'not_offered' });
  });
});

describe('the ticket page and "Needs you" after other ends (owner answers 1, 2 and 3g)', () => {
  it('a failure the machine never confirmed: CI failed, the agent did not get it', async () => {
    const { daemon, runId, runToken, repo } = await working();
    const commit = await submitted(daemon, runId, runToken);
    failAll(repo, commit);
    await h.t.ciTick();
    await round(daemon, runId);
    advance(21);
    await h.t.ciTick();
    expect((await h.run(runId)).failureReason).toBe('ci_timeout');
    const ticket = await h.ticket();
    expect(ticket.ci).toMatchObject({
      checkCiAgain: true,
      outcome: { kind: 'not_received', notSent: { why: 'not_confirmed' } },
    });
    expect(await ciItems()).toEqual([
      expect.objectContaining({
        outcome: expect.objectContaining({ kind: 'not_received' }) as unknown,
      }),
    ]);
    const history = (await h.run(runId)).ciHistory;
    expect(history?.rounds).toEqual([
      expect.objectContaining({ round: 1, kind: 'failed', commit, confirmedAt: null }),
    ]);
    // A new run makes the item go.
    await h.report(daemon, state(runId, { state: 'ended', reason: 'stopped' }));
    await h.running(daemon);
    expect(await ciItems()).toEqual([]);
  });

  it('a conflict whose download failed: Run now only, the refusal kept for the run page', async () => {
    const { daemon, runId, runToken, repo } = await working('none');
    await submitted(daemon, runId, runToken);
    h.github.commit(repo, 'main', { 'src/work-1.ts': 'export const other = 1;\n' }, 'Other');
    advance(6);
    await h.t.ciTick();
    await h.t.ciTick();
    answer(
      daemon,
      (await round(daemon, runId)).id,
      false,
      'Downloading main from GitHub failed: GitHub could not be reached',
    );
    await eventually('the refusal kept', async () => {
      expect(await h.events('run.ci_round_not_taken')).toHaveLength(1);
    });
    advance(15);
    await h.t.ciTick();
    const ticket = await h.ticket();
    expect(ticket.ci).toMatchObject({
      checkCiAgain: false,
      base: 'main',
      outcome: {
        kind: 'conflict',
        notSent: {
          why: 'refused',
          message: 'Downloading main from GitHub failed: GitHub could not be reached',
        },
      },
    });
    expect(await ciItems()).toEqual([
      expect.objectContaining({
        base: 'main',
        outcome: expect.objectContaining({ kind: 'conflict' }) as unknown,
      }),
    ]);
    expect((await h.run(runId)).ciHistory?.rounds).toEqual([]);
  });

  it('a run that ended after a confirmed round, without handing in again', async () => {
    const { daemon, runId, runToken, repo } = await working();
    const commit = await submitted(daemon, runId, runToken);
    failAll(repo, commit);
    await h.t.ciTick();
    await confirmed(daemon, runId, await round(daemon, runId));
    await h.report(daemon, state(runId, { state: 'ended', reason: 'stopped' }));
    await eventually('the run ended', async () => {
      expect((await h.run(runId)).status).not.toBe('running');
    });
    const ticket = await h.ticket();
    expect(ticket.ci).toMatchObject({
      runId,
      checkCiAgain: false,
      outcome: { kind: 'after_round', commit, round: 1, conflict: false },
    });
    expect(ticket.ci?.failureReason).not.toBeNull();
    expect(await ciItems()).toEqual([]);
    expect(await refused(runId)).toMatchObject({ ciRefusal: 'not_offered' });
  });

  it('cancelled because the branch changed: the head read then', async () => {
    const { daemon, runId, runToken, repo } = await working();
    const commit = await submitted(daemon, runId, runToken);
    const head = h.github.commit(repo, BRANCH, { 'src/other.ts': 'export {};\n' }, 'By hand');
    for (const run of h.github.runs(repo, commit)) h.github.cancelRun(run);
    await h.t.ciTick();
    expect((await h.run(runId)).failureReason).toBe('ci_cancelled');
    const [row] = await h.t.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(row?.ciPullRequestHead).toBe(head);
    expect((await h.ticket()).ci).toMatchObject({
      checkCiAgain: false,
      outcome: { kind: 'cancelled', pullRequestHead: head },
    });
  });
});
