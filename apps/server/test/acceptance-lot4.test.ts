import { spawnSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DaemonProcess } from '@orchestrator/daemon/testing';
import { AccountListResponse, NeedsYouResponse, QueueResponse } from '@orchestrator/protocol';
import { schema } from '@orchestrator/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BRANCH,
  SUMMARY,
  TIMEOUT,
  acceptanceHooks,
  bakery,
  clock,
  commit,
  daemons,
  endedSucceeded,
  enrolAndStart,
  fake,
  h,
  home,
  json,
  machine,
  messages,
  run,
  runNow,
  sessionAlive,
  startDaemon,
  startHarness,
  stopDaemon,
  submit,
  ticket,
  tmux,
  until,
} from './acceptance-harness.js';

// Lot 4's acceptance scenarios (lot 4 plan, steps D2b, E, G and J): the scheduler against the real
// daemon, on the shared harness of `acceptance-harness.ts`, apart from `acceptance.test.ts` so the
// CI shards can balance them (owner, review of lot 4 step J).

acceptanceHooks();

// The lot 4 acceptance scenario of step D2b: the scheduler's loop (one `schedulerTick()` per
// pass) against the real daemon, a failure its machine caused, and what stops it looping.

describe('lot 4 acceptance scenario, real server and daemon, fake GitHub', () => {
  beforeEach(async () => {
    await startHarness({
      gitOnFakeGitHub: true,
      now: () => new Date(Date.now() + clock.ahead),
    });
  });

  const tick = async () =>
    (await h.t.schedulerTick()).started.map((start) => `${start.kind} ${start.ticket}`);
  /** The daemon stopped and started again a minute later, its `hello` reporting `claude`. */
  async function restart(daemon: DaemonProcess, machineId: string): Promise<DaemonProcess> {
    await stopDaemon(daemon);
    await until('the machine offline', async () => !(await machine(machineId)).online);
    clock.ahead += 60_000;
    const next = startDaemon();
    await until('the machine online', async () => (await machine(machineId)).online);
    return next;
  }
  const latestRun = async () => {
    const runs = await h.t.db.select().from(schema.runs);
    const last = runs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!last) throw new Error('no run');
    return last;
  };
  const items = async () =>
    (await json((v) => NeedsYouResponse.parse(v), 'GET', '/api/needs-you')).items.filter(
      (item) => item.type === 'machine_failures',
    );

  it(
    'G: Claude Code too old at a start, twice across a daemon restart: never in a loop, the item, then Run now',
    async () => {
      // Its `hello` reports a supported Claude Code; the one found at the start is too old.
      const { machineId } = await enrolAndStart();
      await h.createTicket();
      await fake.play({ version: '2.1.100 (Claude Code)' });

      async function tooOld() {
        expect(await tick()).toEqual(['implement WEB-1']);
        const started = await latestRun();
        await until('the run failed', async () => (await run(started.id)).status === 'failed');
        expect((await run(started.id)).failureReason).toBe('claude_code_unsupported');
      }

      // First failure: the machine is unusable and left out; the loop starts nothing.
      await tooOld();
      for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
      expect(await ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });

      // Restarted, it connects again with a supported version: released, the loop starts it once.
      await fake.play({});
      let daemon = daemons[0];
      if (!daemon) throw new Error('no daemon');
      daemon = await restart(daemon, machineId);
      await fake.play({ version: '2.1.100 (Claude Code)' });
      await tooOld();

      // Second failure in a row on Laptop (Machine failures before asking you: 2): the item, and
      // nothing starts by itself, even after the machine connects again.
      expect(await items()).toMatchObject([
        { ticket: { number: 1 }, machine: { name: 'Laptop' }, limit: 2, failures: [{}, {}] },
      ]);
      await fake.play({});
      await restart(daemon, machineId);
      for (let pass = 0; pass < 3; pass += 1) expect(await tick()).toEqual([]);
      expect(await messages()).toEqual([]);

      // The owner's Run now starts it and removes the item.
      await fake.play({ turns: [{ steps: [{ do: 'text', text: 'Reading the ticket.' }] }] });
      const started = await runNow();
      expect(started.machine.id).toBe(machineId);
      expect(await items()).toEqual([]);
      await h.call('POST', `/api/runs/${started.id}/stop`);
      await until('the session closed', async () => !(await run(started.id)).sessionAlive);
    },
    TIMEOUT,
  );
});

// Shared by step E's tests and scenario I: a limit reached, the run paused, its resumes.

/** The scenario of a turn reaching a limit: detected with no reset time, or suspected. */
const weeklyLimit = {
  turns: [
    {
      steps: [{ do: 'text' as const, text: 'Working on the contact form.' }],
      end: {
        kind: 'stopFailure' as const,
        error: 'rate_limit',
        message: "You've hit your weekly limit",
      },
    },
  ],
};

const finishing = {
  turns: [{ steps: [commit('contact.html', 'Add the contact form'), submit] }],
};

async function pausedOn(runId: string, reason: 'usage_limit' | 'suspected_usage_limit') {
  await until('the run paused', async () => (await run(runId)).status === 'paused_quota');
  expect((await run(runId)).pauseReason).toBe(reason);
  await until('the session closed', () => Promise.resolve(!sessionAlive(runId)));
}

async function accountRow() {
  const [row] = await h.t.db.select().from(schema.claudeAccounts);
  if (!row) throw new Error('no account');
  return row;
}
/** Submitted: CI passes on the fake GitHub, the run ends and the ticket is in review. */
async function finishes(runId: string) {
  await until('the run succeeded and ended', async () => {
    await h.t.ciTick();
    return endedSucceeded(runId);
  });
  expect(await ticket()).toMatchObject({ status: 'in_review', attemptCount: 0 });
}
/** The `--resume` launches of the fake, each with the session of the first one. */
async function resumes(): Promise<number> {
  const starts = (await fake.log()).flatMap((entry) =>
    entry.event === 'start' ? [entry.args] : [],
  );
  return starts.filter((args) => args.includes('--resume')).length;
}

describe('lot 4 step E: usage limits resumed by the scheduler, real server and daemon', () => {
  beforeEach(async () => {
    await startHarness({
      gitOnFakeGitHub: true,
      now: () => new Date(Date.now() + clock.ahead),
    });
  });

  const MINUTE = 60_000;
  const tick = async () =>
    (await h.t.schedulerTick()).started.map((start) => `${start.kind} ${start.ticket}`);
  const now = () => Date.now() + clock.ahead;
  const overloaded = {
    turns: [
      {
        steps: [{ do: 'text' as const, text: 'Working on the contact form.' }],
        end: {
          kind: 'stopFailure' as const,
          error: 'overloaded',
          message: 'API Error: Overloaded',
        },
      },
    ],
  };

  async function runRow(id: string) {
    const [row] = await h.t.db.select().from(schema.runs).where(eq(schema.runs.id, id));
    if (!row) throw new Error('no run');
    return row;
  }
  /** The paused run's item in Needs you: why the scheduler does not resume it yet. */
  async function pausedItem() {
    const item = (await json((v) => NeedsYouResponse.parse(v), 'GET', '/api/needs-you')).items.find(
      (each) => each.type === 'run_paused',
    );
    if (item?.type !== 'run_paused') throw new Error('no paused run in Needs you');
    return item;
  }
  /** The payloads of the events of `type`, oldest first. */
  const payloads = async (type: string) =>
    (await h.events(type)).map((event) => event.payload as Record<string, unknown>);
  const minutesUntil = (at: Date | string | null) =>
    Math.round((new Date(at ?? 0).getTime() - now()) / MINUTE);

  it(
    'a detected limit with a reset time: the scheduler resumes the run at that time, on its machine, and it finishes',
    async () => {
      // The status line's window full for 8 seconds gives the reset time.
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'text', text: 'Starting on the contact form.' },
              { do: 'statusLine', fullForSeconds: 8 },
            ],
            end: {
              kind: 'stopFailure',
              error: 'rate_limit',
              message: "You've hit your session limit · resets 3:45pm",
            },
          },
        ],
      });
      const { machineId } = await enrolAndStart();
      await h.createTicket();
      expect(await tick()).toEqual(['implement WEB-1']);
      const [started] = await h.t.db.select().from(schema.runs);
      if (!started) throw new Error('no run');
      await pausedOn(started.id, 'usage_limit');
      const limited = await accountRow();
      expect(limited).toMatchObject({ state: 'limited', limitedUntilEstimated: false });

      // Until the reset time: nothing, and Needs you says when it resumes.
      expect(await tick()).toEqual([]);
      expect((await pausedItem()).resume).toMatchObject({
        reason: 'account_limited',
        until: limited.limitedUntil?.toISOString(),
      });

      // At the reset time, the same session continues by itself and the agent finishes.
      await fake.play(finishing);
      clock.ahead = (limited.limitedUntil?.getTime() ?? 0) - Date.now() + 1000;
      expect(await tick()).toEqual(['resume WEB-1']);
      expect((await run(started.id)).machine.id).toBe(machineId);
      await finishes(started.id);
      expect(await resumes()).toBe(1);
      expect(await messages()).toHaveLength(2);
      const resumed = (await h.events('run.status_changed')).find(
        (event) => (event.payload as Record<string, unknown>).cause === 'scheduler_resume',
      );
      expect(resumed).toMatchObject({
        actor: 'system',
        payload: { from: 'paused_quota', to: 'dispatched' },
      });
    },
    TIMEOUT,
  );

  it(
    'a limit with no reset time: resumed after 1 hour, then 2, then capped at Longest quota wait, with no failed attempt',
    async () => {
      const set = await h.call('PUT', '/api/settings/quotaFallbackMaxDelayMinutes', {
        value: 180,
      });
      expect(set.statusCode, set.body).toBe(200);
      await fake.play(weeklyLimit);
      await enrolAndStart();
      await h.createTicket();
      expect(await tick()).toEqual(['implement WEB-1']);
      const [started] = await h.t.db.select().from(schema.runs);
      if (!started) throw new Error('no run');

      // Each resume reaches the limit again: the account's wait doubles, up to 180 minutes.
      for (const [index, wait] of [60, 120, 180, 180].entries()) {
        await pausedOn(started.id, 'usage_limit');
        await until('the run paused again', async () => (await resumes()) === index);
        const limited = await accountRow();
        expect(limited).toMatchObject({ limitedUntilEstimated: true, quotaWaitMinutes: wait });
        expect(minutesUntil(limited.limitedUntil)).toBe(wait);
        clock.ahead += (wait - 1) * MINUTE;
        expect(await tick()).toEqual([]);
        clock.ahead += 2 * MINUTE;
        if (wait === 180 && index === 3) await fake.play(finishing);
        expect(await tick()).toEqual(['resume WEB-1']);
      }
      await finishes(started.id);
      expect(await resumes()).toBe(4);
      expect((await payloads('account.limited')).map((p) => p.fallbackMinutes)).toEqual([
        60, 120, 180, 180,
      ]);
      // The resumed run ended its turn without a limit: the next wait is 1 hour again.
      expect((await accountRow()).quotaWaitMinutes).toBeNull();
      expect(await h.events('account.quota_wait_restarted')).toMatchObject([
        { payload: { minutes: 180 } },
      ]);
    },
    TIMEOUT,
  );

  it(
    'a suspected limit: the account unchanged, resumed after 1 hour, then 2, then 1 again once a turn ended without a limit',
    async () => {
      await fake.play(overloaded);
      await enrolAndStart();
      await h.createTicket();
      expect(await tick()).toEqual(['implement WEB-1']);
      const [started] = await h.t.db.select().from(schema.runs);
      if (!started) throw new Error('no run');

      async function waits(minutes: number) {
        await pausedOn(started?.id ?? '', 'suspected_usage_limit');
        expect(await accountRow()).toMatchObject({ state: 'available', limitedUntil: null });
        const row = await runRow(started?.id ?? '');
        expect(row.quotaWaitMinutes).toBe(minutes);
        expect(minutesUntil(row.quotaResumeAt)).toBe(minutes);
        expect((await pausedItem()).resume).toMatchObject({ reason: 'quota_wait', minutes });
        clock.ahead += (minutes - 1) * MINUTE;
        expect(await tick()).toEqual([]);
        clock.ahead += 2 * MINUTE;
      }

      await waits(60);
      expect(await tick()).toEqual(['resume WEB-1']);
      await until('the second pause', async () => (await resumes()) === 1);
      await waits(120);
      // This resume works a turn without a limit (the agent stops; a reminder follows), then
      // reaches a suspected limit again: the wait starts afresh.
      await fake.play({
        turns: [
          { steps: [{ do: 'text', text: 'Looked at the form; continuing.' }] },
          ...overloaded.turns,
        ],
      });
      expect(await tick()).toEqual(['resume WEB-1']);
      await until('the third pause', async () => (await resumes()) === 2);
      await waits(60);
      await fake.play(finishing);
      expect(await tick()).toEqual(['resume WEB-1']);
      await finishes(started.id);
      const pauses = (await payloads('run.status_changed')).filter((p) => p.to === 'paused_quota');
      expect(pauses.map((p) => p.quotaWaitMinutes)).toEqual([60, 120, 60]);
      expect(await h.events('account.limited')).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'an account limited while two runs are paused: both resumed in order, within its maximum',
    async () => {
      await fake.play(weeklyLimit);
      const { account } = await enrolAndStart();
      const raised = await h.call('PATCH', `/api/accounts/${account.id}`, { maxConcurrentRuns: 2 });
      expect(raised.statusCode, raised.body).toBe(200);
      await h.createTicket();
      await h.createTicket({ title: 'Opening hours', priority: 'high' });
      expect(await tick()).toEqual(['implement WEB-2', 'implement WEB-1']);
      const rows = await h.t.db.select().from(schema.runs);
      const second = rows.find((row) => row.branchName?.startsWith('t/2-'));
      const first = rows.find((row) => row.branchName?.startsWith('t/1-'));
      if (!first || !second) throw new Error('two runs expected');
      await pausedOn(first.id, 'usage_limit');
      await pausedOn(second.id, 'usage_limit');
      // The same limit reported twice waits once, not double.
      expect(await accountRow()).toMatchObject({ quotaWaitMinutes: 60 });
      expect(await h.events('account.limited')).toHaveLength(1);

      // One place now: the high-priority ticket's run first, the other once a place is free.
      const lowered = await h.call('PATCH', `/api/accounts/${account.id}`, {
        maxConcurrentRuns: 1,
      });
      expect(lowered.statusCode, lowered.body).toBe(200);
      await fake.play({ turns: [{ steps: [{ do: 'text', text: 'Continuing.' }] }] }, second.id);
      clock.ahead += 61 * MINUTE;
      expect(await tick()).toEqual(['resume WEB-2']);
      expect(await tick()).toEqual([]);
      expect((await run(first.id)).status).toBe('paused_quota');
      // WEB-2 reaches a suspected limit: its place is free, WEB-1's run resumes.
      await fake.play(overloaded, second.id);
      await fake.play(finishing, first.id);
      await until(
        'WEB-2 paused again',
        async () => (await run(second.id)).status === 'paused_quota',
      );
      expect(await tick()).toEqual(['resume WEB-1']);
      await finishes(first.id);
      expect((await ticket(2)).attemptCount).toBe(0);
      await h.call('POST', `/api/runs/${second.id}/stop`);
    },
    TIMEOUT,
  );
});

describe('lot 4 step G: a machine offline during a run, real server and daemon', () => {
  beforeEach(async () => {
    await startHarness({
      gitOnFakeGitHub: true,
      now: () => new Date(Date.now() + clock.ahead),
    });
  });

  const MINUTE = 60_000;
  const tick = async () =>
    (await h.t.schedulerTick()).started.map((start) => `${start.kind} ${start.ticket}`);
  /** The agent commits, says it got there, then works on for a minute (it is stopped first). */
  const committing = {
    turns: [
      {
        steps: [
          commit('contact.html', 'Add the contact form'),
          { do: 'bash' as const, command: 'touch working' },
          { do: 'sleep' as const, ms: 60_000 },
        ],
      },
    ],
  };
  const reviewing = {
    turns: [
      {
        steps: [
          { do: 'text' as const, text: 'Reviewing the contact form.' },
          { do: 'sleep' as const, ms: 60_000 },
        ],
      },
    ],
  };
  const working = (runId: string) =>
    until('the agent at work', async () =>
      (await readdir(join(home.paths.home, 'worktrees', runId)).catch((): string[] => [])).includes(
        'working',
      ),
    );
  const theDaemon = () => {
    const daemon = daemons[0];
    if (!daemon) throw new Error('no daemon');
    return daemon;
  };
  async function offline(machineId: string) {
    await stopDaemon(theDaemon());
    await until('the machine offline', async () => !(await machine(machineId)).online);
  }
  async function online(machineId: string) {
    startDaemon();
    await until('the machine online', async () => (await machine(machineId)).online);
  }
  const latestRun = async () => {
    const runs = await h.t.db.select().from(schema.runs);
    const last = runs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!last) throw new Error('no run');
    return last;
  };

  it(
    'back before Runs of an offline machine fail after, the run goes on; back after it, failed, its session stopped and its end kept',
    async () => {
      await fake.play(committing);
      const { machineId } = await enrolAndStart();
      await h.createTicket();
      const started = await runNow();
      await working(started.id);

      // Offline 9 minutes: nothing fails, and the run goes on with the session it kept.
      await offline(machineId);
      clock.ahead += 9 * MINUTE;
      expect(await tick()).toEqual([]);
      await online(machineId);
      expect((await run(started.id)).status).toBe('running');
      expect(sessionAlive(started.id)).toBe(true);

      // Offline 11 minutes: failed at the scheduler's check, not counted.
      await offline(machineId);
      clock.ahead += 11 * MINUTE;
      expect(await tick()).toEqual([]);
      expect(await run(started.id)).toMatchObject({
        status: 'failed',
        failureReason: 'machine_offline',
      });
      expect(await ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });
      expect(sessionAlive(started.id)).toBe(true);

      // Back: the session is stopped (not active), its end push and branch report are kept.
      await online(machineId);
      await until('the session stopped', () => Promise.resolve(!sessionAlive(started.id)));
      await until(
        'the end reported',
        async () => ((await run(started.id)).branch?.head ?? null) !== null,
      );
      expect(await run(started.id)).toMatchObject({
        status: 'failed',
        failureReason: 'machine_offline',
        branch: { commits: [{ subject: 'Add the contact form' }] },
        push: { result: { status: 'pushed' } },
      });
      expect(h.github.branches(h.github.repository('octo-owner', 'bakery')).has(BRANCH)).toBe(true);

      // Laptop is released by its reconnection: the ticket starts again there.
      await fake.play({ turns: [{ steps: [{ do: 'text', text: 'Reading the ticket.' }] }] });
      expect(await tick()).toEqual(['implement WEB-1']);
      const next = await latestRun();
      expect(next.machineId).toBe(machineId);
      await h.call('POST', `/api/runs/${next.id}/stop`);
      await until('the session closed', async () => !(await run(next.id)).sessionAlive);
    },
    TIMEOUT,
  );

  it(
    'a daemon restarted without a run it had: the run fails at its hello, and starts again there',
    async () => {
      await fake.play(committing);
      const { machineId } = await enrolAndStart();
      await h.createTicket();
      const started = await runNow();
      await working(started.id);

      // The daemon lost the run: its session, its record and its worktree are gone. (A record
      // lost alone, its worktree left, would make the next run's preparation fail: the daemon
      // leaves a worktree it has no record of as it is.)
      await offline(machineId);
      tmux('kill-session', '-t', `orch-${started.id}`);
      await rm(join(home.paths.home, 'runs', started.id), { recursive: true, force: true });
      const bare = join(home.paths.home, 'repos', 'octo-owner', 'bakery.git');
      const worktree = join(home.paths.home, 'worktrees', started.id);
      const removed = spawnSync(
        join(home.bin, 'git'),
        ['-C', bare, 'worktree', 'remove', '--force', worktree],
        { env: home.env },
      );
      expect(removed.status, removed.stderr.toString()).toBe(0);
      clock.ahead += MINUTE;
      await fake.play({ turns: [{ steps: [{ do: 'text', text: 'Reading the ticket.' }] }] });
      await online(machineId);
      expect(await run(started.id)).toMatchObject({
        status: 'failed',
        failureReason: 'machine_offline',
      });
      expect(await ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });
      expect(await tick()).toEqual(['implement WEB-1']);
      const next = await latestRun();
      await until('the next run running', async () => (await run(next.id)).status === 'running');
      await h.call('POST', `/api/runs/${next.id}/stop`);
      await until('the session closed', async () => !(await run(next.id)).sessionAlive);
    },
    TIMEOUT,
  );

  it(
    'a review run on a machine offline too long: the ticket stays in review, "Review did not finish"',
    async () => {
      await fake.play({
        turns: [{ steps: [commit('contact.html', 'Add the contact form'), submit] }],
      });
      const { machineId } = await enrolAndStart();
      await h.createTicket();
      const built = await runNow();
      await until('the run succeeded and ended', async () => {
        await h.t.ciTick();
        return endedSucceeded(built.id);
      });
      await fake.play(reviewing);
      expect(await tick()).toEqual(['review WEB-1']);
      const review = await latestRun();
      await until('the review running', async () => (await run(review.id)).status === 'running');

      await offline(machineId);
      clock.ahead += 11 * MINUTE;
      expect(await tick()).toEqual([]);
      expect(await run(review.id)).toMatchObject({
        status: 'failed',
        failureReason: 'machine_offline',
      });
      expect(await ticket()).toMatchObject({ status: 'in_review', attemptCount: 0 });
      const items = (await json((v) => NeedsYouResponse.parse(v), 'GET', '/api/needs-you')).items;
      expect(items.map((item) => item.type)).toContain('review_not_finished');

      await online(machineId);
      await until('the session stopped', () => Promise.resolve(!sessionAlive(review.id)));
      expect((await run(review.id)).status).toBe('failed');
      expect(await tick()).toEqual([]);
    },
    TIMEOUT,
  );
});

// The lot 4 acceptance scenarios (lot 4 plan, step J): the night the owner leaves the system on,
// as in step L, with the real server, daemon, tmux, the fake `claude` and the fake GitHub. Only
// the merges are the owner's; the scheduler starts everything else, one `schedulerTick()` standing
// for each of its checks, on the server's clock moved by the test.

describe('lot 4 acceptance scenarios, the scheduler overnight, real server and daemon', () => {
  beforeEach(async () => {
    await startHarness({
      gitOnFakeGitHub: true,
      now: () => new Date(Date.now() + clock.ahead),
    });
  });

  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  /** What each session costs, by the fake's status line: the run's estimated usage. */
  const COST_USD = 0.4;
  const tick = async () =>
    (await h.t.schedulerTick()).started.map((start) => `${start.kind} ${start.ticket}`);
  const now = () => Date.now() + clock.ahead;
  /** The server's clock set to `at`. */
  const clockAt = (at: number) => {
    clock.ahead = at - Date.now();
  };
  const latestRun = async () => {
    const runs = await h.t.db.select().from(schema.runs);
    const last = runs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!last) throw new Error('no run');
    return last;
  };
  const queue = () => json((v) => QueueResponse.parse(v), 'GET', '/api/queue');
  /** Each candidate as `kind WEB-n: reason`, in the queue's order. */
  async function queueLines(): Promise<string[]> {
    return (await queue()).candidates.map(
      (candidate) =>
        `${candidate.kind} WEB-${String(candidate.ticket?.number)}: ${candidate.reason?.reason ?? `starts on ${candidate.machine?.name ?? '?'}`}`,
    );
  }
  async function theAccount() {
    const listed = await json((v) => AccountListResponse.parse(v), 'GET', '/api/accounts');
    const [account] = listed.accounts;
    if (!account) throw new Error('no account');
    return account;
  }
  /** The sessions the fake was asked to start, resumes included. */
  async function sessions(): Promise<number> {
    return (await fake.log()).filter((entry) => entry.event === 'start').length;
  }
  const cost = { do: 'statusLine' as const, input: { cost: { total_cost_usd: COST_USD } } };

  it(
    'H: three tickets over a night, one high priority, one blocked: nothing before the window, each implemented, reviewed by itself and done in order after the merges',
    async () => {
      // The evening: 19:00 in the Orchestrator's time zone, the account's window from 20:00 to
      // 06:00 every day, a daily budget in estimated usage as a safety net (step L, 4).
      let evening = new Date(now());
      evening.setUTCHours(19, 0, 0, 0);
      while (evening.getTime() < Date.now() + HOUR) {
        evening = new Date(evening.getTime() + 24 * HOUR);
      }
      clockAt(evening.getTime());
      const zone = await h.call('PUT', '/api/time-zone', { timeZone: 'UTC' });
      expect(zone.statusCode, zone.body).toBe(200);
      const { machineId, account } = await enrolAndStart();
      const everyDay = [
        'monday',
        'tuesday',
        'wednesday',
        'thursday',
        'friday',
        'saturday',
        'sunday',
      ];
      const budget = { kind: 'estimated_usage', usd: 2 };
      const saved = await h.call('PATCH', `/api/accounts/${account.id}`, {
        schedule: [{ days: everyDay, start: '20:00', end: '06:00' }],
        dailyBudget: budget,
      });
      expect(saved.statusCode, saved.body).toBe(200);
      await h.createTicket({ title: 'Add a line about the scheduler to README.md' });
      await h.createTicket({ title: 'Add a CONTRIBUTING.md file', priority: 'high' });
      await h.createTicket({ title: 'Link CONTRIBUTING.md from README.md', blockedBy: [1] });
      const windowOpens = evening.getTime() + HOUR;

      // Before the window (step L, 4): WEB-2 first, WEB-1 next, both waiting for the window at
      // 20:00; WEB-3 blocked by WEB-1. The account's line says why it starts nothing.
      const before = await queue();
      expect(before.accounts).toMatchObject([
        {
          unavailable: {
            why: 'account_outside_window',
            next: new Date(windowOpens).toISOString(),
          },
          active: 0,
          maxConcurrentRuns: 1,
        },
      ]);
      const outside = {
        reason: 'no_machine',
        machines: [
          {
            machine: { id: machineId, name: 'Laptop' },
            unavailable: {
              why: 'account_outside_window',
              next: new Date(windowOpens).toISOString(),
            },
          },
        ],
      };
      expect(before.candidates).toMatchObject([
        { kind: 'implement', ticket: { number: 2, priority: 'high' }, reason: outside },
        { kind: 'implement', ticket: { number: 1 }, blocks: 1, reason: outside },
        {
          kind: 'implement',
          ticket: { number: 3 },
          reason: { reason: 'blocked', tickets: ['WEB-1'] },
        },
      ]);
      expect(await tick()).toEqual([]);
      clockAt(windowOpens - MINUTE);
      expect(await tick()).toEqual([]);
      expect(await sessions()).toBe(0);

      /** One ticket's night: implemented, CI passed, reviewed by Quality by itself. */
      async function implementedAndReviewed(number: number, file: string, subject: string) {
        const reference = `WEB-${String(number)}`;
        await fake.play({ turns: [{ steps: [commit(file, subject), cost, submit] }] });
        expect(await tick()).toEqual([`implement ${reference}`]);
        const built = await latestRun();
        await until(`${reference} submitted, CI passed`, async () => {
          await h.t.ciTick();
          return endedSucceeded(built.id);
        });
        expect(await ticket(number)).toMatchObject({ status: 'in_review', attemptCount: 0 });
        await fake.play({
          turns: [
            {
              steps: [cost, { do: 'mcp', tool: 'review_approve', arguments: { summary: SUMMARY } }],
            },
          ],
        });
        expect(await tick()).toEqual([`review ${reference}`]);
        const review = await latestRun();
        await until(`${reference} reviewed`, async () => {
          const current = await run(review.id);
          return current.status === 'succeeded' && !current.sessionAlive;
        });
        expect(await ticket(number)).toMatchObject({ status: 'awaiting_merge' });
        expect((await run(review.id)).purpose).toBe('review');
      }

      // The window opens: the high-priority ticket first, then its review before any new work.
      clockAt(windowOpens + MINUTE);
      await implementedAndReviewed(2, 'CONTRIBUTING.md', 'Add CONTRIBUTING.md');

      // After the first ticket: WEB-1 starts at the next check; WEB-3 still waits for it.
      expect(await queueLines()).toEqual([
        'implement WEB-1: starts on Laptop',
        'implement WEB-3: blocked',
      ]);
      await implementedAndReviewed(1, 'scheduler.md', 'Add a line about the scheduler');

      // WEB-3 waits for WEB-1's merge all night: nothing else starts.
      expect(await tick()).toEqual([]);
      const night = (await theAccount()).today;
      expect(night.usage).toMatchObject({ runs: 4, runsWithoutEstimate: 0 });
      expect(night.usage.estimatedUsageUsd).toBeCloseTo(4 * COST_USD);
      expect(night.budgetUsed).toBe(false);

      // The morning (step L, 5): both awaiting merge, WEB-3 blocked by WEB-1.
      const morning = evening.getTime() + 12 * HOUR;
      clockAt(morning);
      expect(await queueLines()).toEqual(['implement WEB-3: blocked']);
      expect(await tick()).toEqual([]);

      // The owner merges both on GitHub: each done at the next check, WEB-2 then WEB-1.
      for (const number of [2, 1]) {
        const opened = (await ticket(number)).pullRequest.opened;
        if (!opened) throw new Error(`no pull request for WEB-${String(number)}`);
        h.github.mergePullRequest(bakery(), opened.number, 'merge');
        await until(`WEB-${String(number)} done`, async () => {
          await h.t.ciTick();
          return (await ticket(number)).status === 'done';
        });
      }

      // Outside the window (step L, 6): WEB-3 waits for it now, not for WEB-1.
      const nextWindow = windowOpens + 24 * HOUR;
      expect((await queue()).candidates).toMatchObject([
        {
          ticket: { number: 3 },
          reason: {
            reason: 'no_machine',
            machines: [
              {
                unavailable: {
                  why: 'account_outside_window',
                  next: new Date(nextWindow).toISOString(),
                },
              },
            ],
          },
        },
      ]);
      expect(await tick()).toEqual([]);

      // The next evening's window: WEB-3, then its review, then the owner's merge.
      clockAt(nextWindow + MINUTE);
      await implementedAndReviewed(3, 'link.md', 'Link CONTRIBUTING.md from README.md');
      const opened = (await ticket(3)).pullRequest.opened;
      if (!opened) throw new Error('no pull request for WEB-3');
      h.github.mergePullRequest(bakery(), opened.number, 'merge');
      await until('WEB-3 done', async () => {
        await h.t.ciTick();
        return (await ticket(3)).status === 'done';
      });

      // At the end: nothing waits, and the second night stayed within the budget too.
      expect(await queue()).toMatchObject({ candidates: [] });
      expect(await tick()).toEqual([]);
      const second = (await theAccount()).today;
      expect(second.usage).toMatchObject({ runs: 2, runsWithoutEstimate: 0 });
      expect(second.budgetUsed).toBe(false);

      // Every run started by the scheduler, inside a window, in the expected order; none failed.
      const runs = (await h.t.db.select().from(schema.runs)).sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
      const numbers = new Map(
        (await h.t.db.select().from(schema.tickets)).map((row) => [row.id, row.number]),
      );
      expect(
        runs.map((row) => `${row.purpose} WEB-${String(numbers.get(row.ticketId ?? ''))}`),
      ).toEqual([
        'implement WEB-2',
        'review WEB-2',
        'implement WEB-1',
        'review WEB-1',
        'implement WEB-3',
        'review WEB-3',
      ]);
      for (const row of runs) {
        expect(row.status).toBe('succeeded');
        const hour = (row.startedAt ?? new Date(0)).getUTCHours();
        expect(hour >= 20 || hour < 6, `${row.id} started at ${String(hour)}:00`).toBe(true);
      }
      // Done in that order: WEB-2, WEB-1, then the blocked WEB-3.
      const done = (await h.events('ticket.status_changed'))
        .filter((event) => (event.payload as { to: string }).to === 'done')
        .map((event) => numbers.get(event.entityId ?? ''));
      expect(done).toEqual([2, 1, 3]);
      expect(await sessions()).toBe(6);
    },
    TIMEOUT,
  );

  it(
    'I: a usage limit with no reset time: paused, resumed by itself after 1 hour, then after 2, then submitted, no failed attempt',
    async () => {
      await fake.play(weeklyLimit);
      await enrolAndStart();
      await h.createTicket();
      expect(await tick()).toEqual(['implement WEB-1']);
      const started = await latestRun();

      for (const [index, wait] of [60, 120].entries()) {
        await pausedOn(started.id, 'usage_limit');
        await until('the pause recorded', async () => (await resumes()) === index);
        const limited = await accountRow();
        expect(limited).toMatchObject({
          state: 'limited',
          limitedUntilEstimated: true,
          quotaWaitMinutes: wait,
        });
        expect(Math.round(((limited.limitedUntil?.getTime() ?? 0) - now()) / MINUTE)).toBe(wait);
        // The queue says the run waits for the account's limit; nothing starts before.
        expect((await queue()).candidates).toMatchObject([
          {
            kind: 'resume',
            runId: started.id,
            reason: {
              reason: 'account_limited',
              until: limited.limitedUntil?.toISOString(),
            },
          },
        ]);
        clock.ahead += (wait - 1) * MINUTE;
        expect(await tick()).toEqual([]);
        clock.ahead += 2 * MINUTE;
        if (wait === 120) await fake.play(finishing);
        expect(await tick()).toEqual(['resume WEB-1']);
      }
      await finishes(started.id);

      // One run, paused twice and resumed twice in its own session: no failed attempt.
      const runs = await h.t.db.select().from(schema.runs);
      expect(runs.map((row) => row.status)).toEqual(['succeeded']);
      expect(await resumes()).toBe(2);
      expect(await sessions()).toBe(3);
      expect(
        (await h.events('account.limited')).map(
          (event) => (event.payload as { fallbackMinutes: number }).fallbackMinutes,
        ),
      ).toEqual([60, 120]);
    },
    TIMEOUT,
  );

  it(
    'J: the daemon stopped longer than Runs of an offline machine fail after: the run failed, not counted, started again once the machine is back',
    async () => {
      // The agent commits, then works on for a minute: the daemon is stopped meanwhile.
      await fake.play({
        turns: [
          {
            steps: [
              commit('contact.html', 'Add the contact form'),
              { do: 'bash', command: 'touch working' },
              { do: 'sleep', ms: 60_000 },
            ],
          },
        ],
      });
      const { machineId } = await enrolAndStart();
      await h.createTicket();
      expect(await tick()).toEqual(['implement WEB-1']);
      const started = await latestRun();
      await until('the agent at work', async () =>
        (
          await readdir(join(home.paths.home, 'worktrees', started.id)).catch((): string[] => [])
        ).includes('working'),
      );

      // Stopped for 11 minutes (Runs of an offline machine fail after: 10): failed, not counted.
      const daemon = daemons[0];
      if (!daemon) throw new Error('no daemon');
      await stopDaemon(daemon);
      await until('the machine offline', async () => !(await machine(machineId)).online);
      clock.ahead += 11 * MINUTE;
      expect(await tick()).toEqual([]);
      expect(await run(started.id)).toMatchObject({
        status: 'failed',
        failureReason: 'machine_offline',
      });
      expect(await ticket()).toMatchObject({ status: 'todo', attemptCount: 0 });
      expect((await h.events('ticket.status_changed')).at(-1)?.payload).toMatchObject({
        to: 'todo',
        attemptCounted: false,
      });
      // While it stays away, nothing starts: the queue says the machine is offline.
      expect((await queue()).candidates).toMatchObject([
        {
          ticket: { number: 1 },
          reason: {
            reason: 'no_machine',
            machines: [{ machine: { name: 'Laptop' }, unavailable: { why: 'offline' } }],
          },
        },
      ]);
      expect(await tick()).toEqual([]);

      // Back: its old session stopped, and the scheduler starts the ticket again there.
      startDaemon();
      await until('the machine online', async () => (await machine(machineId)).online);
      await until('the old session stopped', () => Promise.resolve(!sessionAlive(started.id)));
      await fake.play({
        turns: [{ steps: [commit('thanks.html', 'Add the thank-you message'), submit] }],
      });
      expect(await tick()).toEqual(['implement WEB-1']);
      const next = await latestRun();
      expect(next.id).not.toBe(started.id);
      expect(next.machineId).toBe(machineId);
      await finishes(next.id);
      expect(await sessions()).toBe(2);
    },
    TIMEOUT,
  );
});
