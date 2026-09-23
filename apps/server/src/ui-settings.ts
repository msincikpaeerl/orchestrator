import type { UiSettingsResponse } from '@orchestrator/protocol';
import type { FastifyInstance } from 'fastify';
import { requireSession } from './auth/routes.js';
import type { Database } from './database.js';
import type { Settings } from './settings.js';

/** The settings the screens use, so they follow the server's values instead of their own. */
export function registerUiSettingsRoutes(
  app: FastifyInstance,
  { db, settings }: { db: Database; settings: Settings },
) {
  app.get('/api/ui-settings', async (request) => {
    await requireSession(db, request);
    return {
      projectSetupPollSeconds: settings.projectSetupPollSeconds,
    } satisfies UiSettingsResponse;
  });
}
