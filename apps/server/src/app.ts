import {
  PROTOCOL_VERSION,
  type HealthResponse,
  type VersionResponse,
} from '@orchestrator/protocol';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import type { Pool } from 'pg';
import { SERVER_VERSION } from './version.js';

export interface AppDependencies {
  pool: Pool;
  logger: FastifyBaseLogger;
}

/** Builds the HTTP application without listening, so tests can use `inject`. */
export function buildApp({ pool, logger }: AppDependencies) {
  const app = Fastify({ loggerInstance: logger });

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

  return app;
}

export type App = ReturnType<typeof buildApp>;
