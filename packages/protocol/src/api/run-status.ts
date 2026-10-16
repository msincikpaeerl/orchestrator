import { z } from 'zod';

// Run statuses and failure reasons on their own, so that tickets (the board's active run, the CI
// line) and runs share them without importing each other.

/** Status of a run on the server (01, section 3.7; 05, section 4.7 for the daemon's states). */
export const RunStatus = z.enum([
  'queued',
  'dispatched',
  'starting',
  'running',
  'waiting_human',
  'paused_quota',
  'succeeded',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatus>;

/**
 * A run not ended yet: at most one per ticket (01, invariant 2). A paused run keeps its session
 * and worktree on its machine, so it counts too.
 */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'dispatched',
  'starting',
  'running',
  'waiting_human',
  'paused_quota',
];

/**
 * Runs using their Claude account now, counted against its maximum concurrent runs (01,
 * invariant 3): waiting and paused runs do not count (04, section 6; 07, section 5.2).
 */
export const ACCOUNT_BUSY_RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'dispatched',
  'starting',
  'running',
];

/** Why a run is `paused_quota` (01, section 3.7; 05, section 4.10). */
export const PauseReason = z.enum(['usage_limit', 'suspected_usage_limit']);
export type PauseReason = z.infer<typeof PauseReason>;

/** Why a run failed or was cancelled (01, section 3.7). */
export const FailureReason = z.enum([
  'timeout',
  'crash',
  'agent_gave_up',
  'dod_failed',
  'machine_offline',
  'machine_revoked',
  'claude_code_unsupported',
  'machine_problem',
  'cancelled',
  /** One CI failure more than **Most CI failures per run** (lot 3). */
  'ci_failed',
  /** **CI wait at submission** reached (lot 3). */
  'ci_timeout',
  /** The branch head moved during a review run (lot 3). */
  'review_branch_moved',
  /** The push at a submission failed: refused, diverged or GitHub unreachable (lot 3 step F). */
  'push_failed',
  /**
   * Every failed check of the submitted commit is a workflow run GitHub cancelled, and the pull
   * request's head is another commit: the branch moved on GitHub (lot 3 step G2b).
   */
  'ci_cancelled',
  /**
   * The project could not be downloaded from GitHub at the run's start: GitHub unreachable, the
   * credential refused, or **Longest push** reached (lot 3 step K2).
   */
  'download_failed',
]);
export type FailureReason = z.infer<typeof FailureReason>;
