import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { createTestDatabase } from '@orchestrator/db/testing';
import pg from 'pg';
import { z } from 'zod';
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

/** The fake GitHub's accounts as each test starts: repositories created by a test are removed. */
function resetGitHub() {
  github.accounts.clear();
  github.override = undefined;
  // Every permission; GitHub announces an expiry date 300 days ahead. Repositories to link:
  // `notes` (GitHub's README only) and `legacy-site` (CLAUDE.md and user documentation only).
  github.accounts.set(
    'github_pat_e2e_full_0123456789',
    fullAccount({
      expirationHeader: `${inDays(300).toISOString().slice(0, 10)} 10:00:00 UTC`,
      repositories: [
        { name: 'notes', private: true },
        {
          name: 'legacy-site',
          private: false,
          files: {
            'README.md': '# Legacy',
            'CLAUDE.md': '# Legacy',
            'docs/user/index.md': '# Help',
          },
        },
        { name: 'old-archive', private: false, archived: true },
      ],
    }),
  );
  // Workflows missing, no expiry header.
  github.accounts.set(
    'github_pat_e2e_no_workflows_0123456789',
    fullAccount({ permissions: { ...fullAccount().permissions, workflows: undefined } }),
  );
}
resetGitHub();

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

// Test-only controls, never part of the server: POST /reset empties every table and resets the
// fake GitHub, so each test starts from the first launch. POST /github/fail-next makes the next
// GitHub request with this method and path suffix fail, for example
// `{"method":"POST","path":"/git/trees","status":503}`.
const pool = new pg.Pool({ connectionString: database.url });

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const FailNext = z.object({
  method: z.string(),
  path: z.string(),
  status: z.int().min(400).max(599),
});

async function handle(request: IncomingMessage): Promise<number> {
  if (request.method === 'POST' && request.url === '/reset') {
    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_info'",
    );
    const tables = rows.map((row) => `"${row.tablename}"`).join(', ');
    await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
    resetGitHub();
    return 204;
  }
  if (request.method === 'POST' && request.url === '/github/fail-next') {
    const failure = FailNext.parse(await readJson(request));
    let used = false;
    github.override = (sent) => {
      if (used || sent.method !== failure.method) return undefined;
      if (!new URL(sent.path, 'http://fake').pathname.endsWith(failure.path)) return undefined;
      used = true;
      return { status: failure.status, body: { message: 'Failure requested by the test' } };
    };
    return 204;
  }
  return 404;
}

const control = createServer((request, response) => {
  handle(request)
    .then((status) => response.writeHead(status).end())
    .catch((error: unknown) => {
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
