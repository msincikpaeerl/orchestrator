import { schema } from '@orchestrator/db';
import { isTicketBranchName } from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import type { Executor } from '../database.js';
import type { GitHubRefusal } from '../github/answers.js';
import type { GitHubClient } from '../github/client.js';
import { deleteBranch } from '../github/pull-requests.js';

// The one function of the product that deletes a branch on GitHub (owner's answer 5, lot 3 step
// J); `test/branch-delete-callers.test.ts` checks that it is the only caller of `deleteBranch`
// outside the owner's smoke script. Whatever its caller checked before, it reads the ticket and
// its project again and refuses by itself what must never be deleted.

/** What the function refuses by itself, before any request. */
export type OwnRefusal = 'default_branch' | 'base' | 'not_a_ticket_branch' | 'merge_not_recorded';

export type TicketBranchDeletion =
  | { ok: true; value: 'deleted' | 'already_gone' }
  | { ok: false; own: OwnRefusal }
  | { ok: false; refusal: GitHubRefusal };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Why `branch` must not be deleted for this ticket, from the facts given; null when nothing
 * stands in the way. The default branch and the pull request's base (`base`, and the base the
 * merge went into) are compared without case; the name must be the ticket's own branch name
 * (`t/<number>…`); the ticket's merge into the project's default branch must be recorded.
 */
export function ownRefusal(input: {
  branch: string;
  base: string;
  ticket: {
    number: number;
    pullRequestMergedAt: Date | null;
    pullRequestMergedInto: string | null;
  };
  defaultBranch: string | null;
}): OwnRefusal | null {
  const { branch, ticket, defaultBranch } = input;
  if (defaultBranch !== null && same(branch, defaultBranch)) return 'default_branch';
  if (same(branch, input.base)) return 'base';
  if (ticket.pullRequestMergedInto !== null && same(branch, ticket.pullRequestMergedInto)) {
    return 'base';
  }
  if (!isTicketBranchName(branch, ticket.number)) return 'not_a_ticket_branch';
  if (
    defaultBranch === null ||
    ticket.pullRequestMergedAt === null ||
    ticket.pullRequestMergedInto !== defaultBranch
  ) {
    return 'merge_not_recorded';
  }
  return null;
}

/**
 * Deletes the ticket's branch on GitHub after its pull request's merge into the default branch.
 * `base` is the pull request's base as GitHub gave it. The ticket and its project are read
 * again in `db` first; GitHub's "already gone" is accepted.
 */
export async function deleteMergedTicketBranch(
  db: Executor,
  client: GitHubClient,
  input: { ticketId: string; branch: string; base: string },
): Promise<TicketBranchDeletion> {
  const [row] = await db
    .select({ ticket: schema.tickets, project: schema.projects })
    .from(schema.tickets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
    .where(eq(schema.tickets.id, input.ticketId));
  if (!row) return { ok: false, own: 'merge_not_recorded' };
  const refusal = ownRefusal({
    branch: input.branch,
    base: input.base,
    ticket: row.ticket,
    defaultBranch: row.project.defaultBranch,
  });
  if (refusal !== null) return { ok: false, own: refusal };
  const repo = { owner: row.project.repoOwner, name: row.project.repoName };
  const deleted = await deleteBranch(client, repo, input.branch);
  return deleted.ok ? deleted : { ok: false, refusal: deleted.refusal };
}
