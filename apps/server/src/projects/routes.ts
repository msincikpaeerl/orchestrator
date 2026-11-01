import { schema } from '@orchestrator/db';
import {
  AvailabilityQuery,
  CreateProjectRequest,
  defaultRequiredCapabilities,
  ProjectKey,
  ProjectListQuery,
  RepositoryName,
  TicketStatus,
  MergesAutomaticRequest,
  ReviewsAutomaticRequest,
  SetRequiredCapabilitiesRequest,
  UpdateProjectRequest,
  slugify,
  type AvailabilityResponse,
  type LinkableRepositoriesResponse,
  type Project,
  type ProjectListResponse,
  type TicketCounts,
} from '@orchestrator/protocol';
import { and, asc, count, eq, isNotNull, max, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/routes.js';
import { recordEvent } from '../events.js';
import {
  findMissingHarness,
  findRepository,
  listOwnerRepositories,
} from '../github/repositories.js';
import { HttpError, parseInput } from '../http.js';
import {
  alreadyLinked,
  askGitHub,
  githubAccount,
  insertProject,
  keyIsTaken,
  keyTaken,
  newRepositoryValues,
  repositoryNameTaken,
  type GitHubAccess,
} from './creation.js';
import { toProject, projectEntity, type ProjectRow } from './model.js';
import type { ProjectSetupRunner } from './setup.js';

export interface ProjectRoutesOptions extends GitHubAccess {
  /** Runs the setups, shared with the approval of a plan creating a project (lot 5 step G). */
  setups: ProjectSetupRunner;
  now?: () => Date;
}

/** Projects (02, sections 6.1, 6.2 and 6.5). Archiving and editing never send a request to GitHub. */
export function registerProjectRoutes(app: FastifyInstance, options: ProjectRoutesOptions) {
  const { db, setups } = options;
  const now = () => options.now?.() ?? new Date();

  const github = () => githubAccount({ ...options, log: app.log });
  const ask = <T>(action: () => Promise<T>) => askGitHub(app.log, action);

  async function findByKey(key: string): Promise<ProjectRow> {
    const parsed = ProjectKey.safeParse(key);
    const [row] = parsed.success
      ? await db.select().from(schema.projects).where(eq(schema.projects.key, parsed.data))
      : [];
    if (!row) throw new HttpError(404, 'project_not_found', 'No project with this key');
    return row;
  }

  function requireActive(row: ProjectRow) {
    if (row.status === 'archived') {
      throw new HttpError(409, 'project_archived', 'This project is archived: unarchive it first');
    }
  }

  async function linkedProject(owner: string, name: string): Promise<boolean> {
    const rows = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          sql`lower(${schema.projects.repoOwner}) = lower(${owner})`,
          sql`lower(${schema.projects.repoName}) = lower(${name})`,
        ),
      );
    return rows.length > 0;
  }

  app.get('/api/projects', async (request) => {
    await requireSession(db, request);
    const { archived } = parseInput(ProjectListQuery, request.query);
    const rows = await db
      .select()
      .from(schema.projects)
      .where(archived === 'true' ? undefined : eq(schema.projects.status, 'active'))
      .orderBy(asc(schema.projects.name), asc(schema.projects.key));
    const counts = await db
      .select({
        projectId: schema.tickets.projectId,
        status: schema.tickets.status,
        count: count(),
      })
      .from(schema.tickets)
      .groupBy(schema.tickets.projectId, schema.tickets.status);
    // Uses the index on (project_id, created_at, id).
    const activity = await db
      .select({ projectId: schema.events.projectId, at: max(schema.events.createdAt) })
      .from(schema.events)
      .where(isNotNull(schema.events.projectId))
      .groupBy(schema.events.projectId);
    const lastActivity = new Map(activity.map((each) => [each.projectId, each.at]));
    return {
      projects: rows.map((row) => {
        const ticketCounts = Object.fromEntries(
          TicketStatus.options.map((status) => [status, 0]),
        ) as TicketCounts;
        for (const each of counts) {
          if (each.projectId === row.id) ticketCounts[TicketStatus.parse(each.status)] = each.count;
        }
        const at = lastActivity.get(row.id);
        return { ...toProject(row), ticketCounts, lastActivity: at ? at.toISOString() : null };
      }),
    } satisfies ProjectListResponse;
  });

  app.get('/api/projects/availability', async (request) => {
    await requireSession(db, request);
    const query = parseInput(AvailabilityQuery, request.query);
    const result: AvailabilityResponse = {};
    if (query.key !== undefined) {
      result.key = !ProjectKey.safeParse(query.key).success
        ? 'invalid'
        : (await keyIsTaken(db, query.key))
          ? 'taken'
          : 'free';
    }
    if (query.repositoryName !== undefined) {
      if (!RepositoryName.safeParse(query.repositoryName).success) {
        result.repositoryName = 'invalid';
      } else {
        const { client, account } = await github();
        const found = await ask(() =>
          findRepository(client, { owner: account, name: query.repositoryName ?? '' }),
        );
        result.repositoryName = found === null ? 'free' : 'taken';
      }
    }
    return result;
  });

  app.get('/api/projects/linkable-repositories', async (request) => {
    await requireSession(db, request);
    const { client } = await github();
    const repositories = await ask(() => listOwnerRepositories(client));
    const linked = await db
      .select({ owner: schema.projects.repoOwner, name: schema.projects.repoName })
      .from(schema.projects);
    const isLinked = new Set(linked.map((repo) => `${repo.owner}/${repo.name}`.toLowerCase()));
    return {
      repositories: repositories
        .filter(
          (repo) => !repo.archived && !isLinked.has(`${repo.owner}/${repo.name}`.toLowerCase()),
        )
        .map((repo) => ({
          name: repo.name,
          private: repo.private,
          defaultBranch: repo.defaultBranch,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    } satisfies LinkableRepositoriesResponse;
  });

  app.post('/api/projects', async (request, reply) => {
    await requireSession(db, request);
    const input = parseInput(CreateProjectRequest, request.body);
    if (await keyIsTaken(db, input.key)) throw keyTaken();
    const { client, account } = await github();
    const found = await ask(() =>
      findRepository(client, { owner: account, name: input.repository.name }),
    );

    let values: typeof schema.projects.$inferInsert;
    if (input.repository.origin === 'created') {
      if (found !== null) throw repositoryNameTaken();
      values = newRepositoryValues({
        key: input.key,
        name: input.name,
        description: input.description,
        kind: input.kind,
        account,
        repositoryName: input.repository.name,
        private: input.repository.private,
      });
    } else {
      if (found === null) {
        throw new HttpError(
          422,
          'repository_not_found',
          'No repository with this name on your GitHub account',
        );
      }
      if (found.archived) {
        throw new HttpError(
          422,
          'repository_archived',
          'This repository is archived on GitHub: unarchive it there first',
        );
      }
      if (await linkedProject(found.owner, found.name)) throw alreadyLinked();
      values = {
        key: input.key,
        name: input.name,
        description: input.description,
        kind: input.kind,
        // A new repository or a linked one alike (owner's answer, lot 5 step C).
        requiredCapabilities: defaultRequiredCapabilities(input.kind),
        setupStatus: 'in_progress',
        slug: slugify(input.name) || input.key.toLowerCase(),
        repoOwner: found.owner,
        repoName: found.name,
        repoOrigin: 'linked',
        repoPrivate: found.private,
        defaultBranch: found.defaultBranch,
        branchProtection: 'not_applied',
        setupStep: 'harness',
      };
    }

    const row = await db.transaction((tx) => insertProject(tx, values, { at: now() }));
    request.log.info({ project: row.key, origin: row.repoOrigin }, 'project created');
    setups.start(row.id);
    return reply.code(201).send(toProject(row) satisfies Project);
  });

  app.get<{ Params: { key: string } }>('/api/projects/:key', async (request) => {
    await requireSession(db, request);
    return toProject(await findByKey(request.params.key));
  });

  app.patch<{ Params: { key: string } }>('/api/projects/:key', async (request) => {
    await requireSession(db, request);
    const input = parseInput(UpdateProjectRequest, request.body);
    const project = await findByKey(request.params.key);
    requireActive(project);
    const changes = Object.fromEntries(
      Object.entries(input).filter(
        ([field, value]) => value !== project[field as keyof typeof input],
      ),
    );
    if (Object.keys(changes).length === 0) return toProject(project);
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(schema.projects)
        .set({ ...changes, updatedAt: now() })
        .where(and(eq(schema.projects.id, project.id), eq(schema.projects.status, 'active')))
        .returning();
      if (!updated) throw new HttpError(409, 'project_archived', 'This project is archived');
      await recordEvent(tx, {
        actor: 'owner',
        ...projectEntity(updated),
        type: 'project.updated',
        payload: { key: updated.key, ...changes },
      });
      return updated;
    });
    return toProject(row);
  });

  // **Start reviews by themselves** (02, section 6.5; 07, section 1; lot 4 step D3): a review not
  // started yet waits for Start review once it is off, and is the scheduler's again once it is on;
  // a review run already started goes on either way.
  app.put<{ Params: { key: string } }>('/api/projects/:key/reviews-automatic', async (request) => {
    await requireSession(db, request);
    const { on } = parseInput(ReviewsAutomaticRequest, request.body);
    const project = await findByKey(request.params.key);
    requireActive(project);
    if (project.reviewsAutomatic === on) return toProject(project);
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(schema.projects)
        .set({ reviewsAutomatic: on, updatedAt: now() })
        .where(and(eq(schema.projects.id, project.id), eq(schema.projects.status, 'active')))
        .returning();
      if (!updated) throw new HttpError(409, 'project_archived', 'This project is archived');
      await recordEvent(tx, {
        actor: 'owner',
        ...projectEntity(updated),
        type: 'project.reviews_automatic_changed',
        payload: { key: updated.key, on },
      });
      return updated;
    });
    request.log.info({ project: row.key, on }, 'Start reviews by themselves changed');
    return toProject(row);
  });

  // **Merge automatically** (02, section 6.5; 04, section 4; lot 5 step 5bis B): from the next
  // approval on, or no more merges wanted; a merge already sent to GitHub is settled either way.
  app.put<{ Params: { key: string } }>('/api/projects/:key/merges-automatic', async (request) => {
    await requireSession(db, request);
    const { on } = parseInput(MergesAutomaticRequest, request.body);
    const project = await findByKey(request.params.key);
    requireActive(project);
    if (project.mergesAutomatic === on) return toProject(project);
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(schema.projects)
        .set({ mergesAutomatic: on, updatedAt: now() })
        .where(and(eq(schema.projects.id, project.id), eq(schema.projects.status, 'active')))
        .returning();
      if (!updated) throw new HttpError(409, 'project_archived', 'This project is archived');
      await recordEvent(tx, {
        actor: 'owner',
        ...projectEntity(updated),
        type: 'project.merges_automatic_changed',
        payload: { key: updated.key, on },
      });
      return updated;
    });
    request.log.info({ project: row.key, on }, 'Merge automatically changed');
    return toProject(row);
  });

  // Required capabilities (02, section 6.5; lot 5 step C2): each later run of the project needs a
  // machine with all of them; a run already started goes on where it is.
  app.put<{ Params: { key: string } }>(
    '/api/projects/:key/required-capabilities',
    async (request) => {
      await requireSession(db, request);
      const { capabilities } = parseInput(SetRequiredCapabilitiesRequest, request.body);
      const project = await findByKey(request.params.key);
      requireActive(project);
      const previous = toProject(project).requiredCapabilities;
      if (previous.join() === capabilities.join()) return toProject(project);
      const row = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(schema.projects)
          .set({ requiredCapabilities: capabilities, updatedAt: now() })
          .where(and(eq(schema.projects.id, project.id), eq(schema.projects.status, 'active')))
          .returning();
        if (!updated) throw new HttpError(409, 'project_archived', 'This project is archived');
        await recordEvent(tx, {
          actor: 'owner',
          ...projectEntity(updated),
          type: 'project.required_capabilities_changed',
          payload: { key: updated.key, previous, capabilities },
        });
        return updated;
      });
      request.log.info({ project: row.key, capabilities }, 'required capabilities changed');
      return toProject(row);
    },
  );

  app.post<{ Params: { key: string } }>(
    '/api/projects/:key/setup/retry',
    async (request, reply) => {
      await requireSession(db, request);
      const project = await findByKey(request.params.key);
      requireActive(project);
      const row = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(schema.projects)
          .set({
            setupStatus: 'in_progress',
            setupFailure: null,
            setupFailedAt: null,
            updatedAt: now(),
          })
          .where(
            and(
              eq(schema.projects.id, project.id),
              eq(schema.projects.status, 'active'),
              eq(schema.projects.setupStatus, 'failed'),
            ),
          )
          .returning();
        if (!updated) return null;
        await recordEvent(tx, {
          actor: 'owner',
          ...projectEntity(updated),
          type: 'project.setup_retried',
          payload: { key: updated.key, step: updated.setupStep },
        });
        return updated;
      });
      if (row === null) {
        throw new HttpError(
          409,
          'project_setup_not_failed',
          'The setup of this project has not failed',
        );
      }
      request.log.info({ project: row.key, step: row.setupStep }, 'project setup tried again');
      setups.start(row.id);
      return reply.code(202).send(toProject(row));
    },
  );

  app.post<{ Params: { key: string } }>('/api/projects/:key/harness/check', async (request) => {
    await requireSession(db, request);
    const project = await findByKey(request.params.key);
    requireActive(project);
    if (project.repoOrigin !== 'linked') {
      throw new HttpError(
        409,
        'project_not_linked',
        'Harness elements are checked for linked repositories only',
      );
    }
    if (project.setupStatus !== 'ready') {
      throw new HttpError(
        409,
        'project_not_ready',
        'The setup of this project is not done: try it again instead',
      );
    }
    const { client } = await github();
    const missing = await ask(() =>
      findMissingHarness(client, {
        owner: project.repoOwner,
        name: project.repoName,
        defaultBranch: project.defaultBranch ?? '',
      }),
    );
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(schema.projects)
        .set({ missingHarness: missing, harnessCheckedAt: now(), updatedAt: now() })
        .where(eq(schema.projects.id, project.id))
        .returning();
      if (!updated) throw new Error('project disappeared');
      await recordEvent(tx, {
        actor: 'owner',
        ...projectEntity(updated),
        type: 'project.harness_checked',
        payload: { key: updated.key, missing },
      });
      return updated;
    });
    return toProject(row);
  });

  /** Archive or unarchive; never changes the GitHub repository (01, section 3.1). */
  async function setStatus(key: string, status: 'active' | 'archived'): Promise<Project> {
    const project = await findByKey(key);
    if (project.status === status) {
      throw status === 'archived'
        ? new HttpError(409, 'project_archived', 'This project is already archived')
        : new HttpError(409, 'project_not_archived', 'This project is not archived');
    }
    if (status === 'archived' && project.setupStatus === 'in_progress') {
      throw new HttpError(
        409,
        'project_setup_in_progress',
        'The repository setup is running: wait for it to finish',
      );
    }
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(schema.projects)
        .set({ status, updatedAt: now() })
        .where(
          and(
            eq(schema.projects.id, project.id),
            eq(schema.projects.status, project.status),
            // Checked again here: a retry may have started since the read above.
            status === 'archived'
              ? sql`${schema.projects.setupStatus} <> 'in_progress'`
              : undefined,
          ),
        )
        .returning();
      if (!updated) return null;
      await recordEvent(tx, {
        actor: 'owner',
        ...projectEntity(updated),
        type: status === 'archived' ? 'project.archived' : 'project.unarchived',
        payload: { key: updated.key },
      });
      return updated;
    });
    if (row === null) {
      throw new HttpError(
        409,
        'project_setup_in_progress',
        'The project changed meanwhile: try again',
      );
    }
    return toProject(row);
  }

  app.post<{ Params: { key: string } }>('/api/projects/:key/archive', async (request) => {
    await requireSession(db, request);
    return setStatus(request.params.key, 'archived');
  });

  app.post<{ Params: { key: string } }>('/api/projects/:key/unarchive', async (request) => {
    await requireSession(db, request);
    return setStatus(request.params.key, 'active');
  });
}
