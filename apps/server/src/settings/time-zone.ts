import { schema } from '@orchestrator/db';
import { SaveTimeZoneRequest, type TimeZoneResponse } from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/routes.js';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { parseInput } from '../http.js';

/** The time zone used while the owner has saved none (lot 4 step C). */
export const DEFAULT_TIME_ZONE = 'UTC';

/**
 * The Orchestrator's time zone (02, section 10; 07, section 5.3): the one saved on Settings, or
 * UTC with `saved` false before the owner's first save.
 */
export async function readTimeZone(db: Executor): Promise<TimeZoneResponse> {
  const [row] = await db.select().from(schema.timeZone).where(eq(schema.timeZone.id, 1));
  return row ? { timeZone: row.name, saved: true } : { timeZone: DEFAULT_TIME_ZONE, saved: false };
}

/** `GET` and `PUT /api/time-zone`: Settings > Time zone, filled in from the browser. */
export function registerTimeZoneRoutes(app: FastifyInstance, { db }: { db: Database }) {
  app.get('/api/time-zone', async (request) => {
    await requireSession(db, request);
    return readTimeZone(db);
  });

  app.put('/api/time-zone', async (request) => {
    await requireSession(db, request);
    const { timeZone } = parseInput(SaveTimeZoneRequest, request.body);
    const saved = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.timeZone)
        .where(eq(schema.timeZone.id, 1))
        .for('update');
      if (current?.name === timeZone) return false;
      await tx
        .insert(schema.timeZone)
        .values({ id: 1, name: timeZone })
        .onConflictDoUpdate({
          target: schema.timeZone.id,
          set: { name: timeZone, updatedAt: new Date() },
        });
      await recordEvent(tx, {
        actor: 'owner',
        entityType: 'setting',
        entityId: 'timeZone',
        type: 'setting.time_zone_saved',
        payload: { timeZone, previous: current?.name ?? null },
      });
      return true;
    });
    if (saved) request.log.info({ timeZone }, 'time zone saved');
    return { timeZone, saved: true } satisfies TimeZoneResponse;
  });
}
