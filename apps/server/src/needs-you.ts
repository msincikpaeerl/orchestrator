import { schema } from '@orchestrator/db';
import {
  ACTIVE_RUN_STATUSES,
  CLAUDE_CODE_MIN_VERSION,
  DoctorCheck,
  DodReport,
  PullRequestFailure,
  PullRequestReopenFailure,
  SubmissionRecord,
  TicketStatus,
  TicketStop,
  WorkflowReason,
  type NeedsYouResponse,
} from '@orchestrator/protocol';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { requireSession } from './auth/routes.js';
import type { Database } from './database.js';
import { accountRows, accountsWithToday } from './machines/accounts.js';
import { daemonUpdateCommands, doctorErrors } from './machines/model.js';
import { SERVER_VERSION } from './version.js';
import { toProject } from './projects/model.js';
import { ciOutcome, ciSourceRun } from './runs/ci-outcome.js';
import { runDownload } from './runs/download.js';
import { reviewCiOf, ticketReview } from './runs/review-view.js';
import type { RunService } from './runs/service.js';
import { pushFailure, pushPermission } from './tickets/branch.js';
import { askedMachine, machineFailures } from './tickets/holds.js';
import { profileLinks, toComment, type TicketRow } from './tickets/model.js';
import { headMoved, ticketConflict, ticketWatchFailure } from './tickets/pull-request-facts.js';

type Items = NeedsYouResponse['items'];

/**
 * What agents' runs leave for the owner (02, section 4): open questions, tickets proposed by
 * agents, finished work to check and paused runs, on active projects only (archived ones start no
 * work and change nothing).
 */
async function ticketItems(db: Database, runs: RunService): Promise<Items> {
  const items: Items = [];
  const profiles = await profileLinks(db);
  const tickets = await db
    .select({ ticket: schema.tickets, projectKey: schema.projects.key })
    .from(schema.tickets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
    .where(
      and(
        eq(schema.projects.status, 'active'),
        inArray(schema.tickets.status, ['proposed', 'waiting_human', 'in_review']),
      ),
    );
  for (const { ticket, projectKey } of tickets) {
    const ref = { projectKey, number: ticket.number, title: ticket.title };
    if (ticket.status === 'proposed') {
      // A plan's tickets are approved with their plan (lot 5): only those an agent created.
      if (ticket.createdBy !== 'agent') continue;
      const agent =
        ticket.createdByProfileId === null ? undefined : profiles.get(ticket.createdByProfileId);
      items.push({
        type: 'ticket_proposed',
        ticket: ref,
        agent: agent ?? null,
        since: ticket.createdAt.toISOString(),
      });
    } else if (ticket.status === 'waiting_human') {
      // The latest question is the open one (04, section 6).
      const [question] = await db
        .select()
        .from(schema.comments)
        .where(and(eq(schema.comments.ticketId, ticket.id), eq(schema.comments.kind, 'question')))
        .orderBy(desc(schema.comments.createdAt))
        .limit(1);
      if (!question) continue;
      items.push({
        type: 'question',
        ticket: ref,
        question: toComment(question, profiles),
        since: question.createdAt.toISOString(),
      });
    } else if (ticket.pullRequestNumber !== null && ticket.pullRequestUrl !== null) {
      // "Ready for review", or "Review did not finish" (owner's answers 2 to 5, lot 3 steps H and
      // H4); nothing while a run works on it.
      const { review, ready } = await ticketReview(db, ticket);
      if (!review.offered || ready === null) continue;
      const latest = review.latest;
      if (latest?.kind === 'not_finished') {
        items.push({
          type: 'review_not_finished',
          ticket: ref,
          runId: latest.runId,
          machine: latest.machine,
          decision: latest.decision,
          end: latest.end,
          since: latest.endedAt,
        });
        continue;
      }
      items.push({
        type: 'ready_for_review',
        ticket: ref,
        pullRequest: { number: ticket.pullRequestNumber, url: ticket.pullRequestUrl },
        commit: ready.commit,
        ci: ready.ci,
        checkedAgainAt: ready.checkedAgainAt,
        workflowFlag: workflowFlag(ticket),
        start: review.start ?? 'by_itself',
        since: ready.since,
      });
    } else {
      // Left in review by 0.3.0, without a pull request: the owner checks it (answer 6f).
      // Submitted when its run succeeded; a ticket moved there otherwise shows its last change.
      const [run] = await db
        .select({ id: schema.runs.id, endedAt: schema.runs.endedAt })
        .from(schema.runs)
        .where(and(eq(schema.runs.ticketId, ticket.id), eq(schema.runs.status, 'succeeded')))
        .orderBy(desc(schema.runs.endedAt))
        .limit(1);
      const report = DodReport.safeParse(ticket.dodReport);
      items.push({
        type: 'work_to_check',
        ticket: ref,
        summary: report.success ? report.data.summary : null,
        runId: run?.id ?? null,
        since: (run?.endedAt ?? ticket.updatedAt).toISOString(),
      });
    }
  }

  items.push(...(await pushFailedItems(db)));
  items.push(...(await pullRequestItems(db)));
  items.push(...(await closedPullRequestItems(db)));
  items.push(...(await toMergeItems(db)));
  items.push(...(await ciTimeoutItems(db)));
  items.push(...(await downloadFailedItems(db)));
  items.push(...(await ciCancelledItems(db)));
  items.push(...(await machineFailureItems(db)));
  items.push(...(await stoppedItems(db)));

  const paused = await runs.list(
    and(
      eq(schema.runs.status, 'paused_quota'),
      sql`${schema.runs.projectId} IN (SELECT ${schema.projects.id} FROM ${schema.projects} WHERE ${schema.projects.status} = 'active')`,
    ),
    [asc(schema.runs.statusSince)],
  );
  const titles =
    paused.length === 0
      ? []
      : await db
          .select({
            runId: schema.runs.id,
            number: schema.tickets.number,
            title: schema.tickets.title,
          })
          .from(schema.runs)
          .innerJoin(schema.tickets, eq(schema.tickets.id, schema.runs.ticketId))
          .where(
            inArray(
              schema.runs.id,
              paused.map((run) => run.id),
            ),
          );
  for (const run of paused) {
    const ticket = titles.find((row) => row.runId === run.id);
    if (!ticket) continue;
    items.push({
      type: 'run_paused',
      run,
      ticket: { projectKey: run.projectKey, number: ticket.number, title: ticket.title },
      since: run.statusSince,
    });
  }
  return items;
}

/**
 * Tickets whose run ended with `push_failed` and whose branch has not been pushed since (04,
 * section 5; lot 3 step F): from that run's end until the next push done (an end push included),
 * or until the ticket is cancelled or done, or its machine revoked; still shown while a next run
 * works.
 */
export async function pushFailedItems(db: Database): Promise<Items> {
  const rows = await db
    .select({
      ticket: schema.tickets,
      projectKey: schema.projects.key,
      endedAt: sql<Date>`max(${schema.runs.endedAt})`.mapWith(schema.runs.endedAt),
    })
    .from(schema.tickets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
    .innerJoin(schema.runs, eq(schema.runs.ticketId, schema.tickets.id))
    .where(
      and(
        eq(schema.projects.status, 'active'),
        notInArray(schema.tickets.status, ['done', 'cancelled']),
        isNotNull(schema.tickets.branchPushFailure),
        eq(schema.runs.failureReason, 'push_failed'),
        isNotNull(schema.runs.endedAt),
        or(
          isNull(schema.tickets.githubBranchPushedAt),
          gt(schema.runs.endedAt, schema.tickets.githubBranchPushedAt),
        ),
      ),
    )
    .groupBy(schema.tickets.id, schema.projects.key);
  const items: Items = [];
  for (const { ticket, projectKey, endedAt } of rows) {
    const failure = pushFailure(ticket);
    if (!failure) continue;
    // A revoked machine's commits not on GitHub are lost (07, section 3): nothing to push.
    const [machine] = await db
      .select({ id: schema.machines.id, name: schema.machines.name })
      .from(schema.machines)
      .where(and(eq(schema.machines.id, failure.machineId), isNull(schema.machines.revokedAt)));
    if (!machine) continue;
    items.push({
      type: 'push_failed',
      ticket: { projectKey, number: ticket.number, title: ticket.title },
      machine,
      reason: failure.reason,
      permission: failure.reason === 'refused' ? pushPermission(failure.message) : null,
      message: failure.message,
      since: endedAt.toISOString(),
    });
  }
  return items;
}

/**
 * Accepted submissions whose pull request could not be opened or updated (04, section 3.1; lot 3
 * step F3): until an attempt succeeds, or the ticket is done or cancelled.
 */
async function pullRequestItems(db: Database): Promise<Items> {
  const rows = await db
    .select({ ticket: schema.tickets, projectKey: schema.projects.key })
    .from(schema.tickets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
    .where(
      and(
        eq(schema.projects.status, 'active'),
        notInArray(schema.tickets.status, ['done', 'cancelled']),
        isNotNull(schema.tickets.pullRequestWantedSince),
        isNotNull(schema.tickets.pullRequestFailure),
      ),
    );
  return rows.map(({ ticket, projectKey }) => {
    const failure = PullRequestFailure.parse(ticket.pullRequestFailure);
    return {
      type: 'pull_request_not_opened' as const,
      ticket: { projectKey, number: ticket.number, title: ticket.title },
      failure,
      openPullRequest: ticket.pullRequestState === 'open' ? ticket.pullRequestNumber : null,
      since: failure.since ?? failure.at,
    };
  });
}

/**
 * Pull requests closed on GitHub without merging, or merged into another base than the project's
 * default branch (04, section 2; lot 3 step J3a), on tickets neither done nor cancelled: the
 * ticket is unchanged. One closed by the Orchestrator at **Cancel** is left out: a ticket reopened
 * after it keeps it closed until its next accepted submission.
 */
async function closedPullRequestItems(db: Database): Promise<Items> {
  const rows = await db
    .select({ ticket: schema.tickets, project: schema.projects })
    .from(schema.tickets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
    .where(
      and(
        eq(schema.projects.status, 'active'),
        notInArray(schema.tickets.status, ['done', 'cancelled']),
        isNotNull(schema.tickets.pullRequestNumber),
        or(
          and(
            eq(schema.tickets.pullRequestState, 'closed'),
            eq(schema.tickets.pullRequestClosedBy, 'github'),
          ),
          eq(schema.tickets.pullRequestState, 'merged'),
        ),
      ),
    );
  const items: Items = [];
  for (const { ticket, project } of rows) {
    const { pullRequestNumber: number, pullRequestUrl: url } = ticket;
    if (number === null || url === null) continue;
    const merged = ticket.pullRequestState === 'merged';
    // Merged into the default branch: the ticket is done, or stays cancelled (the cancel race).
    if (merged && ticket.pullRequestMergedInto === project.defaultBranch) continue;
    const since = merged ? ticket.pullRequestMergedAt : ticket.pullRequestClosedAt;
    items.push({
      type: 'pull_request_closed',
      ticket: { projectKey: project.key, number: ticket.number, title: ticket.title },
      status: TicketStatus.parse(ticket.status),
      pullRequest: { number, url },
      mergedInto: merged ? ticket.pullRequestMergedInto : null,
      reopenFailure:
        ticket.pullRequestReopenFailure === null
          ? null
          : PullRequestReopenFailure.parse(ticket.pullRequestReopenFailure),
      since: (since ?? ticket.updatedAt).toISOString(),
    });
  }
  return items;
}

/** The workflow flag of the accepted submission, with its reason (lot 3 step F4). */
function workflowFlag(ticket: TicketRow) {
  if (!ticket.workflowChanges) return null;
  return ticket.workflowReason === null ? 'not_kept' : WorkflowReason.parse(ticket.workflowReason);
}

/**
 * Pull requests to merge (02, section 4; lot 3 step J4a): tickets on **Awaiting merge** whose pull
 * request is open as last read, since they entered it. One closed or merged elsewhere is the
 * closed item instead; a merge into the default branch makes the ticket done (step J1).
 */
async function toMergeItems(db: Database): Promise<Items> {
  const rows = await db
    .select({ ticket: schema.tickets, project: schema.projects })
    .from(schema.tickets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
    .where(
      and(
        eq(schema.projects.status, 'active'),
        eq(schema.tickets.status, 'awaiting_merge'),
        eq(schema.tickets.pullRequestState, 'open'),
        isNotNull(schema.tickets.pullRequestNumber),
        isNotNull(schema.tickets.pullRequestUrl),
      ),
    )
    // Items that began at the same time keep this order (the list's sort is stable).
    .orderBy(asc(schema.projects.key), asc(schema.tickets.number));
  const items: Items = [];
  for (const { ticket, project } of rows) {
    const { pullRequestNumber: number, pullRequestUrl: url } = ticket;
    if (number === null || url === null) continue;
    const { latest } = (await ticketReview(db, ticket)).review;
    const source = await ciSourceRun(db, ticket.id);
    const outcome = source === null ? null : ciOutcome(source);
    const result = reviewCiOf(outcome);
    // The latest move to Awaiting merge: Quality's approval applied, or the owner's skip.
    const [entered] = await db
      .select({ at: schema.events.createdAt })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.entityType, 'ticket'),
          eq(schema.events.entityId, ticket.id),
          eq(schema.events.type, 'ticket.status_changed'),
          sql`${schema.events.payload}->>'to' = 'awaiting_merge'`,
        ),
      )
      .orderBy(desc(schema.events.id))
      .limit(1);
    items.push({
      type: 'pull_request_to_merge',
      ticket: { projectKey: project.key, number: ticket.number, title: ticket.title },
      pullRequest: { number, url },
      review:
        latest?.kind === 'skipped'
          ? { kind: 'skipped', at: latest.at }
          : latest?.kind === 'decision' && latest.decision.kind === 'approved'
            ? {
                kind: 'approved',
                commit: latest.decision.commit,
                summary: latest.decision.summary,
                at: latest.decision.at,
              }
            : null,
      ci:
        outcome === null || result === null
          ? null
          : {
              result,
              commit: outcome.commit,
              checkedAgainAt: outcome.acceptedLater?.at ?? null,
            },
      workflowFlag: workflowFlag(ticket),
      conflict: ticketConflict(ticket),
      headMoved: await headMoved(db, ticket),
      watchFailure: ticketWatchFailure(project, ticket),
      since: (entered?.at ?? ticket.updatedAt).toISOString(),
    });
  }
  return items;
}

/**
 * Runs ended `ci_timeout` (04, section 3.1; owner's answer 1, lot 3 step G2c), not counted: one
 * item each, "CI did not finish", "CI failed, and the agent did not get the result" or a conflict,
 * until the work is accepted (**Check CI again**), a new run starts (the run is no longer the
 * ticket's latest), or the ticket is done or cancelled.
 */
export async function ciTimeoutItems(db: Database): Promise<Items> {
  const rows = await db
    .select({
      run: schema.runs,
      ticket: schema.tickets,
      projectKey: schema.projects.key,
      machine: { id: schema.machines.id, name: schema.machines.name },
    })
    .from(schema.runs)
    .innerJoin(schema.tickets, eq(schema.tickets.id, schema.runs.ticketId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
    .innerJoin(schema.machines, eq(schema.machines.id, schema.runs.machineId))
    .where(
      and(
        eq(schema.projects.status, 'active'),
        notInArray(schema.tickets.status, ['done', 'cancelled']),
        eq(schema.runs.failureReason, 'ci_timeout'),
        isNull(schema.runs.ciAcceptedLater),
        isNotNull(schema.runs.endedAt),
        sql`${schema.runs.createdAt} = (SELECT max(r.created_at) FROM runs r WHERE r.ticket_id = ${schema.runs.ticketId})`,
      ),
    );
  const items: Items = [];
  for (const { run, ticket, projectKey, machine } of rows) {
    const outcome = ciOutcome(run);
    if (outcome === null || run.endedAt === null) continue;
    items.push({
      type: 'ci_timeout',
      ticket: { projectKey, number: ticket.number, title: ticket.title },
      runId: run.id,
      machine,
      submittedAt: run.submission === null ? null : SubmissionRecord.parse(run.submission).at,
      // The ticket's pull request now: Try again may have opened it since (owner's answer 3e).
      pullRequest: ticket.pullRequestNumber,
      waitMinutes: run.ciWaitTimeoutMinutes,
      base: run.baseBranch,
      outcome,
      since: run.endedAt.toISOString(),
    });
  }
  return items;
}

/**
 * Builder runs ended `download_failed` (owner's answer 2, lot 3 step K2): blocking, with **Run
 * now**. Only the ticket's latest run, so the item goes when a new run starts; never for a done
 * or cancelled ticket, or a revoked machine. A review run that fails so is "Review did not finish".
 */
export async function downloadFailedItems(db: Database): Promise<Items> {
  const rows = await db
    .select({
      run: schema.runs,
      ticket: schema.tickets,
      projectKey: schema.projects.key,
      machine: { id: schema.machines.id, name: schema.machines.name },
    })
    .from(schema.runs)
    .innerJoin(schema.tickets, eq(schema.tickets.id, schema.runs.ticketId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
    .innerJoin(schema.machines, eq(schema.machines.id, schema.runs.machineId))
    .where(
      and(
        eq(schema.projects.status, 'active'),
        notInArray(schema.tickets.status, ['done', 'cancelled']),
        eq(schema.runs.failureReason, 'download_failed'),
        inArray(schema.runs.purpose, ['implement', 'fix_review']),
        isNull(schema.machines.revokedAt),
        isNotNull(schema.runs.endedAt),
        sql`${schema.runs.createdAt} = (SELECT max(r.created_at) FROM runs r WHERE r.ticket_id = ${schema.runs.ticketId})`,
      ),
    );
  const items: Items = [];
  for (const { run, ticket, projectKey, machine } of rows) {
    const download = runDownload(run);
    if (download === null || run.endedAt === null) continue;
    items.push({
      type: 'download_failed',
      ticket: { projectKey, number: ticket.number, title: ticket.title },
      runId: run.id,
      machine,
      download,
      since: run.endedAt.toISOString(),
    });
  }
  return items;
}

/**
 * Tickets whose latest run ended `ci_cancelled` (04, section 5.1; owner's answer 3, lot 4 step A):
 * CI cancelled on GitHub because the branch changed there. Blocking, with **Run now**, until a new
 * run of the ticket starts, or the ticket is done or cancelled: the rule of `download_failed`.
 */
export async function ciCancelledItems(db: Database): Promise<Items> {
  const rows = await db
    .select({
      run: schema.runs,
      ticket: schema.tickets,
      projectKey: schema.projects.key,
      machine: { id: schema.machines.id, name: schema.machines.name },
    })
    .from(schema.runs)
    .innerJoin(schema.tickets, eq(schema.tickets.id, schema.runs.ticketId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
    .innerJoin(schema.machines, eq(schema.machines.id, schema.runs.machineId))
    .where(
      and(
        eq(schema.projects.status, 'active'),
        notInArray(schema.tickets.status, ['done', 'cancelled']),
        eq(schema.runs.failureReason, 'ci_cancelled'),
        isNotNull(schema.runs.endedAt),
        sql`${schema.runs.createdAt} = (SELECT max(r.created_at) FROM runs r WHERE r.ticket_id = ${schema.runs.ticketId})`,
      ),
    );
  return rows.flatMap(({ run, ticket, projectKey, machine }) =>
    run.endedAt === null
      ? []
      : [
          {
            type: 'ci_cancelled' as const,
            ticket: { projectKey, number: ticket.number, title: ticket.title },
            runId: run.id,
            machine,
            since: run.endedAt.toISOString(),
          },
        ],
  );
}

/**
 * "<ticket> could not start on <machine>" (07, section 4; owner's new answer 1, lot 4 step A): the
 * failures in a row a machine caused reached **Machine failures before asking you**. Blocking,
 * with **Run now**, until a new run of the ticket starts, or the ticket is done or cancelled.
 */
export async function machineFailureItems(db: Database): Promise<Items> {
  const rows = await db
    .select({ ticket: schema.tickets, projectKey: schema.projects.key })
    .from(schema.tickets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
    .where(
      and(
        eq(schema.projects.status, 'active'),
        notInArray(schema.tickets.status, ['done', 'cancelled']),
        sql`${schema.tickets.machineFailures} <> '[]'::jsonb`,
      ),
    );
  if (rows.length === 0) return [];
  const names = new Map(
    (
      await db.select({ id: schema.machines.id, name: schema.machines.name }).from(schema.machines)
    ).map((machine) => [machine.id, machine.name]),
  );
  const items: Items = [];
  for (const { ticket, projectKey } of rows) {
    const entry = askedMachine(machineFailures(ticket));
    if (!entry || entry.asked === null) continue;
    items.push({
      type: 'machine_failures',
      ticket: { projectKey, number: ticket.number, title: ticket.title },
      machine: { id: entry.machineId, name: names.get(entry.machineId) ?? 'unknown' },
      failures: entry.failures,
      limit: entry.asked.limit,
      since: entry.asked.at,
    });
  }
  return items;
}

/**
 * Tickets the retry policy stopped (02, section 4; 04, section 5; owner's answer 2, lot 3 step I),
 * in `todo`: **Try again**, **Cancel** or **Mark as done manually**, each of which ends it, as
 * **Reopen** does.
 */
async function stoppedItems(db: Database): Promise<Items> {
  const rows = await db
    .select({ ticket: schema.tickets, projectKey: schema.projects.key })
    .from(schema.tickets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
    .where(
      and(
        eq(schema.projects.status, 'active'),
        eq(schema.tickets.status, 'todo'),
        isNotNull(schema.tickets.stopped),
      ),
    );
  return rows.map(({ ticket, projectKey }) => {
    const stop = TicketStop.parse(ticket.stopped);
    return {
      type: 'ticket_stopped' as const,
      ticket: { projectKey, number: ticket.number, title: ticket.title },
      cause: stop.cause,
      count: stop.count,
      limit: stop.limit,
      since: stop.at,
    };
  });
}

/**
 * "Needs you" items (02, section 4): setup still to do first, then the others oldest first.
 * GitHub connection problems are part of `GET /api/github`.
 */
export function registerNeedsYouRoutes(
  app: FastifyInstance,
  {
    db,
    publicUrl,
    providedDaemonBuild,
    runs,
    now = () => new Date(),
  }: {
    db: Database;
    publicUrl: string;
    providedDaemonBuild: () => string | null;
    runs: RunService;
    now?: () => Date;
  },
) {
  app.get('/api/needs-you', async (request) => {
    await requireSession(db, request);
    // Archived projects start no work: their failed setup waits until they are unarchived.
    const failed = await db
      .select()
      .from(schema.projects)
      .where(and(eq(schema.projects.setupStatus, 'failed'), eq(schema.projects.status, 'active')))
      .orderBy(asc(schema.projects.setupFailedAt));
    const items: NeedsYouResponse['items'] = [];
    for (const row of failed) {
      const project = toProject(row);
      if (project.setup.step === null || project.setup.failure === null || !row.setupFailedAt) {
        continue;
      }
      items.push({
        type: 'project_setup_failed',
        project: { key: project.key, name: project.name },
        step: project.setup.step,
        reason: project.setup.failure,
        since: row.setupFailedAt.toISOString(),
      });
    }

    // Revoked machines are left out: they can do nothing until enrolled again.
    const machines = await db
      .select()
      .from(schema.machines)
      .where(isNull(schema.machines.revokedAt));
    for (const machine of machines) {
      const ref = { id: machine.id, name: machine.name };
      if (machine.daemonIncompatibleSince) {
        items.push({
          type: 'daemon_incompatible',
          machine: ref,
          daemonVersion: machine.daemonVersion,
          protocolVersion: machine.protocolVersion,
          updateCommands: daemonUpdateCommands(publicUrl),
          since: machine.daemonIncompatibleSince.toISOString(),
        });
      }
      if (machine.daemonOutdatedSince && machine.daemonVersion !== null) {
        items.push({
          type: 'daemon_outdated',
          machine: ref,
          daemonVersion: machine.daemonVersion,
          serverVersion: SERVER_VERSION,
          updateCommands: daemonUpdateCommands(publicUrl),
          since: machine.daemonOutdatedSince.toISOString(),
        });
      }
      const providedBuild = providedDaemonBuild();
      if (
        machine.daemonBuildDiffersSince &&
        machine.daemonVersion !== null &&
        providedBuild !== null
      ) {
        items.push({
          type: 'daemon_build_differs',
          machine: ref,
          daemonVersion: machine.daemonVersion,
          daemonBuild: machine.daemonBuild,
          serverVersion: SERVER_VERSION,
          providedBuild,
          updateCommands: daemonUpdateCommands(publicUrl),
          since: machine.daemonBuildDiffersSince.toISOString(),
        });
      }
      if (machine.claudeCodeUnsupportedSince) {
        items.push({
          type: 'claude_code_unsupported',
          machine: ref,
          version: machine.claudeCodeVersion,
          minimum: CLAUDE_CODE_MIN_VERSION,
          since: machine.claudeCodeUnsupportedSince.toISOString(),
        });
      }
      if (machine.doctorErrorSince) {
        items.push({
          type: 'machine_problem',
          machine: ref,
          checks: doctorErrors(z.array(DoctorCheck).parse(machine.doctor)),
          since: machine.doctorErrorSince.toISOString(),
        });
      }
      if (machine.status === 'offline') {
        // Its active runs show "machine offline"; Stop run fails them (05, section 6).
        const active = await db
          .select({ key: schema.projects.key, number: schema.tickets.number })
          .from(schema.runs)
          .innerJoin(schema.tickets, eq(schema.tickets.id, schema.runs.ticketId))
          .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
          .where(
            and(
              eq(schema.runs.machineId, machine.id),
              inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]),
            ),
          )
          .orderBy(asc(schema.projects.key), asc(schema.tickets.number));
        if (active.length > 0) {
          items.push({
            type: 'machine_offline_with_runs',
            machine: ref,
            tickets: active.map((row) => `${row.key}-${String(row.number)}`),
            since: (machine.lastHeartbeatAt ?? machine.updatedAt).toISOString(),
          });
        }
      }
    }
    items.push(...(await ticketItems(db, runs)));
    items.sort((a, b) => ('since' in a && 'since' in b ? a.since.localeCompare(b.since) : 0));

    // Setup still to do (02, section 3), before the rest.
    const setup: NeedsYouResponse['items'] = [];
    const [account] = await db
      .select({ id: schema.claudeAccounts.id })
      .from(schema.claudeAccounts)
      .limit(1);
    if (!account) setup.push({ type: 'no_claude_account' });
    const [enrolled] = await db
      .select({ id: schema.machines.id })
      .from(schema.machines)
      .where(and(isNotNull(schema.machines.enrolledAt), isNull(schema.machines.revokedAt)))
      .limit(1);
    if (!enrolled) setup.push({ type: 'no_machine' });
    const { accounts } = await accountsWithToday(db, await accountRows(db), now());
    return {
      items: [...setup, ...items],
      accounts: accounts.map(
        ({ id, label, state, limitedUntil, limitedUntilEstimated, today }) => ({
          id,
          label,
          state,
          limitedUntil,
          limitedUntilEstimated,
          today,
        }),
      ),
    } satisfies NeedsYouResponse;
  });
}
