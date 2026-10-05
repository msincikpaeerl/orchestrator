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
 * was cancelled or timed out, `no_ci` when none appeared within **Wait for CI to start**.
 */
export const CiState = z.enum(['pending', 'passed', 'failed', 'no_ci']);
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
