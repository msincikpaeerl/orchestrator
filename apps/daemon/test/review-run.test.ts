import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Git } from '../src/git.js';
import { TrustRegistry } from '../src/trust.js';
import { Workspaces, bareClonePath, worktreePath } from '../src/workspace.js';
import { startGitHttpServer, type GitHttpServer } from './git-http-server.js';
import { gitIn } from './remote.js';
import { runStartPayload } from './run-start.js';
import {
  TIMEOUT,
  daemon,
  ended,
  fake,
  home,
  start,
  states,
  useRunnerHarness,
} from './runner-harness.js';
import { DAEMON_COMMAND, captureLogger, waitFor } from './testing.js';
import { randomUUID } from 'node:crypto';

// A review run (05, section 4.2; lot 3 step D2), with the real tmux and Git and the fake
// `claude`: its worktree is at GitHub's head of the ticket branch, never at commits only this
// machine has; it never pushes; and a head moved during the review ends it with
// `review_branch_moved`.

useRunnerHarness();

const CREDENTIAL = {
  username: 'x-access-token',
  password: 'ghp_ReviewRunTestToken000000000000000001',
};
const BRANCH = 't/1-add-notes';

let server: GitHttpServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const remote = () => join(home.root, 'remotes', 'owner', 'notes.git');

function head(repository: string, ref: string): string | null {
  try {
    return gitIn(repository, ['rev-parse', '--verify', '--quiet', ref], home.env).trim();
  } catch {
    return null;
  }
}

/**
 * GitHub's ticket branch with one commit, and this machine's local ticket branch one commit ahead
 * of it, never pushed (a commit made after an accepted submission, for example). Resolves with
 * both heads and the clone URL.
 */
async function branchAheadOfGitHub(): Promise<{ github: string; local: string; cloneUrl: string }> {
  server = await startGitHttpServer(join(home.root, 'remotes'), CREDENTIAL);
  const cloneUrl = `${server.url}/owner/notes.git`;
  const other = await mkdtemp(join(home.root, 'other-'));
  gitIn(other, ['clone', '--quiet', remote(), '.'], home.env);
  gitIn(other, ['commit', '--quiet', '--allow-empty', '-m', 'Submitted work'], home.env);
  gitIn(other, ['push', '--quiet', 'origin', `HEAD:refs/heads/${BRANCH}`], home.env);
  await rm(other, { recursive: true, force: true });
  const spaces = new Workspaces({
    paths: home.paths,
    git: new Git(join(home.bin, 'git'), home.env),
    trust: new TrustRegistry(join(home.paths.claudeConfig, '.claude.json')),
    credentials: () => Promise.resolve({ ok: true, ...CREDENTIAL }),
    selfCommand: DAEMON_COMMAND,
    log: captureLogger().log,
  });
  const earlier = runStartPayload(cloneUrl);
  const folder = join(home.paths.home, 'runs', earlier.runId);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const prepared = await spaces.prepare(earlier, folder);
  gitIn(prepared.worktree, ['commit', '--quiet', '--allow-empty', '-m', 'Not pushed'], home.env);
  await spaces.remove(prepared.bare, prepared.worktree);
  const local = head(prepared.bare, `refs/heads/${BRANCH}`) ?? '';
  const github = head(remote(), `refs/heads/${BRANCH}`) ?? '';
  expect(local).not.toBe(github);
  return { github, local, cloneUrl };
}

const pushRequests = () => server?.requests.filter((request) => request.push) ?? [];

describe('a review run', () => {
  it(
    "works at GitHub's head, never at commits only this machine has, and never pushes",
    async () => {
      const { github, local, cloneUrl } = await branchAheadOfGitHub();
      const manager = daemon({ credentials: () => Promise.resolve({ ok: true, ...CREDENTIAL }) });
      await fake.play({ turns: [{ steps: [{ do: 'hang' }] }] });
      const run = await start(manager, {
        purpose: 'review',
        reviewCommit: github,
        repository: { cloneUrl },
      });
      await waitFor(
        () => states(run.runId).some((state) => state.state === 'working'),
        20_000,
        'the review session',
      );
      const worktree = worktreePath(home.paths, run.runId);
      expect(head(worktree, 'HEAD')).toBe(github);
      // Detached: the local ticket branch is not checked out, nor moved.
      expect(() => gitIn(worktree, ['symbolic-ref', '--quiet', 'HEAD'], home.env)).toThrow();
      const bare = bareClonePath(home.paths, run.repository);
      expect(head(bare, `refs/heads/${BRANCH}`)).toBe(local);

      await manager.handle({
        type: 'run.stop',
        id: randomUUID(),
        payload: { runId: run.runId, reason: 'owner_stopped' },
      });
      expect(await ended(run.runId)).toMatchObject({
        reason: 'stopped',
        headMoved: false,
        push: null,
        branch: { name: BRANCH, head: github },
      });
      expect(pushRequests()).toEqual([]);
      expect(head(bare, `refs/heads/${BRANCH}`)).toBe(local);
      expect(head(remote(), `refs/heads/${BRANCH}`)).toBe(github);
    },
    TIMEOUT,
  );

  for (const [what, command] of [
    ['a commit in its worktree', 'git commit -q --allow-empty -m "Changed during the review"'],
    ['the local ticket branch moved', `git update-ref refs/heads/${BRANCH} HEAD`],
  ] as const) {
    it(
      `ends with review_branch_moved after ${what}, pushing nothing`,
      async () => {
        const { github, cloneUrl } = await branchAheadOfGitHub();
        const manager = daemon({
          credentials: () => Promise.resolve({ ok: true, ...CREDENTIAL }),
        });
        await fake.play({
          turns: [
            {
              steps: [
                { do: 'bash', command },
                {
                  do: 'mcp',
                  tool: 'ticket_give_up',
                  arguments: { reason: 'Stop.', tried: 'This.' },
                },
              ],
            },
          ],
        });
        const run = await start(manager, {
          purpose: 'review',
          reviewCommit: github,
          repository: { cloneUrl },
        });
        const end = await ended(run.runId);
        expect(end).toMatchObject({ reason: 'review_branch_moved', headMoved: true, push: null });
        expect(end.detail).toMatch(/head moved during the review/);
        expect(pushRequests()).toEqual([]);
        expect(head(remote(), `refs/heads/${BRANCH}`)).toBe(github);
      },
      TIMEOUT,
    );
  }

  it(
    "fails with review_branch_moved when GitHub's head is not the commit under review",
    async () => {
      const { github, local, cloneUrl } = await branchAheadOfGitHub();
      const manager = daemon({ credentials: () => Promise.resolve({ ok: true, ...CREDENTIAL }) });
      await fake.play({ turns: [{ steps: [{ do: 'hang' }] }] });
      // The server fixed another commit at Start review: GitHub's head moved since (answer 2b).
      const run = await start(manager, {
        purpose: 'review',
        reviewCommit: local,
        repository: { cloneUrl },
      });
      const end = await ended(run.runId);
      expect(end).toMatchObject({ reason: 'review_branch_moved', push: null });
      expect(end.detail).toBe(
        `The ticket branch on GitHub moved since the review was started: it is now ${github.slice(0, 7)}, not ${local.slice(0, 7)}.`,
      );
      // No session was started for it.
      expect(states(run.runId).some((state) => state.state === 'starting')).toBe(false);
      expect(pushRequests()).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'fails at preparation when the ticket branch is not on GitHub',
    async () => {
      const manager = daemon();
      const run = await start(manager, { purpose: 'review', reviewCommit: 'a'.repeat(40) });
      const end = await ended(run.runId);
      expect(end).toMatchObject({ reason: 'crashed', headMoved: null, push: null });
      expect(end.detail).toBe(
        `The workspace could not be prepared: The ticket branch ${BRANCH} is not on GitHub: there is nothing to review.`,
      );
    },
    TIMEOUT,
  );
});
