import { z } from 'zod';
import { GitHash } from '../daemon/git.js';

// What keeps a ticket from the scheduler without being the ticket's own state (lot 4 step D2b):
// the owner's hold (01, section 3.4; 07, section 1) and the failures its machines caused (07,
// section 4). Kept on the ticket; **Run now** (**Start review** for a review) clears both.

/**
 * Why a ticket is held from the scheduler (01, section 3.4; 07, section 1; owner's answer 4 and new
 * answer 2, lot 4 step A): the owner's **Stop run** of a builder run or of a review run, or
 * **Request changes** with its hold box checked. **Run now** releases it (**Start review** for a
 * review).
 */
export const HoldCause = z.enum(['stop_run', 'stop_review', 'request_changes']);
export type HoldCause = z.infer<typeof HoldCause>;

/** The ticket's hold: why, when, and what it holds. */
export const TicketHold = z.object({
  cause: HoldCause,
  at: z.iso.datetime(),
  /** The run the owner stopped; null after **Request changes**. */
  runId: z.uuid().nullable(),
  /**
   * `stop_review`: the commit the stopped review was for. The hold applies to that work only: a
   * review of new work is not held (owner, review of lot 4 step D2a).
   */
  commit: GitHash.nullable(),
});
export type TicketHold = z.infer<typeof TicketHold>;

/**
 * What released a hold: **Run now** or **Start review**, or another of the owner's actions on the
 * ticket that replaces it (a **Request changes** sets its own hold only with its box checked).
 */
export const ReleaseAction = z.enum([
  'run_now',
  'start_review',
  'request_changes',
  'skip_review',
  'cancel',
  'mark_done',
]);
export type ReleaseAction = z.infer<typeof ReleaseAction>;

/**
 * The failures a machine caused, which leave it out of the scheduler's choice for the ticket (07,
 * section 4; owner's answer 3, lot 4 step A): the run's failure reason, or a start the machine did
 * not confirm in time or refused.
 */
export const MachineFailureCause = z.enum([
  'machine_offline',
  'machine_revoked',
  'claude_code_unsupported',
  'machine_problem',
  'dispatch_timeout',
  'dispatch_refused',
]);
export type MachineFailureCause = z.infer<typeof MachineFailureCause>;

/**
 * A resume of a paused run that its machine did not confirm in time or refused: the scheduler
 * does not resume the run again until that machine connects again after `at`, or the owner's
 * **Resume** (07, sections 4 and 5.2; lot 4 step E).
 */
export const ResumeLeftOut = z.object({
  cause: z.enum(['dispatch_timeout', 'dispatch_refused']),
  at: z.iso.datetime(),
});
export type ResumeLeftOut = z.infer<typeof ResumeLeftOut>;

/** One run of the ticket that a machine caused to fail, and when it ended. */
export const MachineFailure = z.object({
  cause: MachineFailureCause,
  at: z.iso.datetime(),
  runId: z.uuid(),
});
export type MachineFailure = z.infer<typeof MachineFailure>;

/**
 * The ticket's failures in a row on each machine (07, section 4): kept until a run of the ticket
 * ends otherwise, or the owner's **Run now** (**Start review**). A machine is left out for the
 * ticket from its latest failure until it connects again; `asked` is set once the failures reach
 * **Machine failures before asking you** (its value then, `limit`): the blocking item
 * "<ticket> could not start on <machine>", until a new run of the ticket starts.
 */
export const TicketMachineFailures = z.array(
  z.object({
    machineId: z.uuid(),
    failures: z.array(MachineFailure).min(1),
    asked: z.object({ at: z.iso.datetime(), limit: z.int().positive() }).nullable(),
  }),
);
export type TicketMachineFailures = z.infer<typeof TicketMachineFailures>;
