import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/routes.js';
import type { Database } from '../database.js';
import { computeQueue } from './queue.js';

/**
 * `GET /api/queue`: the scheduler's queue (02, section 7; 07, section 7), which Activity > Queue
 * shows from step H of lot 4. Reading it starts nothing.
 */
export function registerQueueRoutes(
  app: FastifyInstance,
  { db, now: clock = () => new Date() }: { db: Database; now?: () => Date },
) {
  app.get('/api/queue', async (request) => {
    await requireSession(db, request);
    return computeQueue(db, clock());
  });
}
