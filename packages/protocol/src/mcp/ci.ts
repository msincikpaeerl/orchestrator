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
  /** A workflow run's id, to read its jobs (lot 3 step G1b); null for a status. */
  run_id: z.int().positive().nullable().default(null),
  /**
   * A workflow run GitHub concluded `cancelled` (lot 3 step G2b): when every failed check is one
   * and the pull request's head is another commit, the branch moved, not the agent's failure.
   */
  cancelled: z.boolean().default(false),
});
export type CiCheck = z.infer<typeof CiCheck>;

/**
 * Why a failed step's excerpt is the end of the job's log instead of the step's own part (04,
 * section 3.1): GitHub names no failed step in the job, gave no times for the step, the log is
 * larger than **Longest CI log read**, its lines carry no timestamp, no line falls within the
 * step's times, or no `##[error]` line does.
 */
export const CiLogFallback = z.enum([
  'no_failed_step',
  'no_times',
  'ceiling',
  'no_timestamps',
  'outside_window',
  'no_error',
]);
export type CiLogFallback = z.infer<typeof CiLogFallback>;

/** One failed step's part of its job's log, secrets masked, at most **Longest CI log excerpt**. */
export const CiExcerpt = z.object({
  /** The step's name; empty when GitHub names no failed step in the job. */
  step: z.string(),
  /** Null: the step's own part; otherwise the end of the job's log, and why. */
  fallback: CiLogFallback.nullable(),
  /** For a fallback: false when only the first **Longest CI log read** was read. */
  read_to_end: z.boolean(),
  text: boundedText(),
  /** Only its end is kept. */
  cut: z.boolean(),
});
export type CiExcerpt = z.infer<typeof CiExcerpt>;

/**
 * Why something of GitHub's could not be read for `ci_status` (lot 3 step G1b): a job's log GitHub
 * no longer has (expired or deleted), GitHub unreachable or its request limit (read again later),
 * a permission missing, an answer that cannot be read, another refusal.
 */
export const CiReadProblem = z.object({
  reason: z.enum([
    'expired',
    'unreachable',
    'rate_limited',
    'permission_missing',
    'unreadable',
    'refused',
  ]),
  /** GitHub's words, masked, or the unreadable fields named; empty for `expired`. */
  message: z.string(),
  /** For `rate_limited`: when GitHub allows requests again, when it said. */
  retry_at: z.iso.datetime().nullable(),
  /** When it happened: `unreachable` and `rate_limited` are tried again after an interval. */
  at: z.iso.datetime(),
});
export type CiReadProblem = z.infer<typeof CiReadProblem>;

/**
 * What became of a failed job's log: read (an excerpt per failed step), not readable, or not read
 * because more failed jobs than the output has room for came before it (owner's answer 3, G1b).
 */
export const CiJobLog = z.discriminatedUnion('state', [
  z.object({ state: z.literal('read'), excerpts: z.array(CiExcerpt) }),
  z.object({ state: z.literal('unavailable'), problem: CiReadProblem }),
  z.object({ state: z.literal('not_read') }),
]);
export type CiJobLog = z.infer<typeof CiJobLog>;

/** A failed job of a failed workflow run, with its failed steps and what its log gave. */
export const CiFailedJob = z.object({
  workflow: z.string(),
  job: z.string(),
  url: z.url().nullable(),
  failed_steps: z.array(z.string()),
  log: CiJobLog,
});
export type CiFailedJob = z.infer<typeof CiFailedJob>;

export const CiResult = z.object({
  state: CiState,
  checks: z.array(CiCheck),
  /** Every failed job of the failed workflow runs, in GitHub's order, once they were listed. */
  failed_jobs: z.array(CiFailedJob),
  /**
   * Whether the failed jobs were listed (lot 3 step G1b): false until `ci_status` first reads them
   * for a `failed` result, or while listing them failed (`jobs_problem`).
   */
  jobs_read: z.boolean().default(false),
  jobs_problem: CiReadProblem.nullable().default(null),
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

/**
 * `ci_status`'s answer (06, section 4.1; owner's answers, lot 3 step G1b): the CI result of one
 * accepted submission's commit, named, with when it was read on GitHub and sentences for the agent
 * (`note`, each step's `about`) from the template `ci-status`.
 */
export const McpCiStatus = z.object({
  /** The accepted submission's commit; null when no work of the ticket was accepted yet. */
  commit: z
    .object({
      hash: z.string(),
      by: z.enum(['this_run', 'earlier_run']),
      attempt: z.int().positive(),
      submitted_at: z.iso.datetime(),
    })
    .nullable(),
  pull_request: z.object({ number: z.int().positive(), url: z.url(), head: z.string() }).nullable(),
  /** When the result was read on GitHub; null when there is none. */
  read_at: z.iso.datetime().nullable(),
  /** What the answer is about, and what to do with it. */
  note: z.string(),
  ci: z
    .object({
      state: CiState,
      checks: z.array(CiCheck.omit({ run_id: true, cancelled: true })),
      /** The failed jobs whose log was read or could not be read, in GitHub's order. */
      failed_jobs: z.array(
        z.object({
          workflow: z.string(),
          job: z.string(),
          url: z.url().nullable(),
          failed_steps: z.array(
            z.object({
              step: z.string(),
              /** What the log below is, or why there is none. */
              about: z.string(),
              log: z.string().nullable(),
            }),
          ),
        }),
      ),
      /** Failed jobs whose log was not read: too many failed jobs to show (G1b, answer 3). */
      logs_not_read: z.object({
        count: z.int().min(0),
        jobs: z.array(
          z.object({
            workflow: z.string(),
            job: z.string(),
            url: z.url().nullable(),
            failed_steps: z.array(z.string()),
          }),
        ),
      }),
    })
    .nullable(),
});
export type McpCiStatus = z.infer<typeof McpCiStatus>;

/**
 * One CI round of a run (04, section 3.1; lot 3 step G2b): a failed result or a conflict sent
 * back to the agent with `run.input` (`run.resume` when its session is closed), the base branch
 * downloaded first for a conflict (`fetchBase`). It counts within **Most CI failures per run**
 * once the machine confirmed the message (`confirmedAt`); until then it is the run's one
 * unanswered round, sent again with the same `messageId` after **Machine answer timeout** plus
 * **Longest push**, which the daemon recognises and never gives twice. A round the machine refused
 * is not kept: the next check decides again. `result` is what the agent received, with its
 * excerpts, kept on the run (owner's answer 6).
 */
export const CiRound = z.object({
  /** From 1: the confirmed rounds before it, plus one. */
  round: z.int().positive(),
  kind: z.enum(['failed', 'conflict']),
  commit: z.string(),
  messageId: z.uuid(),
  via: z.enum(['input', 'resume']),
  decidedAt: z.iso.datetime(),
  /** When the message was last sent; null while the machine could not be reached. */
  sentAt: z.iso.datetime().nullable(),
  confirmedAt: z.iso.datetime().nullable(),
  result: CiResult,
  /** When `result` was read on GitHub. */
  readAt: z.iso.datetime(),
});
export type CiRound = z.infer<typeof CiRound>;

/** The latest refusal of a round by the machine (a failed download of the base branch, say). */
export const CiRoundRefusal = z.object({
  kind: z.enum(['failed', 'conflict']),
  message: z.string(),
  at: z.iso.datetime(),
});
export type CiRoundRefusal = z.infer<typeof CiRoundRefusal>;
