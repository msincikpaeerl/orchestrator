import { z } from 'zod';

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
  at: z.iso.datetime(),
});
export type PullRequestFailure = z.infer<typeof PullRequestFailure>;

/** The pull request permission in the words of GitHub's token page (owner's point 2, step F3). */
export const PULL_REQUEST_PERMISSION_WORDS = 'Pull requests (Read and write)';

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
