import { z } from 'zod';
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
