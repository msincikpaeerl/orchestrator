import { randomUUID } from 'node:crypto';
import { createPool, endPool, schema } from '@orchestrator/db';
import { createTestDatabase, type TestDatabase } from '@orchestrator/db/testing';
import {
  QueueResponse,
  type QueueCandidate,
  type QueueReason,
  type TicketPriority,
} from '@orchestrator/protocol';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createLogger } from '../src/logger.js';
import { Scheduler } from '../src/scheduler/loop.js';
import { computeQueue } from '../src/scheduler/queue.js';

// The scheduler's queue (07, sections 2 to 4 and 7; lot 4 step D1), over a database built for each
// case: every order rule and every reason, at a time `now` given to it. Nothing is started.

const NOW = new Date('2026-10-20T10:00:00.000Z');
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);

let database: TestDatabase;
let pool: Pool;
let db: Database;
let builder: string;
let quality: string;

beforeEach(async () => {
  database = await createTestDatabase();
  pool = createPool({ connectionString: database.url });
  db = createDatabase(pool);
  builder = await profile('web_dev', 'builder');
  quality = await profile('quality', 'reviewer');
  await db.insert(schema.githubConnection).values({
    account: 'octo-owner',
    accountId: 1,
    savedAt: NOW,
    checkedAt: NOW,
    permissions: [],
  });
});

afterEach(async () => {
  await endPool(pool);
  await database.drop();
});

async function profile(key: string, role: string, requiredCapabilities: string[] = []) {
  const [row] = await db
    .insert(schema.agentProfiles)
    .values({
      key,
      name: key,
      description: key,
      role,
      instructions: '',
      model: 'sonnet',
      requiredCapabilities,
      isDefault: true,
    })
    .returning();
  if (!row) throw new Error('profile not inserted');
  return row.id;
}

async function project(key: string, values: Partial<typeof schema.projects.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.projects)
    .values({
      key,
      name: key,
      slug: key.toLowerCase(),
      description: '',
      kind: 'website',
      repoOwner: 'octo-owner',
      repoName: key.toLowerCase(),
      repoOrigin: 'created',
      repoPrivate: true,
      defaultBranch: 'main',
      setupStatus: 'ready',
      ...values,
    })
    .returning();
  if (!row) throw new Error('project not inserted');
  return row;
}

async function account(
  label: string,
  values: Partial<typeof schema.claudeAccounts.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.claudeAccounts)
    .values({ label, plan: 'pro', maxConcurrentRuns: 10, ...values })
    .returning();
  if (!row) throw new Error('account not inserted');
  return row;
}

/** An enrolled machine, online and usable unless `values` says otherwise. */
async function machine(
  name: string,
  accountId: string,
  values: Partial<typeof schema.machines.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.machines)
    .values({
      name,
      accountId,
      status: 'online',
      enrolledAt: minutes(-600),
      daemonVersion: '0.4.0',
      protocolVersion: 3,
      claudeCodeVersion: '2.1.302',
      ...values,
    })
    .returning();
  if (!row) throw new Error('machine not inserted');
  return row;
}

let numbers = new Map<string, number>();
beforeEach(() => {
  numbers = new Map();
});

async function ticket(
  projectRow: { id: string; key: string },
  values: Partial<typeof schema.tickets.$inferInsert> & { priority?: TicketPriority } = {},
) {
  const number = (numbers.get(projectRow.id) ?? 0) + 1;
  numbers.set(projectRow.id, number);
  const [row] = await db
    .insert(schema.tickets)
    .values({
      projectId: projectRow.id,
      number,
      type: 'feature',
      title: `Ticket ${String(number)}`,
      description: '',
      priority: 'normal',
      status: 'todo',
      createdBy: 'owner',
      assigneeProfileId: builder,
      createdAt: minutes(-300 + number),
      ...values,
    })
    .returning();
  if (!row) throw new Error('ticket not inserted');
  return row;
}

async function blockedBy(
  waiting: { id: string; projectId: string },
  blocker: { id: string },
): Promise<void> {
  await db
    .insert(schema.ticketDependencies)
    .values({ projectId: waiting.projectId, ticketId: waiting.id, blockedById: blocker.id });
}

async function run(
  ticketRow: { id: string; projectId: string },
  machineRow: { id: string; accountId: string },
  values: Partial<typeof schema.runs.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.runs)
    .values({
      projectId: ticketRow.projectId,
      ticketId: ticketRow.id,
      profileId: values.purpose === 'review' ? quality : builder,
      profileVersion: 1,
      purpose: 'implement',
      machineId: machineRow.id,
      accountId: machineRow.accountId,
      status: 'failed',
      attempt: 1,
      runTokenHash: randomUUID(),
      branchName: 't/1-ticket',
      baseBranch: 'main',
      createdAt: minutes(-120),
      statusSince: minutes(-100),
      endedAt: minutes(-100),
      ...values,
    })
    .returning();
  if (!row) throw new Error('run not inserted');
  return row;
}

async function queue(now = NOW): Promise<QueueResponse> {
  return QueueResponse.parse(await computeQueue(db, now));
}

/**
 * What one tick of the loop asks to start (lot 4 step D2a), with the clock at `NOW`: each start is
 * recorded and refused, so nothing is started and every candidate is asked once at most.
 */
async function loopAsks(): Promise<string[]> {
  const asked: string[] = [];
  const start = (projectKey: string, number: number): Promise<never> => {
    asked.push(`${projectKey}-${String(number)}`);
    return Promise.reject(new Error('recorded only'));
  };
  const scheduler = new Scheduler({
    db,
    pool,
    log: createLogger('silent'),
    runs: { runNow: start, startReview: start },
    now: () => NOW,
    timers: false,
  });
  await scheduler.tick();
  await scheduler.close();
  return asked;
}

const label = (candidate: QueueCandidate) =>
  `${candidate.ticket.projectKey}-${String(candidate.ticket.number)}`;

async function reasonOf(reference: string): Promise<QueueReason | null> {
  const found = (await queue()).candidates.find((candidate) => label(candidate) === reference);
  if (!found) throw new Error(`${reference} is not in the queue`);
  return found.reason;
}

/** A review candidate: in review with a pull request, its work handed in with CI passed. */
async function inReview(
  projectRow: { id: string; key: string },
  machineRow: { id: string; accountId: string },
) {
  const row = await ticket(projectRow, {
    status: 'in_review',
    pullRequestNumber: 7,
    pullRequestUrl: 'https://github.com/octo-owner/web/pull/7',
  });
  await run(row, machineRow, {
    status: 'succeeded',
    ciCommit: 'c'.repeat(40),
    endedAt: minutes(-90),
  });
  return row;
}

describe('the order (07, section 3)', () => {
  it('takes resumes, then reviews, then fixes, then new work', async () => {
    const web = await project('WEB');
    const laptop = await machine('Laptop', (await account('Personal')).id);
    const implement = await ticket(web);
    const fix = await ticket(web, {
      changeRequest: {
        by: 'owner',
        commit: null,
        commentId: randomUUID(),
        after: null,
        conflict: null,
        at: minutes(-30).toISOString(),
      },
    });
    const review = await inReview(web, laptop);
    const paused = await ticket(web, { status: 'in_progress' });
    const pausedRun = await run(paused, laptop, {
      status: 'paused_quota',
      pauseReason: 'usage_limit',
      endedAt: null,
      claudeSessionId: randomUUID(),
    });

    const { candidates } = await queue();
    expect(candidates.map((candidate) => [label(candidate), candidate.kind])).toEqual([
      [`WEB-${String(paused.number)}`, 'resume'],
      [`WEB-${String(review.number)}`, 'review'],
      [`WEB-${String(fix.number)}`, 'fix_review'],
      [`WEB-${String(implement.number)}`, 'implement'],
    ]);
    expect(candidates[0]?.runId).toBe(pausedRun.id);
    expect(candidates.every((candidate) => candidate.reason === null)).toBe(true);
    expect(candidates.every((candidate) => candidate.machine?.name === 'Laptop')).toBe(true);
  });

  it('takes high priority first, then the tickets blocking the most, then the oldest', async () => {
    const web = await project('WEB');
    await machine('Laptop', (await account('Personal')).id);
    const low = await ticket(web, { priority: 'low' });
    const oldest = await ticket(web);
    const younger = await ticket(web);
    const blocksOne = await ticket(web);
    const blocksTwo = await ticket(web);
    const high = await ticket(web, { priority: 'high' });
    const waitsOnOne = await ticket(web);
    const waitsOnTwo = await ticket(web);
    const waitsThrough = await ticket(web);
    await blockedBy(waitsOnOne, blocksOne);
    await blockedBy(waitsOnTwo, blocksTwo);
    // Through another (owner's answer 15a): blocksTwo blocks waitsOnTwo, which blocks this one.
    await blockedBy(waitsThrough, waitsOnTwo);
    // A done ticket waiting on it no longer counts.
    await blockedBy(await ticket(web, { status: 'done' }), blocksOne);

    const { candidates } = await queue();
    const order = candidates.map(label);
    const at = (row: { number: number }) => order.indexOf(`WEB-${String(row.number)}`);
    expect(at(high)).toBe(0);
    expect(candidates[at(blocksTwo)]?.blocks).toBe(2);
    expect(candidates[at(blocksOne)]?.blocks).toBe(1);
    expect(at(blocksTwo)).toBeLessThan(at(blocksOne));
    expect(at(blocksOne)).toBeLessThan(at(oldest));
    expect(at(oldest)).toBeLessThan(at(younger));
    expect(at(low)).toBe(order.length - 1);
  });

  it('puts a ticket whose last attempt failed behind the others of its category', async () => {
    const web = await project('WEB');
    const laptop = await machine('Laptop', (await account('Personal')).id);
    const failed = await ticket(web, { priority: 'high', attemptCount: 1 });
    await run(failed, laptop, { status: 'failed', failureReason: 'dod_failed' });
    const notCounted = await ticket(web);
    await run(notCounted, laptop, { status: 'cancelled', failureReason: 'cancelled' });
    const fresh = await ticket(web, { priority: 'low' });

    const { candidates } = await queue();
    expect(candidates.map((candidate) => [label(candidate), candidate.afterFailure])).toEqual([
      [`WEB-${String(notCounted.number)}`, false],
      [`WEB-${String(fresh.number)}`, false],
      [`WEB-${String(failed.number)}`, true],
    ]);
  });

  it('serves projects in turn, the one served longest ago first', async () => {
    const web = await project('WEB');
    const app = await project('APP');
    const laptop = await machine('Laptop', (await account('Personal')).id);
    const web1 = await ticket(web);
    const web2 = await ticket(web);
    const web3 = await ticket(web);
    const app1 = await ticket(app);
    const app2 = await ticket(app);
    // WEB had a run more recently than APP.
    await run(await ticket(app, { status: 'done' }), laptop, {
      status: 'succeeded',
      createdAt: minutes(-200),
    });
    await run(await ticket(web, { status: 'done' }), laptop, {
      status: 'succeeded',
      createdAt: minutes(-50),
    });

    const { candidates } = await queue();
    expect(candidates.map(label)).toEqual(
      [app1, web1, app2, web2, web3].map(
        (row) => `${row.projectId === app.id ? 'APP' : 'WEB'}-${String(row.number)}`,
      ),
    );
  });

  it('gives each account its places in order, the next ones waiting for it', async () => {
    const web = await project('WEB');
    const personal = await account('Personal', { maxConcurrentRuns: 2 });
    await machine('Laptop', personal.id);
    const busy = await ticket(web, { status: 'in_progress' });
    // A run waiting for CI counts against the maximum (owner's answer 2, lot 4 step A).
    await run(busy, await machine('Desktop', personal.id), {
      status: 'running',
      ciWaitingSince: minutes(-5),
      endedAt: null,
    });
    const first = await ticket(web);
    const second = await ticket(web);

    const result = await queue();
    expect(result.accounts).toEqual([
      {
        account: { id: personal.id, label: 'Personal' },
        active: 1,
        maxConcurrentRuns: 2,
        unavailable: null,
      },
    ]);
    const [one, two] = result.candidates;
    expect(one && label(one)).toBe(`WEB-${String(first.number)}`);
    expect(one?.reason).toBeNull();
    expect(one?.machine?.name).toBe('Desktop');
    expect(two && label(two)).toBe(`WEB-${String(second.number)}`);
    expect(two?.machine).toBeNull();
    expect(two?.reason).toEqual({
      reason: 'no_machine',
      machines: ['Desktop', 'Laptop'].map((name) => ({
        machine: { id: expect.any(String) as string, name },
        unavailable: {
          why: 'account_busy',
          account: { id: personal.id, label: 'Personal' },
          maxConcurrentRuns: 2,
        },
      })),
    });
  });
});

describe("each reason, in Run now's terms (07, sections 3 and 7)", () => {
  it('names the ticket reasons: no assignee, stopped, blocked by named tickets', async () => {
    const web = await project('WEB');
    await machine('Laptop', (await account('Personal')).id);
    await ticket(web, { assigneeProfileId: null });
    await ticket(web, {
      stopped: { cause: 'failed_attempts', count: 3, limit: 3, at: minutes(-10).toISOString() },
    });
    const blocker = await ticket(web, { status: 'in_progress' });
    const cancelled = await ticket(web, { status: 'cancelled' });
    const blocked = await ticket(web);
    await blockedBy(blocked, blocker);
    // As Run now: a cancelled blocker still blocks; a done one does not.
    await blockedBy(blocked, cancelled);
    await blockedBy(blocked, await ticket(web, { status: 'done' }));

    expect(await reasonOf('WEB-1')).toEqual({ reason: 'no_assignee' });
    expect(await reasonOf('WEB-2')).toEqual({
      reason: 'ticket_stopped',
      cause: 'failed_attempts',
      count: 3,
      limit: 3,
    });
    expect(await reasonOf(`WEB-${String(blocked.number)}`)).toEqual({
      reason: 'blocked',
      tickets: ['WEB-3', 'WEB-4'],
      // Named apart, so the owner knows to remove the dependency (review of lot 4 step D1).
      cancelled: ['WEB-4'],
    });
  });

  it('names an archived project, one not ready, and a GitHub token missing or refused', async () => {
    await machine('Laptop', (await account('Personal')).id);
    await ticket(await project('OLD', { status: 'archived' }));
    await ticket(await project('NEW', { setupStatus: 'in_progress' }));
    expect(await reasonOf('OLD-1')).toEqual({ reason: 'project_archived' });
    expect(await reasonOf('NEW-1')).toEqual({ reason: 'project_not_ready' });

    const web = await project('WEB');
    await ticket(web);
    await db.update(schema.githubConnection).set({ invalidSince: NOW });
    expect(await reasonOf('WEB-1')).toEqual({ reason: 'github_token_invalid' });
    await db.update(schema.githubConnection).set({ unreadableSince: NOW });
    expect(await reasonOf('WEB-1')).toEqual({ reason: 'github_token_unreadable' });
    await db.delete(schema.githubConnection);
    expect(await reasonOf('WEB-1')).toEqual({ reason: 'github_not_connected' });
  });

  it('names the blocking "Needs you" items: CI wait, CI cancelled, push, download', async () => {
    const web = await project('WEB');
    const laptop = await machine('Laptop', (await account('Personal')).id);
    const ref = { id: laptop.id, name: 'Laptop' };
    await run(await ticket(web), laptop, {
      failureReason: 'ci_timeout',
      ciCommit: 'c'.repeat(40),
    });
    await run(await ticket(web), laptop, { failureReason: 'ci_cancelled' });
    const pushed = await ticket(web, {
      branchPushFailure: {
        at: minutes(-100).toISOString(),
        machineId: laptop.id,
        reason: 'unreachable',
        message: 'GitHub could not be reached',
      },
    });
    await run(pushed, laptop, { failureReason: 'push_failed' });
    await run(await ticket(web), laptop, {
      failureReason: 'download_failed',
      downloadFailure: { reason: 'unreachable', message: 'Could not resolve host: github.com' },
    });
    // A new run since: the download item went (04, section 5.1).
    const again = await ticket(web);
    await run(again, laptop, {
      failureReason: 'download_failed',
      downloadFailure: { reason: 'unreachable', message: 'Could not resolve host: github.com' },
      createdAt: minutes(-130),
    });
    await run(again, laptop, { failureReason: 'cancelled', status: 'cancelled' });

    expect(await reasonOf('WEB-1')).toEqual({
      reason: 'needs_you',
      item: 'ci_timeout',
      machine: ref,
    });
    expect(await reasonOf('WEB-2')).toEqual({
      reason: 'needs_you',
      item: 'ci_cancelled',
      machine: null,
    });
    expect(await reasonOf('WEB-3')).toEqual({
      reason: 'needs_you',
      item: 'push_failed',
      machine: ref,
    });
    expect(await reasonOf('WEB-4')).toEqual({
      reason: 'needs_you',
      item: 'download_failed',
      machine: ref,
    });
    expect(await reasonOf('WEB-5')).toBeNull();
    // The loop asks to start only the ticket without an item (lot 4 step D2a).
    expect(await loopAsks()).toEqual(['WEB-5']);
  });

  it('names a review that did not finish, and offers no review while one runs', async () => {
    const web = await project('WEB');
    const laptop = await machine('Laptop', (await account('Personal')).id);
    const review = await inReview(web, laptop);
    await run(review, laptop, {
      purpose: 'review',
      failureReason: 'timeout',
      reviewCommit: 'c'.repeat(40),
      createdAt: minutes(-80),
      endedAt: minutes(-60),
    });
    const running = await inReview(web, laptop);
    await run(running, laptop, {
      purpose: 'review',
      status: 'running',
      reviewCommit: 'c'.repeat(40),
      createdAt: minutes(-20),
      endedAt: null,
    });

    const { candidates } = await queue();
    expect(candidates.map(label)).toEqual([`WEB-${String(review.number)}`]);
    expect(candidates[0]?.reason).toEqual({
      reason: 'needs_you',
      item: 'review_not_finished',
      machine: { id: laptop.id, name: 'Laptop' },
    });
    expect(await loopAsks()).toEqual([]);
  });

  it('names the account: paused, limited until, outside its window until, budget used', async () => {
    const web = await project('WEB');
    const personal = await account('Personal');
    await machine('Laptop', personal.id);
    await ticket(web);
    const ref = { id: personal.id, label: 'Personal' };
    const machineReason = (unavailable: object) => ({
      reason: 'no_machine',
      machines: [{ machine: { id: expect.any(String) as string, name: 'Laptop' }, unavailable }],
    });

    await db.update(schema.claudeAccounts).set({ state: 'paused_manual' });
    expect(await reasonOf('WEB-1')).toEqual(machineReason({ why: 'account_paused', account: ref }));

    await db.update(schema.claudeAccounts).set({ state: 'limited', limitedUntil: minutes(30) });
    expect(await reasonOf('WEB-1')).toEqual(
      machineReason({ why: 'account_limited', account: ref, until: minutes(30).toISOString() }),
    );
    // Its time passed: available again, as Run now reads it.
    expect((await queue(minutes(31))).candidates[0]?.reason).toBeNull();

    // Windows in the Orchestrator's time zone (UTC until saved): Tuesday 10:00 is outside.
    await db.update(schema.claudeAccounts).set({
      state: 'available',
      limitedUntil: null,
      schedule: [{ days: ['monday', 'tuesday'], start: '22:00', end: '06:00' }],
    });
    expect(await reasonOf('WEB-1')).toEqual(
      machineReason({
        why: 'account_outside_window',
        account: ref,
        next: '2026-10-20T22:00:00.000Z',
      }),
    );
    expect((await queue(new Date('2026-10-20T23:00:00.000Z'))).candidates[0]?.reason).toBeNull();

    await db.update(schema.claudeAccounts).set({
      schedule: [],
      dailyBudget: { kind: 'estimated_usage', usd: 1 },
    });
    await run(await ticket(web, { status: 'done' }), await machine('Desktop', personal.id), {
      status: 'succeeded',
      startedAt: minutes(-60),
      estimatedUsageUsd: 1.5,
    });
    const used = (await queue()).accounts[0];
    expect(used?.unavailable).toEqual({
      why: 'account_budget_used',
      account: ref,
      until: '2026-10-21T00:00:00.000Z',
    });
    expect((await queue()).candidates[0]?.reason).toEqual({
      reason: 'no_machine',
      machines: ['Desktop', 'Laptop'].map((name) => ({
        machine: { id: expect.any(String) as string, name },
        unavailable: {
          why: 'account_budget_used',
          account: ref,
          until: '2026-10-21T00:00:00.000Z',
        },
      })),
    });
  });

  it('names each machine and why: offline, missing a capability, none at all', async () => {
    const web = await project('WEB');
    await ticket(web);
    expect(await reasonOf('WEB-1')).toEqual({
      reason: 'no_machine',
      machines: [],
    });
    const personal = await account('Personal');
    await machine('Laptop', personal.id, { status: 'offline' });
    await machine('Phone', personal.id, { disabledAt: NOW });
    const android = await profile('android_dev', 'builder', ['android-sdk']);
    await ticket(web, { assigneeProfileId: android });
    const laptop = { id: expect.any(String) as string, name: 'Laptop' };
    const phone = { id: expect.any(String) as string, name: 'Phone' };
    expect(await reasonOf('WEB-2')).toEqual({
      reason: 'no_machine',
      machines: [
        { machine: laptop, unavailable: { why: 'offline' } },
        { machine: phone, unavailable: { why: 'disabled' } },
      ],
    });
    await machine('Desktop', personal.id);
    expect(await reasonOf('WEB-2')).toEqual({
      reason: 'no_machine',
      machines: [
        {
          machine: { id: expect.any(String) as string, name: 'Desktop' },
          unavailable: { why: 'missing_capabilities', capabilities: ['android-sdk'] },
        },
        { machine: laptop, unavailable: { why: 'offline' } },
        { machine: phone, unavailable: { why: 'disabled' } },
      ],
    });
    expect(await reasonOf('WEB-1')).toBeNull();
  });

  it("names the machine holding the work, and a paused run's own machine", async () => {
    const web = await project('WEB');
    const personal = await account('Personal');
    const laptop = await machine('Laptop', personal.id, { status: 'offline' });
    const desktop = await machine('Desktop', personal.id);
    // Two commits only on Laptop (lot 3 step D3).
    await run(await ticket(web), laptop, {
      failureReason: 'dod_failed',
      branchHead: 'd'.repeat(40),
      commits: [
        { hash: 'd'.repeat(40), subject: 'Second' },
        { hash: 'e'.repeat(40), subject: 'First' },
      ],
      notOnGitHub: { listed: ['d'.repeat(40), 'e'.repeat(40)], count: 2 },
    });
    const paused = await ticket(web, { status: 'in_progress' });
    await run(paused, laptop, {
      status: 'paused_quota',
      pauseReason: 'usage_limit',
      endedAt: null,
    });
    const fresh = await ticket(web);

    const offline = { why: 'offline' };
    expect(await reasonOf('WEB-1')).toEqual({
      reason: 'machine_unavailable',
      machine: { id: laptop.id, name: 'Laptop' },
      commits: 2,
      unavailable: offline,
    });
    expect(await reasonOf(`WEB-${String(paused.number)}`)).toEqual({
      reason: 'machine_unavailable',
      machine: { id: laptop.id, name: 'Laptop' },
      commits: null,
      unavailable: offline,
    });
    const { candidates } = await queue();
    expect(
      candidates.find((candidate) => candidate.ticket.number === fresh.number)?.machine,
    ).toEqual({ id: desktop.id, name: 'Desktop' });
  });

  it("names a paused run's account limited until its reset, as Resume does", async () => {
    const web = await project('WEB');
    const personal = await account('Personal', {
      state: 'limited',
      limitedUntil: minutes(45),
      limitedUntilEstimated: true,
    });
    const laptop = await machine('Laptop', personal.id);
    const paused = await ticket(web, { status: 'in_progress' });
    await run(paused, laptop, {
      status: 'paused_quota',
      pauseReason: 'usage_limit',
      endedAt: null,
    });
    expect(await reasonOf('WEB-1')).toEqual({
      reason: 'account_limited',
      account: { id: personal.id, label: 'Personal' },
      until: minutes(45).toISOString(),
    });
  });
});

describe('the queue with many tickets', () => {
  it('computes 200 eligible tickets over 5 projects quickly', async () => {
    const personal = await account('Personal', { maxConcurrentRuns: 2 });
    const laptop = await machine('Laptop', personal.id);
    await machine('Desktop', personal.id);
    for (const key of ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE']) {
      const row = await project(key);
      let previous: { id: string; projectId: string } | undefined;
      for (let index = 0; index < 40; index += 1) {
        const created = await ticket(row, {
          priority: (['low', 'normal', 'high'] as const)[index % 3],
        });
        // Every ticket had a run, a fifth of them two; every fourth waits on the one before.
        await run(created, laptop, { failureReason: 'dod_failed' });
        if (index % 5 === 0) await run(created, laptop, { failureReason: 'crash' });
        if (previous && index % 4 === 0) await blockedBy(created, previous);
        previous = created;
      }
    }
    await queue();
    const times: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const start = performance.now();
      const { candidates } = await queue();
      times.push(performance.now() - start);
      expect(candidates).toHaveLength(200);
      expect(candidates.filter((candidate) => candidate.reason === null)).toHaveLength(2);
    }
    const median = [...times].sort((a, b) => a - b)[2] ?? 0;
    expect(median).toBeLessThan(5_000);
  });
});
