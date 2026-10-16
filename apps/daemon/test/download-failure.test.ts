import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionName } from '../src/tmux.js';
import { startGitHttpServer, type GitHttpServer } from './git-http-server.js';
import {
  TIMEOUT,
  daemon,
  ended,
  fake,
  home,
  start,
  tmux,
  useRunnerHarness,
} from './runner-harness.js';

// A project download that fails at a run's start (04, section 5; owner's answer 1, lot 3 step
// K2), with the real Git, the Git test server and the fake `claude`: GitHub unreachable, the
// credential refused (by GitHub or by the Orchestrator) and Longest push each end the run
// `download_failed`, saying which, before any session; any other preparation failure stays
// `crashed`.

useRunnerHarness();

const TOKEN = 'ghp_DownloadTestTokenThatMustNeverBeStored';
const CREDENTIAL = { username: 'x-access-token', password: TOKEN };

let server: GitHttpServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function serve(delayMs = 0): Promise<string> {
  server = await startGitHttpServer(join(home.root, 'remotes'), CREDENTIAL, { delayMs });
  return server.url;
}

/** A daemon whose scripted server gives `password` as the credential. */
function credentialed(password = TOKEN) {
  return daemon({
    credentials: () => Promise.resolve({ ok: true, ...CREDENTIAL, password }),
  });
}

/** A local port nothing listens on: GitHub cannot be reached. */
async function closedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  await new Promise<void>((resolve) => {
    listener.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

/** The run ended before any session: nothing launched, no session left. */
async function noSession(runId: string): Promise<void> {
  expect(await fake.log()).toEqual([]);
  expect(await tmux.hasSession(sessionName(runId))).toBe(false);
}

describe('a download that fails at the start of a run', () => {
  it(
    'says GitHub could not be reached',
    async () => {
      const port = await closedPort();
      const run = await start(credentialed(), {
        repository: { cloneUrl: `http://127.0.0.1:${String(port)}/owner/notes.git` },
      });
      const end = await ended(run.runId);
      expect(end).toMatchObject({
        reason: 'download_failed',
        download: { reason: 'unreachable' },
        branch: null,
        push: null,
      });
      expect(end.download?.message).toMatch(
        /Failed to connect|Connection refused|Could not connect/,
      );
      expect(end.detail).toMatch(/^The project could not be downloaded from GitHub: /);
      await noSession(run.runId);
    },
    TIMEOUT,
  );

  it(
    'says GitHub refused the credential, without its value',
    async () => {
      const url = await serve();
      const run = await start(credentialed('ghp_WrongTokenThatGitHubRefuses0123456789'), {
        repository: { cloneUrl: `${url}/owner/notes.git` },
      });
      const end = await ended(run.runId);
      expect(end).toMatchObject({ reason: 'download_failed', download: { reason: 'refused' } });
      expect(end.download?.message).toMatch(/Authentication failed|returned error: 401/);
      expect(JSON.stringify(end)).not.toContain('ghp_WrongTokenThatGitHubRefuses');
      await noSession(run.runId);
    },
    TIMEOUT,
  );

  it(
    'says GitHub does not let the token see the repository',
    async () => {
      const url = await serve();
      const run = await start(credentialed(), {
        repository: { cloneUrl: `${url}/owner/gone.git` },
      });
      const end = await ended(run.runId);
      expect(end).toMatchObject({ reason: 'download_failed', download: { reason: 'refused' } });
      expect(end.download?.message).toContain('Repository not found.');
      await noSession(run.runId);
    },
    TIMEOUT,
  );

  it(
    "says the Orchestrator refused the credential, in the Orchestrator's words",
    async () => {
      const url = await serve();
      const manager = daemon({
        credentials: () => Promise.resolve({ ok: false, message: 'GitHub is not connected' }),
      });
      const run = await start(manager, { repository: { cloneUrl: `${url}/owner/notes.git` } });
      expect(await ended(run.runId)).toMatchObject({
        reason: 'download_failed',
        download: {
          reason: 'refused',
          message: 'The Orchestrator refused the credential: GitHub is not connected',
        },
      });
      await noSession(run.runId);
    },
    TIMEOUT,
  );

  it(
    'says Longest push was reached, and stops the download',
    async () => {
      const url = await serve(5_000);
      const startedAt = Date.now();
      const run = await start(credentialed(), {
        repository: { cloneUrl: `${url}/owner/notes.git` },
        limits: { pushTimeoutSeconds: 1 },
      });
      expect(await ended(run.runId)).toMatchObject({
        reason: 'download_failed',
        download: {
          reason: 'too_long',
          message:
            'Downloading the project from GitHub took longer than Longest push (1 second, in Settings > Limits) and was stopped. The first download on a new machine takes the longest.',
        },
      });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      await noSession(run.runId);
    },
    TIMEOUT,
  );

  it(
    'keeps any other preparation failure crashed, with no download reported',
    async () => {
      const url = await serve();
      // The worktrees' folder cannot be made: a file stands in its place.
      await mkdir(home.paths.home, { recursive: true, mode: 0o700 });
      await writeFile(join(home.paths.home, 'worktrees'), '');
      const run = await start(credentialed(), {
        repository: { cloneUrl: `${url}/owner/notes.git` },
      });
      const end = await ended(run.runId);
      expect(end).toMatchObject({ reason: 'crashed', download: null });
      expect(end.detail).toMatch(/^The workspace could not be prepared: /);
      await noSession(run.runId);
    },
    TIMEOUT,
  );
});
