import pg from 'pg';
import { ConfigError, loadConfig } from './config.js';
import { createDatabase } from './database.js';
import { ResetPasswordError, askNewPassword, resetPassword } from './reset-password.js';

// The `orchestrator` command of the server image (09, section 7.4), for example:
//   docker compose -f docker/compose.yml exec orchestrator orchestrator reset-password

const usage = 'Usage: orchestrator reset-password';

async function main(args: string[]): Promise<number> {
  if (args.length !== 1 || args[0] !== 'reset-password') {
    console.error(usage);
    return 2;
  }
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    return 1;
  }
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  try {
    const password = await askNewPassword({ input: process.stdin, output: process.stdout });
    const { username } = await resetPassword(createDatabase(pool), password);
    console.log(`Password changed for ${username}. Every session was logged out: log in again.`);
    return 0;
  } catch (error) {
    if (error instanceof ResetPasswordError) {
      console.error(error.message);
      return 1;
    }
    console.error(
      'The password could not be changed: the database could not be reached or failed.',
    );
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main(process.argv.slice(2));
