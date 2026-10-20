import { schema } from '@orchestrator/db';
import {
  EventEntityType,
  type QueueCandidate,
  type QueueResponse,
  type StreamMessage,
} from '@orchestrator/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from 'pg';
import type { Database } from '../database.js';
import type { ChangeFeed } from '../realtime/changes.js';
import type { RunService } from '../runs/service.js';
import { resolveSettings } from '../settings/store.js';
import { computeQueue } from './queue.js';

// The scheduler's loop (07, section 2; lot 4 step D2a): it starts what its queue says can start,
// one run per account per pass, through Run now's and Start review's own path, until a pass
// starts nothing. It runs when something relevant changes (an event of a ticket, a run, a
// machine, an account, a project, a setting or the GitHub connection), when a window opens, a
// day starts or a limit ends, and at least once per **Scheduler check interval**. From step E it
// also resumes the runs paused on a usage limit, first in their account's queue, on their own
// machine, through Resume's own path (07, section 5.2). From step G each tick first fails the runs
// of a machine offline for **Runs of an offline machine fail after** (05, section 6), and wakes
// when the next one is due.

/** The advisory lock of the loop (07, section 2): one pass at a time across server instances. */
export const SCHEDULER_LOCK = 4_701_517_242;

/** The changes that can make a candidate startable, or free an account's place. */
const RELEVANT = new Set<EventEntityType>([
  'ticket',
  'run',
  'machine',
  'claude_account',
  'project',
  'setting',
  'github_connection',
]);

/** Longest wait armed for a window, a day or a limit: the interval's tick comes before anyway. */
const LONGEST_WAKE_MS = 24 * 60 * 60 * 1000;

export interface SchedulerStart {
  runId: string;
  /** `WEB-12`. */
  ticket: string;
  kind: QueueCandidate['kind'];
  machine: string;
}

/** One tick: whether it held the lock, and the runs it started, in order. */
export interface SchedulerTick {
  locked: boolean;
  started: SchedulerStart[];
}

export interface SchedulerOptions {
  db: Database;
  pool: Pool;
  log: FastifyBaseLogger;
  runs: Pick<RunService, 'runNow' | 'startReview' | 'resume' | 'failOfflineRuns'>;
  /** The changes that trigger a tick; none in tests that run the ticks themselves. */
  feed?: ChangeFeed;
  now?: () => Date;
  /** False in tests: the loop runs only when the test asks (`schedulerTick()`), as the CI loop. */
  timers?: boolean;
  /** Milliseconds in one second of **Scheduler check interval**; tests of the timers shorten it. */
  secondMs?: number;
}

export class Scheduler {
  private running: Promise<SchedulerTick> | null = null;
  /** A trigger came during a tick: one more after it. */
  private again = false;
  private interval: NodeJS.Timeout | undefined;
  private wake: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;

  constructor(readonly options: SchedulerOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** At server start: a tick at once, then on each relevant change and each interval. */
  start(): void {
    if (this.options.timers === false) return;
    this.unsubscribe = this.options.feed?.subscribe((message) => {
      if (relevant(message)) this.trigger();
    });
    this.trigger();
  }

  /** A tick soon: at once, or after the one in flight (several triggers make one more tick). */
  trigger(): void {
    if (this.closed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    void this.tick();
  }

  /** One tick, after the one in flight; never rejects. */
  tick(): Promise<SchedulerTick> {
    const previous = this.running ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        return await this.work();
      } catch (error) {
        this.options.log.error({ err: error }, 'scheduler tick failed');
        return { locked: false, started: [] };
      }
    });
    const running: Promise<SchedulerTick> = next.finally(() => {
      if (this.running !== running) return;
      this.running = null;
      if (this.closed || this.options.timers === false) return;
      if (this.again) {
        this.again = false;
        this.trigger();
      } else void this.armInterval();
    });
    this.running = running;
    return next;
  }

  /** Stops the loop; resolves once the tick in flight is over. */
  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    clearTimeout(this.interval);
    clearTimeout(this.wake);
    await this.running;
  }

  private async armInterval(): Promise<void> {
    let seconds = 30;
    try {
      ({ schedulerTickSeconds: seconds } = await resolveSettings(this.options.db, [
        'schedulerTickSeconds',
      ]));
    } catch (error) {
      this.options.log.error({ err: error }, 'Scheduler check interval not read');
    }
    if (this.closed || this.running) return;
    clearTimeout(this.interval);
    this.interval = setTimeout(
      () => {
        this.trigger();
      },
      seconds * (this.options.secondMs ?? 1000),
    );
  }

  /**
   * A tick when the first window opens, day starts or limit ends among the accounts, a paused
   * run's wait after a suspected limit ends, or a run of an offline machine is due to fail.
   */
  private armWake(queue: QueueResponse, now: Date, offlineDue: Date | null): void {
    if (this.options.timers === false || this.closed) return;
    const times = queue.accounts.flatMap(({ unavailable }) => {
      if (!unavailable) return [];
      if (unavailable.why === 'account_outside_window') return unavailable.next ?? [];
      if (unavailable.why === 'account_budget_used' || unavailable.why === 'account_limited') {
        return unavailable.until;
      }
      return [];
    });
    for (const { reason } of queue.candidates) {
      if (reason?.reason === 'quota_wait') times.push(reason.until);
    }
    if (offlineDue !== null) times.push(offlineDue.toISOString());
    const first = Math.min(...times.map((at) => Date.parse(at)));
    clearTimeout(this.wake);
    if (!Number.isFinite(first)) return;
    const delay = Math.min(Math.max(0, first - now.getTime()) + 1000, LONGEST_WAKE_MS);
    this.wake = setTimeout(() => {
      this.trigger();
    }, delay);
  }

  /**
   * The passes of one tick, under the advisory lock: each starts the first startable candidate of
   * every account, until one starts nothing. A candidate refused at its start (its checks under
   * the locks found something new) is left for this tick, so each one is tried once at most.
   */
  private async work(): Promise<SchedulerTick> {
    const client = await this.options.pool.connect();
    let locked = false;
    try {
      const result = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [SCHEDULER_LOCK],
      );
      locked = result.rows[0]?.locked === true;
      if (!locked) {
        this.options.log.debug('scheduler: another instance holds the lock');
        return { locked: false, started: [] };
      }
      // First the runs of machines offline too long: their tickets can then be candidates.
      const offlineDue = await this.options.runs.failOfflineRuns();
      const started: SchedulerStart[] = [];
      const tried = new Set<string>();
      for (;;) {
        const now = this.now();
        const queue = await computeQueue(this.options.db, now);
        this.armWake(queue, now, offlineDue);
        const picks = await this.picks(queue, tried);
        if (picks.length === 0) break;
        for (const candidate of picks) {
          tried.add(key(candidate));
          const run = await this.startOne(candidate);
          if (run) started.push(run);
        }
      }
      this.options.log.debug({ started: started.length }, 'scheduler tick');
      return { locked: true, started };
    } finally {
      if (locked) {
        await client.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK]).catch(() => {
          // The connection is released with its lock if this fails.
        });
      }
      client.release();
    }
  }

  /** The first candidate of each account that can start now, not tried yet in this tick. */
  private async picks(queue: QueueResponse, tried: ReadonlySet<string>): Promise<QueueCandidate[]> {
    const machines = new Map(
      (
        await this.options.db
          .select({ id: schema.machines.id, accountId: schema.machines.accountId })
          .from(schema.machines)
      ).map((machine) => [machine.id, machine.accountId]),
    );
    const picks = new Map<string, QueueCandidate>();
    for (const candidate of queue.candidates) {
      if (candidate.reason !== null || !candidate.machine) continue;
      if (tried.has(key(candidate))) continue;
      const account = machines.get(candidate.machine.id);
      if (account !== undefined && !picks.has(account)) picks.set(account, candidate);
    }
    return [...picks.values()];
  }

  /** Starts one candidate as the scheduler; a refusal is logged and starts nothing. */
  private async startOne(candidate: QueueCandidate): Promise<SchedulerStart | null> {
    const { projectKey, number } = candidate.ticket;
    const machine = candidate.machine;
    if (!machine) return null;
    const starter = { by: 'scheduler' as const, machineId: machine.id };
    const ticket = `${projectKey}-${String(number)}`;
    try {
      const run =
        candidate.kind === 'resume' && candidate.runId !== null
          ? await this.options.runs.resume(candidate.runId, starter)
          : candidate.kind === 'review'
            ? await this.options.runs.startReview(projectKey, number, starter)
            : await this.options.runs.runNow(projectKey, number, starter);
      this.options.log.info(
        { run: run.id, ticket, machine: machine.name, kind: candidate.kind },
        'scheduler started a run',
      );
      return { runId: run.id, ticket, kind: candidate.kind, machine: machine.name };
    } catch (error) {
      this.options.log.info(
        { err: error, ticket, machine: machine.name, kind: candidate.kind },
        'scheduler: the start was refused',
      );
      return null;
    }
  }
}

function key(candidate: QueueCandidate): string {
  return `${candidate.kind}:${candidate.ticket.projectKey}-${String(candidate.ticket.number)}`;
}

function relevant(message: StreamMessage): boolean {
  if (message.type === 'resync') return true;
  return message.type === 'changed' && RELEVANT.has(message.entity);
}
