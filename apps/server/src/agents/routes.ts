import { schema } from '@orchestrator/db';
import { AgentRole, type AgentListResponse } from '@orchestrator/protocol';
import { asc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/routes.js';
import type { Database } from '../database.js';

/** The agent profiles, for the assignee of a ticket (02, section 6.3; the Agents screens: lot 7). */
export function registerAgentRoutes(app: FastifyInstance, { db }: { db: Database }) {
  app.get('/api/agents', async (request) => {
    await requireSession(db, request);
    const rows = await db
      .select()
      .from(schema.agentProfiles)
      .orderBy(asc(schema.agentProfiles.name));
    return {
      agents: rows.map((row) => ({
        key: row.key,
        name: row.name,
        description: row.description,
        role: AgentRole.parse(row.role),
        model: row.model,
        version: row.version,
      })),
    } satisfies AgentListResponse;
  });
}
