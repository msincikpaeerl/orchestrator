import { schema } from '@orchestrator/db';
import {
  BranchProtection,
  HarnessElement,
  ProjectKey,
  ProjectKind,
  ProjectStatus,
  RepositoryOrigin,
  SetupStatus,
  SetupStep,
  type Project,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../database.js';

export type ProjectRow = typeof schema.projects.$inferSelect;

/** The API's view of a project. Parsing the text columns catches a value no code should write. */
export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    key: ProjectKey.parse(row.key),
    name: row.name,
    slug: row.slug,
    description: row.description,
    kind: ProjectKind.parse(row.kind),
    repository: {
      owner: row.repoOwner,
      name: row.repoName,
      origin: RepositoryOrigin.parse(row.repoOrigin),
      private: row.repoPrivate,
      defaultBranch: row.defaultBranch,
    },
    setup: {
      status: SetupStatus.parse(row.setupStatus),
      step: SetupStep.nullable().parse(row.setupStep),
      failure: row.setupFailure,
    },
    branchProtection: BranchProtection.nullable().parse(row.branchProtection),
    harness:
      row.harnessCheckedAt === null
        ? null
        : {
            missing: z.array(HarnessElement).parse(row.missingHarness),
            checkedAt: row.harnessCheckedAt.toISOString(),
          },
    status: ProjectStatus.parse(row.status),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function findProjectById(db: Executor, id: string): Promise<ProjectRow | null> {
  const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
  return row ?? null;
}

/** Entity of the events about a project; their payloads also give its key. */
export function projectEntity(row: Pick<ProjectRow, 'id'>) {
  return { entityType: 'project', entityId: row.id } as const;
}
