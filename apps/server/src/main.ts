import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startServer } from './server.js';

// Entry point of the server process (`node dist/main.js`).

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const logger = createLogger(config.logLevel);

try {
  const server = await startServer(config, logger);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'shutting down');
      server.close().then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error({ err: error }, 'shutdown failed');
          process.exit(1);
        },
      );
    });
  }
} catch (error) {
  logger.fatal({ err: error }, 'server failed to start');
  process.exit(1);
}
