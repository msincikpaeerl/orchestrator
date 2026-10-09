import { schema } from '@orchestrator/db';
import { McpCiStatus, type DodReport } from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptedDaemon } from './daemon-client.js';
import type { FakeRepository } from './fake-github.js';
import { RunHarness, eventually, state } from './run-harness.js';

// `ci_status` (06, section 4.1; owner's answers, lot 3 step G1b) against the fake GitHub, with a
// clock the test controls: which commit it answers for, what it asks GitHub and when, and what the
// agent receives when a log cannot be read.

const h = new RunHarness();

afterEach(async () => {
  h.github.override = undefined;
  h.github.alter = undefined;
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

const TOKEN_IN_LOG = `ghp_${'x'.repeat(36)}`;
const MINUTE = 60_000;
let clock = new Date('2026-10-09T10:00:00.000Z');
const advance = (minutes: number) => {
  clock = new Date(clock.getTime() + minutes * MINUTE);
};

async function working(settings: { githubPollSeconds?: number } = {}) {
  clock = new Date('2026-10-09T10:00:00.000Z');
  await h.start({ now: () => clock, ci: 'queued', settings });
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
  return h.lastPushed ?? '';
}

async function ciStatus(daemon: ScriptedDaemon, runToken: string): Promise<McpCiStatus> {
  return McpCiStatus.parse(await h.ok(daemon, runToken, 'ci_status'));
}

/** GitHub requests made by `work`, by kind. */
async function asked(work: () => Promise<unknown>) {
  const before = h.github.requests.length;
  const logsBefore = h.github.logRequests.length;
  await work();
  const paths = h.github.requests.slice(before).map((request) => request.path);
  return {
    runs: paths.filter((path) => path.includes('/actions/runs?')).length,
    status: paths.filter((path) => /\/commits\/[^/]+\/status/.test(path)).length,
    jobs: paths.filter((path) => /\/actions\/runs\/\d+\/jobs/.test(path)).length,
    logs: paths.filter((path) => /\/actions\/jobs\/\d+\/logs/.test(path)).length,
    downloads: h.github.logRequests.length - logsBefore,
    pulls: paths.filter((path) => path.includes('/pulls')).length,
  };
}

const NOTHING = { runs: 0, status: 0, jobs: 0, logs: 0, downloads: 0, pulls: 0 };

/** Both jobs of the project's CI fail, the first with a token in its log. */
function failBoth(repo: FakeRepository, commit: string) {
  for (const run of h.github.runs(repo, commit)) {
    h.github.completeRun(run, [
      {
        job: 'docs-links',
        step: 'Check documentation links',
        log: `Broken link to docs/user/faq.md\nwith ${TOKEN_IN_LOG}`,
      },
      { job: 'ci', step: 'Check that every job passed', log: 'docs-links failed' },
    ]);
  }
}

/** The run fails on CI (G1a's interim end), then the ticket's next run starts. */
async function failedThenNextRun(settings: { githubPollSeconds?: number } = {}) {
  const first = await working(settings);
  const commit = await submitted(first.daemon, first.runId, first.runToken);
  failBoth(first.repo, commit);
  const decidedAt = clock.toISOString();
  await h.t.ciTick();
  expect((await h.run(first.runId)).failureReason).toBe('ci_failed');
  await h.report(first.daemon, state(first.runId, { state: 'ended', reason: 'submitted' }));
  advance(5);
  const next = await h.running(first.daemon);
  return { ...first, commit, decidedAt, next };
}

describe('ci_status: which commit it answers for', () => {
  it('answers for no commit before any accepted work, and says a refused submission has none', async () => {
    const { daemon, runToken } = await working();
    const before = await asked(async () => {
      const answer = await ciStatus(daemon, runToken);
      expect(answer).toMatchObject({ commit: null, pull_request: null, read_at: null, ci: null });
      expect(answer.note).toBe(
        'No work of this ticket has been accepted yet, so there is no CI result to read. CI is read after ticket_submit accepts your work.',
      );
    });
    expect(before).toEqual(NOTHING);
    const refused = await h.tool(daemon, runToken, 'ticket_submit', {
      ...REPORT,
      criteria: [REPORT.criteria[0], { ...REPORT.criteria[1], status: 'not_met' }],
    });
    expect(refused.ok).toBe(false);
    const answer = await ciStatus(daemon, runToken);
    expect(answer.commit).toBeNull();
    expect(answer.note).toMatch(
      /^Your latest submission was refused, so its commit has no CI result\. No work/,
    );
  });

  it("during the wait gives the wait's latest result, named, asking GitHub nothing", async () => {
    const { daemon, runId, runToken } = await working();
    const commit = await submitted(daemon, runId, runToken);
    advance(1);
    const checkedAt = clock.toISOString();
    await h.t.ciTick();
    advance(1);
    let answer: McpCiStatus | undefined;
    expect(
      await asked(async () => {
        answer = await ciStatus(daemon, runToken);
      }),
    ).toEqual(NOTHING);
    const ticket = await h.ticket();
    expect(answer).toMatchObject({
      commit: {
        hash: commit,
        by: 'this_run',
        attempt: 1,
        submitted_at: '2026-10-09T10:00:00.000Z',
      },
      pull_request: { number: ticket.pullRequest.opened?.number, head: commit },
      read_at: checkedAt,
      ci: { state: 'pending', failed_jobs: [], logs_not_read: { count: 0, jobs: [] } },
    });
    expect(answer?.ci?.checks.map((check) => [check.name, check.state])).toEqual([
      ['CI', 'pending'],
    ]);
    expect(answer?.note).toBe(
      `This is the CI result of commit ${commit}, which your run handed in on 2026-10-09T10:00:00.000Z. This result was read on GitHub on ${checkedAt}. It is not finished: it is read again at most every 60 seconds.`,
    );
  });

  it('says when the pull request is not opened yet, with no result', async () => {
    const { daemon, runId, runToken } = await working();
    h.github.override = (request) =>
      request.method === 'POST' && request.path.endsWith('/pulls') ? { status: 503 } : undefined;
    await h.ok(daemon, runToken, 'ticket_submit', REPORT);
    await h.report(daemon, state(runId, { state: 'waiting_ci' }));
    await eventually('the pull request failed to open', async () => {
      expect((await h.ticket()).pullRequest.failure).toBeTruthy();
    });
    const answer = await ciStatus(daemon, runToken);
    expect(answer).toMatchObject({ commit: { hash: h.lastPushed }, pull_request: null, ci: null });
    expect(answer.note).toMatch(/The pull request is not opened yet, so CI has not started\.$/);
  });
});

describe('ci_status: a failed result', () => {
  it("gives an earlier run's failure, each failed step with its own masked excerpt, read once", async () => {
    const { daemon, commit, decidedAt, next } = await failedThenNextRun();
    let answer: McpCiStatus | undefined;
    const first = await asked(async () => {
      answer = await ciStatus(daemon, next.runToken);
    });
    // The result is finished: only the jobs of the failed workflow run and the two logs.
    expect(first).toEqual({ ...NOTHING, jobs: 1, logs: 2, downloads: 2 });
    expect(answer?.commit).toMatchObject({ hash: commit, by: 'earlier_run', attempt: 1 });
    expect(answer?.read_at).toBe(decidedAt);
    expect(answer?.note).toBe(
      `This is the CI result of commit ${commit}, which an earlier run of this ticket (attempt 1) handed in on 2026-10-09T10:00:00.000Z. Work done since then, yours included, is not part of it. This result was read on GitHub on ${decidedAt}. It is finished, so it is not read again. CI failed: each failed job is listed with its failed steps, each with its part of the job's log.`,
    );
    const steps = answer?.ci?.failed_jobs.map((job) => [job.job, job.failed_steps]);
    expect(steps?.map(([job]) => job)).toEqual(['docs-links', 'ci']);
    const docs = answer?.ci?.failed_jobs[0]?.failed_steps[0];
    expect(docs?.step).toBe('Check documentation links');
    expect(docs?.about).toBe('Step "Check documentation links": its own part of the job\'s log.');
    expect(docs?.log).toContain('Broken link to docs/user/faq.md\nwith [hidden]');
    expect(docs?.log).toMatch(/##\[error\]Process completed with exit code 1\.$/);
    expect(JSON.stringify(answer)).not.toContain(TOKEN_IN_LOG);
    // Asked again, later: nothing more on GitHub.
    advance(10);
    expect(await asked(() => ciStatus(daemon, next.runToken))).toEqual(NOTHING);
  });

  it('tells what a log GitHub no longer has or could not give is, and reads again only what may come', async () => {
    const { daemon, next } = await failedThenNextRun();
    const jobs = new Map<string, number>();
    h.github.alter = (request, reply) => {
      const listed = /\/actions\/runs\/\d+\/jobs/.test(request.path);
      if (listed) {
        for (const job of (reply.body as { jobs: { id: number; name: string }[] }).jobs) {
          jobs.set(job.name, job.id);
        }
      }
      const log = /\/actions\/jobs\/(\d+)\/logs/.exec(request.path)?.[1];
      if (log === String(jobs.get('docs-links'))) return { status: 410, body: { message: 'Gone' } };
      if (log === String(jobs.get('ci'))) return { status: 503 };
      return reply;
    };
    const answer = await ciStatus(daemon, next.runToken);
    expect(answer.ci?.failed_jobs.map((job) => job.failed_steps[0]?.about)).toEqual([
      "GitHub no longer has this job's log (it expired or was deleted).",
      `GitHub could not be reached for this job's log: call ci_status again after ${new Date(clock.getTime() + MINUTE).toISOString()}.`,
    ]);
    // Within the interval, nothing; after it, the jobs again and only the log that may come.
    expect(await asked(() => ciStatus(daemon, next.runToken))).toEqual(NOTHING);
    advance(1);
    h.github.alter = undefined;
    expect(await asked(() => ciStatus(daemon, next.runToken))).toEqual({
      ...NOTHING,
      jobs: 1,
      logs: 1,
      downloads: 1,
    });
    const after = await ciStatus(daemon, next.runToken);
    expect(after.ci?.failed_jobs.map((job) => job.failed_steps[0]?.log === null)).toEqual([
      true,
      false,
    ]);
  });

  it('asks GitHub nothing while its request limit holds, and says until when', async () => {
    const { daemon, next } = await failedThenNextRun();
    const reset = Math.floor(clock.getTime() / 1000) + 600;
    h.github.override = (request) =>
      /\/actions\/runs\/\d+\/jobs/.test(request.path)
        ? {
            status: 403,
            body: { message: 'API rate limit exceeded' },
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
          }
        : undefined;
    const limited = await ciStatus(daemon, next.runToken);
    expect(limited.ci?.failed_jobs).toEqual([]);
    expect(limited.note).toContain('GitHub could not be read just now (API rate limit exceeded)');
    h.github.override = undefined;
    advance(5);
    let held: McpCiStatus | undefined;
    expect(
      await asked(async () => {
        held = await ciStatus(daemon, next.runToken);
      }),
    ).toEqual(NOTHING);
    expect(held?.note).toContain(
      `GitHub's request limit is reached: nothing is asked of GitHub before ${new Date(reset * 1000).toISOString()}.`,
    );
    advance(6);
    const read = await ciStatus(daemon, next.runToken);
    expect(read.ci?.failed_jobs.map((job) => job.job)).toEqual(['docs-links', 'ci']);
  });
});

describe('ci_status: a request limit without a time (owner addition, step G2b)', () => {
  /** GitHub's limit on the jobs, without `retry-after` or `x-ratelimit-reset`. */
  function limitedWithoutTime() {
    h.github.override = (request) =>
      /\/actions\/runs\/\d+\/jobs/.test(request.path)
        ? {
            status: 429,
            body: { message: 'You have exceeded a secondary rate limit' },
            headers: { 'x-ratelimit-remaining': '0' },
          }
        : undefined;
  }

  for (const [interval, heldMinutes] of [
    [60, 1],
    [300, 5],
  ] as const) {
    it(`holds for the longer of one minute and the check interval (${String(interval)} s), and says until when`, async () => {
      const { daemon, next } = await failedThenNextRun({ githubPollSeconds: interval });
      limitedWithoutTime();
      const until = new Date(clock.getTime() + heldMinutes * MINUTE).toISOString();
      const limited = await ciStatus(daemon, next.runToken);
      expect(limited.note).toContain(
        'GitHub could not be read just now (You have exceeded a secondary rate limit)',
      );
      h.github.override = undefined;
      advance(heldMinutes - 0.5);
      let held: McpCiStatus | undefined;
      expect(
        await asked(async () => {
          held = await ciStatus(daemon, next.runToken);
        }),
      ).toEqual(NOTHING);
      expect(held?.note).toContain(
        `GitHub's request limit is reached: nothing is asked of GitHub before ${until}.`,
      );
      advance(0.5);
      const read = await ciStatus(daemon, next.runToken);
      expect(read.ci?.failed_jobs.map((job) => job.job)).toEqual(['docs-links', 'ci']);
    });
  }
});

describe('ci_status: an unfinished result of an ended run', () => {
  /** The wait ends without a result (`ci_timeout`), then the ticket's next run starts. */
  async function timedOutThenNextRun() {
    const first = await working();
    const commit = await submitted(first.daemon, first.runId, first.runToken);
    advance(21);
    await h.t.ciTick();
    expect((await h.run(first.runId)).failureReason).toBe('ci_timeout');
    await h.report(first.daemon, state(first.runId, { state: 'ended', reason: 'submitted' }));
    const next = await h.running(first.daemon);
    return { ...first, commit, next };
  }

  it('reads it at most once per GitHub check interval, calls at the same moment sharing one read', async () => {
    const { daemon, repo, commit, next } = await timedOutThenNextRun();
    advance(1);
    let answers: McpCiStatus[] = [];
    expect(
      await asked(async () => {
        answers = await Promise.all([
          ciStatus(daemon, next.runToken),
          ciStatus(daemon, next.runToken),
        ]);
      }),
    ).toEqual({ ...NOTHING, runs: 1, status: 1 });
    expect(answers.map((answer) => answer.read_at)).toEqual([
      clock.toISOString(),
      clock.toISOString(),
    ]);
    expect(answers[0]?.ci?.state).toBe('pending');
    expect(await asked(() => ciStatus(daemon, next.runToken))).toEqual(NOTHING);
    // CI passes on GitHub; the next read, after the interval, finds it finished for good.
    for (const run of h.github.runs(repo, commit)) h.github.completeRun(run);
    advance(1);
    const passed = await ciStatus(daemon, next.runToken);
    expect(passed.ci?.state).toBe('passed');
    expect(passed.note).toContain('It is finished, so it is not read again. CI passed.');
    advance(30);
    expect(await asked(() => ciStatus(daemon, next.runToken))).toEqual(NOTHING);
  });

  it('asks nothing while the wait for CI met the request limit', async () => {
    const { daemon, runId, next } = await timedOutThenNextRun();
    advance(1);
    const retryAt = new Date(clock.getTime() + 10 * MINUTE).toISOString();
    // As the wait's last check left it: GitHub's limit until `retryAt`.
    await h.t.db
      .update(schema.runs)
      .set({
        ciCheckFailure: {
          reason: 'rate_limited',
          message: 'API rate limit exceeded',
          fields: [],
          since: clock.toISOString(),
          at: clock.toISOString(),
          retryAt,
        },
      })
      .where(eq(schema.runs.id, runId));
    let answer: McpCiStatus | undefined;
    expect(
      await asked(async () => {
        answer = await ciStatus(daemon, next.runToken);
      }),
    ).toEqual(NOTHING);
    expect(answer?.note).toContain(`nothing is asked of GitHub before ${retryAt}.`);
  });

  it('does not ask GitHub again within one check interval after a failed read (owner addition, step G2b)', async () => {
    const { daemon, next } = await timedOutThenNextRun();
    advance(1);
    const failedAt = clock.toISOString();
    h.github.override = (request) =>
      request.path.includes('/actions/runs?') ? { status: 503 } : undefined;
    expect(await asked(() => ciStatus(daemon, next.runToken))).toMatchObject({ runs: 1 });
    advance(0.5);
    let again: McpCiStatus | undefined;
    expect(
      await asked(async () => {
        again = await ciStatus(daemon, next.runToken);
      }),
    ).toEqual(NOTHING);
    expect(again?.note).toContain(
      'GitHub could not be read just now (GitHub could not be reached, or answered with a server error)',
    );
    expect(again?.read_at).not.toBe(failedAt);
    h.github.override = undefined;
    advance(0.5);
    expect(await asked(() => ciStatus(daemon, next.runToken))).toEqual({
      ...NOTHING,
      runs: 1,
      status: 1,
    });
  });
});
