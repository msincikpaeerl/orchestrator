import { schema } from '@orchestrator/db';
import {
  GitHash,
  maskSecrets,
  PushFailureReason,
  type BranchReport,
  type BranchWhere,
  type CommitSummary,
  type PushResult,
  type TicketBranch,
} from '@orchestrator/protocol';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../database.js';
import { recordEvent } from '../events.js';
import type { ProjectRow } from '../projects/model.js';
import { reportedCommits } from '../runs/model.js';
import { ticketReference, type TicketRow } from './model.js';

/**
 * Where a ticket branch's commits are (01, section 3.4; 07, section 3; lot 3 step D3). The server
 * knows two things: the branch each run reported (its head and its commits ahead of the base), and
 * the pushes the daemon reported. It never reads GitHub's branch here, so "on GitHub" means "in a
 * push the daemon reported as done", with its date.
 */

const PushedCommits = z.array(GitHash);

const BranchPushFailure = z.object({
  at: z.iso.datetime(),
  machineId: z.uuid(),
  reason: PushFailureReason,
  message: z.string(),
});
type BranchPushFailure = z.infer<typeof BranchPushFailure>;

/** The commits a push held: those ahead of the base branch its head had, as reported with it. */
export function pushedCommits(ticket: Pick<TicketRow, 'githubBranchCommits'>): Set<string> {
  return new Set(
    ticket.githubBranchCommits === null ? [] : PushedCommits.parse(ticket.githubBranchCommits),
  );
}

export function pushFailure(
  ticket: Pick<TicketRow, 'branchPushFailure'>,
): BranchPushFailure | null {
  return ticket.branchPushFailure === null
    ? null
    : BranchPushFailure.parse(ticket.branchPushFailure);
}

/** The reported commits no push held, newest first: they exist only on the reporting machine. */
export function commitsNotOnGitHub(
  ticket: Pick<TicketRow, 'githubBranchCommits'>,
  commits: readonly CommitSummary[],
): CommitSummary[] {
  const pushed = pushedCommits(ticket);
  return commits.filter((commit) => !pushed.has(commit.hash));
}

/** The branch's state on the ticket page (02, section 6.4), from the reported commits not pushed. */
export function branchWhere(
  ticket: Pick<TicketRow, 'githubBranchHead' | 'branchPushFailure'>,
  notOnGitHub: number,
): BranchWhere {
  if (notOnGitHub === 0) return ticket.githubBranchHead === null ? 'no_commits' : 'github';
  if (pushFailure(ticket)?.reason === 'diverged') return 'diverged';
  return ticket.githubBranchHead === null ? 'machine' : 'machine_ahead';
}

/** The ticket branch's page on GitHub. */
export function branchUrl(project: Pick<ProjectRow, 'repoOwner' | 'repoName'>, branch: string) {
  const path = [project.repoOwner, project.repoName, 'tree', ...branch.split('/')]
    .map(encodeURIComponent)
    .join('/');
  return `https://github.com/${path}`;
}

/**
 * Records a push the daemon reported (05, section 4.9), at a submission or at a run's end: on the
 * run, and on the ticket as the last push done or the latest failure since. A push done holds
 * the commits of the branch report read with it, when that report has the pushed head (always,
 * as the daemon reads the head once); else only its head. Writes `run.branch_pushed` or
 * `run.branch_push_failed`.
 */
export async function recordPush(
  tx: Executor,
  input: {
    project: Pick<ProjectRow, 'id' | 'key'>;
    ticket: Pick<TicketRow, 'id' | 'number'>;
    run: { id: string; branchName: string };
    machine: { id: string; name: string };
    result: PushResult;
    branch: BranchReport | null;
    when: 'submission' | 'end';
    now: Date;
  },
): Promise<void> {
  const { result, now } = input;
  await tx
    .update(schema.runs)
    .set({ push: result, pushAt: now, updatedAt: now })
    .where(eq(schema.runs.id, input.run.id));
  const facts = {
    project: input.project.key,
    ticket: ticketReference(input.project.key, input.ticket.number),
    machine: input.machine.name,
    branch: input.run.branchName,
    at: input.when,
  };
  if (result.status === 'pushed') {
    const commits =
      input.branch?.head === result.head
        ? [...new Set([result.head, ...input.branch.commitsAhead.map((commit) => commit.hash)])]
        : [result.head];
    await tx
      .update(schema.tickets)
      .set({
        githubBranchHead: result.head,
        githubBranchPushedAt: now,
        githubBranchPushedBy: input.machine.id,
        githubBranchCommits: commits,
        branchPushFailure: null,
        updatedAt: now,
      })
      .where(eq(schema.tickets.id, input.ticket.id));
    await recordEvent(tx, {
      actor: 'system',
      entityType: 'run',
      entityId: input.run.id,
      projectId: input.project.id,
      type: 'run.branch_pushed',
      payload: { ...facts, head: result.head },
      at: now,
    });
    return;
  }
  const message = maskSecrets(result.message);
  const failure: BranchPushFailure = {
    at: now.toISOString(),
    machineId: input.machine.id,
    reason: result.reason,
    message,
  };
  await tx
    .update(schema.tickets)
    .set({ branchPushFailure: failure, updatedAt: now })
    .where(eq(schema.tickets.id, input.ticket.id));
  await recordEvent(tx, {
    actor: 'system',
    entityType: 'run',
    entityId: input.run.id,
    projectId: input.project.id,
    type: 'run.branch_push_failed',
    payload: { ...facts, reason: result.reason, message },
    at: now,
  });
}

/** The ticket branch as the ticket page shows it (02, section 6.4); null before the first run. */
export async function ticketBranch(
  executor: Executor,
  project: Pick<ProjectRow, 'repoOwner' | 'repoName'>,
  ticket: TicketRow,
): Promise<TicketBranch | null> {
  if (ticket.branchName === null) return null;
  // The branch as the last run that reported it saw it, on that run's machine.
  const [reported] = await executor
    .select({ run: schema.runs, machineName: schema.machines.name })
    .from(schema.runs)
    .innerJoin(schema.machines, eq(schema.machines.id, schema.runs.machineId))
    .where(and(eq(schema.runs.ticketId, ticket.id), isNotNull(schema.runs.commits)))
    .orderBy(desc(schema.runs.createdAt))
    .limit(1);
  const commits = reported ? (reportedCommits(reported.run) ?? []) : [];
  const notOnGitHub = commitsNotOnGitHub(ticket, commits);
  const failure = notOnGitHub.length > 0 ? pushFailure(ticket) : null;

  const ids = [ticket.githubBranchPushedBy, failure?.machineId].filter(
    (id): id is string => typeof id === 'string',
  );
  const names = new Map(
    ids.length === 0
      ? []
      : (
          await executor
            .select({ id: schema.machines.id, name: schema.machines.name })
            .from(schema.machines)
            .where(inArray(schema.machines.id, ids))
        ).map((row) => [row.id, row]),
  );
  const machineLink = (id: string | null | undefined) =>
    id === null || id === undefined ? null : (names.get(id) ?? null);

  return {
    name: ticket.branchName,
    where: branchWhere(ticket, notOnGitHub.length),
    machine: reported ? { id: reported.run.machineId, name: reported.machineName } : null,
    head: reported?.run.branchHead ?? null,
    commits,
    notOnGitHub: notOnGitHub.map((commit) => commit.hash),
    pushed:
      ticket.githubBranchHead === null || ticket.githubBranchPushedAt === null
        ? null
        : {
            head: ticket.githubBranchHead,
            at: ticket.githubBranchPushedAt.toISOString(),
            machine: machineLink(ticket.githubBranchPushedBy),
            url: branchUrl(project, ticket.branchName),
          },
    pushFailure: failure && {
      at: failure.at,
      machine: machineLink(failure.machineId),
      reason: failure.reason,
      message: failure.message,
    },
  };
}
