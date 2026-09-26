import cookie from '@fastify/cookie';
import {
  PROTOCOL_VERSION,
  type HealthResponse,
  type VersionResponse,
} from '@orchestrator/protocol';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import type { Pool } from 'pg';
import { registerAuthRoutes } from './auth/routes.js';
import { createDatabase } from './database.js';
import { GITHUB_API_URL } from './github/client.js';
import { registerDownloads, defaultDaemonPackageDir } from './downloads.js';
import { registerEventLogRoutes } from './event-log.js';
import { registerGitHubRoutes } from './github/routes.js';
import { handleError } from './http.js';
import { registerAccountRoutes } from './machines/accounts.js';
import { DaemonGateway } from './machines/gateway.js';
import { registerMachineRoutes } from './machines/routes.js';
import { registerNeedsYouRoutes } from './needs-you.js';
import { registerProjectRoutes } from './projects/routes.js';
import { deriveSecretKey } from './secrets.js';
import { registerSettingRoutes } from './settings/routes.js';
import { registerTicketRoutes } from './tickets/routes.js';
import { registerUiSettingsRoutes } from './ui-settings.js';
import { SERVER_VERSION } from './version.js';
import { registerWeb } from './web.js';

export interface AppDependencies {
  pool: Pool;
  logger: FastifyBaseLogger;
  /** ORCHESTRATOR_SECRET_KEY: encrypts stored secrets (ADR 0016). */
  secretKey: string;
  publicUrl: string;
  /** GitHub's REST API; tests use a local fake. */
  githubApiUrl?: string;
  /** Clock for time-based rules (login throttling) and timestamps; tests replace it. */
  now?: () => Date;
  /** Folder of the built UI; `null` or absent serves the API only. */
  webRoot?: string | null;
  /** Milliseconds in one second of the daemon heartbeat settings; tests shorten it. */
  daemonSecondMs?: number;
  /** Folder of the daemon package served at `/downloads/`; tests build their own. */
  daemonPackageDir?: string;
}

/** Builds the HTTP application without listening, so tests can use `inject`. */
export function buildApp(dependencies: AppDependencies) {
  const { pool, logger } = dependencies;
  const db = createDatabase(pool);
  const app = Fastify({ loggerInstance: logger });
  app.setErrorHandler(handleError);
  void app.register(cookie);
  const gateway = new DaemonGateway({
    db,
    log: logger,
    publicUrl: dependencies.publicUrl,
    secondMs: dependencies.daemonSecondMs,
  });
  gateway.register(app);

  // Polled by Docker every few seconds: only failures are logged.
  app.get('/health', { logLevel: 'warn' }, async (request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', database: 'ok' } satisfies HealthResponse;
    } catch (error) {
      request.log.warn({ err: error }, 'health check: database unreachable');
      return reply.code(503).send({ status: 'error', database: 'error' } satisfies HealthResponse);
    }
  });

  registerDownloads(app, dependencies.daemonPackageDir ?? defaultDaemonPackageDir());

  app.get('/version', () => {
    return { server: SERVER_VERSION, protocol: PROTOCOL_VERSION } satisfies VersionResponse;
  });

  void app.register((scope, _options, done) => {
    registerAuthRoutes(scope, {
      db,
      secureCookies: new URL(dependencies.publicUrl).protocol === 'https:',
      now: dependencies.now,
    });
    const github = {
      db,
      key: deriveSecretKey(dependencies.secretKey),
      apiUrl: dependencies.githubApiUrl ?? GITHUB_API_URL,
    };
    registerGitHubRoutes(scope, github);
    registerProjectRoutes(scope, { ...github, now: dependencies.now });
    registerTicketRoutes(scope, { db, now: dependencies.now });
    registerNeedsYouRoutes(scope, { db, publicUrl: dependencies.publicUrl });
    registerUiSettingsRoutes(scope, { db });
    registerSettingRoutes(scope, { db });
    registerEventLogRoutes(scope, { db });
    registerAccountRoutes(scope, { db });
    registerMachineRoutes(scope, {
      db,
      gateway,
      publicUrl: dependencies.publicUrl,
      now: dependencies.now,
    });
    done();
  });

  registerWeb(app, dependencies.webRoot ?? null);

  return app;
}

export type App = ReturnType<typeof buildApp>;
