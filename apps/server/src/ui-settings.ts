import type { UiSettingsResponse } from '@orchestrator/protocol';
import type { FastifyInstance } from 'fastify';
import { requireSession } from './auth/routes.js';
import type { Database } from './database.js';
import { resolveSettings } from './settings/store.js';

/** The settings the screens use, so they follow the server's values instead of their own. */
export function registerUiSettingsRoutes(app: FastifyInstance, { db }: { db: Database }) {
  app.get('/api/ui-settings', async (request) => {
    await requireSession(db, request);
    const { projectSetupPollSeconds } = await resolveSettings(db, ['projectSetupPollSeconds']);
    return { projectSetupPollSeconds } satisfies UiSettingsResponse;
  });
}
