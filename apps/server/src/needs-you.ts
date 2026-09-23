import { schema } from '@orchestrator/db';
import type { NeedsYouResponse } from '@orchestrator/protocol';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession } from './auth/routes.js';
import type { Database } from './database.js';
import { toProject } from './projects/model.js';

/**
 * "Needs you" items (02, section 4), oldest first. GitHub connection problems are part of
 * `GET /api/github`.
 */
export function registerNeedsYouRoutes(app: FastifyInstance, { db }: { db: Database }) {
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
    return { items } satisfies NeedsYouResponse;
  });
}
