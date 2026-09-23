import { schema } from '@orchestrator/db';
import { SETUP_STEPS, RepositoryOrigin, SetupStep } from '@orchestrator/protocol';
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../database.js';
import { recordEvent } from '../events.js';
import { GitHubUnreachableError, type GitHubClient } from '../github/client.js';
import { storedTokenClient } from '../github/connection.js';
import {
  GitHubOperationError,
  applyBranchProtection,
  applySkeleton,
  createRepository,
  findMissingHarness,
  findRepository,
} from '../github/repositories.js';
import { renderSkeleton } from '../github/skeleton.js';
import { SecretUnreadableError, type SecretKey } from '../secrets.js';
import type { Settings } from '../settings.js';
import { findProjectById, projectEntity, type ProjectRow } from './model.js';

// Repository setup of a project (08, sections 3.1 and 3.4), run in the background after the
// project is saved. Each step records its result before the next one starts, so trying again
// resumes from the failed step.

/** A step could not be done; `message` is written for the owner. */
class SetupError extends Error {
  override name = 'SetupError';
}

/** Reason shown to the owner for a failed step. Never contains the token. */
function failureReason(error: unknown): string | null {
  if (error instanceof GitHubOperationError || error instanceof SetupError) return error.message;
  if (error instanceof GitHubUnreachableError) {
    return 'GitHub could not be reached: try again later';
  }
  if (error instanceof SecretUnreadableError) {
    return 'The saved GitHub token cannot be decrypted (ORCHESTRATOR_SECRET_KEY changed): save the token again in Settings, then try again';
  }
  return null;
}

/** Reason of a setup left `in_progress` when the server stopped. */
export const INTERRUPTED_REASON = 'The setup was interrupted by a restart of the server';

/**
 * Run at start, before requests are accepted: a setup still `in_progress` was interrupted, so it
 * becomes `failed` and the owner can try again.
 */
export async function failInterruptedSetups(db: Database): Promise<number> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const rows = await tx
      .update(schema.projects)
      .set({
        setupStatus: 'failed',
        setupFailure: INTERRUPTED_REASON,
        setupFailedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.projects.setupStatus, 'in_progress'))
      .returning();
    for (const row of rows) {
      await recordEvent(tx, {
        actor: 'system',
        ...projectEntity(row),
        type: 'project.setup_failed',
        payload: { key: row.key, step: row.setupStep, reason: INTERRUPTED_REASON },
      });
    }
    return rows.length;
  });
}

export interface ProjectSetupOptions {
  db: Database;
  key: SecretKey;
  apiUrl: string;
  settings: Settings;
  log: FastifyBaseLogger;
  now?: () => Date;
}

/** Starts setups in the background and lets the server wait for them before closing. */
export class ProjectSetupRunner {
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly options: ProjectSetupOptions) {}

  /** Runs the setup of a project whose status is `in_progress`, from its current step. */
  start(projectId: string): void {
    const task = this.run(projectId)
      .catch((error: unknown) => {
        this.options.log.error({ err: error, projectId }, 'project setup crashed');
      })
      .finally(() => this.running.delete(task));
    this.running.add(task);
  }

  /** Resolves when no setup is running. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private async run(projectId: string): Promise<void> {
    const { db } = this.options;
    let project = await findProjectById(db, projectId);
    if (project?.setupStatus !== 'in_progress') return;
    const log = this.options.log.child({ project: project.key });
    const steps = SETUP_STEPS[RepositoryOrigin.parse(project.repoOrigin)];
    let step = SetupStep.parse(project.setupStep);
    log.info({ step }, 'project setup started');
    try {
      const client = await storedTokenClient(this.options);
      if (client === null) {
        throw new SetupError(
          'No GitHub token is saved: connect GitHub in Settings, then try again',
        );
      }
      for (;;) {
        const payload = await this.runStep(client, project, step);
        const next = steps[steps.indexOf(step) + 1];
        project = await this.finishStep(project, step, payload, next ?? null);
        log.info({ step, ...payload }, 'project setup step done');
        if (next === undefined) break;
        step = next;
      }
      log.info('project ready');
    } catch (error) {
      const reason = failureReason(error);
      if (reason === null) log.error({ err: error, step }, 'project setup step crashed');
      else log.warn({ step, reason }, 'project setup step failed');
      await this.fail(project, step, reason ?? 'Unexpected error: see the server logs');
    }
  }

  /** Does one step; its result is the event payload. */
  private async runStep(
    client: GitHubClient,
    project: ProjectRow,
    step: SetupStep,
  ): Promise<Record<string, unknown>> {
    const repo = { owner: project.repoOwner, name: project.repoName };
    const defaultBranch = project.defaultBranch ?? '';
    switch (step) {
      case 'repository': {
        // An earlier attempt may have created it without the answer reaching us.
        let created = project.repoRequestedAt === null ? null : await findRepository(client, repo);
        if (created === null) {
          await this.update(project, { repoRequestedAt: this.now() });
          created = await createRepository(client, {
            name: project.repoName,
            description: project.description,
            private: project.repoPrivate,
          });
        }
        await this.update(project, {
          repoOwner: created.owner,
          repoName: created.name,
          repoPrivate: created.private,
          defaultBranch: created.defaultBranch,
        });
        return {
          repository: `${created.owner}/${created.name}`,
          private: created.private,
          defaultBranch: created.defaultBranch,
        };
      }
      case 'skeleton': {
        const files = await renderSkeleton({
          name: project.name,
          description: project.description,
          defaultBranch,
          date: this.now().toISOString().slice(0, 10),
        });
        return applySkeleton(client, { ...repo, defaultBranch }, files);
      }
      case 'branch_protection': {
        const result = await applyBranchProtection(client, repo);
        await this.update(project, { branchProtection: result.status });
        if (result.status === 'failed') throw new SetupError(result.reason);
        return { branchProtection: result.status };
      }
      case 'harness': {
        const missing = await findMissingHarness(client, { ...repo, defaultBranch });
        await this.update(project, { missingHarness: missing, harnessCheckedAt: this.now() });
        return { missing };
      }
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async update(
    project: ProjectRow,
    values: Partial<typeof schema.projects.$inferInsert>,
  ): Promise<void> {
    await this.options.db
      .update(schema.projects)
      .set({ ...values, updatedAt: this.now() })
      .where(eq(schema.projects.id, project.id));
  }

  /** Records the step and moves to the next one, or to `ready` after the last. */
  private async finishStep(
    project: ProjectRow,
    step: SetupStep,
    payload: Record<string, unknown>,
    next: SetupStep | null,
  ): Promise<ProjectRow> {
    return this.options.db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.projects)
        .set({
          setupStep: next,
          setupStatus: next === null ? 'ready' : 'in_progress',
          updatedAt: this.now(),
        })
        .where(eq(schema.projects.id, project.id))
        .returning();
      if (!row) throw new Error(`project ${project.id} disappeared`);
      await recordEvent(tx, {
        actor: 'system',
        ...projectEntity(row),
        type: 'project.setup_step',
        payload: { key: row.key, step, ...payload },
      });
      if (next === null) {
        await recordEvent(tx, {
          actor: 'system',
          ...projectEntity(row),
          type: 'project.ready',
          payload: { key: row.key },
        });
      }
      return row;
    });
  }

  private async fail(project: ProjectRow, step: SetupStep, reason: string): Promise<void> {
    await this.options.db.transaction(async (tx) => {
      const now = this.now();
      const [row] = await tx
        .update(schema.projects)
        .set({
          setupStatus: 'failed',
          setupStep: step,
          setupFailure: reason,
          setupFailedAt: now,
          updatedAt: now,
        })
        .where(
          and(eq(schema.projects.id, project.id), eq(schema.projects.setupStatus, 'in_progress')),
        )
        .returning();
      if (!row) return;
      await recordEvent(tx, {
        actor: 'system',
        ...projectEntity(row),
        type: 'project.setup_failed',
        payload: { key: row.key, step, reason },
      });
    });
  }
}
