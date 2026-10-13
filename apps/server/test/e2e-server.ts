import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { createTestDatabase } from '@orchestrator/db/testing';
import {
  BranchDeleteAnswer,
  DaemonBuild,
  DaemonMessage,
  Hello,
  type BranchDelete,
  type RunStart,
} from '@orchestrator/protocol';
import { createPool, endPool } from '@orchestrator/db';
import { z } from 'zod';
import { daemonPackageFile } from '../src/downloads.js';
import { createLogger } from '../src/logger.js';
import { ciWatcherOf } from '../src/app.js';
import { startServer } from '../src/server.js';
import { defaultWebRoot } from '../src/web.js';
import { enrollToken, ScriptedDaemon } from './daemon-client.js';
import { installRealGitHubGuard } from '@orchestrator/daemon/testing/real-github-guard';
import { GITHUB_CONTROLS, githubControl } from './fake-github-controls.js';
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

// Working rule 9: the server under test never reaches the real GitHub, even by mistake.
installRealGitHubGuard();
const github = await startFakeGitHub();

/** The fake GitHub's accounts as each test starts: repositories created by a test are removed. */
function resetGitHub() {
  github.accounts.clear();
  github.override = undefined;
  github.alter = undefined;
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

// The build of the daemon package this server provides: a fixed one, whatever `pnpm build` left.
// The scripted daemon says it by default; a test changes `daemonBuild` to see the warning.
const E2E_DAEMON_BUILD = 'e2e0e2e0e2e0e2e0';
const daemonPackageDir = mkdtempSync(join(tmpdir(), 'orchestrator-e2e-daemon-package-'));
writeFileSync(join(daemonPackageDir, `${daemonPackageFile()}.build`), `${E2E_DAEMON_BUILD}\n`);

const database = await createTestDatabase();
const server = await startServer(
  {
    databaseUrl: database.url,
    port,
    secretKey: TEST_SECRET_KEY,
    publicUrl: `http://localhost:${String(port)}`,
  },
  createLogger(process.env.E2E_LOG_LEVEL ?? 'warn'),
  // No CI check starts by itself: a test asks for one (POST /ci/pass).
  { githubApiUrl: github.url, gitBaseUrl: github.url, webRoot, daemonPackageDir, ciTimers: false },
);

// Test-only controls, never part of the server: POST /reset empties every table but the agent
// profiles and resets the fake GitHub, so each test starts from the first launch. POST
// /github/fail-next makes the next GitHub request with this method and path suffix fail, for example
// `{"method":"POST","path":"/git/trees","status":503}`. POST /daemon/connect enrolls a scripted
// daemon (apps/server/test/daemon-client.ts) with the code shown on the screen, connects it and
// says `hello`, with the `hello` fields to change: `{"code":"…","hello":{"claudeCodeVersion":null}}`;
// it sends heartbeats until POST /daemon/disconnect or the next reset. Like a real daemon, it
// acknowledges each command at once (`run.start`, `run.resume`, `run.input`, `run.stop`), except
// while POST /daemon/hold-input `{"hold":true}` holds its answers to `run.input` and `run.resume`
// (a daemon that has not answered yet), sent by `{"hold":false}` or dropped at the reset. POST
// /daemon/run `{"runId":"…"}` waits for the run's `run.start` or `run.resume` and answers
// `{"type":"run.start","runToken":"…"}`; POST /daemon/request `{"message":{…}}` sends a report or a
// tool call of the latest daemon and answers the server's reply (`ack`, `mcp.result`).
// What happens on GitHub without the Orchestrator, in a repository of the full account
// (`octo-owner`), each answering `{"sha":"…"}` when it makes a commit: POST /github/commit
// `{"repository":"notes","branch":"main","files":{"a.md":"A"},"message":"…"}` (a file set to null
// is removed; `"from":"main"` starts a missing branch there); POST /github/ci `{"repository":"notes","ref":"<branch or SHA>","action":"start"}`
// starts the commit's workflow runs, `"action":"complete"` completes them, successful or with
// `"failures":[{"job":"docs-links","step":"Check documentation links","log":"…"}]`; POST
// /github/status `{"repository":"notes","ref":"…","context":"deploy","state":"success"}`; POST
// /github/merge `{"repository":"notes","pullRequest":1,"method":"squash"}`, /github/close and
// /github/update-branch `{"repository":"notes","pullRequest":1}`. A control GitHub would not
// offer (a merge with conflicts) answers 409 with the reason. POST /ci/pass `{"runId":"…"}`: CI
// passes for the commit the run submitted (lot 3 step G1a). The tests' submissions report made-up
// commits, so the wait is begun and GitHub's answers for that commit are given here, then one CI
// check runs; it answers 204 once the check is over. POST /ci/check `{"runId":"…","runs":[{"name":
// "CI","status":"in_progress","conclusion":null}],"statuses":[{"context":"deploy","state":"success"}]}`
// runs one CI check with these answers for the run's commit, used for that check only (lot 3 step
// G1b); `"rateLimitedSeconds":600` makes GitHub refuse it for its request limit, `"mergeable":false`
// gives the pull request a conflict, `"startedMinutesAgo":6` puts **Wait for CI to start** behind.
// POST /github/check runs one check of GitHub as **GitHub check interval** would (merges, CI waits,
// the clean-up after a merge; lot 3 step J2c). POST /daemon/branch-delete `{"answer":{"outcome":
// "deleted"}}` waits for the latest daemon's `branch.delete` not answered yet and answers it
// (`branch.delete_result`, the same id); the daemon answers nothing by itself.
const pool = createPool({ connectionString: database.url });

const daemons: { daemon: ScriptedDaemon; heartbeat: NodeJS.Timeout }[] = [];
/** The answers held while POST /daemon/hold-input holds them; null when they go at once. */
let heldInputs: { daemon: ScriptedDaemon; id: string }[] | null = null;

/**
 * Closes the scripted daemons and waits until the server has recorded each of them offline:
 * emptying the tables while it still writes those changes would deadlock the reset.
 */
async function disconnectDaemons() {
  const closing = daemons.splice(0);
  for (const { daemon, heartbeat } of closing) {
    clearInterval(heartbeat);
    await daemon.close();
  }
  if (closing.length === 0) return;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await pool.query<{ online: number }>(
      "SELECT count(*)::int AS online FROM machines WHERE status = 'online'",
    );
    if (rows[0]?.online === 0) return;
    if (Date.now() > deadline) throw new Error('the server did not record the daemons offline');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The latest daemon connected: the one the run controls act for. */
function latestDaemon(): ScriptedDaemon {
  const latest = daemons.at(-1);
  if (!latest) throw new Error('no daemon connected');
  return latest.daemon;
}

const RunControl = z.object({ runId: z.uuid() });
/** One CI check of a run's made-up commit, with GitHub's answers for it (lot 3 step G1b). */
const CiCheckControl = z.object({
  runId: z.uuid(),
  runs: z
    .array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() }))
    .default([]),
  statuses: z
    .array(
      z.object({ context: z.string(), state: z.enum(['error', 'failure', 'pending', 'success']) }),
    )
    .default([]),
  /** GitHub's request limit on the runs' listing, allowing requests again after this long. */
  rateLimitedSeconds: z.int().positive().optional(),
  /** The pull request's `mergeable`, when the check reads it. */
  mergeable: z.boolean().nullable().optional(),
  /** **Wait for CI to start** over: the wait begun this many minutes ago. */
  startedMinutesAgo: z.int().min(0).optional(),
});
const RequestControl = z.object({ message: DaemonMessage });
const BranchDeleteControl = z.object({ answer: BranchDeleteAnswer });
/** The ids of the `branch.delete` messages a test answered, so each is answered once. */
const answeredDeletes = new Set<string>();

const ConnectDaemon = z.object({
  code: z.string(),
  // Without the protocol's default (null), so an absent build is the e2e one.
  hello: Hello.shape.payload
    .partial()
    .extend({ daemonBuild: DaemonBuild.nullable().optional() })
    .default({}),
});

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const HoldInput = z.object({ hold: z.boolean() });
const FailNext = z.object({
  method: z.string(),
  path: z.string(),
  status: z.int().min(400).max(599),
});

async function handle(
  request: IncomingMessage,
): Promise<number | { status: number; body: unknown }> {
  if (request.method === 'POST' && request.url === '/reset') {
    const { rows } = await pool.query<{ tablename: string }>(
      // The default agent profiles stay, as they are seeded before the first launch.
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('schema_info', 'agent_profiles')",
    );
    const tables = rows.map((row) => `"${row.tablename}"`).join(', ');
    await disconnectDaemons();
    await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
    resetGitHub();
    heldInputs = null;
    answeredDeletes.clear();
    return 204;
  }
  if (request.method === 'POST' && request.url === '/github/check') {
    await ciWatcherOf(server.app).tick();
    return 204;
  }
  if (request.method === 'POST' && request.url === '/daemon/branch-delete') {
    const { answer } = BranchDeleteControl.parse(await readJson(request));
    const daemon = latestDaemon();
    const message = await daemon.find<BranchDelete>(
      (sent) => sent.type === 'branch.delete' && !answeredDeletes.has(sent.id),
      'branch.delete',
      10_000,
    );
    answeredDeletes.add(message.id);
    daemon.send({ type: 'branch.delete_result', id: message.id, payload: answer });
    return 204;
  }
  if (request.method === 'POST' && request.url === '/daemon/hold-input') {
    const { hold } = HoldInput.parse(await readJson(request));
    if (hold) {
      heldInputs ??= [];
    } else {
      const held = heldInputs ?? [];
      heldInputs = null;
      for (const { daemon, id } of held) daemon.send({ type: 'ack', id, payload: { ok: true } });
    }
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
  if (request.method === 'POST' && GITHUB_CONTROLS.includes(request.url ?? '')) {
    return githubControl(github, request.url ?? '', await readJson(request)) ?? 404;
  }
  if (request.method === 'POST' && request.url === '/daemon/connect') {
    const { code, hello } = ConnectDaemon.parse(await readJson(request));
    const serverUrl = `http://127.0.0.1:${String(port)}`;
    const daemon = await ScriptedDaemon.connect(serverUrl, await enrollToken(serverUrl, code));
    daemon.onMessage = (message) => {
      if (heldInputs !== null && ['run.resume', 'run.input'].includes(message.type)) {
        heldInputs.push({ daemon, id: message.id });
      } else if (['run.start', 'run.resume', 'run.input', 'run.stop'].includes(message.type)) {
        daemon.send({ type: 'ack', id: message.id, payload: { ok: true } });
      }
    };
    const welcome = await daemon.hello({ daemonBuild: E2E_DAEMON_BUILD, ...hello });
    const heartbeat = setInterval(() => {
      if (daemon.isOpen) daemon.heartbeat();
    }, 5000);
    daemons.push({ daemon, heartbeat });
    return welcome.accepted ? 204 : 409;
  }
  if (request.method === 'POST' && request.url === '/daemon/run') {
    const { runId } = RunControl.parse(await readJson(request));
    const daemon = latestDaemon();
    const start = await daemon.find<RunStart>(
      (message) => message.type === 'run.start' && message.payload.runId === runId,
      `run.start of ${runId}`,
      10_000,
    );
    const resumed = daemon.received.some(
      (message) => message.type === 'run.resume' && message.payload.runId === runId,
    );
    return {
      status: 200,
      body: { type: resumed ? 'run.resume' : 'run.start', runToken: start.payload.runToken },
    };
  }
  if (request.method === 'POST' && request.url === '/daemon/request') {
    const { message } = RequestControl.parse(await readJson(request));
    return { status: 200, body: await latestDaemon().request(message) };
  }
  if (request.method === 'POST' && request.url === '/ci/pass') {
    const { runId } = RunControl.parse(await readJson(request));
    const { rows } = await pool.query<{ commit: string | null }>(
      'UPDATE runs SET ci_wait_started_at = coalesce(ci_wait_started_at, now()) WHERE id = $1 RETURNING ci_commit AS commit',
      [runId],
    );
    const commit = rows[0]?.commit;
    if (!commit) return 409;
    github.alter = (sent, reply) => {
      if (sent.path.includes(`/actions/runs?head_sha=${commit}`)) {
        return {
          status: 200,
          body: {
            total_count: 1,
            workflow_runs: [
              {
                id: 1,
                name: 'CI',
                event: 'pull_request',
                status: 'completed',
                conclusion: 'success',
                head_sha: commit,
                head_branch: null,
                html_url: `${github.url}/octo-owner/bakery/actions/runs/1`,
                pull_requests: [],
              },
            ],
          },
        };
      }
      if (sent.path.includes(`/commits/${commit}/status`)) {
        return {
          status: 200,
          body: { state: 'pending', sha: commit, total_count: 0, statuses: [] },
        };
      }
      return reply;
    };
    try {
      await ciWatcherOf(server.app).tick();
    } finally {
      github.alter = undefined;
    }
    return 204;
  }
  if (request.method === 'POST' && request.url === '/ci/check') {
    const check = CiCheckControl.parse(await readJson(request));
    const { rows } = await pool.query<{ commit: string | null }>(
      `UPDATE runs SET ci_wait_started_at = CASE WHEN $2::int IS NULL
         THEN coalesce(ci_wait_started_at, now()) ELSE now() - make_interval(mins => $2::int) END
       WHERE id = $1 RETURNING ci_commit AS commit`,
      [check.runId, check.startedMinutesAgo ?? null],
    );
    const commit = rows[0]?.commit;
    if (!commit) return 409;
    github.alter = (sent, reply) => {
      if (sent.path.includes(`/actions/runs?head_sha=${commit}`)) {
        if (check.rateLimitedSeconds !== undefined) {
          const reset = Math.floor(Date.now() / 1000) + check.rateLimitedSeconds;
          return {
            status: 403,
            body: { message: 'API rate limit exceeded for user ID 1.' },
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
          };
        }
        return {
          status: 200,
          body: {
            total_count: check.runs.length,
            workflow_runs: check.runs.map((run, index) => ({
              id: index + 1,
              name: run.name,
              event: 'pull_request',
              status: run.status,
              conclusion: run.conclusion,
              head_sha: commit,
              head_branch: null,
              html_url: `${github.url}/octo-owner/bakery/actions/runs/${String(index + 1)}`,
              pull_requests: [],
            })),
          },
        };
      }
      if (sent.path.includes(`/commits/${commit}/status`)) {
        return {
          status: 200,
          body: {
            state: 'pending',
            sha: commit,
            total_count: check.statuses.length,
            statuses: check.statuses.map((status) => ({
              ...status,
              description: null,
              target_url: `https://preview.example.com/${status.context.length > 20 ? 'long' : 'short'}`,
            })),
          },
        };
      }
      if (
        check.mergeable !== undefined &&
        sent.method === 'GET' &&
        /\/pulls\/\d+$/.test(new URL(sent.path, 'http://fake').pathname)
      ) {
        return { ...reply, body: { ...(reply.body as object), mergeable: check.mergeable } };
      }
      return reply;
    };
    try {
      await ciWatcherOf(server.app).tick();
    } finally {
      github.alter = undefined;
    }
    return 204;
  }
  if (request.method === 'POST' && request.url === '/daemon/disconnect') {
    await disconnectDaemons();
    return 204;
  }
  return 404;
}

const control = createServer((request, response) => {
  handle(request)
    .then((result) => {
      if (typeof result === 'number') {
        response.writeHead(result).end();
      } else {
        response.writeHead(result.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result.body));
      }
    })
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
      await disconnectDaemons();
      await server.close();
      await endPool(pool);
      await github.close();
      await database.drop();
      rmSync(daemonPackageDir, { recursive: true, force: true });
      process.exit(0);
    })();
  });
}
