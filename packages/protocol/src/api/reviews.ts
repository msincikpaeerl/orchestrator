import { z } from 'zod';
import { PullRequestFailureReason } from './pull-requests.js';
import { GitHash } from '../daemon/git.js';

/** One point of a request for changes, as stored: the agent's text, untrusted (06, section 4.5). */
export const ReviewPointRecord = z.object({
  body: z.string(),
  /** Path relative to the worktree root, as the agent gave it. */
  file: z.string().nullable(),
  line: z.int().positive().nullable(),
});
export type ReviewPointRecord = z.infer<typeof ReviewPointRecord>;

export const ReviewDecisionKind = z.enum(['approved', 'changes_requested']);
export type ReviewDecisionKind = z.infer<typeof ReviewDecisionKind>;

/**
 * Quality's decision in a review run, stored on the run at the review tool's call (06, section
 * 4.5; owner's answers 2c and 2d, lot 3 step H2): about one commit, applied only when the run
 * ends `submitted` with no head moved on the machine.
 */
export const ReviewDecision = z.object({
  kind: ReviewDecisionKind,
  /** The commit under review, fixed by **Start review**. */
  commit: GitHash,
  /** The approval's summary; null for a request for changes. */
  summary: z.string().nullable(),
  /** The points of a request for changes, in the agent's order; empty for an approval. */
  points: z.array(ReviewPointRecord),
  /**
   * False when GitHub could not be read at the call (unreachable, its request limit, an answer
   * that cannot be read, the token refused): the decision stands, "head not checked on GitHub at
   * the decision" (owner's change to answer 2c).
   */
  headChecked: z.boolean(),
  at: z.iso.datetime(),
});
export type ReviewDecision = z.infer<typeof ReviewDecision>;

/**
 * Why a comment review is not on GitHub (06, section 4.5; lot 3 step H3): the reasons of a pull
 * request not opened, and the three a refusal can be explained by (one read of the pull request).
 */
export const ReviewPostProblem = z.enum([
  ...PullRequestFailureReason.options,
  'head_moved',
  'pull_request_closed',
  'pull_request_merged',
]);
export type ReviewPostProblem = z.infer<typeof ReviewPostProblem>;

const ReviewPostFailure = {
  /** GitHub's words or the Orchestrator's, masked; never a token. */
  message: z.string(),
  /** `pull_requests` when GitHub names that permission (or none). */
  permission: z.literal('pull_requests').nullable(),
  /** For `unreadable`: each field that did not fit, as a type, never a value. */
  fields: z.array(z.string()),
};

/**
 * What became of Quality's comment review on GitHub, kept on its run (owner's answers 1 to 3, lot
 * 3 step H3). `not_posted` only when GitHub refused it or it never left; `not_found` when GitHub
 * did not answer and the review was not there when checked; `not_checked` when that check failed
 * too (`afterRestart`: the server stopped while posting).
 */
export const ReviewPost = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('posted'),
    pullRequest: z.int().positive(),
    reviewId: z.int().positive(),
    url: z.string(),
    at: z.iso.datetime(),
  }),
  z.object({
    state: z.literal('not_posted'),
    pullRequest: z.int().positive(),
    reason: ReviewPostProblem,
    ...ReviewPostFailure,
    /** For `head_moved`: the pull request's head when the refusal was explained. */
    head: GitHash.nullable(),
    at: z.iso.datetime(),
  }),
  z.object({
    state: z.literal('not_found'),
    pullRequest: z.int().positive(),
    /** When the reviews were read and ours was not among them. */
    checkedAt: z.iso.datetime(),
    at: z.iso.datetime(),
  }),
  z.object({
    state: z.literal('not_checked'),
    pullRequest: z.int().positive(),
    afterRestart: z.boolean(),
    reason: PullRequestFailureReason,
    ...ReviewPostFailure,
    at: z.iso.datetime(),
  }),
]);
export type ReviewPost = z.infer<typeof ReviewPost>;
