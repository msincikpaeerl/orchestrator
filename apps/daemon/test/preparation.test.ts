import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Git } from '../src/git.js';
import { TrustRegistry } from '../src/trust.js';
import { Workspaces } from '../src/workspace.js';
import { createRemote, gitIn } from './remote.js';
import { runStartPayload } from './run-start.js';
import {
  DAEMON_COMMAND,
  captureLogger,
  createTestHome,
  linkSystemTool,
  stopHomeProcesses,
  type TestHome,
} from './testing.js';

// Preparation of an `implement` or `fix_review` run's worktree when the ticket branch is both on
// this machine and on GitHub (05, section 4.2; lot 3 step D2): fast-forwarded to GitHub's when
// GitHub's contains it, left as it is when they diverged (its push then reports it), and never
// moved while a waiting or paused run has it checked out.

const BRANCH = 't/1-add-notes';

let home: TestHome;
let remote: string;
let spaces: Workspaces;

beforeEach(async () => {
  home = await createTestHome();
  await linkSystemTool(home.bin, 'git');
  remote = await createRemote(join(home.root, 'remotes'), 'owner', 'notes', home.env);
  spaces = new Workspaces({
    paths: home.paths,
    git: new Git(join(home.bin, 'git'), home.env),
    trust: new TrustRegistry(join(home.paths.claudeConfig, '.claude.json')),
    credentials: () => Promise.resolve({ ok: false, message: 'file:// asks for none' }),
    selfCommand: DAEMON_COMMAND,
    log: captureLogger().log,
  });
});

afterEach(async () => {
  await stopHomeProcesses(home);
  await home.remove();
});

async function prepare() {
  const start = runStartPayload(`file://${remote}`);
  const folder = join(home.paths.home, 'runs', start.runId);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  return { start, folder, ...(await spaces.prepare(start, folder)) };
}

function head(repository: string, ref: string): string {
  return gitIn(repository, ['rev-parse', '--verify', ref], home.env).trim();
}

function commit(worktree: string, message: string): string {
  gitIn(worktree, ['commit', '--quiet', '--allow-empty', '-m', message], home.env);
  return head(worktree, 'HEAD');
}

/** Runs `change` in a clone of GitHub's ticket branch, then pushes it back. */
async function onGitHub(change: (clone: string) => void): Promise<string> {
  const clone = await mkdtemp(join(home.root, 'github-'));
  gitIn(clone, ['clone', '--quiet', remote, '.'], home.env);
  gitIn(clone, ['checkout', '--quiet', BRANCH], home.env);
  change(clone);
  gitIn(clone, ['push', '--quiet', 'origin', `HEAD:refs/heads/${BRANCH}`], home.env);
  const pushed = head(clone, 'HEAD');
  await rm(clone, { recursive: true, force: true });
  return pushed;
}

/** GitHub's **Update branch**: the base branch merged into the ticket branch. */
function updateBranch(clone: string): void {
  gitIn(clone, ['checkout', '--quiet', 'main'], home.env);
  gitIn(clone, ['commit', '--quiet', '--allow-empty', '-m', 'Merged on main meanwhile'], home.env);
  gitIn(clone, ['push', '--quiet', 'origin', 'main'], home.env);
  gitIn(clone, ['checkout', '--quiet', BRANCH], home.env);
  gitIn(clone, ['merge', '--quiet', '--no-edit', 'main'], home.env);
}

describe('preparation', () => {
  it("fast-forwards the local ticket branch to GitHub's after Update branch", async () => {
    const first = await prepare();
    const pushed = commit(first.worktree, 'Agent work');
    expect(await spaces.push(first.start, first.bare, first.folder, pushed)).toEqual({
      status: 'pushed',
      head: pushed,
    });
    await spaces.remove(first.bare, first.worktree);
    const updated = await onGitHub(updateBranch);

    const second = await prepare();
    expect(head(second.bare, `refs/heads/${BRANCH}`)).toBe(updated);
    expect(head(second.worktree, 'HEAD')).toBe(updated);
    expect(gitIn(second.worktree, ['symbolic-ref', 'HEAD'], home.env).trim()).toBe(
      `refs/heads/${BRANCH}`,
    );
    // Nothing of this machine's is lost: the pushed commit is in the new head's history.
    expect(gitIn(second.worktree, ['merge-base', '--is-ancestor', pushed, 'HEAD'], home.env)).toBe(
      '',
    );
  }, 30_000);

  it('leaves a diverged branch as it is, and its push reports it without overwriting GitHub', async () => {
    const first = await prepare();
    gitIn(
      first.worktree,
      ['push', '--quiet', `file://${remote}`, `HEAD:refs/heads/${BRANCH}`],
      home.env,
    );
    const local = commit(first.worktree, 'Only on this machine');
    await spaces.remove(first.bare, first.worktree);
    const theirs = await onGitHub((clone) => {
      gitIn(clone, ['commit', '--quiet', '--allow-empty', '-m', 'Only on GitHub'], home.env);
    });

    const second = await prepare();
    expect(head(second.bare, `refs/heads/${BRANCH}`)).toBe(local);
    expect(head(second.worktree, 'HEAD')).toBe(local);
    expect(await spaces.endPush(second.start, second.bare, second.folder)).toMatchObject({
      status: 'failed',
      reason: 'diverged',
    });
    expect(head(remote, `refs/heads/${BRANCH}`)).toBe(theirs);
  }, 30_000);

  it('never moves a branch a waiting run has checked out, which keeps working', async () => {
    const waiting = await prepare();
    const pushed = commit(waiting.worktree, 'Before the question');
    await spaces.push(waiting.start, waiting.bare, waiting.folder, pushed);
    const updated = await onGitHub(updateBranch);

    // Another run of the same ticket on this machine (the server never starts one: one active
    // run per ticket; here the daemon protects the branch by itself).
    const refused = await prepare().then(
      () => 'prepared',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(refused).toMatch(
      new RegExp(`^The ticket branch ${BRANCH} is checked out by another run on this machine`),
    );
    expect(head(waiting.bare, `refs/heads/${BRANCH}`)).toBe(pushed);
    expect(head(waiting.worktree, 'HEAD')).toBe(pushed);
    expect(updated).not.toBe(pushed);
    // The waiting run's worktree still commits on its branch, with its author.
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'After the answer'], {
      cwd: waiting.worktree,
      env: home.env,
    });
    const after = head(waiting.worktree, 'HEAD');
    expect(head(waiting.bare, `refs/heads/${BRANCH}`)).toBe(after);
    expect(gitIn(waiting.worktree, ['log', '-1', '--format=%an'], home.env).trim()).toBe(
      'Web Developer (Orchestrator)',
    );
  }, 30_000);
});
