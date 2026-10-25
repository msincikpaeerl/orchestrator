import { schema } from '@orchestrator/db';
import {
  ACTIVE_RUN_STATUSES,
  AddCommentRequest,
  AddDependencyRequest,
  AnswerRequest,
  CheckCiAgainRequest,
  DodCheckResult,
  StoredDodReport,
  CreateTicketRequest,
  EDITABLE_STATUSES,
  MarkDoneRequest,
  RequestChangesRequest,
  ProjectKey,
  RejectRequest,
  TicketNumber,
  TicketStatus,
  TicketImportRequest,
  UpdateTicketRequest,
  type AgentLink,
  type TicketImportPreview,
  type TicketImportProblem,
  type TicketImportResponse,
  type LimitExceeded,
  type OwnerTicketAction,
  type ReleaseAction,
  type TicketHold,
  type TicketDetail,
  type TicketListResponse,
  type TimelineEntry,
  PullRequestClosedBy,
  PullRequestFailure,
  PullRequestReopenFailure,
  PullRequestState,
  WorkflowReason,
  type PullRequestReopenResponse,
  type PullRequestTryAgainResponse,
  type TicketPullRequest,
} from '@orchestrator/protocol';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession } from '../auth/routes.js';
import type { Database, Executor } from '../database.js';
import { maskStrings } from '../event-log.js';
import { recordEvent } from '../events.js';
import { HttpError, parseInput } from '../http.js';
import type { ProjectRow } from '../projects/model.js';
import type { CiCheckAgain } from '../runs/ci-again.js';
import { ticketCi } from '../runs/ci-outcome.js';
import { ticketReview } from '../runs/review-view.js';
import type { RunService } from '../runs/service.js';
import { automaticMergeView } from './automatic-merge.js';
import type { PullRequestWatcher } from './merge-watch.js';
import { headMoved, ticketConflict, ticketWatchFailure } from './pull-request-facts.js';
import type { PullRequestOpener } from './pull-request.js';
import { resolveSettings } from '../settings/store.js';
import {
  StatusChangedPayload,
  acceptanceCriteria,
  activeRuns,
  boardOrder,
  profileLinks,
  ticketEntity,
  ticketReference,
  toComment,
  toTicketLink,
  toTicketSummary,
  type TicketRow,
} from './model.js';
import { ticketBranch } from './branch.js';
import { cleanUpWanted, ticketBranchCleanUp } from './branch-clean-up.js';
import {
  acceptedCommit,
  requestAfter,
  ticketChangeRequest,
  ticketStop,
  tryAgainComment,
} from './changes.js';
import { holdTicket, releaseHold } from './holds.js';
import { checkImport, importTickets, readImportFile } from './import.js';
import {
  assigneeRefusal,
  createOwnerTicket,
  exceededLimits,
  findPath,
  ticketLimits,
} from './rules.js';
import { applyOwnerAction, refusal } from './transitions.js';

/** The owner's actions that release a hold (lot 4 step D2b). */
const RELEASING = new Set<string>(['request_changes', 'skip_review', 'cancel', 'mark_done']);

/** The ticket's pull request as last recorded (lot 3 step F3), for its page (step F4). */
async function ticketPullRequest(
  executor: Executor,
  project: ProjectRow,
  ticket: TicketRow,
): Promise<TicketPullRequest> {
  const { pullRequestNumber: number, pullRequestUrl: url, pullRequestState: state } = ticket;
  const failure = (stored: unknown) =>
    stored === null ? null : maskStrings(PullRequestFailure.parse(stored));
  return {
    opened:
      number === null || url === null || state === null
        ? null
        : { number, url, state: PullRequestState.parse(state) },
    wanted: ticket.pullRequestWantedSince !== null,
    failure: failure(ticket.pullRequestFailure),
    closed:
      state === 'closed'
        ? {
            at: ticket.pullRequestClosedAt?.toISOString() ?? null,
            by: PullRequestClosedBy.parse(ticket.pullRequestClosedBy ?? 'github'),
          }
        : null,
    merged:
      state === 'merged' && ticket.pullRequestMergedInto !== null
        ? {
            into: ticket.pullRequestMergedInto,
            at: ticket.pullRequestMergedAt?.toISOString() ?? null,
            intoDefaultBranch: ticket.pullRequestMergedInto === project.defaultBranch,
          }
        : null,
    close:
      ticket.pullRequestCloseWantedAt === null
        ? null
        : {
            since: ticket.pullRequestCloseWantedAt.toISOString(),
            failure: failure(ticket.pullRequestCloseFailure),
          },
    reopenFailure:
      ticket.pullRequestReopenFailure === null
        ? null
        : maskStrings(PullRequestReopenFailure.parse(ticket.pullRequestReopenFailure)),
    watchFailure: ticketWatchFailure(project, ticket),
    conflict: ticketConflict(ticket),
    headMoved: await headMoved(executor, ticket),
    automaticMerge: await automaticMergeView(executor, ticket),
  };
}

export interface TicketRoutesOptions {
  db: Database;
  /** Cancel and Mark as done manually stop the ticket's active run (04, section 2). */
  runs: RunService;
  /** **Try again** of a pull request not opened (lot 3 step F3). */
  pullRequests: PullRequestOpener;
  /** **Check CI again** (lot 3 step G2c). */
  ciAgain: CiCheckAgain;
  /** **Cancel**'s close of the pull request and **Reopen pull request** (lot 3 step J3a). */
  watcher: Pick<PullRequestWatcher, 'close' | 'reopen'>;
  now?: () => Date;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const projectNotFound = () => new HttpError(404, 'project_not_found', 'No project with this key');
const ticketNotFound = () =>
  new HttpError(404, 'ticket_not_found', 'No ticket with this number in this project');

/** True when at least one ticket this one depends on is not `done` (01, section 3.4). */
const blockedFlag = sql<boolean>`exists (
  select 1 from ticket_dependencies d
  join tickets b on b.id = d.blocked_by_id
  where d.ticket_id = "tickets"."id" and b.status <> 'done'
)`.mapWith(Boolean);

/** The assignee of each ticket row, from a left join on the profiles. */
const assigneeColumns = { key: schema.agentProfiles.key, name: schema.agentProfiles.name };

function assigneeLink(row: { key: string | null; name: string | null } | null): AgentLink | null {
  return row?.key && row.name !== null ? { key: row.key, name: row.name } : null;
}

/** A ticket number from an address: digits only, as in `WEB-12`. */
function parseNumber(value: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(value)) return null;
  const parsed = TicketNumber.safeParse(Number(value));
  return parsed.success ? parsed.data : null;
}

/**
 * Tickets (02, sections 6.3 and 6.4; 04, section 2). Every change runs in one transaction that
 * first locks the project's row: ticket numbers, dependency cycles and archiving are then decided
 * one request at a time per project, and a change and its event are written together.
 */
export function registerTicketRoutes(app: FastifyInstance, options: TicketRoutesOptions) {
  const { db } = options;
  const now = () => options.now?.() ?? new Date();

  async function findProject(key: string): Promise<ProjectRow> {
    const parsed = ProjectKey.safeParse(key);
    const [row] = parsed.success
      ? await db.select().from(schema.projects).where(eq(schema.projects.key, parsed.data))
      : [];
    if (!row) throw projectNotFound();
    return row;
  }

  /** Runs a change on a project's tickets under its row lock; refused unless active and ready. */
  async function change<T>(
    key: string,
    work: (tx: Transaction, project: ProjectRow) => Promise<T>,
  ): Promise<T> {
    const parsed = ProjectKey.safeParse(key);
    if (!parsed.success) throw projectNotFound();
    return db.transaction(async (tx) => {
      const [project] = await tx
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.key, parsed.data))
        .for('no key update');
      if (!project) throw projectNotFound();
      if (project.status === 'archived') {
        throw new HttpError(
          409,
          'project_archived',
          'This project is archived and read-only: unarchive it first',
        );
      }
      if (project.setupStatus !== 'ready') {
        throw new HttpError(
          409,
          'project_not_ready',
          'The repository setup of this project is not finished',
        );
      }
      return work(tx, project);
    });
  }

  async function findTicket(
    executor: Executor,
    projectId: string,
    number: string | number,
  ): Promise<TicketRow> {
    const parsed = typeof number === 'number' ? number : parseNumber(number);
    const [row] =
      parsed === null
        ? []
        : await executor
            .select()
            .from(schema.tickets)
            .where(and(eq(schema.tickets.projectId, projectId), eq(schema.tickets.number, parsed)));
    if (!row) throw ticketNotFound();
    return row;
  }

  function requireEditable(ticket: TicketRow, what: string) {
    if (!EDITABLE_STATUSES.includes(TicketStatus.parse(ticket.status))) {
      throw new HttpError(
        409,
        'ticket_not_editable',
        `${what} can change only while the ticket is proposed or todo; it is ${ticket.status}`,
      );
    }
  }

  /** The profile with this key, refused with `agent_not_found` when there is none. */
  async function findAgent(executor: Executor, key: string) {
    const [row] = await executor
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.key, key));
    const refused = assigneeRefusal(key, row);
    if (refused) throw new HttpError(422, refused.code, refused.message);
    // A missing profile is refused above.
    return row as NonNullable<typeof row>;
  }

  async function assigneeOf(executor: Executor, ticket: TicketRow): Promise<AgentLink | null> {
    if (ticket.assigneeProfileId === null) return null;
    const [row] = await executor
      .select(assigneeColumns)
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.id, ticket.assigneeProfileId));
    return assigneeLink(row ?? null);
  }

  /**
   * Length and count limits of 04, section 8: settings, so the refusal gives each field over its
   * limit and the limit's value. Global only: a project cannot override them.
   */
  async function checkLimits(fields: {
    title?: string;
    description?: string;
    acceptanceCriteria?: string[];
  }) {
    const exceeded = exceededLimits(await ticketLimits(db), fields);
    if (exceeded.length > 0) throw limitRefusal(exceeded);
  }

  /** `apiField`: the comment's field in the request, `body` for a note, `comment` otherwise. */
  async function checkCommentLength(text: string, apiField: 'body' | 'comment') {
    const { commentMaxLength } = await resolveSettings(db, ['commentMaxLength']);
    if (text.length > commentMaxLength) {
      throw limitRefusal(
        [{ field: 'comment', max: commentMaxLength, unit: 'characters' }],
        apiField,
      );
    }
  }

  async function detail(
    executor: Executor,
    project: ProjectRow,
    ticket: TicketRow,
  ): Promise<TicketDetail> {
    const blocker = alias(schema.tickets, 'blocker');
    const waiting = alias(schema.tickets, 'waiting');
    const link = { number: blocker.number, title: blocker.title, status: blocker.status };
    const blockedBy = await executor
      .select(link)
      .from(schema.ticketDependencies)
      .innerJoin(blocker, eq(blocker.id, schema.ticketDependencies.blockedById))
      .where(eq(schema.ticketDependencies.ticketId, ticket.id))
      .orderBy(asc(blocker.number));
    const blocks = await executor
      .select({ number: waiting.number, title: waiting.title, status: waiting.status })
      .from(schema.ticketDependencies)
      .innerJoin(waiting, eq(waiting.id, schema.ticketDependencies.ticketId))
      .where(eq(schema.ticketDependencies.blockedById, ticket.id))
      .orderBy(asc(waiting.number));
    const comments = await executor
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.ticketId, ticket.id))
      .orderBy(asc(schema.comments.createdAt));
    const statusChanges = await executor
      .select()
      .from(schema.events)
      .where(
        and(
          eq(schema.events.entityType, 'ticket'),
          eq(schema.events.entityId, ticket.id),
          eq(schema.events.type, 'ticket.status_changed'),
        ),
      )
      .orderBy(asc(schema.events.id));

    const profiles = await profileLinks(executor);
    const timeline: TimelineEntry[] = [
      ...comments.map((row) => ({
        type: 'comment' as const,
        at: row.createdAt.toISOString(),
        comment: toComment(row, profiles),
      })),
      ...statusChanges.map((event) => {
        const payload = StatusChangedPayload.parse(event.payload);
        return {
          type: 'status_change' as const,
          at: event.createdAt.toISOString(),
          actor:
            event.actor === 'owner'
              ? ('owner' as const)
              : event.actor === 'agent'
                ? ('agent' as const)
                : ('system' as const),
          from: payload.from,
          to: payload.to,
          commentId: payload.commentId,
        };
      }),
    ].sort((a, b) => a.at.localeCompare(b.at));

    const branch = await ticketBranch(executor, project, ticket);

    const blockedByLinks = blockedBy.map(toTicketLink);
    return {
      ...toTicketSummary(
        ticket,
        project.key,
        blockedByLinks.some((link) => link.status !== 'done'),
        await assigneeOf(executor, ticket),
        profiles,
        (await activeRuns(executor, [ticket.id])).get(ticket.id) ?? null,
      ),
      description: ticket.description,
      acceptanceCriteria: acceptanceCriteria(ticket),
      blockedBy: blockedByLinks,
      blocks: blocks.map(toTicketLink),
      timeline,
      attemptCount: ticket.attemptCount,
      branch,
      dodReport:
        ticket.dodReport === null ? null : maskStrings(StoredDodReport.parse(ticket.dodReport)),
      dodChecks:
        ticket.dodChecks === null
          ? null
          : maskStrings(z.array(DodCheckResult).parse(ticket.dodChecks)),
      workflowFlag: ticket.workflowChanges
        ? ticket.workflowReason === null
          ? 'not_kept'
          : WorkflowReason.parse(ticket.workflowReason)
        : null,
      pullRequest: await ticketPullRequest(executor, project, ticket),
      ci: await ticketCi(executor, ticket),
      review: (await ticketReview(executor, ticket)).review,
      reviewRounds: ticket.reviewRounds,
      changeRequest: await ticketChangeRequest(executor, ticket),
      branchCleanUp: await ticketBranchCleanUp(executor, ticket.id),
    };
  }

  /** Common payload of ticket events: the project key and the ticket's reference. */
  function about(project: ProjectRow, ticket: Pick<TicketRow, 'number'>) {
    return { project: project.key, ticket: ticketReference(project.key, ticket.number) };
  }

  async function touch(tx: Transaction, ticket: TicketRow, at: Date): Promise<TicketRow> {
    const [updated] = await tx
      .update(schema.tickets)
      .set({ updatedAt: at })
      .where(eq(schema.tickets.id, ticket.id))
      .returning();
    if (!updated) throw new Error('ticket disappeared');
    return updated;
  }

  type TicketParams = { Params: { key: string; number: string } };

  app.get<{ Params: { key: string } }>('/api/projects/:key/tickets', async (request) => {
    await requireSession(db, request);
    const project = await findProject(request.params.key);
    const rows = await db
      .select({ ticket: schema.tickets, blocked: blockedFlag, assignee: assigneeColumns })
      .from(schema.tickets)
      .leftJoin(schema.agentProfiles, eq(schema.agentProfiles.id, schema.tickets.assigneeProfileId))
      .where(eq(schema.tickets.projectId, project.id));
    const profiles = await profileLinks(db);
    const active = await activeRuns(
      db,
      rows.map((row) => row.ticket.id),
    );
    const tickets = rows
      .map((row) =>
        toTicketSummary(
          row.ticket,
          project.key,
          row.blocked,
          assigneeLink(row.assignee),
          profiles,
          active.get(row.ticket.id) ?? null,
        ),
      )
      .sort(boardOrder);
    return { tickets } satisfies TicketListResponse;
  });

  app.post<{ Params: { key: string } }>('/api/projects/:key/tickets', async (request, reply) => {
    await requireSession(db, request);
    const input = parseInput(CreateTicketRequest, request.body);
    await checkLimits(input);
    const created = await change(request.params.key, async (tx, project) => {
      const assignee = input.assignee === null ? null : await findAgent(tx, input.assignee);
      const blockerNumbers = [...new Set(input.blockedBy)];
      const blockers =
        blockerNumbers.length === 0
          ? []
          : await tx
              .select()
              .from(schema.tickets)
              .where(
                and(
                  eq(schema.tickets.projectId, project.id),
                  inArray(schema.tickets.number, blockerNumbers),
                ),
              );
      const missing = blockerNumbers.filter((n) => !blockers.some((row) => row.number === n));
      if (missing.length > 0) {
        throw new HttpError(
          422,
          'ticket_not_found',
          `No ticket ${missing.map((n) => ticketReference(project.key, n)).join(', ')} in this project`,
        );
      }

      const ticket = await createOwnerTicket(
        tx,
        project,
        {
          type: input.type,
          title: input.title,
          description: input.description,
          acceptanceCriteria: input.acceptanceCriteria,
          priority: input.priority,
          assignee,
        },
        blockers,
        now(),
      );
      return detail(tx, project, ticket);
    });
    request.log.info({ project: created.projectKey, ticket: created.number }, 'ticket created');
    return reply.code(201).send(created);
  });

  /**
   * Import of a file of tickets (02, section 6.3; 06, section 4.6; lot 5bis step A): the preview
   * checks and writes nothing; the import checks again and creates every ticket, or none.
   */
  app.post<{ Params: { key: string } }>(
    '/api/projects/:key/tickets/import/preview',
    async (request): Promise<TicketImportPreview> => {
      await requireSession(db, request);
      const { text } = parseInput(TicketImportRequest, request.body);
      return change(request.params.key, async (tx, project) => {
        const read = readImportFile(text);
        if (read.file === null) return { tickets: [], problems: read.problems, warnings: [] };
        return (await checkImport(tx, project, read.file)).preview;
      });
    },
  );

  app.post<{ Params: { key: string } }>(
    '/api/projects/:key/tickets/import',
    async (request, reply) => {
      await requireSession(db, request);
      const { text } = parseInput(TicketImportRequest, request.body);
      const created = await change(request.params.key, async (tx, project) => {
        const read = readImportFile(text);
        if (read.file === null) throw importRefusal(read.problems);
        const { preview, planned } = await checkImport(tx, project, read.file);
        if (planned === null) throw importRefusal(preview.problems);
        return importTickets(tx, project, planned, now());
      });
      request.log.info(
        { project: request.params.key, tickets: created.length },
        'tickets imported',
      );
      return reply.code(201).send({
        tickets: created.map(toTicketLink),
      } satisfies TicketImportResponse);
    },
  );

  app.get<TicketParams>('/api/projects/:key/tickets/:number', async (request) => {
    await requireSession(db, request);
    const project = await findProject(request.params.key);
    const ticket = await findTicket(db, project.id, request.params.number);
    return detail(db, project, ticket);
  });

  app.patch<TicketParams>('/api/projects/:key/tickets/:number', async (request) => {
    await requireSession(db, request);
    const input = parseInput(UpdateTicketRequest, request.body);
    await checkLimits(input);
    return change(request.params.key, async (tx, project) => {
      const ticket = await findTicket(tx, project.id, request.params.number);
      requireEditable(ticket, 'A ticket');
      const { assignee: assigneeKey, ...fields } = input;
      const assignee =
        assigneeKey === undefined || assigneeKey === null ? null : await findAgent(tx, assigneeKey);
      const current = {
        type: ticket.type,
        title: ticket.title,
        description: ticket.description,
        acceptanceCriteria: acceptanceCriteria(ticket),
        priority: ticket.priority,
      };
      const changes: Record<string, unknown> = Object.fromEntries(
        Object.entries(fields).filter(
          ([field, value]) =>
            JSON.stringify(value) !== JSON.stringify(current[field as keyof typeof current]),
        ),
      );
      const assigneeChanged =
        assigneeKey !== undefined && (assignee?.id ?? null) !== ticket.assigneeProfileId;
      if (Object.keys(changes).length === 0 && !assigneeChanged) {
        return detail(tx, project, ticket);
      }
      const at = now();
      const [updated] = await tx
        .update(schema.tickets)
        .set({
          ...changes,
          ...(assigneeChanged ? { assigneeProfileId: assignee?.id ?? null } : {}),
          updatedAt: at,
        })
        .where(eq(schema.tickets.id, ticket.id))
        .returning();
      if (!updated) throw new Error('ticket disappeared');
      // Long texts are not copied into the event log: the fields changed are named.
      const { type, title, priority } = changes;
      await recordEvent(tx, {
        actor: 'owner',
        ...ticketEntity(updated),
        type: 'ticket.updated',
        payload: {
          ...about(project, updated),
          fields: [...Object.keys(changes), ...(assigneeChanged ? ['assignee'] : [])],
          type,
          title,
          priority,
          ...(assigneeChanged ? { assignee: assignee?.key ?? null } : {}),
          ...(assigneeChanged && assignee ? { assigneeName: assignee.name } : {}),
        },
        at,
      });
      return detail(tx, project, updated);
    });
  });

  app.post<TicketParams>('/api/projects/:key/tickets/:number/dependencies', async (request) => {
    await requireSession(db, request);
    const input = parseInput(AddDependencyRequest, request.body);
    return change(request.params.key, async (tx, project) => {
      const ticket = await findTicket(tx, project.id, request.params.number);
      requireEditable(ticket, 'Dependencies of a ticket');
      if (input.blockedBy === ticket.number) {
        throw new HttpError(422, 'dependency_on_itself', 'A ticket cannot depend on itself');
      }
      const [blocker] = await tx
        .select()
        .from(schema.tickets)
        .where(
          and(eq(schema.tickets.projectId, project.id), eq(schema.tickets.number, input.blockedBy)),
        );
      if (!blocker) {
        throw new HttpError(
          422,
          'ticket_not_found',
          `No ticket ${ticketReference(project.key, input.blockedBy)} in this project`,
        );
      }

      const edges = await tx
        .select({
          ticketId: schema.ticketDependencies.ticketId,
          blockedById: schema.ticketDependencies.blockedById,
        })
        .from(schema.ticketDependencies)
        .where(eq(schema.ticketDependencies.projectId, project.id));
      if (edges.some((e) => e.ticketId === ticket.id && e.blockedById === blocker.id)) {
        return detail(tx, project, ticket);
      }
      const cycle = findPath(edges, blocker.id, ticket.id);
      if (cycle !== null) {
        const numbers = await tx
          .select({ id: schema.tickets.id, number: schema.tickets.number })
          .from(schema.tickets)
          .where(inArray(schema.tickets.id, cycle));
        const name = (id: string) =>
          ticketReference(project.key, numbers.find((row) => row.id === id)?.number ?? 0);
        const loop = [ticket.id, ...cycle].map(name);
        throw new HttpError(
          409,
          'dependency_cycle',
          `This dependency would make ${name(ticket.id)} wait for itself: ${loop.join(' → ')} (each waits for the next)`,
          { cycle: loop },
        );
      }

      const at = now();
      await tx.insert(schema.ticketDependencies).values({
        projectId: project.id,
        ticketId: ticket.id,
        blockedById: blocker.id,
        createdAt: at,
      });
      const updated = await touch(tx, ticket, at);
      await recordEvent(tx, {
        actor: 'owner',
        ...ticketEntity(ticket),
        type: 'ticket.dependency_added',
        payload: {
          ...about(project, ticket),
          blockedBy: ticketReference(project.key, blocker.number),
        },
        at,
      });
      return detail(tx, project, updated);
    });
  });

  app.delete<{ Params: { key: string; number: string; blockedBy: string } }>(
    '/api/projects/:key/tickets/:number/dependencies/:blockedBy',
    async (request) => {
      await requireSession(db, request);
      return change(request.params.key, async (tx, project) => {
        const ticket = await findTicket(tx, project.id, request.params.number);
        requireEditable(ticket, 'Dependencies of a ticket');
        const blockerNumber = parseNumber(request.params.blockedBy);
        const [blocker] =
          blockerNumber === null
            ? []
            : await tx
                .select()
                .from(schema.tickets)
                .where(
                  and(
                    eq(schema.tickets.projectId, project.id),
                    eq(schema.tickets.number, blockerNumber),
                  ),
                );
        const removed = blocker
          ? await tx
              .delete(schema.ticketDependencies)
              .where(
                and(
                  eq(schema.ticketDependencies.ticketId, ticket.id),
                  eq(schema.ticketDependencies.blockedById, blocker.id),
                ),
              )
              .returning()
          : [];
        if (!blocker || removed.length === 0) {
          throw new HttpError(
            404,
            'dependency_not_found',
            'This ticket does not depend on that one',
          );
        }
        const at = now();
        const updated = await touch(tx, ticket, at);
        await recordEvent(tx, {
          actor: 'owner',
          ...ticketEntity(ticket),
          type: 'ticket.dependency_removed',
          payload: {
            ...about(project, ticket),
            blockedBy: ticketReference(project.key, blocker.number),
          },
          at,
        });
        return detail(tx, project, updated);
      });
    },
  );

  app.post<TicketParams>('/api/projects/:key/tickets/:number/comments', async (request, reply) => {
    await requireSession(db, request);
    const input = parseInput(AddCommentRequest, request.body);
    await checkCommentLength(input.body, 'body');
    const result = await change(request.params.key, async (tx, project) => {
      // Owner notes are allowed on any ticket of an active project, terminal ones included.
      const ticket = await findTicket(tx, project.id, request.params.number);
      const at = now();
      const [comment] = await tx
        .insert(schema.comments)
        .values({
          ticketId: ticket.id,
          author: 'owner',
          kind: 'note',
          body: input.body,
          createdAt: at,
        })
        .returning({ id: schema.comments.id });
      if (!comment) throw new Error('comment not inserted');
      await recordEvent(tx, {
        actor: 'owner',
        ...ticketEntity(ticket),
        type: 'ticket.commented',
        payload: { ...about(project, ticket), commentId: comment.id, kind: 'note' },
        at,
      });
      return detail(tx, project, ticket);
    });
    return reply.code(201).send(result);
  });

  function ownerAction(
    path: string,
    action: OwnerTicketAction,
    comment: (body: unknown) => string | undefined,
    /** **Request changes**'s hold box (owner's new answer 2, lot 4 step A). */
    hold: (body: unknown) => boolean = () => false,
  ) {
    app.post<TicketParams>(`/api/projects/:key/tickets/:number/${path}`, async (request) => {
      await requireSession(db, request);
      const text = comment(request.body);
      const holdWanted = hold(request.body);
      if (text !== undefined) await checkCommentLength(text, 'comment');
      let afterCommit: () => Promise<void> = () => Promise.resolve();
      // Set inside the transaction's callback: a holder, so the type stays `string | null`.
      const closeWanted: { ticketId: string | null } = { ticketId: null };
      const result = await change(request.params.key, async (tx, project) => {
        const ticket = await findTicket(tx, project.id, request.params.number);
        if (
          action === 'mark_done' &&
          ticket.status === 'done' &&
          ticket.pullRequestMergedAt !== null &&
          ticket.pullRequestNumber !== null
        ) {
          // The merge was found first: exactly once (owner's answer 2, lot 3 step J1).
          throw new HttpError(
            409,
            'ticket_transition_not_allowed',
            `${ticketReference(project.key, ticket.number)} is already done: pull request #${String(ticket.pullRequestNumber)} was merged on GitHub.`,
          );
        }
        if (
          (action === 'request_changes' || action === 'skip_review') &&
          ticket.status === 'in_review'
        ) {
          // Never during a review run (owner's answer 6e and decision A, lot 3 step H2).
          const [active] = await tx
            .select({ id: schema.runs.id })
            .from(schema.runs)
            .where(
              and(
                eq(schema.runs.ticketId, ticket.id),
                inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]),
              ),
            );
          if (active) {
            throw new HttpError(
              409,
              'review_active',
              'A review run is active: wait for its end, or stop it first',
            );
          }
        }
        if (
          (action === 'cancel' || action === 'mark_done') &&
          refusal(action, TicketStatus.parse(ticket.status)) === null
        ) {
          afterCommit = await options.runs.endForTicket(
            tx,
            project,
            ticket,
            action === 'cancel' ? 'ticket_cancelled' : 'ticket_done',
          );
        }
        // The commit the owner's request is made on, and what it comes after (lot 3 step I).
        const changeRequest =
          action === 'request_changes' &&
          refusal(action, TicketStatus.parse(ticket.status)) === null
            ? {
                commit: await acceptedCommit(tx, ticket),
                after:
                  ticket.status === 'awaiting_merge'
                    ? requestAfter((await ticketReview(tx, ticket)).review.latest)
                    : null,
                // GitHub's fact at this moment, never the comment's text (owner's addition to
                // answer 4 of step J, lot 3 step J3b): it holds when the owner edits the text.
                conflict:
                  ticket.status === 'awaiting_merge'
                    ? (ticketConflict(ticket)?.base ?? null)
                    : null,
              }
            : undefined;
        let updated = await applyOwnerAction(tx, {
          projectKey: project.key,
          ticket,
          action,
          comment: text,
          changeRequest,
          now: now(),
        });
        if (RELEASING.has(action)) {
          // The owner's action replaces a hold; Request changes holds again with its box (07,
          // section 1; owner's new answer 2, lot 4 step A).
          await releaseHold(tx, project, updated, action as ReleaseAction, now());
          let held: TicketHold | null = null;
          if (action === 'request_changes' && holdWanted && updated.status === 'todo') {
            held = { cause: 'request_changes', at: now().toISOString(), runId: null, commit: null };
            await holdTicket(tx, project, updated, held, now());
          }
          updated = { ...updated, held };
        }
        const close =
          action === 'cancel' &&
          updated.status === 'cancelled' &&
          ticket.pullRequestState === 'open'
            ? { pullRequestCloseWantedAt: now(), pullRequestCloseFailure: null }
            : // Reopened: nothing is closed any more; a pull request already closed stays closed
              // until the next accepted submission (lot 3 step J3a).
              action === 'reopen' && ticket.pullRequestCloseWantedAt !== null
              ? { pullRequestCloseWantedAt: null, pullRequestCloseFailure: null }
              : null;
        if (close !== null) {
          // **Cancel** closes the pull request, after this transaction (04, section 2).
          const [changed] = await tx
            .update(schema.tickets)
            .set(close)
            .where(eq(schema.tickets.id, ticket.id))
            .returning();
          if (changed) updated = changed;
          if (close.pullRequestCloseWantedAt !== null) closeWanted.ticketId = ticket.id;
        }
        if (
          action === 'mark_done' &&
          updated.status === 'done' &&
          ticket.pullRequestNumber !== null &&
          ticket.pullRequestMergedAt !== null &&
          ticket.pullRequestMergedHead !== null &&
          ticket.pullRequestMergedInto !== null
        ) {
          // The cancel race finished: Reopen, then Mark as done manually, while the merged pull
          // request is still the ticket's own starts the clean-up now (owner's answer 3, step J2).
          await cleanUpWanted(tx, project, ticket, {
            number: ticket.pullRequestNumber,
            head: ticket.pullRequestMergedHead,
            into: ticket.pullRequestMergedInto,
          });
        }
        return detail(tx, project, updated);
      });
      await afterCommit();
      // Not awaited: GitHub's answer never delays the owner's Cancel; a failure is kept on the
      // ticket and tried again at the next check.
      if (closeWanted.ticketId !== null) void options.watcher.close(closeWanted.ticketId);
      request.log.info(
        { project: result.projectKey, ticket: result.number, action, status: result.status },
        'ticket status changed by the owner',
      );
      return result;
    });
  }

  ownerAction('cancel', 'cancel', () => undefined);
  ownerAction('mark-done', 'mark_done', (body) => parseInput(MarkDoneRequest, body).comment);
  ownerAction('reopen', 'reopen', () => undefined);
  ownerAction('accept', 'accept', () => undefined);
  ownerAction('reject', 'reject', (body) => parseInput(RejectRequest, body ?? {}).comment);
  ownerAction(
    'request-changes',
    'request_changes',
    (body) => parseInput(RequestChangesRequest, body).comment,
    (body) => parseInput(RequestChangesRequest, body).hold === true,
  );
  ownerAction('skip-review', 'skip_review', () => undefined);

  // **Try again** on a ticket the retry policy stopped (04, section 5; owner's answer 2, lot 3
  // step I): the stop cleared, `attempt_count` and `review_rounds` back to 0, with a comment.
  app.post<TicketParams>('/api/projects/:key/tickets/:number/try-again', async (request) => {
    await requireSession(db, request);
    const result = await change(request.params.key, async (tx, project) => {
      const ticket = await findTicket(tx, project.id, request.params.number);
      const stop = ticketStop(ticket);
      if (stop === null || ticket.status !== 'todo') {
        throw new HttpError(
          409,
          'ticket_not_stopped',
          'This ticket is not stopped: Run now can start it',
        );
      }
      const at = now();
      const [comment] = await tx
        .insert(schema.comments)
        .values({
          ticketId: ticket.id,
          author: 'owner',
          kind: 'status_change',
          body: tryAgainComment(stop),
          createdAt: at,
        })
        .returning({ id: schema.comments.id });
      if (!comment) throw new Error('comment not inserted');
      const [updated] = await tx
        .update(schema.tickets)
        .set({ stopped: null, attemptCount: 0, reviewRounds: 0, updatedAt: at })
        .where(eq(schema.tickets.id, ticket.id))
        .returning();
      if (!updated) throw new Error('ticket disappeared');
      await recordEvent(tx, {
        actor: 'owner',
        ...ticketEntity(ticket),
        type: 'ticket.tried_again',
        payload: { ...about(project, ticket), cause: stop.cause, commentId: comment.id },
        at,
      });
      return detail(tx, project, updated);
    });
    request.log.info(
      { project: result.projectKey, ticket: result.number },
      'stopped ticket tried again by the owner',
    );
    return result;
  });

  // **Try again** of "Pull request not opened" (04, section 3.1; lot 3 step F3): one attempt,
  // answered once made; the ticket must still want its pull request.
  app.post<TicketParams>(
    '/api/projects/:key/tickets/:number/pull-request/try-again',
    async (request) => {
      await requireSession(db, request);
      const project = await findProject(request.params.key);
      const ticket = await findTicket(db, project.id, request.params.number);
      if (ticket.pullRequestWantedSince === null || ['done', 'cancelled'].includes(ticket.status)) {
        throw new HttpError(
          409,
          'no_pull_request_wanted',
          'This ticket does not wait for its pull request: it was opened or updated already, or the ticket is done or cancelled',
        );
      }
      request.log.info(
        { project: project.key, ticket: ticket.number },
        'pull request tried again by the owner',
      );
      await options.pullRequests.request(ticket.id);
      const [after] = await db
        .select({
          failure: schema.tickets.pullRequestFailure,
          wanted: schema.tickets.pullRequestWantedSince,
          url: schema.tickets.pullRequestUrl,
        })
        .from(schema.tickets)
        .where(eq(schema.tickets.id, ticket.id));
      return {
        failure:
          after?.wanted === null || after?.failure == null
            ? null
            : PullRequestFailure.parse(after.failure),
        url: after?.url ?? null,
      } satisfies PullRequestTryAgainResponse;
    },
  );

  // **Reopen pull request** (lot 3 step J3a): the ticket's pull request closed without merging,
  // on a ticket neither done nor cancelled; one attempt, answered once made.
  app.post<TicketParams>(
    '/api/projects/:key/tickets/:number/pull-request/reopen',
    async (request) => {
      await requireSession(db, request);
      const project = await findProject(request.params.key);
      const ticket = await findTicket(db, project.id, request.params.number);
      if (['done', 'cancelled'].includes(ticket.status)) {
        throw new HttpError(
          409,
          'pull_request_not_closed',
          'This ticket is done or cancelled: its pull request is not reopened',
        );
      }
      if (ticket.pullRequestState !== 'closed' || ticket.pullRequestNumber === null) {
        throw new HttpError(
          409,
          'pull_request_not_closed',
          'This ticket has no pull request closed without merging',
        );
      }
      request.log.info(
        { project: project.key, ticket: ticket.number, pullRequest: ticket.pullRequestNumber },
        'pull request reopened by the owner',
      );
      return {
        failure: await options.watcher.reopen(ticket.id),
      } satisfies PullRequestReopenResponse;
    },
  );

  // **Check CI again** (04, section 3.1; lot 3 step G2c): one reading of the run's commit on
  // GitHub, starting no session; a refusal is `ci_check_refused` with the owner's words.
  app.post<TicketParams>('/api/projects/:key/tickets/:number/ci/check-again', async (request) => {
    await requireSession(db, request);
    const input = parseInput(CheckCiAgainRequest, request.body);
    const number = parseNumber(request.params.number);
    if (number === null) throw ticketNotFound();
    const answer = await options.ciAgain.check(request.params.key, number, input.runId);
    request.log.info(
      { project: request.params.key, ticket: number, run: input.runId, outcome: answer.outcome },
      'CI checked again by the owner',
    );
    return answer;
  });

  // The owner's answer to the open question (04, section 6): the waiting run receives it live, or
  // resumes on its machine; with that machine offline, the run fails with `machine_offline`.
  app.post<TicketParams>('/api/projects/:key/tickets/:number/answer', async (request) => {
    await requireSession(db, request);
    const input = parseInput(AnswerRequest, request.body);
    await checkCommentLength(input.body, 'body');
    const number = parseNumber(request.params.number);
    if (number === null) throw ticketNotFound();
    await options.runs.answer(request.params.key, number, input.body);
    const project = await findProject(request.params.key);
    const ticket = await findTicket(db, project.id, number);
    return detail(db, project, ticket);
  });
}

/** `ticket_import_invalid` with every problem of the file, as the preview lists them. */
function importRefusal(problems: TicketImportProblem[]): HttpError {
  return new HttpError(
    422,
    'ticket_import_invalid',
    `The file has ${String(problems.length)} problem${problems.length === 1 ? '' : 's'}: nothing was imported`,
    { importProblems: problems },
  );
}

/** `invalid_request` naming each field over its limit; the message keeps the API's field names. */
function limitRefusal(exceeded: LimitExceeded[], commentField = 'comment'): HttpError {
  const apiField: Record<LimitExceeded['field'], string> = {
    title: 'title',
    description: 'description',
    acceptance_criteria: 'acceptanceCriteria',
    acceptance_criterion: 'acceptanceCriteria',
    comment: commentField,
  };
  const message = exceeded
    .map(({ field, index, max, unit }) => {
      const path = index === undefined ? apiField[field] : `${apiField[field]}.${String(index)}`;
      return `${path}: at most ${String(max)}${unit === 'characters' ? ' characters' : ''}`;
    })
    .join('; ');
  return new HttpError(400, 'invalid_request', message, { limits: exceeded });
}
