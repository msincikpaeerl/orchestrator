import { schema } from '@orchestrator/db';
import {
  ACTIVE_RUN_STATUSES,
  CLAUDE_CODE_MIN_VERSION,
  DoctorCheck,
  DodReport,
  type NeedsYouResponse,
} from '@orchestrator/protocol';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { requireSession } from './auth/routes.js';
import type { Database } from './database.js';
import { daemonUpdateCommands, doctorErrors, toAccount } from './machines/model.js';
import { SERVER_VERSION } from './version.js';
import { toProject } from './projects/model.js';
import type { RunService } from './runs/service.js';
import { profileLinks, toComment } from './tickets/model.js';

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
    } else {
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
  }: {
    db: Database;
    publicUrl: string;
    providedDaemonBuild: () => string | null;
    runs: RunService;
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
    const accounts = await db
      .select()
      .from(schema.claudeAccounts)
      .orderBy(asc(sql`lower(${schema.claudeAccounts.label})`));
    const now = new Date();
    return {
      items: [...setup, ...items],
      accounts: accounts.map((row) => {
        const { id, label, state, limitedUntil, limitedUntilEstimated } = toAccount(row, now);
        return { id, label, state, limitedUntil, limitedUntilEstimated };
      }),
    } satisfies NeedsYouResponse;
  });
}
