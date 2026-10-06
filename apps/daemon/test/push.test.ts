import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitCredentialRequest } from '@orchestrator/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CredentialAnswer } from '../src/credentials.js';
import { findExecutable } from '../src/exec.js';
import { Git } from '../src/git.js';
import { TrustRegistry } from '../src/trust.js';
import { Workspaces } from '../src/workspace.js';
import { startGitHttpServer, type GitHttpServer } from './git-http-server.js';
import { createRemote, gitIn } from './remote.js';
import { runStartPayload } from './run-start.js';
import {
  DAEMON_COMMAND,
  captureLogger,
  createTestHome,
  fakeExecutable,
  linkSystemTool,
  waitFor,
  type TestHome,
} from './testing.js';

// The daemon's fetch and push with the real Git and an authenticated Git HTTP server (05,
// sections 4.2, 4.9 and 7; lot 3 step D1).

const TOKEN = 'ghp_PushTestTokenThatMustNeverBeStored0123';
const CREDENTIAL = { ok: true as const, username: 'x-access-token', password: TOKEN };
const BRANCH = 't/1-add-notes';

let home: TestHome;
let remote: string;
let server: GitHttpServer;
let asked: GitCredentialRequest['payload'][];
let answer: CredentialAnswer;

beforeEach(async () => {
  home = await createTestHome();
  await linkSystemTool(home.bin, 'git');
  remote = await createRemote(join(home.root, 'remotes'), 'owner', 'notes', home.env);
  asked = [];
  answer = CREDENTIAL;
});

afterEach(async () => {
  await server.close();
  await home.remove();
});

function workspaces(gitFile = join(home.bin, 'git')): Workspaces {
  return new Workspaces({
    paths: home.paths,
    git: new Git(gitFile, home.env),
    trust: new TrustRegistry(join(home.paths.claudeConfig, '.claude.json')),
    credentials: (request) => {
      asked.push(request);
      return Promise.resolve(answer);
    },
    selfCommand: DAEMON_COMMAND,
    log: captureLogger().log,
  });
}

async function serve(delayMs = 0): Promise<void> {
  server = await startGitHttpServer(join(home.root, 'remotes'), CREDENTIAL, { delayMs });
}

async function prepare(spaces: Workspaces, limits: { pushTimeoutSeconds?: number } = {}) {
  const start = runStartPayload(`${server.url}/owner/notes.git`, { limits });
  const folder = join(home.paths.home, 'runs', start.runId);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  return { start, folder, ...(await spaces.prepare(start, folder)) };
}

function commit(worktree: string, message: string): string {
  gitIn(worktree, ['commit', '--quiet', '--allow-empty', '-m', message], home.env);
  return gitIn(worktree, ['rev-parse', 'HEAD'], home.env).trim();
}

function remoteRef(ref: string): string | null {
  try {
    return gitIn(remote, ['rev-parse', '--verify', '--quiet', ref], home.env).trim();
  } catch {
    return null;
  }
}

/** A Git wrapper recording every Git process's trace2 events, with the canary and credential. */
async function tracingGit(trace: string): Promise<string> {
  const real = findExecutable('git', process.env.PATH);
  if (!real) throw new Error('git is needed');
  await mkdir(join(home.root, 'tracing'), { recursive: true });
  return fakeExecutable(
    join(home.root, 'tracing'),
    'git',
    [
      `export GIT_TRACE2_EVENT='${trace}'`,
      'export GIT_TRACE2_CONFIG_PARAMS=orchestratortest.canary',
      'export GIT_TRACE2_ENV_VARS=ORCHESTRATOR_CREDENTIAL_SOCKET',
      `exec '${real}' "$@"`,
    ].join('\n'),
  );
}

describe('push', () => {
  it('pushes the given head to the ticket branch, the credential asked once for this repository', async () => {
    await serve();
    const spaces = workspaces();
    const run = await prepare(spaces);
    const head = commit(run.worktree, 'Agent work');
    asked.length = 0;
    expect(await spaces.push(run.start, run.bare, run.folder, head)).toEqual({
      status: 'pushed',
      head,
    });
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBe(head);
    expect(asked).toEqual([
      { runId: run.start.runId, repository: { owner: 'owner', name: 'notes' }, command: 'push' },
    ]);
    // Nothing left in the run folder: the isolated repository and the socket are gone.
    expect(await readdir(run.folder)).toEqual([]);
  }, 30_000);

  it('pushes the hash it was given even when the branch moved after it was read', async () => {
    await serve();
    const spaces = workspaces();
    const run = await prepare(spaces);
    const read = commit(run.worktree, 'Read for the facts');
    const moved = commit(run.worktree, 'Committed afterwards');
    expect(await spaces.push(run.start, run.bare, run.folder, read)).toEqual({
      status: 'pushed',
      head: read,
    });
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBe(read);
    expect(moved).not.toBe(read);
  }, 30_000);

  it('never forces: a GitHub branch with commits the local one lacks is diverged and kept', async () => {
    await serve();
    const spaces = workspaces();
    const run = await prepare(spaces);
    const local = commit(run.worktree, 'Local work');
    // Someone else's commit on GitHub's ticket branch.
    const other = await mkdtemp(join(home.root, 'other-'));
    gitIn(other, ['clone', '--quiet', remote, '.'], home.env);
    gitIn(other, ['commit', '--quiet', '--allow-empty', '-m', 'On GitHub'], home.env);
    gitIn(other, ['push', '--quiet', 'origin', `HEAD:refs/heads/${BRANCH}`], home.env);
    const theirs = remoteRef(`refs/heads/${BRANCH}`);
    expect(await spaces.push(run.start, run.bare, run.folder, local)).toEqual({
      status: 'failed',
      reason: 'diverged',
      message: '[rejected] (fetch first)',
    });
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBe(theirs);
    await rm(other, { recursive: true, force: true });
  }, 30_000);

  it("reports the Orchestrator's refusal of the credential", async () => {
    await serve();
    const spaces = workspaces();
    const run = await prepare(spaces);
    const head = commit(run.worktree, 'Agent work');
    answer = { ok: false, message: 'a review run never pushes' };
    expect(await spaces.push(run.start, run.bare, run.folder, head)).toEqual({
      status: 'failed',
      reason: 'refused',
      message: 'The Orchestrator refused the credential: a review run never pushes',
    });
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBeNull();
  }, 30_000);

  it('stops a push at Longest push, with every process it started', async () => {
    await serve();
    const spaces = workspaces();
    const run = await prepare(spaces);
    const head = commit(run.worktree, 'Agent work');
    await server.close();
    await serve(5_000);
    const slow = {
      ...run.start,
      repository: { ...run.start.repository, cloneUrl: `${server.url}/owner/notes.git` },
      limits: { ...run.start.limits, pushTimeoutSeconds: 1 },
    };
    const started = Date.now();
    expect(await spaces.push(slow, run.bare, run.folder, head)).toEqual({
      status: 'failed',
      reason: 'unreachable',
      message: 'The push took longer than Longest push (1 second) and was stopped.',
    });
    expect(Date.now() - started).toBeLessThan(4_000);
    // No process holding the credential variables is left.
    await waitFor(
      async () => {
        for (const pid of await readdir('/proc')) {
          if (!/^\d+$/.test(pid)) continue;
          const environment = await readFile(`/proc/${pid}/environ`).catch(() => null);
          if (environment?.includes(`ORCHESTRATOR_CREDENTIAL_SOCKET=${run.folder}`)) return false;
        }
        return true;
      },
      2_000,
      'the push processes gone',
    );
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBeNull();
  }, 30_000);
});

describe('fetch', () => {
  it('stops a download at Longest push, naming the limit in plain words', async () => {
    await serve(3_000);
    const failure = await prepare(workspaces(), { pushTimeoutSeconds: 1 }).then(
      () => 'prepared',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toBe(
      'Downloading the project from GitHub took longer than Longest push (1 second, in Settings > Limits) and was stopped. The first download on a new machine takes the longest.',
    );
  }, 30_000);

  it('never runs Git in the bare clone from a process holding the credential', async () => {
    await serve();
    const trace = join(home.root, 'trace.json');
    const spaces = workspaces(await tracingGit(trace));
    const first = await prepare(spaces);
    // A canary value Git reports whenever a process reads the bare clone's configuration.
    gitIn(first.bare, ['config', 'orchestratortest.canary', 'bare'], home.env);
    const head = commit(first.worktree, 'Agent work');
    await writeFile(trace, '');
    await spaces.push(first.start, first.bare, first.folder, head);
    await spaces.remove(first.bare, first.worktree);
    await prepare(spaces);

    const processes = new Map<string, { canary: boolean; credential: boolean }>();
    for (const line of (await readFile(trace, 'utf8')).split('\n').filter(Boolean)) {
      const event = JSON.parse(line) as { event: string; sid: string; param?: string };
      if (event.event !== 'def_param') continue;
      const seen = processes.get(event.sid) ?? { canary: false, credential: false };
      if (event.param === 'orchestratortest.canary') seen.canary = true;
      if (event.param === 'ORCHESTRATOR_CREDENTIAL_SOCKET') seen.credential = true;
      processes.set(event.sid, seen);
    }
    const all = [...processes.values()];
    // The trace saw both kinds: local commands in the bare clone, credentialed commands.
    expect(all.some((each) => each.canary)).toBe(true);
    expect(all.some((each) => each.credential)).toBe(true);
    expect(all.filter((each) => each.canary && each.credential)).toEqual([]);
  }, 30_000);

  it('downloads only the new commit after one commit on GitHub, not the history', async () => {
    await serve();
    // A history of 30 commits on GitHub's main branch.
    const work = await mkdtemp(join(home.root, 'history-'));
    gitIn(work, ['clone', '--quiet', remote, '.'], home.env);
    for (let index = 0; index < 30; index++) {
      await writeFile(join(work, `file-${String(index)}.txt`), `${String(index)}\n`);
      gitIn(work, ['add', '.'], home.env);
      gitIn(work, ['commit', '--quiet', '-m', `Commit ${String(index)}`], home.env);
    }
    gitIn(work, ['push', '--quiet', 'origin', 'HEAD:main'], home.env);
    const spaces = workspaces();
    const first = await prepare(spaces);
    await spaces.remove(first.bare, first.worktree);

    await writeFile(join(work, 'new.txt'), 'new\n');
    gitIn(work, ['add', '.'], home.env);
    gitIn(work, ['commit', '--quiet', '-m', 'One more'], home.env);
    gitIn(work, ['push', '--quiet', 'origin', 'HEAD:main'], home.env);
    const packs = join(first.bare, 'objects', 'pack');
    const before = new Set(await readdir(packs));
    const second = await prepare(spaces);
    const added = (await readdir(packs)).filter(
      (name) => name.endsWith('.idx') && !before.has(name),
    );
    const objects = added.map(
      (name) =>
        execFileSync(join(home.bin, 'git'), ['show-index'], {
          input: readFileSync(join(packs, name)),
          env: home.env,
          encoding: 'utf8',
        })
          .split('\n')
          .filter(Boolean).length,
    );
    // One commit, its tree and its new file, plus at most the base a deltified object needs
    // (`index-pack --fix-thin`); the history holds more than 90 objects.
    expect(objects).toHaveLength(1);
    expect(objects[0]).toBeGreaterThanOrEqual(3);
    expect(objects[0]).toBeLessThanOrEqual(4);
    expect(
      gitIn(second.worktree, ['log', '-1', '--format=%s', 'origin/main'], home.env).trim(),
    ).toBe('One more');
  }, 60_000);

  it('deletes the remote refs of branches no longer on GitHub', async () => {
    await serve();
    gitIn(remote, ['branch', 'gone', 'main'], home.env);
    const spaces = workspaces();
    const first = await prepare(spaces);
    expect(
      gitIn(first.bare, ['for-each-ref', '--format=%(refname)', 'refs/remotes/'], home.env),
    ).toContain('refs/remotes/origin/gone');
    await spaces.remove(first.bare, first.worktree);
    gitIn(remote, ['branch', '-D', 'gone'], home.env);
    await prepare(spaces);
    expect(
      gitIn(first.bare, ['for-each-ref', '--format=%(refname)', 'refs/remotes/'], home.env),
    ).toBe('refs/remotes/origin/main\n');
  }, 30_000);
});
