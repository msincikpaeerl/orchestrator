import { z } from 'zod';
import { GitHash } from '../daemon/git.js';
import { CiCheck } from '../mcp/ci.js';

// What a run's wait for CI came to, for the screens (02, sections 4, 6.4 and 7; owner's answers,
// lot 3 step G2c): the ticket page's CI line, the run page's CI card with its rounds, the "Needs
// you" item of a run ended `ci_timeout`, and **Check CI again**. The words are made by the screens
// from these facts.

/** A check as the screens show it: GitHub's run id and cancellation are the server's own. */
export const CiCheckView = CiCheck.omit({ run_id: true, cancelled: true });
export type CiCheckView = z.infer<typeof CiCheckView>;

/**
 * What a run's CI came to:
 * - `waiting`: the run waits for the result of its submitted commit;
 * - `passed`, `no_ci`: the submission was accepted (also later, by **Check CI again**);
 * - `too_many`: `ci_failed`, one failure or conflict more than **Most CI failures per run**;
 * - `not_finished`: `ci_timeout`, CI not finished, or nothing read;
 * - `not_received`: `ci_timeout` after CI failed, the agent not getting the result;
 * - `conflict`: `ci_timeout` with the pull request conflicting with its base branch;
 * - `cancelled`: `ci_cancelled`, CI cancelled on GitHub because the branch changed there;
 * - `after_round`: the run ended otherwise after a round sent back, without handing in again;
 * - `ended`: the run ended otherwise while it waited.
 */
export const RunCiOutcomeKind = z.enum([
  'waiting',
  'passed',
  'no_ci',
  'too_many',
  'not_finished',
  'not_received',
  'conflict',
  'cancelled',
  'after_round',
  'ended',
]);
export type RunCiOutcomeKind = z.infer<typeof RunCiOutcomeKind>;

/**
 * Why a failure or a conflict did not reach the agent (`not_received`, `conflict`): a round the
 * machine did not confirm, a round it refused (its masked words), or a result read on GitHub only
 * after **CI wait at submission** was reached.
 */
export const CiNotSent = z.object({
  why: z.enum(['not_confirmed', 'refused', 'read_late']),
  /** The machine's refusal, for `refused`; null otherwise. */
  message: z.string().nullable(),
});
export type CiNotSent = z.infer<typeof CiNotSent>;

/** The work accepted by **Check CI again** after the run ended (lot 3 step G2c). */
export const CiAcceptedLater = z.object({
  at: z.iso.datetime(),
  state: z.enum(['passed', 'no_ci']),
  /** After `ci_failed`: that run's failed attempt no longer counts (owner's answer 3d). */
  attemptTakenBack: z.boolean(),
});
export type CiAcceptedLater = z.infer<typeof CiAcceptedLater>;

export const RunCiOutcome = z.object({
  kind: RunCiOutcomeKind,
  /** The commit the outcome is about: the submitted one, or the last round's. */
  commit: GitHash,
  /** When its result was read on GitHub; null when none was read. */
  at: z.iso.datetime().nullable(),
  /** The latest result's checks; the screens name the failed ones. */
  checks: z.array(CiCheckView),
  /** The latest result conflicts with the base branch (`too_many`, `conflict`, `after_round`). */
  conflict: z.boolean(),
  notSent: CiNotSent.nullable(),
  /** `too_many`: the failures and conflicts counted, the last included; whether one conflicted. */
  failures: z.int().min(0),
  anyConflict: z.boolean(),
  /** `after_round`: the last round sent back. */
  round: z.int().positive().nullable(),
  /** `cancelled`: the pull request's head read at that result. */
  pullRequestHead: GitHash.nullable(),
  /** False when the pull request was never opened before the wait ended. */
  pullRequestOpened: z.boolean(),
  acceptedLater: CiAcceptedLater.nullable(),
});
export type RunCiOutcome = z.infer<typeof RunCiOutcome>;

/** One CI round of a run, as its page lists it: confirmed by the machine, or not (the last). */
export const RunCiRoundView = z.object({
  round: z.int().positive(),
  kind: z.enum(['failed', 'conflict']),
  commit: GitHash,
  /** When the result was read on GitHub. */
  readAt: z.iso.datetime(),
  confirmedAt: z.iso.datetime().nullable(),
  checks: z.array(CiCheckView),
});
export type RunCiRoundView = z.infer<typeof RunCiRoundView>;

/**
 * A run's CI as its page shows it (lot 3 step G2c): its rounds, what it came to, and the settings
 * kept on the run. Null for a run that never waited for CI.
 */
export const RunCiHistory = z.object({
  /** **Most CI failures per run** and **CI wait at submission** as the run kept them. */
  maxCiFailures: z.int().positive().nullable(),
  waitMinutes: z.int().positive().nullable(),
  base: z.string().nullable(),
  rounds: z.array(RunCiRoundView),
  outcome: RunCiOutcome.nullable(),
});
export type RunCiHistory = z.infer<typeof RunCiHistory>;

/**
 * `POST /api/projects/:key/tickets/:number/ci/check-again` (04, section 3.1; lot 3 step G2c): the
 * run whose result the owner saw, so newer work is never accepted by an older page.
 */
export const CheckCiAgainRequest = z.strictObject({ runId: z.uuid() });
export type CheckCiAgainRequest = z.infer<typeof CheckCiAgainRequest>;

/** What **Check CI again** found; a refusal is an error answer (`ci_check_refused`). */
export const CheckCiAgainResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('accepted'),
    state: z.enum(['passed', 'no_ci']),
    attemptTakenBack: z.boolean(),
  }),
  z.object({
    outcome: z.literal('not_finished'),
    finished: z.int().min(0),
    total: z.int().min(0),
    at: z.iso.datetime(),
  }),
  z.object({ outcome: z.literal('failed'), checks: z.array(CiCheckView) }),
  z.object({ outcome: z.literal('conflict'), base: z.string() }),
  z.object({ outcome: z.literal('github_problem'), message: z.string() }),
]);
export type CheckCiAgainResponse = z.infer<typeof CheckCiAgainResponse>;

/** Why **Check CI again** was refused, kept in its event. */
export const CheckCiAgainRefusal = z.enum([
  'run_active',
  'newer_work',
  'not_offered',
  'no_pull_request',
  'branch_moved',
  'pull_request_closed',
  'pull_request_merged',
]);
export type CheckCiAgainRefusal = z.infer<typeof CheckCiAgainRefusal>;

/**
 * A refusal of **Check CI again** with the facts its words need (`ci_check_refused`): the commit
 * and the branch's head for `branch_moved`, the pull request's number, the newer work's date.
 */
export const CheckCiAgainRefused = z.object({
  reason: CheckCiAgainRefusal,
  commit: z.string().optional(),
  head: z.string().optional(),
  pullRequest: z.int().positive().optional(),
  acceptedAt: z.iso.datetime().optional(),
});
export type CheckCiAgainRefused = z.infer<typeof CheckCiAgainRefused>;
