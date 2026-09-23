import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createTestDatabase } from '@orchestrator/db/testing';
import pg from 'pg';
import { createLogger } from '../src/logger.js';
import { startServer } from '../src/server.js';
import { defaultWebRoot } from '../src/web.js';
import { fullAccount, startFakeGitHub } from './fake-github.js';
import { TEST_SECRET_KEY } from './helpers.js';

// The server for the end-to-end tests (apps/web/e2e, docs/dev/testing.md): the built UI, a new
// database and the fake GitHub. Started by Playwright; stopped with SIGTERM.
// The tokens must match apps/web/e2e/fixtures.ts.

const port = Number(process.env.E2E_PORT ?? 8095);
const controlPort = port + 1;

const webRoot = defaultWebRoot();
if (!existsSync(join(webRoot, 'index.html'))) {
  console.error('The UI is not built: run pnpm --filter @orchestrator/web build first.');
  process.exit(1);
}

function inDays(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

const github = await startFakeGitHub();
// Every permission; GitHub announces an expiry date 300 days ahead.
github.accounts.set(
  'github_pat_e2e_full_0123456789',
  fullAccount({
    expirationHeader: `${inDays(300).toISOString().slice(0, 10)} 10:00:00 UTC`,
  }),
);
// Workflows missing, no expiry header.
github.accounts.set(
  'github_pat_e2e_no_workflows_0123456789',
  fullAccount({ permissions: { ...fullAccount().permissions, workflows: undefined } }),
);

const database = await createTestDatabase();
const server = await startServer(
  {
    databaseUrl: database.url,
    port,
    secretKey: TEST_SECRET_KEY,
    publicUrl: `http://localhost:${String(port)}`,
  },
  createLogger(process.env.E2E_LOG_LEVEL ?? 'warn'),
  { githubApiUrl: github.url, webRoot },
);

// POST /reset empties every table, so each test starts from the first launch.
const pool = new pg.Pool({ connectionString: database.url });
const control = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/reset') {
    response.writeHead(404).end();
    return;
  }
  void (async () => {
    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_info'",
    );
    const tables = rows.map((row) => `"${row.tablename}"`).join(', ');
    await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
    response.writeHead(204).end();
  })().catch((error: unknown) => {
    console.error(error);
    response.writeHead(500).end();
  });
});
control.listen(controlPort, '127.0.0.1');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    control.close();
    void (async () => {
      await server.close();
      await pool.end();
      await github.close();
      await database.drop();
      process.exit(0);
    })();
  });
}
