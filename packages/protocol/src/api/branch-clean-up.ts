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
 *
 * On a machine (lot 3 step J2b), besides `ticket_reopened`, `another_pull_request` and
 * `not_a_ticket_branch` (the daemon's own check of the name):
 *
 * - `local_head_differs`: the local branch's head is `head`, not the merged head (commits not
 *   pushed, or the branch moved).
 * - `bare_head`: the bare clone's `HEAD` names it, which nothing changes by itself. A worktree
 *   having it or a run of the repository active is not a reason to keep it: the machine is asked
 *   again (`MachineBranchCleanUp.busy`).
 * - `machine_revoked`: the machine was revoked before it was asked.
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
  z.object({ kind: z.literal('local_head_differs'), head: z.string() }),
  z.object({ kind: z.literal('bare_head') }),
  z.object({ kind: z.literal('machine_revoked') }),
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

/** Why a machine answered that the branch is in use, a wait and not a decision (lot 3 step J2b). */
export const MachineBusy = z.enum(['worktree', 'run']);
export type MachineBusy = z.infer<typeof MachineBusy>;

/**
 * What a machine's clean-up waits for, while wanted (lot 3 step J2b):
 *
 * - `runs_ending`: a run of the ticket on it has not reported its end (`waitingFor` says which);
 * - `offline`: it is offline, and gets the message at its reconnection (`offlineSince`);
 * - `daemon_outdated`: its daemon is of an earlier protocol, which cannot be asked; it gets the
 *   message once its daemon is updated;
 * - `busy`: the machine answered that a worktree has the branch or a run of the repository was
 *   working (`busy` says which); it is asked again, with a new message, at the next check;
 * - `next_check`: nothing left to wait for; it is sent at the next check (**GitHub check
 *   interval**);
 * - `answer`: the message was sent (`sentAt`), its answer is awaited.
 */
export const MachineCleanUpWait = z.enum([
  'runs_ending',
  'offline',
  'daemon_outdated',
  'busy',
  'next_check',
  'answer',
]);
export type MachineCleanUpWait = z.infer<typeof MachineCleanUpWait>;

/** The ticket branch's clean-up on one machine whose runs had it (lot 3 step J2b). */
export const MachineBranchCleanUp = z.object({
  machine: z.object({ id: z.uuid(), name: z.string() }),
  /** `already_gone`: the machine had no such branch, or no clone of the repository. */
  state: BranchCleanUpState,
  decidedAt: z.iso.datetime().nullable(),
  reason: BranchKeptReason.nullable(),
  /** While wanted: what it waits for; null once decided. */
  waiting: MachineCleanUpWait.nullable(),
  /** While wanted and the machine is offline: since when. */
  offlineSince: z.iso.datetime().nullable(),
  /** When the message was last sent; null before. */
  sentAt: z.iso.datetime().nullable(),
  /**
   * While wanted: the machine's latest answer that it is busy, asked again at the next check: a
   * worktree of a waiting or paused run has the branch (`worktree`), or a run of the repository
   * was working (`run`); null otherwise.
   */
  busy: MachineBusy.nullable(),
});
export type MachineBranchCleanUp = z.infer<typeof MachineBranchCleanUp>;

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
  /** The same merge's clean-up on each machine whose runs had the branch (lot 3 step J2b). */
  machines: z.array(MachineBranchCleanUp),
});
export type TicketBranchCleanUp = z.infer<typeof TicketBranchCleanUp>;
