import { z } from 'zod';
import { PullRequestFailureReason } from './pull-requests.js';
import { GitHash } from '../daemon/git.js';
import { FailureReason } from './run-status.js';

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

/**
 * The post as the screens show it: its outcome, or `posting` while it is wanted and has none yet
 * ("Posting on GitHub…"; owner's answer 4, lot 3 step H4).
 */
export const ReviewPostView = z.union([
  ReviewPost,
  z.object({ state: z.literal('posting'), pullRequest: z.int().positive() }),
]);
export type ReviewPostView = z.infer<typeof ReviewPostView>;

/** Where a review run found the head moved (lot 3 step H4, owner's answer 3). */
export const ReviewMoved = z.enum(['before_start', 'machine', 'github']);
export type ReviewMoved = z.infer<typeof ReviewMoved>;

/**
 * Why a review run ended without a decision applied, as facts the screens word (owner's answers
 * 2 and 3, lot 3 step H4): Quality gave up (its reason); the pull request changed on GitHub
 * before the review started or at a decision (its head then, when known); the branch changed on
 * the machine; the owner's **Stop run**; any other failure of the run.
 */
export const ReviewEnd = z.discriminatedUnion('why', [
  z.object({ why: z.literal('gave_up'), reason: z.string().nullable() }),
  z.object({ why: z.literal('moved_before_start'), head: GitHash.nullable() }),
  z.object({ why: z.literal('moved_on_github'), head: GitHash.nullable() }),
  z.object({ why: z.literal('moved_on_machine') }),
  z.object({ why: z.literal('stopped') }),
  z.object({ why: z.literal('failed'), failureReason: FailureReason }),
]);
export type ReviewEnd = z.infer<typeof ReviewEnd>;

/**
 * A review run's review card (02, section 7; lot 3 step H4): the commit reviewed, Quality's
 * decision (agent text, credentials masked), whether it was applied, why not, and its post.
 */
export const RunReview = z.object({
  commit: GitHash.nullable(),
  /** The ticket's pull request. */
  pullRequest: z.int().positive().nullable(),
  decision: ReviewDecision.nullable(),
  applied: z.boolean(),
  /** The run ended without a decision applied; null while it is active, or once applied. */
  notApplied: ReviewEnd.nullable(),
  post: ReviewPostView.nullable(),
});
export type RunReview = z.infer<typeof RunReview>;

const MachineRef = z.object({ id: z.uuid(), name: z.string() });

/**
 * The ticket's latest review, for its page (02, section 6.4; owner's answer 4, lot 3 step H4):
 * a review run working, Quality's decision applied, a review run that did not finish (shown only
 * while the ticket is in review, about the work in review), or the owner's **Skip review**. A
 * review run the owner stopped before any decision is passed over.
 */
export const TicketReviewLatest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('in_progress'), runId: z.uuid(), machine: MachineRef }),
  z.object({
    kind: z.literal('decision'),
    runId: z.uuid(),
    decision: ReviewDecision,
    post: ReviewPostView.nullable(),
  }),
  z.object({
    kind: z.literal('not_finished'),
    runId: z.uuid(),
    machine: MachineRef,
    decision: ReviewDecision.nullable(),
    end: ReviewEnd,
    endedAt: z.iso.datetime(),
  }),
  z.object({ kind: z.literal('skipped'), at: z.iso.datetime() }),
]);
export type TicketReviewLatest = z.infer<typeof TicketReviewLatest>;

export const TicketReview = z.object({
  latest: TicketReviewLatest.nullable(),
  /**
   * While the ticket is in review: the commit of the work in review (the one CI checked), and
   * whether `latest` is about an earlier submission (owner's change to answer 4). Null otherwise.
   */
  current: z.object({ commit: GitHash, earlier: z.boolean() }).nullable(),
  /** **Start review** and **Skip review** offered: in review, a pull request, no run active. */
  offered: z.boolean(),
});
export type TicketReview = z.infer<typeof TicketReview>;
