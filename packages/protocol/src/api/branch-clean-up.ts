import { z } from 'zod';

// The clean-up after a merge (04, section 4; owner's answer 5 of lot 3 step J and the answers of
// step J2): the ticket branch deleted on GitHub, then on the machines, once per recorded merge.

/**
 * A ticket branch's name: `t/<number>` or `t/<number>-<slug>` (04, section 4), the slug in lower
 * case letters, digits and single hyphens. With `ticket`, only that ticket's: `t/1` never matches
 * `t/12` or `t/1-something` of ticket 12.
 */
export function isTicketBranchName(name: string, ticket?: number): boolean {
  const match = /^t\/([1-9][0-9]*)(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/.exec(name);
  if (!match) return false;
  return ticket === undefined || match[1] === String(ticket);
}

/**
 * Why a ticket branch was kept on GitHub after its merge, as facts; the words are the screens'.
 *
 * - `ticket_reopened`: the ticket is no longer `done`.
 * - `another_pull_request`: the ticket's recorded merge is no longer this pull request's (another
 *   pull request recorded, `number`, or none).
 * - `not_merged_into_default`: GitHub's pull request is not merged, or into `base`, not the
 *   project's default branch.
 * - `head_branch_differs`: the pull request's head branch is `headBranch`, not the ticket's.
 * - `fork`: the pull request's head repository is `headRepository` (null: deleted), not the
 *   project's.
 * - `default_branch_changed`: GitHub's default branch is `github`, the project's is `stored`.
 * - `protected_name`: the branch is the default branch or the pull request's base.
 * - `not_a_ticket_branch`: the name is not this ticket's branch name.
 * - `used_as_head`, `used_as_base`: an open pull request uses it.
 * - `moved`: its head on GitHub is `head`, not the merged head: commits pushed after the merge.
 * - `ref_differs`: GitHub answered for `ref`, not exactly `refs/heads/<branch>`.
 * - `read_failed`: a read GitHub refused or answered in a way that cannot be read (`what` read,
 *   GitHub's `message`).
 * - `refused`: GitHub refused the deletion (a protected branch, for example), with its words.
 */
export const BranchKeptReason = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ticket_reopened') }),
  z.object({ kind: z.literal('another_pull_request'), number: z.int().positive().nullable() }),
  z.object({ kind: z.literal('not_merged_into_default'), merged: z.boolean(), base: z.string() }),
  z.object({ kind: z.literal('head_branch_differs'), headBranch: z.string() }),
  z.object({ kind: z.literal('fork'), headRepository: z.string().nullable() }),
  z.object({ kind: z.literal('default_branch_changed'), github: z.string(), stored: z.string() }),
  z.object({ kind: z.literal('protected_name'), which: z.enum(['default_branch', 'base']) }),
  z.object({ kind: z.literal('not_a_ticket_branch') }),
  z.object({ kind: z.literal('used_as_head'), pullRequest: z.int().positive() }),
  z.object({ kind: z.literal('used_as_base'), pullRequest: z.int().positive() }),
  z.object({ kind: z.literal('moved'), head: z.string() }),
  z.object({ kind: z.literal('ref_differs'), ref: z.string() }),
  z.object({
    kind: z.literal('read_failed'),
    what: z.enum(['pull_request', 'open_pull_requests', 'branch']),
    message: z.string(),
  }),
  z.object({ kind: z.literal('refused'), message: z.string() }),
]);
export type BranchKeptReason = z.infer<typeof BranchKeptReason>;

/**
 * A clean-up's state: `wanted` until done (it may wait for the end of stopped runs first), then
 * `deleted`, `already_gone` (GitHub had no such branch any more) or `kept` with its reason.
 */
export const BranchCleanUpState = z.enum(['wanted', 'deleted', 'already_gone', 'kept']);
export type BranchCleanUpState = z.infer<typeof BranchCleanUpState>;

/**
 * A try that could not end (GitHub unreachable or answering a server error, the request limit,
 * the token refused or a permission missing): tried again at the next check.
 */
export const BranchCleanUpFailure = z.object({
  reason: z.enum(['unreachable', 'rate_limited', 'token', 'permission_missing']),
  message: z.string(),
  at: z.iso.datetime(),
});
export type BranchCleanUpFailure = z.infer<typeof BranchCleanUpFailure>;

/** A push of the branch the server recorded after the branch was deleted (owner's answer 2). */
export const BranchPushedAgain = z.object({
  machine: z.string(),
  head: z.string(),
  at: z.iso.datetime(),
});
export type BranchPushedAgain = z.infer<typeof BranchPushedAgain>;

/** A run stopped earlier whose end the clean-up waits for: its machine and since when offline. */
export const BranchCleanUpWait = z.object({
  runId: z.uuid(),
  machine: z.object({ id: z.uuid(), name: z.string() }),
  /** When the machine went offline; null while it is online. */
  offlineSince: z.iso.datetime().nullable(),
});
export type BranchCleanUpWait = z.infer<typeof BranchCleanUpWait>;

/** The ticket branch's clean-up on GitHub after the latest recorded merge (lot 3 step J2a). */
export const TicketBranchCleanUp = z.object({
  branch: z.string(),
  pullRequest: z.int().positive(),
  mergedHead: z.string(),
  state: BranchCleanUpState,
  /** When it was deleted, found gone or kept; null while wanted. */
  decidedAt: z.iso.datetime().nullable(),
  reason: BranchKeptReason.nullable(),
  /** While wanted: the stopped runs whose end it waits for, none when it no longer waits. */
  waitingFor: z.array(BranchCleanUpWait),
  /** While wanted: the latest try that could not end. */
  failure: BranchCleanUpFailure.nullable(),
  pushedAgain: BranchPushedAgain.nullable(),
});
export type TicketBranchCleanUp = z.infer<typeof TicketBranchCleanUp>;
