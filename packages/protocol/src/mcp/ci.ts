import { z } from 'zod';
import { boundedText } from '../text-limits.js';

/*
 * The CI result of a pull request's head commit (04, section 3.1; 06, section 4.1), as `ci_status`
 * returns it: every GitHub Actions workflow run of that commit, plus its commit statuses
 * (fine-grained tokens cannot read the Checks API, 02 section 3.1).
 */

/**
 * The whole result: `pending` while one is not completed, `passed` when all are completed and
 * successful (skipped or neutral count as passed), `failed` when all are completed and one failed,
 * was cancelled or timed out (any other conclusion too: the safe side), `no_ci` when none appeared
 * within **Wait for CI to start** and the pull request has no conflict, `conflict` when none
 * appeared and the pull request conflicts with its base branch: GitHub starts no `pull_request`
 * run then (A18; lot 3 step G1, owner's addition). `conflict` never passes.
 */
export const CiState = z.enum(['pending', 'passed', 'failed', 'no_ci', 'conflict']);
export type CiState = z.infer<typeof CiState>;

/** One workflow run or commit status of the head commit. */
export const CiCheck = z.object({
  kind: z.enum(['workflow_run', 'status']),
  /** The workflow's name, or the status's context. */
  name: z.string(),
  state: z.enum(['pending', 'passed', 'failed']),
  /** GitHub's page for it, when GitHub gives one. */
  url: z.url().nullable(),
});
export type CiCheck = z.infer<typeof CiCheck>;

/** A failed job, with its failed steps and the end of its log (**Longest CI log excerpt**). */
export const CiFailedJob = z.object({
  workflow: z.string(),
  job: z.string(),
  url: z.url().nullable(),
  failed_steps: z.array(z.string()),
  log_excerpt: boundedText(),
  /** The excerpt is the end of a longer log, or was cut further to fit the output. */
  log_cut: z.boolean(),
});
export type CiFailedJob = z.infer<typeof CiFailedJob>;

export const CiResult = z.object({
  state: CiState,
  checks: z.array(CiCheck),
  /** Empty unless `failed`: at most one excerpt per failed job. */
  failed_jobs: z.array(CiFailedJob),
});
export type CiResult = z.infer<typeof CiResult>;

/**
 * Why GitHub could not be checked for a run's CI (lot 3 step G1a): no answer or a server error,
 * the request limit, an answer that cannot be read (its fields named), no saved token or one that
 * cannot be used, a permission missing (Actions or Commit statuses read), any other refusal.
 * The run keeps waiting: only **CI wait at submission** ends it.
 */
export const CiCheckFailureReason = z.enum([
  'unreachable',
  'rate_limited',
  'unreadable',
  'token',
  'permission_missing',
  'refused',
]);
export type CiCheckFailureReason = z.infer<typeof CiCheckFailureReason>;

/** The latest failed check of a run's CI, until a check works again. */
export const CiCheckFailure = z.object({
  reason: CiCheckFailureReason,
  /** GitHub's words, masked, or the Orchestrator's. */
  message: z.string(),
  /** For `unreadable`: each field that did not fit, by type, never a value. */
  fields: z.array(z.string()),
  /** The first failure of this reason, and the latest. */
  since: z.iso.datetime(),
  at: z.iso.datetime(),
  /** For `rate_limited`: when GitHub said requests are allowed again, when it said. */
  retryAt: z.iso.datetime().nullable(),
});
export type CiCheckFailure = z.infer<typeof CiCheckFailure>;
