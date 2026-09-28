import { schema } from '@orchestrator/db';
import {
  AddCommentRequest,
  AddDependencyRequest,
  AnswerRequest,
  DodReport,
  CreateTicketRequest,
  EDITABLE_STATUSES,
  MarkDoneRequest,
  ProjectKey,
  RejectRequest,
  TicketNumber,
  TicketStatus,
  UpdateTicketRequest,
  type AgentLink,
  type LimitExceeded,
  type OwnerTicketAction,
  type TicketDetail,
  type TicketListResponse,
  type TimelineEntry,
} from '@orchestrator/protocol';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/routes.js';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { HttpError, parseInput } from '../http.js';
import type { ProjectRow } from '../projects/model.js';
import { reportedCommits } from '../runs/model.js';
import type { RunService } from '../runs/service.js';
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
import { applyOwnerAction, insertOwnerTicket, refusal } from './transitions.js';

export interface TicketRoutesOptions {
  db: Database;
  /** Cancel and Mark as done manually stop the ticket's active run (04, section 2). */
  runs: RunService;
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
    if (!row) {
      throw new HttpError(422, 'agent_not_found', `No agent profile with the key ${key}`);
    }
    return row;
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
    const settings = await resolveSettings(db, [
      'ticketTitleMaxLength',
      'ticketDescriptionMaxLength',
      'ticketMaxAcceptanceCriteria',
      'acceptanceCriterionMaxLength',
    ]);
    const exceeded: LimitExceeded[] = [];
    if (fields.title !== undefined && fields.title.length > settings.ticketTitleMaxLength) {
      exceeded.push({ field: 'title', max: settings.ticketTitleMaxLength, unit: 'characters' });
    }
    if (
      fields.description !== undefined &&
      fields.description.length > settings.ticketDescriptionMaxLength
    ) {
      exceeded.push({
        field: 'description',
        max: settings.ticketDescriptionMaxLength,
        unit: 'characters',
      });
    }
    const criteria = fields.acceptanceCriteria ?? [];
    if (criteria.length > settings.ticketMaxAcceptanceCriteria) {
      exceeded.push({
        field: 'acceptance_criteria',
        max: settings.ticketMaxAcceptanceCriteria,
        unit: 'items',
      });
    }
    criteria.forEach((criterion, index) => {
      if (criterion.length > settings.acceptanceCriterionMaxLength) {
        exceeded.push({
          field: 'acceptance_criterion',
          index,
          max: settings.acceptanceCriterionMaxLength,
          unit: 'characters',
        });
      }
    });
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

    // The branch as the last run that reported it saw it, on that run's machine (01, section 3.4).
    const [reported] = await executor
      .select({ run: schema.runs, machineName: schema.machines.name })
      .from(schema.runs)
      .innerJoin(schema.machines, eq(schema.machines.id, schema.runs.machineId))
      .where(and(eq(schema.runs.ticketId, ticket.id), isNotNull(schema.runs.commits)))
      .orderBy(desc(schema.runs.createdAt))
      .limit(1);
    const branch =
      ticket.branchName === null
        ? null
        : reported
          ? {
              name: ticket.branchName,
              machine: { id: reported.run.machineId, name: reported.machineName },
              head: reported.run.branchHead,
              commits: reportedCommits(reported.run) ?? [],
            }
          : { name: ticket.branchName, machine: null, head: null, commits: [] };

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
      dodReport: ticket.dodReport === null ? null : DodReport.parse(ticket.dodReport),
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

      // Under the project's lock: numbers follow each other and are never given twice.
      const [counter] = await tx
        .update(schema.projects)
        .set({ lastTicketNumber: sql`${schema.projects.lastTicketNumber} + 1` })
        .where(eq(schema.projects.id, project.id))
        .returning({ number: schema.projects.lastTicketNumber });
      if (!counter) throw new Error('project disappeared');

      const at = now();
      const ticket = await insertOwnerTicket(tx, {
        projectId: project.id,
        number: counter.number,
        type: input.type,
        title: input.title,
        description: input.description,
        acceptanceCriteria: input.acceptanceCriteria,
        priority: input.priority,
        assigneeProfileId: assignee?.id ?? null,
        now: at,
      });
      if (blockers.length > 0) {
        await tx.insert(schema.ticketDependencies).values(
          blockers.map((row) => ({
            projectId: project.id,
            ticketId: ticket.id,
            blockedById: row.id,
            createdAt: at,
          })),
        );
      }
      await recordEvent(tx, {
        actor: 'owner',
        ...ticketEntity(ticket),
        type: 'ticket.created',
        payload: {
          ...about(project, ticket),
          type: ticket.type,
          title: ticket.title,
          priority: ticket.priority,
          status: ticket.status,
          blockedBy: blockers.map((row) => ticketReference(project.key, row.number)).sort(),
          assignee: assignee?.key ?? null,
          ...(assignee ? { assigneeName: assignee.name } : {}),
        },
        at,
      });
      return detail(tx, project, ticket);
    });
    request.log.info({ project: created.projectKey, ticket: created.number }, 'ticket created');
    return reply.code(201).send(created);
  });

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
  ) {
    app.post<TicketParams>(`/api/projects/:key/tickets/:number/${path}`, async (request) => {
      await requireSession(db, request);
      const text = comment(request.body);
      if (text !== undefined) await checkCommentLength(text, 'comment');
      let afterCommit: () => void = () => undefined;
      const result = await change(request.params.key, async (tx, project) => {
        const ticket = await findTicket(tx, project.id, request.params.number);
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
        const updated = await applyOwnerAction(tx, {
          projectKey: project.key,
          ticket,
          action,
          comment: text,
          now: now(),
        });
        return detail(tx, project, updated);
      });
      afterCommit();
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

/**
 * The tickets `from` waits for, directly or not, up to `to`: `[from, ..., to]`, or null when
 * `from` does not wait for `to`. Adding "`to` waits for `from`" would then close a cycle.
 */
export function findPath(
  edges: readonly { ticketId: string; blockedById: string }[],
  from: string,
  to: string,
): string[] | null {
  const waitsFor = new Map<string, string[]>();
  for (const edge of edges) {
    waitsFor.set(edge.ticketId, [...(waitsFor.get(edge.ticketId) ?? []), edge.blockedById]);
  }
  const previous = new Map<string, string>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === to) {
      const path = [to];
      while (path[0] !== from) path.unshift(previous.get(path[0] as string) as string);
      return path;
    }
    for (const next of waitsFor.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, current);
      queue.push(next);
    }
  }
  return null;
}
