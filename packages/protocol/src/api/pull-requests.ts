import { z } from 'zod';
import { CiCheckFailureReason } from '../mcp/ci.js';

/**
 * Why the server could not open or update a ticket's pull request (04, section 3.1; lot 3 step
 * F3): GitHub not reached, no token saved or the saved one unreadable, the token refused, a
 * permission missing, the rate limit, an answer the Orchestrator cannot read (its fields named),
 * or any other refusal (GitHub's words).
 */
export const PullRequestFailureReason = z.enum([
  'unreachable',
  'no_token',
  'token_unreadable',
  'token_invalid',
  'permission_missing',
  'rate_limited',
  'unreadable',
  'refused',
]);
export type PullRequestFailureReason = z.infer<typeof PullRequestFailureReason>;

/** The latest failed attempt, kept on the ticket until one succeeds. */
export const PullRequestFailure = z.object({
  reason: PullRequestFailureReason,
  /** GitHub's words or the Orchestrator's, masked; never the token. */
  message: z.string(),
  /** `pull_requests` when GitHub names that permission (or none): shown in the token page's words. */
  permission: z.literal('pull_requests').nullable(),
  /** For `unreadable`: each field that did not fit, as a type, never a value. */
  fields: z.array(z.string()),
  /** The latest failed attempt. */
  at: z.iso.datetime(),
  /**
   * The first failed attempt since the pull request was last opened or updated, kept at each new
   * try (owner's correction, lot 3 step G1a); absent from failures kept before, which read `at`.
   */
  since: z.iso.datetime().optional(),
});
export type PullRequestFailure = z.infer<typeof PullRequestFailure>;

/** The pull request permission in the words of GitHub's token page (owner's point 2, step F3). */
export const PULL_REQUEST_PERMISSION_WORDS = 'Pull requests (Read and write)';

/**
 * A reopen of the ticket's pull request that failed (lot 3 step J3a): **Reopen pull request**, or
 * the next submission's. `branchGone`: GitHub refused it and the head branch no longer exists on
 * GitHub, so the next accepted submission opens a new pull request.
 */
export const PullRequestReopenFailure = PullRequestFailure.extend({ branchGone: z.boolean() });
export type PullRequestReopenFailure = z.infer<typeof PullRequestReopenFailure>;

/**
 * Why the watch of a project's pull requests could not read GitHub (owner's note on step J1, lot 3
 * step J3a), kept on the project as the CI wait keeps its failed check: nothing is decided for
 * the pull requests not read, until a check works again.
 */
export const PullRequestWatchFailure = z.object({
  reason: CiCheckFailureReason,
  /** GitHub's words, masked, or the Orchestrator's. */
  message: z.string(),
  /** For `unreadable`: each field that did not fit, by type, never a value. */
  fields: z.array(z.string()),
  /**
   * The watched pull requests this check could not read: their own read failed, or a failure
   * before it stopped the check (every watched one of the project when its list of open pull
   * requests failed). Never empty.
   */
  pullRequests: z.array(z.int().positive()),
  /** The first failure of this reason, and the latest. */
  since: z.iso.datetime(),
  at: z.iso.datetime(),
  /** For `rate_limited`: when GitHub said requests are allowed again, when it said. */
  retryAt: z.iso.datetime().nullable(),
});
export type PullRequestWatchFailure = z.infer<typeof PullRequestWatchFailure>;

/**
 * Who closed the ticket's pull request (lot 3 step J3a): someone on GitHub, or the Orchestrator
 * at **Cancel**, which keeps it closed until the next accepted submission of a reopened ticket.
 */
export const PullRequestClosedBy = z.enum(['github', 'orchestrator']);
export type PullRequestClosedBy = z.infer<typeof PullRequestClosedBy>;

/** A ticket's pull request as last read. */
export const PullRequestState = z.enum(['open', 'closed', 'merged']);
export type PullRequestState = z.infer<typeof PullRequestState>;

/**
 * `POST /api/projects/<key>/tickets/<number>/pull-request/try-again`: the attempt's result, once
 * made. `failure` is null when the pull request was opened or updated.
 */
export const PullRequestTryAgainResponse = z.object({
  failure: PullRequestFailure.nullable(),
  url: z.string().nullable(),
});
export type PullRequestTryAgainResponse = z.infer<typeof PullRequestTryAgainResponse>;

/**
 * `POST /api/projects/<key>/tickets/<number>/pull-request/reopen` (**Reopen pull request**, lot 3
 * step J3a): the attempt's result, once made. `failure` is null when the pull request is open
 * again, or was found merged (recorded as a merge).
 */
export const PullRequestReopenResponse = z.object({ failure: PullRequestReopenFailure.nullable() });
export type PullRequestReopenResponse = z.infer<typeof PullRequestReopenResponse>;
