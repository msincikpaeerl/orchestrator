import { schema } from '@orchestrator/db';
import { CiResult, type DodReport, type RunStop } from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import type { FakeRepository } from './fake-github.js';
import { RunHarness, SESSION, cleanWorkspace, eventually, state } from './run-harness.js';

// The wait for CI after an accepted submission (04, section 3.1; lot 3 step G1a), against the
// fake GitHub, with a clock the test controls: each check is one tick the test starts.

const h = new RunHarness();

afterEach(async () => {
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

const MINUTE = 60_000;
let clock = new Date('2026-10-09T10:00:00.000Z');
const advance = (minutes: number) => {
  clock = new Date(clock.getTime() + minutes * MINUTE);
};

/** `WEB-1` running on a connected machine; the project's CI does `ci` by itself. */
async function working(ci: 'success' | 'queued' | 'none' = 'queued') {
  clock = new Date('2026-10-09T10:00:00.000Z');
  await h.start({ now: () => clock, ci });
  const repo = h.github.repository('octo-owner', 'bakery');
  await h.createTicket();
  const machine = await h.machine();
  const run = await h.running(machine.daemon);
  return { ...machine, ...run, repo };
}

/** Submits, then the session idles waiting for CI once the pull request is open. */
async function submitted(daemon: ScriptedDaemon, runId: string, runToken: string) {
  const answer = await h.ok(daemon, runToken, 'ticket_submit', REPORT);
  expect(answer.result).toBe('pending_ci');
  await h.report(daemon, state(runId, { state: 'waiting_ci' }));
  await eventually('the pull request opened', async () => {
    expect((await h.ticket()).pullRequest.opened?.state).toBe('open');
  });
  const commit = h.lastPushed ?? '';
  expect((await h.run(runId)).ci).toMatchObject({ commit, since: clock.toISOString() });
  return commit;
}

async function runRow(runId: string) {
  const [row] = await h.t.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!row) throw new Error('no run');
  return row;
}

function stops(daemon: ScriptedDaemon, runId: string) {
  return daemon.received.filter(
    (message): message is RunStop => message.type === 'run.stop' && message.payload.runId === runId,
  );
}

async function ciEvents() {
  return (await h.events('run.ci_')).map((event) => ({
    type: event.type,
    payload: event.payload as Record<string, unknown>,
  }));
}

function completeAll(repo: FakeRepository, commit: string, failures = false) {
  for (const run of h.github.runs(repo, commit)) {
    h.github.completeRun(
      run,
      failures
        ? [{ job: 'docs-links', step: 'Check documentation links', log: 'Broken link' }]
        : [],
    );
  }
}

/** A commit on the default branch changing the file the agent's first push added. */
function conflictOnMain(repo: FakeRepository) {
  h.github.commit(repo, 'main', { 'src/work-1.ts': 'export const other = 1;\n' }, 'Other work');
}

describe('the wait for CI', () => {
  it('passes when every run of the submitted commit passed, without counting working time', async () => {
    const { daemon, runId, runToken, repo } = await working('queued');
    const commit = await submitted(daemon, runId, runToken);
    const workedBefore = (await runRow(runId)).workingMs;
    advance(3);
    await h.t.ciTick();
    // Queued: the run waits, the ticket stays in progress.
    expect((await h.run(runId)).status).toBe('running');
    expect((await h.run(runId)).ci?.result?.state).toBe('pending');
    expect(stops(daemon, runId)).toEqual([]);
    completeAll(repo, commit);
    advance(1);
    await h.t.ciTick();
    const run = await h.run(runId);
    expect(run.status).toBe('succeeded');
    expect(run.ci?.result?.state).toBe('passed');
    expect((await h.ticket()).status).toBe('in_review');
    expect(stops(daemon, runId).map((stop) => stop.payload.reason)).toEqual(['completed']);
    // The 4 minutes waiting for CI count as waiting, never as working time.
    expect(run.workingMs).toBe(workedBefore);
    expect(run.waitingMs).toBe(4 * MINUTE);
    expect((await ciEvents()).map((event) => event.type)).toEqual([
      'run.ci_waiting',
      'run.ci_result',
    ]);
    // The daemon's end afterwards only adds its branch.
    await h.report(daemon, state(runId, { state: 'ended', reason: 'submitted' }));
    expect((await h.run(runId)).status).toBe('succeeded');
  });

  it('never takes an older green commit of the branch for the submitted one', async () => {
    const { daemon, runId, runToken, repo } = await working('success');
    const first = await submitted(daemon, runId, runToken);
    await h.t.ciTick();
    expect((await h.ticket()).status).toBe('in_review');
    // The older commit is green, by its run and by a status on the commit and the branch's name.
    h.github.setStatus(repo, first, { context: 'deploy', state: 'success' });
    await h.report(daemon, state(runId, { state: 'ended', reason: 'submitted' }));
    const changes = await h.call('POST', '/api/projects/WEB/tickets/1/request-changes', {
      comment: 'One more thing',
    });
    expect(changes.statusCode, changes.body).toBe(200);
    repo.ci = 'queued';
    const next = await h.running(daemon);
    const second = await submitted(daemon, next.runId, next.runToken);
    expect(second).not.toBe(first);
    h.github.requests.length = 0;
    for (let minute = 0; minute < 10; minute++) {
      advance(1);
      await h.t.ciTick();
    }
    expect((await h.run(next.runId)).status).toBe('running');
    expect((await h.ticket()).status).toBe('in_progress');
    expect(stops(daemon, next.runId)).toEqual([]);
    // Only the submitted commit was asked about, by its hash.
    const ciPaths = h.github.requests
      .map((request) => request.path)
      .filter((path) => path.includes('/actions/runs') || path.includes('/status'));
    expect(ciPaths.length).toBeGreaterThan(0);
    for (const path of ciPaths) {
      expect(
        path.includes(`head_sha=${second}`) || path.includes(`/commits/${second}/status`),
      ).toBe(true);
    }
    completeAll(repo, second);
    await h.t.ciTick();
    expect((await h.run(next.runId)).status).toBe('succeeded');
  });

  it('gives "No CI found", never "passed", when the submitted commit has no run beside a green older one', async () => {
    const { daemon, runId, runToken, repo } = await working('success');
    await submitted(daemon, runId, runToken);
    await h.t.ciTick();
    await h.report(daemon, state(runId, { state: 'ended', reason: 'submitted' }));
    await h.call('POST', '/api/projects/WEB/tickets/1/request-changes', { comment: 'Again' });
    repo.ci = 'none';
    const next = await h.running(daemon);
    await submitted(daemon, next.runId, next.runToken);
    advance(4);
    await h.t.ciTick();
    expect((await h.run(next.runId)).ci?.result).toMatchObject({ state: 'pending', checks: [] });
    // Wait for CI to start (5 minutes) over: the pull request is read, without a conflict.
    advance(2);
    await h.t.ciTick();
    const run = await h.run(next.runId);
    expect(run.status).toBe('succeeded');
    expect(run.ci?.result?.state).toBe('no_ci');
    expect((await ciEvents()).at(-1)?.payload).toMatchObject({ state: 'no_ci', checks: 0 });
  });

  it('keeps the workflow flag with "No CI found" when the agent deleted the workflow files', async () => {
    const { daemon, runId, runToken, repo } = await working('success');
    // The agent's branch deletes the skeleton's CI: no pull_request run (A29).
    const [ticket] = await h.t.db.select().from(schema.tickets);
    h.github.commit(
      repo,
      ticket?.branchName ?? '',
      { '.github/workflows/ci.yml': null },
      'No CI',
      'main',
    );
    const answer = await h.tool(
      daemon,
      runToken,
      'ticket_submit',
      REPORT,
      cleanWorkspace({
        changedFiles: {
          listed: ['.github/workflows/ci.yml', 'docs/user/contact.md', 'src/contact.test.ts'],
          count: 3,
        },
      }),
    );
    expect(answer.ok).toBe(true);
    await h.report(daemon, state(runId, { state: 'waiting_ci' }));
    await eventually('the pull request opened', async () => {
      expect((await h.ticket()).pullRequest.opened?.state).toBe('open');
    });
    advance(6);
    await h.t.ciTick();
    await h.t.ciTick();
    expect((await h.run(runId)).ci?.result?.state).toBe('no_ci');
    expect((await ciEvents()).at(-1)?.payload).toMatchObject({
      state: 'no_ci',
      workflowChanges: 'changed',
    });
  });

  it('never passes a conflicting pull request with no run: mergeable null, then false', async () => {
    const { daemon, runId, runToken, repo } = await working('none');
    await submitted(daemon, runId, runToken);
    conflictOnMain(repo);
    advance(6);
    await h.t.ciTick();
    // GitHub computes it first.
    expect((await h.run(runId)).ci?.result?.state).toBe('pending');
    await h.t.ciTick();
    expect((await h.run(runId)).ci?.result?.state).toBe('conflict');
    for (let minute = 0; minute < 10; minute++) {
      advance(1);
      await h.t.ciTick();
    }
    expect((await h.run(runId)).status).toBe('running');
    expect((await ciEvents()).filter((event) => event.payload.state === 'conflict')).toHaveLength(
      1,
    );
    // CI wait at submission (20 minutes) reached: not counted, the ticket back to todo.
    advance(5);
    await h.t.ciTick();
    const run = await h.run(runId);
    expect(run).toMatchObject({ status: 'failed', failureReason: 'ci_timeout' });
    expect(run.endDetail).toMatch(/conflicts with main/);
    const ticket = await h.ticket();
    expect(ticket).toMatchObject({ status: 'todo', attemptCount: 0 });
    expect(stops(daemon, runId).map((stop) => stop.payload.reason)).toEqual(['not_active']);
  });

  it('changes nothing when a conflict appears after the runs started', async () => {
    const { daemon, runId, runToken, repo } = await working('queued');
    const commit = await submitted(daemon, runId, runToken);
    conflictOnMain(repo);
    advance(6);
    await h.t.ciTick();
    expect((await h.run(runId)).ci?.result?.state).toBe('pending');
    completeAll(repo, commit);
    await h.t.ciTick();
    expect((await h.run(runId)).ci?.result?.state).toBe('passed');
    expect((await h.ticket()).status).toBe('in_review');
  });

  it('sends a failed CI result back to the agent instead of ending the run (step G2b)', async () => {
    const { daemon, runId, runToken, repo } = await working('queued');
    const commit = await submitted(daemon, runId, runToken);
    completeAll(repo, commit, true);
    await h.t.ciTick();
    // The rounds themselves are tested in ci-rounds.test.ts.
    await daemon.find(
      (message) => message.type === 'run.input' && message.payload.runId === runId,
      'the CI round',
    );
    const run = await h.run(runId);
    expect(run).toMatchObject({ status: 'running', failureReason: null });
    expect(run.ci?.result?.state).toBe('failed');
    expect((await h.ticket()).attemptCount).toBe(0);
    expect(stops(daemon, runId)).toEqual([]);
  });

  it('keeps waiting while GitHub is unreachable, limited or unreadable, then goes on', async () => {
    const { daemon, runId, runToken, repo } = await working('queued');
    const commit = await submitted(daemon, runId, runToken);
    const isRuns = (path: string) => path.includes('/actions/runs?');
    h.github.alter = (request, reply) => (isRuns(request.path) ? { status: 503 } : reply);
    await h.t.ciTick();
    advance(1);
    await h.t.ciTick();
    expect((await h.run(runId)).ci?.checkFailure).toMatchObject({ reason: 'unreachable' });
    const reset = Math.floor(clock.getTime() / 1000) + 600;
    h.github.alter = (request, reply) =>
      isRuns(request.path)
        ? {
            status: 403,
            body: { message: 'API rate limit exceeded' },
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
          }
        : reply;
    advance(1);
    await h.t.ciTick();
    expect((await h.run(runId)).ci?.checkFailure).toMatchObject({
      reason: 'rate_limited',
      retryAt: new Date(reset * 1000).toISOString(),
    });
    h.github.alter = (request, reply) =>
      isRuns(request.path) ? { ...reply, body: { workflow_runs: 'none' } } : reply;
    advance(1);
    await h.t.ciTick();
    expect((await h.run(runId)).ci?.checkFailure).toMatchObject({
      reason: 'unreadable',
      fields: ['workflow_runs: expected array, received a string'],
    });
    expect((await h.run(runId)).status).toBe('running');
    // One event per reason, never one per check.
    expect(
      (await ciEvents())
        .filter((event) => event.type === 'run.ci_check_failed')
        .map((event) => event.payload.reason),
    ).toEqual(['unreachable', 'rate_limited', 'unreadable']);
    h.github.alter = undefined;
    completeAll(repo, commit);
    await h.t.ciTick();
    expect((await h.run(runId)).status).toBe('succeeded');
    expect((await ciEvents()).map((event) => event.type)).toContain('run.ci_check_recovered');
  });

  it('ends with ci_timeout when GitHub stays unreachable until CI wait at submission', async () => {
    const { daemon, runId, runToken } = await working('queued');
    await submitted(daemon, runId, runToken);
    h.github.alter = () => ({ status: 502 });
    advance(21);
    await h.t.ciTick();
    const run = await h.run(runId);
    expect(run).toMatchObject({ status: 'failed', failureReason: 'ci_timeout' });
    expect(run.endDetail).toMatch(/GitHub could not be checked/);
  });

  it('goes on after a server restart, a result finished meanwhile winning over the deadline', async () => {
    const { daemon, runId, runToken, repo, token } = await working('queued');
    const commit = await submitted(daemon, runId, runToken);
    await h.t.ciTick();
    await h.t.restart();
    // The daemon still has the run, waiting for CI: its `hello` lists it (lot 4 step G).
    await h.connect(token, { runs: [{ runId, state: 'waiting_ci', claudeSessionId: SESSION }] });
    // CI finished while the server was down, and the deadline passed too.
    completeAll(repo, commit);
    advance(30);
    await h.t.ciTick();
    expect((await h.run(runId)).status).toBe('succeeded');
    expect((await h.ticket()).status).toBe('in_review');
    expect((await ciEvents()).at(-1)?.payload).toMatchObject({ state: 'passed', commit });
  });

  it('keeps waiting after a server restart while CI runs', async () => {
    const { daemon, runId, runToken, repo, token } = await working('queued');
    const commit = await submitted(daemon, runId, runToken);
    await h.t.restart();
    // The daemon still has the run, waiting for CI: its `hello` lists it (lot 4 step G).
    await h.connect(token, { runs: [{ runId, state: 'waiting_ci', claudeSessionId: SESSION }] });
    advance(2);
    await h.t.ciTick();
    expect((await h.run(runId)).ci?.result?.state).toBe('pending');
    completeAll(repo, commit);
    await h.t.ciTick();
    expect((await h.run(runId)).status).toBe('succeeded');
  });

  it('accepts after the session ended during the wait, without a failed attempt', async () => {
    const { daemon, runId, runToken, repo } = await working('queued');
    const commit = await submitted(daemon, runId, runToken);
    // Claude Code ended: the daemon reports the wait with its session closed.
    await h.report(daemon, state(runId, { state: 'waiting_ci' }, false));
    // A daemon reporting its end as submitted meanwhile does not accept it either.
    await h.report(daemon, state(runId, { state: 'ended', reason: 'submitted' }));
    expect((await h.run(runId)).status).toBe('running');
    completeAll(repo, commit);
    await h.t.ciTick();
    const run = await h.run(runId);
    expect(run).toMatchObject({ status: 'succeeded', sessionAlive: false });
    expect(await h.ticket()).toMatchObject({ status: 'in_review', attemptCount: 0 });
  });

  it('ends with ci_timeout when the pull request is never opened', async () => {
    const { daemon, runId, runToken } = await working('queued');
    // GitHub never answers the search for the branch's pull request: none is opened.
    h.github.alter = (request, reply) =>
      request.method === 'GET' && request.path.includes('/pulls?') ? { status: 502 } : reply;
    expect((await h.ok(daemon, runToken, 'ticket_submit', REPORT)).result).toBe('pending_ci');
    await h.report(daemon, state(runId, { state: 'waiting_ci' }));
    await eventually('the attempt recorded', async () => {
      expect((await h.ticket()).pullRequest.failure).toBeTruthy();
    });
    advance(10);
    await h.t.ciTick();
    expect((await h.run(runId)).ci?.since).toBeNull();
    advance(11);
    await h.t.ciTick();
    const run = await h.run(runId);
    expect(run).toMatchObject({ status: 'failed', failureReason: 'ci_timeout' });
    expect(run.endDetail).toMatch(/pull request could not be opened/);
    expect(CiResult.nullable().parse(run.ci?.result ?? null)).toBeNull();
  });
});
