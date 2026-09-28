import { z } from 'zod';

// Run statuses on their own, so that tickets (the board's active run) and runs share them
// without importing each other.

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
