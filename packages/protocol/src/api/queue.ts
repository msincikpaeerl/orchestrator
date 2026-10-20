import { z } from 'zod';
import { HoldCause } from './holds.js';
import { AccountRef, MachineRef, MachineUnavailable, RunRefusal } from './runs.js';
import { TicketPriority } from './tickets.js';

// The scheduler's queue (07, sections 2, 3 and 7; lot 4 step D1): every candidate in the order the
// scheduler takes them, each with why it cannot start now, in the reasons **Run now** refuses with,
// so the queue and Run now say the same thing in the same words.

/** What a candidate starts, in the scheduler's order of categories (07, section 3). */
export const QueueKind = z.enum(['resume', 'review', 'fix_review', 'implement']);
export type QueueKind = z.infer<typeof QueueKind>;

/**
 * The blocking "Needs you" items that keep a ticket out of the scheduler while they stand (04,
 * section 5.1; 07, sections 1 and 4).
 */
export const BlockingItem = z.enum([
  'ci_timeout',
  'ci_cancelled',
  'push_failed',
  'download_failed',
  'review_not_finished',
  /** "<ticket> could not start on <machine>" (07, section 4). */
  'machine_failures',
]);
export type BlockingItem = z.infer<typeof BlockingItem>;

/** Why a candidate cannot start now: Run now's refusals, and the two the scheduler adds. */
export const QueueReason = z.discriminatedUnion('reason', [
  ...RunRefusal.options,
  z.object({ reason: z.literal('held'), cause: HoldCause }),
  /** `machine`: the machine the item names, when it names one. */
  z.object({ reason: z.literal('needs_you'), item: BlockingItem, machine: MachineRef.nullable() }),
]);
export type QueueReason = z.infer<typeof QueueReason>;

export const QueueCandidate = z.object({
  kind: QueueKind,
  ticket: z.object({
    projectKey: z.string(),
    number: z.int().positive(),
    title: z.string(),
    priority: TicketPriority,
  }),
  /** The paused run a resume continues; null for the others. */
  runId: z.uuid().nullable(),
  /** Tickets waiting on it, directly or through others, not done or cancelled (07, section 3). */
  blocks: z.int().min(0),
  /** Its latest run failed and counted: it waits behind the others of its category (07, 6). */
  afterFailure: z.boolean(),
  /** Since when it waits, for "oldest first". */
  since: z.iso.datetime(),
  /** Null when it can start now; `machine` is then the machine it would start on. */
  reason: QueueReason.nullable(),
  machine: MachineRef.nullable(),
});
export type QueueCandidate = z.infer<typeof QueueCandidate>;

/** A Claude account's line (02, section 7): runs using it now, and why it starts none, if so. */
export const QueueAccount = z.object({
  account: AccountRef,
  /** Runs counted against its maximum (01, invariant 3; waiting for CI included, 07, 3). */
  active: z.int().min(0),
  maxConcurrentRuns: z.int().positive(),
  /** One of the `account_*` reasons, or null when it can start a run. */
  unavailable: MachineUnavailable.nullable(),
});
export type QueueAccount = z.infer<typeof QueueAccount>;

/** `GET /api/queue`: computed at `at`; nothing is started by reading it. */
export const QueueResponse = z.object({
  at: z.iso.datetime(),
  accounts: z.array(QueueAccount),
  candidates: z.array(QueueCandidate),
});
export type QueueResponse = z.infer<typeof QueueResponse>;
