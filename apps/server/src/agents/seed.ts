import { schema } from '@orchestrator/db';
import { ROLE_MCP_PERMISSIONS } from '@orchestrator/protocol';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../database.js';
import { recordEvent } from '../events.js';
import type { ShippedAgents } from './files.js';

export interface SeedResult {
  created: string[];
  /** Profiles whose shipped files changed: their version went up. */
  updated: string[];
}

/**
 * Seeds the default profiles from `agents/` (03, section 3), in one transaction with their events.
 * A missing profile is created at version 1; one whose shipped files changed since the last start
 * (its file, the shared rules or the rules its role's runs receive) gets them and its version goes up. Profiles cannot be edited
 * before lot 6, so the shipped files are the only source of a default profile.
 */
export async function seedAgentProfiles(
  db: Database,
  shipped: ShippedAgents,
  now: Date = new Date(),
): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    // One seeding at a time, even if two servers started on the same database.
    await tx.execute(sql`LOCK TABLE agent_profiles IN SHARE ROW EXCLUSIVE MODE`);
    const result: SeedResult = { created: [], updated: [] };
    for (const profile of shipped.profiles) {
      const values = {
        name: profile.name,
        description: profile.description,
        role: profile.role,
        instructions: profile.instructions,
        model: profile.model,
        allowedTools: profile.allowedTools,
        mcpPermissions: ROLE_MCP_PERMISSIONS[profile.role],
        shippedHash: profile.shippedHash,
        updatedAt: now,
      };
      const [current] = await tx
        .select()
        .from(schema.agentProfiles)
        .where(eq(schema.agentProfiles.key, profile.key));
      const entity = { actor: 'system', entityType: 'agent_profile', at: now } as const;
      if (!current) {
        const [row] = await tx
          .insert(schema.agentProfiles)
          .values({ ...values, key: profile.key, isDefault: true, version: 1, createdAt: now })
          .returning();
        if (!row) throw new Error('profile not inserted');
        await recordEvent(tx, {
          ...entity,
          entityId: row.id,
          type: 'agent_profile.created',
          payload: { key: row.key, name: row.name, version: row.version },
        });
        result.created.push(row.key);
      } else if (current.shippedHash !== profile.shippedHash) {
        const [row] = await tx
          .update(schema.agentProfiles)
          .set({ ...values, version: current.version + 1 })
          .where(eq(schema.agentProfiles.id, current.id))
          .returning();
        if (!row) throw new Error('profile disappeared');
        await recordEvent(tx, {
          ...entity,
          entityId: row.id,
          type: 'agent_profile.updated',
          payload: {
            key: row.key,
            name: row.name,
            previousVersion: current.version,
            version: row.version,
          },
        });
        result.updated.push(row.key);
      }
    }
    return result;
  });
}
