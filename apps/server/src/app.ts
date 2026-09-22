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
import { registerGitHubRoutes } from './github/routes.js';
import { handleError } from './http.js';
import { deriveSecretKey } from './secrets.js';
import { defaultSettings, type Settings } from './settings.js';
import { SERVER_VERSION } from './version.js';

export interface AppDependencies {
  pool: Pool;
  logger: FastifyBaseLogger;
  /** ORCHESTRATOR_SECRET_KEY: encrypts stored secrets (ADR 0016). */
  secretKey: string;
  publicUrl: string;
  settings?: Settings;
  /** GitHub's REST API; tests use a local fake. */
  githubApiUrl?: string;
}

/** Builds the HTTP application without listening, so tests can use `inject`. */
export function buildApp(dependencies: AppDependencies) {
  const { pool, logger } = dependencies;
  const db = createDatabase(pool);
  const settings = dependencies.settings ?? defaultSettings;
  const app = Fastify({ loggerInstance: logger });
  app.setErrorHandler(handleError);
  void app.register(cookie);

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

  app.get('/version', () => {
    return { server: SERVER_VERSION, protocol: PROTOCOL_VERSION } satisfies VersionResponse;
  });

  void app.register((scope, _options, done) => {
    registerAuthRoutes(scope, {
      db,
      settings,
      secureCookies: new URL(dependencies.publicUrl).protocol === 'https:',
    });
    registerGitHubRoutes(scope, {
      db,
      key: deriveSecretKey(dependencies.secretKey),
      settings,
      apiUrl: dependencies.githubApiUrl ?? GITHUB_API_URL,
    });
    done();
  });

  return app;
}

export type App = ReturnType<typeof buildApp>;
