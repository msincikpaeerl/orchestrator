import { z } from 'zod';
import { GitHash } from '../daemon/git.js';
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

/**
 * GitHub's conflict fact on the ticket's pull request (lot 3 step J3b): a read of the pull request
 * by itself answered `mergeable` false for `head` against `base`. Kept until GitHub answers
 * `mergeable` true, or the head moves; `mergeable` null (GitHub still computing) or a failed read
 * changes nothing. `since`: the first read saying so for this head.
 */
export const PullRequestConflict = z.object({
  head: GitHash,
  base: z.string(),
  since: z.iso.datetime(),
});
export type PullRequestConflict = z.infer<typeof PullRequestConflict>;

/** At most this many commit titles of a moved head are listed (owner's answer 3, step J). */
export const MOVED_HEAD_TITLES_MAX = 5;
/** Each listed title is cut to this many characters, with `…` (owner's answer 3, step J). */
export const MOVED_HEAD_TITLE_MAX_CHARS = 72;

/**
 * The one comparison of the commit Quality approved (or whose review the owner skipped) with the
 * pull request's head, when the head moved (owner's answer 3 of step J, lot 3 step J3b):
 * - `ahead`: the head holds the approved commit and `more` + listed commits after it; `titles`,
 *   the newest at most `MOVED_HEAD_TITLES_MAX`, newest first, each the first line of its
 *   message, plain text, credentials masked, cut to `MOVED_HEAD_TITLE_MAX_CHARS`;
 * - `not_part`: any other status of GitHub's (`diverged`, `behind`; history rewritten): the
 *   approved commit is no longer part of the pull request;
 * - `failed`: GitHub could not compare them (the reason, as a failed check keeps it); not tried
 *   again for the same two commits.
 */
export const HeadComparisonResult = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ahead'),
    titles: z.array(z.string()).max(MOVED_HEAD_TITLES_MAX),
    more: z.int().min(0),
  }),
  z.object({ kind: z.literal('not_part'), status: z.enum(['diverged', 'behind', 'identical']) }),
  z.object({ kind: z.literal('failed'), reason: CiCheckFailureReason, message: z.string() }),
]);
export type HeadComparisonResult = z.infer<typeof HeadComparisonResult>;

/** The comparison as kept on the ticket: of `approved...head`, made `at`. */
export const HeadComparison = z.object({
  approved: GitHash,
  head: GitHash,
  at: z.iso.datetime(),
  result: HeadComparisonResult,
});
export type HeadComparison = z.infer<typeof HeadComparison>;

/**
 * The pull request's head moved after the approval (owner's answer 3 of step J, lot 3 step J3b),
 * on **Awaiting merge**: the commit Quality approved (`approved`) or whose review the owner
 * skipped (`skipped`), GitHub's head as last read, and the comparison (null until it is made, at
 * the next check).
 */
export const PullRequestHeadMoved = z.object({
  after: z.enum(['approved', 'skipped']),
  commit: GitHash,
  head: GitHash,
  comparison: HeadComparisonResult.nullable(),
});
export type PullRequestHeadMoved = z.infer<typeof PullRequestHeadMoved>;
