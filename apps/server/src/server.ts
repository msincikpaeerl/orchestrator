import { endPool, reportConnectionErrors, runMigrations } from '@orchestrator/db';
import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';
import { buildApp, type App, type AppDependencies } from './app.js';
import type { Config } from './config.js';
import { createDatabase } from './database.js';
import { detectUnreadableToken } from './github/connection.js';
import { markAllOffline } from './machines/gateway.js';
import { failInterruptedSetups } from './projects/setup.js';
import { deriveSecretKey } from './secrets.js';
import { defaultWebRoot } from './web.js';

export interface RunningServer {
  app: App;
  /** Stops accepting requests, then closes the database connections. */
  close(): Promise<void>;
}

/** Applies pending database migrations, then starts listening. */
export async function startServer(
  config: Pick<Config, 'databaseUrl' | 'port' | 'secretKey' | 'publicUrl'>,
  logger: FastifyBaseLogger,
  options: Pick<AppDependencies, 'githubApiUrl' | 'webRoot'> = {},
): Promise<RunningServer> {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  reportConnectionErrors(pool, (error) => {
    logger.error({ err: error }, 'database connection lost');
  });

  try {
    await runMigrations(pool);
    logger.info('database migrations applied');
    const db = createDatabase(pool);
    await detectUnreadableToken(db, deriveSecretKey(config.secretKey), logger);
    const interrupted = await failInterruptedSetups(db);
    if (interrupted > 0) logger.warn({ interrupted }, 'project setups interrupted by a restart');
    const offline = await markAllOffline(db);
    if (offline > 0) logger.info({ offline }, 'machines offline until their daemons reconnect');
    const app = buildApp({
      pool,
      logger,
      secretKey: config.secretKey,
      publicUrl: config.publicUrl,
      webRoot: defaultWebRoot(),
      ...options,
    });
    await app.listen({ port: config.port, host: '0.0.0.0' });
    return {
      app,
      async close() {
        await app.close();
        await endPool(pool);
      },
    };
  } catch (error) {
    await endPool(pool);
    throw error;
  }
}
