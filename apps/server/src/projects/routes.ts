import { schema } from '@orchestrator/db';
import {
  AvailabilityQuery,
  CreateProjectRequest,
  ProjectKey,
  ProjectListQuery,
  RepositoryName,
  UpdateProjectRequest,
  slugify,
  type AvailabilityResponse,
  type LinkableRepositoriesResponse,
  type Project,
  type ProjectListResponse,
} from '@orchestrator/protocol';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/routes.js';
import type { Database } from '../database.js';
import { recordEvent } from '../events.js';
import { GitHubUnreachableError, type GitHubClient } from '../github/client.js';
import { storedTokenClient } from '../github/connection.js';
import {
  GitHubOperationError,
  findMissingHarness,
  findRepository,
  listOwnerRepositories,
} from '../github/repositories.js';
import { HttpError, parseInput } from '../http.js';
import { SecretUnreadableError, type SecretKey } from '../secrets.js';
import type { Settings } from '../settings.js';
import { projectEntity, toProject, type ProjectRow } from './model.js';
import { ProjectSetupRunner } from './setup.js';

export interface ProjectRoutesOptions {
  db: Database;
  key: SecretKey;
  settings: Settings;
  apiUrl: string;
  now?: () => Date;
}

/** Name of the unique constraint violated by a failed insert, or null for any other error. */
function uniqueViolation(error: unknown): string | null {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    const { code, constraint } = cause as Error & { code?: unknown; constraint?: unknown };
    if (code === '23505' && typeof constraint === 'string') return constraint;
  }
  return null;
}

const keyTaken = () =>
  new HttpError(409, 'project_key_taken', 'Another project already uses this key');
const alreadyLinked = () =>
  new HttpError(409, 'repository_already_linked', 'This repository is already linked to a project');

/** Projects (02, sections 6.1, 6.2 and 6.5). Archiving and editing never send a request to GitHub. */
export function registerProjectRoutes(app: FastifyInstance, options: ProjectRoutesOptions) {
  const { db } = options;
  const now = () => options.now?.() ?? new Date();
  const setups = new ProjectSetupRunner({ ...options, log: app.log });
  app.addHook('onClose', () => setups.idle());

  /** The stored-token client and the account it belongs to, or the reason there is none. */
  async function github(): Promise<{ client: GitHubClient; account: string }> {
    let client: GitHubClient | null;
    try {
      client = await storedTokenClient(options);
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      throw new HttpError(
        409,
        'github_token_unreadable',
        'The saved token cannot be decrypted with the current ORCHESTRATOR_SECRET_KEY; save the token again',
      );
    }
    const [connection] = await db
      .select({ account: schema.githubConnection.account })
      .from(schema.githubConnection);
    if (client === null || !connection) {
      throw new HttpError(409, 'github_not_connected', 'No GitHub token saved');
    }
    return { client, account: connection.account };
  }

  async function askGitHub<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof GitHubUnreachableError) {
        app.log.warn({ err: error }, 'GitHub unreachable');
        throw new HttpError(502, 'github_unreachable', 'GitHub could not be reached; try again');
      }
      if (error instanceof GitHubOperationError) {
        throw new HttpError(502, 'github_request_failed', error.message);
      }
      throw error;
    }
  }

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

  async function keyIsTaken(key: string): Promise<boolean> {
    const rows = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.key, key));
    return rows.length > 0;
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
    return { projects: rows.map(toProject) } satisfies ProjectListResponse;
  });

  app.get('/api/projects/availability', async (request) => {
    await requireSession(db, request);
    const query = parseInput(AvailabilityQuery, request.query);
    const result: AvailabilityResponse = {};
    if (query.key !== undefined) {
      result.key = !ProjectKey.safeParse(query.key).success
        ? 'invalid'
        : (await keyIsTaken(query.key))
          ? 'taken'
          : 'free';
    }
    if (query.repositoryName !== undefined) {
      if (!RepositoryName.safeParse(query.repositoryName).success) {
        result.repositoryName = 'invalid';
      } else {
        const { client, account } = await github();
        const found = await askGitHub(() =>
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
    const repositories = await askGitHub(() => listOwnerRepositories(client));
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
    if (await keyIsTaken(input.key)) throw keyTaken();
    const { client, account } = await github();
    const found = await askGitHub(() =>
      findRepository(client, { owner: account, name: input.repository.name }),
    );

    let values: typeof schema.projects.$inferInsert;
    const common = {
      key: input.key,
      name: input.name,
      description: input.description,
      kind: input.kind,
      setupStatus: 'in_progress',
    } as const;
    if (input.repository.origin === 'created') {
      if (found !== null) {
        throw new HttpError(
          409,
          'repository_name_taken',
          'A repository with this name already exists on your GitHub account',
        );
      }
      values = {
        ...common,
        slug: input.repository.name,
        repoOwner: account,
        repoName: input.repository.name,
        repoOrigin: 'created',
        repoPrivate: input.repository.private,
        setupStep: 'repository',
      };
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
        ...common,
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

    let row: ProjectRow;
    try {
      row = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(schema.projects)
          .values({ ...values, createdAt: now(), updatedAt: now() })
          .returning();
        if (!inserted) throw new Error('project not inserted');
        await recordEvent(tx, {
          actor: 'owner',
          ...projectEntity(inserted),
          type: 'project.created',
          payload: {
            key: inserted.key,
            name: inserted.name,
            kind: inserted.kind,
            origin: inserted.repoOrigin,
            repository: `${inserted.repoOwner}/${inserted.repoName}`,
            private: inserted.repoPrivate,
          },
        });
        return inserted;
      });
    } catch (error) {
      // Two requests at the same time: the database has the last word.
      const constraint = uniqueViolation(error);
      if (constraint === 'projects_key_unique') throw keyTaken();
      if (constraint === 'projects_repository') throw alreadyLinked();
      throw error;
    }
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
    const missing = await askGitHub(() =>
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
