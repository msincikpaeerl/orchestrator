import { runMigrations } from '@orchestrator/db';
import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';
import { buildApp, type App, type AppDependencies } from './app.js';
import type { Config } from './config.js';
import { createDatabase } from './database.js';
import { detectUnreadableToken } from './github/connection.js';
import { deriveSecretKey } from './secrets.js';

export interface RunningServer {
  app: App;
  /** Stops accepting requests, then closes the database connections. */
  close(): Promise<void>;
}

/** Applies pending database migrations, then starts listening. */
export async function startServer(
  config: Pick<Config, 'databaseUrl' | 'port' | 'secretKey' | 'publicUrl'>,
  logger: FastifyBaseLogger,
  options: Pick<AppDependencies, 'settings' | 'githubApiUrl'> = {},
): Promise<RunningServer> {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  pool.on('error', (error) => {
    logger.error({ err: error }, 'idle database connection failed');
  });

  try {
    await runMigrations(pool);
    logger.info('database migrations applied');
    await detectUnreadableToken(createDatabase(pool), deriveSecretKey(config.secretKey), logger);
    const app = buildApp({
      pool,
      logger,
      secretKey: config.secretKey,
      publicUrl: config.publicUrl,
      ...options,
    });
    await app.listen({ port: config.port, host: '0.0.0.0' });
    return {
      app,
      async close() {
        await app.close();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
