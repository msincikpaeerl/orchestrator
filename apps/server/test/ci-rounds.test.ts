import { schema } from '@orchestrator/db';
import {
  McpCiStatus,
  RunStart,
  type CiResult,
  type DodReport,
  type RunInput,
  type RunResume,
  type RunStop,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ciWatcherOf } from '../src/app.js';
import { ScriptedDaemon } from './daemon-client.js';
import type { FakeRepository } from './fake-github.js';
import { RunHarness, SESSION, cleanWorkspace, eventually, state } from './run-harness.js';

// The CI rounds of a run (04, section 3.1; owner's answers, lot 3 step G2b), against the fake
// GitHub with a clock the test controls: a failed CI result or a conflict sent back to the agent,
// counted once the machine confirmed it; one failure more than **Most CI failures per run** ends
// the run; a late result never decides; the same commit refused; runs cancelled because the branch
// moved; a round the machine could not take yet tried again at each check; the next run's first
// sentence.

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
/** Machine answer timeout (60 s) plus Longest push (60 s), the defaults. */
const ANSWER_WAIT_MINUTES = 2;

const BRANCH = 't/1-contact-form';

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

/** Submits, then the session idles waiting for CI once the pull request is open. */
async function submitted(
  daemon: ScriptedDaemon,
  runId: string,
  runToken: string,
  sessionAlive = true,
) {
  const answer = await h.ok(daemon, runToken, 'ticket_submit', REPORT);
  expect(answer.result).toBe('pending_ci');
  await h.report(daemon, state(runId, { state: 'waiting_ci' }, sessionAlive));
  await eventually('the pull request opened', async () => {
    expect((await h.ticket()).pullRequest.opened?.state).toBe('open');
  });
  const commit = h.lastPushed ?? '';
  await eventually('the wait begun', async () => {
    expect((await h.run(runId)).ci).toMatchObject({ commit });
  });
  return commit;
}

async function runRow(runId: string) {
  const [row] = await h.t.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  if (!row) throw new Error('no run');
  return row;
}

function failAll(repo: FakeRepository, commit: string) {
  for (const run of h.github.runs(repo, commit)) {
    h.github.completeRun(run, [
      {
        job: 'docs-links',
        step: 'Check documentation links',
        log: 'Broken link to docs/user/faq.md',
      },
    ]);
  }
}

function passAll(repo: FakeRepository, commit: string) {
  for (const run of h.github.runs(repo, commit)) h.github.completeRun(run);
}

/** A commit on the default branch changing the file the agent's first push added. */
const OTHER_WORK = 'export const other = 1;\n';
function conflictOnMain(repo: FakeRepository) {
  h.github.commit(repo, 'main', { 'src/work-1.ts': OTHER_WORK }, 'Other work');
}

/** The agent merges the base branch: its branch takes main's side of the file. */
function mergeMain(repo: FakeRepository) {
  h.github.commit(repo, BRANCH, { 'src/work-1.ts': OTHER_WORK }, 'Merge main');
}

/** The round messages the machine received for the run: `run.input` and `run.resume`. */
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

const textOf = (message: RunInput | RunResume) =>
  message.type === 'run.input' ? message.payload.text : message.payload.message;

function answer(daemon: ScriptedDaemon, id: string, ok = true, message = '') {
  daemon.send({ type: 'ack', id, payload: ok ? { ok: true } : { ok: false, message } });
}

async function counted(runId: string, count: number) {
  await eventually(`${String(count)} rounds counted`, async () => {
    expect((await h.events('run.ci_round_sent')).filter((e) => e.entityId === runId)).toHaveLength(
      count,
    );
  });
}

async function roundEvents(type: 'run.ci_round_sent' | 'run.ci_round_not_taken') {
  return (await h.events(type)).map((event) => event.payload as Record<string, unknown>);
}

function stops(daemon: ScriptedDaemon, runId: string) {
  return daemon.received.filter(
    (message): message is RunStop => message.type === 'run.stop' && message.payload.runId === runId,
  );
}

/** The round confirmed, and the agent works again before it hands in. */
async function confirmed(daemon: ScriptedDaemon, runId: string, message: RunInput | RunResume) {
  const before = (await h.events('run.ci_round_sent')).length;
  answer(daemon, message.id);
  await eventually('the round counted', async () => {
    expect((await h.events('run.ci_round_sent')).length).toBe(before + 1);
  });
  await h.report(daemon, state(runId, { state: 'working' }));
}

describe('a failed CI result sent back (owner answers 3 and 4)', () => {
  it('counts the round once the machine confirmed it; the next commit then passes', async () => {
    const { daemon, runId, runToken, repo } = await working();
    const first = await submitted(daemon, runId, runToken);
    failAll(repo, first);
    await h.t.ciTick();
    const message = await round(daemon, runId);
    expect(message.type).toBe('run.input');
    if (message.type !== 'run.input') return;
    expect(message.payload.fetchBase).toBeUndefined();
    expect(message.payload.text).toMatch(
      new RegExp(
        `^CI failed on GitHub for commit ${first}, .*\\(CI round 1 of 2 this run allows\\)`,
      ),
    );
    expect(message.payload.text).toContain('Broken link to docs/user/faq.md');
    // Not counted before the machine confirmed it; the run still runs, nothing sent twice.
    expect(await roundEvents('run.ci_round_sent')).toEqual([]);
    await h.t.ciTick();
    expect(rounds(daemon, runId)).toHaveLength(1);
    expect((await h.run(runId)).status).toBe('running');

    await confirmed(daemon, runId, message);
    expect(await roundEvents('run.ci_round_sent')).toEqual([
      expect.objectContaining({ commit: first, kind: 'failed', round: 1, of: 2 }),
    ]);
    // The same answer again counts nothing.
    answer(daemon, message.id);
    await h.t.ciTick();
    expect(await roundEvents('run.ci_round_sent')).toHaveLength(1);
    const row = await runRow(runId);
    expect(row).toMatchObject({ decision: null, ciCommit: null, ciRoundMessageId: null });
    expect(row.ciRounds).toEqual([
      expect.objectContaining({ round: 1, kind: 'failed', commit: first, via: 'input' }),
    ]);

    const second = await submitted(daemon, runId, runToken);
    expect(second).not.toBe(first);
    passAll(repo, second);
    await h.t.ciTick();
    expect(await h.run(runId)).toMatchObject({ status: 'succeeded' });
    expect(await h.ticket()).toMatchObject({ status: 'in_review', attemptCount: 0 });
  });

  it('ends the run ci_failed, counted, at one failure more than Most CI failures per run, kept at its start', async () => {
    const { daemon, runId, runToken, repo } = await working('queued', { maxCiFailuresPerRun: 1 });
    // A change after the run started does not change this run.
    expect(
      (await h.call('PUT', '/api/settings/maxCiFailuresPerRun', { value: 3 })).statusCode,
    ).toBe(200);
    const first = await submitted(daemon, runId, runToken);
    failAll(repo, first);
    await h.t.ciTick();
    const message = await round(daemon, runId);
    expect(textOf(message)).toMatch(/\(CI round 1 of 1 this run allows\)/);
    expect(textOf(message)).toContain(
      'This is the last CI round this run sends back: if CI fails again or the pull request conflicts after your next submission, the run ends and counts as a failed attempt.',
    );
    await confirmed(daemon, runId, message);

    const second = await submitted(daemon, runId, runToken);
    failAll(repo, second);
    await h.t.ciTick();
    const run = await h.run(runId);
    expect(run).toMatchObject({ status: 'failed', failureReason: 'ci_failed' });
    expect(rounds(daemon, runId)).toHaveLength(1);
    expect(stops(daemon, runId).map((stop) => stop.payload.reason)).toEqual(['not_active']);
    const ticket = await h.ticket();
    expect(ticket).toMatchObject({ status: 'todo', attemptCount: 1 });
    const comment = ticket.timeline.findLast((entry) => entry.type === 'comment');
    expect(JSON.stringify(comment)).toMatch(
      /CI failed on GitHub for the submitted commit .* after 1 CI round sent back to the agent/,
    );
  });

  it('ends the run ci_failed, counted, for a conflict after the last allowed round (owner answer 3)', async () => {
    const { daemon, runId, runToken, repo } = await working('none', { maxCiFailuresPerRun: 1 });
    const first = await submitted(daemon, runId, runToken);
    // No CI at all in this project: the first submission's runs never come; a status fails.
    h.github.setStatus(repo, first, { context: 'deploy', state: 'failure' });
    await h.t.ciTick();
    await confirmed(daemon, runId, await round(daemon, runId));
    await submitted(daemon, runId, runToken);
    conflictOnMain(repo);
    advance(6);
    await h.t.ciTick();
    await h.t.ciTick();
    const run = await h.run(runId);
    expect(run).toMatchObject({ status: 'failed', failureReason: 'ci_failed' });
    expect(run.endDetail).toMatch(/conflicts with main/);
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 1 });
  });
});

describe('a conflict sent back (owner answer 1)', () => {
  it('downloads the base branch first, then the merged work passes as "No CI found"', async () => {
    const { daemon, runId, runToken, repo } = await working('none');
    await submitted(daemon, runId, runToken);
    conflictOnMain(repo);
    advance(6);
    await h.t.ciTick();
    await h.t.ciTick();
    const message = await round(daemon, runId);
    expect(message).toMatchObject({ type: 'run.input', payload: { fetchBase: true } });
    expect(textOf(message)).toMatch(
      /^The pull request conflicts with main, so GitHub started no CI for commit [0-9a-f]{40}, /,
    );
    expect(textOf(message)).toContain('Run `git merge origin/main`');
    await confirmed(daemon, runId, message);
    expect(await roundEvents('run.ci_round_sent')).toEqual([
      expect.objectContaining({ kind: 'conflict', round: 1, of: 2 }),
    ]);

    mergeMain(repo);
    await submitted(daemon, runId, runToken);
    advance(6);
    await h.t.ciTick();
    await h.t.ciTick();
    expect(await h.run(runId)).toMatchObject({ status: 'succeeded' });
    expect((await h.ticket()).status).toBe('in_review');
  });

  it('a download that failed is not counted, tried again at each check; the deadline ends the run', async () => {
    const { daemon, runId, runToken, repo } = await working('none');
    await submitted(daemon, runId, runToken);
    conflictOnMain(repo);
    advance(6);
    await h.t.ciTick();
    await h.t.ciTick();
    const refused = 'Downloading main from GitHub failed: GitHub could not be reached';
    const first = await round(daemon, runId);
    answer(daemon, first.id, false, refused);
    await eventually('the refusal kept', async () => {
      expect(await roundEvents('run.ci_round_not_taken')).toHaveLength(1);
    });
    expect(await roundEvents('run.ci_round_sent')).toEqual([]);
    expect((await runRow(runId)).ciRounds).toEqual([]);

    // Tried again at the next check, as a new message; the same refusal writes no new event.
    advance(1);
    await h.t.ciTick();
    const second = await round(daemon, runId, 2);
    expect(second.id).not.toBe(first.id);
    answer(daemon, second.id, false, refused);
    await eventually('the second refusal handled', async () => {
      expect((await runRow(runId)).ciRoundMessageId).toBeNull();
    });
    expect(await roundEvents('run.ci_round_not_taken')).toHaveLength(1);

    // CI wait at submission (20 minutes from the submission) reached: not counted.
    advance(15);
    await h.t.ciTick();
    const run = await h.run(runId);
    expect(run).toMatchObject({ status: 'failed', failureReason: 'ci_timeout' });
    expect(run.endDetail).toContain(
      'The pull request conflicts with main, and the machine could not download main from GitHub: GitHub could not be reached.',
    );
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });
  });
});

describe('one round delivered once (owner point 2)', () => {
  it('sends the same message again after the answer wait, and counts one late answer once', async () => {
    const { daemon, runId, runToken, repo } = await working();
    const first = await submitted(daemon, runId, runToken);
    failAll(repo, first);
    await h.t.ciTick();
    const message = await round(daemon, runId);
    // Within Machine answer timeout plus Longest push: nothing sent again.
    advance(ANSWER_WAIT_MINUTES - 1);
    await h.t.ciTick();
    expect(rounds(daemon, runId)).toHaveLength(1);
    advance(1);
    await h.t.ciTick();
    const again = await round(daemon, runId, 2);
    expect(again.id).toBe(message.id);
    expect(textOf(again)).toBe(textOf(message));
    // Both answers come: one round.
    answer(daemon, message.id);
    answer(daemon, again.id);
    await counted(runId, 1);
    await h.t.ciTick();
    expect(await roundEvents('run.ci_round_sent')).toHaveLength(1);
  });

  it('sends the round when the machine is back, the same message', async () => {
    const { daemon, runId, runToken, repo, token } = await working();
    const first = await submitted(daemon, runId, runToken);
    await daemon.close();
    failAll(repo, first);
    await h.t.ciTick();
    const pending = await runRow(runId);
    expect(pending.ciRoundMessageId).not.toBeNull();
    expect(await roundEvents('run.ci_round_sent')).toEqual([]);
    // The machine comes back with its run waiting for CI.
    const back = await ScriptedDaemon.connect(h.t.url, token);
    try {
      expect(
        (
          await back.hello({
            runs: [{ runId, state: 'waiting_ci', claudeSessionId: SESSION }],
          })
        ).accepted,
      ).toBe(true);
      await h.t.ciTick();
      const message = await round(back, runId);
      expect(message.id).toBe(pending.ciRoundMessageId);
      answer(back, message.id);
      await counted(runId, 1);
    } finally {
      await back.close();
    }
  });

  it('ends ci_timeout, not counted, when the machine never confirms', async () => {
    const { daemon, runId, runToken, repo } = await working();
    const first = await submitted(daemon, runId, runToken);
    failAll(repo, first);
    await h.t.ciTick();
    await round(daemon, runId);
    advance(21);
    await h.t.ciTick();
    const run = await h.run(runId);
    expect(run).toMatchObject({ status: 'failed', failureReason: 'ci_timeout' });
    expect(run.endDetail).toContain(
      'CI failed on GitHub, and machine Laptop did not confirm it received the result',
    );
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });
  });

  it('gives a closed session the round with run.resume, and switches when the session closed meanwhile', async () => {
    const { daemon, runId, runToken, repo } = await working('none');
    await submitted(daemon, runId, runToken, false);
    conflictOnMain(repo);
    advance(6);
    await h.t.ciTick();
    await h.t.ciTick();
    const resumed = await round(daemon, runId);
    expect(resumed).toMatchObject({
      type: 'run.resume',
      payload: { claudeSessionId: SESSION, fetchBase: true },
    });
    await confirmed(daemon, runId, resumed);

    // The next round goes live, but the session closed before it arrived.
    mergeMain(repo);
    const second = await submitted(daemon, runId, runToken);
    h.github.setStatus(repo, second, { context: 'deploy', state: 'failure' });
    await h.t.ciTick();
    const live = await round(daemon, runId, 2);
    expect(live.type).toBe('run.input');
    answer(daemon, live.id, false, 'session closed: use run.resume');
    const switched = await round(daemon, runId, 3);
    expect(switched.type).toBe('run.resume');
    expect(switched.id).not.toBe(live.id);
    expect(textOf(switched)).toBe(textOf(live));
    answer(daemon, switched.id);
    await counted(runId, 2);
  });
});

describe('a late result and the same commit (owner answer 3)', () => {
  it('changes nothing with a late result of the earlier commit, sent after the new submission', async () => {
    const { daemon, runId, runToken, repo } = await working();
    const first = await submitted(daemon, runId, runToken);
    failAll(repo, first);
    await h.t.ciTick();
    await confirmed(daemon, runId, await round(daemon, runId));
    const second = await submitted(daemon, runId, runToken);
    const late = (state: 'passed' | 'failed'): CiResult & { state: 'passed' | 'failed' } => ({
      state,
      checks: [],
      failed_jobs: [],
      jobs_read: false,
      jobs_problem: null,
    });
    const outcomes = ciWatcherOf(h.t.app).outcomes;
    await outcomes.decided(runId, first, { result: late('passed'), pullRequestHead: null });
    await outcomes.decided(runId, first, { result: late('failed'), pullRequestHead: null });
    await h.t.ciTick();
    const run = await h.run(runId);
    expect(run).toMatchObject({ status: 'running', ci: { commit: second } });
    expect(rounds(daemon, runId)).toHaveLength(1);
    expect((await h.ticket()).status).toBe('in_progress');
  });

  it('refuses the commit that failed CI, without counting a round', async () => {
    const { daemon, runId, runToken, repo } = await working();
    const first = await submitted(daemon, runId, runToken);
    failAll(repo, first);
    await h.t.ciTick();
    await confirmed(daemon, runId, await round(daemon, runId));
    const refused = await h.tool(
      daemon,
      runToken,
      'ticket_submit',
      REPORT,
      cleanWorkspace({ push: { status: 'pushed', head: first } }),
    );
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: 'DOD_FAILED',
        details: [
          {
            check: 'commits_ahead',
            message: `Commit ${first} is the one CI failed for in this run: commit your fix on the branch ${BRANCH}, then submit again.`,
          },
        ],
      },
    });
    const row = await runRow(runId);
    expect(row).toMatchObject({ ciCommit: null, decision: null });
    expect(await roundEvents('run.ci_round_sent')).toHaveLength(1);
  });
});

describe('runs cancelled because the branch moved (owner answer 2)', () => {
  it('ends the run at once with ci_cancelled, not counted', async () => {
    const { daemon, runId, runToken, repo } = await working();
    const first = await submitted(daemon, runId, runToken);
    h.github.commit(repo, BRANCH, { 'src/elsewhere.ts': 'export {};\n' }, 'Pushed on GitHub');
    for (const run of h.github.runs(repo, first)) h.github.cancelRun(run);
    await h.t.ciTick();
    const run = await h.run(runId);
    expect(run).toMatchObject({ status: 'failed', failureReason: 'ci_cancelled' });
    expect(rounds(daemon, runId)).toEqual([]);
    expect(stops(daemon, runId).map((stop) => stop.payload.reason)).toEqual(['not_active']);
    const ticket = await h.ticket();
    expect(ticket).toMatchObject({ status: 'todo', attemptCount: 0 });
    const comment = ticket.timeline.findLast((entry) => entry.type === 'comment');
    expect(JSON.stringify(comment)).toMatch(
      /CI was cancelled on GitHub because the branch changed there/,
    );
  });

  it('counts a cancellation as a failure when the branch did not move', async () => {
    const { daemon, runId, runToken, repo } = await working();
    const first = await submitted(daemon, runId, runToken);
    for (const run of h.github.runs(repo, first)) h.github.cancelRun(run);
    await h.t.ciTick();
    expect(textOf(await round(daemon, runId))).toContain('- Workflow run "CI": cancelled');
  });

  it('decides nothing while the pull request cannot be read, then decides (owner answer 4)', async () => {
    const { daemon, runId, runToken, repo } = await working();
    const first = await submitted(daemon, runId, runToken);
    h.github.commit(repo, BRANCH, { 'src/elsewhere.ts': 'export {};\n' }, 'Pushed on GitHub');
    for (const run of h.github.runs(repo, first)) h.github.cancelRun(run);
    h.github.override = (request) =>
      request.method === 'GET' && /\/pulls\/\d+$/.test(request.path) ? { status: 503 } : undefined;
    await h.t.ciTick();
    expect(await h.run(runId)).toMatchObject({ status: 'running' });
    expect(rounds(daemon, runId)).toEqual([]);
    expect((await runRow(runId)).ciCheckFailure).toMatchObject({ reason: 'unreachable' });
    h.github.override = undefined;
    advance(1);
    await h.t.ciTick();
    expect(await h.run(runId)).toMatchObject({ status: 'failed', failureReason: 'ci_cancelled' });
  });
});

describe('ci_status after a round (owner addition 2)', () => {
  it("answers for the round's commit with its excerpts, asking GitHub nothing, then for the new one", async () => {
    const { daemon, runId, runToken, repo } = await working();
    const first = await submitted(daemon, runId, runToken);
    failAll(repo, first);
    await h.t.ciTick();
    await confirmed(daemon, runId, await round(daemon, runId));
    const before = h.github.requests.length;
    const status = McpCiStatus.parse(await h.ok(daemon, runToken, 'ci_status'));
    expect(h.github.requests.length).toBe(before);
    expect(status.commit).toMatchObject({ hash: first, by: 'this_run' });
    expect(status.ci?.state).toBe('failed');
    expect(status.ci?.failed_jobs[0]?.failed_steps[0]?.log).toContain('Broken link');
    const second = await submitted(daemon, runId, runToken);
    const next = McpCiStatus.parse(await h.ok(daemon, runToken, 'ci_status'));
    expect(next.commit?.hash).toBe(second);
  });

  it('reads again a log the round could not read, after the interval, and keeps it on the round (owner review, step G2b)', async () => {
    const { daemon, runId, runToken, repo } = await working();
    const first = await submitted(daemon, runId, runToken);
    failAll(repo, first);
    const logPath = /\/actions\/jobs\/\d+\/logs/;
    h.github.override = (request) => (logPath.test(request.path) ? { status: 503 } : undefined);
    await h.t.ciTick();
    const message = await round(daemon, runId);
    const retryAt = new Date(clock.getTime() + MINUTE).toISOString();
    expect(textOf(message)).toContain(
      `GitHub could not be reached for this job's log: call ci_status again after ${retryAt}.`,
    );
    await confirmed(daemon, runId, message);
    const logReads = () => h.github.requests.filter((request) => logPath.test(request.path));
    const status = async () => McpCiStatus.parse(await h.ok(daemon, runToken, 'ci_status'));

    // Within the GitHub check interval: nothing is asked again.
    const before = logReads().length;
    const early = await status();
    expect(logReads()).toHaveLength(before);
    expect(early.ci?.failed_jobs[0]?.failed_steps[0]?.log).toBeNull();
    expect(early.note).not.toMatch(/read again at most every/);

    // After it, the log is read, the excerpt given and kept on the round.
    advance(1);
    h.github.override = undefined;
    const later = await status();
    expect(later.commit).toMatchObject({ hash: first, by: 'this_run' });
    expect(later.ci?.failed_jobs[0]?.failed_steps[0]?.log).toContain('Broken link');
    expect(logReads()).toHaveLength(before + 1);
    const kept = (await runRow(runId)).ciRounds as { result: CiResult }[];
    const job = kept[0]?.result.failed_jobs[0];
    expect(job?.log.state).toBe('read');

    // Complete now: GitHub is asked nothing more.
    advance(5);
    const requests = h.github.requests.length;
    expect((await status()).ci?.failed_jobs[0]?.failed_steps[0]?.log).toContain('Broken link');
    expect(h.github.requests.length).toBe(requests);
  });

  it('after a conflict round: the kept result, never "read again at most every", GitHub asked nothing (owner review, step G2b)', async () => {
    const { daemon, runId, runToken, repo } = await working('none');
    const first = await submitted(daemon, runId, runToken);
    conflictOnMain(repo);
    advance(6);
    await h.t.ciTick();
    await h.t.ciTick();
    await confirmed(daemon, runId, await round(daemon, runId));
    const before = h.github.requests.length;
    const status = McpCiStatus.parse(await h.ok(daemon, runToken, 'ci_status'));
    expect(h.github.requests.length).toBe(before);
    expect(status.commit?.hash).toBe(first);
    expect(status.ci?.state).toBe('conflict');
    expect(status.note).not.toMatch(/read again at most every/);
    expect(status.note).toContain(
      'This result was sent back to the agent as CI round 1 of its run: it is not read again, except failed jobs or logs that could not be read then.',
    );
    expect(status.note).toContain('The pull request conflicts with main');
  });
});

describe("ci_status in the next run, after a run ended following a confirmed round (owner review, step G2b)", () => {
  it("answers with that run's latest round, not an older run's commit, asking GitHub nothing", async () => {
    const { daemon, runId, runToken, repo } = await working('queued', { maxCiFailuresPerRun: 1 });
    // The first run ends ci_failed: its wait keeps its last commit.
    const older = await submitted(daemon, runId, runToken);
    failAll(repo, older);
    await h.t.ciTick();
    await confirmed(daemon, runId, await round(daemon, runId));
    const olderLast = await submitted(daemon, runId, runToken);
    failAll(repo, olderLast);
    await h.t.ciTick();
    expect((await h.run(runId)).failureReason).toBe('ci_failed');
    await h.report(daemon, state(runId, { state: 'ended', reason: 'submitted' }));

    // The second run gets one round, confirmed, then is stopped before handing in again.
    advance(5);
    const second = await h.running(daemon);
    const sent = await submitted(daemon, second.runId, second.runToken);
    failAll(repo, sent);
    await h.t.ciTick();
    await confirmed(daemon, second.runId, await round(daemon, second.runId));
    expect((await runRow(second.runId)).ciCommit).toBeNull();
    await h.report(daemon, state(second.runId, { state: 'ended', reason: 'stopped' }));

    advance(5);
    const third = await h.running(daemon);
    const before = h.github.requests.length;
    const status = McpCiStatus.parse(await h.ok(daemon, third.runToken, 'ci_status'));
    expect(h.github.requests.length).toBe(before);
    expect(status.commit).toMatchObject({ hash: sent, by: 'earlier_run', attempt: 2 });
    expect(status.ci?.state).toBe('failed');
    expect(status.ci?.failed_jobs[0]?.failed_steps[0]?.log).toContain('Broken link');
    expect(status.note).toContain('CI round 1 of its run');
    expect(olderLast).not.toBe(sent);
  });
});

describe("the next run's first sentence (owner answer 8 and addition 4)", () => {
  async function nextStart(daemon: ScriptedDaemon, previous: string) {
    const response = await h.call('POST', '/api/projects/WEB/tickets/1/run');
    expect(response.statusCode, response.body).toBe(201);
    const start = await daemon.find<RunStart>(
      (message) => message.type === 'run.start' && message.payload.runId !== previous,
      'the next run.start',
    );
    return RunStart.parse(start).payload.initialPrompt;
  }

  it('after ci_failed: CI failed, read it with ci_status', async () => {
    const { daemon, runId, runToken, repo } = await working('queued', { maxCiFailuresPerRun: 1 });
    const first = await submitted(daemon, runId, runToken);
    failAll(repo, first);
    await h.t.ciTick();
    await confirmed(daemon, runId, await round(daemon, runId));
    const second = await submitted(daemon, runId, runToken);
    failAll(repo, second);
    await h.t.ciTick();
    await h.report(daemon, state(runId, { state: 'ended', reason: 'stopped' }));
    expect(await nextStart(daemon, runId)).toContain(
      'The previous attempt ended after CI failed on GitHub more times than its run allows: call ci_status to read that result before you start.',
    );
  });

  it('after a failure read once the wait had ended: the detail says CI failed, the next run reads it (owner review, step G2b)', async () => {
    const { daemon, runId, runToken, repo } = await working();
    const commit = await submitted(daemon, runId, runToken);
    // GitHub's answer comes only after CI wait at submission (20 minutes) passed.
    advance(21);
    failAll(repo, commit);
    await h.t.ciTick();
    const run = await h.run(runId);
    expect(run).toMatchObject({ status: 'failed', failureReason: 'ci_timeout' });
    expect(run.endDetail).toBe(
      'CI wait at submission (20 minutes) reached: CI failed on GitHub (failed: workflow run "CI"), and the result was read only after the wait had ended.',
    );
    expect(rounds(daemon, runId)).toHaveLength(0);
    expect(await h.ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });
    await h.report(daemon, state(runId, { state: 'ended', reason: 'stopped' }));
    const next = await h.running(daemon);
    const start = daemon.received.find(
      (message): message is RunStart =>
        message.type === 'run.start' && message.payload.runId === next.runId,
    );
    expect(start?.payload.initialPrompt).toContain(
      'The previous attempt ended before a failed CI result on GitHub reached it: call ci_status to read that result before you start.',
    );
    const status = McpCiStatus.parse(await h.ok(daemon, next.runToken, 'ci_status'));
    expect(status.commit).toMatchObject({ hash: commit, by: 'earlier_run' });
    expect(status.ci?.failed_jobs[0]?.failed_steps[0]?.log).toContain('Broken link');
  });

  it('after a conflict left unresolved: merge the base branch first', async () => {
    const { daemon, runId, runToken, repo } = await working('none');
    await submitted(daemon, runId, runToken);
    conflictOnMain(repo);
    advance(6);
    await h.t.ciTick();
    await h.t.ciTick();
    answer(
      daemon,
      (await round(daemon, runId)).id,
      false,
      'Downloading main from GitHub failed: x',
    );
    advance(15);
    await h.t.ciTick();
    expect((await h.run(runId)).failureReason).toBe('ci_timeout');
    await h.report(daemon, state(runId, { state: 'ended', reason: 'stopped' }));
    expect(await nextStart(daemon, runId)).toContain(
      'The pull request conflicts with main: run `git merge origin/main` and resolve the conflicts before anything else.',
    );
  });
});
