import { z } from 'zod';
import { RepositoryName } from '../api/projects.js';
import { TicketReference } from '../api/tickets.js';
import { message } from './envelope.js';
import { GitBranchName, GitHash, RepositoryOwner } from './git.js';

// The clean-up of a ticket branch on a machine after its pull request's merge (05, section 4.11;
// lot 3 step J2b). The server says what was merged; the daemon decides nothing from that alone:
// it checks the name, the bare clone and the runs itself, and deletes only a branch still at the
// merged head.

/**
 * `branch.delete`, server to daemon (protocol 2): delete the local ticket branch of `ticket` in
 * the repository's bare clone if its head is `mergedHead`. Sent once that machine's runs of the
 * ticket reported their end; the same message (same id) again when its answer did not come, and
 * the daemon applies it once.
 */
export const BranchDelete = message(
  'branch.delete',
  z.object({
    repository: z.object({ owner: RepositoryOwner, name: RepositoryName }),
    ticket: TicketReference,
    branch: GitBranchName,
    mergedHead: GitHash,
  }),
);
export type BranchDelete = z.infer<typeof BranchDelete>;

/**
 * What the daemon did with a `branch.delete`, as facts:
 *
 * - `deleted`: the branch was at the merged head and is deleted.
 * - `not_found`: the machine has no bare clone of the repository (`repository`), or no such
 *   branch in it (`branch`).
 * - `kept`: the branch's head is `head`, not the merged head (commits not pushed, or moved).
 * - `in_use`: the bare clone's `HEAD` names it (`bare_head`), a worktree has it checked out
 *   (`worktree`), or a run of the repository is active on the machine (`run`).
 * - `not_a_ticket_branch`: the name is not the given ticket's branch name (`t/<number>…`).
 */
export const BranchDeleteAnswer = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('deleted') }),
  z.object({ outcome: z.literal('not_found'), what: z.enum(['repository', 'branch']) }),
  z.object({ outcome: z.literal('kept'), head: GitHash }),
  z.object({ outcome: z.literal('in_use'), by: z.enum(['bare_head', 'worktree', 'run']) }),
  z.object({ outcome: z.literal('not_a_ticket_branch') }),
]);
export type BranchDeleteAnswer = z.infer<typeof BranchDeleteAnswer>;

/**
 * `branch.delete_result`, daemon to server: the answer to the `branch.delete` of the same id. A
 * copy of an answered message gets the same answer again. No answer when the daemon could not
 * finish (Git failed): the server sends the message again.
 */
export const BranchDeleteResult = message('branch.delete_result', BranchDeleteAnswer);
export type BranchDeleteResult = z.infer<typeof BranchDeleteResult>;
