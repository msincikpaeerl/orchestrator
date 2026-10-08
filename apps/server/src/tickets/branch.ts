import { schema } from '@orchestrator/db';
import {
  GitHash,
  maskSecrets,
  NotOnGitHub,
  PushFailureReason,
  type PushPermission,
  type BranchReport,
  type BranchWhere,
  type CommitSummary,
  type PushResult,
  type TicketBranch,
} from '@orchestrator/protocol';
import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../database.js';
import { recordEvent } from '../events.js';
import type { ProjectRow } from '../projects/model.js';
import { reportedCommits, type RunRow } from '../runs/model.js';
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

/**
 * The permission a refused push lacked, from GitHub's own words (lot 3 step E3, the owner's run):
 * "Write access to repository not granted." without Contents write, and "... without `workflow`
 * scope" for a change under `.github/workflows/` without Workflows write, which GitHub words that
 * way even for a fine-grained token. Null for any other refusal.
 */
export function pushPermission(message: string): PushPermission | null {
  if (/without `workflow` scope/.test(message)) return 'workflows';
  if (/Write access to repository not granted/.test(message)) return 'contents';
  return null;
}

/** A branch report: the commits listed, and what the machine said was not on GitHub. */
export interface ReportedBranch {
  commits: readonly CommitSummary[];
  notOnGitHub: NotOnGitHub | null;
}

/** A run's stored report. */
export function runReport(run: Pick<RunRow, 'commits' | 'notOnGitHub'>): ReportedBranch {
  return {
    commits: reportedCommits(run) ?? [],
    notOnGitHub: run.notOnGitHub === null ? null : NotOnGitHub.parse(run.notOnGitHub),
  };
}

/**
 * The commits of a report that are only on its machine (07, section 3; lot 3 step D3): those the
 * machine said were on no branch fetched from GitHub, and no push held, newest first. A machine
 * that said nothing (protocol 1, runs of 0.3.0): every commit no push held. `count` adds the
 * commits beyond the report's ceiling the machine counted: the server knows nothing about them,
 * so they are not on GitHub.
 */
export function commitsNotOnGitHub(
  ticket: Pick<TicketRow, 'githubBranchCommits'>,
  report: ReportedBranch,
): { commits: CommitSummary[]; count: number } {
  const pushed = pushedCommits(ticket);
  if (report.notOnGitHub === null) {
    const commits = report.commits.filter((commit) => !pushed.has(commit.hash));
    return { commits, count: commits.length };
  }
  const listed = report.notOnGitHub.listed.filter((hash) => !pushed.has(hash));
  const held = new Set(listed);
  const beyond = report.notOnGitHub.count - report.notOnGitHub.listed.length;
  return {
    commits: report.commits.filter((commit) => held.has(commit.hash)),
    count: listed.length + beyond,
  };
}

/** The branch's state on the ticket page (02, section 6.4). */
export function branchWhere(
  ticket: Pick<TicketRow, 'githubBranchHead' | 'branchPushFailure'>,
  report: ReportedBranch,
  notOnGitHub: number,
): BranchWhere {
  const onGitHub = report.commits.length > notOnGitHub || ticket.githubBranchHead !== null;
  if (notOnGitHub === 0) return onGitHub ? 'github' : 'no_commits';
  if (pushFailure(ticket)?.reason === 'diverged') return 'diverged';
  return onGitHub ? 'machine_ahead' : 'machine';
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
  // The branch as the last run that reported it saw it, on that run's machine. A review run
  // reports GitHub's head, never work of its machine: it never changes where the work is.
  const [reported] = await executor
    .select({ run: schema.runs, machineName: schema.machines.name })
    .from(schema.runs)
    .innerJoin(schema.machines, eq(schema.machines.id, schema.runs.machineId))
    .where(
      and(
        eq(schema.runs.ticketId, ticket.id),
        isNotNull(schema.runs.commits),
        ne(schema.runs.purpose, 'review'),
      ),
    )
    .orderBy(desc(schema.runs.createdAt))
    .limit(1);
  const report: ReportedBranch = reported
    ? runReport(reported.run)
    : { commits: [], notOnGitHub: null };
  const notOnGitHub = commitsNotOnGitHub(ticket, report);
  const failure = notOnGitHub.count > 0 ? pushFailure(ticket) : null;

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
    where: branchWhere(ticket, report, notOnGitHub.count),
    machine: reported ? { id: reported.run.machineId, name: reported.machineName } : null,
    head: reported?.run.branchHead ?? null,
    commits: [...report.commits],
    notOnGitHub: notOnGitHub.commits.map((commit) => commit.hash),
    notOnGitHubCount: notOnGitHub.count,
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
