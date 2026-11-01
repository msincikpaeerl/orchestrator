import { schema } from '@orchestrator/db';
import { defaultRequiredCapabilities, type ProjectKind } from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { GitHubUnreachableError, type GitHubClient } from '../github/client.js';
import { storedTokenClient } from '../github/connection.js';
import { GitHubOperationError, findRepository } from '../github/repositories.js';
import { HttpError, uniqueViolation } from '../http.js';
import { SecretUnreadableError, type SecretKey } from '../secrets.js';
import { projectEntity, type ProjectRow } from './model.js';

/*
 * What creating a project needs, shared by the Projects screen (02, section 6.2) and the approval
 * of a plan that creates one (02, section 5.3; lot 5 step G): the GitHub account, the checks of
 * the key and the repository name, and the project's row with its `project.created` event.
 */

export interface GitHubAccess {
  db: Database;
  key: SecretKey;
  apiUrl: string;
}

export const keyTaken = () =>
  new HttpError(409, 'project_key_taken', 'Another project already uses this key');
export const alreadyLinked = () =>
  new HttpError(409, 'repository_already_linked', 'This repository is already linked to a project');
export const repositoryNameTaken = () =>
  new HttpError(
    409,
    'repository_name_taken',
    'A repository with this name already exists on your GitHub account',
  );

/** The stored-token client and the account it belongs to, or the reason there is none. */
export async function githubAccount(
  options: GitHubAccess & { log: FastifyBaseLogger },
): Promise<{ client: GitHubClient; account: string }> {
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
  const [connection] = await options.db
    .select({ account: schema.githubConnection.account })
    .from(schema.githubConnection);
  if (client === null || !connection) {
    throw new HttpError(409, 'github_not_connected', 'No GitHub token saved');
  }
  return { client, account: connection.account };
}

/** A request to GitHub, its failures in the owner's words. */
export async function askGitHub<T>(log: FastifyBaseLogger, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof GitHubUnreachableError) {
      log.warn({ err: error }, 'GitHub unreachable');
      throw new HttpError(502, 'github_unreachable', 'GitHub could not be reached; try again');
    }
    if (error instanceof GitHubOperationError) {
      throw new HttpError(502, 'github_request_failed', error.message);
    }
    throw error;
  }
}

export async function keyIsTaken(executor: Executor, key: string): Promise<boolean> {
  const rows = await executor
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.key, key));
  return rows.length > 0;
}

/** Refused when the owner's account already has a repository with this name. */
export async function requireRepositoryNameFree(
  log: FastifyBaseLogger,
  github: { client: GitHubClient; account: string },
  name: string,
): Promise<void> {
  const found = await askGitHub(log, () =>
    findRepository(github.client, { owner: github.account, name }),
  );
  if (found !== null) throw repositoryNameTaken();
}

/** A project with a new repository, before its setup (08, section 3.1). */
export function newRepositoryValues(input: {
  key: string;
  name: string;
  description: string;
  kind: ProjectKind;
  account: string;
  repositoryName: string;
  private: boolean;
}): typeof schema.projects.$inferInsert {
  return {
    key: input.key,
    name: input.name,
    description: input.description,
    kind: input.kind,
    // A new repository or a linked one alike (owner's answer, lot 5 step C).
    requiredCapabilities: defaultRequiredCapabilities(input.kind),
    setupStatus: 'in_progress',
    slug: input.repositoryName,
    repoOwner: input.account,
    repoName: input.repositoryName,
    repoOrigin: 'created',
    repoPrivate: input.private,
    setupStep: 'repository',
  };
}

/**
 * Inserts the project and records `project.created` (the owner's), with the request whose plan
 * created it, if any. Two creations at the same time: the database has the last word, given as
 * the refusal of the key or the repository.
 */
export async function insertProject(
  tx: Executor,
  values: typeof schema.projects.$inferInsert,
  input: { at: Date; request?: number },
): Promise<ProjectRow> {
  let inserted: ProjectRow | undefined;
  try {
    // The refusal ends the caller's transaction, which then rolls back.
    [inserted] = await tx
      .insert(schema.projects)
      .values({ ...values, createdAt: input.at, updatedAt: input.at })
      .returning();
  } catch (error) {
    const constraint = uniqueViolation(error);
    if (constraint === 'projects_key_unique') throw keyTaken();
    if (constraint === 'projects_repository') throw alreadyLinked();
    throw error;
  }
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
      requiredCapabilities: inserted.requiredCapabilities,
      ...(input.request === undefined ? {} : { request: input.request }),
    },
    at: input.at,
  });
  return inserted;
}
