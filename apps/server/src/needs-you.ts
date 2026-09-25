import { schema } from '@orchestrator/db';
import {
  CLAUDE_CODE_MIN_VERSION,
  DoctorCheck,
  type NeedsYouResponse,
} from '@orchestrator/protocol';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { requireSession } from './auth/routes.js';
import type { Database } from './database.js';
import { doctorErrors } from './machines/model.js';
import { toProject } from './projects/model.js';

/**
 * "Needs you" items (02, section 4): setup still to do first, then the others oldest first.
 * GitHub connection problems are part of `GET /api/github`.
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
          since: machine.daemonIncompatibleSince.toISOString(),
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
    }
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
    return { items: [...setup, ...items] } satisfies NeedsYouResponse;
  });
}
